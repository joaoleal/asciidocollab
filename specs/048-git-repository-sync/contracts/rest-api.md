# Contract: Git Sync REST API (apps/api)

**Feature**: `048-git-repository-sync` | Fastify, schema-first validation, session auth, project-scoped.

Conventions: all routes are under an authenticated, project-membership-guarded prefix
`/projects/:projectId/git`. Authorization enforced **in the use case** (Security Constitution), not the
route. Mutating/expensive routes are **rate-limited** (configurable `git.rateLimitMax/Window`), and the
contract notes the `429`. Long-running operations return **202 + a `GitOperation` id** (the client
polls status or subscribes); they do not block the request. Typed domain errors map to safe HTTP codes
(no internals leaked).

## Connection lifecycle (OWNER)

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /projects/:projectId/git/connect` | `{ provider, remoteUrl, token, branch? }` | `200 { repository }` | 403 role, 401 auth-to-remote, 409 already-connected, 422 validation |
| `POST /projects/:projectId/git/initialize` | `{ provider, remoteUrl, token, branch? }` | `202 { operationId }` (initial commit+push) | 403, 409 remote-not-empty, 401, 429 |
| `POST /projects/:projectId/git/disconnect` | `{ }` | `200 { ok: true }` (files kept, credential deleted) | 403, 404 not-connected, 429 |
| `PUT  /projects/:projectId/git/credential` | `{ token }` | `200 { tokenHint }` | 403, 401, 429 |

## Import into a NEW project (any authenticated user → becomes OWNER)

| `POST /git/import` | `{ provider, remoteUrl, token, branch? }` | `202 { operationId, projectId }` | 401 auth, 409 import-already-in-progress, 422, 429 |

## Status, tree decoration, history, diff (VIEWER+)

| `GET /projects/:projectId/git/status` | — | `200 { branch, syncStatus, ahead, behind, lastSyncAt, staged[], unstaged[], untracked[], conflicted[] }` | 404 not-connected |
| `GET /projects/:projectId/git/tree-status` | — | `200 { statusByFileNodeId: Record<uuid, FileGitStatus> }` (drives FR-025–027) | 404 |
| `GET /projects/:projectId/git/history?path=&limit=` | — | `200 { commits: [{ hash, message, author, authoredAt }] }` | 404 |
| `GET /projects/:projectId/git/diff?path=&from=&to=` | — | `200 { unified }` (rendered client-side) | 404 |
| `GET /projects/:projectId/git/operations/:opId` | — | `200 { id, kind, state, progress, errorCode? }` | 404 |

## Staging & commit (EDITOR+)

These are **synchronous mutating short ops** — they run over the direct worker RPC, not the work-list,
but each **acquires the project single-flight guard** first and returns `409 GitOperationInProgressError`
if a content-changing op (import/pull/checkout) is active (see internal-collab.md §2).

| `POST /projects/:projectId/git/stage` | `{ paths[] }` | `200 { staged[] }` | 403, 409 op-in-progress |
| `POST /projects/:projectId/git/unstage` | `{ paths[] }` | `200 { staged[] }` | 403, 409 op-in-progress |
| `POST /projects/:projectId/git/commit` | `{ message }` (commits **staged only**; author = current user) | `200 { commit }` | 403, 409 op-in-progress, 409 nothing-staged, 422 empty-message, 409 live-flush-failed→abort |
| `POST /projects/:projectId/git/push` | `{ }` | `202 { operationId }` | 403, 409 non-fast-forward (pull first), 401 |
| `POST /projects/:projectId/git/discard` | `{ paths[] }` \| restore `{ path, commit }` | `200 { ok }` | 403, 409 op-in-progress |
| `POST /projects/:projectId/git/amend` | `{ message? }` (unpushed only) | `200 { commit }` | 403, 409 op-in-progress, 409 already-pushed |

## Pull, branches, conflicts, undo (EDITOR+)

| `POST /projects/:projectId/git/pull` | `{ confirmAffectsOpenFiles?: bool }` | `202 { operationId }` (may enter `AWAITING_CONFLICT`) | 403, 409 open-files-need-confirm, 401 |
| `GET  /projects/:projectId/git/branches` | — | `200 { current, branches[] }` | 404 |
| `POST /projects/:projectId/git/branches` | `{ name }` | `200 { branch }` | 403 |
| `POST /projects/:projectId/git/checkout` | `{ name, confirmAffectsOpenFiles?, stashLocal?: bool }` | `202 { operationId }` | 403, 409 uncommitted-changes |
| `GET  /projects/:projectId/git/conflicts` | — | `200 { operationId, files: [{ path, isBinary, resolved }] }` | 404 |
| `GET  /projects/:projectId/git/conflicts/:path` | — | `200 { base, ours, theirs }` (client renders 3-way) | 404 |
| `POST /projects/:projectId/git/conflicts/:path` | `{ resolution: 'ours'\|'theirs'\|'merged', mergedContent? }` | `200 { resolved: true }` | 403, 422 |
| `POST /projects/:projectId/git/pull/complete` | `{ }` (all conflicts resolved → resolving commit) | `202 { operationId }` | 409 unresolved-conflicts |
| `POST /projects/:projectId/git/undo-pull` | `{ }` | `202 { operationId }` | 403, 409 nothing-to-undo |

Notes:
- **Write-lock / single-flight (FR-009, FR-031a)**: while an IMPORT/PULL/CHECKOUT operation is `RUNNING`,
  (a) file-tree mutation routes and new edit sessions on affected files, and (b) the mutating git short
  ops (stage/unstage/commit/discard/amend), all return `409 GitOperationInProgressError`. Read-only git
  routes (`status`, `tree-status`, `history`, `diff`, `branches`) still succeed but are served from
  last-known status rather than shelling to `git` while the op holds the lock (D15).
- Every mutating action writes an `AuditLog` entry; every authz denial is logged (FR-022).
