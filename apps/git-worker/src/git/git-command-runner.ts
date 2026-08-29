import {
  type AuthenticationFailedError,
  type ClonedRepository,
  type ConflictStageStore,
  type GitAmendError,
  type GitAmendInput,
  type GitBehindAhead,
  type GitBlameLine,
  type GitBranchList,
  type GitCheckoutInput,
  type GitCheckoutOutcome,
  type GitCloneInput,
  type GitCommandFailedError,
  type GitCommandRunner,
  type GitCommitInput,
  type GitCommitResult,
  type GitCreateBranchInput,
  type GitCreatedBranch,
  type GitDiffInput,
  type GitDiffResult,
  type GitDiscardInput,
  type GitFetchInput,
  type GitFetchResult,
  type GitInitializeError,
  type GitInitializeInput,
  type GitInitializeOutcome,
  type GitLogEntry,
  type GitMergeFileChange,
  type GitMergeInput,
  type GitMergeOutcome,
  type GitPreviewPullInput,
  type GitPreviewPullResult,
  type GitPreviewPushInput,
  type GitPreviewPushResult,
  type GitPushError,
  type GitPushInput,
  type GitPushResult,
  type GitRemoteAccessCheck,
  type GitResolveMergeInput,
  type GitResolveMergeOutcome,
  type GitRestoreOutcome,
  type GitRestoreToSnapshotInput,
  type GitWorkingTreeStatus,
  type ProjectId,
  type RepositoryTooLargeError,
  type RepositoryUnreachableError,
  type Result,
} from '@asciidocollab/domain';
import { BranchOps } from './branch-ops.js';
import { type HostAddressResolver } from './egress-allowlist.js';
import { LocalReadOps } from './local-read-ops.js';
import { MergeConflictOps } from './merge-conflict-ops.js';
import { RemoteOps } from './remote-ops.js';
import { StagingOps } from './staging-ops.js';

export { deriveLfsEndpoint } from './git-command-helpers.js';

/**
 * Real `GitCommandRunner` adapter: runs the actual `git` CLI, through {@link runGitCommand}'s
 * secure `execFile` wrapper, against each project's working tree at
 * `<storageRoot>/<projectId>/`, mapping raw git output to this port's domain-owned types.
 * Git-library types never cross this boundary — this class is the only place in git-worker that
 * shells out to `git` for the operations it implements.
 *
 * The implementation is split across cohesive, single-responsibility collaborators
 * ({@link RemoteOps}, {@link StagingOps}, {@link MergeConflictOps}, {@link BranchOps},
 * {@link LocalReadOps}); this class is the thin facade that constructs them and delegates each port
 * method to the right one, so the rest of the app depends only on the {@link GitCommandRunner} port.
 */
export class RealGitCommandRunner implements GitCommandRunner {
  private readonly remoteOps: RemoteOps;
  private readonly stagingOps: StagingOps;
  private readonly mergeConflictOps: MergeConflictOps;
  private readonly branchOps: BranchOps;
  private readonly localReadOps: LocalReadOps;

