# Configuration reference

Every setting has a secure default, so a local install needs almost none of this.
Copy `.env.example` to `.env.local` and override what you need — `.env.example`
carries the full list with inline descriptions.

If you are deploying with Docker, most of this is handled for you: see
[`docker/README.md`](docker/README.md), where `generate-secrets.sh` produces the
secrets and the compose file derives the URLs from your domain.

---

## Required for any real deployment

| Variable                                    | Purpose                                                                |
|---------------------------------------------|------------------------------------------------------------------------|
| `ASCIIDOCOLLAB_DATABASE_URL`                | PostgreSQL connection string                                           |
| `ASCIIDOCOLLAB_AUTH_SESSION_SECRET`         | Cookie signing secret (`openssl rand -base64 32`)                      |
| `ASCIIDOCOLLAB_AUTH_SESSION_ENCRYPTION_KEY` | Session encryption key (`openssl rand -base64 32`)                     |
| `ASCIIDOCOLLAB_API_FRONTEND_URL`            | Public frontend URL — embedded in password-reset and invitation emails |
| `ASCIIDOCOLLAB_AUTH_EMAIL_FROM`             | From address for outbound email; the API refuses to start without it   |

## Real-time collaboration

The web client connects directly to the collaboration WebSocket server.

| Variable                                        | Purpose                                                                                                           |
|-------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| `NEXT_PUBLIC_COLLAB_URL`                        | WebSocket URL of the collab server (default `ws://localhost:4002`; use `wss://` in production)                    |
| `ASCIIDOCOLLAB_COLLAB_ALLOWED_ORIGINS`          | Comma-separated allowlist of handshake Origins. **Must** be set in production — an empty value disables the check |
| `ASCIIDOCOLLAB_COLLAB_MAX_PAYLOAD_BYTES`        | Maximum size of a single inbound collaboration message                                                            |
| `ASCIIDOCOLLAB_COLLAB_MAX_CONNECTIONS_PER_USER` | Concurrent WebSocket connections allowed per user                                                                 |
| `ASCIIDOCOLLAB_COLLAB_MAX_ROOMS_PER_USER`       | Distinct documents a user may have open at once                                                                   |
| `ASCIIDOCOLLAB_COLLAB_CONNECT_RATE_PER_MIN`     | New connections accepted per user per minute                                                                      |

Two constraints that are easy to miss:

- **The session cookie carries the authentication.** The collab server must share
  a registrable domain with the web app, or the browser will not send the cookie
  on the WebSocket handshake. Serve it over `wss://`.
- **Cross-site WebSocket hijacking** is prevented by the Origin allowlist above.
  Leaving `ALLOWED_ORIGINS` empty is a development-only convenience.

## Shared file storage

`ASCIIDOCOLLAB_STORAGE_PATH` sets the root directory for project files.

The API and the collab server **must point at the same directory**. They both
write document content, so if the paths diverge, edits are written to two
different places and silently overwrite one another. The collab server verifies
this at startup and refuses to run if the check fails.

## Internal API ↔ collab channel

The API and collab server talk over two internal endpoints: collab asks the API
to authorise each connection, and the API asks collab to rewrite cross-file
references inside live documents.

Both default to loopback, which is safe when the two run on the same host. If
they run on separate hosts — or in separate containers — secure them.

| Variable                                                      | Purpose                                                                                              |
|---------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `ASCIIDOCOLLAB_COLLAB_EDIT_URL`                               | Where the API reaches collab's internal edit endpoint (default loopback `:4003`)                     |
| `ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_PORT` / `_HOST`           | Where collab binds that endpoint                                                                     |
| `ASCIIDOCOLLAB_COLLAB_INTERNAL_PORT` / `_HOST`                | Where the API binds its authorisation endpoint                                                       |
| `ASCIIDOCOLLAB_COLLAB_EDIT_SECRET`                            | Shared secret for the edit endpoint. Must equal collab's `ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_SECRET` |
| `ASCIIDOCOLLAB_COLLAB_EDIT_TLS_*` / `_INTERNAL_EDIT_TLS_*`    | Client and server mTLS material for the edit endpoint                                                |
| `ASCIIDOCOLLAB_COLLAB_INTERNAL_TLS_*` / `_API_INTERNAL_TLS_*` | Client and server mTLS material for the authorisation endpoint                                       |

The Docker deployment sets all of these up automatically, including issuing the
certificates — see the mTLS section of [`docker/README.md`](docker/README.md).

## Email delivery

Email is not optional: account verification, invitations and password resets all
depend on it.

