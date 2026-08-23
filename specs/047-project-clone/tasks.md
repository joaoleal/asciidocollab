---
description: "Task list for 047-project-clone"
---

# Tasks: Project Cloning

**Input**: Design documents from `/specs/047-project-clone/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R9), data-model.md, contracts/

**Implementation**: Every task MUST be executed via the `/tdd` skill (Constitution §Implementation
Discipline). Tasks describe WHAT to deliver; the skill owns red-green-refactor. No deliverable is
split into a separate "write test" and "write implementation" task — where a guarantee has an
implementation, its assertion lives in the same task as that implementation.

**No schema migration. No new package. No new runtime dependency.** (plan.md §Summary)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel — different files, no dependency on an incomplete task
- **[Story]**: US1 / US2 / US3, mapping to the spec's user stories
- Exact file paths are given in every task

## Path Conventions

Tests live in a `tests/` directory at the package or app root, mirroring the source tree. Never
`__tests__/`, never co-located. `packages/domain/src/use-cases/project/clone-project.ts` →
`packages/domain/tests/use-cases/project/clone-project.test.ts`.

---

## Phase 1: Setup (Shared Surface)

**Purpose**: The two shared declarations every later phase imports. There is nothing else to
initialize — no package, no dependency, no migration.

- [X] T001 [P] Add `CloneProjectDto { name: string }` in `packages/shared/src/dtos/clone-project.dto.ts` and export it from `packages/shared/src/dtos/index.ts` (data-model §4; the response body reuses the existing `ProjectDto`, so no result DTO is added)
- [X] T002 [P] Add `AUDIT_PROJECT_CLONED = 'project.cloned'` and `AUDIT_PROJECT_CLONE_REQUESTED = 'project.clone_requested'` to `packages/domain/src/audit-actions.ts`, following the existing `AUDIT_PROJECT_*` constant pattern (data-model §1 AuditLog)

**Checkpoint**: Shared names exist; foundational work can begin.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The domain errors, the concurrency port with both its fake and its implementation, and
the resolver generalization. The clone use case cannot be written until all five land.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T003 Add the three clone domain errors — `CloneAlreadyInProgressError`, `LiveContentUnavailableError(path)`, `CloneFailedError(cause)` — in `packages/domain/src/errors/project/clone-already-in-progress.ts`, `packages/domain/src/errors/project/live-content-unavailable.ts` and `packages/domain/src/errors/project/clone-failed.ts`, exported from `packages/domain/src/errors/index.ts`. Typed value objects, not strings (data-model §5). `LiveContentUnavailableError` carries a project-relative `FileNode.path` only — never a `ProjectFileStore` `FilePath`
- [X] T004 [P] Define the `ActiveCloneRegistry` port (`tryAcquire(userId): boolean`, `release(userId): void`) in `packages/domain/src/ports/project/active-clone-registry.ts`, exported from `packages/domain/src/ports/index.ts` (data-model §2, research R5)
- [X] T005 [P] Implement the in-memory fake in `packages/domain/tests/ports/project/in-memory-active-clone-registry.ts`, registered in `packages/domain/tests/ports/index.ts`, honouring the data-model §2 contract: `tryAcquire` atomic per user; a second `tryAcquire` returns `false` until `release`; `release` of an unheld user is a no-op; users are independent (Principle III) — depends on T004
- [X] T006 [P] Implement `InMemoryActiveCloneRegistry` in `packages/infrastructure/src/services/in-memory-active-clone-registry.ts`, exported from `packages/infrastructure/src/services/index.ts`, mirroring `apps/collab/src/extensions/connection-limit.ts` (research R5). The held-user set MUST be **private instance state on the class** — never a module-level `Set`, which would be a static singleton the architecture constitution forbids (§Layer Boundaries) and would leak between tests — depends on T004
- [X] T007 [P] Generalize `resolveDownloadContentSource` in `packages/domain/src/use-cases/project/download-content-source.ts` with an `onLiveReadError: 'fallback' | 'fail'` policy and a third result variant `{ kind: 'unavailable'; fileNode: FileNode }` returned only under `'fail'`. Download callers pass `'fallback'`; prove in `packages/domain/tests/use-cases/project/download-content-source.test.ts` that download's behaviour is byte-for-byte unchanged (research R2). Do **not** add a policy flag to `packages/domain/src/use-cases/content/live-content.ts`

**Checkpoint**: Foundation ready — the clone use case can now be built.

---

## Phase 3: User Story 1 - Clone a project I have access to (Priority: P1) 🎯 MVP

**Goal**: A member of any role can clone a project under a new name and own the copy, which holds the
same file tree and content as the source, with the source left untouched.

**Independent Test**: Drive `CloneProjectUseCase` against in-memory fakes: a viewer of a source
project with folders, documents and assets clones it; assert the clone's tree, paths and bytes match,
the clone's sole member is the actor as owner, and every source fake is unmodified.

All six tasks edit `packages/domain/src/use-cases/project/clone-project.ts` and its test file, so
they run in order — none is `[P]`.

- [X] T008 [US1] Create `CloneProjectUseCase` in `packages/domain/src/use-cases/project/clone-project.ts` (exported from `packages/domain/src/use-cases/index.ts`) implementing the ordering spine of data-model §6: `tryAcquire` first and `release` in a `finally` covering every path (FR-027); membership authorization at **any** role — viewer, editor or owner (FR-001) — with a non-member and a non-existent project returning the identical `PermissionDeniedError` (FR-002) after recording `authz.denied` through `recordAuthorizationDenial` (`packages/domain/src/use-cases/audit-recording.ts:114`, FR-026a); `ProjectName.create` validation, which accepts a name already used by another of the actor's projects because project names are not unique (FR-003); the **memberless** project row; and the single owner `ProjectMember` row written **last** as the commit point that makes the project visible (research R1, FR-023). Assert the finished clone has exactly one member — the actor as owner (FR-005, FR-006, SC-004)
- [X] T009 [US1] Copy the file tree in `clone-project.ts`: one `FileNode` per source node, parent-before-child so `parentId` always resolves, `name`/`type`/`path` verbatim so cross-file references keep resolving (FR-008, FR-012, SC-002). Build and carry the `sourceFileNodeId → cloneFileNodeId` identity map for the whole run. The clone's root keeps `path` `/` and takes the new project name, matching `CreateProjectUseCase`. Cover the degenerate case: a source whose tree is only the root folder yields an empty clone, not a failure (spec §Edge Cases — empty project)
- [X] T010 [US1] Copy text documents in `clone-project.ts`: for each source file node that has a `Document`, resolve content through the T007 resolver with `onLiveReadError: 'fail'`, write the UTF-8 bytes to the clone's sandbox at the same path, and create a `Document` row with **fresh** `id`, `contentId` and `yjsStateId` and the copied `mimeType`, persisting **no** Yjs state (research R3, FR-009/FR-009b, SC-002). An `'unavailable'` result aborts the clone with `LiveContentUnavailableError` naming the source `FileNode.path` (FR-009a)
- [X] T011 [US1] Copy binary assets and folders in `clone-project.ts`: a file node with no `Document` is an asset — read raw bytes from the source `ProjectFileStore` and write them verbatim into the clone's sandbox, creating an `Asset` row whose `id` is the clone's file node id, with the copied `mimeType` and `sizeBytes` equal to the bytes actually written (research R4, FR-010, SC-002). Folders are created via `createDirectory`
- [X] T012 [US1] Add compensating cleanup to `clone-project.ts`: any failure between the project row and the membership row deletes the project row (cascading file nodes, documents, assets, render config and dictionary terms) and calls `ProjectFileStore.removeProject`, then returns `CloneFailedError` — **without** calling `YjsStateStore.deleteAllForProject`, because a clone persists no Yjs state (data-model §6, quickstart orientation table, FR-024/FR-024a). Prove the source project's rows, files and membership are unmodified after a failed clone (FR-007). Cover the source-deleted-mid-clone case: the clone either completes as a faithful copy of what it had already read, or fails cleanly with cleanup — never a partially copied project (spec §Edge Cases)
- [X] T013 [US1] Write the clone's audit entries in `clone-project.ts`: `project.cloned` against the new project with metadata naming the source project id, and `project.clone_requested` against the source project recording that the actor read its content (FR-026, data-model §1 AuditLog). Given a source that already has audit entries, assert the clone's trail contains **exactly** that one creation entry and none of the source's earlier ones (FR-020)

**Checkpoint**: US1 complete — the clone use case produces an owned, content-identical, independent copy.

---

## Phase 4: User Story 2 - The copy behaves like the original (Priority: P2)

**Goal**: The clone carries the source's project-level settings, so it renders and exports the same.

**Independent Test**: Configure a source project's description, tags, language, main file, render
config and dictionary away from their defaults, clone it, and assert every copied setting equals the
source's and the clone is active rather than archived.

All three tasks edit `packages/domain/src/use-cases/project/clone-project.ts` — run in order.

- [X] T014 [US2] Copy the project-level settings in `clone-project.ts`: `description`, `tags` and `language` verbatim and `archivedAt` forced to `null` on the initial project row, so an archived source yields an active clone (FR-015); then `mainFileNodeId` as a **separate update after T009's file nodes exist** — it is a foreign key to `FileNode` (`packages/db/prisma/schema.prisma:94`, `onDelete: SetNull`), so it cannot be written when the project row is created (data-model §6, steps 4 and 7) — remapped through the T009 identity map to the clone's own copy of that node, so a later change to the source's main file cannot affect the clone (FR-013, R7)
- [X] T015 [US2] Copy `ProjectRenderConfig` in `clone-project.ts`: if the source has a row, create one for the clone with the same `config` JSON verbatim; if it has none, create none — an absent row means "project defaults", and materializing one would freeze today's defaults into the clone (data-model §1, FR-013)
- [X] T016 [US2] Copy `ProjectDictionaryTerm` rows in `clone-project.ts`: same `term`, fresh ids, and `createdByUserId` re-attributed to the cloning user because the source author may not be a member of the clone (FR-014, Principle VII)

**Checkpoint**: US1 + US2 complete — the clone is a faithful, independently-configured copy.

---

## Phase 5: User Story 3 - The copy starts clean (Priority: P3)

**Goal**: No collaboration state, no private per-user state and no credential crosses from the source
into the clone.

**Independent Test**: Seed a source project with review comments, replies, reactions and open tasks,
dismissed lint suggestions, a git repository link and a template; clone it; assert the clone carries
none of them.

The story's two other exclusions are asserted where they are implemented, not here: membership
(FR-006) in T008 and audit history (FR-020) in T013. Splitting a guarantee from its implementation
across two tasks is what §Implementation Discipline forbids. T023 re-proves all of them against real
Postgres.

- [X] T017 [US3] Prove the exclusions that have no implementation of their own, in `packages/domain/tests/use-cases/project/clone-project.exclusions.test.ts`: with the in-memory fakes **seeded** for the source, a clone carries zero `ReviewComment` rows — asserted across **both** `ReviewItemKind` values, because a review task is a `ReviewComment` with `kind: TASK` and there is no separate task entity (`packages/db/prisma/schema.prisma:31-34, 398-402`), which is the only way FR-017's coverage can actually fail — and zero `ReviewReaction`, `IgnoredLint`, `GitRepository` (hence no copied `credentialRef`), `Template` and `CollaborationSession` rows against the clone id (FR-016, FR-017, FR-018, FR-019, FR-021, R7 — FR-006 and FR-020 are asserted in T008 and T013). Seeding is what keeps these assertions from being vacuous

**Checkpoint**: All three stories hold at the domain level.

---

## Phase 6: API

**Purpose**: Expose the use case as `POST /api/projects/:projectId/clone` per
`contracts/clone-project-api.md`.

- [X] T018 [P] Add the `project.clone` rate-limit pair to `apps/api/src/config/schema-project.ts` — both the TypeScript config-interface fragment and the convict schema fragment — as `rateLimitMax` (env `ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_MAX`, default `20`) and `rateLimitWindow` (env `ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_WINDOW`, default `3_600_000`), alongside the existing `mainFile`, `renderConfig`, `refactoring` and `search` pairs. Configuration-driven, never a literal (security constitution)
- [X] T019 [P] Construct **one** `InMemoryActiveCloneRegistry` instance at the composition root in `apps/api/src/di/services.ts` and inject it into `CloneProjectUseCase`, so every request in the process shares that instance (research R5). "Singleton" describes the wiring, not the module — no module-level state (architecture constitution §Layer Boundaries)
- [X] T020 Add the route module `apps/api/src/routes/projects/clone.ts` — `POST /api/projects/:projectId/clone`, `preHandler: [requireAuth]`, Fastify body schema `name: { type: 'string', minLength: 1, maxLength: 100 }`, and `config.rateLimit` fed from `app.config.project.clone.*` — registered in `apps/api/src/di/routes.ts` next to `projectDownloadRoute` and `renderConfigRoutes` — depends on T018, T019
- [X] T021 Map domain errors to statuses in `apps/api/src/routes/projects/clone.ts` per the contract's error table: `400 VALIDATION_ERROR`, `403 FORBIDDEN` (also when the project does not exist), `409 CLONE_IN_PROGRESS`, `429 RATE_LIMITED`, `503 LIVE_CONTENT_UNAVAILABLE` with `details.path` bound to the project-relative `FileNode.path`, `500 CLONE_FAILED`. Cover each row in `apps/api/tests/routes/projects/clone.test.ts` — same file as T020, run after it
- [X] T022 Emit the `201` body as a complete `ProjectDto` in `apps/api/src/routes/projects/clone.ts`, field-for-field identical to an element of `GET /api/projects`'s `data` array (`apps/api/src/routes/projects.ts:100-115`) — including `owners` with `displayName` resolved via `repos.user.findById`, `rootFolderId`, `mainFileNodeId`, `role` `"owner"`, `archivedAt` `null`, and `memberCount` / `fileCount` derived the **same way the list route derives them** rather than assumed from what the clone just wrote. Assert the field set against the list route's shape in `apps/api/tests/routes/projects/clone.test.ts`; a narrower body renders a dashboard card with blank counts (data-model §4, UI contract)
- [X] T023 Prove the exclusions and the cleanup against real Postgres in `apps/api/tests/routes/projects/clone-exclusions.test.ts` (testcontainers): seed the source with extra members, review comments and replies with reactions plus open tasks (`ReviewComment` rows of **both** `ReviewItemKind` values), ignored lints, a git link and audit history, clone over HTTP, and assert the clone carries none of them (FR-006, FR-016 – FR-021, SC-005); that a clone failed mid-run leaves no project row visible in `GET /api/projects` and no directory under project storage (FR-024a, SC-008); and that two **different** users cloning the same source concurrently both succeed with independent results (FR-027, spec §Edge Cases)
- [X] T024 Prove the membership-last invisibility invariant in `apps/api/tests/routes/projects/clone-invisibility.test.ts` (testcontainers): seed a project row with **no `ProjectMember` rows** plus its file nodes and stored bytes directly — the exact residue an abrupt stop mid-clone leaves — and assert it is absent from `GET /api/projects` for every user including the one who would have owned it, that project-scoped routes refuse to open it, and that it is counted nowhere a user can observe (FR-024b, SC-008). This is the premise the whole atomicity design rests on (research R1) and nothing else tests it in isolation: T023's assertions run *after* cleanup has already removed the row, so they cannot tell "cleanup worked" from "membership-last works"

**Checkpoint**: The clone is reachable, rate-limited, correctly refused, correctly shaped, and provably invisible until it commits.

---

## Phase 7: Web

**Purpose**: Deliver the dashboard flow in `contracts/clone-project-ui.md`.

- [X] T025 [P] Add `clone(id: string, name: string): Promise<{ data: Project }>` to `apps/web/src/lib/api/projects.ts`, following the existing `create` / `archive` / `restore` shape
- [X] T026 [P] Add `apps/web/src/components/clone-project-dialog.tsx` using the existing token-driven dialog and button primitives (Principle V, no color literals): name field pre-filled with `Copy of <name>` truncated to 100 characters and selected so typing replaces it; the idle / invalid / pending / error / success states from the UI contract, where pending shows an indeterminate busy indicator and disables submit (this is both the progress indication and the double-submit guard, FR-022, research R6); and error copy driven by the response code (`CLONE_IN_PROGRESS`, `RATE_LIMITED`, `LIVE_CONTENT_UNAVAILABLE` naming the file, `FORBIDDEN`, `VALIDATION_ERROR` / `CLONE_FAILED`). On error the dialog stays open with the name preserved
- [X] T027 Change `apps/web/src/components/project-card.tsx` so the overflow menu renders for **every** role — moving today's `canManage` gate off the menu and onto its items: Members owner-only, Settings and Clone for every role (FR-001, FR-001a, FR-001b, FR-001c, research R8) — and open the T026 dialog from the Clone item. Keep the trigger's `aria-label="Project options"` and its `stopPropagation` (the card is a stretched link) — depends on T026
- [X] T028 Refresh the listing and confirm on success in `apps/web/src/app/(dashboard)/dashboard/page.tsx` and `apps/web/src/app/(dashboard)/dashboard/archived/page.tsx`: insert the `201` response body directly into the list with no follow-up fetch, keep the user on the dashboard, and show a confirmation naming the new project with a direct action that opens it (FR-025) — depends on T027

**Checkpoint**: The full flow works in the browser against the real API.

---

## Phase 8: End-to-End

**Purpose**: The acceptance scenarios only a real stack can prove. Both tasks write
`apps/web/e2e/project-clone.spec.ts`, so they run in order. The spec MUST NOT change any editor
preference — preferences are per-account and every e2e spec shares one login.

- [X] T029 Cover the dashboard flow in `apps/web/e2e/project-clone.spec.ts`: the overflow menu appears for a viewer, an editor and an owner, offering Clone to all three and Members and Settings only to the owner (FR-001b/FR-001c, as amended during implementation — see the FR-001c note in spec.md; a viewer's menu holds Clone alone). Also assert the menu does not remain open behind the clone dialog, which no unit test can see because the dropdown is mocked; cloning under a new name leaves the user on the dashboard, the new card appears without a reload, and the confirmation's action opens the clone, which lists the actor as its only member (FR-025, SC-001, SC-004). Include the archived path end to end: an **archived** source cloned from `/dashboard/archived` succeeds and yields an **active** clone (FR-004, FR-015) — this is the only check on the UI contract's claim that the archived view gets the menu for free by reusing `ProjectCard`
- [X] T030 Cover clone fidelity and isolation in `apps/web/e2e/project-clone.spec.ts`: a cloned document **opens in the editor with its content** rather than blank — the exact failure mode research R3 warns about, which no unit test can catch; the include and the image reference resolve without path edits (FR-012); the main file, render settings and dictionary term carried over (FR-013/FR-014); no review comments appear (FR-016/FR-017); and editing the clone leaves the source unchanged and vice versa (FR-011, SC-007). Include the export-equality check that stands in for SC-006 — deliberately not a fidelity-oracle run (research R9)

**Checkpoint**: Every acceptance scenario in the spec is covered.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T031 [P] Walk `specs/047-project-clone/quickstart.md` end to end on a running stack, including its failure-path table (live content unavailable, one-clone-at-a-time, non-member + `authz.denied`, rate limit, nothing visible on failure, abrupt stop), and correct the document where reality differs
- [X] T032 [P] Update `AGENTS.md` with the clone route, the injected `ActiveCloneRegistry`, and the membership-last visibility invariant, so the next contributor does not discover the commit-point ordering by breaking it
- [ ] T033 Run the full quality gate from the repo root — `pnpm gate` (config in `package.json`) plus the Docker-gated and `RUN_*`-gated jobs the local gate skips (`.github/workflows/`), and the security scan. Cap Jest workers and run under a memory-limited scope; a skipped check is not a pass (Constitution §End-of-Feature Verification)
- [ ] T034 Run `/code-review` repeatedly over the `047-project-clone` branch diff until it returns zero findings, applying each fix in the files it names

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: needs Phase 1 — **blocks every user story**
- **US1 (Phase 3)**: needs Phase 2
- **US2 (Phase 4)**: needs US1's identity map (T009) — it copies settings onto the project US1 builds
- **US3 (Phase 5)**: needs US1; independent of US2
- **API (Phase 6)**: needs US1 (US2/US3 recommended, since T023 asserts their guarantees)
- **Web (Phase 7)**: needs the API route (T020–T022)
- **E2E (Phase 8)**: needs Web
- **Polish (Phase 9)**: needs everything

### Task-level dependencies worth stating

- T005, T006 → T004 (the port they implement)
- T009 → T008 (the identity map lives on the use case's spine)
- T010, T011 → T009 (both walk the identity map)
- T012 → T010, T011 (there is nothing to clean up until bytes are written)
- T014 → T009 (the main-file update needs the clone's nodes to exist)
- T020 → T018, T019
- T021, T022 → T020 (same file)
- T023 → T020–T022 (drives the route over HTTP)
- T024 → T019 (needs the app wired; it seeds the DB directly rather than calling the route)
- T027 → T026; T028 → T027
- T030 → T029 (same spec file)

### Parallel Opportunities

- **Phase 1**: T001 and T002 together — different packages
- **Phase 2**: T004 and T007 together; then T005 and T006 together once T004 lands
- **Phase 6**: T018 and T019 together — different files, both before T020
- **Phase 7**: T025 and T026 together — different files
- **Phase 9**: T031 and T032 together

Phases 3, 4 and 5 have **no** parallel tasks: every task in 3 and 4 edits
`packages/domain/src/use-cases/project/clone-project.ts`, and Phase 5 has a single task.

---

## Parallel Example: Phase 2

```bash
# First wave — the port and the resolver are unrelated:
Task: "T004 ActiveCloneRegistry port in packages/domain/src/ports/project/active-clone-registry.ts"
Task: "T007 onLiveReadError policy in packages/domain/src/use-cases/project/download-content-source.ts"

