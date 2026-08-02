<!-- SPECKIT START -->
Active feature plan: specs/043-preview-responsiveness/plan.md
<!-- SPECKIT END -->

## Hard Constraints (MUST NOT)

- MUST NOT create `CLAUDE.md` — this project uses `AGENTS.md` as the sole agent context file; update `AGENTS.md` instead
- MUST NOT `git push` or `git merge` without explicit user consent — commit freely, ask before pushing or merging
- MUST NOT use inline `eslint-disable` comments — fix the root cause instead
- MUST NOT use TypeScript `as X` assertions — `assertionStyle: 'never'` is enforced; use typed variable assignment or restructure the types instead
- MUST NOT name tests with task IDs (e.g. `[T042]`, `T-042`) — test names MUST describe behavior
- MUST NOT define the API base URL locally (`const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '...'`) anywhere — import `API_BASE_URL` from `@/lib/api/base-url`, the single isomorphic source. It resolves to the internal address during server rendering and the public one in the browser; a local copy silently loses that.
- MUST NOT add `@jest-environment` docblock pragma to `.tsx` test files — `.tsx` files automatically run in jsdom; the pragma is only valid in `.ts` test files that need a non-default environment
- MUST NOT create a test file without first verifying no test file already exists at an adjacent path
- MUST NOT throw raw strings or generic `Error` in domain or application layers — use typed `DomainError` subclasses
- MUST NOT import infrastructure, Prisma, or Fastify in `packages/domain`
- MUST NOT use `console.log/error/warn` in production code — use `request.log` (route handlers) or a module-level `pino()` instance
- MUST NOT skip tests — run the test suite for every package touched; a green typecheck is not a passing test suite

---

## Project

AsciiDoCollab is a browser-based collaborative AsciiDoc editor: real-time multi-user editing, project/file management, Git integration, HTML live preview, PDF generation. Targets self-hosted and SaaS deployments.

A production self-hosting stack lives in `docker/` (see `docker/README.md`): Postgres, api, collab, web and a Caddy edge proxy with automatic HTTPS, generated secrets, and mutual TLS on the internal api↔collab channels. `docker/README.md` also records the hardening applied and the limitations accepted deliberately.

## Tech Stack

| Layer                   | Technology                                                                                      |
|-------------------------|-------------------------------------------------------------------------------------------------|
| Frontend                | Next.js 16 (App Router) + TypeScript 6                                                          |
| Code editor             | CodeMirror 6 + `y-codemirror.next`                                                              |
| HTML preview            | Asciidoctor.js + highlight.js (Web Worker, client-side)                                         |
| API server              | Fastify + TypeScript 6                                                                          |
| Real-time CRDT          | Yjs                                                                                             |
| Collaboration server    | Hocuspocus 4 (standalone native-ESM process, `apps/collab`)                                     |
| PDF generation          | Asciidoctor-PDF via ruby.wasm — in-browser Web Worker, no server (`packages/asciidoc-pdf`)      |
| Database                | PostgreSQL via Prisma ORM                                                                       |
| Auth                    | Passport.js + passport-saml (local + SAML 2.0 + Entra ID)                                       |
| Email                   | Nodemailer (SMTP)                                                                               |
| Monorepo                | pnpm workspaces                                                                                 |
| Tests                   | Jest + Testing Library + Playwright (E2E)                                                       |
| Architecture validation | `scripts/ci/architecture-guard.mjs` (layer rules in `onion.config.json`)                        |
| Security scanning       | Semgrep · zizmor · gitleaks · OSV-Scanner · knip (CI `security` job / `scripts/ci/security.sh`) |

## Monorepo Structure

