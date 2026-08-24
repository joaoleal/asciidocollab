# Phase 1 Data Model: Project Cloning

**Feature**: 047-project-clone | **Date**: 2026-08-22

The feature adds **no new persistent entity and no schema migration**. It defines a copy mapping over
existing entities, one new domain port, and the DTOs crossing the API boundary.

---

## 1. Copy mapping

For a clone of source project `S` by actor `A` under name `N`. Read the table as: what the new
project's rows contain, and where each value comes from.

### Project

| Field | Value in clone | Source |
|---|---|---|
| `id` | fresh UUID | generated |
| `name` | `N` | user input, via `ProjectName.create` |
| `description`, `tags`, `language` | copied verbatim | `S` |
| `mainFileNodeId` | **remapped** — the copy of `S.mainFile`, looked up through the identity map built while the tree was written (not by matching paths); written as a *separate update* after the file nodes exist (see §6, steps 4 and 7), because the column is an FK to `FileNode` and cannot be set on the initial row | derived |
| `archivedAt` | `null` | FR-015, never copied |
| `createdAt`, `updatedAt` | now | generated |

### ProjectMember

Exactly one row: `(cloneId, A, OWNER)`. **Written last** — it is the commit point that makes the
project visible (research R1). No row from `S` is copied (FR-006).

### FileNode

One row per node in `S`, in parent-before-child order so `parentId` always resolves.

| Field | Value in clone |
|---|---|
| `id` | fresh UUID |
| `projectId` | clone id |
| `parentId` | the clone's node corresponding to `S`'s parent, or `null` for the root |
| `name`, `type`, `path` | copied verbatim — **`path` is what makes FR-012 hold** |

The clone's root folder is the copy of `S`'s root, whose `name` in `S` was `S.name`. It keeps `path`
`/`; its `name` is set to `N` so the tree root reads as the new project (matching
`CreateProjectUseCase`, which names the root after the project).

**Identity map**: the use case carries `sourceFileNodeId → cloneFileNodeId` for the whole run. It is
what remaps `parentId`, `mainFileNodeId`, and the asset rows.

### Document (text files)

One row per source file node that **has** a document.

| Field | Value in clone |
|---|---|
| `id`, `contentId`, `yjsStateId` | **fresh UUIDs** — never reused (research R3) |
| `fileNodeId` | the clone's node |
| `mimeType` | copied verbatim |

No Yjs state is persisted. The room bootstraps from the copied file bytes on first open.

### Asset (binary files)

One row per source file node that has **no** document. `id` = the clone's file node id (the 1:1 FK),
`mimeType` copied, `sizeBytes` = the length of the bytes actually written.

### File bytes (`ProjectFileStore`)

One write per file node of type `FILE`, at the same path under the clone's sandbox:

- **has a document** → content resolved through the shared resolver with `onLiveReadError: 'fail'`
  (research R2): live Yjs text when a session is active, stored bytes otherwise, **abort** on a
  failed live read.
- **no document** → raw bytes read from `S`'s store and written verbatim.

Folders are created via `createDirectory`.

### ProjectRenderConfig

Zero or one row. If `S` has one, the clone gets a new row with the same `config` JSON verbatim. If
`S` has none, the clone gets none — an absent row means "project defaults", and materializing one
would freeze today's defaults into the clone.

### ProjectDictionaryTerm

One row per source term: same `term`, `createdByUserId` = `A` (the source author may not be a member
of the clone), fresh id.

### AuditLog

Three entries, none copied from `S`:

| Project | Action | When | Meaning |
|---|---|---|---|
| clone | `project.cloned` | success | the clone was created; metadata names the source project id |
| `S` | `project.clone_requested` | success | `S`'s content was read by `A` (FR-026) |
| `S` | `authz.denied` | refusal | a non-member tried to clone `S`; actor, resource and reason (FR-026a) |

The first two use the existing `AUDIT_*` constants pattern in
`packages/domain/src/audit-actions.ts`. The third is **not** hand-rolled: it goes through
`recordAuthorizationDenial` (`packages/domain/src/use-cases/audit-recording.ts:114`), the shared
helper the other ~dozen authorization boundaries already use, which is best-effort by design so a
failed denial record can never turn a clean 403 into a 500.

### Deliberately absent from the clone

`ProjectMember` (beyond the owner), `ReviewComment`, `ReviewReaction`, `CollaborationSession`,
`IgnoredLint`, `GitRepository`, `Template`, persisted Yjs state, and `S`'s audit history.
FR-016 – FR-021.

**Review tasks are not a separate entity.** FR-017 states them separately from comments, but the schema
has no `ReviewTask` model: a task is a `ReviewComment` with `kind: TASK`
(`packages/db/prisma/schema.prisma:31-34, 398-402`). Excluding `ReviewComment` therefore excludes both
kinds — and any test claiming to prove FR-017 MUST assert across both `ReviewItemKind` values, or it
passes without checking anything.

