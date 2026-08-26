---
description: "Task list for Git Repository Synchronization"
---

# Tasks: Git Repository Synchronization

**Input**: Design documents from `/specs/048-git-repository-sync/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Implementation**: Every task MUST be executed via the `/tdd` skill (Constitution §Implementation
Discipline). Tasks describe WHAT to implement; the skill owns red-green-refactor. One deliverable = one
task = one `/tdd` invocation — never split test and implementation.

**Organization**: Grouped by user story (spec.md priorities). Each story is an independently testable
increment. Non-functional/performance tests are opt-in (Constitution II) — none are added here.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task).
- **[Story]**: US1–US7 for story-phase tasks; Setup/Foundational/Polish carry no story label.
- Test files live under each package/app `tests/` root mirroring `src/` (never `__tests__`/co-located).

**Reuse map** (from research.md — don't rebuild): `SessionEncryption` (AES-256-GCM), the collab
internal-HTTP transport + `CollaborativeContentReader`, the `<storageRoot>/<projectId>/` layout, the
`presenceByFile` decoration seam in `file-tree-node.tsx`, the config-fragment + 3-registrar DI, the
`CloneProjectUseCase` all-or-nothing/owner-member-last pattern, and the dormant `GitRepository`
entity/port/prisma/repository.

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 [P] Add `apps/api/src/config/schema-git.ts` (worker pool size, `git.egress.allowedHosts` + provider defaults, `git.credentialEncryptionKey` base64-32 with format validation, `git.rateLimitMax`/`git.rateLimitWindow`, `git.maxRepoSizeMB`, `git.lfsThresholdBytes`) and register it in `apps/api/src/config/schema.ts` + `Config` interface + `apps/api/src/config/formats.ts`
- [X] T002 [P] Scaffold new delivery app `apps/git-worker` (package.json, tsconfig, ESLint, composition-root skeleton, Dockerfile with `git` + `git-lfs`) under `apps/git-worker/`
- [X] T003 [P] Add git shared DTOs and typed error codes in `packages/shared/src/` (GitRepository/Branch/Commit/PendingChange/FileGitStatus/Conflict DTOs; error codes: RepositoryUnreachable, AuthenticationFailed, NonFastForward, MergeConflict, GitOperationInProgress, InsufficientRole, NothingStaged, EmptyCommitMessage, RemoteAlreadyInitialized, RemoteHistoryRewritten)
- [X] T004 Add Prisma models to `packages/db/prisma/schema.prisma`: `GitCredential`, `GitOperation` (+ partial-unique active-op index on `projectId WHERE state IN (QUEUED,RUNNING,AWAITING_CONFLICT)`, `heartbeatAt`), `GitConflict`, enums (`GitSyncStatus`, `GitOperationKind`, `GitOperationState`); extend `GitRepository` (`syncStatus`, `defaultBranch`, `lastKnownRemoteHead`, `connectedByUserId`) and add Project back-relations — **schema only; ask the user before generating any migration**

**Checkpoint**: config, worker app, DTOs, and schema shapes exist.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: no user story can begin until this phase is complete.

- [X] T005 [P] `GitCredentialStore` port + in-memory fake (`packages/domain/src/ports/git/`, `packages/domain/tests/ports/git/`)
- [X] T006 [P] `GitOperationRepository` port (enqueue, `claimNextQueued` incl. stale-heartbeat reclaim, heartbeat, `withGuard`, conflict CRUD) + in-memory fake (`packages/domain/src/ports/git/`, tests)
- [X] T007 [P] `GitCommandRunner` port + in-memory fake — all git actions return `packages/shared` DTOs; no git-library types cross the port (`packages/domain/src/ports/git/`, tests)
- [X] T008 [P] Extend `GitRepository` entity with `syncStatus`/`defaultBranch`/`lastKnownRemoteHead` and update `packages/infrastructure/src/persistence/project/prisma-git-repository.repository.ts` mapping (`packages/domain/src/entities/git-repository.ts`)
- [X] T009 `GitCredentialStore` adapter using `SessionEncryption` under a **dedicated** `git.credentialEncryptionKey`; store/read/delete encrypted token + `tokenHint`; never log/return plaintext (`packages/infrastructure/src/persistence/git/`)
- [X] T010 `GitOperationRepository` Prisma adapter: `claimNextQueued` via `SELECT … FOR UPDATE SKIP LOCKED` (reclaim stale ops in the same call), `withGuard` (fast conditional insert against the partial-unique index → `GitOperationInProgress`), heartbeat writes (`packages/infrastructure/src/persistence/git/`)
- [X] T011 `GitCommandRunner` adapter in `apps/git-worker/src/`: `execFile` git wrapper (array args, `--end-of-options`), working tree at `<storageRoot>/<projectId>/`, per-job workspace clean, out-of-band credential (askpass/env — never argv/URL/`.git/config`/logs), cross-host redirects disabled
- [X] T012 git-worker run loop + composition root: poll/claim `QUEUED` ops, dispatch to use cases, write heartbeat, set terminal state + `AuditLog`, opportunistic stale-op reclaim (`apps/git-worker/src/`)
- [X] T013 Worker network egress: deny-by-default with allowlist enforced at the network layer from `git.egress.allowedHosts` (`apps/git-worker/` + deploy manifest)
- [X] T014 [P] Hidden-metadata guard (FR-008a): filter `.git/`/`.collab/` from the file-tree read API and reject any file-operation path resolving into them, extending the existing `resolveSafe` denylist (`apps/api/src/routes/projects/file-tree-*.ts`, infra store)
- [X] T015 [P] Managed `.gitignore` ensuring `.collab/` and internal artifacts are never tracked; worker never stages them; **expose project-maintainer-editable ignore patterns (persisted on the project, OWNER-gated) merged into the managed `.gitignore`** (FR-008/040) (`apps/git-worker/src/`, `apps/api/`)
- [X] T016 Write-lock / single-flight integration (FR-009/031a): file-tree mutation routes and new edit-session gate return `409 GitOperationInProgress` while a content-changing op is `RUNNING`; mutating git short ops call `withGuard` (`apps/api/src/routes/projects/file-tree-*.ts`, collab auth gate)
- [X] T016a Git authorization guard (FR-021): a shared use-case-level role check (VIEWER/EDITOR/OWNER per data-model.md §8 matrix) returning `InsufficientRole`, invoked by every git use case (`packages/domain/src/use-cases/git/`)
- [X] T017 [P] Wire git DI: `GitCredentialStore` + `GitOperationRepository` in `apps/api/src/di/services.ts`; collab writer client in `di/stores.ts` (git repo already registered in `di/repositories.ts`)

**Checkpoint**: credentials, work-list + guard, runner, worker loop, hidden-metadata + write-lock guards ready — stories can begin.

---

## Phase 3: User Story 1 — Import a repository as a new project (Priority: P1) 🎯 MVP

**Goal**: Import an existing remote repo into a brand-new, fully editable project.

**Independent Test**: Import a repo with nested folders + text and binary files; the new project's tree and contents match the default branch and files open in the editor.

- [X] T018 [US1] `ConnectRepository` use case: validate provider/remote, authenticate, store encrypted credential, create `GitRepository`; OWNER-gated (`packages/domain/src/use-cases/git/`)
- [X] T019 [US1] `ImportRepository` use case: clone remote → new project (all-or-nothing + owner-member-last commit point, mirroring `CloneProjectUseCase`); build `FileNode`/`Document`/`Asset` tree from cloned files; mint fresh `yjsStateId`/`contentId`; exclude `.git`/`.collab`; LFS-aware; single-flight via `GitOperation` (`packages/domain/src/use-cases/git/`)
- [X] T020 [US1] `GitCommandRunner` clone + tree-materialize support in the worker (`apps/git-worker/src/`)
- [X] T021 [US1] `POST /projects/:projectId/git/import` route → `202 { operationId, projectId }`; auth; rate-limited (`apps/api/src/routes/projects/git/`)
- [X] T022 [US1] `GET /projects/:projectId/git/operations/:opId` route (state/progress/errorCode) (`apps/api/src/routes/projects/git/`)
- [X] T023 [P] [US1] Web import flow: provider/remote/token form + progress polling, and `apps/web/src/lib/api/git.ts` client (`apps/web/src/components/git/`)
- [X] T024 [P] [US1] Web connection status bar (branch / sync status / last-sync) (`apps/web/src/components/git/`)

**Checkpoint**: Import works end-to-end — MVP.

---

## Phase 4: User Story 2 — Commit and push local changes (Priority: P2)

**Goal**: Stage, review, commit (live-accurate), and push changes.

**Independent Test**: Live-edit an open doc + add/delete files; commit reflects the latest live edit (not stale disk); push lands it on the remote; empty message / nothing staged is refused.

- [X] T025 [US2] `GetGitStatus` use case: pending changes with types (added/modified/removed/renamed/moved/copied) and staged/unstaged/untracked states from the working tree; eventually-consistent, live-read only for the specific committed/diffed file (D15) (`packages/domain/src/use-cases/git/`)
- [X] T026 [US2] `StageChanges` use case (stage/unstage individual files; `withGuard`) (`packages/domain/src/use-cases/git/`)
- [X] T027 [US2] `CommitChanges` use case: flush + live-aware capture via `CollaborativeContentReader`, abort on live-read failure (FR-030); commit **staged only**; author = triggering user; reject empty message / nothing staged; `withGuard` (`packages/domain/src/use-cases/git/`)
- [X] T028 [US2] `PushChanges` use case: push current branch; non-fast-forward → `NonFastForward` (pull first); update `lastSyncAt`/`syncStatus` (`packages/domain/src/use-cases/git/`)
- [X] T029 [US2] `GitCommandRunner` status/add/reset/commit/push in the worker (`apps/git-worker/src/`)
- [X] T030 [US2] Git routes: `GET /git/status`, `GET /git/tree-status`, `POST /git/stage`, `/unstage`, `/commit`, `/push` (guard-aware `409`s; rate-limited) (`apps/api/src/routes/projects/git/`)
- [X] T031 [P] [US2] Web file-tree status badges: `statusByFile` prop threaded through `file-tree-node.tsx` (mirroring `presenceByFile`) + folder roll-up + `use-git-status` producer hook; render no git badges for projects that are not git-connected (FR-028) (`apps/web/src/components/file-tree/`, `apps/web/src/hooks/use-git-status.ts`)
- [X] T032 [P] [US2] Web commit dialog: required message + staged-changes review list with change-type labels (added/modified/removed/renamed/moved/copied); per-file stage/unstage; disable commit on empty message / nothing staged (`apps/web/src/components/git/`)

**Checkpoint**: Commit/push + tree indicators work.

---

## Phase 5: User Story 3 — Pull remote changes into the project (Priority: P3)

**Goal**: Pull remote changes, landing them safely into open documents.

**Independent Test**: Push a change to an open file from outside; pull → all connected editors see it and it survives save-back; a pull touching open files requires confirmation.

- [X] T033 [US3] `CollaborativeContentWriter` port + in-memory fake (`replaceContent` = minimal-diff reconcile) (`packages/domain/src/ports/storage/`, tests)
- [X] T034 [US3] apps/collab: `POST /internal/collab/apply-full-content` + `replaceDocumentContent` (minimal diff of live text → target, single Yjs transaction, forces writeback) (`apps/collab/src/internal-edit-server.ts`, `apps/collab/src/apply-edits.ts`)
- [X] T035 [US3] `HttpCollaborativeContentEditor.replaceContent` adapter (`packages/infrastructure/src/services/http-collaborative-content-editor.ts`)
- [X] T036 [US3] `PullChanges` use case: **flush open docs first (D14)**; fetch+merge; land content (writer for active docs, projection else); reconcile `FileNode`/`Document` rows; git-sourced renames applied as-is with **no** reference rewrite (FR-015a); conflicts → `AWAITING_CONFLICT`; update behind/ahead (`packages/domain/src/use-cases/git/`)
- [X] T037 [US3] Background fetch + `GetBehindAhead` use case (FR-038) — remote status only, no content egress (`packages/domain/src/use-cases/git/`)
- [X] T038 [US3] `GitCommandRunner` fetch/merge/pull with flush integration in the worker (`apps/git-worker/src/`)
- [X] T039 [US3] Collaboration-aware safety: warn+confirm before a pull affecting open files (FR-029); presence "git activity" signal (FR-031) (`apps/api/src/routes/projects/git/`, `apps/web/src/components/git/`)
- [X] T040 [US3] Git routes: `POST /git/pull` (`202`; `confirmAffectsOpenFiles`), `GET /git/behind-ahead` (`apps/api/src/routes/projects/git/`)
- [X] T041 [P] [US3] Web: "behind by N — pull available" badge, pull action, open-files warning dialog (`apps/web/src/components/git/`)

**Checkpoint**: Pull lands into live docs without data loss.

---

## Phase 6: User Story 4 — Create branches and switch between them (Priority: P4)

**Goal**: Create/switch branches; open editors reflect the target branch.

**Depends on**: T033–T035 (US3 writer/`apply-full-content`) for landing target-branch content into open editors.

**Independent Test**: Create a branch, switch to it (current-branch indicator updates), commit a change, switch back — files reflect the original branch.

- [X] T042 [US4] `CreateBranch` use case (branch from current state) (`packages/domain/src/use-cases/git/`)
- [X] T043 [US4] `SwitchBranch` use case: flush open docs first (D14); land target-branch content into open editors; uncommitted-changes → stash or clear block (FR-018); warn+confirm before a switch that changes files currently open (FR-029), mirroring T039's pull warning (`packages/domain/src/use-cases/git/`)
- [X] T044 [US4] `StashChanges` use case (shelve/restore on switch, FR-042) (`packages/domain/src/use-cases/git/`)
- [X] T045 [US4] `GitCommandRunner` branch/checkout/stash in the worker (`apps/git-worker/src/`)
- [X] T046 [US4] Git routes: `GET /git/branches`, `POST /git/branches`, `POST /git/checkout` (`apps/api/src/routes/projects/git/`)
- [X] T047 [P] [US4] Web branch switcher: list/create/switch + current-branch indicator (`apps/web/src/components/git/`)

**Checkpoint**: Branching works with live editors.

---

## Phase 7: User Story 5 — Resolve conflicts within the platform (Priority: P5)

**Goal**: Resolve pull/switch conflicts in-app.

**Depends on**: US3 pull (T036) reaching a conflicted state; T033–T035 (US3 writer) for landing resolved content.

**Independent Test**: Create a same-line conflict, pull → conflicted state; resolve each file (ours/theirs/merged) → operation completes with a resolving commit.

- [X] T048 [US5] `ResolveConflicts` use case: per-file ours/theirs/merged; persist/clear `GitConflict`; block completion until all resolved (`packages/domain/src/use-cases/git/`)
- [X] T049 [US5] `CompleteMerge`/`pull-complete` + `UndoPull` use cases (continue-merge → resolving commit; undo restores pre-op snapshot, FR-037) with worker merge-continue/abort + conflict-stage read (base/ours/theirs) (`packages/domain/src/use-cases/git/`, `apps/git-worker/src/`)
- [X] T050 [US5] Git routes: `GET /git/conflicts`, `GET /git/conflicts/:path`, `POST /git/conflicts/:path`, `POST /git/pull/complete`, `POST /git/undo-pull` (`apps/api/src/routes/projects/git/`)
- [X] T051 [P] [US5] Web conflict UI: per-file keep-ours/take-theirs + inline three-way merge editor (client-side diff) (`apps/web/src/components/git/`)

**Checkpoint**: Conflicts fully resolvable in-app.

---

## Phase 8: User Story 6 — Initialize Git on an existing project (Priority: P6)

**Goal**: Connect/init an existing project to a remote and disconnect.

**Independent Test**: On a non-git project with an empty remote, initialize+publish → remote gets an initial commit; project shows connected. Disconnect keeps files and deletes the credential.

- [X] T052 [US6] `InitializeRepository` use case: init repo on existing project, connect remote, initial commit+push; remote-not-empty → guide to import; OWNER-gated (`packages/domain/src/use-cases/git/`)
- [X] T053 [US6] `DisconnectRepository` use case: remove remote link + delete credential, keep files, revert to non-git; OWNER-gated (FR-004a) (`packages/domain/src/use-cases/git/`)
- [X] T054 [US6] `GitCommandRunner` init/remote-add/first-push in the worker (`apps/git-worker/src/`)
- [X] T055 [US6] Git routes: `POST /git/connect`, `POST /git/initialize`, `POST /git/disconnect`, `PUT /git/credential` (`apps/api/src/routes/projects/git/`)
- [X] T056 [P] [US6] Web connect/initialize/disconnect panel + credential rotation (`apps/web/src/components/git/`)

**Checkpoint**: Full connection lifecycle.

---

## Phase 9: User Story 7 — History, diff & discard (additive)

**Goal**: Everyday git usage inside the editor.

**Depends on**: T033–T035 (US3 writer/`apply-full-content`) for discard/restore into open editors (FR-035).

**Independent Test**: View a file's history and a legible diff of uncommitted changes; discard a file's changes; all without leaving the editor.

- [X] T057 [US7] `GetHistory` use case (project + per-file commit history) (`packages/domain/src/use-cases/git/`)
- [X] T058 [US7] `GetDiff` use case (uncommitted-vs-last + commit-vs-commit; live read for an open file, D15) (`packages/domain/src/use-cases/git/`)
- [X] T059 [US7] `DiscardChanges` use case (discard/restore a file; safe w.r.t. active sessions via the writer, FR-035) (`packages/domain/src/use-cases/git/`)
- [X] T060 [US7] `AmendCommit` use case (amend most-recent unpushed commit, FR-036) (`packages/domain/src/use-cases/git/`)
- [X] T061 [US7] `GitCommandRunner` log/diff/blame/restore/reset in the worker (`apps/git-worker/src/`) — split T061a (log/diff/blame reads) + T061b (discard/amend writes)
- [X] T062 [US7] Git routes: `GET /git/history`, `GET /git/diff`, `GET /git/blame`, `POST /git/discard`, `POST /git/amend` (`apps/api/src/routes/projects/git/`)
- [X] T063 [P] [US7] Web: history panel, AsciiDoc-aware diff view, blame, discard/restore actions (`apps/web/src/components/git/`)

**Checkpoint**: History/diff/discard usable in-editor.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T064 [P] Rate limiting on all mutating/expensive git routes (configurable `git.rateLimitMax`/`Window`) with contract-noted `429` (`apps/api/src/routes/projects/git/`)
- [X] T065 [P] Audit-log coverage completeness for every git action + authz denial (FR-022), secrets redacted (`apps/api/`, domain)
- [X] T066 [P] Git LFS handling for large binary assets (over `git.lfsThresholdBytes`) in import/commit; enforce `git.maxRepoSizeMB` with graceful failure (FR-041) (`apps/git-worker/src/`)
- [X] T067 [P] Provider guided auth (OAuth connect flow) + commit-email privacy option (FR-044/045) (`apps/api/`, `apps/web/src/components/git/`)
- [X] T068 [P] Dry-run preview of push/pull (FR-043) (`packages/domain/src/use-cases/git/`, `apps/web/src/components/git/`)
- [~] T069 [P] Provider webhook receiver for near-real-time "remote updated" signal (FR-039) (`apps/api/`) — optional
- [X] T070 [P] Docs: developer setup for `apps/git-worker`, egress/credential config; update feature docs
- [X] T071 Run `quickstart.md` validation — all six smoke paths + security checks (arg-injection rejected, egress allowlist, `.git`/`.collab` traversal rejected, token absent from logs/responses) + an all-or-nothing check (force a mid-op failure and confirm the project is left in its prior consistent state, FR-010)
- [X] T072 Full quality-gate sweep across touched packages: `pnpm gate` (lint, typecheck, unit + integration + security scan + e2e) — Constitution §End-of-Feature Verification
- [X] T073 `/code-review` loop until zero findings — Constitution §End-of-Feature Verification

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → no deps.
- **Foundational (P2)** → after Setup; **blocks all stories**. Within P2: T005–T008 [P]; T009–T010 depend on T004+ports; T011–T013 depend on T002/T007; T014–T016 depend on the guard/runner; T017 wires it.
- **US1 (P3)** → after Foundational. **MVP.**
- **US2 (P4)**, **US3 (P5)**, **US4 (P6)**, **US5 (P7)**, **US6 (P8)**, **US7 (P9)** → each after Foundational; independently testable.
- **Polish (P10)** → after the desired stories.

### Cross-story notes (independent, but natural build order)

- US2 assumes a connected project (US1 or US6). US3's `apply-full-content` (T033–T035) is reused by US4 switch and US5/US7 landing/discard. US5 continues US3's pull. Each story is still testable on its own against a connected project.
- The single-flight guard (T010/T016), live reader (existing), and writer (T033–T035) are the shared spine; once present, stories mostly parallelize.

### Parallel opportunities

- Setup: T001–T003 [P] (T004 after).
- Foundational: T005–T008 [P]; T014/T015/T017 [P].
- Per story: the domain use cases (different files) and the `[P]` web tasks can run alongside the worker/runner task once the story's use case exists.
- Polish: T064–T070 [P].

---

## Parallel Example: Foundational ports

```bash
# Ports + fakes are independent files — run together:
Task: "T005 GitCredentialStore port + fake"
Task: "T006 GitOperationRepository port + fake"
Task: "T007 GitCommandRunner port + fake"
Task: "T008 Extend GitRepository entity + prisma mapping"
```

---

## Implementation Strategy

### MVP first (US1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (blocks everything) → 3. Phase 3 US1 Import →
4. **STOP & validate** import end-to-end → demo.

### Incremental delivery

US1 (import) → US2 (commit/push) → US3 (pull) → US4 (branches) → US5 (conflicts) → US6 (init/disconnect)
→ US7 (history/diff/discard) → Polish. Each story is demoable without breaking prior ones.

---

## Notes

- Each task = one `/tdd` invocation (red→green→refactor); never split test and implementation.
- **Authorization (FR-021)**: every git use-case task MUST call the T016a role guard and cover the
  denial path in its `/tdd` test — permission checks live in the use case, never only in the route.
- **All-or-nothing (FR-010)**: each content-mutating op task (T019, T027/T028, T036, T043, T049) MUST
  verify in its `/tdd` test that a forced mid-op failure leaves the project in its prior consistent state.
- Domain use cases tested with in-memory fakes; infrastructure adapters + `GitCommandRunner` with
  integration tests (testcontainers Postgres + a temp bare remote / temp working tree); the collab
  `apply-full-content` with an integration test proving a live room updates and an open editor is not
  reverted.
- Commit only after green; keep git token out of every diff, log, and response.
- **Before starting T004's migration**, ask the user (Constitution Database Migration Policy).
- Constitution deviations already ratified: architecture 2.6.0 (git-worker + SKIP-LOCKED exemption),
  security 1.3.0 (git sandbox). Governance Principle X unchanged — egress documented at feature scope.
