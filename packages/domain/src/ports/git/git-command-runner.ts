import { ProjectId } from '../../value-objects/ids/project-id';
import { GitOperationId } from '../../value-objects/ids/git-operation-id';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../errors/git/authentication-failed';
import { RemoteAlreadyInitializedError } from '../../errors/git/remote-already-initialized';
import { NonFastForwardError } from '../../errors/git/non-fast-forward';
import { CommitAlreadyPushedError } from '../../errors/git/commit-already-pushed';
import { RepositoryTooLargeError } from '../../errors/git/repository-too-large';
import { ConflictResolution } from '../../types/conflict-resolution';
import { Result } from '../../types/result';

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

/** What an amend records. Like a commit, but `message` is optional — absent means keep the amended
 *  commit's existing message. `flush` carries the live text of any staged open documents, same as commit. */
export interface GitAmendInput {
  readonly message?: string;
  readonly author: GitCommitAuthor;
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

/** One commit as read from a project's git history: the raw author identity is an email — mapping it
 *  to a platform user is a domain concern, not the runner's. Newest-first ordering is the adapter's contract. */
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

/** One line of a file's blame: which commit last touched it, by whom (a raw git author email — mapping it to a
 *  platform user is a domain concern, not the runner's), when, and the line's text. */
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

/** What to diff. `from`+`to` → between two commits; neither → uncommitted working changes vs HEAD.
 *  `path` scopes to one project-relative file (whole tree when absent). `currentContent`, only meaningful
 *  in the uncommitted mode, overrides that single file's working-tree content with the live editor content
 *  so an open file diffs its live text rather than its stale on-disk copy. */
export interface GitDiffInput {
  readonly path?: string;
  readonly from?: string;
  readonly to?: string;
  readonly currentContent?: { readonly path: string; readonly content: string };
}

/** A rendered diff. Rendering is a client concern: the runner supplies only the raw unified-diff text. */
export interface GitDiffResult {
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

/** What to discard/restore. `paths` are project-relative (no leading slash). Without `fromCommit`, each path's
 *  working-tree changes are dropped back to HEAD (a plain discard); with `fromCommit`, each path is restored to
 *  its content at that commit. */
export interface GitDiscardInput {
  readonly paths: readonly string[];
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

/**
 * Port for running scoped git actions against a project's sandboxed working tree.
 *
 * The real adapter (`apps/git-worker`) runs the actual `git` CLI via `execFile` inside a
 * sandboxed container; this interface is the hard boundary that keeps every git-library
 * type (e.g. `simple-git`) out of the domain. Every method returns either a domain-owned
 * type shaped to match its `packages/shared` DTO counterpart, or a `Result`-wrapped typed
 * error — never a raw git-library value.
 *
 * This is a foundational, deliberately minimal port: only the read-only status query
 * needed to unblock the earliest git use cases is defined here. Story tasks extend this
 * interface with the mutating and history/diff operations it will eventually cover
 * (clone, stage, commit, push, fetch, merge, branch, checkout, stash, log, diff, ...) as
 * each is built — add new methods here alongside a corresponding in-memory fake method.
 */
export interface GitCommandRunner {
  /**
   * Reads the working tree's current branch and its pending (uncommitted) changes.
   *
   * @param projectId - The project whose working tree to inspect.
   * @returns The current branch and pending changes, or a `GitCommandFailedError` when
   *   the working tree cannot be read (for example, it has not been initialized yet).
   */
  getStatus(projectId: ProjectId): Promise<Result<GitWorkingTreeStatus, GitCommandFailedError>>;

  /**
   * Verifies that a remote can be reached and that the given token authenticates against it,
   * without cloning or otherwise materializing a working tree. This is the connectivity/auth check
   * `ConnectRepository` (and other remote-connecting use cases) runs before a credential is ever
   * stored, so a bad remote URL or a rejected token is never persisted.
   *
   * @param check - The remote URL and the plaintext token to check it with.
   * @returns Success once the remote is reachable and the token was accepted; a
   *   `RepositoryUnreachableError` when the remote itself could not be reached, or an
   *   `AuthenticationFailedError` when it was reached but rejected the token.
   */
  checkRemoteAccess(
    check: GitRemoteAccessCheck,
  ): Promise<Result<void, RepositoryUnreachableError | AuthenticationFailedError>>;

