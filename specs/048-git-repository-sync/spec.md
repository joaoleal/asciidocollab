# Feature Specification: Git Repository Synchronization

**Feature Branch**: `048-git-repository-sync`

**Created**: 2026-08-24

**Status**: Draft

**Input**: User description: "add support for synchronizing with a git repository, must support fresh clone for a new project, initializing a new project, adding new files, removing files, creating branches, moving between branches, pushing, pulling, resolving conflicts. special care needs to be taken when performing these operations considering hocuspocus."

## Clarifications

### Session 2026-08-24

- Q: How much git staging should users control before committing? → A: A true staging area (index) — users stage/unstage individual files; the file tree distinguishes staged ("added"), modified-but-unstaged ("changed"), and untracked ("not added") states.
- Q: How should users resolve merge conflicts inside the app? → A: Per-file side choice plus an inline three-way merge — keep-ours / take-theirs / edit a merged result per conflicting file; completion is blocked until all conflicts are resolved.
- Q: How should git credentials and commit authorship work? → A: One encrypted project-level credential (token) authorizes push/pull for the connection; each commit is authored by the platform user who triggered it.
- Q: A visual indication in the file tree of changed / added / not-added files is required, and committing must let the user set a commit message and review the changed files (added, modified, removed, renamed/moved, copied) that the commit will contain. → A: Adopted as explicit requirements (see FR-011a, FR-011b, FR-025–FR-028).
- Q: How should git operations execute, given the mandate to sandbox them yet the need to reach a remote and to scale across many projects? → A: A bounded, warm pool of stateless git-worker sandboxes (system `git`) sized to load — not to project count — consuming a job queue. Each job is scoped to a single project's directory (which persistently holds the repository state on shared storage), cleans its workspace between jobs, and is allowed network egress only to the connection's configured remote. This requires reconciling two constitution statements before/at planning: (a) "one Docker container per git operation" → a per-job-scoped shared worker pool; (b) the git sandbox's "no network access" → "egress allowlisted to the configured remote host only".
- Q: Which project roles gate which git actions? → A: Owner/admin role is required to connect/disconnect a remote and to set/rotate the credential; any member with edit rights may perform everyday sync (commit, push, pull, branch create/switch, resolve conflicts, discard/restore); viewers see git status read-only.
- Q: While a content-changing git op (import/pull/branch switch) runs, what happens to normal editing and file-tree mutations? → A: Content-changing operations (import, pull, branch switch) take a project write-lock — file/tree edits and new sessions on affected files are paused/queued until the operation completes, while reading stays available; commit and push (read-only content capture) do NOT block editing.
- Q: Can a project disconnect from its remote after connecting? → A: Yes — disconnect unlinks the remote and deletes the stored credential while keeping the project's current files; the project reverts to a normal non-git project and can be reconnected later.
- Q: When git brings in a file rename via pull/switch, should the platform auto-rewrite AsciiDoc references (include::/image::/xref) the way a native move does? → A: No — git is the source of truth for git-sourced changes; incoming file contents and renames are applied exactly as received, with no automatic reference rewriting (the native rewrite applies only to moves initiated inside the platform).
- Q: The `.git` folder must be hidden — what exactly is hidden from the user-facing file tree and file operations? → A: Internal metadata only — the `.git/` directory and `.collab/` (and equivalents) are never shown in the tree, never browsable/editable/deletable via file operations, and never treated as project content; user-facing tracked dotfiles such as `.gitignore`, `.gitattributes`, and `.github/` remain visible and editable.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Import an existing repository as a new project (Priority: P1)

A user wants to bring an existing Git repository (for example, a documentation repo on GitHub) into the platform so their team can edit it collaboratively. They provide the repository's address and credentials, and the platform creates a brand-new project populated with all the repository's files and folder structure, ready for real-time editing.