```
asciidocollab/
├── apps/
│   ├── web/                        # Next.js 16 — delivery layer
│   │   └── src/
│   │       ├── app/
│   │       │   ├── (auth)/         # login, register, reset-password, verify-email, accept-invite
│   │       │   └── (dashboard)/
│   │       │       └── dashboard/
│   │       │           ├── page.tsx              # Project list
│   │       │           ├── account/              # Display name, email, password, keybindings
│   │       │           ├── admin/users/          # Admin user management
│   │       │           ├── archived/             # Archived projects
│   │       │           └── projects/
│   │       │               ├── new/              # Create project form
│   │       │               └── [id]/             # Project editor (3-panel layout)
│   │       │                   ├── page.tsx
│   │       │                   ├── project-editor-layout.tsx
│   │       │                   ├── members/      # Member management
│   │       │                   └── settings/     # Project settings + danger zone
│   │       ├── components/
│   │       │   ├── file-tree/      # FileTree, FileTreeNode, FileTreeActions, DragDropZone
│   │       │   ├── ui/             # shadcn/ui primitives (Button, Input, Card, etc.)
│   │       │   ├── asciidoc-preview.tsx   # Collapsible AsciiDoc → HTML preview
│   │       │   └── file-content-panel.tsx # Read-only file content display
│   │       ├── hooks/              # useFileTreeEvents, useFileSelection, useKeyBindings, etc.
│   │       ├── lib/api/            # fetch wrappers: file-tree, projects, assets
│   │       └── workers/            # file-tree-events.worker.ts (SharedWorker, SSE fan-out)
│   └── api/                        # Fastify — delivery layer
│       └── src/
│           ├── config/             # convict schema, formats
│           ├── plugins/            # auth, cors, origin-check, rate-limit, file-tree-event-bus,
│           │                       # require-auth/admin
│           └── routes/
│               ├── projects/       # file-tree (GET/POST/PATCH/DELETE), file-content,
│               │                   # events (SSE), members, assets, users-search
│               ├── internal/       # collab-auth: GET /internal/collab/auth/{document,presence}
│               └── ...             # auth, admin, user, health, keybindings routes
├── packages/
│   ├── domain/                     # Entities, use cases, ports — zero external deps
│   │   └── src/
│   │       ├── entities/           # 14 entities (User, Project, FileNode, Document, Asset, …)
│   │       ├── errors/             # 25+ typed DomainError subclasses
│   │       ├── ports/              # Grouped by domain subdirectory:
│   │       │   ├── admin/          # AuditLogRepository, SystemSettingRepository
│   │       │   ├── auth-tokens/    # PasswordResetToken, EmailChange, EmailVerification repos
│   │       │   ├── file-tree/      # FileNodeRepository, DocumentRepository, AssetRepository
│   │       │   ├── project/        # ProjectRepository, ProjectMemberRepository, etc.
│   │       │   ├── storage/        # ProjectFileStore, YjsStateStore
│   │       │   └── user/           # UserRepository, KeyBindingRepository, etc.
│   │       ├── services/           # EmailSender, PasswordHasher, BreachChecker, etc.
│   │       ├── use-cases/          # Grouped by domain subdirectory:
│   │       │   ├── auth/           # login, register, reset-password, verify-email, etc.
│   │       │   ├── content/        # get/save document content, upload-asset
│   │       │   ├── file-tree/      # create-file, create-folder, rename, delete, move, get-tree
│   │       │   ├── members/        # change-member-role, remove-member
│   │       │   ├── project/        # create, update, delete, archive, restore, list
│   │       │   └── settings/       # keybindings, open-registration, admin status
│   │       └── value-objects/      # 22 VOs including FileName (validates against path traversal,
│   │                               # control chars, Windows reserved names)
│   ├── infrastructure/             # Prisma repos, filesystem stores, email sender
│   ├── collaboration/              # Hocuspocus 4 standalone server (apps/collab, native ESM) — real-time Yjs
│   │                               # co-editing + per-project presence rooms, auth-hook, per-user
│   │                               # connection/rate caps, Origin allowlist, max-payload
│   ├── shared/                     # Result<T,E> type, DTOs (FileTreeEventDto, CollabAuth*, etc.),
│   │                               # presenceRoomName()/isPresenceRoom() room-name convention
│   ├── asciidoc-core/              # Zero-dep AsciiDoc structural engine (conditional regions, {ref} subst,
│   │                               # attribute authority) — shared leaf, imported inward by domain + web
│   ├── asciidoc-pdf/               # Browser-only leaf: renders a project to PDF entirely client-side via
│   │                               # Asciidoctor-PDF compiled to WebAssembly (ruby.wasm) in a Web Worker.
│   │                               # Depends inward on asciidoc-core only; never imported by server code
│   ├── db/                         # Prisma schema + prisma/migrations (production applies these)
│   └── testing/                    # Testcontainers helper, factories, shared test setup
├── docker/                         # ALL compose files live here — dev, e2e and prod
│   ├── docker-compose.dev.yml      # local Postgres + Mailpit (used by scripts/dev.sh)
│   ├── docker-compose.e2e.yml      # isolated throwaway stack for e2e
│   ├── docker-compose.prod.yml     # production stack: postgres, migrate, api, collab, web, caddy
│   ├── Dockerfile                  # multi-stage, one runtime image per service (Alpine base)
│   ├── Caddyfile                   # edge proxy: TLS, security headers, path routing
│   ├── generate-secrets.sh         # secrets + internal mTLS PKI; safe to re-run, explicit rotation
│   └── README.md                   # deployment, backups, upgrades, hardening, troubleshooting
├── specs/
│   └── <NNN>-<feature>/            # spec.md, plan.md, tasks.md, data-model.md, contracts/, research.md
└── pnpm-workspace.yaml
```

**Database schema — two different mechanisms.** Development and e2e apply the schema with
`prisma db push` (fast, throwaway databases, no migration produced). Production runs
`prisma migrate deploy`, which applies only the committed SQL in `packages/db/prisma/migrations/`.

Consequence: **changing `schema.prisma` without generating a migration will pass every test and
then never reach production.** `scripts/ci/check-migrations.sh` (part of the quality gate) fails
the build when they drift. After a schema change:

