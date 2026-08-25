import type {
  AuthenticationFailedError,
  ClonedRepository,
  GitCloneInput,
  GitCommandFailedError,
  GitCommandRunner,
  GitCommitResult,
  GitPushError,
  GitPushResult,
  GitWorkingTreeStatus,
  RepositoryUnreachableError,
  Result,
} from '@asciidocollab/domain';

/**
 * A local, minimal in-memory `GitCommandRunner` fake for this app's tests, covering only what
 * `ImportRepositoryUseCase` exercises (`clone`). See `in-memory-git-operation-repository.ts`'s
 * class docs for why this app keeps its own fakes rather than reusing `packages/domain/tests`'.
 */
export class InMemoryGitCommandRunner implements GitCommandRunner {
  private readonly clonedRepositories = new Map<string, ClonedRepository>();
  private readonly cloneFailures = new Map<
    string,
    RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError
  >();

  /** Every call made to `clone`, in call order, for asserting interactions. */
  readonly cloneCalls: GitCloneInput[] = [];

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

  async push(): Promise<Result<GitPushResult, GitPushError>> {
    throw new Error('not used by these tests');
  }
}
