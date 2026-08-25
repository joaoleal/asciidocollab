import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../../src/errors/git/authentication-failed';
import {
  ClonedRepository,
  GitAmendError,
  GitAmendInput,
  GitBehindAhead,
  GitBlameLine,
  GitBranchList,
  GitCheckoutInput,
  GitCheckoutOutcome,
  GitCloneInput,
  GitCommandRunner,
  GitCommitInput,
  GitCommitResult,
  GitCreateBranchInput,
  GitCreatedBranch,
  GitDiffInput,
  GitDiffResult,
  GitDiscardInput,
  GitFetchInput,
  GitFetchResult,
  GitInitializeError,
  GitInitializeInput,
  GitInitializeOutcome,
  GitLogEntry,
  GitMergeFileChange,
  GitMergeInput,
  GitMergeOutcome,
  GitPushError,
  GitPushInput,
  GitPushResult,
  GitRemoteAccessCheck,
  GitResolveMergeInput,
  GitResolveMergeOutcome,
  GitRestoreOutcome,
  GitRestoreToSnapshotInput,
  GitWorkingTreeStatus,
} from '../../../src/ports/git/git-command-runner';
import { Result } from '../../../src/types/result';

/** In-memory implementation of GitCommandRunner for use in tests. */
export class InMemoryGitCommandRunner implements GitCommandRunner {
  private readonly statuses = new Map<string, GitWorkingTreeStatus>();
  private readonly statusFailures = new Map<string, GitCommandFailedError>();
  private readonly remoteAccessFailures = new Map<
    string,
    RepositoryUnreachableError | AuthenticationFailedError
  >();
  private readonly clonedRepositories = new Map<string, ClonedRepository>();
  private readonly cloneFailures = new Map<
    string,
    RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError
  >();
  private readonly stageFailures = new Map<string, GitCommandFailedError>();
  private readonly unstageFailures = new Map<string, GitCommandFailedError>();
  private readonly commitFailures = new Map<string, GitCommandFailedError>();
  private readonly commitResults = new Map<string, GitCommitResult>();
  private readonly amendCommitFailures = new Map<string, GitAmendError>();
  private readonly amendCommitResults = new Map<string, GitCommitResult>();
  private readonly pushFailures = new Map<string, GitPushError>();
  private readonly pushResults = new Map<string, GitPushResult>();
  private readonly initializeAndPublishFailures = new Map<string, GitInitializeError>();
  private readonly initializeAndPublishOutcomes = new Map<string, GitInitializeOutcome>();
  private readonly fetchFailures = new Map<
    string,
    RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError
  >();
  private readonly fetchResults = new Map<string, GitFetchResult>();
  private readonly behindAheadFailures = new Map<string, GitCommandFailedError>();
  private readonly behindAheadResults = new Map<string, GitBehindAhead>();
  private readonly logFailures = new Map<string, GitCommandFailedError>();
  private readonly logResults = new Map<string, GitLogEntry[]>();
  private readonly diffFailures = new Map<string, GitCommandFailedError>();
  private readonly diffResults = new Map<string, GitDiffResult>();
  private readonly blameFailures = new Map<string, GitCommandFailedError>();
  private readonly blameResults = new Map<string, GitBlameLine[]>();
  private readonly mergeFailures = new Map<string, GitCommandFailedError>();
  private readonly mergeOutcomes = new Map<string, GitMergeOutcome>();
  private readonly createBranchFailures = new Map<string, GitCommandFailedError>();
  private readonly createBranchResults = new Map<string, GitCreatedBranch>();
  private readonly branchListFailures = new Map<string, GitCommandFailedError>();
  private readonly branchLists = new Map<string, GitBranchList>();
  private readonly checkoutFailures = new Map<string, GitCommandFailedError>();
  private readonly checkoutOutcomes = new Map<string, GitCheckoutOutcome>();
  private readonly resolveMergeFailures = new Map<string, GitCommandFailedError>();
  private readonly resolveMergeOutcomes = new Map<string, GitResolveMergeOutcome>();
  private readonly restoreToSnapshotFailures = new Map<string, GitCommandFailedError>();
  private readonly restoreToSnapshotOutcomes = new Map<string, GitRestoreOutcome>();
  private readonly discardChangesFailures = new Map<string, GitCommandFailedError>();
  private readonly discardChangesResults = new Map<string, GitMergeFileChange[]>();