**Why this priority**: This is the primary entry point for the feature and delivers standalone value: existing content becomes collaboratively editable without any manual re-upload. It can ship before any write-back capability exists (read-only import is already useful).

**Independent Test**: Provide a valid repository address and credentials for a repository containing nested folders and both text and binary files; confirm a new project is created whose file tree, file contents, and folder hierarchy exactly match the repository's default branch, and that files open in the collaborative editor.

**Acceptance Scenarios**:

1. **Given** a valid repository address and working credentials, **When** the user imports it as a new project, **Then** a new project is created that the importing user owns, containing every tracked file and folder from the repository's default branch with content matching the repository.
2. **Given** an import is already running for the user, **When** they start another import, **Then** the second attempt is refused with a clear "operation already in progress" message and no partial project is created.
3. **Given** invalid credentials or an unreachable repository, **When** the user attempts the import, **Then** the import fails with a clear reason and no project (or a fully cleaned-up empty state) is left behind.
4. **Given** the repository contains internal collaboration state paths (e.g., an ignored working directory), **When** the project is created, **Then** only genuine repository-tracked content is imported and no platform-internal artifacts are treated as user files.

---

### User Story 2 - Commit and push local changes to the remote (Priority: P2)

A team has edited documents in a git-connected project and wants to publish their work back to the remote repository. The user reviews what changed (files added, removed, renamed, or modified), writes a commit message, and pushes. The content that gets published reflects exactly what collaborators currently see in the editor — including edits made moments ago that have not yet been written to disk.

**Why this priority**: Publishing changes back is the other half of a useful two-way workflow. It depends on a connection existing (P1 or P6) but is independently valuable and testable.

**Independent Test**: In a git-connected project, make live edits to an open document and also add and delete files, then commit and push; verify the pushed commit on the remote contains the latest live edit content (not stale content) and reflects the added/removed files.

**Acceptance Scenarios**:

1. **Given** a document that is currently open with unsaved live edits, **When** the user commits and pushes, **Then** the committed content matches the latest collaborative edits, not an older on-disk snapshot.
2. **Given** files were added, removed, or renamed since the last commit, **When** the user views pending changes, **Then** all additions, removals, and renames are listed accurately before committing.
3. **Given** the remote has advanced since the project last synced, **When** the user attempts to push, **Then** the push is rejected as out-of-date and the user is prompted to pull first, with no partial push.
4. **Given** a successful push, **When** the user views the connection status, **Then** the current branch, last-synced time, and latest commit are updated to reflect the push.

---

### User Story 3 - Pull remote changes into the project (Priority: P3)

Someone else pushed updates to the remote repository. A user in the platform pulls those changes so the project reflects the latest remote state. Where an incoming change touches a document that teammates currently have open, the update becomes visible to everyone in that document without their in-progress work being silently lost or overwritten.

**Why this priority**: Keeping the project current with the remote is essential for collaboration across the platform boundary, and it is where the live-editing interaction is most delicate. It depends on a connection but is independently testable.

**Independent Test**: Push a change to a file from outside the platform, keep that same file open in the collaborative editor inside the platform, then pull; verify the incoming change appears to all connected editors and is not reverted by the editor's normal save cycle.

**Acceptance Scenarios**:

1. **Given** remote changes to files nobody has open, **When** the user pulls, **Then** the project's file tree and contents update to match the remote and the changes are visible when those files are opened.
2. **Given** remote changes to a file that is currently open in the collaborative editor, **When** the user pulls, **Then** the incoming content is delivered to all connected editors of that document and persists (it is not overwritten by the routine save-back cycle).
3. **Given** incoming and local changes conflict, **When** the user pulls, **Then** the pull stops in a conflicted state, the conflicting files are clearly identified, and no non-conflicting change is lost.
4. **Given** a pull is interrupted by a network failure, **When** the operation aborts, **Then** the project is left in its prior consistent state with a clear error.

---

### User Story 4 - Create branches and switch between them (Priority: P4)

