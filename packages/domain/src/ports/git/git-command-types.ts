import { GitOperationId } from '../../value-objects/ids/git-operation-id';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../errors/git/authentication-failed';
import { RemoteAlreadyInitializedError } from '../../errors/git/remote-already-initialized';
import { NonFastForwardError } from '../../errors/git/non-fast-forward';
import { CommitAlreadyPushedError } from '../../errors/git/commit-already-pushed';
import { ConflictResolution } from '../../types/conflict-resolution';

/**
 * The kind of working-tree change a pending change represents. `renamed` is the
 * canonical label for a move as well as a rename — there is no separate `moved` value.
 */
export type GitPendingChangeType = 'added' | 'modified' | 'removed' | 'renamed' | 'copied';

/**
 * Where a pending change currently stands in the working tree/index. `conflicted` names a
 * change left unresolved by a merge or rebase; no use case in this package produces it yet — it
 * exists now so a later merge/pull story can populate it without another type change.
 */
export type GitPendingChangeState = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

/**
 * A single working-tree change, awaiting commit, and where it currently stands
 * (`state`) — staged for the next commit, an unstaged edit to a tracked file, a brand-new
 * file never `git add`-ed, or left conflicted by an unresolved merge.
 */
export interface GitPendingChange {
  /** Project-relative path of the changed file. */
  readonly path: string;
  /** The kind of change. */
  readonly changeType: GitPendingChangeType;
  /** Where this change currently stands in the working tree/index. */
  readonly state: GitPendingChangeState;
}

/** A project's working tree: its current branch and its uncommitted changes. */
export interface GitWorkingTreeStatus {
  /** The currently checked-out branch. */
  readonly currentBranch: string;
  /** Every pending (uncommitted) change, staged or not. */
  readonly changes: readonly GitPendingChange[];
}

/** Input for {@link GitCommandRunner.checkRemoteAccess}. */
export interface GitRemoteAccessCheck {
  /** The remote's URL, exactly as the caller supplied it. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Used only for this check, never persisted. */
  readonly token: string;
}

/** Input for {@link GitCommandRunner.clone}. */
export interface GitCloneInput {
  /** The remote's URL, exactly as the caller supplied it. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Used only for this call, never persisted. */
  readonly token: string;
  /** The branch to check out, or the remote's default branch when omitted. */
  readonly branch?: string;
}

/**
 * One file a clone produced: its path (workspace-relative, POSIX separators, no leading slash —
 * e.g. `chapters/intro.adoc`) and its bytes, exactly as the remote's default (or requested) branch
 * has them. `.git/` and LFS plumbing (`.gitattributes`) are resolved by the runner — an LFS pointer
 * is smudged to the real object's bytes before this entry is produced, so a caller never has to
 * recognize or special-case a pointer file — but nothing here excludes internal platform paths
 * (e.g. `.collab/`); doing that is the caller's responsibility, the same way it decides everything
 * else about how the bytes become a project.
 */
export interface ClonedFileEntry {
  /** Workspace-relative path, POSIX separators, no leading slash. */
  readonly path: string;
  /** The file's bytes, already resolved past any LFS pointer. */
  readonly content: Buffer;
  /** Best-effort MIME type for the file, as the runner determined it. */
  readonly mimeType: string;
}

/** What a completed clone produced: every tracked file, and the remote state it was cloned at. */
export interface ClonedRepository {
  /** The remote's default branch (what its `HEAD` points to). */
  readonly defaultBranch: string;
  /** The commit hash of the branch that was cloned, as observed at clone time. */
  readonly headCommit: string;
  /** Every tracked file the clone produced. Directories are implicit in each entry's path. */
  readonly entries: readonly ClonedFileEntry[];
}

/** The identity a commit is attributed to. */
export interface GitCommitAuthor {
  /** The author's display name, written into the commit's author/committer field. */
  readonly name: string;
  /** The author's email address, written into the commit's author/committer field. */
  readonly email: string;
}