  /**
   * @param storageRoot - Root directory for per-project storage.
   * @param allowedHosts - The configured git network egress allowlist (`git.egress.allowedHosts`).
   *   Defaults to empty (deny-by-default) so a caller that omits it can never reach a remote.
   *   Every method that reaches a remote (clone, fetch, push, ...) validates that remote's URL
   *   against this allowlist before running any network `git` command.
   * @param resolveHost - Overrides the DNS resolution the egress check validates a remote host's
   *   address against. Defaults to real DNS resolution; only ever overridden by tests.
   * @param conflictStageStore - Off-working-tree store {@link merge}/{@link checkout} write the
   *   pre-operation undo snapshot and captured three-way conflict stages to. Optional so a test
   *   exercising unrelated behavior need not construct one; the composition root always supplies a
   *   real one rooted OUTSIDE every project's working tree. When omitted, `merge`/`checkout` skip
   *   the snapshot/stage capture entirely (their conflicted/clean outcomes are unaffected).
   * @param maxRepoSizeMB - Maximum repository size, in megabytes, {@link clone} enforces against the
   *   cloned working tree (`git.maxRepoSizeMB`). Defaults to the same 500 MB default as
   *   `apps/api`'s schema, so a test that omits it still exercises realistic behavior.
   * @param lfsThresholdBytes - File size, in bytes, at or above which {@link stage} tracks a path
   *   with Git LFS before staging it (`git.lfsThresholdBytes`). Defaults to the same 10 MiB default
   *   as `apps/api`'s schema.
   */
  constructor(
    storageRoot: string,
    allowedHosts: readonly string[] = [],
    resolveHost?: HostAddressResolver,
    conflictStageStore?: ConflictStageStore,
    maxRepoSizeMB: number = 500,
    lfsThresholdBytes: number = 10_485_760,
  ) {
    this.remoteOps = new RemoteOps(storageRoot, allowedHosts, resolveHost, maxRepoSizeMB);
    this.stagingOps = new StagingOps(storageRoot, lfsThresholdBytes);
    this.mergeConflictOps = new MergeConflictOps(storageRoot, conflictStageStore);
    this.branchOps = new BranchOps(storageRoot);
    this.localReadOps = new LocalReadOps(storageRoot, allowedHosts, resolveHost);
  }

  /**
   * Gates a git network operation on the configured egress allowlist, rejecting before any `git`
   * process is spawned when the remote host is not allowed or resolves to a private/link-local
   * address. Delegates to {@link RemoteOps.assertRemoteAllowed}.
   *
   * @param remoteUrl - The remote URL the caller is about to contact.
   * @returns Resolves if the remote is allowed to be contacted; otherwise rejects.
   */
  async assertRemoteAllowed(remoteUrl: string): Promise<void> {
    return this.remoteOps.assertRemoteAllowed(remoteUrl);
  }

  /**
   * Reads the working tree's current branch and its pending (uncommitted) changes. Delegates to
   * {@link LocalReadOps.getStatus}.
   *
   * @param projectId - The project whose working tree to inspect.
   * @returns The current branch and pending changes, or a `GitCommandFailedError` when the working
   *   tree cannot be read.
   */
  async getStatus(projectId: ProjectId): Promise<Result<GitWorkingTreeStatus, GitCommandFailedError>> {
    return this.localReadOps.getStatus(projectId);
  }

  /**
   * Verifies a remote can be reached and that `check.token` authenticates against it. Delegates to
   * {@link RemoteOps.checkRemoteAccess}.
   *
   * @param check - The remote URL and the plaintext token to check it with.
   * @returns Success once the remote is reachable and the token was accepted; a
   *   `RepositoryUnreachableError`/`AuthenticationFailedError` otherwise.
   */
  async checkRemoteAccess(
    check: GitRemoteAccessCheck,
  ): Promise<Result<void, RepositoryUnreachableError | AuthenticationFailedError>> {
    return this.remoteOps.checkRemoteAccess(check);
  }

  /**
   * Clones a remote's branch into a temporary scratch tree and returns every tracked file it
   * contains. Delegates to {@link RemoteOps.clone}.
   *
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to
   *   clone (defaults to the remote's default branch).
   * @returns The cloned repository's files and the branch/commit they were cloned at; a
   *   `RepositoryUnreachableError`/`AuthenticationFailedError`, a `RepositoryTooLargeError`, or a
   *   `GitCommandFailedError` on failure.
   */
  async clone(
    input: GitCloneInput,
  ): Promise<
    Result<
      ClonedRepository,
      RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError | RepositoryTooLargeError
    >
  > {
    return this.remoteOps.clone(input);
  }

  /**
   * Stages the given files for the next commit, routing any large file through Git LFS first.
   * Delegates to {@link StagingOps.stage}.
   *
   * @param projectId - The project whose working tree to stage files in.
   * @param paths - Workspace-relative POSIX paths of the files to stage.
   * @returns Success once staged; a `GitCommandFailedError` when the underlying git command fails.
   */
  async stage(projectId: ProjectId, paths: readonly string[]): Promise<Result<void, GitCommandFailedError>> {
    return this.stagingOps.stage(projectId, paths);
  }