A user wants to work on a set of changes in isolation. They create a new branch, do their editing, and later switch back to the main branch. Switching branches updates the project's files to match the target branch. If files are open in the collaborative editor when the project switches branches, those editors reflect the target branch's content.

**Why this priority**: Branching supports parallel and reviewable workflows. It builds on a working connection and content-sync mechanics, so it comes after the core pull/push slices.

**Independent Test**: In a git-connected project, create a branch, switch to it, verify the current branch indicator updates; make and commit a change on the branch; switch back to the original branch and verify the project's files reflect the original branch's content.

**Acceptance Scenarios**:

1. **Given** a git-connected project, **When** the user creates a branch, **Then** the branch is created from the current branch's state and is available to switch to.
2. **Given** multiple branches exist, **When** the user switches to another branch, **Then** the project's file tree and contents update to match that branch and the current-branch indicator reflects the switch.
3. **Given** files are open in the collaborative editor when a branch switch changes those files, **When** the switch completes, **Then** connected editors reflect the target branch's content rather than the previous branch's.
4. **Given** the project has uncommitted local changes, **When** the user attempts to switch branches, **Then** the platform either safely preserves those changes or clearly blocks the switch with guidance, and never silently discards work.

---

### User Story 5 - Resolve conflicts within the platform (Priority: P5)

A pull or branch switch produces conflicting changes to one or more files. Rather than needing external Git tooling, the user is guided through the conflicts inside the platform: for each conflicting file they can see the competing versions and choose how to resolve it, then complete the operation with a resolving commit.

**Why this priority**: Conflict resolution turns pull/switch from "works only in the happy path" into something usable by non-experts, but it only matters once pull/branching exist.

**Independent Test**: Create a conflict by changing the same lines of a file both on the remote and locally, pull to trigger the conflict, then resolve each conflicting file through the in-platform flow and confirm the operation completes and the resolved content is what the user selected.

**Acceptance Scenarios**:

1. **Given** a conflicted state after a pull or switch, **When** the user opens the conflict resolution view, **Then** each conflicting file is listed with its competing versions presented understandably.
2. **Given** a conflicting file, **When** the user chooses a resolution (keep local, take incoming, or a combined result), **Then** the file is marked resolved with the chosen content.
3. **Given** all conflicts are resolved, **When** the user completes the operation, **Then** the merge/switch finishes, a resolving commit is recorded, and the project returns to a normal (non-conflicted) state.
4. **Given** unresolved conflicts remain, **When** the user attempts to finish, **Then** completion is blocked and the remaining conflicts are highlighted.

---

### User Story 6 - Initialize Git on an existing project (Priority: P6)

A team already has a project on the platform that is not connected to any repository. They want to start tracking it in Git and publish it to a remote. The user connects the project to a (possibly empty) remote repository and makes an initial commit and push so the project's current content becomes the repository's starting point.

**Why this priority**: This complements the import flow for content that originated on the platform. It reuses the commit/push mechanics of P2, so it is valuable but not the first slice.

**Independent Test**: Take an existing project with no git connection, connect it to an empty remote repository, and perform the initial publish; verify the remote then contains all of the project's current files and the project shows as connected on its default branch.

**Acceptance Scenarios**:

1. **Given** a project with no git connection and a reachable empty remote, **When** the user initializes and publishes, **Then** the remote receives an initial commit containing the project's current files and the project is marked connected.
2. **Given** the acting user lacks permission to modify the project, **When** they attempt to initialize a connection, **Then** the action is refused.
3. **Given** the target remote already contains commits, **When** the user attempts to initialize as if empty, **Then** the platform detects the mismatch and guides the user toward importing/pulling instead of overwriting remote history.

---

### Edge Cases

