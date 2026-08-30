<p align="center"><img src="assets/banner.png" alt="AsciiDoCollab" width="100%"></p>

<p align="center">
  <a href="https://github.com/joaoleal/asciidocollab/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/joaoleal/asciidocollab/ci.yml?branch=main&label=CI&logo=github" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node >= 24">
  <img src="https://img.shields.io/badge/pnpm-%3E%3D11-f69220?logo=pnpm&logoColor=white" alt="pnpm >= 11">
  <img src="https://img.shields.io/badge/status-pre--1.0-e0a458.svg" alt="Status: pre-1.0">
</p>

> **⚠ Pre-1.0 — not yet hardened for production.**
> The editor, file management, real-time co-editing, in-browser PDF export and Git repository sync are
> all built and working; co-editing is under active hardening. See
> [Project status](#project-status) for the honest picture.

**Collaborative AsciiDoc editing for teams — self-hosted, secure, and built for real work.**

Write technical documentation, books, and structured content in AsciiDoc format — together, in real time, in your
browser. No lock-in, no vendor dependency: deploy it on your own infrastructure and keep full control of your documents.

---

## What it does

AsciiDoCollab gives your team a shared space to write and manage AsciiDoc documents. Multiple people can edit the same
document simultaneously, preview rendered output live, export to PDF, and integrate with Git — all from a single,
self-hosted web application.

## Features

Everything below is built and working today — see [Project status](#project-status) for how far each layer has been
hardened.

### Writing

- A dedicated AsciiDoc editor: syntax highlighting, auto-save, table editing, autocomplete for images and
  includes, block title captions, and a choice of editor themes
- Live HTML preview beside your text, with diagrams (mermaid, graphviz/DOT, vega/vega-lite) and STEM math
  rendered inline

### Working together

- Real-time co-editing — several people in one document, seeing each other's cursors, selections and edits as
  they happen, with no changes lost to collisions
- Projects, folders and files, with the file tree updating live for everyone
- Invite teammates and give them a role: Viewer, Editor, or Owner

### PDF publishing

- One-click PDF export and a live PDF preview, produced entirely in your browser — no upload, no server
  round-trip, no queue
- Your images, custom fonts, citations, math and diagrams all come out in the PDF, rendered by the real
  Asciidoctor-PDF toolchain
- A PDF theme editor with live preview: edit your project's theme beside a sample document, with completion and
  documentation for every setting, colour swatches, and font samples
- Optional per-project layout extensions — numbered paragraphs, a generated licence page, multi-column sections,
  per-chapter contents lists, landscape pages for wide tables and more; each is off until you turn it on
  ([details](CONFIGURATION.md#pdf-converter-extensions))

### Git

- Connect a project to GitHub, GitLab, or Bitbucket and commit, pull, push, switch and create branches, and read
  history and per-line blame — all from the editor toolbar
- **Always revertible, never lossy** — a clean pull or branch switch is one click to undo, a conflict is resolved
  file-by-file in the editor or abandoned back to where you started, and no uncommitted work is lost on the way
- Authorize with a personal access token, or with guided OAuth when your administrator enables it

### Accounts and administration

- Self-registration with email verification, or invitation-only — with rate limiting and passwords checked against
  known breaches via [Have I Been Pwned](https://haveibeenpwned.com)
- Admin panel: manage users, toggle open registration, review the audit log
- Configurable email delivery (SMTP, SendGrid, or AWS SES)

### Planned after MVP

- Pull-request creation from the UI (GitHub, GitLab, Bitbucket)
- SSO / SAML 2.0 (Microsoft Entra ID and compatible providers)
- Multi-factor authentication and IP-based access controls

---

## Project status

**The MVP feature set is complete, but the project is not yet production-hardened.**

The authentication, file management, editor, and real-time collaboration layers are built and have been through
multiple rounds of code review and hardening. In-browser PDF export and live preview are complete, including
citations, math and diagrams. Git repository sync is built end to end — connect/import/initialize, commit, pull,
push, branch switch and creation, history, blame, and always-revertible conflict handling — via a dedicated
`apps/git-worker` process (see [Self-hosting](#self-hosting) for how it is wired in).

| Layer                               | Status            |
|-------------------------------------|-------------------|
| Authentication & session management | ✅ Built, hardened |
| User registration & invitation flow | ✅ Built, hardened |
| Project & team management           | ✅ Built           |
| Admin panel & audit log             | ✅ Built           |
| File & folder management            | ✅ Built           |
| AsciiDoc editor                     | ✅ Built           |
| Live HTML preview                   | ✅ Built           |
| Real-time collaboration             | ✅ Built           |
| PDF export & live preview           | ✅ Built           |
| Git repository sync                 | ✅ Built           |
| Self-hosted deployment (Docker)     | ✅ Built           |

Do not deploy this to production or rely on it for real work yet. The API and data model may change before 1.0.

A hardened Docker stack for self-hosting is built and tested — see
[Self-hosting](#self-hosting) below. It does not change the pre-MVP status of the
application itself.

---

## Quickstart

The fastest way to get AsciiDoCollab running locally is with the included startup script. You need:

- [Docker](https://docs.docker.com/get-docker/) (for PostgreSQL and local email)
- [Node.js 24+](https://nodejs.org)
- [pnpm 11+](https://pnpm.io/installation)

```bash
git clone https://github.com/joaoleal/asciidocollab.git
cd asciidocollab
./scripts/dev.sh
```

The script will:

1. Start PostgreSQL and a local mail server via Docker
2. Create a `.env.local` from the provided template (auto-generating secrets)
3. Install all dependencies
4. Build the codebase and apply the database schema
5. Start the API server (`http://localhost:4000`), the collaboration WebSocket server
   (`ws://localhost:4002`), and the web app (`http://localhost:3000`)

**Local email preview** — all outbound emails (registration, password reset) are captured
by [Mailpit](https://mailpit.axllent.org) and visible at `http://localhost:8025`. Nothing is sent to real addresses.

---

## Configuration

Everything has a secure default, so a local install works out of the box. For a
real deployment you need to set a database URL, two generated secrets, your
public URL and an email sender address.

See **[CONFIGURATION.md](CONFIGURATION.md)** for the full reference, or
`.env.example` for the annotated list of every setting.

Git repository sync (import/commit/push/pull/branch against GitHub, GitLab or Bitbucket) has its own
delivery app, `apps/git-worker` — see [`apps/git-worker/README.md`](apps/git-worker/README.md) to run
it, and the [Git repository sync](CONFIGURATION.md#git-repository-sync) section of the configuration
reference for its security config and the operator actions it requires before real use.

---

## Self-hosting

AsciiDoCollab is designed to be self-hosted. No cloud accounts, no telemetry, no
external services required — you need a PostgreSQL database, a way to send email,
and somewhere to run Node.js.

The supported path is the Docker stack in **[docker/README.md](docker/README.md)**:
Postgres, the API, the collaboration server, the web app and a reverse proxy with
automatic HTTPS. Secrets and internal certificates are generated for you; you
supply a domain and SMTP credentials.

Git repository sync runs in its own delivery app, `apps/git-worker` — the only part of
the deployment that shells out to `git`/`git-lfs` and talks to a remote. It is **not**
included in the default production compose file; to enable git sync you add the service
yourself (a ready-made compose fragment, including the egress-proxy sidecar its host
allowlist needs, ships in `docker/git-worker-egress-policy.md`). See
[`apps/git-worker/README.md`](apps/git-worker/README.md) and the
[Git repository sync](CONFIGURATION.md#git-repository-sync) configuration reference.

The stability warning above still applies — treat this as suitable for trials and
internal deployments.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[Apache License 2.0](LICENSE)
