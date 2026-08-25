import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { GitBehindAhead, GitCommandRunner } from '../../ports/git/git-command-runner';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { Logger } from '../../ports/observability/logger';
import { Result } from '../../types/result';

/** Everything `GetBehindAheadUseCase.execute` needs to compare a project's branch to its remote. */
export interface GetBehindAheadInput {
  /** The project whose branch to compare. */
  readonly projectId: ProjectId;
  /** The user requesting the counts. Not used for gating here — the route enforces it. */
  readonly actorId?: UserId;
}

/**
 * How far a project's current branch stands from its already-fetched remote-tracking ref: how
 * many commits `getBehindAhead` needs to back a "behind by N — pull available" prompt.
 *
 * Read-only, local, lock-free — this is a cheap comparison of the local branch to whatever the
 * remote-tracking ref last held, not a network call: it does not itself update the ref, so its
 * counts are only as fresh as the last fetch. `RefreshRemoteStatus` is what performs that fetch.
 */
export class GetBehindAheadUseCase {
  /**
   * @param gitRepositoryRepo - Loads the project's repository link.
   * @param commandRunner - Compares the local branch to its remote-tracking ref.
   * @param logger - Optional sink for best-effort diagnostics.
   */
  constructor(
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitCommandRunner,
    private readonly logger?: Logger,
  ) {}

  /**
   * Compares `input.projectId`'s current branch to its already-fetched remote-tracking ref.
   *
   * @param input - The project (and optionally the requesting user) whose branch to compare.
   * @returns The behind/ahead counts on success; a {@link RepositoryNotConnectedError} when the
   *   project has no repository link, or the `GitCommandFailedError` the comparison itself fails
   *   with.
   */
  async execute(input: GetBehindAheadInput): Promise<Result<GitBehindAhead, DomainError>> {
    const repository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (repository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    return this.commandRunner.getBehindAhead(input.projectId, repository.currentBranch);
  }
}