| Variable                                                         | Purpose                     |
|------------------------------------------------------------------|-----------------------------|
| `ASCIIDOCOLLAB_AUTH_EMAIL_PROVIDER`                              | `smtp`, `sendgrid` or `ses` |
| `ASCIIDOCOLLAB_AUTH_SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` | SMTP relay settings         |
| `ASCIIDOCOLLAB_AUTH_SENDGRID_API_KEY`                            | SendGrid credentials        |
| `ASCIIDOCOLLAB_AUTH_SES_REGION`                                  | AWS SES region              |

For local development, `scripts/dev.sh` starts [Mailpit](https://mailpit.axllent.org)
and captures everything at `http://localhost:8025`; nothing reaches real addresses.

## PDF converter extensions

Projects can enable converter extensions that change how their PDF is produced —
numbered paragraphs, a generated licence page, multi-column sections. The
application ships a set of these. You can add your own by dropping them into a
folder; no rebuild and no restart is needed.

> **These extensions are as trusted as the application's own code.**
> An extension is Ruby that runs inside the PDF engine **in every project
> member's browser**. It is not sandboxed from the page. Treat adding one exactly
> as you would treat deploying a patch to AsciiDoCollab itself: read it, know
> where it came from, and control write access to the folder.
>
> This is why the folder is the *only* way to add one. A project's stored
> selection is a list of **identifiers**, never code, and nothing under a
> project's own files is ever executed — project content is member-writable, so
> if it were executable, any member with write access could run code in every
> other member's browser.

| Variable                                                | Purpose                                                                                                   |
|---------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| `ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_PATH`             | Folder to read extensions from (default `/data/pdf-extensions`)                                           |
| `ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_MAX`              | Most extensions read from the folder (default 50)                                                         |
| `ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_MAX_SOURCE_BYTES` | Largest single extension source (default 256 KiB)                                                         |
| `ASCIIDOCOLLAB_PROJECT_PDF_EXTENSIONS_SCAN_CACHE_TTL`   | How long a folder scan is reused, in ms (default 30000) — bounds how long a new extension takes to appear |

### Adding an extension

One directory per extension, each carrying two files:

```
/data/pdf-extensions/
└── my-extension/
    ├── manifest.json
    └── extension.rb
```

`manifest.json` needs `id`, `displayName` and `description`; `targeting`,
`themeKeys` and `sampleContent` are optional. The `id` is what a project stores
when it enables the extension, so **it must never change** — renaming it silently
disables the extension for every project that had selected it.

Add the directory and it appears in each project's extension list within the scan
cache TTL. Nothing is restarted, and no image is rebuilt.

With Docker, bind-mount the folder:

```yaml
services:
  api:
    volumes:
      - ./pdf-extensions:/data/pdf-extensions:ro
```

Mounting it read-only is worth doing: the application only ever reads from it.

A missing folder is not an error — it simply means no extensions beyond the
shipped ones are offered.

### When something is wrong with an extension

Anything the folder scan rejects is **reported, not silently skipped**. A
malformed `manifest.json`, an oversized source, or an `id` that collides with a
shipped extension all surface in the project's extension list with a reason
attached. One bad directory does not hide the good ones beside it.

### Debugging a misbehaving extension

**An extension that hangs freezes that member's PDF render, and only a page
reload clears it.**

The PDF convert runs under a synchronous `vm.eval` call inside the render worker.
While Ruby is executing, the worker cannot process any message — including its
own cancel. So an extension that loops forever, or blocks on something that never
completes, leaves the render stuck until the browser tab is reloaded or the tab
is closed. There is no timeout that will rescue it.

This is an operational concern rather than a security one — extensions are
deployment-controlled code — but it means the safe place to try a new extension
is a staging deployment, not the one your team is working in. If a render stalls
after you add an extension, remove its directory from the folder and have
affected members reload; the next render will not load it.

## Git repository sync

Connects a project to a remote Git repository (GitHub, GitLab, Bitbucket, or a compatible
self-hosted instance) for import, commit, push, pull, branching and conflict resolution. The actual
`git`/`git-lfs` commands run in a separate app, `apps/git-worker` — see
[`apps/git-worker/README.md`](apps/git-worker/README.md) for how to run and deploy it. This section
covers the security-relevant configuration, most of which lives on `apps/api` and is mirrored by the
worker.

> **Operator actions required before enabling git sync.** These are not optional hardening — each
> one blocks a real (non-mock, non-dev) deployment from working correctly or safely.
>
> - **A pending database migration.** `EditorPreferences` (table `editor_preferences`) gained a
>   `privateCommitEmail Boolean @default(false)` column in `packages/db/prisma/schema.prisma` with
>   **no migration file generated yet**, by this project's migration policy (schema-only changes
>   are checked in first; a human generates and applies the migration separately). The per-user
>   privacy-preserving commit email opt-in will not work against a real database until you run
>   `prisma migrate dev` (or your usual migration workflow) to generate and apply it.
>
>   A second change is captured but **deliberately withheld** even further: "one active git
>   operation per project" is meant to be enforced by a partial unique index on `GitOperation`
>   (`projectId`, scoped to the `QUEUED`/`RUNNING`/`AWAITING_CONFLICT` states) — Prisma 7.9's schema
>   DSL cannot express a partial *unique* index, so there is no schema line to generate a migration
>   from yet. The exact `CREATE UNIQUE INDEX ... WHERE ...` statement is kept at
>   `packages/infrastructure/src/persistence/git/git-operation-active-op-unique-index.sql` so it
>   isn't lost; it must be added to a migration once one is authorized for this feature. Until then,
>   single-flight is enforced defensively in application code (a `SERIALIZABLE` transaction around
>   the claim), not by the database.
>
> - **OAuth needs `sameSite: 'lax'` on the session cookie.** The guided OAuth connect flow redirects
>   the browser to the provider and back; the callback needs the session cookie to identify who
>   started the flow. The session cookie's `auth.session.cookie.sameSite` setting (there is no env
>   var for it — it is set per environment in `apps/api/config/*.yaml`, e.g. `production.yaml`)
>   defaults to `strict` everywhere, which browsers do **not** attach on a cross-site redirect back
>   from the provider, so the callback looks unauthenticated and fails closed. Guided OAuth connect
>   will not work until an operator deliberately relaxes this to `lax` (a small, app-wide security
>   trade-off, not a per-provider setting) — manual personal-access-token connect is unaffected
>   either way and needs no cookie change.
>
> - **The OAuth flow has only been verified against a mock provider.** Before enabling it against a
>   real GitHub/GitLab/Bitbucket, it needs a human security review and verification against the real
>   provider's authorize/token endpoints, in addition to registering an OAuth application with that
>   provider (see [below](#oauth-guided-connect)).

### Egress allowlist

| Variable                                  | Purpose                                                                                              |
|--------------------------------------------|--------------------------------------------------------------------------------------------------------|
| `ASCIIDOCOLLAB_GIT_EGRESS_ALLOWED_HOSTS`  | Comma-separated hostnames git-worker's outbound git operations may reach (default `github.com,gitlab.com,bitbucket.org`) |

Deny-by-default: a remote whose host is not on this list is rejected before any network attempt is
made. This is enforced at the application layer (`apps/git-worker` resolves and checks the remote's
host, and separately rejects private/link-local addresses and cross-host redirects) **and** must
additionally be enforced at the network layer by whoever deploys the stack — a compromised worker
process must not be able to reach an arbitrary host just because the application-layer check can be
bypassed from inside the container. See
[`docker/git-worker-egress-policy.md`](docker/git-worker-egress-policy.md) for ready-made
docker-compose and Kubernetes fragments; keep both layers' allowlists identical.

### Credential encryption

| Variable                                       | Purpose                                                                                    |
|--------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY`  | Base64, 32-byte AES-256-GCM key encrypting stored git credential tokens (`openssl rand -base64 32`) |

A dedicated key, separate from the session encryption key, so a leak of one does not expose the
other. Personal access tokens and OAuth tokens are stored encrypted at rest and decrypted only at the
moment a git operation needs them; the plaintext token is handed to the real `git` CLI out-of-band via
`GIT_ASKPASS`/environment — never as a command-line argument, never embedded in a remote URL, and
never written into `.git/config` or a log line. `apps/git-worker` needs the identical key
(`ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY` on that app) to decrypt what this one encrypts.

### Rate limiting

| Variable                             | Purpose                                                        |
|----------------------------------------|--------------------------------------------------------------------|
| `ASCIIDOCOLLAB_GIT_RATE_LIMIT_MAX`   | Maximum git operation requests per project per window (default 30) |
| `ASCIIDOCOLLAB_GIT_RATE_LIMIT_WINDOW`| Window length in milliseconds (default 60000)                      |

Applied per project on the mutating/expensive git routes (import, commit, push, pull, branch
operations, and similar). Exceeding it returns `429` with `{ "code": "RATE_LIMITED" }`.

### Repository size and Git LFS

| Variable                                  | Purpose                                                                                    |
|----------------------------------------------|-------------------------------------------------------------------------------------------|
| `ASCIIDOCOLLAB_GIT_MAX_REPO_SIZE_MB`      | Maximum repository size in megabytes permitted for import/connect (default 500)           |
| `ASCIIDOCOLLAB_GIT_LFS_THRESHOLD_BYTES`   | File size in bytes at or above which a tracked file is handled as a Git LFS object rather than stored inline (default 10485760 — 10 MiB) |

An import or clone whose repository exceeds `maxRepoSizeMB` fails gracefully with a
`repository_too_large` error rather than exhausting worker memory or disk. A staged file at or over
`lfsThresholdBytes` is tracked as a Git LFS pointer instead of being committed inline.

### Worker pool and the internal RPC channel

| Variable                             | Purpose                                                                                          |
|----------------------------------------|-------------------------------------------------------------------------------------------------|
| `ASCIIDOCOLLAB_GIT_WORKER_POOL_SIZE` | Number of warm git-worker sandboxes in the pool (default 4) — sized to load, not to project count |
| `ASCIIDOCOLLAB_GIT_WORKER_URL`       | Base URL of `apps/git-worker`'s internal RPC endpoint (default `http://127.0.0.1:4010`)          |
| `ASCIIDOCOLLAB_GIT_WORKER_SECRET`    | Shared secret sent on that channel; must match the worker's `ASCIIDOCOLLAB_GIT_WORKER_INTERNAL_SECRET` |
| `ASCIIDOCOLLAB_GIT_WORKER_TLS_CERT` / `_KEY` / `_CA` | Client mTLS material for that channel; all empty disables mTLS (loopback HTTP)   |

The API reaches the worker over this channel for short synchronous operations (status, stage,
unstage, commit, connect, branches, history, diff, blame, conflict resolution, pull/push previews).
It is authenticated with the shared secret above and never logged; secure it the same way as the
api↔collab internal channel once the two run on separate hosts — see
[`apps/git-worker/README.md`](apps/git-worker/README.md).

### OAuth (guided connect)

| Variable                                                  | Purpose                                                                                    |
|--------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `ASCIIDOCOLLAB_GIT_OAUTH_STATE_ENCRYPTION_KEY`            | Base64, 32-byte AES-256-GCM key encrypting the OAuth `state` parameter. Empty unless at least one provider below is configured — **required** the moment any is (the API refuses to start otherwise) |
| `ASCIIDOCOLLAB_GIT_OAUTH_<GITHUB\|GITLAB\|BITBUCKET>_CLIENT_ID` | The provider's OAuth app client id. Empty (the default) means guided connect is unavailable for that provider — manual personal-access-token connect keeps working regardless |
| `..._CLIENT_SECRET`                                       | The OAuth app's client secret. Never logged, never returned to a client                    |
| `..._REDIRECT_URI`                                        | The exact redirect URI registered with the provider's OAuth app                            |
| `..._SCOPES`                                              | Space-separated OAuth scopes requested (defaults: `repo` for GitHub; `read_repository write_repository` for GitLab; `repository repository:write` for Bitbucket) |
| `..._AUTHORIZE_URL` / `..._TOKEN_URL`                     | The provider's authorize/token endpoints. Default to the real provider (e.g. `https://github.com/login/oauth/authorize` / `.../access_token`) — override for a self-hosted GitLab/Bitbucket instance |

To enable guided OAuth connect for a provider, register an OAuth application with that provider using
the exact `redirectUri` you configure here, then set that provider's `CLIENT_ID`/`CLIENT_SECRET` plus
`ASCIIDOCOLLAB_GIT_OAUTH_STATE_ENCRYPTION_KEY`. See **Operator actions required** above for the
session-cookie change and security review this flow needs before it is exposed to real users.

## Behind a reverse proxy

| Variable                           | Purpose                                                                                                                                                                |
|------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ASCIIDOCOLLAB_API_TRUST_PROXY`    | Trust `X-Forwarded-*` headers. Enable only when the API is reachable exclusively through your proxy                                                                    |
| `ASCIIDOCOLLAB_API_HTTPS_REDIRECT` | Redirect HTTP to HTTPS at the application. Leave off when the proxy already does it — otherwise internal plaintext callers get redirected into a failing TLS handshake |
| `ASCIIDOCOLLAB_API_CORS_ORIGINS`   | Allowed browser origins. Unnecessary when the app and API share one origin                                                                                             |

## Everything else

Password policy, rate limits, lockout windows, session lifetimes, upload limits
and retention periods all have secure defaults. `.env.example` documents each one
alongside its default value.
