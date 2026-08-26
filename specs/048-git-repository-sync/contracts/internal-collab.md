# Contract: New collab internal endpoint + git-worker job

**Feature**: `048-git-repository-sync`

## 1. `POST /internal/collab/apply-full-content` (apps/collab internal-edit-server)

New sibling to the existing `read-content` / `apply-edits` / `apply-structured-replacement` endpoints
(`apps/collab/src/internal-edit-server.ts`). Same transport and security: loopback by default, optional
shared-secret header `x-collab-internal-secret` (constant-time compare), optional mTLS; `MAX_BODY_BYTES`
cap (raise for large docs as needed).

- **Request** (POST JSON): `{ projectId: uuid, yjsStateId: uuid, content: string }`
- **Behavior**: opens a direct server-side connection to the room and reconciles the `"codemirror"`
  `Y.Text` to `content` by applying the **minimal diff** (computed against current live text) in a
  **single Yjs transaction** — NOT delete-all + insert, so cursors/selections/undo are preserved and the
  delta stays small (S2). Forces writeback of both the Yjs blob and the materialized file. Idempotent for
  identical `content` (empty diff → no-op).
- **Response**: `{ applied: boolean }` (`false` only if the room could not be opened).
- **Caller**: new domain port `CollaborativeContentWriter.replaceContent(projectId, yjsStateId, content)`,
  implemented by extending `HttpCollaborativeContentEditor`
  (`packages/infrastructure/src/services/http-collaborative-content-editor.ts`) and wired in
  `apps/api/src/di/stores.ts` / the git-worker composition root using `collab.editUrl` + `collab.editSecret`
  + `collab.editTls`.

Used when a PULL/CHECKOUT/UNDO lands new content into a document that currently has an **active
session** (FR-006/007). For dormant docs the worker writes the file-store projection directly and the
next room open re-seeds from it.

## 2. Git-worker job model (no queue library)

Work list = the `GitOperation` table. Producer: `apps/api` git routes insert a `QUEUED` row (long ops).
Consumers: `apps/git-worker` pool. **Short ops** skip the table and are a direct internal-HTTP
request/response to a worker (same transport as §1), split by whether they touch the repo:
- **Read-only short ops** (status, diff, branch-list, history) are **lock-free**. While a content-changing
  op holds the single-flight guard for that project, they are served from **last-known status** (the
  projection / cached snapshot) instead of shelling to `git`, to avoid colliding with the in-flight
  operation (D15).
- **Mutating short ops** (stage, unstage, commit-without-push, discard, amend) still **acquire the
  single-flight guard** for the project (§ below) before touching the working tree/index — even though
  they create no long-lived `GitOperation` row. If a content-changing op is active they return
  `409 GitOperationInProgressError`. This keeps FR-009 ("one git operation per project at a time") true
  across *both* transports.

- **Row payload**: `GitOperation { operationId, projectId, kind, state, triggeredByUserId, params, ... }`
  (`params` per kind: e.g. import → `{ remoteUrl, credentialRef, branch }`; commit → `{ message, stagedPaths }`;
  checkout → `{ name, stashLocal }`).
- **Single-flight (D4)**: a PARTIAL UNIQUE index on `projectId WHERE state IN (QUEUED, RUNNING,
  AWAITING_CONFLICT)` guarantees at most one active op per project (also the write-lock). No advisory
  locks, no queue-library singleton. **Every mutating op — long (table-dispatched) OR short (RPC:
  stage/unstage/commit/discard/amend) — MUST hold this guard before touching the working tree/index**;
  a short mutating op inserts a short-lived `GitOperation` row (or a fast conditional insert against the
  same partial-unique index) so it is refused when a content-changing op is active. Read-only ops never
  take the guard.
- **Claim**: a worker picks the next job with `SELECT … FOR UPDATE SKIP LOCKED` over `QUEUED` rows (the
  only raw SQL in the feature; behind `GitOperationRepository.claimNextQueued`), then sets `RUNNING` and
  begins writing `heartbeatAt`.
- **Worker responsibilities per job**:
  1. Claim + mark `RUNNING`; start heartbeat.
  2. **Flush first (D14)**: for pull/checkout/undo, flush every affected open document's live text into
     the working tree before running git, so the merge sees true current content and live edits aren't lost.
  3. For content **capture** (commit/push): read live text for docs with an active `CollaborationSession`
     via `CollaborativeContentReader`; abort on live-read failure (FR-030).
  4. Run `git` (`execFile`, array args, `--end-of-options`; cross-host redirects disabled — S5) in the
     project's `<storageRoot>/<projectId>/` working tree, workspace cleaned before the job; `.collab/` and
     internal paths git-ignored (D10). Credential supplied out-of-band (askpass/env, never argv/URL/
     config/logs — D5).
  5. For content **landing** (pull/checkout/undo): for each changed file, call
     `CollaborativeContentWriter.replaceContent` (minimal diff) if a session is active, else write the
     file-store projection; reconcile `FileNode`/`Document` rows (creates/renames/deletes) in a DB
     transaction. Git-sourced renames are applied as-is — no AsciiDoc reference rewrite (FR-015a).
  6. On conflicts: persist `GitConflict` rows, set `AWAITING_CONFLICT`, stop (client resolves, then
     `pull/complete` enqueues a continue-merge op).
  7. On success/failure: update `GitRepository.lastSyncAt`/`syncStatus`, write `AuditLog`, set terminal
     state + `progress = 100`; on failure restore pre-op state (FR-010). The active row moving to a
     terminal state releases the single-flight/write-lock.
- **Crash recovery (D4)**: no separate scheduler. A worker reclaims stale ops **opportunistically at
  claim time** — `claimNextQueued` first fails any non-terminal op whose `heartbeatAt` is older than the
  timeout (dead worker) and clears its guard, then claims. A lightweight periodic tick is optional; the
  claim-path check alone guarantees a dead worker never permanently wedges a project.
- **Egress (D8)**: worker network denies all but `git.egress.allowedHosts`, enforced at the network layer.
- **Progress**: worker updates `GitOperation.progress`; the API `operations/:opId` endpoint reads it.
