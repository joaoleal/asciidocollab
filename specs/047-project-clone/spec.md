# Feature Specification: Project Cloning

**Feature Branch**: `047-project-clone`

**Created**: 2026-08-22

**Status**: Draft

**Input**: User description: "a user can clone any existing project it has access to, a new name will be requested for the new project, the user that clones becomes the owner of the new project. Permissions to other users are not cloned. other settings are cloned. comments are not cloned"

## Clarifications

### Session 2026-08-22

- Q: Where is a clone started from? → A: From the projects dashboard, via the per-project overflow menu that today holds Members and Settings. That menu must now appear for every project the user is a member of, not just those they own.
- Q: With the menu now shown for every role, what does it contain for a viewer or editor? → A: **Clone alone.** *(Answered at the time as "Settings and Clone", on the belief that the settings page is role-aware. It is not — it calls `getProjectAccess(id, "owner")` and refuses everyone else, exactly as the members page does. Both are therefore owner-only, and a non-owner's menu holds Clone and nothing else. See the amendment on FR-001c, and R8 in research.md, whose rationale carried the same mistaken premise.)*
- Q: Does the user wait for a clone, or does it run in the background? → A: Synchronous and all-or-nothing. The user waits on a busy/progress state, and the new project becomes visible only once the whole clone has succeeded.
- Q: What happens when a document's live editing content cannot be read during a clone? → A: The clone fails. Nothing is created and the user is told which document could not be read, so they can retry. A clone never silently falls back to last-saved content — unlike the existing project download, which does.
- Q: Are repeated or concurrent clone requests limited? → A: One clone at a time per user. A second concurrent request from the same user is refused with a message saying a clone is already in progress. Clones by different users still run concurrently.
- Q: Where does the user end up after a successful clone? → A: They stay on the projects dashboard. The list refreshes to include the new project and a confirmation names it and offers a direct action to open it. *(Refined during implementation: this holds for the active listing. A clone is never archived, so the **archived** listing deliberately does not gain the new card — adding it would claim an active project is archived — and there the confirmation is the only route to the copy. See the notice rules in contracts/clone-project-ui.md.)*

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Clone a project I have access to (Priority: P1)

A user who can see a project — whether they own it, edit it, or only view it — wants their own copy
of it to work from: to start a new document set from an established one, to try a large restructuring
without touching the shared original, or to keep a personal snapshot of a project someone else owns.
They pick "Clone", are asked for a name for the copy, confirm, and land in a brand-new project that
they own, containing the same files, folders and content as the original.

**Why this priority**: This is the whole feature. Without it there is no way to branch off an
existing body of work; users resort to downloading the project and re-uploading it file by file,
which loses structure and settings. On its own it is already a complete, shippable capability.

**Independent Test**: Fully testable from the projects dashboard by opening a project's menu, cloning
it under a new name, and confirming the new project exists, is owned by that user, holds the same file
tree and content, and that the source project is untouched.

**Acceptance Scenarios**:

1. **Given** a user who is a member of a project containing folders, AsciiDoc files and images,
   **When** they open that project's menu on the dashboard, choose Clone, and supply the name
   "Handbook 2027", **Then** a new project named "Handbook 2027" exists containing the same folder
   and file structure at the same relative paths, with the same file contents.
2. **Given** a user whose role in the source project is viewer, **When** they view the dashboard,
   **Then** that project shows an overflow menu offering Clone; **and when** they clone it, **Then**
   the clone is created and their role in the new project is owner.
3. **Given** a clone has just completed, **When** the confirmation appears, **Then** the user is
   still on the projects dashboard, the new project is listed there without reloading the page, and
   the confirmation offers a direct action that opens it.
4. **Given** a user who has just cloned a project, **When** they edit a file in the clone, **Then**
   the corresponding file in the source project is unchanged, and vice versa.
5. **Given** a user who is not a member of a project, **When** they attempt to clone it, **Then** the
   request is refused and no new project is created.
6. **Given** a user whose role in a project is viewer or editor, **When** they open that project's
   menu on the dashboard, **Then** the menu offers Clone and nothing else — neither Members nor
   Settings, both of which lead to pages that admit owners alone; **and given** a user who owns the
   project, **Then** the menu offers Members, Settings and Clone.
7. **Given** the clone dialog is open, **When** the user submits an empty name or a name longer than
   the allowed length, **Then** the clone is not started and the user is told why.
8. **Given** a collaborator is editing a document in the source project right now, **When** another
   member clones the project, **Then** the clone contains that document's content as of the moment
   the clone started, including edits made in the live session.

---

### User Story 2 - The copy behaves like the original (Priority: P2)

A user cloning a project expects the copy to look and render the same as the source: the same main
document, the same rendering and export options, the same language, the same accepted spelling terms.
Otherwise the first thing they must do after cloning is re-create configuration by hand, and the
copy's exported output silently differs from the original's.

**Why this priority**: Valuable but not the core capability — a clone with content but default
settings is still useful, and settings can be re-applied manually. It becomes essential the moment
projects carry non-default rendering configuration.

**Independent Test**: Testable by configuring a source project's settings away from their defaults,
cloning it, and comparing the clone's settings and rendered output against the source's.

**Acceptance Scenarios**:

1. **Given** a source project with a description, tags, a document language and a configured main
   file, **When** it is cloned, **Then** the clone carries the same description, tags and language,
   and its main file is the copy of the source's main file.
2. **Given** a source project with non-default rendering, PDF and HTML options and enabled rendering
   extensions, **When** it is cloned, **Then** the clone's options match the source's, and exporting
   the same document from both produces visually identical output.
3. **Given** a source project whose shared dictionary contains accepted terms, **When** it is cloned,
   **Then** the clone's shared dictionary contains the same terms.
4. **Given** a source document that includes another file and references an image by a relative path,
   **When** the project is cloned, **Then** the same document in the clone resolves the include and
   the image without any path edits.
5. **Given** an archived source project, **When** it is cloned, **Then** the clone is created and is
   active, not archived.

---

### User Story 3 - The copy starts clean (Priority: P3)

A user cloning a project — especially a shared one they do not own — must not carry the original's
collaboration state into their copy. The other members must not silently gain access to the new
project, and the original's review discussion must not reappear as if it belonged to the copy.

**Why this priority**: A correctness and privacy boundary rather than a user-visible capability. It
has to hold from the first release, but it is expressed as exclusions from the P1 behaviour and is
verified alongside it.

**Independent Test**: Testable by cloning a project that has several members and an active review
discussion, then confirming the clone has exactly one member and no review items.

**Acceptance Scenarios**:

1. **Given** a source project with several members in different roles, **When** a member clones it,
   **Then** the clone has exactly one member — the cloning user, as owner — and no other user can see
   or open the clone.
2. **Given** a source project with review comments, replies, reactions and open tasks on its
   documents, **When** it is cloned, **Then** the clone's documents carry no review items of any
   kind.
3. **Given** a source project linked to an external repository with stored credentials, **When** it is
   cloned, **Then** the clone has no external repository link and no copied credential.
4. **Given** a source project with an existing activity history, **When** it is cloned, **Then** the
   clone's history begins with its own creation entry recording that it was cloned and from which
   project, and contains none of the source's earlier entries.

---

### Edge Cases

- **Clone fails part-way while the system is running** (storage error, unreadable document, rejected
  write): what was built is removed, nothing was ever visible, and the user is told the clone did not
  complete.
- **The system stops abruptly mid-clone**: the user's request simply fails. Whatever had been written
  stays invisible and unreachable forever — no listing shows it, nothing can open it — but it is not
  removed from storage, because nothing was left running to remove it.
- **The user closes the tab or navigates away mid-clone**: because nothing is visible until success,
  they either find the finished project on their next visit or find no project at all; they never
  find a half-built one.
- **Access is revoked between opening the dialog and confirming**: the clone is refused, as it would
  be for any non-member.
- **The source project is deleted while the clone is running**: the clone either completes as a
  faithful copy of what it had already read, or fails cleanly — it never produces a partially copied
  project.
- **Empty project** (root folder only, no files): the clone succeeds and yields an empty project.
- **Very large project** (many files, large images): the user gets progress feedback rather than an
  unresponsive screen, and the operation does not appear to hang.
- **Two clones of the same source at the same time by different users**: both succeed and produce
  independent projects.
- **A second clone requested by a user who already has one running**: refused with an explanation;
  the running clone is unaffected and still completes.
- **A clone started from the archived-projects view**: the same menu and the same behaviour — the
  archived listing shows the same project cards, and the resulting clone is active, not archived.
- **Name collides with a project the user already has**: allowed — project names are not unique.
- **Cloning a clone**: behaves like any other clone; the chain is not tracked beyond each clone's own
  creation entry naming its immediate source.
- **Source has a main file configured that is later deleted in the source**: the clone's main file
  points at the clone's own copy and is unaffected by the source's change.
- **A source document has never been opened** (no live collaborative state yet): its stored content is
  copied, and the clone succeeds normally.
- **The collaboration service is unavailable while a source document is open for editing**: the clone
  fails and names that document; nothing is created and the user can retry once the service returns.

## Requirements *(mandatory)*

### Functional Requirements

#### Initiating a clone

- **FR-001**: Users MUST be able to initiate a clone of any project they are a member of, whatever
  their role in it (viewer, editor or owner).
- **FR-001a**: The clone action MUST be offered on the projects dashboard, in the per-project overflow
  menu that already holds Members and Settings.
- **FR-001b**: That overflow menu MUST be shown for every project listed, in both the active and the
  archived project views, whatever the user's role in the project. Today it is shown only to owners, so viewers and editors currently have no
  menu at all.
- **FR-001c**: The menu's contents MUST reflect the user's role in that project: Clone is offered to
  every role; Members is offered only to owners, because that destination refuses non-owners. The
  menu MUST NOT offer any item whose destination would then be refused.

  **Amended during implementation (2026-08-23).** This requirement originally also said "Settings is
  offered to every role (it already presents only the sections the role may see)", on the strength of
  research R8's reading of `visibleSettingsSections(isOwner)`. That reading was wrong at the page
  level: `apps/web/src/app/(dashboard)/dashboard/projects/[id]/settings/page.tsx` calls
  `getProjectAccess(id, "owner")`, which redirects any non-owner to `/403`. Offering Settings to a
  viewer therefore violated the second half of this very requirement. Settings is now owner-only in
  the menu, alongside Members. The invariant is preserved as stated; only the Settings row changed.

  Admitting non-owners to the settings page instead was considered and rejected **for this feature**.
  It needs no new permission — every write is already gated server-side (owner-only for project
  fields, editor-or-owner for render config and main file) and non-members are refused before any
  role comparison — but the page's five non-owner-visible sections gate their controls on
  `canEdit = !isArchived` with no role in it, so a viewer would be shown live inputs and three Save
  buttons that all fail with 403. Making that honest means role-gating four separate places in the
  settings module, which is a change to project settings rather than to cloning. It is recorded here
  as deliberately deferred, not overlooked.
- **FR-002**: System MUST refuse a clone request from a user who is not a member of the source
  project, and MUST NOT reveal through that refusal whether the project exists.
- **FR-003**: System MUST ask for a name for the new project before the clone begins, pre-filled with
  a suggested name derived from the source project's name, and MUST validate it under the same rules
  used when creating a project (non-empty after trimming, at most 100 characters).
- **FR-004**: System MUST allow cloning an archived project.

#### Ownership and permissions

- **FR-005**: The user who performs the clone MUST become the owner of the new project.
- **FR-006**: The new project MUST have exactly one member — the cloning user. No membership, role or
  invitation from the source project is carried over.
- **FR-007**: The source project MUST be left completely unmodified by a clone, including its
  membership, settings, content and file structure.

#### Content copied

- **FR-008**: System MUST reproduce the source project's complete folder and file structure, with
  every file and folder at the same path relative to the project root.
- **FR-009**: File contents MUST be copied as of the moment the clone starts, including edits made in
  an active collaborative editing session that have not yet been written back to storage.
- **FR-009a**: If a document's live editing content cannot be read, the clone MUST fail rather than
  substitute that document's last-saved content. The failure message MUST identify the document that
  could not be read. A clone never produces a copy that silently differs from what collaborators see.
- **FR-009b**: A document with no active editing session MUST be copied from its stored content; that
  is not a fallback and MUST NOT fail the clone.
- **FR-010**: Non-text files (images and other uploaded assets) MUST be copied with identical
  contents.
- **FR-011**: The clone's content MUST be fully independent of the source's: subsequent edits in
  either project MUST NOT be visible in the other.
- **FR-012**: Cross-file references that resolve in the source — includes, image references, and the
  configured main file — MUST resolve identically in the clone without the user editing any path.

#### Settings copied

- **FR-013**: System MUST copy the source project's settings to the clone: description, tags,
  document/spellcheck language, configured main file (remapped to the clone's own copy of that file),
  and all rendering settings — general rendering options, PDF options, HTML options, and enabled
  rendering extensions.
- **FR-014**: System MUST copy the source project's shared dictionary of accepted terms.
- **FR-015**: The clone MUST be created in an active (non-archived) state regardless of the source's
  archived state.

#### Not copied

- **FR-016**: System MUST NOT copy review comments, their replies or their reactions.
- **FR-017**: System MUST NOT copy review tasks. Tasks are excluded on the same basis as comments:
  they belong to the same review discussion and carry an assignee who is not a member of the clone.
- **FR-018**: System MUST NOT copy any user's private per-project state from the source, such as
  dismissed grammar or spelling suggestions.
- **FR-019**: System MUST NOT copy any link to an external repository, nor any credential stored for
  it.
- **FR-020**: System MUST NOT copy the source project's activity history. The clone's history MUST
  begin with its own creation entry, which records that the project was cloned and identifies the
  source project.
- **FR-021**: System MUST NOT copy active collaboration sessions; nobody is joined to any document in
  the clone at the moment it is created.

#### Feedback and integrity

- **FR-022**: A clone MUST run as a single all-or-nothing operation that the requesting user waits
  for. While it runs, the system MUST show that it is in progress, and MUST prevent the user from
  submitting the same clone twice.
- **FR-023**: The new project MUST become visible — to its owner and in any listing — only once the
  clone has fully succeeded. There is no intermediate "being cloned" state.
- **FR-024**: A clone that fails MUST leave nothing that any user can see or reach: no project in any
  listing, no project anyone can open, no files or settings reachable through the application. The
  failure MUST be reported to the user who requested it, with the source project unaffected.
- **FR-024a**: When a clone fails while the system is still running — a storage error, an unreadable
  document, a rejected write — the system MUST additionally remove what it had built, leaving no
  stored project record and no stored files.
- **FR-024b**: When the system itself stops abruptly mid-clone, FR-024a cannot run. The residue that
  survives MUST remain permanently invisible and inaccessible: it MUST never appear in a listing,
  never be openable, and never be counted anywhere the user can observe. Reclaiming that stored
  residue is out of scope (see Out of Scope).
- **FR-025**: On success the user MUST remain on the projects dashboard. The project listing MUST
  refresh to include the new project without a manual reload, and a confirmation MUST name the new
  project and offer a direct action to open it.
- **FR-026**: A successful clone MUST be recorded in the source project's activity history as an
  access event attributed to the cloning user.
- **FR-026a**: A refused clone request MUST be recorded as an authorization denial against the source
  project, capturing who asked, what they asked for, and why it was refused. Recording the denial
  MUST NOT change what the caller sees — a failure to record it still returns the same refusal.
- **FR-027**: A user MUST have at most one clone running at a time. A further clone request from the
  same user while one is in progress MUST be refused with a message saying a clone is already
  running, and MUST NOT start a second copy or affect the one already running. Clones requested by
  different users MUST be able to run concurrently.

### Key Entities *(include if data involved)*

- **Project**: The unit being cloned. Carries a name, description, tags, language, archived state and
  a designated main file, and aggregates everything below.
- **Project membership**: A user's role in a project (viewer, editor, owner). Determines who may
  clone, and is deliberately not carried into the clone beyond the new owner.
- **File tree node**: A folder or file within a project, identified by its path relative to the
  project root. Paths must be preserved by the clone for references to keep resolving.
- **Document content**: The text of an editable file. May exist in two places at once — stored
  content and the in-flight state of a live editing session — and the clone must take whichever is
  current.
- **Asset**: The binary content of an uploaded non-text file, copied verbatim.
- **Project rendering settings**: The project-scoped rendering, PDF, HTML and extension options that
  determine how documents preview and export. Copied, so the clone renders like the source.
- **Shared dictionary term**: A spelling accepted across a project. Copied.
- **Review item**: A comment, reply, reaction or task anchored to a document. None are copied.
- **Activity entry**: A record of something that happened in a project. Not copied; the clone gets a
  fresh trail beginning with its own creation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from the projects dashboard to a confirmed clone request in no more than
  three interactions (open the project's menu, choose Clone, name it and confirm), for every project
  they are a member of regardless of role, and can open the finished clone in one further click
  without leaving the dashboard first.
- **SC-002**: 100% of the source project's folders and files appear in the clone at the same relative
  paths, with identical content, for every project cloned.
- **SC-003**: For a project of up to 200 files and 50 MB of content, the clone completes within 30
  seconds of confirmation, and the user sees an in-progress indication for the whole wait.
- **SC-004**: The clone's membership list contains exactly one entry — the cloning user as owner — in
  100% of clones, including clones of projects with many members.
- **SC-005**: The clone contains zero review items — comments, replies, reactions or tasks — in 100%
  of clones, including clones of projects with active review discussions and outstanding tasks.
- **SC-006**: Exporting the same document from the clone and from the source, immediately after
  cloning, produces visually identical output for 100% of documents.
- **SC-007**: Editing either project after a clone changes nothing in the other, in 100% of checks
  across content, structure and settings.
- **SC-008**: A clone that fails leaves zero projects visible or openable by any user, in 100% of
  failures — including failures caused by stopping the system mid-clone. For failures that occur
  while the system is running, it additionally leaves zero stored files and zero stored settings.
- **SC-009**: Users who previously downloaded and re-uploaded a project to branch from it can do so
  without any manual file handling or settings re-entry — the number of manual steps drops from one
  per file plus one per setting, to one.

## Assumptions

- **"Has access to" means membership.** Any user who is a member of a project — viewer, editor or
  owner — may clone it, as stated in the request. Cloning is treated as an authorized read of content
  the user can already read, plus creation of a new project of their own; it grants no new access to
  the source.
- **Content is a point-in-time snapshot.** The clone captures each document's most current content at
  the moment cloning starts, resolving live-session content for documents that are open and stored
  content for those that are not. Edits made in the source after the clone starts are not chased.
  Unlike the existing project download, a clone does not tolerate a failed live read (FR-009a).
- **Project names are not unique.** The system does not enforce unique project names today, so a
  clone may be given any valid name, including one already in use. The suggested default name is
  derived from the source (for example "Copy of <name>") and is fully editable.
- **The external repository link is treated as a credential, not a setting.** It is excluded from
  "other settings are cloned" because copying it would duplicate a stored credential and point two
  projects at the same remote.
- **The shared project dictionary is treated as a setting** and is cloned; per-user dismissed
  suggestions are private state and are not.
- **Activity history is not a setting.** The clone starts a fresh trail rather than inheriting the
  source's record of who did what.
- **The clone is a one-time copy.** No ongoing link, sync or comparison between clone and source is
  created or implied.
- **Existing project creation rules apply to the clone**, including name validation and whatever
  limits already govern how many projects a user may own.

## Out of Scope

- Cloning into another user's account, or choosing a different owner for the clone.
- Cloning a subset of a project (selected folders or files only).
- Any ongoing link between clone and source: syncing, diffing, merging changes back, or tracking
  clone lineage beyond the clone's own creation entry.
- Cloning across separate instances of the system, or as an export/import format.
- Cloning individual files or folders within or between existing projects.
- Changing who may see or clone a project — the existing permission model is unchanged.
- Reclaiming the storage left behind when the system stops abruptly mid-clone (FR-024b). Such residue
  is unreachable, and a sweep that deleted projects merely for having no members would also delete
  projects orphaned for unrelated reasons — for instance one whose only owner's account was removed.
  That is a separate decision about a pre-existing condition, not part of cloning.