  /**
   * Clones a remote's branch (its default branch when none is given) into a scratch working tree
   * and returns every tracked file it contains. Used by `ImportRepository` to materialize a
   * brand-new project's file tree from an external remote — this call does not touch any
   * project's own working tree or storage; translating the returned entries into that project's
   * `FileNode`/`Document`/`Asset` rows and stored bytes is the caller's job.
   *
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to
   *   clone (defaults to the remote's default branch).
   * @returns The cloned repository's files and the branch/commit they were cloned at; a
   *   `RepositoryUnreachableError`/`AuthenticationFailedError` on the same terms as
   *   {@link checkRemoteAccess}, a `RepositoryTooLargeError` when the cloned working tree exceeds
   *   the configured size ceiling, or a `GitCommandFailedError` for any other failure.
   */
  clone(
    input: GitCloneInput,
  ): Promise<
    Result<
      ClonedRepository,
      RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError | RepositoryTooLargeError
    >
  >;

  /**
   * Stages the given files for the next commit (the real adapter runs `git add -- <paths>` inside
   * the project's sandboxed working tree).
   *
   * @param projectId - The project whose working tree to stage files in.
   * @param paths - Workspace-relative POSIX paths, no leading slash, of the files to stage.
   * @returns Success once the files are staged; a `GitCommandFailedError` when the underlying git
   *   command fails (for example, a path does not exist in the working tree).
   */
  stage(projectId: ProjectId, paths: readonly string[]): Promise<Result<void, GitCommandFailedError>>;

  /**
   * Unstages the given files, leaving their working-tree contents untouched (the real adapter runs
   * `git reset -- <paths>` inside the project's sandboxed working tree).
   *
   * @param projectId - The project whose working tree to unstage files in.
   * @param paths - Workspace-relative POSIX paths, no leading slash, of the files to unstage.
   * @returns Success once the files are unstaged; a `GitCommandFailedError` when the underlying git
   *   command fails.
   */
  unstage(projectId: ProjectId, paths: readonly string[]): Promise<Result<void, GitCommandFailedError>>;

  /**
   * Records a commit of the currently staged index — a whole-project mutating action.
   *
   * Adapter contract (the real adapter must implement exactly this ordering, so the commit
   * captures live collaborative content rather than stale staged bytes):
   *
   * 1. For EACH `input.flush` entry, in order: write its `content` to the working-tree file at its
   *    `path`, THEN run `git add -- <path>` to re-stage it. Re-adding is mandatory: the file was
   *    already staged, so its live text only reaches the commit if the index is refreshed after the
   *    write. A naive flush-then-commit that writes the files but skips the `git add` would commit
   *    the STALE bytes the index captured when the file was first staged — the exact stale-content
   *    bug this flush exists to prevent.
   * 2. Run `git commit` with `input.message` and `input.author` as the author/committer. This
   *    commits the INDEX, which means: only staged files are committed (staged-only); a staged file
   *    absent from `flush` keeps the version already in its index; and unstaged/untracked files —
   *    never written and never added here — stay out of the commit entirely.
   *
   * The runner does not decide what to flush or which files are staged; the caller resolves that and
   * hands over a fully-formed `flush` list. The runner only writes those bytes, re-stages them, and
   * commits.
   *
   * @param projectId - The project whose staged index to commit.
   * @param input - The message, author, and the live-content flush list described above.
   * @returns The new commit on success; a `GitCommandFailedError` when the underlying git
   *   command (write, add, or commit) fails.
   */
  commit(projectId: ProjectId, input: GitCommitInput): Promise<Result<GitCommitResult, GitCommandFailedError>>;

  /**
   * Amends the most-recent commit — folding the currently-staged changes (with any live text supplied via
   * `flush`) into it and, when `message` is given, replacing its message. A purely local operation — no network.
   *
   * Adapter contract (implemented later in the worker): first verify the current HEAD is NOT already present on
   * the remote-tracking branch; if it is, make no change and return {@link CommitAlreadyPushedError}. Otherwise
   * flush the supplied live content over the staged files, then `git commit --amend` (keeping the existing
   * message when `message` is absent, `--message` it when present) with the given author identity. Returns the
   * amended commit's new hash/message/authored date.
   *
   * @param projectId - The project whose most-recent commit to amend.
   * @param input - The optional replacement message, the author, and the live-content flush list.
   * @returns The amended commit on success; a {@link CommitAlreadyPushedError} when the current commit is
   *   already present on the remote-tracking branch, or a `GitCommandFailedError` for any other failure.
   */
  amendCommit(projectId: ProjectId, input: GitAmendInput): Promise<Result<GitCommitResult, GitAmendError>>;