- **Live document while pulling/switching**: An incoming change targets a document with an active editing session. The change must reach connected editors and survive the routine save-back cycle; it must not be silently discarded by the editor writing its in-memory content back over the pulled file.
- **Committing an actively edited document**: The content captured for a commit must be the latest collaborative content, not a stale on-disk projection that lags behind live edits.
- **Concurrent git operations**: A second git operation (import/pull/push/switch) is requested for the same project while one is in flight — the second must be refused or queued, never run concurrently in a way that corrupts state.
- **Internal collaboration state**: The platform's internal per-document collaboration state must never be committed to the repository or exposed as user files.
- **Hidden metadata access attempts**: Any attempt to view, open, edit, move, or delete `.git/` or `.collab/` through the file tree or file operations must be impossible (these paths are not surfaced at all), while `.gitignore`/`.gitattributes` remain normal editable files.
- **Binary and non-text assets**: Images and other binary files have no collaborative-text representation and must round-trip through commit/pull unchanged.
- **Non-fast-forward push**: The remote advanced since the last sync — push must be safely rejected and the user directed to pull first.
- **Renames/moves vs. cross-reference integrity**: A file renamed or moved by a git-sourced change (pull/switch) is applied exactly as the remote committed it — references are NOT auto-rewritten (git is source of truth). Only platform-initiated moves trigger the native reference rewrite.
- **Credential expiry / revocation**: Credentials become invalid between operations — the failure must be clear and must not leave the project in a broken state.
- **Interrupted operation**: Network loss or server restart mid-operation must leave the project in its prior consistent state (all-or-nothing).
- **Empty repository / first commit**: Importing or connecting to a repository with no commits yet.
- **Detached or deleted remote branch**: The tracked branch no longer exists on the remote when pulling or pushing.
- **Very large repository or file**: Import/sync of a repository that exceeds a configured size limit should fail gracefully with clear feedback rather than hang.
- **Pull/switch affecting open files**: An incoming operation would change files that collaborators currently have open — the user is warned and must confirm; on confirmation the change reaches the open editors without discarding in-progress work.
- **Commit while a document cannot be flushed**: An open document's latest live content cannot be captured at commit time — the commit is aborted rather than publishing stale content.
- **Remote branch rewritten**: A background fetch finds the tracked branch was force-pushed/rewritten upstream — the user is warned and guided, and no history is silently discarded.
- **Undo-a-pull after further edits**: Undoing a pull when local edits were made after it must either fold those edits forward or clearly warn about what will be lost, never silently discarding them.

## Requirements *(mandatory)*

### Functional Requirements

#### Connection & setup

- **FR-001**: The system MUST allow a user to import an existing remote repository as a new project, populating the new project's file tree, folder structure, and file contents from the repository's default branch.
- **FR-002**: The system MUST allow connecting an existing project (that has no git connection) to a remote repository and publishing the project's current content as the repository's initial state.
- **FR-003**: The system MUST store, per project, the remote repository address, the tracked/current branch, a reference to the credentials used (never the raw secret in a way that exposes it to unauthorized members), and the time of last successful synchronization.
- **FR-004**: The system MUST support authenticated access to private repositories and surface authentication failures with actionable messages.
- **FR-004a**: The system MUST allow an owner/admin to disconnect a project from its remote: the remote link and the stored credential are removed while the project's current files are retained, returning the project to a normal non-git project that can be reconnected later.

#### Content fidelity with live collaboration (the "hocuspocus" concern)