/**
 * A single file whose live collaborative content must overwrite its working-tree copy before the
 * commit is taken. `path` is the workspace-relative POSIX path with NO leading slash (e.g.
 * `chapters/intro.adoc`); `content` is the current live UTF-8 text captured from the file's
 * collaborative room.
 */
export interface GitCommitFlushEntry {
  /** Workspace-relative POSIX path, no leading slash, of the file to overwrite then re-stage. */
  readonly path: string;
  /** The live UTF-8 text to write to that file before committing. */
  readonly content: string;
}

/** Everything {@link GitCommandRunner.commit} needs to record one commit. */
export interface GitCommitInput {
  /** The commit message. The caller guarantees it is non-empty. */
  readonly message: string;
  /** The identity to attribute the commit to (the triggering user). */
  readonly author: GitCommitAuthor;
  /**
   * The staged files whose live collaborative text must replace their working-tree copy before the
   * commit, so the commit captures what collaborators currently see rather than the older bytes the
   * index already holds. Only staged files with live content appear here; a staged file with no
   * live session, and every unstaged file, is absent — the adapter must not touch those.
   */
  readonly flush: readonly GitCommitFlushEntry[];
}

/** What a completed commit produced. */
export interface GitCommitResult {
  /** The new commit's hash. */
  readonly hash: string;
  /** The commit message, as recorded. */
  readonly message: string;
  /** When the commit was authored. */
  readonly authoredAt: Date;
}

/**
 * What an amend records. Like a commit, but `message` is optional — absent means keep the amended
 *  commit's existing message. `flush` carries the live text of any staged open documents, same as commit.
 */
export interface GitAmendInput {
  /** The replacement commit message, or the amended commit's existing message when omitted. */
  readonly message?: string;
  /** The identity to attribute the amended commit to. */
  readonly author: GitCommitAuthor;
  /** The staged files whose live collaborative text must replace their working-tree copy before the amend, same contract as {@link GitCommitInput.flush}. */
  readonly flush: readonly GitCommitFlushEntry[];
}

/** Amend can be refused because the target commit is already published (peer of GitCommandFailedError). */
export type GitAmendError = GitCommandFailedError | CommitAlreadyPushedError;

/** Everything {@link GitCommandRunner.push} needs to push a branch to its remote. */
export interface GitPushInput {
  /** The remote's URL, exactly as stored on the project's `GitRepository` link. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Used only for this call, never persisted or logged. */
  readonly token: string;
  /** The local branch to push (and the remote branch it pushes to, by the same name). */
  readonly branch: string;
}

/** What a completed push produced. */
export interface GitPushResult {
  /** The commit now at the tip of the remote branch, after the push landed. */
  readonly headCommit: string;
}

/** Every typed way {@link GitCommandRunner.push} can fail. */
export type GitPushError =
  | GitCommandFailedError
  | NonFastForwardError
  | RepositoryUnreachableError
  | AuthenticationFailedError;

/** Everything {@link GitCommandRunner.initializeAndPublish} needs to publish an existing project onto a fresh, empty remote. */
export interface GitInitializeInput {
  /** The remote's URL to publish onto. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Used only for this call, never persisted or logged. */
  readonly token: string;
  /** The branch to publish under. Defaults to the project's current branch (or `'main'`) when omitted. */
  readonly branch?: string;
}

/** What a completed {@link GitCommandRunner.initializeAndPublish} call produced. */
export interface GitInitializeOutcome {
  /** The hash of the initial commit now at the tip of the pushed branch. */
  readonly headCommit: string;
  /** The branch the project was published under. */
  readonly defaultBranch: string;
}

/** Every typed way {@link GitCommandRunner.initializeAndPublish} can fail. */
export type GitInitializeError =
  | RemoteAlreadyInitializedError
  | RepositoryUnreachableError
  | AuthenticationFailedError
  | GitCommandFailedError;