---

## 2. New domain port

### `ActiveCloneRegistry` (`packages/domain/src/ports/project/active-clone-registry.ts`)

```
tryAcquire(userId: UserId): boolean   // false when that user already has a clone running
release(userId: UserId): void         // idempotent
```

Enforces FR-027. Infrastructure supplies an in-memory implementation; per the architecture
constitution it also needs an in-memory fake under `packages/domain/tests/ports/project/`.

**Contract the fake must honour**: `tryAcquire` is atomic per user; a second `tryAcquire` for the
same user returns `false` until `release`; `release` for a user who holds nothing is a no-op; users
are independent.

---

## 3. Changed domain signature

`resolveDownloadContentSource` gains a policy parameter and a third result variant:

```
type ContentSource =
  | { kind: 'inline'; bytes: Buffer }
  | { kind: 'stored' }
  | { kind: 'unavailable'; fileNode: FileNode }   // only when policy is 'fail'
```

Download passes `'fallback'` and can never observe `'unavailable'` — its behaviour is unchanged.
Clone passes `'fail'` and aborts on `'unavailable'`, naming `fileNode.path` in the error.

---

## 4. DTOs (`packages/shared/src/dtos/`)

```
CloneProjectDto  { name: string }
```

The response body is the existing `ProjectDto`
(`packages/shared/src/dtos/project-management.dto.ts:52`) — no new result DTO. Reusing it lets the
dashboard insert the new card without a second round-trip (FR-025), but only if the route emits
**every** field the list route emits, including the ones `ProjectDto` marks optional and the card
renders: `owners`, `rootFolderId`, `mainFileNodeId`, `memberCount`, `fileCount` and `role`. The API
contract pins the exact body; a narrower shape renders a card with blank counts. The route therefore
describes the project as the database now returns it rather than as the entity it just built in
memory — the two differ on `rootFolderId`, which has no column and so reads back as `null` for every
project, and describing the entity would put a value in the response that the next refresh
contradicts.

---

## 5. Domain errors (`packages/domain/src/errors/project/`)

| Error | Meaning | Maps to |
|---|---|---|
| `CloneAlreadyInProgressError` | the actor already has a clone running (FR-027) | 409 |
| `LiveContentUnavailableError(path)` | a document's live content could not be read (FR-009a) | 503 |
| `CloneFailedError(cause)` | anything else failed; cleanup has already run (FR-024) | 500 |

Existing `PermissionDeniedError` covers the non-member case, and `InvalidProjectNameError` covers
name validation — neither is re-invented.

---

## 6. Ordering constraint

The sequence is not incidental; FR-023/FR-024 depend on it.

1. `tryAcquire` — refuse early if the actor already has a clone running.
2. Authorize: `A` is a member of `S`. Non-member and non-existent are indistinguishable (FR-002).
   On refusal, record the `authz.denied` entry before returning (FR-026a). It is scoped to `S` only
   when `S` exists: `AuditLog.projectId` is a foreign key, so naming a project that is not there
   makes the insert fail, and audit writes are best-effort — the refusal most worth recording, an id
   being probed, would be the one silently lost. The id asked for is recorded as the resource either
   way.
3. Validate `N`.
4. Create the project row (still memberless, therefore invisible).
5. Copy file nodes parent-first, building the identity map.
6. Per file: resolve content, write bytes, create the `Document` or `Asset` row.
7. Remap and set the main file; copy render config and dictionary terms.
8. **Write the owner `ProjectMember` row.** ← the project becomes visible here.
9. Write the audit entries.
10. `release`, in a `finally` that also covers every failure path.

Any failure in 4–8 triggers cleanup before the error is returned: delete the project row (which
cascades to file nodes, documents, assets, render config and dictionary terms) and call
`ProjectFileStore.removeProject`. Step 4 is inside that range, not before it: an insert that commits
and then loses its acknowledgement leaves exactly the residue the cleanup exists to remove. A throw
anywhere in 4–8 becomes a returned `CloneFailedError` rather than escaping, because only a returned
refusal runs the cleanup.

**Step 9 is deliberately after the commit point** — the only thing that is. Both entries are
best-effort and neither can strand anything, whereas writing them before step 8 meant an abandoned
copy left a `project.cloned` entry behind: the cleanup deleted the project row, the audit row
outlived it with its project reference nulled (the foreign key is `ON DELETE SET NULL`), and the
governance trail then described a copy no user ever received.

`YjsStateStore.deleteAllForProject` is **deliberately not part of this cleanup**, unlike
`DeleteProjectUseCase`'s: a clone never persists Yjs state (research R3), so there is nothing for it
to remove. Adding it would imply the clone writes state it does not write.
