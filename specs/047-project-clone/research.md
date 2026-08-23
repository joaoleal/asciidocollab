# Phase 0 Research: Project Cloning

**Feature**: 047-project-clone | **Date**: 2026-08-22

All Technical Context unknowns are resolved below. Each decision records what was chosen, why, and
what was rejected.

---

## R1. Atomicity without a unit-of-work abstraction

**Question**: FR-023/FR-024 demand that the clone be invisible until it succeeds and leave no trace
if it fails. The codebase has no transaction or unit-of-work port — every Prisma repository holds its
own client and saves independently (`packages/infrastructure/src/persistence/**`), and a clone also
writes to the filesystem (`ProjectFileStore`), which no database transaction can cover.

**Decision**: **Membership-last visibility, plus compensating cleanup.**

Every read path in the system authorizes on project *membership*, not on the project row:
`ListUserProjectsUseCase` → `ProjectRepository.findByMemberId` → `members: { some: { userId } }`
(`prisma-project.repository.ts:54`), and every project-scoped use case gates on
`projectMemberRepo.findByCompositeKey(...)` (e.g. `download-project.ts:66`). A project row with **no
`ProjectMember` rows is therefore invisible and inaccessible to every user, including its creator**.

So the clone builds everything — project row, file nodes, documents, assets, file bytes, settings,
dictionary — while the project has no members, then writes the single owner `ProjectMember` row as
the **last** step. That row is the commit point. On any failure before it, the use case deletes the
half-built project (`ProjectRepository.delete` cascades file nodes, documents, assets, render config
and dictionary terms per `schema.prisma`) and calls `ProjectFileStore.removeProject`, exactly as
`DeleteProjectUseCase` already does (`delete-project.ts:64-71`).

**Rationale**: it gives the required visibility semantics with no new architectural machinery, and it
is honest about the filesystem — a database transaction would have created a false sense of atomicity
while leaving orphaned bytes on disk.

**Alternatives rejected**:
- *Introduce a `UnitOfWork` port and `prisma.$transaction`* — a substantial cross-layer addition that
  still would not cover the file store, so the compensating cleanup would be needed anyway.
- *Create the project visibly and mark it "cloning"* — the spec explicitly rules out an intermediate
  state (FR-023), and it would leak partial projects into every listing on a crash.

**Residual risk**: a process crash between the last content write and the membership row leaves an
orphan project row with no members. It is invisible and harmless, but it accumulates. Mitigation is
out of scope here and recorded in the plan's Complexity Tracking.

---

## R2. Reading current content, failing closed

**Question**: FR-009 requires live in-flight content; FR-009a requires the clone to **fail** when a
live read fails, rather than substituting last-saved content.

**Decision**: **Generalize the existing download resolver rather than fork it.**

`resolveDownloadContentSource` (`packages/domain/src/use-cases/project/download-content-source.ts`)
already implements the exact resolution order the clone needs: no document → stored; no active
session → stored; live read succeeds → live bytes; live read errors → **warn and fall back**. Only
that last step differs.

The resolver gains an explicit policy parameter — `onLiveReadError: 'fallback' | 'fail'` — with a
third result variant for the failure case that names the file node. Download keeps `'fallback'`
(unchanged behaviour); clone passes `'fail'`. One resolver, one resolution order, one place to change
it.

**Rationale**: Principle IV (Reuse Before Rebuild) applied to a first-party asset. A forked resolver
is how the two paths would silently drift — and this repo already carries two content resolvers
(`download-content-source.ts` and `content/live-content.ts`), which is one more than it should.

**Alternatives rejected**:
- *A separate strict resolver for cloning* — guarantees drift the first time the resolution order
  changes.
- *Reuse `content/live-content.ts` instead* — it reads the file store itself and has no
  session-active short-circuit, so it would make a collab round-trip per dormant file.

**Note for tasks**: `content/live-content.ts` and `download-content-source.ts` should not both grow a
policy flag. Only `download-content-source.ts` is touched.

---

## R3. Yjs state is not copied

**Question**: a document has both file bytes and persisted Yjs CRDT state. Which does the clone
write?

**Decision**: **Write file bytes only. Give each cloned document a fresh `yjsStateId` and persist no
Yjs state for it.**

The collaboration server bootstraps a room from the file store when no state exists:
`onLoadDocument` loads persisted state if present, otherwise reads the file and seeds
`getText('codemirror')` from it (`apps/collab/src/extensions/persistence.ts:44-64`). This is exactly
what `CreateFileUseCase` relies on — it writes bytes and creates a `Document` with a random
`contentId`/`yjsStateId`, persisting no Yjs state (`create-file.ts:78-93`).

**Rationale**: copying CRDT state would carry the source room's client IDs and edit history into the
clone, and would make the clone's first open depend on binary state produced for a different
document. Seeding from bytes is the path the system already exercises on every new file.

**Alternatives rejected**:
- *Copy the Yjs state files verbatim* — carries foreign client IDs and history; also breaks the
  point-in-time guarantee, since persisted state can lag the live room.
- *Reuse the source's `yjsStateId`* — two projects would share one collaboration room. Data
  corruption, and a cross-tenant leak.

**Consequence to verify**: the clone's documents must open in the editor with the copied content
(this is the failure mode recorded in the `collab-lifecycle-data-loss` note — a room that seeds
wrongly yields a blank editor and corrupts on first keystroke). This needs an e2e check, not a unit
test.

---

## R4. Text documents versus binary assets

**Question**: how does the clone know which files to read as live text and which to copy as bytes?

**Decision**: **Branch on the presence of a `Document` row**, which is how the rest of the system
already distinguishes them.

