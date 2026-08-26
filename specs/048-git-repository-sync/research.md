# Phase 0 Research: Git Repository Synchronization

**Feature**: `048-git-repository-sync` | **Date**: 2026-08-24 | [spec.md](./spec.md)

All open decisions from the spec's Clarifications plus the technical unknowns surfaced while
drafting the plan are resolved below. Each entry: **Decision / Rationale / Alternatives considered**.

---

## D1. Git engine — system `git` binary

- **Decision**: Drive the real `git` program via `execFile` (array-arg form; no shell), wrapped by a
  thin `simple-git`-style adapter, running inside the sandbox worker (see D2).
- **Rationale**: Only the CLI provides a real recursive 3-way merge with conflict staging, conflict
  markers, and `merge --continue/--abort` — required by the chosen inline-3-way conflict UX
  (FR-019). Best large-repo performance and best-maintained of all options. Its one real weakness —
  argument injection — is mitigated in code (array args, `--end-of-options`/`--` separators, strict
  validation of every ref/path/remote) and contained by the sandbox.
- **Alternatives considered**: **isomorphic-git** (pure JS) — rejected: no recursive merge strategy,
  no abort/continue, slower on large repos (would force a weaker conflict UX than chosen).
  **nodegit** (libgit2) — rejected: effectively unmaintained (no stable release in >12 months),
  Node 24 ABI/prebuild fragility in containers, no capability advantage over the CLI. **wasm-git** —
  browser-oriented, no server benefit.

## D2. Compute topology — bounded warm git-worker pool (the worker *is* the sandbox)

- **Decision**: A **bounded, autoscaling pool of long-lived git-worker containers** (new app
  `apps/git-worker`), sized to load — not to project count — each consuming a shared job queue (D3).
  A worker runs `git` via `execFile` **inside itself**; each job operates on one project's directory,
  in a clean workspace, and the worker cleans/`git`-resets between jobs. No docker-in-docker and no
  container spawned per operation.
- **Rationale**: Reconciles the three rejected shapes from clarification — per-project containers
  (sprawl), per-op containers (~0.5 s startup tax on every status/commit), and pure-JS (capability).
  Repository state (the `.git` dir + working tree) persists per project on the shared storage volume;
  only compute is pooled and warm. Mirrors the CI-runner model.
- **Reconciliation required** (see D11): this reframes the Architecture Constitution's "Docker
  container **per git operation**" into a per-job-scoped **shared worker pool**, and honors "no git
  on the host" (git runs only inside worker containers, never the API host).
- **Alternatives considered**: dockerode spawning a fresh container per op (rejected: latency +
  greenfield container-management code for no isolation gain over a clean per-job workspace); running
  git in the API process (rejected: violates "no git on the host", blocks Fastify workers for
  minutes).

## D3. Job dispatch — a polled `GitOperation` work-list table (no queue library)

- **Decision**: No external queue/broker. **Short** git ops (status, diff, stage/unstage, branch list,
  commit-without-push) are handled by a **direct internal-HTTP call** to a git-worker, reusing the
  collab internal-server transport pattern (shared-secret / mTLS) that already exists. **Long**,
  network-bound ops (import/clone, pull, push) are dispatched via the **`GitOperation` table**: the API
  inserts a `QUEUED` row and returns `202`; git-workers poll and claim the next row with a single
  `SELECT … FOR UPDATE SKIP LOCKED` (the canonical safe-claim), run it, and update `state`/`progress`
  on the same row. **Mutating** short ops (stage/unstage/commit/discard/amend) still acquire the
  per-project single-flight guard (D4) before touching the working tree/index — they are refused (`409`)
  while a content-changing op holds it — so FR-009 holds across both transports. **Read-only** short ops
  are lock-free and, during a running content-changing op, are served from last-known status (D15)
  rather than shelling to `git`.
- **Rationale**: The workload is a handful of **human-triggered** git ops per project — nowhere near the
  volume that justifies a broker. The `GitOperation` row already exists for status/progress/the
  write-lock, so it doubles as the work list at zero extra machinery. This avoids introducing the repo's
  first async-framework dependency (see D-removed) and keeps the only raw SQL to one well-understood
  claim query, confined behind `GitOperationRepository.claimNextQueued`.