```bash
cd packages/db && pnpm exec prisma migrate dev --name <describe-the-change>
```

## Development Commands

```bash
pnpm install              # install all workspace dependencies
pnpm build                # build all packages
pnpm test                 # run all tests
pnpm test --filter=domain # run tests for a specific package
pnpm test:coverage        # run tests with coverage
pnpm typecheck            # TypeScript type-checking
pnpm lint                 # lint all packages
pnpm architecture         # validate architecture boundaries (layer rules)
pnpm semgrep              # SAST scan (Semgrep packs + first-party .semgrep.yml rules)
pnpm knip                 # dead-code / unused-dependency report (non-gating)
```

## Test Execution Rules

Run tests for **every package touched**. Do not stop at typecheck.

| Package touched                                                    | Command to run                             |
|--------------------------------------------------------------------|--------------------------------------------|
| `apps/web/src/` or `apps/web/tests/`                               | `pnpm --filter @asciidocollab/web test`    |
| `apps/api/src/` or `apps/api/tests/`                               | `cd apps/api && npx jest`                  |
| `packages/domain/src/` or `packages/domain/tests/`                 | `cd packages/domain && npx jest`           |
| `packages/infrastructure/src/` or `packages/infrastructure/tests/` | `cd packages/infrastructure && npx jest`   |
| `apps/collab/src/` or `apps/collab/tests/`                         | `pnpm --filter @asciidocollab/collab test` |
| `apps/web/e2e/`                                                    | Run E2E suite (see Pre-merge gate)         |

MUST NOT run `npx jest` from the repo root without `--filter` — it picks up configs from all workspace packages and produces misleading results.

### Pre-merge gate (all five jobs must pass with zero failures)

Run the whole gate locally with one command:

```bash
pnpm gate    # = scripts/ci/gate.sh — runs all five jobs below, stops on first failure
```

`pnpm gate` uses the **isolated** e2e job (`scripts/ci/e2e-local.sh`), so it is safe to run while `scripts/dev.sh` is up — it never clashes on the dev ports or touches the dev database. **When asked to "run all quality gates with e2e", use `pnpm gate` (or `scripts/ci/e2e-local.sh` for the e2e job) — never `scripts/ci/e2e.sh` while a dev stack is running** (see below). The individual jobs (all under `scripts/ci/`):

```bash
./scripts/ci/quality.sh      # Job 1: build · lint · types · architecture · audit · migration drift
./scripts/ci/unit.sh         # Job 2: unit tests + coverage — shared, domain, api, collab, web (needs Job 1)
./scripts/ci/integration.sh  # Job 3: integration tests via Testcontainers (needs Job 1)
./scripts/ci/security.sh     # Job 4: security scan — Semgrep · zizmor · gitleaks · OSV-Scanner (High+) · knip
./scripts/ci/e2e-local.sh    # Job 5: E2E on an isolated stack (needs Jobs 2+3, requires Docker)
```

**Directive — "run all quality gates" / "run the quality gates" ALWAYS includes Job 4 (the security scan above).** Lint + typecheck + tests are NOT the whole gate. Run the full sweep with `pnpm gate`, or Job 4 alone with `./scripts/ci/security.sh` (mirrors the CI `security` job in `.github/workflows/ci.yml`). Whether Job 5 / e2e is included follows the "with e2e" convention above.

`check-migrations.sh` behavior (part of Job 1): it needs a reachable PostgreSQL for the shadow database, so locally it **skips** with a notice when none is up and still exits 0; `CI=1` (or `MIGRATION_CHECK_STRICT=1`) makes an unreachable database a hard failure. Same lenient-local / strict-CI contract as `security.sh`.

`security.sh` behavior: its four scanners are NOT npm-managed (Semgrep, zizmor → pip; gitleaks, osv-scanner → release binaries). Locally it **skips** any not installed (prints an install hint) and still exits 0 — so `pnpm gate` scans with whatever is present; knip always runs. `SECURITY_STRICT=1` (set by `CI=1`) makes a missing scanner a hard failure. Reproduce CI offline: `pipx install semgrep zizmor` + the gitleaks/osv-scanner release binaries.

E2E tests are mandatory before merge — they are the only layer that catches missing route registrations and broken API contracts.

**`scripts/ci/e2e-local.sh` (= `pnpm e2e:local`) vs `scripts/ci/e2e.sh`:** both run the *same* Playwright suite. `e2e-local.sh` spins up a throwaway Postgres + Mailpit from `docker/docker-compose.e2e.yml` on distinct ports (5433/1126/8126, API 4100, web 3100, collab-internal 4101) and tears down — it never touches your dev containers, ports, or data, so it coexists with a running `dev.sh`. `e2e.sh` is the **CI** form: it targets the dev stack (`docker/docker-compose.dev.yml`, ports 4000/3000) and runs `prisma db push --force-reset`, so running it locally while `dev.sh` is up would `EADDRINUSE` on 4000/3000 and wipe the dev database. `scripts/e2e-stack-up.sh` brings the isolated stack **up and leaves it running** for iterating on individual specs.