/** Everything {@link GitCommandRunner.fetch} needs to update a project's remote-tracking ref. */
export interface GitFetchInput {
  /** The remote's URL, exactly as stored on the project's `GitRepository` link. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Used only for this call, never persisted or logged. */
  readonly token: string;
  /** The remote branch whose tracking ref to update. */
  readonly branch: string;
}

/** What a completed fetch produced. */
export interface GitFetchResult {
  /** The tip of `origin/<branch>` after the fetch, i.e. the remote-tracking ref's new commit. */
  readonly remoteHead: string;
}

/** How far a local branch stands from its already-fetched remote-tracking ref. */
export interface GitBehindAhead {
  /** The number of commits the remote-tracking ref has that the local branch does not. */
  readonly behind: number;
  /** The number of commits the local branch has that the remote-tracking ref does not. */
  readonly ahead: number;
}

/**
 * One commit as read from a project's git history: the raw author identity is an email — mapping it
 *  to a platform user is a domain concern, not the runner's. Newest-first ordering is the adapter's contract.
 */
export interface GitLogEntry {
  /** The full commit hash. */
  readonly hash: string;
  /** The commit's subject/message. */
  readonly message: string;
  /** The commit author's email, exactly as recorded in git (may map to no platform user). */
  readonly authorEmail: string;
  /** When the commit was authored. */
  readonly authoredAt: Date;
}

/**
 * One line of a file's blame: which commit last touched it, by whom (a raw git author email — mapping it to a
 *  platform user is a domain concern, not the runner's), when, and the line's text.
 */
export interface GitBlameLine {
  /** 1-based line number in the blamed file. */
  readonly lineNumber: number;
  /** The full hash of the commit that last modified this line. */
  readonly hash: string;
  /** The author email recorded on that commit (may map to no platform user). */
  readonly authorEmail: string;
  /** When that commit was authored. */
  readonly authoredAt: Date;
  /** The line's text content. */
  readonly content: string;
}

/** Input for {@link GitCommandRunner.previewPull}. */
export interface GitPreviewPullInput {
  /** The remote's URL, exactly as stored on the project's `GitRepository` link. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Used only for this call, never persisted or logged. */
  readonly token: string;
  /** The branch to preview incoming changes for. */
  readonly branch: string;
}

/** What a completed {@link GitCommandRunner.previewPull} call produced: what a pull would bring in, without applying it. */
export interface GitPreviewPullResult {
  /** Commits that would land locally, newest first, if the pull actually ran. */
  readonly incoming: readonly GitLogEntry[];
  /** Every path those commits touch. */
  readonly changedPaths: readonly string[];
}

/** Input for {@link GitCommandRunner.previewPush}. */
export interface GitPreviewPushInput {
  /** The branch to preview outgoing changes for. */
  readonly branch: string;
}

/** What a completed {@link GitCommandRunner.previewPush} call produced: what a push would send out, without applying it. */
export interface GitPreviewPushResult {
  /** Commits that would land on the remote, newest first, if the push actually ran. */
  readonly outgoing: readonly GitLogEntry[];
  /** Every path those commits touch. */
  readonly changedPaths: readonly string[];
}

/**
 * What to diff. `from`+`to` → between two commits; neither → uncommitted working changes vs HEAD.
 *  `path` scopes to one project-relative file (whole tree when absent). `currentContent`, only meaningful
 *  in the uncommitted mode, overrides that single file's working-tree content with the live editor content
 *  so an open file diffs its live text rather than its stale on-disk copy.
 */
export interface GitDiffInput {
  /** The project-relative file to scope the diff to (the whole tree when omitted). */
  readonly path?: string;
  /** The earlier commit to diff from (commit-vs-commit mode only). */
  readonly from?: string;
  /** The later commit to diff to (commit-vs-commit mode only). */
  readonly to?: string;
  /** Overrides `path`'s working-tree content with this live text (uncommitted mode only). */
  readonly currentContent?: { readonly path: string; readonly content: string };
}

