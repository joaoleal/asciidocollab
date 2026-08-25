import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../../src/errors/git/authentication-failed';
import {
  ClonedRepository,
  GitCloneInput,
  GitCommandRunner,
  GitCommitInput,
  GitCommitResult,
  GitRemoteAccessCheck,
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
}