`UploadAssetUseCase` creates a `Document` for editable text (including `.yml` theme files) and an
`Asset` row otherwise (`upload-asset.ts:110-128`); `Asset.id == FileNode.id`. So: a file node with a
document is text (resolve via R2, write UTF-8 bytes); a file node without one is an asset (read raw
bytes from the source file store, write verbatim, create an `Asset` row with the same mime type and
size against the new file node id).

**Rationale**: reuses the existing invariant instead of inventing a second classification (extension
sniffing would misclassify theme files, which are assets by extension but documents by row).

---

## R5. One clone at a time per user

**Question**: FR-027 — where does "one clone at a time per user" live?

**Decision**: a domain port `ActiveCloneRegistry` with `tryAcquire(userId): boolean` and
`release(userId): void`, implemented in infrastructure as an in-memory `Set`, wired as a singleton at
the API composition root and released in a `finally`.

**Rationale**: the guard is a business rule (the spec states it), so the port belongs in the domain;
the storage is process-local, so the implementation belongs in infrastructure. It mirrors the
existing in-memory limiter in `apps/collab/src/extensions/connection-limit.ts`.

**Scope limit, stated plainly**: the registry is **per API process**. With more than one API instance
behind a load balancer, a user could hold one clone per instance. The deployment is a single API
container today (`docker-compose`), so this is correct now and is a known limit later. A
database-backed lock was rejected as disproportionate to the risk.

**Alternatives rejected**:
- *`@fastify/rate-limit` on the route* — rate-limits requests per window, which is not the same rule;
  it cannot express "one *in flight*".
- *A database advisory lock* — correct across instances, but adds a lock lifecycle (and a stale-lock
  recovery story) for a guard whose whole purpose is to bound cost.

---

## R6. Progress feedback in a synchronous request

**Question**: FR-022 requires the system to show a clone is in progress. A single HTTP request cannot
report percentage progress back to its own caller.

**Decision**: **an indeterminate busy state** — the clone dialog's submit control enters a pending
state and is disabled for the duration, which also satisfies FR-022's double-submit prevention. No
percentage, no step counter.

**Rationale**: FR-022 asks the system to *show that it is in progress*, not to quantify it. The
project already has an SSE channel (`apps/api/src/routes/projects/events.ts`), but it is scoped to a
project the user is a member of — the clone's target project has no members until it succeeds (R1),
so it could only report against the *source* project, and would need a new event type, a bus, and a
subscription lifecycle for a ≤30s operation. Not worth it.

**Revisit if**: SC-003's 30-second budget proves unreachable for realistic projects, which would also
reopen the synchronous-execution decision itself.

---

## R7. What "settings" concretely means

**Question**: FR-013/FR-014 say "all project-level settings". Enumerated against the schema so the
requirement is testable rather than aspirational.

**Copied** (source of truth: `packages/db/prisma/schema.prisma`):

| Setting | Where it lives | Note |
|---|---|---|
| description, tags, language | `Project` columns | verbatim |
| main file | `Project.mainFileNodeId` | **remapped** to the clone's copy of that node |
| rendering / PDF / HTML / extensions | `ProjectRenderConfig.config` (one JSON blob) | verbatim; the settings UI's `rendering`, `pdf`, `html` and `extensions` sections all read this one row |
| shared dictionary | `ProjectDictionaryTerm[]` | terms copied; `createdByUserId` re-attributed to the cloning user |

**Not copied**: `ProjectMember` (except the new owner), `ReviewComment` + `ReviewReaction`,
`AuditLog`, `CollaborationSession`, `IgnoredLint`, `GitRepository`, `Template`, `archivedAt`.

**Rationale for the two non-obvious ones**: `GitRepository` holds a `credentialRef` — copying it
duplicates a credential and points two projects at one remote (FR-019). `IgnoredLint` is per-user
private state keyed by `(userId, documentId)`, which Principle VII keeps out of shared content
(FR-018).

---

## R8. Role-shaped dashboard menu

**Question**: FR-001b/FR-001c — the card menu becomes unconditional, with role-dependent contents.

**Decision**: drop the `canManage` gate on the menu in
`apps/web/src/components/project-card.tsx:22` and gate the **items** instead: Clone and Settings for
every role, Members only when `project.role === "owner"`.

**Rationale**: `/settings` already renders for any member and hides its owner-only section
(`visibleSettingsSections(isOwner)` in `components/settings/sections.ts:87`), so listing it is safe.
`/members` calls `getProjectAccess(id, "owner")` (`members/page.tsx:12`) and refuses non-owners, so
listing it for a viewer would be a dead item — hence FR-001c's rule that the menu must not offer an
item whose destination would refuse the user.

`apps/web/src/app/(dashboard)/dashboard/archived/page.tsx:80` renders the same `ProjectCard`, so the
archived view gets the menu — and Clone — with no extra work, which is what FR-004 needs.

---

## R9. Verifying "the clone renders like the source" (SC-006)

**Question**: Principle XV requires comparison tests against reference output for fidelity-critical
behaviour. Does SC-006 pull this feature into the fidelity-oracle regime?

**Decision**: **No, and the plan states why rather than leaving it implied.** This feature introduces
no rendering or export code path. Its claim is *clone ≡ source*, not *in-app ≡ reference build*.
SC-006 is therefore verified by asserting that the clone's render config and document content equal
the source's, plus one e2e export-equality check — not by a new fidelity-oracle run.

Principle XI is untouched: whatever parity the source project has with the reference build, the clone
inherits by construction, because it inherits the same inputs and the same settings.

---

## Technology choices

No new runtime dependencies. Everything needed is present: Prisma repositories, `ProjectFileStore`,
`CollaborativeContentReader`, Fastify routes with `@fastify/rate-limit`, the Next.js dashboard, and
Playwright for e2e.