  /** Every call made to `getStatus`, in call order, for asserting use-case interactions. */
  readonly statusCalls: ProjectId[] = [];

  /** Every call made to `checkRemoteAccess`, in call order, for asserting use-case interactions. */
  readonly remoteAccessCalls: GitRemoteAccessCheck[] = [];

  /** Every call made to `clone`, in call order, for asserting use-case interactions. */
  readonly cloneCalls: GitCloneInput[] = [];

  /** Every call made to `stage`, in call order, for asserting use-case interactions. */
  readonly stageCalls: { projectId: ProjectId; paths: readonly string[] }[] = [];

  /** Every call made to `unstage`, in call order, for asserting use-case interactions. */
  readonly unstageCalls: { projectId: ProjectId; paths: readonly string[] }[] = [];

  /** Every call made to `commit`, in call order, for asserting the flush list and author. */
  readonly commitCalls: { projectId: ProjectId; input: GitCommitInput }[] = [];

  /** Every call made to `amendCommit`, in call order, for asserting the flush list, author, and optional message. */
  readonly amendCommitCalls: { projectId: ProjectId; input: GitAmendInput }[] = [];

  /** Every call made to `push`, in call order, for asserting the remote URL, token, and branch pushed. */
  readonly pushCalls: { projectId: ProjectId; input: GitPushInput }[] = [];

  /** Every call made to `initializeAndPublish`, in call order, for asserting the remote URL, token, and branch published. */
  readonly initializeAndPublishCalls: { projectId: ProjectId; input: GitInitializeInput }[] = [];

  /** Every call made to `fetch`, in call order, for asserting the remote URL, token, and branch fetched. */
  readonly fetchCalls: { projectId: ProjectId; input: GitFetchInput }[] = [];

  /** Every call made to `getBehindAhead`, in call order, for asserting the branch compared. */
  readonly behindAheadCalls: { projectId: ProjectId; branch: string }[] = [];

  /** Every call made to `log`, in call order, for asserting the path/limit options. */
  readonly logCalls: { projectId: ProjectId; options: { readonly path?: string; readonly limit?: number } }[] = [];

  /** Every call made to `diff`, in call order, for asserting the exact input passed. */
  readonly diffCalls: { projectId: ProjectId; input: GitDiffInput }[] = [];

  /** Every call made to `blame`, in call order, for asserting the exact path/ref passed. */
  readonly blameCalls: { projectId: ProjectId; input: { readonly path: string; readonly ref?: string } }[] = [];

  /** Every call made to `merge`, in call order, for asserting the flush list and branch merged. */
  readonly mergeCalls: { projectId: ProjectId; input: GitMergeInput }[] = [];

  /** Every call made to `createBranch`, in call order, for asserting the requested name. */
  readonly createBranchCalls: { projectId: ProjectId; input: GitCreateBranchInput }[] = [];

  /** Every call made to `listBranches`, in call order, for asserting use-case interactions. */
  readonly listBranchesCalls: ProjectId[] = [];

  /** Every call made to `checkout`, in call order, for asserting the flush list, branch, and stash flag. */
  readonly checkoutCalls: { projectId: ProjectId; input: GitCheckoutInput }[] = [];

  /** Every call made to `resolveMerge`, in call order, for asserting the branch and resolutions. */
  readonly resolveMergeCalls: { projectId: ProjectId; input: GitResolveMergeInput }[] = [];

  /** Every call made to `restoreToSnapshot`, in call order, for asserting the operation id. */
  readonly restoreToSnapshotCalls: { projectId: ProjectId; input: GitRestoreToSnapshotInput }[] = [];

  /** Every call made to `discardChanges`, in call order, for asserting the exact paths/fromCommit. */
  readonly discardChangesCalls: { projectId: ProjectId; input: GitDiscardInput }[] = [];

  /** Configures the status `getStatus` returns for a project. */
  seedStatus(projectId: ProjectId, status: GitWorkingTreeStatus): void {
    this.statuses.set(projectId.value, status);
  }