/** A rendered diff. Rendering is a client concern: the runner supplies only the raw unified-diff text. */
export interface GitDiffResult {
  /** The raw unified-diff text. */
  readonly unified: string;
}

/** Everything {@link GitCommandRunner.merge} needs to merge a fetched remote-tracking ref into a branch. */
export interface GitMergeInput {
  /** The local branch to merge the remote-tracking ref into. */
  readonly branch: string;
  /**
   * Live collaborative text written to the working tree and `git add`-ed BEFORE the merge runs,
   * forming the local side of the three-way merge. Same contract and adapter ordering as
   * {@link GitCommitInput.flush}.
   */
  readonly flush: readonly GitCommitFlushEntry[];
  /**
   * The queued operation this merge is running. Keys the pre-operation undo snapshot the adapter
   * records (on both a clean and a conflicted outcome), and the three-way conflict stages it
   * captures before aborting a conflicted merge.
   */
  readonly operationId: GitOperationId;
}

/**
 * One file a clean merge changed. Carries the merged bytes (mirroring {@link ClonedFileEntry})
 * because the git worktree root differs from the domain's `ProjectFileStore` root — the domain
 * cannot read the merged bytes off disk itself.
 */
export type GitMergeFileChange =
  | { readonly type: 'added'; readonly path: string; readonly content: Buffer; readonly mimeType: string }
  | { readonly type: 'modified'; readonly path: string; readonly content: Buffer; readonly mimeType: string }
  | { readonly type: 'removed'; readonly path: string }
  | {
      readonly type: 'renamed';
      readonly fromPath: string;
      readonly toPath: string;
      readonly content: Buffer;
      readonly mimeType: string;
    };

/** One file left conflicted by a merge. */
export interface GitMergeConflictPath {
  /** Workspace-relative POSIX path, no leading slash, of the conflicted file. */
  readonly path: string;
  /** Whether the conflicted file is binary (and so cannot be shown as a textual diff/conflict marker). */
  readonly isBinary: boolean;
}

/**
 * The outcome of a {@link GitCommandRunner.merge} call. A conflict is an EXPECTED outcome of a
 * merge, not a failure — it is represented here as the `conflicted` variant, never as a
 * `Result` error. "Already up to date" is represented as `{ status: 'merged', changes: [] }`;
 * there is no separate variant for it.
 */
export type GitMergeOutcome =
  | { readonly status: 'merged'; readonly headCommit: string; readonly changes: readonly GitMergeFileChange[] }
  | { readonly status: 'conflicted'; readonly conflicts: readonly GitMergeConflictPath[] };

/** Everything {@link GitCommandRunner.checkout} needs to switch a project's working tree to another local branch. */
export interface GitCheckoutInput {
  /** The local branch to switch the working tree to. */
  readonly branch: string;
  /**
   * Live collaborative text written to the working tree and `git add`-ed BEFORE the switch,
   * materializing current live edits as uncommitted working-tree state. Same contract and adapter
   * ordering as {@link GitMergeInput.flush}.
   */
  readonly flush: readonly GitCommitFlushEntry[];
  /**
   * When true, the flushed live edits are shelved before the switch and re-applied after, carrying
   * them onto the target branch. A no-op on a clean tree (nothing to shelve).
   */
  readonly stashLocal: boolean;
  /**
   * The queued operation this switch is running. Keys the pre-operation undo snapshot the adapter
   * records (on both a clean and a conflicted outcome), and the three-way conflict stages it
   * captures before discarding a stash-pop conflict.
   */
  readonly operationId: GitOperationId;
}

/**
 * The outcome of a {@link GitCommandRunner.checkout} call. A conflict (the re-applied live edits did
 * not merge cleanly onto the target branch) is an EXPECTED outcome, never a `Result` error — it is
 * represented here as the `conflicted` variant, mirroring {@link GitMergeOutcome}. A switch that
 * leaves the tree unchanged is `{status: 'switched', changes: []}`; there is no separate variant for
 * it. The `switched` variant reuses {@link GitMergeFileChange}/{@link GitMergeConflictPath} so a
 * switch's landed change-set is indistinguishable from a merge's.
 */
