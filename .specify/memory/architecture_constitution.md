# AsciiDoCollab Architecture Constitution

<!--
AMENDMENT NOTE (2.4.0 → 2.5.0, 2026-07-11)
MINOR — driven by governance constitution v2.6.0 Principle X (Client-Side by Default — No Source
Egress, NON-NEGOTIABLE) and feature 039 (in-browser PDF export). Backward-compatible mandate
evolution; nothing removed:
- Technology Mandate "PDF generation" now permits the REAL Asciidoctor-PDF Ruby gem compiled to
  WebAssembly (ruby.wasm) running client-side, in addition to the server sidecar. Confidential
  source MUST NOT be sent to a server to render (Principle X), so client-side wasm is the mandated
  path for that case. The "no JS-based PDF fallback" constraint is UNCHANGED — the engine must be
  the real Asciidoctor-PDF gem, never a hand-rolled JS reimplementation.
- Async & Integration Rules updated to match.
- Module Boundaries: recorded the accepted deviation for browser-only capability packages
  (e.g. packages/asciidoc-pdf) — inward-only, never imported by domain/application/infrastructure.
- Blocking Architecture Violations: added rule 9 (a package MUST NOT import from an app).
-->

## Architecture Style

**Modular Monolith** with Clean Architecture layering.

```
apps/           ← Delivery (Fastify API, Next.js frontend)
packages/
  asciidoc-core/ ← Pure AsciiDoc language kernel (zero-dep innermost ring; domain + web depend on it)
  domain/       ← Business logic, entities, use cases, port interfaces (repositories + storage)
  application/  ← Orchestration, DTOs, service coordination
  infrastructure/ ← Prisma repos, external adapters, Docker wrappers
  shared/       ← DTOs, error types, value objects crossing package boundaries
  db/           ← Prisma schema, generated client
```

---

## Layer Boundaries — Strict Dependency Rule

Dependencies flow strictly inward:

```
Domain ← Application ← Infrastructure ← Delivery
```

- `packages/domain` MUST have zero external dependencies — no Prisma, no Fastify, no
  filesystem, no framework imports of any kind.
- `packages/infrastructure` implements domain interfaces; domain MUST never import
  infrastructure.
- All cross-boundary communication MUST use DTOs defined in `packages/shared`.
- Dependency injection MUST wire concrete implementations to domain interfaces at the
  composition root in `apps/` — no service locators, no static singletons.
- The domain layer MUST define port interfaces (repositories and storage contracts)
  under `packages/domain/src/ports/`; infrastructure provides implementations.
- Use cases in the domain layer MUST orchestrate business logic without knowing the
  delivery mechanism (HTTP, WebSocket, CLI, etc.).

---

## Business Logic Placement

- Business rules live in **domain entities** and **use cases**.
- Use cases orchestrate domain logic; they MUST NOT contain infrastructure concerns.
- Controllers/handlers MUST delegate to use cases — no business logic in route handlers.
- Services in `infrastructure/` implement domain interfaces; they MUST NOT contain
  business rules.

---

## Contracts & Validation

- `packages/shared` MUST define all DTOs, shared error types, and interfaces that cross
  package boundaries. No two packages MAY independently define the same type.
- Input validation happens at the boundary: Fastify schema validation for API, Zod for
  frontend forms. The domain layer MUST NOT trust its inputs.
- `Result<T, E>` (discriminated union) MUST be used for all fallible operations in the
  domain and application layers. Exceptions are reserved for truly exceptional conditions.

---

## Data Access Rules

- Database access via Prisma ORM only. The Prisma schema lives in `packages/db`.
- All queries use the generated Prisma client — raw SQL or untyped queries are not
  permitted without documented justification.
- **Documented justification (atomic background-job claim):** a background worker MAY use a single
  raw `SELECT … FOR UPDATE SKIP LOCKED` query to atomically claim the next queued row from a
  Prisma-modeled work-list table (e.g. `GitOperation`), because Prisma has no first-class SKIP LOCKED
  primitive and this is the canonical safe-claim pattern. Application/domain data still MUST use the
  Prisma client; this exemption covers only that one claim query, and it MUST be confined behind a
  domain port (e.g. `GitOperationRepository.claimNextQueued`) so the raw-SQL surface does not leak
  past infrastructure.
- Port interfaces (repositories and storage contracts) are defined in
  `packages/domain/src/ports/` grouped by domain area (user/, project/, file-tree/,
  storage/, auth-tokens/, admin/).
  Infrastructure provides Prisma-backed and filesystem implementations.
