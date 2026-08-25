import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../../src/errors/git/authentication-failed';
import {
  ClonedRepository,
  GitBehindAhead,
  GitBranchList,
  GitCloneInput,
  GitCommandRunner,
  GitCommitInput,
  GitCommitResult,
  GitCreateBranchInput,
  GitCreatedBranch,
  GitFetchInput,
  GitFetchResult,
  GitMergeInput,
  GitMergeOutcome,
  GitPushError,
  GitPushInput,
  GitPushResult,
  GitRemoteAccessCheck,
  GitStashOutcome,
  GitStashRestoreOutcome,
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
  private readonly pushFailures = new Map<string, GitPushError>();
  private readonly pushResults = new Map<string, GitPushResult>();
  private readonly fetchFailures = new Map<
    string,
    RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError
  >();
  private readonly fetchResults = new Map<string, GitFetchResult>();
  private readonly behindAheadFailures = new Map<string, GitCommandFailedError>();
  private readonly behindAheadResults = new Map<string, GitBehindAhead>();
  private readonly mergeFailures = new Map<string, GitCommandFailedError>();
  private readonly mergeOutcomes = new Map<string, GitMergeOutcome>();
  private readonly createBranchFailures = new Map<string, GitCommandFailedError>();
  private readonly createBranchResults = new Map<string, GitCreatedBranch>();
  private readonly branchListFailures = new Map<string, GitCommandFailedError>();
  private readonly branchLists = new Map<string, GitBranchList>();
  private readonly stashFailures = new Map<string, GitCommandFailedError>();
  private readonly stashOutcomes = new Map<string, GitStashOutcome>();
  private readonly restoreStashFailures = new Map<string, GitCommandFailedError>();
  private readonly restoreStashOutcomes = new Map<string, GitStashRestoreOutcome>();

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

  /** Every call made to `push`, in call order, for asserting the remote URL, token, and branch pushed. */
  readonly pushCalls: { projectId: ProjectId; input: GitPushInput }[] = [];

  /** Every call made to `fetch`, in call order, for asserting the remote URL, token, and branch fetched. */
  readonly fetchCalls: { projectId: ProjectId; input: GitFetchInput }[] = [];

  /** Every call made to `getBehindAhead`, in call order, for asserting the branch compared. */
  readonly behindAheadCalls: { projectId: ProjectId; branch: string }[] = [];

  /** Every call made to `merge`, in call order, for asserting the flush list and branch merged. */
  readonly mergeCalls: { projectId: ProjectId; input: GitMergeInput }[] = [];

  /** Every call made to `createBranch`, in call order, for asserting the requested name. */
  readonly createBranchCalls: { projectId: ProjectId; input: GitCreateBranchInput }[] = [];

  /** Every call made to `listBranches`, in call order, for asserting use-case interactions. */
  readonly listBranchesCalls: ProjectId[] = [];

  /** Every call made to `stashChanges`, in call order, for asserting use-case interactions. */
  readonly stashCalls: ProjectId[] = [];

  /** Every call made to `restoreStash`, in call order, for asserting use-case interactions. */
  readonly restoreStashCalls: ProjectId[] = [];

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

  /** Configures the `GitStashOutcome` `stashChanges` returns for a project on success. */
  seedStash(projectId: ProjectId, outcome: GitStashOutcome): void {
    this.stashOutcomes.set(projectId.value, outcome);
  }

  /** Configures `stashChanges` to fail for a project, taking priority over any seeded outcome. */
  seedStashFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.stashFailures.set(projectId.value, error);
  }

  /**
   * Records the call and returns the seeded `GitStashOutcome` (defaulting to `{stashed: false}`
   * when unseeded), unless a failure was seeded for this project via `seedStashFailure`.
   */
  async stashChanges(projectId: ProjectId): Promise<Result<GitStashOutcome, GitCommandFailedError>> {
    this.stashCalls.push(projectId);

    const failure = this.stashFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome = this.stashOutcomes.get(projectId.value) ?? { stashed: false };

    return { success: true, value: outcome };
  }

  /** Configures the `GitStashRestoreOutcome` `restoreStash` returns for a project on success — a
   * clean `{hadConflicts: false}` or a conflicted `{hadConflicts: true}`. A conflicted restore is a
   * seeded happy-path outcome, not a failure — use `seedRestoreStashFailure` only for an actual git
   * command failure. */
  seedRestoreStash(projectId: ProjectId, outcome: GitStashRestoreOutcome): void {
    this.restoreStashOutcomes.set(projectId.value, outcome);
  }

  /** Configures `restoreStash` to fail for a project, taking priority over any seeded outcome. */
  seedRestoreStashFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.restoreStashFailures.set(projectId.value, error);
  }

  /**
   * Records the call and returns the seeded `GitStashRestoreOutcome` (defaulting to
   * `{hadConflicts: false}` when unseeded), unless a failure was seeded for this project via
   * `seedRestoreStashFailure`.
   */
  async restoreStash(projectId: ProjectId): Promise<Result<GitStashRestoreOutcome, GitCommandFailedError>> {
    this.restoreStashCalls.push(projectId);

    const failure = this.restoreStashFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome = this.restoreStashOutcomes.get(projectId.value) ?? { hadConflicts: false };

    return { success: true, value: outcome };
  }
}