  /**
   * Pushes the project's current branch to its remote (the real adapter runs `git push` inside the
   * project's sandboxed working tree, authenticating out-of-band with `input.token` — never via
   * argv, the same convention {@link clone} and {@link checkRemoteAccess} follow).
   *
   * Adapter contract: a push git rejects as non-fast-forward (`! [rejected] ... (non-fast-forward)`
   * / `(fetch first)` — the remote has commits this branch does not) is classified into
   * {@link NonFastForwardError}, distinct from the remote being unreachable at all
   * ({@link RepositoryUnreachableError}) or rejecting the credential ({@link AuthenticationFailedError}).
   *
   * @param projectId - The project whose working tree to push from.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to push.
   * @returns The remote branch's new tip commit on success; a {@link NonFastForwardError} when the
   *   remote has commits this branch does not, a {@link RepositoryUnreachableError}/
   *   {@link AuthenticationFailedError} on the same terms as {@link checkRemoteAccess}, or a
   *   {@link GitCommandFailedError} for any other failure.
   */
  push(projectId: ProjectId, input: GitPushInput): Promise<Result<GitPushResult, GitPushError>>;

  /**
   * Initializes git on an existing (previously non-git) project's real working tree and publishes
   * it to a fresh, empty remote, atomically: the whole init → remote-add → initial-commit → push
   * sequence is one adapter call so the all-or-nothing boundary between "not published" and
   * "published" stays in a single place, rather than being split across several port calls a
   * use case would otherwise have to sequence and unwind itself.
   *
   * Adapter contract (the real adapter must implement exactly this ordering):
   *
   * 1. FIRST verify the remote has no commits at all (e.g. `git ls-remote <remoteUrl>`, authenticated
   *    out-of-band with `input.token`). If it reports ANY ref/commit, do NOTHING else — no local
   *    `git init`, no working-tree mutation — and return {@link RemoteAlreadyInitializedError}. A
   *    non-empty remote must never be overwritten; the caller is expected to guide the user to
   *    import/pull that remote's existing history instead.
   * 2. Otherwise: `git init` the project's own working tree (not a scratch directory — this project
   *    was never git-managed before this call).
   * 3. `git remote add origin <input.remoteUrl>` (no credential in this step — the URL alone).
   * 4. Stage and commit every file currently in the working tree as the project's initial commit.
   * 5. `git push` that commit to `input.branch` (defaulting to the project's current branch, or
   *    `'main'` when that too is unset), authenticating out-of-band with `input.token` — never via
   *    argv, config, or logs, the same convention {@link clone} and {@link push} follow.
   *
   * On ANY failure at step 2 or later, the adapter leaves nothing half-published (no lingering
   * `origin` remote pointed at a repository this call did not finish publishing to); this is the
   * adapter's own responsibility, not something the caller can undo from the outside.
   *
   * @param projectId - The project whose working tree to initialize and publish.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to
   *   publish under.
   * @returns The initial commit's hash and the branch it was published under; a
   *   {@link RemoteAlreadyInitializedError} when the remote already has commits, a
   *   {@link RepositoryUnreachableError}/{@link AuthenticationFailedError} on the same terms as
   *   {@link checkRemoteAccess}, or a {@link GitCommandFailedError} for any other failure.
   */
  initializeAndPublish(
    projectId: ProjectId,
    input: GitInitializeInput,
  ): Promise<Result<GitInitializeOutcome, GitInitializeError>>;

  /**
   * Fetches a remote branch, updating only the local remote-tracking ref (`origin/<branch>`) — the
   * working tree and the local branch are never touched. Authenticates out-of-band with
   * `input.token`, the same convention {@link clone} and {@link push} follow.
   *
   * @param projectId - The project whose working tree's remote-tracking ref to update.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to fetch.
   * @returns The remote-tracking ref's new tip commit on success; a
   *   `RepositoryUnreachableError`/`AuthenticationFailedError` on the same terms as
   *   {@link checkRemoteAccess}, or a `GitCommandFailedError` for any other failure.
   */
  fetch(
    projectId: ProjectId,
    input: GitFetchInput,
  ): Promise<Result<GitFetchResult, RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError>>;

