<p align="center"><img src="assets/banner.png" alt="AsciiDoCollab" width="100%"></p>

<p align="center">
  <a href="https://github.com/joaoleal/asciidocollab/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/joaoleal/asciidocollab/ci.yml?branch=main&label=CI&logo=github" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node >= 24">
  <img src="https://img.shields.io/badge/pnpm-%3E%3D11-f69220?logo=pnpm&logoColor=white" alt="pnpm >= 11">
  <img src="https://img.shields.io/badge/status-pre--MVP-e0a458.svg" alt="Status: pre-MVP">
</p>

> **⚠ Pre-MVP — not ready for production use.**
> The editor, file management, real-time co-editing and in-browser PDF export are built and working —
> co-editing is under active hardening. Git integration, the last MVP feature, is not yet built. See
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

**Foundation (built, under active hardening)**

- Real-time co-editing — edit the same document together and see collaborators' cursors, selections, and changes
  as they happen; conflict-free by construction (Yjs CRDT over WebSocket) with shared undo/redo
- User accounts — self-registration with email verification, admin invitation flow
- Secure login with session management (Argon2id, encrypted sessions, rate limiting, breach detection
  via [Have I Been Pwned](https://haveibeenpwned.com))
- Create and manage projects to organise your work
- File and folder management — create, rename, move, delete files and folders; real-time tree sync via SSE
- Invite team members and assign roles — Viewer, Editor, or Owner
- Admin panel — manage users, toggle open registration, audit log
- Configurable email delivery (SMTP, SendGrid, or AWS SES)
- AsciiDoc code editor — CodeMirror 6 with AsciiDoc syntax highlighting, auto-save, table editing, autocomplete
  for images and includes, block title captions, and multiple editor themes
- Live HTML preview — Asciidoctor.js renders AsciiDoc to HTML in the browser
- In-browser PDF export & live PDF preview — renders the project to a print-ready PDF entirely client-side via
  the real Asciidoctor-PDF engine compiled to WebAssembly (no server round-trip, no upload); project images,
  custom fonts (including WOFF2), PDF themes, citations, STEM math (block and inline), and diagrams
  (mermaid, graphviz/DOT, vega/vega-lite) are all rendered. Diagrams also render in the on-screen HTML preview,
  and diagram blocks get their own syntax highlighting in the editor.
- PDF theme editor — edit your project's theme as YAML beside a live preview of a sample document that
  exercises every element a theme can style, so a change to almost any setting visibly moves something.
  The editor knows the whole Asciidoctor-PDF theme vocabulary: completion for every setting and its
  permitted values, hover documentation for the ones already in the file, inline colour swatches and
  font samples, and warnings for settings the renderer will not read. Themes are ordinary project
  files, so two people can edit one together like any other document.
- PDF converter extensions — opt-in changes to how the PDF is produced: numbered paragraphs, a generated
  licence page, multi-column sections, per-chapter contents lists, landscape pages for wide tables, and
  more. Enable them per project in the project's options; each is off until you turn it on, and turning
  one off returns the document exactly as it was. Administrators can add their own — see
  [`CONFIGURATION.md`](CONFIGURATION.md#pdf-converter-extensions).

**Not yet built (MVP blockers)**

- Git integration — push, pull, branch, and create pull requests from the UI

**Planned after MVP**

- SSO / SAML 2.0 (Microsoft Entra ID and compatible providers)
- Multi-factor authentication and IP-based access controls

---

## Project status

**This project has not reached MVP.**

The authentication, file management, editor, and real-time collaboration layers are built and have been through
multiple rounds of code review and hardening. In-browser PDF export and live preview are complete, including
citations, math and diagrams. Git integration — the remaining MVP feature — is not yet started.

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
| Git integration                     | ❌ Not started     |
| Self-hosted deployment (Docker)     | ✅ Built           |

Do not deploy this to production or rely on it for real work yet. The API and data model may change before MVP.

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

The stability warning above still applies — treat this as suitable for trials and
internal deployments.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[Apache License 2.0](LICENSE)
