# Implementation Plan: Git Repository Synchronization

**Branch**: `048-git-repository-sync` | **Date**: 2026-08-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/048-git-repository-sync/spec.md`

## Summary

Give a project a two-way link to a remote Git repository (GitHub/GitLab/Bitbucket) while it stays a
live collaborative editor. Users import a repo into a new project or connect/initialize an existing
one; stage changes against a real index; see per-file status in the tree; commit (with a required
message and a reviewed, live-accurate change set) and push; pull and switch branches with incoming
changes landing safely into open documents; resolve conflicts in-app (per-file side choice or inline
3-way merge); plus history/diff/discard and remote automation extras.

**Technical approach** (from [research.md](./research.md)): run the real `git` CLI inside a **bounded,
warm pool of sandbox git-worker containers** (new `apps/git-worker`); each project's `.git` working tree
persists at `<storageRoot>/<projectId>/` (sibling of `.collab/`). **No external queue library**: short
git ops (status, diff, stage, branch list) are direct internal-HTTP calls to a worker (reusing the
existing collab internal-server pattern); long ops (import, pull, push) are dispatched via a
**`GitOperation` work-list table** the workers poll and claim with `SELECT … FOR UPDATE SKIP LOCKED`,
returning `202` immediately. Every **mutating** op — long or short (stage/commit/discard/amend) — takes
the same per-project single-flight guard (FR-009), so the short-op RPC path can't race a running
pull/checkout on the same working tree; read-only short ops stay lock-free. Content fidelity with live editing is achieved by
reusing the existing authoritative live-content **reader** for commit capture and a **new
`apply-full-content` collab endpoint** to land pulled/merged text into open Yjs rooms so it reaches
editors and survives save-back. Credentials are encrypted at rest by reusing `SessionEncryption`
(AES-256-GCM) under a dedicated key. Cross-instance single-flight and the content-changing write-lock
use a durable `GitOperation` work-list row (unique active op per project) plus a heartbeat sweep to
recover ops orphaned by a worker crash. The dormant `GitRepository` model/port is finally wired.

See [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: TypeScript (strict), Node ≥ 24, ESM. pnpm 11 workspaces.

**Primary Dependencies**: Fastify (API), Next.js 16 / React 19 (web), Hocuspocus v4 + Yjs (collab),
Prisma 7.9 + `@prisma/adapter-pg` (Postgres). **New**: system `git` + `git-lfs` (worker image), a JS
text-diff lib (used both to render diffs client-side and to compute the minimal Yjs edit when landing
pulled content), bundled with no external host. **No new queue/broker dependency** — job dispatch is a
polled Prisma table (see Summary).

**Storage**: PostgreSQL (Prisma) for metadata (incl. the `GitOperation` work-list); filesystem storage
volume at `storage.path` for project files (`<storageRoot>/<projectId>/…`), Yjs blobs (`.collab/`), and
now the git working tree + `.git`.

**Testing**: Jest + Testing Library (unit/integration), in-memory fakes for domain ports,
testcontainers (Postgres, git temp remotes) for infrastructure, Playwright for E2E.

**Target Platform**: Linux server (containerized); modern browsers for the editor.

**Project Type**: Web — modular monolith / clean architecture across pnpm packages + apps, **plus one
new delivery app** (`apps/git-worker`).

**Performance Goals**: Interactive tree-status refresh (no full-page reload, FR-027); warm worker pool
avoids per-op container startup; concrete latency budgets and pool sizing are tuned in tasks (not
asserted as tests — performance tests are opt-in per Constitution II).

**Constraints**: Live-editing coexistence (FR-005–008a) is the central constraint; all-or-nothing +
single-flight (FR-009/010); egress denied except the configured remote (D8); no git on the API host;
secrets AES-256 at rest, never logged.

**Scale/Scope**: Workers sized to load, independent of project count; large repos handled by the CLI +
LFS. Feature delivered by the spec's prioritized user stories (D13).

## Constitution Check

*GATE: must pass before Phase 0 and re-checked after Phase 1 design.*

**Governance (v2.6.0 — unchanged)**
- **II TDD (NON-NEGOTIABLE)** — PASS. Every use case/adapter built via `/tdd`; new ports get in-memory
  fakes (III). One deliverable = one task = one `/tdd`.
- **III Seam testing / fakes** — PASS. New `ports/git/*` each mirrored in `tests/ports/git/*`.
- **IX Untrusted Input Boundary (NON-NEGOTIABLE)** — PASS with explicit design: pulled remote content
  is externally-sourced → paths are sandbox-confined (reject any entry resolving outside
  `<storageRoot>/<projectId>/`, extending the existing `resolveSafe` guard; reject symlink/`..` escape),
  and any pulled content shown in the preview flows through the **existing sanitizer unchanged** (no new
  path). Remote fetch is confined to the egress allowlist (SSRF control). `git` treats content as inert
  data.
- **X Client-Side by Default — No Source Egress (NON-NEGOTIABLE)** — PASS (feature-scoped, Principle X
  text UNCHANGED). Principle X prohibits sending source to a server *for rendering/export*; git push is
  not rendering. It is an explicit, user-initiated **publish to a remote the user configured for this
  project** — the user-configured destination is the allowlist and the user-triggered sync is the
  consent, satisfying the principle's existing "explicit consent via an allowlisted path" gate. Two
  conditions the design guarantees: (a) the destination is a per-project user-configured remote
  (FR-003/004), never an implicit default; (b) egress happens only on an explicit user action — the
  background *fetch* (FR-038) reads remote status only and **never egresses content**. Diff/merge
  **rendering stays client-side** (D9). We deliberately did **not** amend Principle X (a non-negotiable);
  this reasoning is recorded here at feature scope. If the team wants it in the constitution, ratify it
  separately per the Amendment Procedure.
- **XI/XII/XV Reference-build parity / determinism / fidelity** — N/A (no PDF/rendering-fidelity change).
- **V Design tokens / VI style isolation / VII per-user prefs** — PASS. New UI (git panel, tree badges,
  commit dialog, conflict/merge view, history/diff) uses design tokens, light/dark; the connection is
  **project-scoped configuration** (permission-gated, stored on the project — the sanctioned non-preference
  case in VII), not a per-user preference.
- **VIII Editor pipeline integrity** — PASS. Landing content goes through the collab layer
  (`apply-full-content`) as a normal Yjs transaction; sanitization and scroll-sync seams are untouched;
  a regression test covers the apply path.

**Architecture Constitution (v2.5.0)**
- Layer boundaries — PASS: git logic as domain use cases + ports; infrastructure adapters; `apps/git-worker`
  and `apps/api` are delivery. Domain stays dependency-free. `packages/*` never imports `apps/*`.
- Data access via Prisma, ports in `packages/domain/src/ports/git/` with fakes — PASS. The only raw SQL
  is a single `SELECT … FOR UPDATE SKIP LOCKED` to claim the next queued `GitOperation`, under the
  **documented-justification exemption** added in architecture constitution **2.6.0** (Data Access
  Rules), confined behind `GitOperationRepository.claimNextQueued`; all other data goes through Prisma.
- `Result<T,E>` + typed errors, DTOs in `packages/shared` — PASS. All `GitCommandRunner` outputs
  (commits, diffs, conflict stages, status) cross the port as **`packages/shared` DTOs** — no
  git-library type leaks past the infrastructure adapter into domain.
- **Async & Integration Rules — PASS, ratified**: architecture constitution **2.6.0** now mandates git
  runs only in sandboxed `apps/git-worker` containers (never a host process) served by a bounded warm
  pool with single-project-scoped, freshly-cleaned jobs — exactly this design. `apps/git-worker` is
  recorded there as a sanctioned delivery app.
- Migration policy — PASS: schema edits proposed in data-model.md; **no migration generated without
  explicit user confirmation.**

**Security Constitution (v1.3.0)**
- RBAC in use cases (FR-021 matrix) — PASS.
- Secrets AES-256 at rest + never logged (D5) — PASS. Execution-time credential handling meets the
  new Git Sandbox rule (1.3.0): the decrypted token is supplied via an ephemeral credential
  helper / askpass or environment — **never** in process argv, the remote URL, `.git/config`, the
  working tree, logs, or any persisted artifact — and is scrubbed from worker memory after the job.
- Input validation at the boundary + argument-injection defenses — PASS.
- Rate limiting on expensive/amplifying git routes, configurable — PASS.
- Audit of git actions + authz denials — PASS.
- **Git Sandbox execution & network — PASS, ratified**: security constitution **1.3.0** now permits a
  bounded warm git-worker pool (never on a host process) with single-project-scoped, freshly-cleaned
  jobs and **no shared state between projects**, and permits **deny-by-default egress allowlisted to
  the configured remote** as the sole narrow exception. Enforced at the **network layer** (not URL
  strings), with git **cross-host redirect following disabled** to block redirect-based SSRF (S5).
  This design matches the amended rule exactly.

**The two constitution tensions are ratified via amendments to the two *reference* constitutions
(architecture 2.6.0 — git-worker rule + one `SKIP LOCKED` data-access exemption; security 1.3.0 — Git
Sandbox Security). Governance Principle X was intentionally **not** amended: git-sync egress is
documented as a user-consented, allowlisted publish at feature scope (Principle X row above). No
external queue dependency is introduced — a polled `GitOperation` table replaces the earlier pg-boss
idea.**

## Project Structure

### Documentation (this feature)

```text
specs/048-git-repository-sync/
├── plan.md              # This file
├── research.md          # Phase 0 decisions (D1–D13)
├── data-model.md        # Entities, Prisma changes, ports, authz matrix
├── contracts/
│   ├── rest-api.md      # apps/api git routes
│   └── internal-collab.md # apply-full-content endpoint + git-worker job contract
├── quickstart.md        # End-to-end smoke paths + test strategy
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/
├── db/prisma/schema.prisma        # + GitCredential, GitOperation, GitConflict, enums; extend GitRepository
├── shared/src/                    # + git DTOs & typed error types
├── domain/src/
│   ├── entities/git-*.ts          # GitRepository (extend), GitCredential, GitOperation, GitConflict, VOs
│   ├── ports/git/                 # GitCredentialStore, GitOperationRepository (incl. claimNextQueued),
│   │                              #   GitCommandRunner (+ reuse GitRepositoryRepository,
│   │                              #   CollaborativeContentReader; + new CollaborativeContentWriter)
│   ├── ports/storage/collaborative-content-writer.ts
│   └── use-cases/git/             # connect/import/initialize/disconnect/status/stage/commit/push/
│       │                          #   pull/branch/checkout/resolve/discard/amend/undo/history/diff
│   └── tests/ports/git/           # in-memory fakes (mirrors ports/git/)
├── infrastructure/src/
│   ├── persistence/git/           # Prisma GitOperation/Conflict repos (incl. claimNextQueued via
│   │                              #   SELECT … FOR UPDATE SKIP LOCKED), GitCredentialStore (SessionEncryption)
│   └── services/http-collaborative-content-editor.ts  # + replaceContent (apply-full-content, minimal diff)
apps/
├── api/src/
│   ├── config/schema-git.ts       # NEW config fragment (registered in schema.ts)
│   ├── routes/projects/git/       # NEW git routes (contracts/rest-api.md)
│   ├── routes/projects/file-tree-*.ts # extend: write-lock 409s; tree-status source
│   └── di/{services,stores,repositories}.ts # wire git services/stores (git repo already registered)
├── git-worker/                    # NEW delivery app: polls GitOperation work-list + serves sync RPC;
│   └── src/                       #   GitCommandRunner (execFile git+git-lfs) in the sandbox image; heartbeat sweep
├── collab/src/
│   ├── internal-edit-server.ts    # + /internal/collab/apply-full-content
│   └── apply-edits.ts             # + replaceDocumentContent (whole Y.Text in one txn)
└── web/src/
    ├── components/file-tree/file-tree-node.tsx  # + statusByFile badge (mirrors presenceByFile)
    ├── components/git/            # NEW: connect panel, commit dialog (staging), branch switcher,
    │                             #   conflict/3-way merge view, history/diff view, status bar
    ├── hooks/use-git-status.ts    # NEW: tree-status producer (analogous to use-collab-presence)
    └── lib/api/git.ts             # NEW API client

tests/  (mirrored per package/app under each `tests/` root — never __tests__ or co-located)
```

**Structure Decision**: Modular monolith + clean architecture (existing) **plus one new delivery app
`apps/git-worker`**. This is the minimal structural addition: git execution cannot live in the API
process (Architecture "no host git") or the domain (no IO), so a dedicated worker delivery app that
hosts the `GitCommandRunner` adapter is required. All business logic stays in
`packages/domain/src/use-cases/git`; both `apps/api` (enqueue + reads) and `apps/git-worker` (execute)
are thin delivery layers over the same use cases. Job dispatch needs no broker: the API inserts a
`GitOperation` row and workers poll/claim it (`SELECT … FOR UPDATE SKIP LOCKED`); short ops are a direct
internal-HTTP call reusing the collab internal-server pattern.

## Complexity Tracking

| Violation / Deviation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **New app `apps/git-worker`** (4th delivery app) | Git must run off the API host (Architecture mandate) and out-of-process (minutes-long, network-bound); domain can't do IO | Running git in `apps/api` violates "no host git" and blocks Fastify workers; no existing worker app to extend |
| **One raw `SKIP LOCKED` query** for job claim | Prisma has no SKIP LOCKED primitive; it's the canonical safe-claim pattern | A pure-Prisma claim risks double-processing; an external queue library (pg-boss/BullMQ) is far more than a handful of human-triggered git ops per project needs (BullMQ also needs Redis) |
| **Worker pool instead of container-per-git-op** (ratified, arch 2.6.0) | Per-op containers add ~0.5 s startup to every status/commit; per-project containers sprawl | Both rejected in clarification; a clean per-job workspace in a warm pool preserves isolation intent — now the mandated model |
| **Egress allowlist instead of "no network"** (ratified, security 1.3.0) | Push/pull inherently require the remote | Literal "no network" makes sync impossible; unrestricted egress is an SSRF surface — the allowlist is the sanctioned narrow exception |

The two constitution tensions the architecture-guard gate flagged as Critical are **resolved by
amendment of the two reference constitutions** (architecture 2.6.0, security 1.3.0). Governance
Principle X was **intentionally left unchanged** — git-sync egress is documented as a user-consented,
allowlisted publish at feature scope (Constitution Check › Principle X), not by amending a
non-negotiable. No external queue dependency is introduced (a polled `GitOperation` table replaces the
earlier pg-boss idea), so there is no repo-wide async-framework decision riding on this feature.

## Phase 0 — Outline & Research

**Output**: [research.md](./research.md) — all unknowns resolved (D1–D13). No open `NEEDS CLARIFICATION`.

## Phase 1 — Design & Contracts

**Outputs**: [data-model.md](./data-model.md), [contracts/rest-api.md](./contracts/rest-api.md),
[contracts/internal-collab.md](./contracts/internal-collab.md), [quickstart.md](./quickstart.md), and
the agent-context update (root `AGENTS.md` SPECKIT block → this plan).

**Post-design Constitution re-check**: PASS — the design keeps domain pure, uses ports + fakes, routes
authz through use cases, keeps rendering client-side, and confines the two deviations to the reference
constitutions with a documented amendment path. No NON-NEGOTIABLE principle is waived.

## Next

Run `/speckit-tasks` to generate the dependency-ordered `tasks.md` (organized by the P1–P6 user stories
+ additive bundles). Consider `/speckit-constitution` to land the two reference-doc amendments before
implementation, and confirm whether to generate the Prisma migration for the new models.