- Every port interface MUST have a corresponding in-memory fake in
  `packages/domain/tests/ports/` mirroring the same subfolder structure.

---

## Async & Integration Rules

- Git operations MUST run only inside sandboxed git-worker containers (delivery app
  `apps/git-worker`) — never on the API host or in any application host process. They are served
  by a bounded, warm worker pool sized to load (not one container per operation, not one per
  project), each job single-project-scoped in a freshly cleaned workspace. Per-job isolation,
  egress allowlisting, and credential handling are governed by `security_constitution.md` ›
  Git Sandbox Security.
- Real-time collaborative editing via Yjs `Y.Text` with Hocuspocus server.
- PDF generation via the real Asciidoctor-PDF Ruby gem. Two mandated modes: (a) server sidecar
  (spawned per-render) for non-confidential/server-driven builds; (b) **client-side ruby.wasm** (the
  same gem compiled to WebAssembly, run in a browser Web Worker) when source must not leave the
  client (governance Principle X). No JS-based PDF reimplementation in either mode.

---

## Module Boundaries

- Each package owns its internal structure. Cross-package access uses public interfaces
  only.
- `packages/asciidoc-core` is the innermost ring — a zero-dependency AsciiDoc language
  kernel that MUST import nothing; `domain` and `web` may depend inward on it.
- `packages/domain` is the application dependency root — apart from `asciidoc-core`, no
  other package may inject dependencies into it.
- Feature modules in `apps/` wire everything together at the composition root.
- **Browser-only capability packages** (e.g. `packages/asciidoc-pdf`, the client-side ruby.wasm PDF
  engine) are an accepted deviation from the domain-ring taxonomy: they carry browser/runtime
  dependencies, MAY depend inward only on `asciidoc-core`, are consumed **only** by `apps/web` at a
  worker/composition root, and MUST NEVER be imported by `domain`, `application`, or
  `infrastructure`. Such a package MUST NOT import from any `apps/*` module (see Blocking rule 9);
  app-provided capabilities (I/O, sandbox-path policy, DOM-bound shims, include assembly) are passed
  in via injected ports, not imported.

---

## Test File Layout

Tests MUST live in a dedicated `tests/` directory at the package or app root, mirroring the source directory structure.
Co-located `__tests__` directories are **prohibited**.

### Canonical paths

| Package / App             | Source root                    | Test root                        |
|---------------------------|--------------------------------|----------------------------------|
| `packages/domain`         | `packages/domain/src/`         | `packages/domain/tests/`         |
| `packages/infrastructure` | `packages/infrastructure/src/` | `packages/infrastructure/tests/` |
| `apps/api`                | `apps/api/src/`                | `apps/api/tests/`                |
| `apps/web`                | `apps/web/src/`                | `apps/web/tests/`                |

### Structure mirrors source

A test for `apps/api/src/routes/users/keybindings.ts` lives at `apps/api/tests/routes/keybindings.test.ts`. A test for
`apps/web/src/hooks/useKeyBindings.ts` lives at `apps/web/tests/hooks/useKeyBindings.test.ts`. The `src/` segment is
dropped; the rest of the path is preserved.

### Subfolder conventions (domain package)

| Layer                      | Source path                                                                                   | Test path                                                |
|----------------------------|-----------------------------------------------------------------------------------------------|----------------------------------------------------------|
| Domain use cases           | `packages/domain/src/use-cases/{auth,project,file-tree,content,settings,members}/`            | `packages/domain/tests/use-cases/{subfolder}/`           |
| Domain ports               | `packages/domain/src/ports/{user,project,file-tree,storage,auth-tokens,admin}/`               | `packages/domain/tests/ports/{subfolder}/`               |
| Infrastructure persistence | `packages/infrastructure/src/persistence/{user,project,file-tree,storage,auth-tokens,admin}/` | `packages/infrastructure/tests/persistence/{subfolder}/` |

### Rules

- MUST NOT create `__tests__/` directories anywhere in the repository.
- MUST NOT place test files alongside source files.
- Task descriptions that reference test file paths MUST use the `tests/` root convention above.
- When `/speckit-analyze` detects a test path using `__tests__` in tasks.md or plan.md, it MUST flag it as a **MEDIUM**
  inconsistency finding.

---

## Database Migration Policy

Agents MUST ask the user before generating or applying Prisma migration scripts.