  /** Configures `getStatus` to fail for a project, taking priority over any seeded status. */
  seedStatusFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.statusFailures.set(projectId.value, error);
  }

  /**
   * Returns the seeded status for the project, the seeded failure if one was
   * configured, or a generic `GitCommandFailedError` if nothing was seeded.
   */
  async getStatus(projectId: ProjectId): Promise<Result<GitWorkingTreeStatus, GitCommandFailedError>> {
    this.statusCalls.push(projectId);

    const failure = this.statusFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const status = this.statuses.get(projectId.value);
    if (!status) {
      return { success: false, error: new GitCommandFailedError('No working tree status configured for this project') };
    }

    return { success: true, value: status };
  }

  /** Configures `checkRemoteAccess` to fail for a remote URL, taking priority over success. */
  seedRemoteAccessFailure(
    remoteUrl: string,
    error: RepositoryUnreachableError | AuthenticationFailedError,
  ): void {
    this.remoteAccessFailures.set(remoteUrl, error);
  }

  /**
   * Records the call and reports success, unless a failure was seeded for this remote URL via
   * `seedRemoteAccessFailure`.
   */
  async checkRemoteAccess(
    check: GitRemoteAccessCheck,
  ): Promise<Result<void, RepositoryUnreachableError | AuthenticationFailedError>> {
    this.remoteAccessCalls.push(check);

    const failure = this.remoteAccessFailures.get(check.remoteUrl);
    if (failure) return { success: false, error: failure };

    return { success: true, value: undefined };
  }

  /** Configures `clone` to return `repository` for a remote URL. */
  seedClone(remoteUrl: string, repository: ClonedRepository): void {
    this.clonedRepositories.set(remoteUrl, repository);
  }

  /** Configures `clone` to fail for a remote URL, taking priority over any seeded repository. */
  seedCloneFailure(
    remoteUrl: string,
    error: RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError,
  ): void {
    this.cloneFailures.set(remoteUrl, error);
  }

  /**
   * Returns the seeded repository for the remote URL, the seeded failure if one was configured, or
   * a generic `GitCommandFailedError` if nothing was seeded.
   */
  async clone(
    input: GitCloneInput,
  ): Promise<Result<ClonedRepository, RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError>> {
    this.cloneCalls.push(input);

    const failure = this.cloneFailures.get(input.remoteUrl);
    if (failure) return { success: false, error: failure };

    const repository = this.clonedRepositories.get(input.remoteUrl);
    if (!repository) {
      return { success: false, error: new GitCommandFailedError('No clone result configured for this remote') };
    }

    return { success: true, value: repository };
  }

  /** Configures `stage` to fail for a project, taking priority over its default success. */
  seedStageFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.stageFailures.set(projectId.value, error);
  }

  /**
   * Records the call and reports success, unless a failure was seeded for this project via
   * `seedStageFailure`. Does not itself mutate any seeded `getStatus` result — seed the status a
   * test expects `getStatus` to return after staging via `seedStatus`.
   */
  async stage(projectId: ProjectId, paths: readonly string[]): Promise<Result<void, GitCommandFailedError>> {
    this.stageCalls.push({ projectId, paths });

    const failure = this.stageFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    return { success: true, value: undefined };
  }

  /** Configures `unstage` to fail for a project, taking priority over its default success. */
  seedUnstageFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.unstageFailures.set(projectId.value, error);
  }

  /**
   * Records the call and reports success, unless a failure was seeded for this project via
   * `seedUnstageFailure`. Does not itself mutate any seeded `getStatus` result — seed the status a
   * test expects `getStatus` to return after unstaging via `seedStatus`.
   */
  async unstage(projectId: ProjectId, paths: readonly string[]): Promise<Result<void, GitCommandFailedError>> {
    this.unstageCalls.push({ projectId, paths });

    const failure = this.unstageFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    return { success: true, value: undefined };
  }

  /** Configures `commit` to fail for a project, taking priority over its default success. */
  seedCommitFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.commitFailures.set(projectId.value, error);
  }

  /** Configures the `GitCommitResult` `commit` returns for a project on success. */
  seedCommitResult(projectId: ProjectId, result: GitCommitResult): void {
    this.commitResults.set(projectId.value, result);
  }

  /**
   * Records the call — including the exact flush list and author, so a test can assert them — and
   * returns the seeded `GitCommitResult` (or a canned default), unless a failure was seeded for
   * this project via `seedCommitFailure`. Records no working-tree writes: the flush list is
   * captured verbatim for assertion only.
   */
  async commit(projectId: ProjectId, input: GitCommitInput): Promise<Result<GitCommitResult, GitCommandFailedError>> {
    this.commitCalls.push({ projectId, input });

    const failure = this.commitFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const seeded = this.commitResults.get(projectId.value);
    const result: GitCommitResult = seeded ?? {
      hash: '0000000000000000000000000000000000000000',
      message: input.message,
      authoredAt: new Date('2024-01-01T00:00:00.000Z'),
    };

    return { success: true, value: result };
  }

  /** Configures `amendCommit` to fail for a project, taking priority over its default success — seed with a
   *  `CommitAlreadyPushedError` or a generic `GitCommandFailedError` to exercise each of `amendCommit`'s typed
   *  refusals. */
  seedAmendCommitFailure(projectId: ProjectId, error: GitAmendError): void {
    this.amendCommitFailures.set(projectId.value, error);
  }

  /** Configures the `GitCommitResult` `amendCommit` returns for a project on success. */
  seedAmendCommitResult(projectId: ProjectId, result: GitCommitResult): void {
    this.amendCommitResults.set(projectId.value, result);
  }

  /**
   * Records the call — including the exact flush list, author, and optional message, so a test can assert
   * them — and returns the seeded `GitCommitResult` (or a canned default), unless a failure was seeded for
   * this project via `seedAmendCommitFailure`. Records no working-tree writes: the flush list is captured
   * verbatim for assertion only.
   */
  async amendCommit(projectId: ProjectId, input: GitAmendInput): Promise<Result<GitCommitResult, GitAmendError>> {
    this.amendCommitCalls.push({ projectId, input });

    const failure = this.amendCommitFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const seeded = this.amendCommitResults.get(projectId.value);
    const result: GitCommitResult = seeded ?? {
      hash: '0000000000000000000000000000000000000000',
      message: input.message ?? 'the original commit message',
      authoredAt: new Date('2024-01-01T00:00:00.000Z'),
    };

    return { success: true, value: result };
  }

  /**
   * Configures `push` to fail for a project, taking priority over any seeded result — seed with a
   * `NonFastForwardError`, `RepositoryUnreachableError`, `AuthenticationFailedError`, or a generic
   * `GitCommandFailedError` to exercise each of `push`'s typed refusals.
   */
  seedPushFailure(projectId: ProjectId, error: GitPushError): void {
    this.pushFailures.set(projectId.value, error);
  }

  /** Configures the `GitPushResult` `push` returns for a project on success. */
  seedPush(projectId: ProjectId, result: GitPushResult): void {
    this.pushResults.set(projectId.value, result);
  }

  /**
   * Records the call — including the exact remote URL, token, and branch, so a test can assert
   * them — and returns the seeded `GitPushResult`, unless a failure was seeded for this project via
   * `seedPushFailure`, in which case that failure takes priority.
   */
  async push(projectId: ProjectId, input: GitPushInput): Promise<Result<GitPushResult, GitPushError>> {
    this.pushCalls.push({ projectId, input });

    const failure = this.pushFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.pushResults.get(projectId.value);
    if (!result) {
      return { success: false, error: new GitCommandFailedError('No push result configured for this project') };
    }

    return { success: true, value: result };
  }

  /** Configures the `GitInitializeOutcome` `initializeAndPublish` returns for a project on success. */
  seedInitializeAndPublish(projectId: ProjectId, outcome: GitInitializeOutcome): void {
    this.initializeAndPublishOutcomes.set(projectId.value, outcome);
  }

  /**
   * Configures `initializeAndPublish` to fail for a project, taking priority over any seeded
   * outcome — seed with a `RemoteAlreadyInitializedError`, `RepositoryUnreachableError`,
   * `AuthenticationFailedError`, or a generic `GitCommandFailedError` to exercise each of
   * `initializeAndPublish`'s typed refusals.
   */
  seedInitializeAndPublishFailure(projectId: ProjectId, error: GitInitializeError): void {
    this.initializeAndPublishFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the exact remote URL, token, and branch, so a test can assert
   * them — and returns the seeded `GitInitializeOutcome`, unless a failure was seeded for this
   * project via `seedInitializeAndPublishFailure`, in which case that failure takes priority.
   */
  async initializeAndPublish(
    projectId: ProjectId,
    input: GitInitializeInput,
  ): Promise<Result<GitInitializeOutcome, GitInitializeError>> {
    this.initializeAndPublishCalls.push({ projectId, input });

    const failure = this.initializeAndPublishFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome = this.initializeAndPublishOutcomes.get(projectId.value);
    if (!outcome) {
      return {
        success: false,
        error: new GitCommandFailedError('No initialize-and-publish outcome configured for this project'),
      };
    }

    return { success: true, value: outcome };
  }

  /** Configures the `GitFetchResult` `fetch` returns for a project on success. */
  seedFetch(projectId: ProjectId, result: GitFetchResult): void {
    this.fetchResults.set(projectId.value, result);
  }

  /**
   * Configures `fetch` to fail for a project, taking priority over any seeded result — seed with a
   * `RepositoryUnreachableError`, `AuthenticationFailedError`, or a generic `GitCommandFailedError`.
   */
  seedFetchFailure(
    projectId: ProjectId,
    error: RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError,
  ): void {
    this.fetchFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the exact remote URL, token, and branch, so a test can assert
   * them — and returns the seeded `GitFetchResult` (or a canned default), unless a failure was
   * seeded for this project via `seedFetchFailure`.
   */
  async fetch(
    projectId: ProjectId,
    input: GitFetchInput,
  ): Promise<Result<GitFetchResult, RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError>> {
    this.fetchCalls.push({ projectId, input });

    const failure = this.fetchFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.fetchResults.get(projectId.value) ?? { remoteHead: '0000000000000000000000000000000000000000' };

    return { success: true, value: result };
  }

  /** Configures the `GitBehindAhead` `getBehindAhead` returns for a project on success. */
  seedBehindAhead(projectId: ProjectId, result: GitBehindAhead): void {
    this.behindAheadResults.set(projectId.value, result);
  }

  /** Configures `getBehindAhead` to fail for a project, taking priority over any seeded result. */
  seedBehindAheadFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.behindAheadFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the branch compared, so a test can assert it — and returns the
   * seeded `GitBehindAhead` (defaulting to `{behind: 0, ahead: 0}` when unseeded), unless a failure
   * was seeded for this project via `seedBehindAheadFailure`.
   */
  async getBehindAhead(projectId: ProjectId, branch: string): Promise<Result<GitBehindAhead, GitCommandFailedError>> {
    this.behindAheadCalls.push({ projectId, branch });

    const failure = this.behindAheadFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.behindAheadResults.get(projectId.value) ?? { behind: 0, ahead: 0 };

    return { success: true, value: result };
  }

  /** Configures the `GitLogEntry[]` `log` returns for a project on success. */
  seedLog(projectId: ProjectId, entries: GitLogEntry[]): void {
    this.logResults.set(projectId.value, entries);
  }

  /** Configures `log` to fail for a project, taking priority over any seeded entries. */
  seedLogFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.logFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the exact `path`/`limit` options, so a test can assert them — and
   * returns the seeded `GitLogEntry[]` (defaulting to an empty history when unseeded), unless a
   * failure was seeded for this project via `seedLogFailure`.
   */
  async log(
    projectId: ProjectId,
    options: { readonly path?: string; readonly limit?: number },
  ): Promise<Result<GitLogEntry[], GitCommandFailedError>> {
    this.logCalls.push({ projectId, options });

    const failure = this.logFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const entries = this.logResults.get(projectId.value) ?? [];

    return { success: true, value: entries };
  }

  /** Configures the `GitDiffResult` `diff` returns for a project on success. */
  seedDiff(projectId: ProjectId, result: GitDiffResult): void {
    this.diffResults.set(projectId.value, result);
  }

  /** Configures `diff` to fail for a project, taking priority over any seeded result. */
  seedDiffFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.diffFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the exact input, so a test can assert `from`/`to`/`path`/
   * `currentContent` — and returns the seeded `GitDiffResult` (defaulting to an empty unified diff
   * when unseeded), unless a failure was seeded for this project via `seedDiffFailure`.
   */
  async diff(projectId: ProjectId, input: GitDiffInput): Promise<Result<GitDiffResult, GitCommandFailedError>> {
    this.diffCalls.push({ projectId, input });

    const failure = this.diffFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.diffResults.get(projectId.value) ?? { unified: '' };

    return { success: true, value: result };
  }

  /** Configures the `GitBlameLine[]` `blame` returns for a project on success. */
  seedBlame(projectId: ProjectId, lines: GitBlameLine[]): void {
    this.blameResults.set(projectId.value, lines);
  }

  /** Configures `blame` to fail for a project, taking priority over any seeded lines. */
  seedBlameFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.blameFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the exact `path`/`ref` options, so a test can assert them — and
   * returns the seeded `GitBlameLine[]` (defaulting to an empty blame when unseeded), unless a
   * failure was seeded for this project via `seedBlameFailure`.
   */
  async blame(
    projectId: ProjectId,
    input: { readonly path: string; readonly ref?: string },
  ): Promise<Result<GitBlameLine[], GitCommandFailedError>> {
    this.blameCalls.push({ projectId, input });

    const failure = this.blameFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const lines = this.blameResults.get(projectId.value) ?? [];

    return { success: true, value: lines };
  }

  /**
   * Configures the `GitMergeOutcome` `merge` returns for a project on success — a `merged` outcome
   * with its `changes`, or a `conflicted` outcome with its `conflicts`. A conflict is a seeded
   * happy-path outcome, not a failure — use `seedMergeFailure` only for an actual git command failure.
   */
  seedMerge(projectId: ProjectId, outcome: GitMergeOutcome): void {
    this.mergeOutcomes.set(projectId.value, outcome);
  }

  /** Configures `merge` to fail for a project, taking priority over any seeded outcome. */
  seedMergeFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.mergeFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the exact flush list and branch, so a test can assert them — and
   * returns the seeded `GitMergeOutcome` (defaulting to `{status: 'merged', changes: []}` when
   * unseeded), unless a failure was seeded for this project via `seedMergeFailure`. Records no
   * working-tree writes: the flush list is captured verbatim for assertion only.
   */
  async merge(projectId: ProjectId, input: GitMergeInput): Promise<Result<GitMergeOutcome, GitCommandFailedError>> {
    this.mergeCalls.push({ projectId, input });

    const failure = this.mergeFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome: GitMergeOutcome = this.mergeOutcomes.get(projectId.value) ?? {
      status: 'merged',
      headCommit: '0000000000000000000000000000000000000000',
      changes: [],
    };

    return { success: true, value: outcome };
  }

  /** Configures the `GitCreatedBranch` `createBranch` returns for a project on success. */
  seedCreateBranch(projectId: ProjectId, result: GitCreatedBranch): void {
    this.createBranchResults.set(projectId.value, result);
  }

  /** Configures `createBranch` to fail for a project, taking priority over any seeded result. */
  seedCreateBranchFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.createBranchFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the exact requested name, so a test can assert it — and returns
   * the seeded `GitCreatedBranch` (defaulting to a branch named exactly as requested when
   * unseeded), unless a failure was seeded for this project via `seedCreateBranchFailure`.
   */
  async createBranch(
    projectId: ProjectId,
    input: GitCreateBranchInput,
  ): Promise<Result<GitCreatedBranch, GitCommandFailedError>> {
    this.createBranchCalls.push({ projectId, input });

    const failure = this.createBranchFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.createBranchResults.get(projectId.value) ?? { name: input.name };

    return { success: true, value: result };
  }

  /** Configures the `GitBranchList` `listBranches` returns for a project on success. */
  seedBranches(projectId: ProjectId, list: GitBranchList): void {
    this.branchLists.set(projectId.value, list);
  }

  /** Configures `listBranches` to fail for a project, taking priority over any seeded list. */
  seedBranchesFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.branchListFailures.set(projectId.value, error);
  }

  /**
   * Records the call and returns the seeded `GitBranchList` (defaulting to a single `main`
   * branch when unseeded), unless a failure was seeded for this project via `seedBranchesFailure`.
   */
  async listBranches(projectId: ProjectId): Promise<Result<GitBranchList, GitCommandFailedError>> {
    this.listBranchesCalls.push(projectId);

    const failure = this.branchListFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const list = this.branchLists.get(projectId.value) ?? { current: 'main', branches: ['main'] };

    return { success: true, value: list };
  }

  /**
   * Configures the `GitCheckoutOutcome` `checkout` returns for a project on success — a `switched`
   * outcome with its `changes`, or a `conflicted` outcome with its `conflicts`. A conflict is a
   * seeded happy-path outcome, not a failure — use `seedCheckoutFailure` only for an actual git
   * command failure.
   */
  seedCheckout(projectId: ProjectId, outcome: GitCheckoutOutcome): void {
    this.checkoutOutcomes.set(projectId.value, outcome);
  }

  /** Configures `checkout` to fail for a project, taking priority over any seeded outcome. */
  seedCheckoutFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.checkoutFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the exact flush list, branch, and stash flag, so a test can assert
   * them — and returns the seeded `GitCheckoutOutcome` (defaulting to `{status: 'switched',
   * headCommit: '0'.repeat(40), changes: []}` when unseeded), unless a failure was seeded for this
   * project via `seedCheckoutFailure`. Records no working-tree writes: the flush list is captured
   * verbatim for assertion only.
   */
  async checkout(projectId: ProjectId, input: GitCheckoutInput): Promise<Result<GitCheckoutOutcome, GitCommandFailedError>> {
    this.checkoutCalls.push({ projectId, input });

    const failure = this.checkoutFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome: GitCheckoutOutcome = this.checkoutOutcomes.get(projectId.value) ?? {
      status: 'switched',
      headCommit: '0'.repeat(40),
      changes: [],
    };

    return { success: true, value: outcome };
  }

  /**
   * Configures the `GitResolveMergeOutcome` `resolveMerge` returns for a project on success — a
   * `resolved` outcome with its `changes`, or a `stillConflicted` outcome with its `conflicts`. A
   * `stillConflicted` result is a seeded happy-path outcome, not a failure — use
   * `seedResolveMergeFailure` only for an actual git command failure.
   */
  seedResolveMerge(projectId: ProjectId, outcome: GitResolveMergeOutcome): void {
    this.resolveMergeOutcomes.set(projectId.value, outcome);
  }

  /** Configures `resolveMerge` to fail for a project, taking priority over any seeded outcome. */
  seedResolveMergeFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.resolveMergeFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the exact branch and resolutions, so a test can assert them — and
   * returns the seeded `GitResolveMergeOutcome` (defaulting to `{status: 'resolved', headCommit:
   * '0'.repeat(40), changes: []}` when unseeded), unless a failure was seeded for this project via
   * `seedResolveMergeFailure`.
   */
  async resolveMerge(
    projectId: ProjectId,
    input: GitResolveMergeInput,
  ): Promise<Result<GitResolveMergeOutcome, GitCommandFailedError>> {
    this.resolveMergeCalls.push({ projectId, input });

    const failure = this.resolveMergeFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome: GitResolveMergeOutcome = this.resolveMergeOutcomes.get(projectId.value) ?? {
      status: 'resolved',
      headCommit: '0'.repeat(40),
      changes: [],
    };

    return { success: true, value: outcome };
  }

  /** Configures the `GitRestoreOutcome` `restoreToSnapshot` returns for a project on success. */
  seedRestoreToSnapshot(projectId: ProjectId, outcome: GitRestoreOutcome): void {
    this.restoreToSnapshotOutcomes.set(projectId.value, outcome);
  }

  /** Configures `restoreToSnapshot` to fail for a project, taking priority over any seeded outcome. */
  seedRestoreToSnapshotFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.restoreToSnapshotFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the exact operation id, so a test can assert it — and returns the
   * seeded `GitRestoreOutcome` (defaulting to `{headCommit: '0'.repeat(40), changes: []}` when
   * unseeded), unless a failure was seeded for this project via `seedRestoreToSnapshotFailure`.
   */
  async restoreToSnapshot(
    projectId: ProjectId,
    input: GitRestoreToSnapshotInput,
  ): Promise<Result<GitRestoreOutcome, GitCommandFailedError>> {
    this.restoreToSnapshotCalls.push({ projectId, input });

    const failure = this.restoreToSnapshotFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome: GitRestoreOutcome = this.restoreToSnapshotOutcomes.get(projectId.value) ?? {
      headCommit: '0'.repeat(40),
      changes: [],
    };

    return { success: true, value: outcome };
  }

  /** Configures the `GitMergeFileChange[]` `discardChanges` returns for a project on success. */
  seedDiscardChanges(projectId: ProjectId, changes: GitMergeFileChange[]): void {
    this.discardChangesResults.set(projectId.value, changes);
  }

  /** Configures `discardChanges` to fail for a project, taking priority over any seeded change-set. */
  seedDiscardChangesFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.discardChangesFailures.set(projectId.value, error);
  }

  /**
   * Records the call — including the exact paths/`fromCommit`, so a test can assert them — and
   * returns the seeded change-set (defaulting to an empty array when unseeded), unless a failure was
   * seeded for this project via `seedDiscardChangesFailure`.
   */
  async discardChanges(
    projectId: ProjectId,
    input: GitDiscardInput,
  ): Promise<Result<GitMergeFileChange[], GitCommandFailedError>> {
    this.discardChangesCalls.push({ projectId, input });

    const failure = this.discardChangesFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const changes = this.discardChangesResults.get(projectId.value) ?? [];

    return { success: true, value: changes };
  }
}