- **Alternatives considered**: **pg-boss** (rejected as over-engineered for this volume — a whole
  durable-queue framework and schema to schedule a few user-clicked operations; it also became the
  repo's first async framework, a decision bigger than this feature). **BullMQ** (rejected: needs Redis,
  not in the stack). **Synchronous in-request** like clone (rejected: ties up an API worker and the HTTP
  connection for a minutes-long op, and can't survive a restart).

## D4. Single-flight, write-lock & crash recovery — the `GitOperation` row is the single source of truth

- **Decision**: Enforce "one git operation per project at a time" (FR-009) and the content-changing
  **write-lock** (FR-031a) with a **partial unique constraint** on the `GitOperation` table (at most one
  row per `projectId` in a non-terminal state). The same row drives progress (FR-024) and the presence
  "git activity" signal (FR-031). The worker writes a `heartbeatAt`; **crash recovery needs no separate
  scheduler** — `claimNextQueued` first fails any non-terminal op whose heartbeat is stale (worker died)
  and clears its guard, then claims (an optional periodic tick is belt-and-suspenders). The single guard
  covers **all mutating ops** regardless of transport (long table-dispatched ops and short mutating RPCs
  alike, D3). No Postgres advisory locks and no queue-library singleton — one mechanism.
- **Rationale**: Git ops run in a separate worker and the API may be multi-instance, so the guard must be
  shared DB state — but a durable row with a uniqueness constraint already provides that, and a heartbeat
  sweep is a few lines versus reasoning about connection-scoped advisory-lock lifetimes held for minutes.
  The `SKIP LOCKED` claim (D3) also prevents two workers grabbing the same row.
- **Alternatives considered**: Postgres advisory locks (rejected: connection-scoped locks held for the
  whole op complicate lifecycle and add a second locking mechanism); `InMemoryActiveCloneRegistry`
  (rejected: process-local only).

## D5. Credential storage & encryption — reuse `SessionEncryption`, new key + store

- **Decision**: Encrypt the per-connection access token with the existing **AES-256-GCM
  `SessionEncryption`** primitive, instantiated with a **dedicated new key**
  `git.credentialEncryptionKey` (base64 32-byte, config + env, format-validated like
  `auth.session.encryptionKey`). Store the ciphertext in a new `GitCredential` store row; the existing
  dormant `GitRepository.credentialRef` points to it. The plaintext token never touches logs, the DB,
  the working tree, or the client.
- **Rationale**: The security constitution mandates AES-256 at rest; `SessionEncryption`
  (`iv:tag:ciphertext`, aes-256-gcm) is a clean, tested reusable primitive. A separate key isolates
  credential blast radius from session data. `credentialRef` is currently inert scaffolding — this
  wires it to a real store.
- **Execution-time handling (Security Constitution 1.3.0)**: the worker decrypts the token only into
  memory for the duration of a job and supplies it to `git` **out-of-band** — via an ephemeral
  credential helper / `GIT_ASKPASS` script or environment, **never** as a process argument, in the
  remote URL, in `.git/config`, in the working tree, or in any log. The token is scrubbed from memory
  after the job. `tokenHint` (last 4 chars) is the only credential-derived value ever returned to a
  client.
- **Alternatives considered**: store token on `GitRepository` directly (rejected: mixes secret with
  metadata, harder to rotate/redact); external KMS (rejected: no KMS in stack, over-scoped for now).

## D6. Landing pulled/merged content into live Yjs documents — new "replace full content" apply mode

- **Decision**: Add a **new collab internal endpoint** `POST /internal/collab/apply-full-content`
  `{ projectId, yjsStateId, content }` → `{ applied }` that reconciles the document's `Y.Text`
  ("codemirror") to `content` by applying the **minimal set of edits** (a text diff between the current
  live text and `content`) in a **single Yjs transaction** — NOT a delete-all + re-insert (S2). This
  forces writeback of both the Yjs blob and the materialized file. Expose it via a new domain port method
  `CollaborativeContentWriter.replaceContent(projectId, yjsStateId, content)`, implemented on the
  existing `HttpCollaborativeContentEditor` transport (shared-secret + optional mTLS, reused verbatim).
- **Rationale**: The current apply model is literal find/replace only; a pull/merge produces a whole new
  file body that must reach open editors (FR-006) and survive save-back (FR-007) — writing the file on
  disk is not enough (the open room ignores disk and would overwrite it on next writeback). Applying a
  **minimal diff** (rather than replacing the whole text) preserves collaborators' cursors, selections,
  and undo history and keeps the CRDT delta small — important for Principle VIII (editor integrity) and
  XIII (responsiveness). The diff is trivial to compute with the same JS diff lib used to render diffs.
  `CollaborativeContentReader` (already present) is reused unchanged to read live text (for the diff base
  here and for commit capture in D7).
- **Alternatives considered**: whole-`Y.Text` delete-all + insert (rejected, S2: destroys cursors/undo,
  huge deltas); write file on disk and let writeback pick it up (rejected: race + the room ignores disk
  while a session is live).

## D7. Live-aware content capture for commit/push — reuse the download/clone resolver

- **Decision**: When staging/committing, read each active document's **live** content via
  `CollaborativeContentReader` (fall back to the file-store projection for dormant docs), reusing the
  same `resolveDownloadContentSource(..., 'fail')` pattern the clone/download paths already use. If a
  live read fails for an actively edited doc, **abort the commit** (FR-030) rather than commit stale
  bytes.
- **Rationale**: FR-005 requires commits reflect the latest live edits. This exact problem is already
  solved for download/clone; reuse it rather than re-derive.
- **Alternatives considered**: read the disk projection directly (rejected: lags live edits by the
  writeback debounce — would publish stale content).

## D8. Network egress control — deny-by-default, allowlist enforced at the network layer

- **Decision**: Git-worker containers run with **egress denied by default**; only the host(s) of the
  connection's configured `remoteUrl` (and the provider's known git endpoints) are reachable. The
  allowlist is enforced at the **network layer** (network policy / egress proxy) — **not** by URL-string
  validation alone. Additionally, git is configured to **not follow cross-host redirects**
  (`http.followRedirects` restricted), and the remote host is validated against the provider allowlist at
  connect time (S5). Config: `git.egress.allowedHosts` (+ provider defaults).