- Agents MAY update `packages/db/prisma/schema.prisma` as part of a task.
- When a schema change is made, the agent MUST ask the user: "Do you want me to generate a Prisma migration script for this change?" and wait for confirmation before running any migrate command.
- Agents MUST NOT run `prisma migrate dev`, `prisma migrate deploy`, or create files under `packages/db/prisma/migrations/` unless the user explicitly confirms.

This rule exists because the application has not been released yet — there are no live systems to migrate, so migration scripts are not required for schema changes during development.

---

## Blocking Architecture Violations (P0)

The following violations MUST block merge:

1. Domain layer imports from infrastructure, application, or delivery layers.
2. Business logic in route handlers or controllers.
3. Repository interfaces missing from domain layer.
4. Cross-package type duplication (same type defined in multiple packages).
5. `any` type in production code.
6. `as` casts in production code.
7. Test files placed in `__tests__/` directories or co-located with source files.
8. Prisma migration files committed without the user first being asked and confirming.
9. A package (`packages/*`) imports from an app (`apps/*`). Dependencies flow inward; apps are the
   outermost delivery layer. App-provided capabilities MUST be injected via ports, never imported.

---

## Architecture Evolution Policy

Architecture rules may evolve over time. When repeated drift is detected:

- Generate Constitution Update Proposals targeting this file.
- Proposals MUST explain the drift, impact, and proposed evolution.
- Require explicit approval before any rule changes.
- NEVER automatically modify this file.

---

## Refactor & Drift Handling

- Violations become refactor tasks unless marked P0 (blocking).
- Prefer incremental, module-by-module migration over full rewrites.
- Document accepted deviations with rationale and rollback plan.

---

## Technology Mandates

| Constraint             | Rule                                      | Enforcement                                                            |
|------------------------|-------------------------------------------|------------------------------------------------------------------------|
| Database               | PostgreSQL via Prisma ORM                 | Prisma schema in `packages/db`; all queries via generated client       |
| Monorepo tooling       | pnpm workspaces                           | `pnpm-workspace.yaml` defines the workspace                            |
| Code editor            | CodeMirror 6                              | Only CodeMirror 6 + y-codemirror.next for collaborative editing        |
| Real-time CRDT         | Yjs                                       | All collaborative text editing via Yjs `Y.Text`; Hocuspocus for server |
| PDF generation         | Real Asciidoctor-PDF Ruby gem — server sidecar OR client-side ruby.wasm | Sidecar container per-render for server builds; ruby.wasm in a Web Worker when source must stay on the client (Principle X); no JS-based PDF reimplementation in either mode |
| API framework          | Fastify                                   | Schema-first validation for all routes                                 |
| Frontend framework     | Next.js 16 (App Router)                   | Dashboard/auth via SSR; editor as client component                     |
| Component library      | shadcn/ui + Radix UI + Tailwind CSS       | Design tokens as CSS custom properties; light/dark themes              |
| Test runner            | Jest + Testing Library (unit/integration) | Jest for all Node.js tests; Playwright for E2E                         |
| Domain testing         | In-memory fakes                           | Every domain repository has an in-memory fake in the test suite        |
| Infrastructure testing | testcontainers                            | Integration tests spin up real PostgreSQL/Docker containers            |

**Version**: 2.6.0 | **Ratified**: 2026-05-27 | **Last Amended**: 2026-08-24

<!--
AMENDMENT 2.5.0 → 2.6.0 (2026-08-24, MINOR) — driven by feature 048 (git repository synchronization).
Two backward-compatible mandate evolutions; nothing removed:
- Async & Integration Rules: the "Docker sandbox container per git operation" wording is replaced by
  "git runs only inside sandboxed git-worker containers (apps/git-worker), never on a host process,
  served by a bounded warm worker pool with single-project-scoped, freshly-cleaned jobs". Isolation
  intent preserved; detailed per-job/egress/credential rules delegated to security_constitution.md
  1.3.0 (aligned same cycle). This also records apps/git-worker as a sanctioned 4th delivery app.
- Data Access Rules: added an explicit documented-justification exemption permitting a single raw
  `SELECT … FOR UPDATE SKIP LOCKED` query for atomic background-job claiming from a Prisma-modeled
  work-list table, confined behind a domain port. Application/domain data still MUST use Prisma.
  (No external queue library or advisory locks are introduced.)
No layer-boundary, contract, or blocking-violation rule changed.
-->

<!-- Prior version line retained for context:
**Version**: 2.5.0 | **Ratified**: 2026-05-27 | **Last Amended**: 2026-07-11 -->