Local e2e gotchas: (1) the isolated scripts offset the collab-internal port to 4101 so they coexist with a dev API on 4001; override `ASCIIDOCOLLAB_COLLAB_INTERNAL_PORT` if 4101 is also taken; (2) dev and e2e share `apps/web/.next`, so a stale `.next` (a prior `next dev` build mixed with `next build`) can make the served HTML reference chunks that 404→500 and pages won't hydrate (e.g. the register button stays disabled) — `rm -rf apps/web/.next` before building if you hit this; (3) never `DROP SCHEMA` on the e2e DB while the API is running (it corrupts the Prisma pool) — reset the DB before the API starts.

### Quick local check — `apps/web` only

```bash
pnpm --filter @asciidocollab/web test        # jest — all tests must pass
npx tsc -p apps/web/tsconfig.json --noEmit   # type-check (matches CI)
pnpm --filter @asciidocollab/web lint        # lint apps/web only
```

`next lint` was removed in Next.js 16. CI runs `npx eslint .` from the repo root. `pnpm --filter @asciidocollab/web lint` runs `eslint src/ tests/ e2e/` directly.

### Editor: collab vs legacy mode

On opening a file the editor calls `GET /projects/:projectId/files/:fileNodeId/collab` (→ `{ yjsStateId, role }`, or 404 for binary assets). The result selects one of two paths:

- **Collab mode** (text document): binds CodeMirror to a shared `Y.Text` over Hocuspocus (`use-collab-document` owns the provider+Y.Doc), mounts an **empty** doc populated by sync, and **disables** the legacy REST machinery — no `useAutoSave` PUT, ETag polling, localStorage drafts, or `beforeunload` keepalive. The collaboration server owns persistence (write-back + room-teardown flush). Observers get a read-only editor; if the WS never syncs within the timeout, the editor opens **offline read-only** seeded from `GET /content`. Per-user undo is a Yjs `UndoManager` (native CM history is dropped on this path).
- **Legacy mode** (binary assets, non-collaborative files, offline fallback): unchanged `GET`/`PUT /content` REST load/save.

---

## Code Quality Rules

1. **No `eslint-disable`** — never add inline `eslint-disable` comments; fix the root cause.
2. **No spec-local identifiers in code, test names, or comments** — spec-local IDs are not unique across specs (the same number recurs in different feature specs), so they carry no reliable meaning outside their own `specs/<feature>/` artifacts. Never write them into source code, test names (`describe`/`it`/`test` strings), or comments — including combos and ranges like `(US8/FR-020)`, `(SEC2/FR-011)`, `FR-064-065`. Describe the behavior or the reason instead; reword the sentence if an ID was integral. The families to avoid:
   - `FR-###` (functional requirement), `NFR-###` (non-functional requirement)
   - `US#` (user story), `SC-###` (success criterion / scenario)
   - `T###` (task, e.g. `[T042]`, `T-042`), `R##` (risk), `INV-#` (invariant)
   - `SEC#` (security requirement), `CFG#` (config item)

   Non-spec tokens that look similar are fine and must be preserved: `SHA-256`, `UTF-8`, `AES-256`, `CM6`, `Constitution VIII` and other constitution/feature references, Markdown/AsciiDoc markup (`- [ ]`, `Term;;`), and table cells.
3. **`API_BASE_URL` source** — never define the API base URL locally; import `API_BASE_URL` from `@/lib/api/base-url`. It is isomorphic: `INTERNAL_API_URL` (runtime, server) wins over `NEXT_PUBLIC_API_URL` (build-time, browser), so server rendering reaches the API directly instead of hairpinning through the reverse proxy. `@/lib/api/file-content` and `@/lib/api/file-tree` re-export it for existing call sites.
4. **Jest environments in `apps/web`** — `.test.ts` files run in Node environment; `.test.tsx` files run in jsdom environment. No `@jest-environment` docblock pragma needed in `.tsx` files.
5. **No duplicate test files** — before creating a test file, verify no file already exists at an adjacent path.
6. **No TypeScript type assertions** — `assertionStyle: 'never'` is enforced; no `as X`; use typed variable assignment or restructure the types.
7. **`@jest-environment` is a Jest pragma, not a JSDoc tag** — only valid in `.ts` test files that need a different environment than the project default; `.tsx` files automatically run in jsdom.

---

## Architecture Principles

### Clean Architecture — strict dependency rule

Dependencies flow strictly inward: `domain` ← `infrastructure` ← `apps/*`.

