import type {
  AuthenticationFailedError,
  ClonedRepository,
  GitBehindAhead,
  GitCloneInput,
  GitCommandFailedError,
  GitCommandRunner,
  GitCommitResult,
  GitFetchInput,
  GitFetchResult,
  GitMergeInput,
  GitMergeOutcome,
  GitPushError,
  GitPushInput,
  GitPushResult,
  GitWorkingTreeStatus,
  ProjectId,
  RepositoryUnreachableError,
  Result,
} from '@asciidocollab/domain';

/** Every typed way {@link InMemoryGitCommandRunner.fetch} can be seeded to fail. */
type FetchError = RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError;

/**
 * A local, minimal in-memory `GitCommandRunner` fake for this app's tests, covering only what
 * `ImportRepositoryUseCase` (`clone`) and `PushChangesUseCase` (`push`) exercise. See
 * `in-memory-git-operation-repository.ts`'s class docs for why this app keeps its own fakes
 * rather than reusing `packages/domain/tests`'.
 */
export class InMemoryGitCommandRunner implements GitCommandRunner {
  private readonly clonedRepositories = new Map<string, ClonedRepository>();
  private readonly cloneFailures = new Map<
    string,
    RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError
  >();
  private readonly pushResults = new Map<string, GitPushResult>();
  private readonly pushFailures = new Map<string, GitPushError>();
  private readonly fetchResults = new Map<string, GitFetchResult>();
  private readonly fetchFailures = new Map<string, FetchError>();
  private readonly behindAheadResults = new Map<string, GitBehindAhead>();
  private readonly behindAheadFailures = new Map<string, GitCommandFailedError>();
  private readonly mergeResults = new Map<string, GitMergeOutcome>();
  private readonly mergeFailures = new Map<string, GitCommandFailedError>();

  /** Every call made to `clone`, in call order, for asserting interactions. */
  readonly cloneCalls: GitCloneInput[] = [];

  /** Every call made to `push`, in call order, for asserting interactions. */
  readonly pushCalls: { projectId: ProjectId; input: GitPushInput }[] = [];

  /** Every call made to `fetch`, in call order, for asserting interactions. */
  readonly fetchCalls: { projectId: ProjectId; input: GitFetchInput }[] = [];

  /** Every call made to `getBehindAhead`, in call order, for asserting interactions. */
  readonly getBehindAheadCalls: { projectId: ProjectId; branch: string }[] = [];

  /** Every call made to `merge`, in call order, for asserting interactions. */
  readonly mergeCalls: { projectId: ProjectId; input: GitMergeInput }[] = [];

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

  /** Configures `push` to return `result` for a project. */
  seedPush(projectId: ProjectId, result: GitPushResult): void {
    this.pushResults.set(projectId.value, result);
  }

  /** Configures `push` to fail for a project, taking priority over any seeded result. */
  seedPushFailure(projectId: ProjectId, error: GitPushError): void {
    this.pushFailures.set(projectId.value, error);
  }

  /** Configures `fetch` to return `result` for a project. */
  seedFetch(projectId: ProjectId, result: GitFetchResult): void {
    this.fetchResults.set(projectId.value, result);
  }

  /** Configures `fetch` to fail for a project, taking priority over any seeded result. */
  seedFetchFailure(projectId: ProjectId, error: FetchError): void {
    this.fetchFailures.set(projectId.value, error);
  }

  /** Configures `getBehindAhead` to return `result` for a project. */
  seedBehindAhead(projectId: ProjectId, result: GitBehindAhead): void {
    this.behindAheadResults.set(projectId.value, result);
  }

  /** Configures `getBehindAhead` to fail for a project, taking priority over any seeded result. */
  seedBehindAheadFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.behindAheadFailures.set(projectId.value, error);
  }

  /** Configures `merge` to return `outcome` (merged or conflicted) for a project. */
  seedMerge(projectId: ProjectId, outcome: GitMergeOutcome): void {
    this.mergeResults.set(projectId.value, outcome);
  }

  /** Configures `merge` to fail for a project, taking priority over any seeded outcome. */
  seedMergeFailure(projectId: ProjectId, error: GitCommandFailedError): void {
    this.mergeFailures.set(projectId.value, error);
  }

  async getStatus(): Promise<Result<GitWorkingTreeStatus, GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  async checkRemoteAccess(): Promise<Result<void, RepositoryUnreachableError | AuthenticationFailedError>> {
    throw new Error('not used by these tests');
  }

  async clone(
    input: GitCloneInput,
  ): Promise<Result<ClonedRepository, RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError>> {
    this.cloneCalls.push(input);

    const failure = this.cloneFailures.get(input.remoteUrl);
    if (failure) return { success: false, error: failure };

    const repository = this.clonedRepositories.get(input.remoteUrl);
    if (!repository) {
      throw new Error(`no clone result seeded for ${input.remoteUrl}`);
    }

    return { success: true, value: repository };
  }

  async stage(): Promise<Result<void, GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  async unstage(): Promise<Result<void, GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  async commit(): Promise<Result<GitCommitResult, GitCommandFailedError>> {
    throw new Error('not used by these tests');
  }

  async push(projectId: ProjectId, input: GitPushInput): Promise<Result<GitPushResult, GitPushError>> {
    this.pushCalls.push({ projectId, input });

    const failure = this.pushFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.pushResults.get(projectId.value);
    if (!result) {
      throw new Error(`no push result seeded for ${projectId.value}`);
    }

    return { success: true, value: result };
  }

  async fetch(
    projectId: ProjectId,
    input: GitFetchInput,
  ): Promise<Result<GitFetchResult, FetchError>> {
    this.fetchCalls.push({ projectId, input });

    const failure = this.fetchFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.fetchResults.get(projectId.value);
    if (!result) {
      throw new Error(`no fetch result seeded for ${projectId.value}`);
    }

    return { success: true, value: result };
  }

  async getBehindAhead(projectId: ProjectId, branch: string): Promise<Result<GitBehindAhead, GitCommandFailedError>> {
    this.getBehindAheadCalls.push({ projectId, branch });

    const failure = this.behindAheadFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const result = this.behindAheadResults.get(projectId.value);
    if (!result) {
      throw new Error(`no behind/ahead result seeded for ${projectId.value}`);
    }

    return { success: true, value: result };
  }

  async merge(projectId: ProjectId, input: GitMergeInput): Promise<Result<GitMergeOutcome, GitCommandFailedError>> {
    this.mergeCalls.push({ projectId, input });

    const failure = this.mergeFailures.get(projectId.value);
    if (failure) return { success: false, error: failure };

    const outcome = this.mergeResults.get(projectId.value);
    if (!outcome) {
      throw new Error(`no merge outcome seeded for ${projectId.value}`);
    }

    return { success: true, value: outcome };
  }
}
