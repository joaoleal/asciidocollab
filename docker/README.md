# Deploying AsciiDoCollab

Everything Docker-related lives in this folder:

| File                      | Purpose                                              |
|---------------------------|------------------------------------------------------|
| `docker-compose.prod.yml` | Production stack (Postgres, api, collab, web, Caddy) |
| `docker-compose.dev.yml`  | Local development dependencies (Postgres + Mailpit)  |
| `docker-compose.e2e.yml`  | Isolated end-to-end test stack                       |
| `Dockerfile`              | Multi-stage build; one image per service             |
| `Caddyfile`               | Edge proxy: TLS, security headers, path routing      |
| `generate-secrets.sh`     | Generates `docker/.env` and the internal mTLS PKI    |

---

## 1. Requirements

- A host with Docker Engine 24+ and the Compose v2 plugin.
- A domain name with an A/AAAA record pointing at the host — or a fixed IP /
  LAN hostname, see [Deploying without a domain](#deploying-without-a-domain).
- Inbound TCP **80** and **443** open. With a public domain, port 80 is required
  for certificate issuance, not just for the HTTPS redirect.
- An SMTP account. **Email is not optional**: account verification, invitations
  and password resets all depend on it, and the api refuses to start without a
  sender address.
- Roughly 4 GB RAM and 10 GB disk to start. Project storage grows with use.

## 2. Deploy

```bash
git clone <this repository>
cd asciidocollab

# Generates docker/.env (0600) and docker/pki/ (internal CA + mTLS keypairs).
# Both are gitignored. Safe to re-run; it will not overwrite existing files.
./docker/generate-secrets.sh --domain docs.example.com --acme-email ops@example.com

# Add your SMTP details — the only values you must fill in by hand.
$EDITOR docker/.env

docker compose -f docker/docker-compose.prod.yml up -d --build
```

Caddy obtains a certificate on first start; the first request may take a few
seconds. Watch progress with:

```bash
docker compose -f docker/docker-compose.prod.yml logs -f caddy
```

Then open `https://docs.example.com` and register. **The first account to
register becomes the administrator**, so do this immediately after deploying,
before the instance is reachable by anyone else.

### Deploying without a domain

You can deploy to a bare IP or a LAN hostname — useful for an internal trial or
an air-gapped network. Give the generator the address instead of a domain:

```bash
./docker/generate-secrets.sh --domain 192.168.1.10
docker compose -f docker/docker-compose.prod.yml up -d --build
```

Let's Encrypt cannot issue a certificate for an IP or a name that does not
resolve publicly, so the stack uses a self-signed certificate from Caddy's own
certificate authority instead. Everything else works the same, and traffic is
still encrypted — but browsers will show a warning until that authority is
trusted.

To remove the warning, install Caddy's root certificate on the machines that
will use the instance:

```bash
docker compose -f docker/docker-compose.prod.yml cp \
  caddy:/data/caddy/pki/authorities/local/root.crt ./asciidocollab-root.crt
```

Then add `asciidocollab-root.crt` to the system or browser trust store. Without
this, users must click through a certificate warning on every new browser
profile.

Two things to know:

- **The address is baked into the web image.** Changing the IP or hostname later
  means rebuilding: `docker compose -f docker/docker-compose.prod.yml up -d --build`.
- **Use a fixed address.** If the host's IP is assigned by DHCP and changes, the
  instance becomes unreachable until it is rebuilt with the new one. Reserve the
  address on your router, or use a LAN hostname you control.

### What is configured automatically

You provide a domain and SMTP credentials. Everything else is derived:

- Postgres password, session secret, session encryption key and the api↔collab
  shared secret are generated with `openssl rand`.
- An internal certificate authority plus mTLS keypairs for api and collab.
- TLS certificates for the public domain, via ACME, renewed automatically.
- CORS origins, WebSocket allowed origins, the frontend URL and every internal
  service URL are derived from your domain.
- The database schema is applied on first start by a one-shot `migrate` job.

## 3. How it fits together

```
                    ┌──────────────────── edge network ────────────────────┐
  internet ──443──► │ caddy ──► web:3000                                   │
                    │       ──► api:4000                                   │
                    │       ──► collab:4002 (WebSocket)                    │
                    └──────────┬──────────────────────┬───────────────────-┘
                               │                      │
                    ┌──────────┴──── backend network (internal: true) ─────┐
                    │ api ◄──mTLS──► collab      postgres:5432             │
                    │  └── shared volume: project_storage at /data/storage │
                    └──────────────────────────────────────────────────────┘
```

Only Caddy publishes ports. Postgres and the internal api/collab channels sit on
a network with no route off the host.

Everything is served from one origin, so session cookies stay first-party and
CORS never enters the picture:

| Path                                       | Service            |
|--------------------------------------------|--------------------|
| `/collab*`                                 | collab (WebSocket) |
| `/api*`, `/auth*`, `/admin*`, `/projects*` | api                |
| everything else                            | web                |

If you add a top-level Next.js route, check it against the API prefixes above —
an overlap would be shadowed by the api.

### mTLS between api and collab

The two services talk over two internal channels: collab calls the api's auth
server (4001) to authorise every WebSocket connection, and the api calls
collab's edit server (4003) to rewrite references inside live documents.

In a single-process deployment both are loopback-only. Under Docker they must
bind `0.0.0.0`, so they are protected by three independent layers: the internal
network, a shared secret, and mutual TLS against a private CA. `generate-secrets.sh`
issues the certificates, so this is on by default with no extra work.

Certificates are issued for the compose service names and expire after 825 days.

### Rotating secrets

Re-running `generate-secrets.sh` with no arguments is always safe: it fills in
values that are missing and never touches anything that already exists,
including SMTP credentials you edited by hand.

Rotation is explicit, one thing at a time, and every rotation writes a
timestamped backup first:

```bash
./docker/generate-secrets.sh --rotate certs          # internal mTLS PKI
./docker/generate-secrets.sh --rotate session        # signs every user out
./docker/generate-secrets.sh --rotate collab-secret  # api <-> collab shared secret
./docker/generate-secrets.sh --rotate db-password    # see below
./docker/generate-secrets.sh --rotate all
```

After `--rotate certs` or `--rotate collab-secret`:

```bash
docker compose -f docker/docker-compose.prod.yml restart api collab
```

**Rotating the database password** needs the stack running, because the password
lives in two places: `docker/.env` and the role inside the database volume. The
script changes the live role first and only writes the new value to `.env` if
that succeeded, so an unreachable database aborts the rotation and leaves your
working credentials intact.

```bash
docker compose -f docker/docker-compose.prod.yml up -d postgres
./docker/generate-secrets.sh --rotate db-password
docker compose -f docker/docker-compose.prod.yml up -d api collab
```

There is no flag that regenerates everything at once — rotating the wrong
secret silently is how a working deployment gets locked out of its own database.

## 4. Operations

### Backups

Back up both volumes **together**. They reference each other — the database
holds project metadata, the storage volume holds file contents — so a restore
from two different points in time will be inconsistent.

```bash
# Database
docker compose -f docker/docker-compose.prod.yml exec -T postgres \
  pg_dump -U asciidocollab -Fc asciidocollab > backup-$(date +%F).dump

# Project files
docker run --rm -v asciidocollab-prod_project_storage:/data:ro \
  -v "$PWD":/backup alpine tar czf /backup/storage-$(date +%F).tar.gz -C /data .
```

Restore:

```bash
docker compose -f docker/docker-compose.prod.yml stop api collab
docker compose -f docker/docker-compose.prod.yml exec -T postgres \
  pg_restore -U asciidocollab -d asciidocollab --clean --if-exists < backup-YYYY-MM-DD.dump
docker run --rm -v asciidocollab-prod_project_storage:/data \
  -v "$PWD":/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/storage-YYYY-MM-DD.tar.gz -C /data"
docker compose -f docker/docker-compose.prod.yml start api collab
```

A backup you have never restored is a guess. Test the restore path.

### Upgrading

```bash
git pull
docker compose -f docker/docker-compose.prod.yml up -d --build
```

**Take a database backup first**, as with any schema change.

The `migrate` job runs `prisma migrate deploy`, which applies the reviewed,
version-controlled migrations in `packages/db/prisma/migrations/`. It never
computes a schema diff of its own, so it cannot silently drop a column to make
the database match the schema file, and it is idempotent — already-applied
migrations are skipped.

#### Upgrading an instance first deployed with `db push`

Earlier versions of this stack applied the schema with `prisma db push`, which
leaves no migration history. Such a database already has the tables but no
`_prisma_migrations` table, so `migrate deploy` would try to create everything
again and fail. Baseline it **once**:

```bash
docker compose -f docker/docker-compose.prod.yml run --rm --entrypoint sh migrate \
  -c 'node_modules/.bin/prisma migrate resolve --applied 0_init'
```

That records the baseline migration as already applied without running its SQL.
Subsequent upgrades then work normally. A fresh install needs none of this.

Because `NEXT_PUBLIC_*` values are compiled into the browser bundle, **changing
the domain requires rebuilding the web image**, not just restarting it.

### Rollback

```bash
git checkout <previous-tag>
docker compose -f docker/docker-compose.prod.yml up -d --build
```

Schema changes do not roll back automatically. If the release changed the schema,
restore the database from backup.

### Logs and status

```bash
docker compose -f docker/docker-compose.prod.yml ps
docker compose -f docker/docker-compose.prod.yml logs -f api collab
```

Logs are JSON-file with rotation at 10 MB × 5 per container.

## 5. Troubleshooting

**`collab` exits immediately with a storage error.** It verifies at startup that
it shares a filesystem root with the api. Both must mount `project_storage` at
exactly `/data/storage`. If they diverge, edits are written to two different
places and silently overwrite each other — which is why this is a hard failure
rather than a warning.

**`api` exits with `ASCIIDOCOLLAB_AUTH_EMAIL_FROM is required`.** Set it in
`docker/.env`. This is intentional fail-fast behaviour: without email, users
cannot verify accounts or reset passwords.

**Certificate issuance fails.** Confirm DNS resolves to this host and that port
80 is reachable from the internet. Let's Encrypt rate-limits failures, so fix
DNS before retrying repeatedly. The `caddy_data` volume must persist across
redeploys or every deploy re-issues.

**WebSocket connections are rejected.** `ASCIIDOCOLLAB_COLLAB_ALLOWED_ORIGINS`
must match the origin the browser actually uses. It is derived from `ADC_DOMAIN`,
so a mismatch usually means the domain changed without a rebuild.

**`migrate` fails with a data-loss warning.** Working as designed — see
"Upgrading" above.

## 6. Security

### What you have to protect

`docker/.env` and `docker/pki/` hold every secret in the deployment. Anyone who
can read them owns the instance. Both are gitignored — including the timestamped
backups that rotation creates — and are never copied into an image.

`docker/pki/ca.key` is the most sensitive file: it can mint certificates the
services will trust. No container ever needs it, so it stays readable only by
you.

### What the stack does for you

- Only the reverse proxy is reachable from outside. The database publishes no
  port at all, and sits on a network with no route off the host.
- The API and collaboration server authenticate each other with mutual TLS, so
  neither internal endpoint is usable by anything else on the host — including a
  compromised web container.
- HTTPS is obtained and renewed automatically, HTTP is redirected, and responses
  carry HSTS, a content-security policy, and clickjacking/MIME-sniffing
  protections.
- Containers run as an unprivileged user with a read-only filesystem, no extra
  Linux capabilities, no ability to gain privileges, and CPU, memory and process
  limits. Nothing has access to the Docker socket.
- Base images are pinned by digest, so a rebuild cannot silently pull different
  content.

### Administering the database

Do not publish the Postgres port. Connect through the running container instead:

```bash
docker compose -f docker/docker-compose.prod.yml exec postgres psql -U asciidocollab
```

### Limits worth knowing before you deploy

- **Script execution is not locked down.** The content-security policy restricts
  where images, fonts, styles and network connections may come from, and forbids
  framing the site — but it still permits inline and dynamically-evaluated
  scripts, because Next.js and the chart renderer require them. It reduces the
  blast radius of an injection; it does not eliminate it.
- **Secrets are passed as environment variables**, so anyone who can talk to the
  Docker daemon on the host can read them. That is already equivalent to root on
  that machine, so treat host access as the real boundary.
- **One instance of each service, on one host.** No replication or failover, and
  the collaboration server keeps open documents in memory, so it cannot simply be
  scaled to multiple replicas. Backups are not shipped off-host, and there is no
  log aggregation or metrics — connect those to your own infrastructure.
- **Upgrades apply database migrations automatically.** Take a backup first; see
  [Upgrading](#upgrading).