- **FR-005**: When capturing project content for a commit/push, the system MUST use the latest collaborative content for any document that is currently being edited, not a stale on-disk snapshot.
- **FR-006**: When applying incoming changes (pull or branch switch) to a document that currently has an active editing session, the system MUST deliver the new content to all connected editors of that document.
- **FR-006a**: When applying incoming content to a live document, the system MUST apply only the minimal change needed to reach the target content (not a full-document replace), so collaborators' cursor positions, selections, and undo history are preserved.
- **FR-006b**: Before a pull or branch switch, the system MUST flush the latest live content of all affected open documents into the working copy first, so the operation reconciles against current content and no un-committed live edits are lost; genuine conflicts then surface through the normal conflict flow.
- **FR-007**: Content applied to an actively edited document MUST persist and MUST NOT be reverted by the collaboration server's routine save-back cycle.
- **FR-008**: The system MUST exclude internal collaboration state (per-document collaboration blobs and any other platform-internal working artifacts) from what is tracked, committed, or pushed to the repository.
- **FR-008a**: The system MUST hide git and collaboration internal metadata — the `.git/` directory and `.collab/` (and equivalents) — from the user-facing file tree and from all file operations: these paths MUST never be shown, browsed, edited, moved, or deleted through the app, and MUST never be treated as project content. User-facing tracked dotfiles (e.g. `.gitignore`, `.gitattributes`, `.github/`) MUST remain visible and editable.
- **FR-009**: The system MUST prevent more than one mutating git operation from running against the same project at the same time — this includes staging, committing, discarding, and amending as well as import/pull/push/branch-switch — refusing or serializing concurrent requests with a clear "operation already in progress" signal. Read-only git actions (status, diff, history, branch list) are exempt and may proceed concurrently (served from last-known state while a content-changing operation is in progress).
- **FR-010**: Every git operation that mutates project content MUST be all-or-nothing: on failure or interruption, the project MUST be left in the consistent state it had before the operation began.

#### Staging, commit & push

- **FR-011**: The system MUST detect and present the set of pending changes (added, removed, modified, renamed/moved, copied files) relative to the last commit before the user commits.
- **FR-011a**: The system MUST provide a staging area (index): users MUST be able to stage and unstage individual files (and select all / none) so that a commit contains only the staged changes. The system MUST distinguish, per file, three states — staged ("added"), modified-but-unstaged ("changed"), and untracked ("not added").
- **FR-011b**: The system MUST show, in the commit experience, a required commit-message input and a review list of exactly the changes the commit will contain, each labeled by change type (added, modified, removed, renamed/moved, copied). The user MUST NOT be able to commit with an empty message or with nothing staged.
- **FR-012**: The system MUST record a commit containing only the staged changes, and MUST attribute the commit to the platform user who triggered it (author identity derived from that user), while the connection's stored credential authorizes the eventual push.
- **FR-013**: The system MUST push committed changes to the remote on the current branch, and MUST reject a push that would overwrite unseen remote history (non-fast-forward), directing the user to pull first.

#### Pull

- **FR-014**: The system MUST fetch and integrate remote changes for the current branch, updating the project's file tree and file contents to reflect the merged result.
- **FR-015**: The system MUST detect conflicts between incoming and local changes and stop in a clearly identified conflicted state without losing non-conflicting changes.
- **FR-015a**: For git-sourced changes (pull or branch switch), the system MUST apply incoming file contents and renames exactly as received and MUST NOT automatically rewrite AsciiDoc references (include::/image::/xref). The platform's native reference-rewriting on move/rename applies only to moves initiated inside the platform, so that a git-connected project stays byte-consistent with its remote.

#### Branching

- **FR-016**: The system MUST allow the user to view existing branches, create a new branch from the current state, and see which branch is current.
- **FR-017**: The system MUST allow switching the project to another branch, updating the project's files and tree to match the target branch, including for documents that are currently open.
- **FR-018**: When switching branches with uncommitted local changes, the system MUST either safely preserve those changes or block the switch with clear guidance; it MUST NOT silently discard uncommitted work.

#### Conflict resolution

- **FR-019**: The system MUST let users resolve conflicts entirely within the platform. For each conflicting file the user MUST be able to choose keep-local (ours) or take-incoming (theirs) for the whole file, OR edit a merged result in an inline three-way view (base / local / incoming) to combine both sides.
- **FR-020**: The system MUST block completion of a conflicted operation until all conflicts are resolved, and MUST record a resolving commit once they are.