- **Rationale**: Reconciles the Security Constitution's git-sandbox network rule with the unavoidable
  need to reach a remote while closing redirect-based and DNS-rebinding SSRF (a malicious remote must not
  be able to bounce the worker to an internal host). Honors the Principle IX sandbox intent.
- **Alternatives considered**: URL-string allowlist only (rejected, S5: bypassable via redirect/DNS);
  unrestricted worker egress (rejected: SSRF/exfiltration surface); literal "no network" (rejected:
  impossible for sync).

## D9. Diff & merge presentation — client-side

- **Decision**: Conflict resolution and diff views render **client-side** in `apps/web`. The worker
  supplies base/ours/theirs text (from git's index stages) and unified diffs (`git diff`
  machine-readable); the browser renders them with a JS diff/merge view (jsdiff-family, bundled — no
  external host). The resolved text is sent back and applied by the worker (`git` writes the
  resolution, stages, and continues the merge).
- **Rationale**: Honors Principle X (no server-side rendering of document content) and Principle XIII
  (responsiveness); keeps AsciiDoc content on the client for display.
- **Alternatives considered**: server-rendered diffs (rejected: Principle X).

## D10. Ignored / hidden internal metadata

- **Decision**: A managed `.gitignore` guarantees `.collab/`, `.git/`-internal probes, and other
  platform artifacts are never tracked (FR-008); the worker never stages them. The **file-tree API and
  web tree filter out** `.git/` and `.collab/` entirely (FR-008a) — they are never surfaced as nodes
  and file-operation routes reject any path resolving into them. User-facing dotfiles
  (`.gitignore`, `.gitattributes`, `.github/`) remain normal editable files.
- **Rationale**: Directly from the `.git`-hidden clarification; reuses the existing path-traversal
  guard (`resolveSafe`) extended with an internal-prefix denylist.

## D11. Constitution reconciliation — RATIFIED via amendment

- **Decision**: The two **reference** constitutions are amended (their wording predated a real sync
  feature); the **governance** constitution is left untouched. (a) Architecture Constitution **2.6.0** —
  git runs only in sandboxed `apps/git-worker` containers, never a host process, served by a bounded
  warm pool with single-project-scoped, freshly-cleaned jobs; plus a narrow Data Access
  documented-justification exemption for the single `SELECT … FOR UPDATE SKIP LOCKED` job-claim query
  (confined behind `GitOperationRepository.claimNextQueued`). (b) Security Constitution **1.3.0** — Git
  Sandbox Security reframed to permit the warm pool with per-job scrub + no cross-project state,
  deny-by-default egress allowlisted to the configured remote, and out-of-band credential handling.
  (c) Governance Principle X — **NOT amended**. Git-sync egress is documented at feature scope as a
  user-consented, allowlisted publish (destination is a per-project user-configured remote; egress only
  on explicit user action), which satisfies Principle X's existing gate and is distinct from
  rendering/export egress. An AI unilaterally editing a non-negotiable was the wrong move; if the team
  wants the clarification in the constitution, they ratify it separately.
