# Phase 1 Data Model: Git Repository Synchronization

**Feature**: `048-git-repository-sync` | **Date**: 2026-08-24 | [spec.md](./spec.md) · [research.md](./research.md)

Onion layering: entities + ports in `packages/domain`, Prisma models in `packages/db`, adapters in
`packages/infrastructure`. Every new port gets an in-memory fake under `packages/domain/tests/ports/`.
**Prisma schema edits are proposed here; migrations are NOT generated without explicit user
confirmation** (Architecture Constitution — Database Migration Policy).

---

## 1. Reused / existing models (no change or additive only)

- **`Project`** (`schema.prisma:81`) — unchanged; already has `gitRepository GitRepository?` 1:1.
- **`GitRepository`** (`schema.prisma:191`) — **wired, lightly extended**. Existing:
  `id, projectId (unique), provider (GitProvider), remoteUrl, credentialRef, currentBranch, lastSyncAt, createdAt`.
  Add: `defaultBranch String?`, `lastKnownRemoteHead String?` (for ahead/behind), `syncStatus`
  (enum below), `connectedByUserId String? @db.Uuid`.
- **`ProjectMember` / `Role`** (`schema.prisma:104`, `Role = VIEWER|EDITOR|OWNER`) — reused for
  authorization (FR-021): **OWNER** connects/disconnects/manages credential; **EDITOR|OWNER** perform
  sync (commit/push/pull/branch/resolve/discard); **VIEWER** reads git status only.
- **`FileNode` / `Document` / `Asset` / `CollaborationSession`** — unchanged. `Document.yjsStateId`
  remains the collab room id used to read/land live content. `CollaborationSession` (exists iff a room
  is open) remains the active-edit signal consulted by the live-content resolver and the write-lock.
- **`AuditLog`** (`schema.prisma:204`) — reused for FR-022 (git actions + authz denials), no schema
  change (uses `action`, `resourceType`, `resourceId`).
- **`GitProvider`** enum (`GITHUB|GITLAB|BITBUCKET`) — unchanged (spec assumption).

## 2. New Prisma models

```prisma
enum GitSyncStatus { UP_TO_DATE AHEAD BEHIND DIVERGED CONFLICTED DISCONNECTED }

enum GitOperationKind {
  IMPORT INITIALIZE CONNECT DISCONNECT COMMIT PUSH PULL FETCH
  BRANCH_CREATE BRANCH_SWITCH RESOLVE DISCARD AMEND UNDO_PULL
}

enum GitOperationState { QUEUED RUNNING AWAITING_CONFLICT SUCCEEDED FAILED ABORTED }

// Encrypted credential store that GitRepository.credentialRef points to (D5).
model GitCredential {
  id             String   @id @default(uuid()) @db.Uuid
  projectId      String   @unique @db.Uuid
  provider       GitProvider
  // AES-256-GCM ciphertext (iv:tag:ciphertext); NEVER logged or returned to clients.
  encryptedToken String
  tokenHint      String?  // last 4 chars for UI display only
  createdByUserId String  @db.Uuid
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

// Durable record of a whole-project git operation: the cross-instance lock + progress + audit source.
model GitOperation {
  id            String            @id @default(uuid()) @db.Uuid
  projectId     String            @db.Uuid
  kind          GitOperationKind
  state         GitOperationState @default(QUEUED)
  branch        String?
  triggeredByUserId String        @db.Uuid
  progress      Int               @default(0) // 0..100
  heartbeatAt   DateTime?         // worker liveness; a stale heartbeat on a non-terminal op → swept to FAILED (D4)
  errorCode     String?           // typed domain error code (safe, no internals)
  startedAt     DateTime?
  finishedAt    DateTime?
  createdAt     DateTime          @default(now())

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId])
  // "One active op per project" (single-flight + write-lock, D4) is enforced by a PARTIAL UNIQUE
  // index on projectId WHERE state IN (QUEUED, RUNNING, AWAITING_CONFLICT). Workers claim the next
  // QUEUED row with SELECT … FOR UPDATE SKIP LOCKED (no queue library, no advisory locks — D3/D4).
}

// A conflicted file awaiting resolution during a PULL/SWITCH (FR-019/020).
model GitConflict {
  id            String   @id @default(uuid()) @db.Uuid
  operationId   String   @db.Uuid
  path          String
  // stage blobs materialized to temp storage; content fetched on demand for the merge view
  isBinary      Boolean  @default(false)
  resolved      Boolean  @default(false)
  resolution    String?  // 'ours' | 'theirs' | 'merged'
  createdAt     DateTime @default(now())

  operation GitOperation @relation(fields: [operationId], references: [id], onDelete: Cascade)

  @@index([operationId])
}
```

> `GitConflict` needs a relation back-reference added to `GitOperation` (`conflicts GitConflict[]`).
> `GitCredential` and `GitOperation` need back-relations on `Project`.

## 3. Non-persistent / derived model — file git status

**Not a table by default.** Per-file status (FR-025–027) is computed by the worker from `git status`
(and index state) and delivered as a **projection** keyed by `FileNode.id`:

```
FileGitStatus = 'unchanged' | 'modified' | 'staged' | 'untracked' | 'removed' | 'conflicted'
FolderGitStatus = rolled-up worst-of-descendants (FR-026)
```

- Served to the web tree as a `Record<fileNodeId, FileGitStatus>` map, mirroring the `presenceByFile`
  prop already threaded through `file-tree-node.tsx`.
- Refreshed after each git op and on document writeback/tree mutation (FR-027); cached on the
  `GitOperation`/connection or a short-lived in-memory/Redis-free store keyed by project+head. A
  materialized `GitFileStatusSnapshot` table is an optional optimization, not required for MVP.