#### Permissions & audit

- **FR-021**: The system MUST enforce role-based authorization for git actions, reusing the existing project role model: connecting or disconnecting a remote and setting/rotating the connection credential require the owner/admin role; everyday sync actions (commit, push, pull, branch create/switch, resolve conflicts, discard/restore) are available to any member with edit rights; viewers may see git status but perform no mutating git action.
- **FR-022**: The system MUST record git operations (import, connect, commit, push, pull, branch create/switch, conflict resolution) in the project's activity/audit history.

#### Feedback & status

- **FR-023**: The system MUST surface, for a connected project, the current branch, synchronization status (up to date / ahead / behind / conflicted), and last-sync time.
- **FR-024**: The system MUST report progress and outcome of long-running operations (import, pull, push, switch) and clearly communicate failures with their cause.

#### File-tree change indicators

- **FR-025**: The system MUST show, directly in the project file tree, a per-file visual indication of each file's git status: unchanged, modified ("changed"), newly added and staged, untracked ("not added"), removed, and conflicted. Indicators MUST be legible in both light and dark themes.
- **FR-026**: The system MUST roll up child status onto collapsed folders so a folder indicates when it contains changes that are not currently visible.
- **FR-027**: File-tree indicators MUST update as the working state changes (edits made, files staged/unstaged, operations completed) without requiring a manual page reload, and MUST reflect the same status the commit review uses (a single source of truth for status).
- **FR-028**: The file-tree indicators MUST coexist with the existing presence/collaboration indicators on the tree without visual conflict, and MUST NOT be shown for projects that are not git-connected.

#### Collaboration-aware safety

- **FR-029**: Before a pull or branch switch that would change files currently open in live editing sessions, the system MUST warn the acting user, identify the affected open files (and that collaborators are present), and require explicit confirmation before proceeding.
- **FR-030**: Before capturing content for a commit or push, the system MUST flush the latest live content of all affected open documents and surface this as a visible preparation step; if a live flush fails for any affected document, the operation MUST abort with a clear error rather than commit stale content.
- **FR-031**: While a project-wide git operation is running, the system MUST signal that activity to project members (reusing the existing presence mechanism) and MUST prevent conflicting concurrent git operations on the same project.
- **FR-031a**: Content-changing operations (import, pull, branch switch) MUST take a project write-lock for their duration: file and tree mutations, and new editing sessions on affected files, MUST be paused or queued until the operation completes, while read access remains available. Commit and push, which only read content, MUST NOT block editing.

#### History, diff & discard

- **FR-032**: The system MUST let users view commit history for the project and for an individual file.
- **FR-033**: The system MUST provide a diff view for a file — uncommitted changes versus the last commit, and between two chosen commits — presented legibly for AsciiDoc content.
- **FR-034**: The system MUST show per-line authorship (blame) for a file, mapped to platform users where the commit author can be resolved to one.
- **FR-035**: The system MUST let users discard uncommitted changes for a selected file, or restore a file to a chosen committed version, with confirmation; discarding MUST be safe with respect to active editing sessions (the restored content reaches open editors and is not lost to save-back).
- **FR-036**: The system MUST let users amend the most recent commit that has not yet been pushed (message and/or staged content).
- **FR-037**: The system MUST let users undo the most recent pull/merge by restoring the project to its pre-operation state, consistent with the all-or-nothing model.

#### Remote automation & safety extras

