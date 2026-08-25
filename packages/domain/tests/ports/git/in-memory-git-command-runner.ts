import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../../src/errors/git/authentication-failed';
import {
  ClonedRepository,
  GitCloneInput,
  GitCommandRunner,
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

  /** Every call made to `getStatus`, in call order, for asserting use-case interactions. */
  readonly statusCalls: ProjectId[] = [];

  /** Every call made to `checkRemoteAccess`, in call order, for asserting use-case interactions. */
  readonly remoteAccessCalls: GitRemoteAccessCheck[] = [];

  /** Every call made to `clone`, in call order, for asserting use-case interactions. */
  readonly cloneCalls: GitCloneInput[] = [];

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
}