- `packages/domain` has **zero external dependencies** — no Prisma, no Fastify, no filesystem imports.
- `packages/infrastructure` implements domain interfaces; domain never imports infrastructure.
- Cross-boundary communication uses DTOs from `packages/shared`.
- `packages/asciidoc-core` is the innermost ring: zero dependencies, pure AsciiDoc policy, no I/O. It exists so the server and the browser apply identical document semantics, so **any** layer may depend inward on it — `shared` included.
- `packages/shared` is a **boundary-contracts** package (wire DTOs, zod schemas, wire constants), not a kernel of primitives. It must stay **browser-safe**: `apps/web` depends on it, so it may never import `domain`, or every web consumer is forced to depend on server business rules it does not need. That is a component-cohesion rule, not the dependency rule — when a value is owned by the domain and also needed at the wire (e.g. `REVIEW_BODY_MAX_LEN`), shared MIRRORS it and `apps/api/tests/architecture/layer-mirror-parity.test.ts` holds the two together. A layer that may read the domain directly (api, collab, infrastructure) should read the domain, not the mirror.
- Dependency injection wires concrete implementations to domain interfaces at startup in `apps/`.
- Architectural boundaries are enforced by `scripts/ci/architecture-guard.mjs` in CI (gate Job 1). It checks BARE workspace specifiers as well as relative ones — the previous tool, fresh-onion, skipped bare specifiers and so inspected nothing in this repo.

### Error handling

- Domain errors are typed value objects extending `DomainError` (e.g. `ProjectNotFoundError`, `PermissionDeniedError`). Never throw raw strings or generic `Error` in domain or application layers.
- Value objects throw `ValidationError extends DomainError` on bad input (programmer errors, not control flow).
- Use cases return `Result<T, DomainError>` (discriminated union) — no exception-driven control flow.
- Infrastructure adapters catch external errors at the adapter boundary and map them to domain error types.
- Fastify's error handler maps domain errors to HTTP status codes and structured JSON.

### Testing

- Domain use cases: tested with **in-memory fakes** (not mocks) of repository interfaces.
- Infrastructure adapters: integration tests against real DB/filesystem via `testcontainers`.
- E2E: Playwright.

#### API route tests — every route needs an `app.inject()` test

Every `app.get/post/patch/delete()` registration in `apps/api/src/routes/` MUST have a corresponding test in `apps/api/tests/routes/` that makes real HTTP calls via `app.inject()`. The test must cover:

1. **Happy path** — correct status code and response shape
2. **Auth/permission errors** — 403 when caller is not a member
3. **Not-found errors** — 404 when the resource does not exist

Pattern (from `tests/routes/events.test.ts`):

```typescript
jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_req, _rep, done) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

async function buildTestServer() {
  const app = Fastify();
  app.decorate('repos', { /* mocked repos */ } as never);
  await app.register(myRoute);
  await app.ready();
  return app;
}

it('returns 200 for member', async () => {
  const app = await buildTestServer();
  const response = await app.inject({ method: 'GET', url: '/projects/550e8400-e29b-41d4-a716-446655440002/...' });
  expect(response.statusCode).toBe(200);
  await app.close();
});
```

**UUID invariant:** Test UUIDs must be valid UUID v4 — third group starts with `4`, fourth group starts with `[89ab]`. Example: `550e8400-e29b-41d4-a716-446655440001`. Invalid UUIDs cause `Uuid.create()` to throw `ValidationError` → 500, masking the real assertion.

#### Frontend component tests — fetch coverage rule

Any component that calls `fetch` MUST cover all three error paths:

| Case                     | Mock setup                        | What to assert                                         |
|--------------------------|-----------------------------------|--------------------------------------------------------|
| Success                  | `{ ok: true, json: () => data }`  | Data renders                                           |
| HTTP error (404, 500, …) | `{ ok: false, status: 404 }`      | Error state visible; UI is **not** stuck on "Loading…" |
| Network failure          | `mockRejectedValue(new Error(…))` | Error state visible; UI is **not** stuck on "Loading…" |

`response.ok === false` and a thrown exception are distinct code paths. Tests that only mock `ok: true` leave the `else` branch of `if (response.ok)` uncovered.

---

## Code Conventions

### Value Objects

- Use `static create()` factory with a `private constructor`.
- Validate input in `create()`, throw `ValidationError` on failure.
- Expose `.value` getter for the wrapped primitive.
- Implement `.equals(other: unknown): boolean` via `instanceof`.
- **UUID IDs**: Extend the `Uuid` abstract base class. `Uuid.equals()` uses constructor comparison to prevent cross-type equality (`UserId` !== `AuditLogId` even with same UUID string).

### Timestamps

- Use the `Timestamps` value object for `createdAt`/`updatedAt` pairs.
- Timestamps stores private `Date` fields and returns defensive copies from getters.
- Entity getters delegate to `this.timestamps.createdAt` / `this.timestamps.updatedAt`.

### Entities

- Validate invariants in the constructor. Throw `Error` for programmer errors (not returned as Result).
- Accept `Timestamps` as a single constructor parameter (defaults to `new Timestamps()`).
- Provide `.createdAt` and `.updatedAt` getters delegating to timestamps.

