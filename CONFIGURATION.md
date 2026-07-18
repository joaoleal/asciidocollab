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
