# git-worker

A separate delivery app that runs the real `git` and `git-lfs` command-line tools on behalf of a
project's connected Git repository. It is the only part of the deployment that ever shells out to
`git`, and — together with the network-layer egress allowlist deployers configure around it — the
only part that talks to a remote outside your infrastructure.

It does two things at once:

- **Polls a work queue.** Longer-running operations (import, initialize, pull, push, branch switch)
  are recorded as rows in the `GitOperation` table and claimed by the run loop
  (`src/worker-loop.ts`), one project at a time, with a heartbeat so a crashed worker's operation is
  reclaimed rather than stuck.
- **Serves an internal RPC endpoint.** `apps/api` calls the worker directly (`src/internal-git-server.ts`)
  for short, synchronous operations against a project's working tree — status, stage/unstage, commit,
  connect, list branches, history, diff, blame, conflict resolution, and pull/push previews. This
  channel is authenticated with a shared secret (and can be put behind mTLS) and is never logged.

Git credentials (personal access tokens, OAuth tokens) are decrypted only inside this process, at the
moment a job needs them, and are handed to the `git` CLI out-of-band via `GIT_ASKPASS` — never as a
command-line argument, never in a remote URL, and never written into `.git/config` or a log line.

## Running it locally

`git` and `git-lfs` must be installed on the machine (or container) this runs on — nothing in
`node_modules` provides them. It also needs a reachable Postgres database and the same project-file
storage root as `apps/api` and `apps/collab`.

This app is **not** started by `scripts/dev.sh` — start it separately when you need to exercise git
sync locally:

```bash
pnpm --filter @asciidocollab/git-worker build
pnpm --filter @asciidocollab/git-worker start
```

Other package scripts:

| Script      | Command                          | Purpose                                   |
|-------------|-----------------------------------|--------------------------------------------|
| `build`     | `tsc`                              | Compile to `dist/`                         |
| `start`     | `node dist/index.js`               | Run the compiled worker                    |
| `test`      | `jest`                             | Unit/integration tests                     |
| `typecheck` | `tsc --noEmit -p tsconfig.eslint.json` | Type-check without emitting            |
| `lint`      | `eslint .`                         | Lint                                       |