### Use Cases

- Every `execute()` method returns `Promise<Result<T, DomainError>>`.
- Never throw exceptions for control flow.
- Use `actorId` as the parameter name for the acting user (all ID params use `Id` suffix).
- Permission checks use `role.value !== 'administrator'` pattern.
- Create `AuditLog` entries for all state-changing operations.
- Inject repository dependencies via constructor (no DI framework).

### In-Memory Fakes

- Stored in `packages/domain/tests/repositories/`.
- Backed by `Map<string, Entity>` keyed by `.value` of the ID.
- No mocking libraries — fakes are hand-written implementations.
- `save()` upserts into the map.

### Environment Variables

All env vars follow `ASCIIDOCOLLAB_CATEGORY_VARIABLE` convention (e.g., `ASCIIDOCOLLAB_DATABASE_URL`, `ASCIIDOCOLLAB_AUTH_SESSION_SECRET`).

### Logging

Fastify uses Pino (built-in). Use `request.log` in route handlers. Never use `console.log/error/warn` in production code. Services without request context use a module-level `pino()` instance. All log fields containing passwords/tokens must be added to the `redact` array in logger config.

### Documentation

All **public** classes, methods, interfaces, exported functions, and type definitions MUST have JSDoc:

```typescript
/**
 * One-line purpose. Second sentence explains *why* if non-obvious.
 *
 * @invariant Invariant condition enforced by the class (entities only).
 */
export class SomeEntity {
  /**
   * @param id - Unique identifier for this entity.
   * @param name - Display name shown in the UI.
   */
  constructor(
    /** Unique identifier for this entity. */
    public readonly id: SomeId,
    /** Display name shown in the UI. */
    public readonly name: string,
  ) {}

  /**
   * @param paramName - Description of the parameter.
   * @returns Description of the return value.
   * @throws {ErrorType} When/why this error occurs.
   */
  method(paramName: string): SomeType { ... }
}
```

Rules:
- Every public class, interface, type alias, and exported function gets a JSDoc block.
- Every public method gets `@param` + `@returns` + `@throws` tags.
- `@param` uses dash-separator: `@param name - Description.` No type annotation (TypeScript handles that).
- `@returns` and `@throws` are always included for public methods. Omit `@returns` only for plain `void` methods.
- `@invariant` on entity classes listing constructor-enforced invariants.
- Inline `/** doc */` on constructor `public readonly` parameters preferred over separate `@param` tags.
- Tag ordering: `@param` (in argument order), then `@returns`, then `@throws`.
- Always insert an empty line between the description paragraph and the first tag.
- Use backticks for code references, end sentences with periods.
- Infrastructure layer must be documented same as domain — no exceptions.
- Private/internal helpers with obvious behavior need no JSDoc; add one when the implementation has non-obvious side effects or safety invariants.
- Every constructor parameter needs a `@param` tag or inline `/** doc */`; `jsdoc/require-param` runs with `checkConstructors: true`. Adding a param without documentation is a lint error.
- Descriptions must add information the name does not already convey. The linter strips the symbol name plus these structural words before judging: `interface type class hook function method handler component helper utility service manager object result`. Nothing remaining = lint error. WRONG: `/** Result interface for useBar hook. */` / `@param reply - The reply object.` RIGHT: `/** Exposes the current bar state and its setters. */` / `@param reply - Fastify reply used to send the error response.`

---

## Key Architectural Decisions

**Git sandboxing:** Each git operation spawns a short-lived Docker container from `docker/git-sandbox`. The container mounts only the requesting project's directory. Credentials are injected as environment variables — never written to disk.

**HTML preview:** Asciidoctor.js runs in a dedicated Web Worker (`apps/web/src/workers/asciidoc-render.worker.ts`) and auto-renders on a debounce (`PREVIEW_DEBOUNCE_MS`, 1500 ms) so typing never blocks the editor thread — there is no manual Refresh button. The worker post-processes Asciidoctor's HTML with highlight.js (`highlightCodeBlocks`) to add `.hljs-*` token spans to fenced source blocks; the result is sanitized by DOMPurify on the main thread before injection. Preview styling (`styles/asciidoc-preview.css`) is driven by the app's `--*` design tokens, so it follows light/dark theme automatically — never hard-code preview colors.