- **FR-038**: The system MUST periodically refresh remote state in the background and show how far ahead of / behind the remote the current branch is, without automatically merging.
- **FR-039**: The system MUST reflect remote updates promptly (surfacing a "remote updated — pull available" signal) without requiring the user to manually refresh.
- **FR-040**: The system MUST maintain ignore rules so that internal collaboration artifacts are never tracked or committed, and MUST allow project maintainers to add additional ignore patterns.
- **FR-041**: The system MUST handle large binary assets efficiently so that repositories containing large binaries remain usable (e.g., large-file storage handling).
- **FR-042**: The system MUST be able to shelve (stash) uncommitted changes when the user switches branches, and restore them afterward, so no work is lost (this satisfies the "safely preserve" path of FR-018).
- **FR-043**: The system MUST offer a dry-run preview of push and pull that shows what would change before the operation is applied.
- **FR-044**: The system MUST support connecting to a provider via a guided authorization flow (in addition to manual token entry), storing any resulting credential encrypted at rest.
- **FR-045**: The system MUST rate-limit synchronization operations per the platform's security policy (configurable limits), and MUST support privacy-preserving commit author email where the user opts in.

### Key Entities *(include if data involved)*

- **Git connection**: The link between a project and a remote repository — remote address, provider, tracked/current branch, reference to credentials, last-sync time, and sync status. One per project.
- **Branch**: A named line of development within the connected repository; the project tracks a current branch and can create/switch among them.
- **Commit**: A recorded snapshot with a message, an author, a timestamp, and an identifier, produced by the platform or fetched from the remote.
- **Pending change**: A not-yet-committed difference for a file — its path and change type (added / removed / modified / renamed / copied).
- **File git status**: The per-file state shown in the tree and commit review — one of unchanged, modified ("changed"), staged/added, untracked ("not added"), removed, or conflicted; folders carry a rolled-up status of their descendants.
- **Staged set (index)**: The subset of pending changes the user has staged; a commit contains exactly this set.
- **Conflict**: A file whose incoming and local versions cannot be automatically reconciled, holding the base/local/incoming versions and the user's resolution (keep-local, take-incoming, or an edited merged result).
- **Credential reference**: A pointer to the authentication material used to access the remote, stored so that the raw secret is not exposed to unauthorized members.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can import a typical existing repository (hundreds of files) as a new, fully editable project without any manual file re-creation, and the resulting file tree and contents match the repository's default branch exactly.
- **SC-002**: 100% of commits capture the latest collaborative content for actively edited documents — a document edited seconds before a commit is never published as an older version.
- **SC-003**: When a pull or branch switch changes a document that teammates have open, 100% of connected editors see the updated content, and none of the applied content is reverted by the routine save-back cycle.
- **SC-004**: No git operation ever leaves a project in a corrupted or partially-updated state; on any failure or interruption the project is verifiably in its prior consistent state.
- **SC-005**: Two git operations never run against the same project simultaneously; overlapping requests are refused or serialized in 100% of attempts.
- **SC-006**: Users can resolve merge conflicts entirely within the platform for common text-conflict cases, with no need to use external Git tools.
- **SC-007**: Internal collaboration artifacts are never present in any commit pushed to the remote (0 leaked internal files across operations).
- **SC-008**: For a typical repository, a user can complete a connect-and-publish or import flow in a small number of guided steps and understand the result (branch, status, last sync) from the project's git status view.
- **SC-009**: Without opening any file, a user can tell from the file tree alone which files are changed, added-and-staged, untracked, removed, or conflicted, and folders correctly signal hidden changes beneath them.
- **SC-010**: Before committing, a user can see exactly which files the commit will contain and each one's change type (added / modified / removed / renamed/moved / copied), stage or unstage individual files, and cannot commit with an empty message or nothing staged.
- **SC-011**: No pull or branch switch that touches an open document proceeds without the user being warned and confirming, and in 100% of confirmed cases no open editor loses in-progress work.
- **SC-012**: Users can see a file's history and a legible diff of their uncommitted changes, and can discard changes for a file, without leaving the editor.
- **SC-013**: Role boundaries hold in 100% of attempts: non-owners cannot connect/disconnect a remote or manage the credential, viewers cannot perform any mutating git action, and each denial is recorded.
- **SC-014**: During an import/pull/branch-switch, no conflicting file or tree mutation is admitted (the write-lock holds), and a disconnected project retains all of its files with the credential fully removed.