## 4. Domain entities (packages/domain/src/entities)

- **`GitRepository`** (exists, `entities/git-repository.ts`) — extend with `syncStatus`,
  `defaultBranch`, `lastKnownRemoteHead`.
- **`GitCredential`** — value object wrapping the encrypted token reference; the plaintext token is a
  transient input, never stored on the entity.
- **`GitOperation`** — entity with `kind`, `state`, transitions (below), `progress`.
- **`GitConflict`** / **`ConflictResolution`** — VO for a conflicting file and its chosen resolution.
- **`PendingChange`** — VO: `{ path, changeType: 'added'|'modified'|'removed'|'renamed'|'copied', staged: boolean }` (FR-011/011a/011b; `renamed` covers moves — canonical label "renamed/moved").
- **`Branch`**, **`Commit`** (VOs) — `{ name, isCurrent }`, `{ hash, message, authorUserId?, authoredAt }`.
- All fallible operations return `Result<T, E>` with typed domain errors (below).

### GitOperation state transitions

```
QUEUED ──▶ RUNNING ──▶ SUCCEEDED
             │  └────▶ AWAITING_CONFLICT ──▶ RUNNING (on resolve) ──▶ SUCCEEDED
             ├───────▶ FAILED      (typed error; project restored to pre-op state — FR-010)
             └───────▶ ABORTED     (user cancel / live-flush failure — FR-030)
```

## 5. New domain ports (packages/domain/src/ports)

Grouped under a new `ports/git/` area (+ mirrored in-memory fakes in `tests/ports/git/`):

| Port | Responsibility | Notes |
|---|---|---|
| `GitRepositoryRepository` | CRUD `GitRepository` | **Exists** (`ports/project/git-repository.repository.ts`) — reuse. |
| `GitCredentialStore` | save/get/delete encrypted token by projectId | New; impl uses `SessionEncryption` + Prisma. |
| `GitOperationRepository` | persist/query `GitOperation` + conflicts; `enqueue`, `claimNextQueued` (SKIP LOCKED; reclaims stale-heartbeat ops in the same call), `heartbeat`, and `withGuard(projectId, fn)` for short mutating ops | New. Doubles as the work-list + single-flight guard (D3/D4); mutating short ops (stage/commit/discard/amend) call `withGuard` (fast conditional insert against the partial-unique index) so they respect single-flight without a long-lived row. No separate queue/lock port. |
| `GitCommandRunner` | run a scoped git operation in the sandbox (clone/commit/push/pull/branch/merge/status/diff/history) | New; impl runs `git` via `execFile` in `apps/git-worker`. |
| `CollaborativeContentWriter` | `replaceContent(projectId, yjsStateId, content)` — reconciles live `Y.Text` to `content` via a **minimal diff** in one transaction | New (D6, S2); impl extends `HttpCollaborativeContentEditor`. |
| `CollaborativeContentReader` | read live doc text | **Exists** (`ports/storage/collaborative-content-reader.ts`) — reuse. |
| `ProjectFileStore` / `YjsStateStore` | filesystem projection + blobs | **Exist** — reuse (`.git` lives beside `.collab/`). |

**Boundary rule (no infrastructure type leak):** every `GitCommandRunner` output — commits, diffs,
conflict stages, file status, branch lists — crosses the port as a **`packages/shared` DTO** returned
inside `Result<T, E>`. Git-library types (e.g. `simple-git`) MUST stay inside the infrastructure adapter
and never appear in domain or in a port signature.

**Credential boundary:** `GitCredentialStore` returns the *decrypted* token only to the git-worker's
in-memory runner at execution time; it is never returned to a route/client, logged, or written to the
working tree/`.git/config`/argv (Security Constitution 1.3.0). The client-facing shape exposes only
`tokenHint`.

## 6. Use cases (packages/domain/src/use-cases/git)

One use case per deliverable (one `/tdd` invocation each): `ConnectRepository`, `ImportRepository`
(clone → new project, mirrors `CloneProjectUseCase` all-or-nothing + owner-member-last commit point),
`InitializeRepository`, `DisconnectRepository`, `GetGitStatus`, `StageChanges`/`UnstageChanges`,
`CommitChanges` (live-aware capture, D7), `PushChanges`, `PullChanges` (flush open docs first D14, land
via D6 minimal-diff + conflict detection), `CreateBranch`, `SwitchBranch` (flush-first, D14),
`ResolveConflicts`, `DiscardChanges`, `AmendCommit`, `UndoPull`, `GetHistory`, `GetDiff`,
`GetBehindAhead`.

## 7. Validation & typed errors (partial)

- Refs/paths/remote URLs validated at the Fastify boundary (schema) **and** in the runner before
  reaching `git` (FR/security: argument-injection defense).
- Typed domain errors (safe, no internals — Security Constitution): `RepositoryUnreachableError`,
  `AuthenticationFailedError`, `NonFastForwardError`, `MergeConflictError`, `LiveContentUnavailableError`
  (reused), `GitOperationInProgressError`, `InsufficientRoleError`, `NothingStagedError`,
  `EmptyCommitMessageError`, `RemoteAlreadyInitializedError`, `RemoteHistoryRewrittenError`.

## 8. Authorization matrix (FR-021)

| Action | VIEWER | EDITOR | OWNER |
|---|---|---|---|
| View git status / history / diff | ✅ | ✅ | ✅ |
| Commit / push / pull / branch / switch / resolve / discard / stage | ❌ | ✅ | ✅ |
| Connect / import-into-new-project* / initialize / disconnect / set-rotate credential | ❌ | ❌ | ✅ |

\* Import creates a **new** project owned by the importing user (that user becomes its OWNER).