**Cross-file editor intelligence (US8/US12, feature 026):** A project can designate a **main file** (`PUT /projects/:id/main-file`, `SetProjectMainFileUseCase`, editor/owner only) — the root of the include tree that scopes cross-file resolution. The web `useProjectSymbolIndex` hook walks the cycle-guarded include graph (fetching each reachable file once, capped concurrency, FR-073/SC-025) to build a project symbol index that powers: cross-file diagnostics, xref go-to-definition + hover, **Go to Symbol** (Ctrl/Cmd+Shift+O), and the assembled include preview (rendered only while the open file *is* the main file). The AsciiDoc structural rules (reference/symbol extraction, the include graph, the file-name rule, and the Constitution-IX sandbox path resolver) are **domain-owned** (`packages/domain/src/asciidoc/*`, `project-path/*`); the web keeps non-authoritative *presentation copies* under `apps/web/src/lib/asciidoc/*` because the live editor needs them per-keystroke (web ⊥ domain — never import `@asciidocollab/domain` from `apps/web`). **Refactoring** (Ctrl/Cmd+Shift+R, the "Refactor" header button → `EditorSymbolRefactor`): find-usages (`GET /projects/:id/symbol-usages`, `FindReferencesUseCase`) and project-wide rename of an id/anchor/attribute (`POST /projects/:id/symbol-rename`, `RenameSymbolUseCase`, editor/owner). Rename and file move/rename/delete rewrite `include::`/`image::`/`xref:` references across **all** project files server-side (best-effort). For any referencing file that is a collaborative document (has a `yjsStateId`) the rewrite is applied through the **Yjs source of truth** — the API calls the collab server's internal `POST /internal/collab/apply-edits`, which uses `hocuspocus.openDirectConnection().transact()` so the change shows up live for anyone editing and is **not** clobbered by the next write-back; files with no collab document fall back to a direct file-store write. The chain is the domain port `CollaborativeContentEditor` → infra `HttpCollaborativeContentEditor` → collab `internal-edit-server.ts`. Both refactoring endpoints share the `project.refactoring` rate limit.

**Collaboration (Hocuspocus 4):** `apps/collab` runs Hocuspocus v4 as a standalone native-ESM process. There are two room types, distinguished by name (the convention lives in `@asciidocollab/shared`: `presenceRoomName`/`isPresenceRoom`):

- **Document rooms** — name `<projectId>/<yjsStateId>`. On WS connect the auth-hook calls `GET /internal/collab/auth/document` on the Fastify API to verify ≥`viewer` access and resolve the connection role (`editor`/`observer`, via `connectionConfig.readOnly`). Yjs state is persisted to the filesystem as `.yjs` binary files (`apps/collab/src/extensions/persistence.ts`, plain `import * as Y from 'yjs'`).
- **Presence rooms** — name `presence/<projectId>`. Authorized via `GET /internal/collab/auth/presence` (project membership only). These carry awareness only: no document session, no persistence, exempt from the per-document connection caps, and forced read-only at the WS layer so no content can be written (FR-011).

Besides the collab→API auth calls above, the API→collab direction has one internal endpoint: **`POST /internal/collab/apply-edits`** (`apps/collab/src/internal-edit-server.ts`, a small loopback HTTP server separate from the WS port). The API calls it (via infra `HttpCollaborativeContentEditor`) so a file rename/move can rewrite cross-file references inside *live* documents through the Yjs source of truth (`hocuspocus.openDirectConnection().transact()`), instead of writing the file store under an open room and being clobbered on write-back. Default is loopback HTTP; harden with `ASCIIDOCOLLAB_COLLAB_INTERNAL_EDIT_SECRET` and/or mTLS (`*_INTERNAL_EDIT_TLS_*` on collab, `*_EDIT_TLS_*` on the API) when collab runs off-host. `apps/collab` is native ESM, so its Jest specs cannot use `jest.mock`/`require` — use `jest.unstable_mockModule` + dynamic `import` (the `jest` global is provided by `apps/collab/tests/jest-setup.ts`); collab unit tests run in Job 2 (`scripts/ci/unit.sh`).

v4 migration notes: `new Server()` replaces `Server.configure()`; the live-document map moved to `server.hocuspocus.documents`; the auth hook reads request headers via web `Headers.get()` and sets `connectionConfig.readOnly` (v4 `onConnect` no longer exposes `connection`). Migrating `apps/collab` to ESM (`type: module`, node16 resolution, explicit `.js` import specifiers) removed the old `createRequire('yjs')` CJS workaround.

**File-tree open-file presence:** Each project has one Yjs awareness presence room. The web hook `use-project-presence.ts` publishes `{ user, openFileNodeId }` and reads peers; `open-by-others-marker.tsx` renders an avatar cluster + accessible label on `file-tree-node` rows for files other users have open. Self and the user's own multi-tab connections are excluded, peers are deduped per file, and markers clear on disconnect. The new domain use case `AuthorizeProjectPresence` (project membership) backs the presence auth endpoint.