  /**
   * Unstages the given files, leaving their working-tree contents untouched. Delegates to
   * {@link StagingOps.unstage}.
   *
   * @param projectId - The project whose working tree to unstage files in.
   * @param paths - Workspace-relative POSIX paths of the files to unstage.
   * @returns Success once unstaged; a `GitCommandFailedError` when the underlying git command fails.
   */
  async unstage(projectId: ProjectId, paths: readonly string[]): Promise<Result<void, GitCommandFailedError>> {
    return this.stagingOps.unstage(projectId, paths);
  }

  /**
   * Records a commit of the currently staged index, first flushing live collaborative content into
   * the working tree. Delegates to {@link StagingOps.commit}.
   *
   * @param projectId - The project whose staged index to commit.
   * @param input - The message, author, and live-content flush list.
   * @returns The new commit on success; a `GitCommandFailedError` when a flush path is unsafe or the
   *   underlying git command fails.
   */
  async commit(projectId: ProjectId, input: GitCommitInput): Promise<Result<GitCommitResult, GitCommandFailedError>> {
    return this.stagingOps.commit(projectId, input);
  }

  /**
   * Amends the most-recent commit, refusing when it is already present on the remote-tracking
   * branch. Delegates to {@link StagingOps.amendCommit}.
   *
   * @param projectId - The project whose most-recent commit to amend.
   * @param input - The optional replacement message, the author, and the live-content flush list.
   * @returns The amended commit on success; a `CommitAlreadyPushedError` or a `GitCommandFailedError`
   *   on failure.
   */
  async amendCommit(projectId: ProjectId, input: GitAmendInput): Promise<Result<GitCommitResult, GitAmendError>> {
    return this.stagingOps.amendCommit(projectId, input);
  }

  /**
   * Pushes the project's current branch to its remote, authenticating out-of-band. Delegates to
   * {@link RemoteOps.push}.
   *
   * @param projectId - The project whose working tree to push from.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to push.
   * @returns The remote branch's new tip commit on success; a `NonFastForwardError`,
   *   `RepositoryUnreachableError`, `AuthenticationFailedError`, or `GitCommandFailedError` on failure.
   */
  async push(projectId: ProjectId, input: GitPushInput): Promise<Result<GitPushResult, GitPushError>> {
    return this.remoteOps.push(projectId, input);
  }

  /**
   * Initializes git on a previously non-git project's working tree and publishes it to a fresh,
   * empty remote. Delegates to {@link RemoteOps.initializeAndPublish}.
   *
   * @param projectId - The project whose working tree to initialize and publish.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to
   *   publish under (defaults to `'main'`).
   * @returns The initial commit's hash and the branch it was published under; a
   *   `RemoteAlreadyInitializedError`, `RepositoryUnreachableError`, `AuthenticationFailedError`, or
   *   `GitCommandFailedError` on failure.
   */
  async initializeAndPublish(
    projectId: ProjectId,
    input: GitInitializeInput,
  ): Promise<Result<GitInitializeOutcome, GitInitializeError>> {
    return this.remoteOps.initializeAndPublish(projectId, input);
  }

  /**
   * Fetches `input.branch` from the remote into the project's remote-tracking ref. Delegates to
   * {@link RemoteOps.fetch}.
   *
   * @param projectId - The project whose working tree's remote-tracking ref to update.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to fetch.
   * @returns The remote-tracking ref's new tip on success; a `RepositoryUnreachableError`,
   *   `AuthenticationFailedError`, or `GitCommandFailedError` on failure.
   */
  async fetch(
    projectId: ProjectId,
    input: GitFetchInput,
  ): Promise<Result<GitFetchResult, RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError>> {
    return this.remoteOps.fetch(projectId, input);
  }

  /**
   * Compares a local branch against its already-fetched remote-tracking ref. Delegates to
   * {@link LocalReadOps.getBehindAhead}.
   *
   * @param projectId - The project whose working tree to compare.
   * @param branch - The local branch to compare against its remote-tracking ref.
   * @returns The `{ behind, ahead }` counts; a `GitCommandFailedError` when the underlying command
   *   fails or its output is unparseable.
   */
  async getBehindAhead(projectId: ProjectId, branch: string): Promise<Result<GitBehindAhead, GitCommandFailedError>> {
    return this.localReadOps.getBehindAhead(projectId, branch);
  }