# Second wave — both implement T004's port, in different packages:
Task: "T005 in-memory fake in packages/domain/tests/ports/project/in-memory-active-clone-registry.ts"
Task: "T006 InMemoryActiveCloneRegistry in packages/infrastructure/src/services/in-memory-active-clone-registry.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 → Phase 2 → Phase 3 (T001–T013)
2. **STOP and VALIDATE**: the use case clones tree, content and ownership against in-memory fakes,
   fails closed on an unreadable live document, and cleans up after itself
3. The MVP is domain-only and not yet reachable by a user — Phases 6 and 7 are what ship it

### Incremental Delivery

1. Setup + Foundational → the clone use case can be written
2. US1 → a faithful copy exists (MVP)
3. US2 → the copy behaves like the original
4. US3 → the copy is provably clean
5. API + Web + E2E → users can actually clone

### Suggested MVP scope for a shippable release

US1 + US3 + API + Web. US3 is a privacy boundary that must hold from the first release even though
it is priority P3, and US2 is the only phase a first release could defensibly defer — a clone with
content but default settings is still useful.

---

## Notes

- Each task = one `/tdd` invocation; never split test and implementation into separate tasks
- Commit after each task or logical group, only after the green phase
- `LiveContentUnavailableError` is the single reviewed exception to "domain errors expose no paths".
  It carries the project-relative `FileNode.path` the caller already sees in their own file tree —
  never a `ProjectFileStore` `FilePath` resolved against the storage root
- The owner `ProjectMember` row is the commit point. Nothing may be written after it, and nothing
  before it may be visible — T024 is what proves the second half
- A review task is a `ReviewComment` with `kind: TASK`; there is no separate task table. Assertions
  about FR-017 must go through `kind`, or they pass without checking anything
- **SC-003's 30-second budget is deliberately untested.** Principle II makes performance tests
  opt-in, the spec does not request one, and its absence is not a coverage gap. The other half of
  SC-003 — an in-progress indication for the whole wait — is covered by T026
- `e2e-local.sh` is not concurrent-safe — a second run tears down the first