export type GitCheckoutOutcome =
  | { readonly status: 'switched'; readonly headCommit: string; readonly changes: readonly GitMergeFileChange[] }
  | { readonly status: 'conflicted'; readonly conflicts: readonly GitMergeConflictPath[] };

/** A project's branches: the checked-out branch plus every local branch name. */
export interface GitBranchList {
  /** The currently checked-out branch. */
  readonly current: string;
  /** Every local branch name. */
  readonly branches: readonly string[];
}

/** Input for {@link GitCommandRunner.createBranch}. */
export interface GitCreateBranchInput {
  /** The new branch's name. */
  readonly name: string;
}

/** The branch a {@link GitCommandRunner.createBranch} call produced. */
export interface GitCreatedBranch {
  /** The new branch's name, as created. */
  readonly name: string;
}

/**
 * One conflicted file's chosen resolution, as a completion use case hands it to
 * {@link GitCommandRunner.resolveMerge}. The `merged` bytes themselves are NOT carried here — the
 * runner reads them from the `ConflictStageStore` by `(operationId, path)`, so large/binary content
 * never crosses this port.
 */
export interface GitConflictResolutionChoice {
  /** Workspace-relative POSIX path, no leading slash, of the conflicted file. */
  readonly path: string;
  /** The chosen resolution for this file. */
  readonly resolution: ConflictResolution;
}

/** Everything {@link GitCommandRunner.resolveMerge} needs to complete a previously-aborted conflicted pull. */
export interface GitResolveMergeInput {
  /** The local branch the original merge ran against. */
  readonly branch: string;
  /** The conflicted `PULL` operation being completed. Keys the `ConflictStageStore` reads. */
  readonly operationId: GitOperationId;
  /** Every conflicting file's chosen resolution. The caller guarantees this covers every conflict. */
  readonly resolutions: readonly GitConflictResolutionChoice[];
}

/**
 * The outcome of a {@link GitCommandRunner.resolveMerge} call. Mirrors {@link GitMergeOutcome}'s
 * shape: `resolved` on a completed merge (with the resolving commit and the full landed
 * change-set); `stillConflicted` when some path was left unresolved by the given choices — a
 * caller/validation bug, since the caller guarantees a full set, but represented as a normal
 * outcome rather than a thrown error. A genuine git failure is the `Result` error instead.
 */
export type GitResolveMergeOutcome =
  | { readonly status: 'resolved'; readonly headCommit: string; readonly changes: readonly GitMergeFileChange[] }
  | { readonly status: 'stillConflicted'; readonly conflicts: readonly GitMergeConflictPath[] };

/**
 * What to discard/restore. `paths` are project-relative (no leading slash). Without `fromCommit`, each path's
 *  working-tree changes are dropped back to HEAD (a plain discard); with `fromCommit`, each path is restored to
 *  its content at that commit.
 */
export interface GitDiscardInput {
  /** Project-relative paths (no leading slash) to discard/restore. */
  readonly paths: readonly string[];
  /** The commit to restore each path from; without it, each path drops back to HEAD. */
  readonly fromCommit?: string;
}

/** Input for {@link GitCommandRunner.restoreToSnapshot}. */
export interface GitRestoreToSnapshotInput {
  /** The operation whose pre-operation undo snapshot to restore. The snapshot is read from the `ConflictStageStore`. */
  readonly operationId: GitOperationId;
}

/** What a completed {@link GitCommandRunner.restoreToSnapshot} call produced. */
export interface GitRestoreOutcome {
  /** The commit the working tree was restored to (the snapshot's `preOpHead`). */
  readonly headCommit: string;
  /** The reversal change-set: the tree after the reset compared against the tree before it, so the caller can revert docs/live editors. */
  readonly changes: readonly GitMergeFileChange[];
}