  /**
   * Compares a local branch against its already-fetched remote-tracking ref — a pure local
   * comparison that touches no network. Callers run {@link fetch} first when the remote-tracking
   * ref needs to be current.
   *
   * @param projectId - The project whose working tree to compare.
   * @param branch - The local branch to compare against its remote-tracking ref.
   * @returns How many commits each side has that the other lacks; a `GitCommandFailedError` when
   *   the underlying git command fails (for example, the branch has no remote-tracking ref yet).
   */
  getBehindAhead(projectId: ProjectId, branch: string): Promise<Result<GitBehindAhead, GitCommandFailedError>>;

  /**
   * Reads a project's commit history, newest first. With `path`, restricts to the commits that touched
   * that single project-relative file (its per-file history); without it, the whole project's history.
   * `limit`, when given, caps the number of commits returned. A purely local read — no network.
   *
   * Adapter contract (implemented later in the worker): run `git log` with a machine-readable format that
   * emits hash, author email, author date, and subject; when `path` is set, pass it as a positional after
   * `--end-of-options` (`git log … -- <path>`); apply `--max-count=<limit>` when `limit` is set. Returns the
   * entries newest-first; an empty history is an empty array, not an error.
   *
   * @param projectId - The project whose history to read.
   * @param options - `path` restricts to a single project-relative file's history; `limit` caps the
   *   number of commits returned.
   * @returns Every matching commit, newest first; a `GitCommandFailedError` when the underlying git
   *   command fails.
   */
  log(
    projectId: ProjectId,
    options: { readonly path?: string; readonly limit?: number },
  ): Promise<Result<GitLogEntry[], GitCommandFailedError>>;

  /**
   * Produces a unified diff. With `from` and `to`, diffs between those two commits; with neither, diffs the
   * uncommitted working changes against HEAD. `path`, when set, scopes the diff to that single project-relative
   * file (passed as a positional after `--end-of-options`). `currentContent` (uncommitted mode only) replaces
   * that one file's working-tree content with the given live text before diffing. A purely local read — no network.
   *
   * Adapter contract (implemented later in the worker): commit-vs-commit → `git diff <from> <to> [-- <path>]`;
   * uncommitted → `git diff HEAD [-- <path>]`; when `currentContent` is present, diff HEAD's blob of that path
   * against the supplied live text (e.g. via a temp file / `git diff --no-index`, worker's choice) so no stale
   * working-tree copy is read. An empty diff is an empty string, not an error.
   *
   * @param projectId - The project whose working tree (and/or history) to diff.
   * @param input - What to diff — two commits, or the uncommitted working changes, optionally scoped to one
   *   file, optionally overriding that file's content with live text.
   * @returns The unified diff text; a `GitCommandFailedError` when the underlying git command fails.
   */
  diff(projectId: ProjectId, input: GitDiffInput): Promise<Result<GitDiffResult, GitCommandFailedError>>;

  /**
   * Reads per-line authorship for a single project-relative file: for each line, the commit that last modified it,
   * its author email and date, and the line text. With `ref`, blames the file as of that commit; without it, the
   * current working-tree file. A purely local read — no network.
   *
   * Adapter contract (implemented later in the worker): run `git blame` in a machine-readable form (e.g.
   * `--porcelain`) for the file, passing the file path (and `ref` when set) as positionals after
   * `--end-of-options`; parse each line's commit hash, author email, author time, and text. Returns the lines in
   * file order (line 1 first).
   *
   * @param projectId - The project whose file to blame.
   * @param input - The project-relative file path, and the optional commit to blame it as of.
   * @returns Every line's authorship, in file order; a `GitCommandFailedError` when the underlying git command
   *   fails (for example, the path does not exist at the given ref).
   */
  blame(
    projectId: ProjectId,
    input: { readonly path: string; readonly ref?: string },
  ): Promise<Result<GitBlameLine[], GitCommandFailedError>>;

