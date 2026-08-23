# Implementation Plan: Project Cloning

**Branch**: `047-project-clone` | **Date**: 2026-08-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/047-project-clone/spec.md`

## Summary

A member of any project — viewer, editor or owner — can clone it from the projects dashboard menu
under a new name and become the sole owner of the copy. Content, structure and project-level settings
are copied; members, review items, per-user state, repository credentials and history are not.

The technical shape follows from two spec decisions. Because the clone is **synchronous and
all-or-nothing** (FR-022–FR-024) and the codebase has no transaction abstraction that could span
Postgres *and* the filesystem, the design uses **membership-last visibility**: the whole project is
built while it has no `ProjectMember` rows — which makes it invisible to every membership-gated read
path in the system — and the owner row is written last as the commit point, with compensating cleanup
on failure. Because a failed live read must **fail the clone** rather than fall back (FR-009a), the
existing download content resolver is generalized with an error policy rather than forked.

No schema migration. No new package. No new runtime dependency.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js (API, collab), React 19 / Next.js (web)

**Primary Dependencies**: Fastify + `@fastify/rate-limit` (API), Prisma 7 + PostgreSQL, Yjs +
Hocuspocus (collaboration), Next.js App Router (web). **Nothing new is added.**

**Storage**: PostgreSQL via Prisma (`packages/db`) for structure and settings; per-project filesystem
sandbox via `ProjectFileStore` for file bytes; per-project Yjs state via `YjsStateStore` — *not*
written by this feature (research R3).

**Testing**: Jest with in-memory port fakes (domain), Jest + testcontainers Postgres (infrastructure,
API), Playwright (`apps/web/e2e`). Every task runs through the `/tdd` skill.

**Target Platform**: Linux server (Docker Compose), modern browsers.

**Project Type**: Web application in a modular monolith — `apps/api`, `apps/web`, `apps/collab` over
`packages/{domain,infrastructure,shared,db}`.

**Performance Goals**: SC-003 — a project of ≤200 files / ≤50 MB clones within 30 seconds of
confirmation. Per Principle II, no performance test is added: the spec states the budget but does not
request load testing.

**Constraints**: the clone must be invisible until it succeeds and leave no trace on failure
(FR-023/FR-024); it must never modify the source (FR-007); one clone in flight per user (FR-027).

**Scale/Scope**: 1 new domain use case, 1 new domain port, 3 new domain errors, 1 generalized
resolver, 1 API route, 1 web dialog, 1 changed web component.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 — see the re-check at the end.*

Governance constitution v2.6.0.

| Principle | Assessment |
|---|---|
| **I. Clean Code** | New domain errors are typed value objects, not strings. The copy order (data-model §6) is a documented invariant, not an accident of statement order. |
| **II. TDD (NON-NEGOTIABLE)** | Every task goes through `/tdd`. Tasks describe deliverables, never "write a test for X" as a separate step. |
| **III. Seam Testing** | The new `ActiveCloneRegistry` port gets an in-memory fake under `packages/domain/tests/ports/project/`, honouring the contract in data-model §2. The clone use case is tested against in-memory fakes only. |
| **IV. Reuse Before Rebuild** | The download content resolver is **generalized, not forked** (R2); cleanup reuses the `DeleteProjectUseCase` pattern (R1); the dashboard reuses the existing card menu and dialog primitives. |
| **V. Theming via Design Tokens** | The clone dialog uses existing token-driven dialog/button primitives. No color literals. |
| **VI. Style Isolation** | Not engaged — no rendered-document styles change. |
| **VII. Per-User Preferences** | Directly engaged and satisfied: `IgnoredLint` is per-user private state and is excluded (FR-018). Project-scoped configuration (`ProjectRenderConfig`, dictionary terms, main file) is legitimately shared and *is* copied — the principle's explicit carve-out. The clone never mutates the source (FR-007). |
| **VIII. Editor Pipeline Integrity** | Not engaged — no sanitizer or scroll-sync change. Cloned content re-enters the editor through the unchanged existing path. |
| **IX. Untrusted Input Boundary (NON-NEGOTIABLE)** | Engaged on two surfaces. (a) The new project **name** is user input, validated by `ProjectName.create`. (b) Every byte written lands in the *clone's* sandbox through `ProjectFileStore`, at paths copied verbatim from already-validated `FileNode.path` values in the source — no user-supplied path enters the write path, so no new traversal surface exists. No remote fetch, no new sanitization path. |
| **X. Client-Side by Default (NON-NEGOTIABLE)** | **No egress.** The principle governs document content leaving the client to be processed. A clone moves content between two projects *inside* the system, from stores where it already lives (the file store and the collaboration server) to a new sandbox on the same host. Nothing is transmitted to any third party, and no rendering happens server-side. The principle is not weakened; it is not reached. |
| **XI. Reference-Build Parity (NON-NEGOTIABLE)** | Not engaged — no rendering or export code path is introduced. The clone inherits the source's parity by construction, having the same inputs and the same render config (R9). |
| **XII. Deterministic Output** | Satisfied structurally: asset bytes are copied verbatim; document bytes are the resolved UTF-8 snapshot. No time, locale or ordering dependence enters the output. |
| **XIII. Non-Blocking Responsiveness** | The clone runs server-side; the editor is not involved. The dashboard stays interactive during the wait — the pending state is confined to the dialog (contracts/clone-project-ui.md). |
| **XIV. Sandbox-Safe Dependencies** | Not engaged — no rendering dependency involved. |
| **XV. Fidelity Verified Before Done** | Not engaged, and R9 records why rather than leaving it implied: this feature adds no fidelity-critical behaviour. SC-006's clone-renders-like-source claim is verified by settings and content equality plus one e2e export-equality check — deliberately *not* presented as a fidelity-oracle run. |

**Architecture constitution v2.5.0**: the use case and both ports live in `packages/domain`;
Prisma/filesystem/in-memory implementations in `packages/infrastructure`; DTOs in `packages/shared`;
wiring at the `apps/api` composition root (`apps/api/src/di/`). `Result<T, E>` for every fallible
operation. No raw SQL. No app imported by a package.

**Security constitution**: four obligations are engaged and each is discharged in the contract rather
than assumed.

- *Rate limiting* — cloning copies a whole project per request, so it is an amplifying route that
  MUST be limited, with a **configurable** `rateLimitMax`/`rateLimitWindow` pair (never a literal)
  and a `429` documented in the route's contract. Both are specified: a new `project.clone` pair in
  `apps/api/src/config/schema-project.ts` (default 20/hour, below `refactoring`'s 60) and a `429`
  row in the error table.
- *Typed errors leak nothing* — the one error carrying a path, `LIVE_CONTENT_UNAVAILABLE`, is bound
  in the contract to the project-relative `FileNode.path` the caller can already see in their own
  file tree, explicitly **not** a `ProjectFileStore` `FilePath` resolved against the storage root.
  FR-009a requires naming the document; this is the narrowest way to satisfy it.
- *Authorization denials are logged* — a refused clone records `authz.denied` against the source
  project through the shared `recordAuthorizationDenial` helper (FR-026a), not a hand-rolled entry.
- *Credentials are not copied* — the `GitRepository.credentialRef` exclusion (FR-019) is a security
  requirement, not a convenience.

The widened authorization (any member may clone) is the spec's explicit decision, restated in
contracts/clone-project-api.md so it is reviewed rather than absorbed.

**Result: PASS.** No violation to justify. One deliberate design tradeoff is recorded in Complexity
Tracking below.

## Project Structure

### Documentation (this feature)

```text
specs/047-project-clone/
├── plan.md              # This file
├── research.md          # Phase 0 output — R1–R9
├── data-model.md        # Phase 1 output — copy mapping, new port, DTOs, ordering
├── quickstart.md        # Phase 1 output — how to run and verify it
├── contracts/
│   ├── clone-project-api.md
│   └── clone-project-ui.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
packages/domain/
├── src/
│   ├── use-cases/project/
│   │   ├── clone-project.ts                  # NEW — the use case
│   │   └── download-content-source.ts        # CHANGED — onLiveReadError policy (R2)
│   ├── ports/project/
│   │   └── active-clone-registry.ts          # NEW — FR-027
│   ├── errors/project/
│   │   ├── clone-already-in-progress.ts      # NEW
│   │   ├── live-content-unavailable.ts       # NEW
│   │   └── clone-failed.ts                   # NEW
│   └── audit-actions.ts                      # CHANGED — project.cloned, project.clone_requested
└── tests/ports/project/
    └── in-memory-active-clone-registry.ts    # NEW — Principle III