  /**
   * Previews what a fetch-then-merge pull would bring in, without changing anything beyond the
   * remote-tracking ref. Delegates to {@link LocalReadOps.previewPull}.
   *
   * @param projectId - The project whose incoming changes to preview.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to preview.
   * @returns The incoming commits (newest first) and the paths they touch; a
   *   `RepositoryUnreachableError`, `AuthenticationFailedError`, or `GitCommandFailedError` on failure.
   */
  async previewPull(
    projectId: ProjectId,
    input: GitPreviewPullInput,
  ): Promise<
    Result<GitPreviewPullResult, RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError>
  > {
    return this.localReadOps.previewPull(projectId, input);
  }

  /**
   * Previews what a push would send out, without changing anything. Delegates to
   * {@link LocalReadOps.previewPush}.
   *
   * @param projectId - The project whose outgoing changes to preview.
   * @param input - The branch to preview.
   * @returns The outgoing commits (newest first) and the paths they touch; a `GitCommandFailedError`
   *   when the underlying git command fails for a reason other than a missing remote-tracking ref.
   */
  async previewPush(
    projectId: ProjectId,
    input: GitPreviewPushInput,
  ): Promise<Result<GitPreviewPushResult, GitCommandFailedError>> {
    return this.localReadOps.previewPush(projectId, input);
  }

  /**
   * Runs a local three-way merge of the already-fetched remote-tracking ref into `input.branch`.
   * Delegates to {@link MergeConflictOps.merge}.
   *
   * @param projectId - The project whose working tree to merge into.
   * @param input - The branch to merge into, the live-content flush list, and the operation id the
   *   undo snapshot and any captured conflict stages are keyed by.
   * @returns A `GitMergeOutcome` — `merged` or `conflicted`; a `GitCommandFailedError` only when a
   *   git command itself fails, a flush path is unsafe, or the stage-store capture fails.
   */
  async merge(projectId: ProjectId, input: GitMergeInput): Promise<Result<GitMergeOutcome, GitCommandFailedError>> {
    return this.mergeConflictOps.merge(projectId, input);
  }

  /**
   * Lists the project's local branches and which one is currently checked out. Delegates to
   * {@link BranchOps.listBranches}.
   *
   * @param projectId - The project whose working tree to list branches for.
   * @returns The current branch and every local branch name; a `GitCommandFailedError` when the
   *   underlying git command fails.
   */
  async listBranches(projectId: ProjectId): Promise<Result<GitBranchList, GitCommandFailedError>> {
    return this.branchOps.listBranches(projectId);
  }

  /**
   * Creates a new local branch from the current branch tip without switching to it. Delegates to
   * {@link BranchOps.createBranch}.
   *
   * @param projectId - The project whose working tree to create the branch in.
   * @param input - The new branch's name.
   * @returns The created branch on success; a `GitCommandFailedError` when the underlying git
   *   command fails.
   */
  async createBranch(
    projectId: ProjectId,
    input: GitCreateBranchInput,
  ): Promise<Result<GitCreatedBranch, GitCommandFailedError>> {
    return this.branchOps.createBranch(projectId, input);
  }

  /**
   * Switches the project's working tree to another local branch, carrying in-progress live edits
   * across the switch. Delegates to {@link MergeConflictOps.checkout}.
   *
   * @param projectId - The project whose working tree to switch.
   * @param input - The target branch, the live-content flush list, whether to carry local edits,
   *   and the operation id the undo snapshot and any captured conflict stages are keyed by.
   * @returns A `GitCheckoutOutcome` — `switched` or `conflicted`; a `GitCommandFailedError` only
   *   when the underlying git command fails, a flush path is unsafe, or the stage-store capture fails.
   */
  async checkout(
    projectId: ProjectId,
    input: GitCheckoutInput,
  ): Promise<Result<GitCheckoutOutcome, GitCommandFailedError>> {
    return this.mergeConflictOps.checkout(projectId, input);
  }