  /**
   * Runs a local three-way merge of the already-fetched remote-tracking ref into `input.branch`.
   * Touches no network — callers run {@link fetch} first so the remote-tracking ref is current.
   *
   * Adapter contract, matching {@link commit}: for EACH `input.flush` entry, in order, write its
   * `content` to the working-tree file at its `path` and `git add` it BEFORE the merge runs, so the
   * merge's local side reflects live collaborative content rather than stale working-tree bytes.
   *
   * @param projectId - The project whose working tree to merge into.
   * @param input - The branch to merge into and the live-content flush list described above.
   * @returns A {@link GitMergeOutcome} — `merged` with the resulting changes (empty when already up
   *   to date) or `conflicted` with the files left in conflict; a conflict is an expected outcome,
   *   never an error. Returns a `GitCommandFailedError` only when the underlying git command itself
   *   fails.
   */
  merge(projectId: ProjectId, input: GitMergeInput): Promise<Result<GitMergeOutcome, GitCommandFailedError>>;

  /**
   * Creates a new local branch from the working tree's current branch tip (the real adapter runs
   * `git branch <name>` inside the project's sandboxed working tree). This does not check the new
   * branch out — it only creates the ref; switching to it is a separate, later operation.
   *
   * @param projectId - The project whose working tree to create the branch in.
   * @param input - The new branch's name.
   * @returns The created branch on success; a `GitCommandFailedError` when the underlying git
   *   command fails (for example, a branch by that name already exists, or the name is not a
   *   valid git ref name).
   */
  createBranch(projectId: ProjectId, input: GitCreateBranchInput): Promise<Result<GitCreatedBranch, GitCommandFailedError>>;

  /**
   * Lists every local branch in the project's working tree, along with which one is currently
   * checked out (the real adapter runs something like `git branch --list` inside the project's
   * sandboxed working tree).
   *
   * @param projectId - The project whose working tree to list branches for.
   * @returns The current branch and every local branch name; a `GitCommandFailedError` when the
   *   underlying git command fails.
   */
  listBranches(projectId: ProjectId): Promise<Result<GitBranchList, GitCommandFailedError>>;

  /**
   * Switches the project's working tree to another local branch, landing that branch's content and
   * carrying in-progress live edits across the switch. Touches no network — a purely LOCAL operation,
   * like {@link merge}: no egress, no credential.
   *
   * Adapter contract (the real adapter must implement exactly this ordering, atomically):
   *
   * 1. For EACH `input.flush` entry, in order: write its `content` to the working-tree file at its
   *    `path` and `git add` it, materializing the current live collaborative edits as uncommitted
   *    working-tree state — the same flush contract and ordering as {@link commit} and {@link merge}.
   * 2. When `input.stashLocal` is true, `git stash push` to shelve those flushed edits so the switch
   *    can carry them onto the target branch. A no-op on a clean tree (nothing to shelve).
   * 3. `git checkout <input.branch>` to switch the working tree to the target branch.
   * 4. When step 2 stashed anything, `git stash pop` to re-apply the shelved edits onto the target
   *    branch. A pop that leaves conflict markers is the `conflicted` outcome carrying those conflict
   *    paths — an EXPECTED outcome, NEVER a `Result` error (mirrors {@link GitMergeOutcome}).
   * 5. On a clean switch, compute `changes` as the delta between the editors' pre-switch flushed state
   *    and the post-switch working tree, so the re-applied live edits are INCLUDED in `changes`, each
   *    carrying its `Buffer` content per {@link GitMergeFileChange}. `{status: 'switched', changes: []}`
   *    when the resulting tree is identical to the pre-switch flushed state.
   *
   * The runner does not decide what to flush or whether to stash; the caller resolves that and hands
   * over a fully-formed {@link GitCheckoutInput}.
   *
   * @param projectId - The project whose working tree to switch.
   * @param input - The target branch, the live-content flush list, and whether to carry local edits.
   * @returns A {@link GitCheckoutOutcome} — `switched` with the resulting changes (empty when the tree
   *   is unchanged) or `conflicted` with the files the stash-pop left in conflict; a conflict is an
   *   expected outcome, never an error. Returns a `GitCommandFailedError` only when the underlying git
   *   command itself fails (for example, the target branch does not exist).
   */
  checkout(projectId: ProjectId, input: GitCheckoutInput): Promise<Result<GitCheckoutOutcome, GitCommandFailedError>>;