packages/infrastructure/src/
└── services/
    └── in-memory-active-clone-registry.ts    # NEW — process-local Set (R5)

packages/shared/src/dtos/
└── clone-project.dto.ts                      # NEW — CloneProjectDto

apps/api/src/
├── routes/projects/clone.ts                  # NEW — POST /api/projects/:id/clone
├── config/schema-project.ts                  # CHANGED — project.clone rate-limit pair
└── di/                                       # CHANGED — register the registry singleton

apps/web/src/
├── app/(dashboard)/dashboard/
│   ├── page.tsx                              # CHANGED — insert the new project, confirm with an open action
│   └── archived/page.tsx                     # CHANGED — same, for the archived listing
├── components/
│   ├── project-card.tsx                      # CHANGED — unconditional menu, role-shaped items
│   └── clone-project-dialog.tsx              # NEW
└── lib/api/projects.ts                       # CHANGED — projectsApi.clone

apps/web/e2e/
└── project-clone.spec.ts                     # NEW — menu by role, clone, isolation, exclusions
```

**Structure Decision**: the existing modular monolith is used unchanged. Business logic goes in a
domain use case, the new concurrency guard is a domain port with an infrastructure implementation,
and the API route only translates HTTP to the use case and domain errors to status codes — matching
the `projects.ts` `mapDomainError` pattern already in place.

The route gets its own module under `apps/api/src/routes/projects/` rather than joining
`routes/projects.ts`, following the split the repository already keeps: every heavy or rate-limited
project route (`download.ts`, `refactoring.ts`, `render-config.ts`, `main-file.ts`, `search.ts`)
lives in its own module, while `projects.ts` holds plain CRUD. Cloning is the heaviest project
operation in the system.

## Phase 2 preview (what `/speckit-tasks` will decompose)

Ordered by dependency, mapped to the spec's user stories:

1. **Foundation** — domain errors, `ActiveCloneRegistry` port + in-memory fake + implementation,
   audit action constants, `CloneProjectDto`.
2. **Resolver generalization (R2)** — `onLiveReadError` policy and the `unavailable` variant, with
   download's behaviour proven unchanged.
3. **US1 — the clone itself** — `CloneProjectUseCase`: authorization, name validation, the copy
   mapping (data-model §1), the ordering and cleanup contract (data-model §6).
4. **US2 — settings** — render config, dictionary terms, main-file remap, active-not-archived.
5. **US3 — exclusions** — membership, review items, per-user state, git link, history.
6. **API** — the route module, error mapping (including `429` and the path-bounded `503`), the
   `project.clone` config pair, the denial record, and the full-`ProjectDto` response body proven
   field-for-field against the list route's shape.
7. **Web** — `projectsApi.clone`, the card menu change, the dialog, list refresh and confirmation.
8. **e2e** — the acceptance scenarios that only a real stack can prove: menu contents per role, a
   clone opening with the right content in the editor (research R3's failure mode), and
   source-untouched isolation.

## Complexity Tracking

No constitution violation. One tradeoff is recorded here because it is a deliberate deviation from
the obvious approach and should be reviewed as such.

| Decision | Why needed | Simpler alternative rejected because |
|---|---|---|
| Membership-last visibility + compensating cleanup, instead of a database transaction | FR-023/FR-024 require all-or-nothing across Postgres *and* the filesystem. No unit-of-work abstraction exists, and a Prisma transaction could not cover the file store anyway | A `UnitOfWork` port plus `prisma.$transaction` is a cross-layer addition that would still leave orphaned bytes on disk, so the compensating cleanup would be needed regardless — paying for both |

**Known residual limits**, stated rather than discovered later:

- A crash between the last content write and the owner-membership row leaves an **invisible,
  inaccessible orphan project row and its files**. This is not a silent deviation from FR-024: the
  spec states the guarantee at exactly this granularity (FR-024 visibility always; FR-024a removal
  whenever the system is alive to do it; FR-024b the abrupt-stop residue), and Out of Scope records
  why no reaper is added — a sweep keyed on "no members" would also delete projects orphaned for
  unrelated reasons, such as one whose only owner's account was removed.
- `ActiveCloneRegistry` is **per API process**. Correct for the current single-container deployment;
  with multiple API instances a user could hold one clone per instance (research R5).
- Progress is **indeterminate**, not quantified — a single synchronous request cannot report its own
  progress, and the existing SSE channel is scoped to projects the user is a member of, which the
  clone is not until it succeeds (research R6).

## Post-Design Constitution Re-Check

Re-evaluated against the Phase 1 design (data model, contracts):

- **Principle III** — the design adds exactly one port, and data-model §2 specifies the behavioural
  contract its in-memory fake must honour, so the fake cannot quietly diverge. **Pass.**
- **Principle IV** — the design generalizes one resolver and adds no second content-resolution path.
  research R2 explicitly forbids giving `content/live-content.ts` a parallel policy flag. **Pass.**
- **Principle IX** — the contract confirms no user-supplied path reaches the write path; paths are
  copied from validated source `FileNode.path` values into the clone's own sandbox. **Pass.**
- **Principle VII** — the copy mapping enumerates per-user state as excluded and project-scoped
  configuration as included, with the dictionary's `createdByUserId` re-attributed to the cloning
  user rather than carrying a non-member's id. **Pass.**
- **Principles X, XI, XV** — unchanged from the pre-design assessment; the design introduces no
  rendering, export or egress path. **Not engaged.**

No new violation. No change to the Complexity Tracking table.
