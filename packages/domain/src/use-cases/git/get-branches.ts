import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitReadPort } from '../../ports/git/git-command-runner';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { Logger } from '../../ports/observability/logger';
import { Result } from '../../types/result';

/** Everything `GetBranchesUseCase.execute` needs to list a project's branches. */
export interface GetBranchesInput {
  /** The project whose branches to list. */
  readonly projectId: ProjectId;
  /** The user asking to list the branches. Not itself checked here — the calling route enforces membership. */
  readonly actorId?: UserId;
}

/** A project's branches: the checked-out branch plus every local branch name. */
export interface GetBranchesResult {
  /** The currently checked-out branch. */
  readonly current: string;
  /** Every local branch name. */
  readonly branches: readonly string[];
}

/**
 * Lists a project's local branches and the one currently checked out.
 *
 * Read-only and lock-free — this is a short, local working-tree read, not a mutating git action,
 * so it takes no single-flight guard and enforces no role beyond what the calling route requires.
 */
export class GetBranchesUseCase {
  /**
   * @param gitRepositoryRepo - Confirms the project has a connected repository.
   * @param commandRunner - Reads the live working tree's branches.
   * @param logger - Optional sink for best-effort diagnostics.
   */
  constructor(
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitReadPort,
    private readonly logger?: Logger,
  ) {}

  /**
   * Lists the branches for `input.projectId`.
   *
   * @param input - The project whose branches to list.
   * @returns The current branch and every local branch name on success; a
   *   {@link RepositoryNotConnectedError} when the project has no repository link, or the
   *   {@link GitCommandFailedError} the underlying git command fails with.
   */
  async execute(input: GetBranchesInput): Promise<Result<GetBranchesResult, DomainError>> {
    const repository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (repository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const listResult = await this.commandRunner.listBranches(input.projectId);
    if (!listResult.success) return listResult;

    return {
      success: true,
      value: {
        current: listResult.value.current,
        branches: listResult.value.branches,
      },
    };
  }
}