  /**
   * Completes a previously-aborted conflicted pull by re-running the merge, applying each
   * resolution, and taking a resolving merge commit. Delegates to {@link MergeConflictOps.resolveMerge}.
   *
   * @param projectId - The project whose working tree to complete the merge in.
   * @param input - The branch, the operation id, and every conflicting file's chosen resolution.
   * @returns A `GitResolveMergeOutcome`; a `GitCommandFailedError` when the underlying git command
   *   fails, no conflict-stage store is configured for a `merged` resolution, or its bytes are missing.
   */
  async resolveMerge(
    projectId: ProjectId,
    input: GitResolveMergeInput,
  ): Promise<Result<GitResolveMergeOutcome, GitCommandFailedError>> {
    return this.mergeConflictOps.resolveMerge(projectId, input);
  }

  /**
   * Restores the working tree to an operation's pre-operation undo snapshot. Delegates to
   * {@link MergeConflictOps.restoreToSnapshot}.
   *
   * @param projectId - The project whose working tree to restore.
   * @param input - The operation whose snapshot to restore to.
   * @returns A `GitRestoreOutcome`; a `GitCommandFailedError` when no store/snapshot is available,
   *   the recorded commit is unresolvable, or the underlying git command fails.
   */
  async restoreToSnapshot(
    projectId: ProjectId,
    input: GitRestoreToSnapshotInput,
  ): Promise<Result<GitRestoreOutcome, GitCommandFailedError>> {
    return this.mergeConflictOps.restoreToSnapshot(projectId, input);
  }

  /**
   * Reads a project's commit history, newest first. Delegates to {@link LocalReadOps.log}.
   *
   * @param projectId - The project whose history to read.
   * @param options - `path` restricts to a single project-relative file's history; `limit` caps the
   *   number of commits returned.
   * @returns Every matching commit, newest first; a `GitCommandFailedError` when the underlying git
   *   command fails for a reason other than an as-yet-commit-less repository.
   */
  async log(
    projectId: ProjectId,
    options: { readonly path?: string; readonly limit?: number },
  ): Promise<Result<GitLogEntry[], GitCommandFailedError>> {
    return this.localReadOps.log(projectId, options);
  }

  /**
   * Produces a unified diff — between two commits, of the uncommitted working changes, or of a live
   * editor override. Delegates to {@link LocalReadOps.diff}.
   *
   * @param projectId - The project whose working tree (and/or history) to diff.
   * @param input - What to diff — two commits, or the uncommitted working changes, optionally scoped
   *   to one file, optionally overriding that file's content with live text.
   * @returns The unified diff text (empty when there is no difference); a `GitCommandFailedError`
   *   when the underlying git command fails.
   */
  async diff(projectId: ProjectId, input: GitDiffInput): Promise<Result<GitDiffResult, GitCommandFailedError>> {
    return this.localReadOps.diff(projectId, input);
  }

  /**
   * Reads per-line authorship for a single project-relative file. Delegates to
   * {@link LocalReadOps.blame}.
   *
   * @param projectId - The project whose file to blame.
   * @param input - The project-relative file path, and the optional commit to blame it as of.
   * @returns Every line's authorship, in file order; a `GitCommandFailedError` when the underlying
   *   git command fails.
   */
  async blame(
    projectId: ProjectId,
    input: { readonly path: string; readonly ref?: string },
  ): Promise<Result<GitBlameLine[], GitCommandFailedError>> {
    return this.localReadOps.blame(projectId, input);
  }

  /**
   * Restores the given files in the working tree, dropping their uncommitted changes, and returns
   * the resulting change-set. Delegates to {@link LocalReadOps.discardChanges}.
   *
   * @param projectId - The project whose working tree to restore.
   * @param input - The paths to restore, and, optionally, the commit to restore them from.
   * @returns The resulting change-set on success; a `GitCommandFailedError` when a path is unsafe or
   *   the underlying git command fails.
   */
  async discardChanges(
    projectId: ProjectId,
    input: GitDiscardInput,
  ): Promise<Result<GitMergeFileChange[], GitCommandFailedError>> {
    return this.localReadOps.discardChanges(projectId, input);
  }
}