  /**
   * Completes a previously-aborted conflicted `PULL` by RE-RUNNING the merge (recreating
   * `MERGE_HEAD`), dropping each file's chosen resolution onto its conflicted path, and taking a
   * genuine merge commit — the resolving commit that completing a conflicted merge requires. Re-running the
   * merge (rather than committing only the resolved files) also recovers whatever the remote
   * changed in files that were NOT in conflict, which the original abort discarded.
   *
   * Adapter contract: reset the working tree clean and capture `preHead`; `git merge --no-edit
   * <remoteRef>` (a clean auto-merge here is fine — nothing to resolve, skip straight to the
   * commit); apply each `input.resolutions` entry (`ours`/`theirs` via `git checkout --ours/--theirs
   * -- <path>` + `git add`, `merged` via the `ConflictStageStore`'s recorded bytes + `git add`);
   * verify no unmerged paths remain (else abort and return `stillConflicted`); `git commit --no-edit`
   * under the service identity; compute the change-set from `preHead` to the new head. Any throw
   * after the merge runs `git merge --abort` in a `finally`, so a failure here leaves the working
   * tree clean and the caller's operation untouched and retryable. Touches no network — a purely
   * LOCAL operation, like {@link merge}.
   *
   * @param projectId - The project whose working tree to complete the merge in.
   * @param input - The branch, the operation id (keys the `ConflictStageStore`), and every
   *   conflict's chosen resolution.
   * @returns A {@link GitResolveMergeOutcome}; a `GitCommandFailedError` only when a git command
   *   itself fails, or the `ConflictStageStore` read for a `merged` resolution fails.
   */
  resolveMerge(
    projectId: ProjectId,
    input: GitResolveMergeInput,
  ): Promise<Result<GitResolveMergeOutcome, GitCommandFailedError>>;

  /**
   * Restores the working tree to an operation's pre-operation undo snapshot (`git reset --hard
   * <preOpHead>`), undoing a pull or switch — whether it left the project `AWAITING_CONFLICT` or
   * already landed cleanly. Touches no network — a purely LOCAL operation, like {@link merge}.
   *
   * Adapter contract: read the snapshot from the `ConflictStageStore` by `input.operationId`;
   * capture the pre-reset `HEAD`; `git reset --hard <preOpHead>`; compute the reversal change-set as
   * the delta from the pre-reset `HEAD` to the now-reset working tree (the single-argument form of
   * the change-computing helper {@link merge} uses, mirroring how {@link checkout} computes its own
   * change-set) — the exact set the caller needs to revert docs/live editors.
   *
   * @param projectId - The project whose working tree to restore.
   * @param input - The operation whose snapshot to restore to.
   * @returns A {@link GitRestoreOutcome}; a `GitCommandFailedError` when no snapshot is recorded for
   *   the operation, its recorded commit is no longer resolvable, or the underlying git command
   *   fails.
   */
  restoreToSnapshot(
    projectId: ProjectId,
    input: GitRestoreToSnapshotInput,
  ): Promise<Result<GitRestoreOutcome, GitCommandFailedError>>;

  /**
   * Restores the given files in the working tree — dropping their uncommitted changes back to HEAD, or, with
   * `fromCommit`, to their content at that commit — and returns the resulting change-set for the caller to land
   * into the project. A purely local operation — no network.
   *
   * Adapter contract (implemented later in the worker): for a plain discard, restore each tracked path from HEAD
   * (`git checkout HEAD -- <path>` / `git restore`), and remove an untracked path (a `removed` change); with
   * `fromCommit`, restore each path from that commit (`git checkout <fromCommit> -- <path>`). Paths are positionals
   * after `--end-of-options`. Return each restored file as a `modified` (or `added`, if it was absent) change
   * carrying its now-current bytes and mime type, and each discarded untracked file as a `removed` change — the
   * change-set the reconciler applies. All-or-nothing: on any failure, leave the working tree as it was and return
   * a `GitCommandFailedError`.
   *
   * @param projectId - The project whose working tree to restore.
   * @param input - The paths to restore, and, optionally, the commit to restore them from.
   * @returns The resulting change-set on success; a `GitCommandFailedError` when the underlying git command fails.
   */
  discardChanges(
    projectId: ProjectId,
    input: GitDiscardInput,
  ): Promise<Result<GitMergeFileChange[], GitCommandFailedError>>;
}