- **Rationale**: The reference-doc wording came from the dormant FR-011 scaffold and was impossible for
  real sync; the intent (isolation, minimal blast radius, no host git) is preserved and strengthened
  (per-job scrub, network-layer egress allowlist, credential-handling rule). Keeping the non-negotiable
  Principle X text unchanged and handling the egress reasoning at feature scope is the smaller, safer
  governance footprint.

## D12. Large binary assets (FR-041) — Git LFS in the worker image

- **Decision**: Include `git-lfs` in the worker image; assets over a configurable size threshold are
  handled as LFS objects. Non-text assets remain opaque bytes (no merge; choose-a-side on conflict).
- **Rationale**: Keeps large binaries usable without bloating pack history; LFS is the standard
  mechanism and needs no bespoke code.
- **Alternatives considered**: store large assets in-repo (rejected: repo bloat, slow clones).

## D13. Delivery phasing

- **Decision**: Ship by the spec's prioritized, independently-testable user stories: **P1 import →
  P2 commit/push → P3 pull → P4 branching → P5 conflicts → P6 init**, then the additive bundles
  (collaboration-aware safety, history/diff/discard, remote automation & extras). Each story is a
  runnable, testable slice per the constitution's phased-delivery rule.
- **Rationale**: This is a large feature; slicing by user story keeps every phase shippable and keeps
  the write-lock / live-apply machinery (needed from P1's import bootstrap onward) incrementally
  exercised.

## D14. Flush open documents before pull / branch switch (data-loss fix, S1)

- **Decision**: Before running a pull or branch switch, **flush every affected open document's live text
  into the working tree first** (the same flush used before a commit, D7). Only then does `git`
  merge/checkout run — so it operates on the true current content, live edits participate in the merge as
  ordinary local changes, and any genuine conflict surfaces through the normal conflict flow (D9). The
  write-lock (FR-031a) prevents new edits racing in after the flush. Uncommitted local changes that would
  be overwritten follow git's own rules — offered via stash (FR-042) or a clear block (FR-018).
- **Rationale**: The authoritative content of an open doc is the Yjs text, which runs ahead of the on-disk
  projection by the writeback debounce. Without the pre-flush, a pull would merge against **stale** disk
  content and then the landing step (D6) would clobber the un-flushed live edits — silent data loss.
  Flushing first is a one-line ordering rule that reuses existing machinery and closes the hole.
- **Alternatives considered**: warn-and-proceed without flushing (rejected: loses recent edits);
  three-way-merge the live Yjs state against git directly (rejected: overengineered — flushing lets git
  do the merge it's good at).

## D15. Status & diff consistency for actively-edited files (S3)

- **Decision**: File-tree status **badges** are served from the working-tree projection (refreshed on
  writeback, ≤ debounce) and are treated as **eventually-consistent** — acceptable for a badge, and
  documented as such. The two moments that must be exact do a **live read of the single file involved**:
  (a) capturing content for a **commit** (D7), and (b) opening the **diff or conflict view** for a
  specific file. No per-file live read is done on every tree-status poll.
- **Rationale**: Correctness where it matters (commit, explicit diff) without paying a live-read cost per
  file on every status refresh (FR-027 wants near-real-time badges). Reuses `CollaborativeContentReader`
  for the exact cases.
- **Alternatives considered**: live-read every file on every poll (rejected: expensive, defeats
  responsiveness); trust the projection everywhere (rejected: a commit/diff could show stale content).

---

## Resolved unknowns summary

| Unknown | Resolution |
|---|---|
| Git engine | System `git` CLI via `execFile` (D1) |
| Where git runs | Bounded warm worker pool, worker = sandbox (D2) |
| Async execution | Polled `GitOperation` work-list table + sync RPC; no queue library (D3) |
| Single-flight / write-lock / crash recovery | `GitOperation` unique active-op + heartbeat sweep (D4) |
| Credential secret at rest | `SessionEncryption` AES-256-GCM, dedicated key + `GitCredential` store (D5) |
| Land pulled content into live docs | New `apply-full-content` collab endpoint, **minimal diff** (D6) |
| Commit reads live content | Reuse download/clone live-content resolver (D7) |
| Egress | Deny-by-default, network-layer allowlist + no cross-host redirects (D8) |
| Diff/merge UI | Client-side rendering (D9) |
| Hide `.git`/`.collab` | Tree/API filter + managed `.gitignore` (D10) |
| Constitution tension | Reference-docs amended (arch 2.6.0, security 1.3.0); Principle X untouched (D11) |
| Large binaries | Git LFS in worker image (D12) |
| Pull/switch vs live edits | Flush open docs before pull/switch (D14) |
| Status/diff accuracy | Eventually-consistent badges; live read for commit + open diff (D15) |
