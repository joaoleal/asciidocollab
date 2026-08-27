import { ProjectId } from '../../value-objects/ids/project-id';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../errors/git/authentication-failed';
import { RepositoryTooLargeError } from '../../errors/git/repository-too-large';
import { Result } from '../../types/result';
import type {
  GitWorkingTreeStatus,
  GitRemoteAccessCheck,
  GitCloneInput,
  ClonedRepository,
  GitCommitInput,
  GitCommitResult,
  GitAmendInput,
  GitAmendError,
  GitPushInput,
  GitPushResult,
  GitPushError,
  GitInitializeInput,
  GitInitializeOutcome,
  GitInitializeError,
  GitFetchInput,
  GitFetchResult,
  GitBehindAhead,
  GitLogEntry,
  GitDiffInput,
  GitDiffResult,
  GitPreviewPullInput,
  GitPreviewPullResult,
  GitPreviewPushInput,
  GitPreviewPushResult,
  GitBlameLine,
  GitMergeInput,
  GitMergeOutcome,
  GitMergeFileChange,
  GitCreateBranchInput,
  GitCreatedBranch,
  GitBranchList,
  GitCheckoutInput,
  GitCheckoutOutcome,
  GitResolveMergeInput,
  GitResolveMergeOutcome,
  GitRestoreToSnapshotInput,
  GitRestoreOutcome,
  GitDiscardInput,
} from './git-command-types';

export type {
  GitWorkingTreeStatus,
  GitPendingChange,
  GitPendingChangeType,
  GitPendingChangeState,
  GitRemoteAccessCheck,
  GitCloneInput,
  ClonedFileEntry,
  ClonedRepository,
  GitCommitAuthor,
  GitCommitFlushEntry,
  GitCommitInput,
  GitCommitResult,
  GitPushInput,
  GitPushResult,
  GitPushError,
  GitInitializeInput,
  GitInitializeOutcome,
  GitInitializeError,
  GitFetchInput,
  GitFetchResult,
  GitBehindAhead,
  GitMergeInput,
  GitMergeFileChange,
  GitMergeConflictPath,
  GitMergeOutcome,
  GitCheckoutInput,
  GitCheckoutOutcome,
  GitBranchList,
  GitCreateBranchInput,
  GitCreatedBranch,
  GitConflictResolutionChoice,
  GitResolveMergeInput,
  GitResolveMergeOutcome,
  GitRestoreToSnapshotInput,
  GitRestoreOutcome,
  GitLogEntry,
  GitDiffInput,
  GitDiffResult,
  GitPreviewPullInput,
  GitPreviewPullResult,
  GitPreviewPushInput,
  GitPreviewPushResult,
  GitBlameLine,
  GitDiscardInput,
  GitAmendInput,
  GitAmendError,
} from './git-command-types';

/**
 * Read-only slice of the git port: status, history, diffs, previews, blame, branch
 * listing, and the remote reachability/auth check — every operation that inspects a
 * project's working tree or a remote without mutating either.
 */
export interface GitReadPort {
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
   * @param options.path - Restricts the history to commits touching this single project-relative file.
   * @param options.limit - Caps the number of commits returned.
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
   * working-tree copy is read. An empty diff is an empty string, not an error..
   *
   * @param projectId - The project whose working tree (and/or history) to diff.
   * @param input - What to diff — two commits, or the uncommitted working changes, optionally scoped to one
   *   file, optionally overriding that file's content with live text.
   * @returns The unified diff text; a `GitCommandFailedError` when the underlying git command fails.
   */
  diff(projectId: ProjectId, input: GitDiffInput): Promise<Result<GitDiffResult, GitCommandFailedError>>;

  /**
   * Previews what a {@link fetch}-then-merge pull would bring in, without changing anything beyond
   * the remote-tracking ref {@link fetch} itself already updates: fetches `input.branch` from the
   * remote (the same fetch {@link fetch} performs, authenticating out-of-band with `input.token`),
   * then reads the commits and touched paths between the local branch and that freshly-fetched ref.
   * A LIVE network read — the fetch is real, so the preview reflects the remote's current state —
   * but never merges, commits, or flushes anything.
   *
   * Adapter contract (implemented later in the worker): fetch exactly as {@link fetch} does, then
   * `git log`/`git diff --name-only` over `HEAD..<the freshly-fetched remote-tracking ref>`, in the
   * same `-z`/`%H%x00%ae%x00%aI%x00%s` format {@link log} uses.
   *
   * @param projectId - The project whose incoming changes to preview.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to preview.
   * @returns The incoming commits (newest first) and the paths they touch; a
   *   `RepositoryUnreachableError`/`AuthenticationFailedError` on the same terms as {@link fetch}, or
   *   a `GitCommandFailedError` for any other failure.
   */
  previewPull(
    projectId: ProjectId,
    input: GitPreviewPullInput,
  ): Promise<
    Result<GitPreviewPullResult, GitCommandFailedError | RepositoryUnreachableError | AuthenticationFailedError>
  >;

  /**
   * Previews what a push would send out, without changing anything: reads the commits and touched
   * paths between the already-fetched remote-tracking ref and the local branch. Purely local — no
   * network, no credential; a caller wanting a fresh comparison against the remote should
   * {@link fetch} first.
   *
   * Adapter contract (implemented later in the worker): `git log`/`git diff --name-only` over
   * `<remote-tracking ref>..HEAD`. When the branch has no remote-tracking ref yet (never fetched or
   * pushed), degrades gracefully to an empty result (`{incoming: [], changedPaths: []}`-shaped, here
   * `{outgoing: [], changedPaths: []}`) rather than failing — there is nothing yet to compare
   * against, which is not itself an error.
   *
   * @param projectId - The project whose outgoing changes to preview.
   * @param input - The branch to preview.
   * @returns The outgoing commits (newest first) and the paths they touch; a `GitCommandFailedError`
   *   when the underlying git command fails for a reason other than a missing remote-tracking ref.
   */
  previewPush(
    projectId: ProjectId,
    input: GitPreviewPushInput,
  ): Promise<Result<GitPreviewPushResult, GitCommandFailedError>>;

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
   * @param input.path - The project-relative file path to blame.
   * @param input.ref - The commit to blame the file as of; the current working-tree file when omitted.
   * @returns Every line's authorship, in file order; a `GitCommandFailedError` when the underlying git command
   *   fails (for example, the path does not exist at the given ref).
   */
  blame(
    projectId: ProjectId,
    input: { readonly path: string; readonly ref?: string },
  ): Promise<Result<GitBlameLine[], GitCommandFailedError>>;

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
}

/**
 * Local-mutation slice of the git port: staging, committing, merging, branching,
 * checkout, conflict resolution, and working-tree restore/discard — every operation
 * that changes a project's own working tree or index without touching the network.
 */
export interface GitMutationPort {
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

/**
 * Network slice of the git port: clone, push, initialize-and-publish, and fetch — every
 * operation that reaches a remote, authenticating out-of-band with a plaintext token.
 */
export interface GitRemotePort {
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
export interface GitCommandRunner extends GitReadPort, GitMutationPort, GitRemotePort {}
