# Git-worker network egress policy

The git-worker container is the only service in this stack that talks to a remote outside
the deployment (cloning/fetching/pushing a project's connected git repository). It must run
**deny-by-default**: no host is reachable except those on the configured allowlist.

This is enforced at two layers, and both are required — neither alone is sufficient:

1. **Runtime (this repository)**: before any git network operation, `apps/git-worker` resolves
   the remote's host and rejects it unless it is present in `git.egress.allowedHosts`
   (env `ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS`, defaulting to `github.com`, `gitlab.com`,
   `bitbucket.org`) — see `apps/git-worker/src/git/egress-allowlist.ts`. It also validates the
   resolved address is not private/link-local, closing a DNS-rebinding path around an
   otherwise-allowlisted hostname, and pairs with `apps/git-worker/src/git/run-git-command.ts`
   disabling cross-host HTTP redirects (`http.followRedirects=false`), so a malicious remote
   cannot bounce the connection to a different host after the allowlist check has passed.
2. **Network layer (this file)**: a crafted request from inside a compromised worker process
   must not be able to bypass the runtime check by talking to the network directly. This
   requires infrastructure this repository does not provision — a network policy, egress
   proxy, or firewall configured by whoever deploys the stack. The fragments below are that
   configuration, kept in sync with the same allowlist the runtime enforces.

Whichever fragment is adopted, keep its allowlist identical to
`ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS` — the runtime config is the single source of truth for
which hosts are permitted; the network layer only needs to agree with it.

## docker-compose: an egress-proxy sidecar

Plain Docker networks are not hostname-aware, so restricting a container to *specific remote
hostnames* (rather than an entire network) needs a forward proxy in front of it. `git-worker`
gets no direct route to the outside network; all its outbound traffic is forced through a
small proxy container whose ACL is the same host list.

```yaml
services:
  git-worker:
    image: asciidocollab/git-worker:latest
    networks: [backend, git-egress]   # NOT `edge` — no public inbound, no direct outbound
    environment:
      ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS: github.com,gitlab.com,bitbucket.org
      HTTPS_PROXY: http://git-egress-proxy:3128
      HTTP_PROXY: http://git-egress-proxy:3128
      NO_PROXY: postgres,api,collab   # internal traffic bypasses the proxy
    <<: *hardening

  # Forward proxy: the only container in `git-egress` with a route to the public internet.
  # Its ACL is the network-layer half of the allowlist above — keep the two in sync.
  git-egress-proxy:
    image: ubuntu/squid:latest
    networks: [git-egress]
    volumes:
      - ./git-egress-allowlist.acl:/etc/squid/conf.d/allowlist.acl:ro
    <<: *hardening

networks:
  git-egress:
    internal: false   # this network's only egress path is through the proxy above
```

`git-egress-allowlist.acl` (mounted read-only into the proxy) is a Squid ACL restricting
`CONNECT`/HTTP requests to the allowlisted hosts, for example:

```
acl allowed_git_hosts dstdomain .github.com .gitlab.com .bitbucket.org
http_access allow allowed_git_hosts
http_access deny all
```

## Kubernetes: NetworkPolicy

A vanilla Kubernetes `NetworkPolicy` matches IP/CIDR blocks, not hostnames, so it cannot express
"only `github.com`" directly. Combine one of two approaches:

- **CNI with FQDN-aware egress** (e.g. Cilium): restrict by hostname directly.

  ```yaml
  apiVersion: cilium.io/v2
  kind: CiliumNetworkPolicy
  metadata:
    name: git-worker-egress
  spec:
    endpointSelector:
      matchLabels: {app: git-worker}
    egress:
      - toFQDNs:
          - matchName: github.com
          - matchName: gitlab.com
          - matchName: bitbucket.org
      - toEndpoints:       # DNS resolution itself
          - matchLabels: {k8s-app: kube-dns}
        toPorts:
          - ports: [{port: "53", protocol: UDP}]
  ```

- **Plain `NetworkPolicy` + an egress proxy** (portable across any CNI): deny all pod egress
  except to DNS and the proxy sidecar/service, which applies the same hostname ACL as the
  docker-compose fragment above.

  ```yaml
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata:
    name: git-worker-egress
  spec:
    podSelector:
      matchLabels: {app: git-worker}
    policyTypes: [Egress]
    egress:
      - to: [{namespaceSelector: {}, podSelector: {matchLabels: {k8s-app: kube-dns}}}]
        ports: [{port: 53, protocol: UDP}, {port: 53, protocol: TCP}]
      - to: [{podSelector: {matchLabels: {app: git-egress-proxy}}}]
        ports: [{port: 3128, protocol: TCP}]
  ```

Either way, the pod spec sets `HTTPS_PROXY`/`HTTP_PROXY` (or the CNI enforces it transparently)
and `ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS` to the same host list, exactly as in the
docker-compose fragment.
