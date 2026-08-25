import type {
  AuthenticationFailedError,
  ClonedRepository,
  GitCloneInput,
  GitCommandFailedError,
  GitCommandRunner,
  GitCommitResult,
  GitPushError,
  GitPushInput,
  GitPushResult,
  GitWorkingTreeStatus,
  ProjectId,
  RepositoryUnreachableError,
  Result,
} from '@asciidocollab/domain';

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

  /** Every call made to `clone`, in call order, for asserting interactions. */
  readonly cloneCalls: GitCloneInput[] = [];

  /** Every call made to `push`, in call order, for asserting interactions. */
  readonly pushCalls: { projectId: ProjectId; input: GitPushInput }[] = [];

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
}