## Assumptions

- **Providers & transport**: The initially supported remote providers are GitHub, GitLab, and Bitbucket over HTTPS, using token-based credentials, consistent with the provider/credential fields already modeled in the data layer. SSH-key transport and other providers are out of scope for the first version.
- **Connection scope**: Each project connects to a single remote repository and tracks one current branch at a time (a one-to-one project↔repository relationship), matching the existing data model. Multiple remotes per project are out of scope.
- **Credential model**: A git connection uses a project-level stored credential (referenced indirectly), authorizing operations for members with sufficient role, rather than each member supplying their own per-user identity. Commit authorship is attributed to the acting platform user where the platform can express it.
- **Sync is user-initiated**: All operations (import, commit, push, pull, branch create/switch, resolve) are explicitly triggered by a user. Continuous background auto-sync is out of scope for the first version.
- **Live-editing coexistence approach**: Reads for commit/push resolve authoritatively from live collaborative content (reusing the platform's existing authoritative-read mechanism), and incoming content is applied to open documents through the collaboration layer so it reaches connected editors and survives save-back — rather than writing files directly underneath live sessions. The precise integration boundary is a design/plan concern.
- **Whole-project, single-flight operations**: Git operations follow the established pattern for long-running whole-project operations (single-flight per project/user lock, all-or-nothing with cleanup on failure), consistent with the existing project-clone capability.
- **Execution & isolation environment**: Git commands run as the real `git` program (for full merge/conflict capability), inside a **bounded, warm pool of sandboxed git-worker processes sized to load rather than to project count**, dispatched via a job queue. Repository state (the `.git` data and working tree) persists per project on the shared project storage; workers are stateless, handle one project's directory per job, clean their workspace between jobs, and are permitted network egress only to the connection's configured remote. Internal collaboration state (`.collab/` and equivalents) is excluded from the tracked working tree.
- **Constitution reconciliation (dependency)**: This execution model intentionally reframes two existing constitution statements and MUST be reconciled at planning time: the Architecture Constitution's "Docker sandbox container per git operation" becomes a per-job-scoped shared worker pool, and the Security Constitution's git-sandbox "no network access" becomes "egress allowlisted to the configured remote host only". Argument-injection risk from invoking `git` is mitigated by array-form arguments, option/positional separators, and validation of all refs/paths/remotes, in addition to the sandbox boundary.
- **Binary assets** are tracked and round-tripped as opaque bytes; they have no collaborative-text representation and are not subject to text merge.
- **Conflict resolution** offers, per conflicting text file, a whole-file side choice (keep-local / take-incoming) or an inline three-way merge (base / local / incoming) to produce a combined result; conflicts in binary assets are resolved by choosing one side only (no merge).
- **Line endings / encoding**: Text is handled as UTF-8; repository line-ending normalization follows the repository's own configuration where present.
- **Existing scaffolding is reused**: The already-present (currently unwired) git connection model in the data layer is the intended foundation; this feature wires behavior onto it rather than introducing a parallel model.

## Out of Scope (Future Work)

Captured for future consideration; explicitly NOT part of this feature:

- **Provider pull/merge-request workflow**: creating PRs/MRs on the provider from a branch, protected-branch enforcement, and branch comparison views. (Considered and deferred during clarification.)
- **Signed commits** (GPG/SSH commit signing).
- **Hunk/line-level partial staging** within a single file (staging is per-file in this version).
- **SSH-key transport** and providers beyond GitHub/GitLab/Bitbucket.
- **Multiple remotes per project** and read-only mirrors.
- **Continuous automatic two-way sync** (background auto-commit/auto-push); sync remains user-initiated aside from the background *fetch/status* refresh in FR-038/FR-039.
- **Submodules / monorepo sparse-checkout** management.
