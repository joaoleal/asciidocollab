# Quickstart: Git Repository Synchronization

**Feature**: `048-git-repository-sync` | [spec.md](./spec.md) · [plan.md](./plan.md)

How to exercise the feature end-to-end once implemented, and the smoke path for each user story.

## Prerequisites

- Postgres running (Prisma; includes the `GitOperation` work-list table). Storage volume mounted, shared
  by `apps/api`, `apps/collab`, and `apps/git-worker` (verify via the storage-probe route).
- New config set: `git.credentialEncryptionKey` (base64 32-byte), `git.egress.allowedHosts`
  (e.g. `github.com`), `git.workerPoolSize`, `git.rateLimitMax/Window`. See `apps/api/src/config/schema-git.ts`.
- `apps/git-worker` running (git + git-lfs in image); collab internal-edit server reachable
  (`collab.editUrl` + secret/mTLS).
- A test remote you control (empty repo for init; a seeded repo for import) and a token.

## Smoke paths (by user story)

**P1 — Import (fresh clone → new project)**
1. `POST /git/import { provider, remoteUrl, token }` → `202 { operationId, projectId }`.
2. Poll `GET /git/operations/:opId` until `SUCCEEDED`.
3. Open the new project → file tree matches the remote's default branch; open a file → editable.

**P2 — Commit & push (live-aware)**
1. In a connected project, open a document and type (do not wait for writeback).
2. `POST /git/stage { paths }`, then `POST /git/commit { message }` → committed content equals the
   live edit (not stale disk). `POST /git/push` → remote receives it.
3. Empty message or nothing staged → rejected (FR-011b).

**P3 — Pull into a live doc**
1. Push a change to an open file from outside; keep it open in the editor.
2. `POST /git/pull` → if it touches open files, `409` until `{ confirmAffectsOpenFiles: true }`.
3. Confirmed pull → all connected editors see the new content; it is not reverted by save-back.

**P4 — Branches**
1. `POST /git/branches { name }`; `POST /git/checkout { name }` → tree/current-branch update; open
   editors reflect the target branch.

**P5 — Conflicts**
1. Change the same lines locally and on the remote; `POST /git/pull` → `AWAITING_CONFLICT`.
2. `GET /git/conflicts` + `/conflicts/:path` (base/ours/theirs) → resolve per file
   (`ours`/`theirs`/`merged`) → `POST /git/pull/complete` → resolving commit; state normal.

**P6 — Initialize on an existing project**
1. On a non-git project with an empty remote: `POST /git/initialize` → remote gets an initial commit;
   project shows connected.

## File-tree indicators (FR-025–028)
- `GET /git/tree-status` returns `statusByFileNodeId`; the web tree renders a badge per node
  (added/changed/untracked/removed/conflicted) next to the presence marker, with folder roll-up.
- `.git/` and `.collab/` never appear as nodes; `.gitignore` does and is editable.

## Test strategy (Constitution II/III)
- Domain use cases: unit tests with **in-memory fakes** of every new port (`tests/ports/git/`).
- Infrastructure adapters: integration tests — Prisma via testcontainers; `GitCommandRunner` against a
  temp bare remote + temp working tree; `SessionEncryption`-backed credential store round-trip.
- Collab `apply-full-content`: integration test proving a live room's `Y.Text` is replaced and written
  back, and that an open editor is not reverted.
- E2E (Playwright): the six smoke paths above.
- Security: argument-injection tests (malicious ref/path/remote rejected); egress-allowlist test;
  path-traversal into `.git`/`.collab` rejected; token never present in logs/responses.