At minimum, set `ASCIIDOCOLLAB_DATABASE_URL`, `ASCIIDOCOLLAB_STORAGE_PATH` (shared with `apps/api`),
and `ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY` (must match the same value configured on
`apps/api` — see the [Configuration](#configuration) table below). Without a matching key, tokens the
API encrypted cannot be decrypted here and every git operation that needs a credential fails.

## Docker image

`docker/Dockerfile` builds a dedicated `git-worker` target: the shared Alpine runtime base, plus
`git` and `git-lfs` installed with `apk add` (the only image in the stack that ships them), plus the
worker's own production dependencies deployed with `pnpm deploy`. It mounts the same `project_storage`
volume as the `api` and `collab` images, at the same path, for the same reason those two must agree —
a worker-imported file has to land somewhere the rest of the application can read it back from.

This image target is **not currently wired into `docker/docker-compose.prod.yml`** — the compose file
builds and runs `api`, `collab`, `web`, `postgres`, `migrate` and `caddy`, but no `git-worker` service.
To exercise git sync in a Docker deployment, add a `git-worker` service yourself. A ready-made compose
fragment — including the egress-proxy sidecar the network-layer allowlist needs — is in
[`docker/git-worker-egress-policy.md`](../../docker/git-worker-egress-policy.md).

## Configuration

All of these are read with [`convict`](https://github.com/mozilla/node-convict) in
`src/config/git-worker-config.ts`; env var names below are authoritative.

| Env var                                              | Config key                    | Default                     | Purpose                                                                                       |
|-------------------------------------------------------|--------------------------------|------------------------------|-------------------------------------------------------------------------------------------------|
| `ASCIIDOCOLLAB_STORAGE_PATH`                          | `storageRoot` / `contentStorageRoot` | `./storage`            | Root of per-project git working trees, and of the content-bytes projection `ProjectFileStore` reads/writes. Both must resolve to the exact same directory `apps/api` uses (`storage.path`) |
| `ASCIIDOCOLLAB_GIT_CONFLICT_STORE_ROOT`               | `conflictStoreRoot`            | `./storage-git-conflicts`   | Off-working-tree store for captured conflict blobs and pre-operation undo snapshots. Must be a **sibling** of `storageRoot`'s project directories, never nested inside one — a pull's cleanup step runs `git clean -fdx` in the working tree and would otherwise delete it |
| `ASCIIDOCOLLAB_DATABASE_URL`                          | `databaseUrl`                  | *(none)*                    | PostgreSQL connection string, shared with `apps/api`/`apps/collab`                              |
| `ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY`         | `credentialEncryptionKey`      | *(none)*                    | Base64, 32-byte AES-256-GCM key. Must be identical to `apps/api`'s key of the same name — the API encrypts a stored token, this worker decrypts it at job time |
| `ASCIIDOCOLLAB_GIT_WORKER_POLL_INTERVAL_MS`           | `pollIntervalMs`               | `2000`                      | How long the run loop sleeps between claim attempts when the queue is empty                     |
| `ASCIIDOCOLLAB_GIT_WORKER_HEARTBEAT_INTERVAL_MS`      | `heartbeatIntervalMs`          | `15000`                      | How often a running job refreshes its `GitOperation` heartbeat                                   |
| `ASCIIDOCOLLAB_GIT_WORKER_STALE_HEARTBEAT_AFTER_MS`   | `staleHeartbeatAfterMs`        | `60000`                      | How long a `RUNNING` operation may go without a heartbeat before it is treated as crashed and reclaimed |
| `ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS`              | `egressAllowedHosts`           | `github.com,gitlab.com,bitbucket.org` | Hostnames this worker's outbound git operations may reach; must match `apps/api`'s allowlist of the same name — see [Egress allowlist](../../CONFIGURATION.md#git-repository-sync) |
| `ASCIIDOCOLLAB_GIT_MAX_REPO_SIZE_MB`                  | `maxRepoSizeMB`                | `500`                        | Import/clone over this size (megabytes) fails gracefully with `repository_too_large`. Must match `apps/api`'s value |
| `ASCIIDOCOLLAB_GIT_LFS_THRESHOLD_BYTES`               | `lfsThresholdBytes`            | `10485760` (10 MiB)          | Files at or above this size are staged as Git LFS objects instead of stored inline. Must match `apps/api`'s value |
| `ASCIIDOCOLLAB_COLLAB_EDIT_URL`                       | `collab.editUrl`               | `http://127.0.0.1:4003`      | Collab server's internal edit endpoint — used to read a staged file's current live (unsaved) content before recording a commit |
| `ASCIIDOCOLLAB_COLLAB_EDIT_SECRET`                    | `collab.editSecret`            | *(empty)*                    | Shared secret for that endpoint; must match `apps/collab`'s `ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_SECRET` |
| `ASCIIDOCOLLAB_COLLAB_EDIT_TLS_CERT/_KEY/_CA`         | `collab.editTls.*`             | *(empty)*                    | Client mTLS material for that endpoint; all empty disables mTLS (loopback HTTP)                 |
| `ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_HOST`              | `internalGitHost`              | `127.0.0.1`                  | Interface the internal git-ops RPC server binds to                                              |
| `ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_PORT`              | `internalGitPort`              | `4010`                       | Port `apps/api` calls for the synchronous git ops listed above                                   |
| `ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_SECRET`            | `internalGitSecret`            | *(empty)*                    | Shared secret enforced on that endpoint. Empty relies on loopback trust — **set this off loopback/in production**; must match `apps/api`'s `ASCIIDOCOLLAB_GIT_WORKER_SECRET` |
| `ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_TLS_CERT/_KEY/_CLIENT_CA` | `internalGitTls.*`      | *(empty)*                    | Server mTLS material for that endpoint; all empty disables mTLS (loopback HTTP)                  |

The egress allowlist, credential encryption, rate limiting, LFS/size thresholds and OAuth guided-connect
settings are configured on `apps/api` and shared with (or independently mirrored by) this worker — see
the [Git repository sync](../../CONFIGURATION.md#git-repository-sync) section of the configuration
reference for the full picture, including the **operator actions required** before enabling git sync
against a real deployment.