**File-tree drag-and-drop (move):** Dragging a node onto a folder moves it (`MoveFileUseCase`); handlers live in `file-tree.tsx` (`handleTreeDragStart`) and `file-tree-node.tsx`. Two non-obvious cross-browser HTML5-DnD requirements — both bugs present as "drop does nothing": (1) guard the dragstart target with `instanceof Element`, **not** `HTMLElement` — browsers fire `dragstart` on the row's `<svg>` icon when grabbed there (WebKit always), and `SVGElement` is not an `HTMLElement`, so an `HTMLElement`-only guard silently skips `setData`; (2) set `effectAllowed`/`dropEffect` to `'move'` and give folders an `onDragEnter` that `preventDefault()`s, or Firefox/Safari resolve `dropEffect` to `none` and discard the drop. Note: Playwright (and synthetic event tests) paper over (2), so an e2e move test can pass while real users see nothing — cover the icon-grab case explicitly.

**SSE real-time file tree:** The API broadcasts `FileTreeEventDto` over a per-project in-memory `EventTarget` bus (`FileTreeEventBus` plugin). The frontend connects via a `SharedWorker` that holds one `EventSource` per project and fans events to all tabs. `applyEvent()` handles `created/deleted/renamed/moved` events locally; `onUpdate` (called after any mutation) triggers `fetchTree()` as a reliable fallback. `applyEvent` is idempotent for `created` events to prevent duplicates when refetch beats SSE delivery.

**Project creation invariant:** Creating a project always runs a single DB transaction: insert Project (rootFolderId=null) → insert root FileNode → update Project.rootFolderId. Every project always has a root folder.

**RBAC:** Roles (viewer/editor/administrator) are assigned per project via `ProjectMember`. Global admins are a separate flag on `User`. Role checks happen in use cases, not in route handlers.

**Actor validation:** Use cases that require the actor to exist as a registered user delegate that check to the API layer (e.g. session middleware), not to the domain use case itself.

---

## Speckit Architecture Files

| File                            | Purpose                                                       |
|---------------------------------|---------------------------------------------------------------|
| `specs/<feature>/spec.md`       | Product specification (non-technical, user-facing)            |
| `specs/<feature>/plan.md`       | Implementation plan (tech stack, architecture decisions)      |
| `specs/<feature>/data-model.md` | Frontend/backend data shapes for the feature                  |
| `specs/<feature>/contracts/`    | Component prop contracts and hook interfaces                  |
| `specs/<feature>/tasks.md`      | Ordered, dependency-tracked task list for implementation      |
| `specs/<feature>/research.md`   | Technical research and ADRs                                   |
| `.specify/`                     | Speckit internal configuration and extensions                 |
| `onion.config.json`             | Layer definitions + allowed-import rules (architecture guard) |

The active plan is always referenced in the SPECKIT block at the top of this file. Run `/speckit-implement` to execute tasks from the current plan.

---

## Current Test Counts (approximate, as of feature 026)

| Package                    | Tests |
|----------------------------|-------|
| `apps/web` (unit)          | ~2794 |
| `apps/api` (unit)          | ~462  |
| `packages/domain` (unit)   | ~748  |
| `packages/infrastructure`  | ~185  |
| `apps/collab` (unit)       | ~122  |
| `packages/shared`          | ~37   |
| `packages/asciidoc-pdf`    | ~186  |
| `apps/web` (e2e)           | ~120  |

> `packages/asciidoc-pdf` (browser leaf) has its own jest suite that neither
> `scripts/ci/unit.sh` nor `.github/workflows/ci.yml` runs (CI's unit job covers
> asciidoc-core/shared/domain/api/collab/web only) — **run it manually** after
> touching the package: `pnpm --filter @asciidocollab/asciidoc-pdf test`.

> Known pre-existing gaps (not a regression of any single feature): `apps/web`
> jest coverage sits just under the configured 90/93/90 thresholds, and
> `packages/shared` reports 0% (it is types/DTOs only). The CI step
> `pnpm --filter @asciidocollab/web test -- --coverage` is also mis-quoted — the
> stray `--` makes jest treat `--coverage` as a path; run
> `pnpm --filter @asciidocollab/web exec jest --coverage` instead.

## Pending Phases

> Phases 8 (collaboration server) and 9 (real-time co-editing, presence) have shipped — see features 018, 020, 023 (Hocuspocus 4 upgrade), and 024 (file-tree open-file presence). Phase 10 (PDF generation) is landing as **feature 039** — in-browser export + live preview (see below).

| Phase | Scope                                                                                                                                                                            |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 10    | 🚧 PDF generation (feature 039) — **in-browser** Asciidoctor-PDF (ruby.wasm) export + live preview; images/custom-fonts/themes done, diagram/math/citation rendering being wired |
| 11    | Templates + asset management (built-in templates, custom templates, image upload)                                                                                                |
| 12    | Git sandbox + core operations (Docker sandbox, clone/pull/push/commit/branch switch)                                                                                             |
| 13    | Merge/pull requests (GitHub, GitLab, Bitbucket provider REST adapters)                                                                                                           |
| 14    | SAML authentication (passport-saml, Entra ID SSO, user provisioning)                                                                                                             |
| 15    | Enterprise security (MFA/TOTP, IP restrictions, audit log, performance hardening)                                                                                                |
