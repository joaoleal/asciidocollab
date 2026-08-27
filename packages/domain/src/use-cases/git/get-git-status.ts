import { ProjectId } from '../../value-objects/ids/project-id';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { GitPendingChange, GitReadPort } from '../../ports/git/git-command-runner';
import { GitSyncStatus } from '../../types/git-sync-status';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { Logger } from '../../ports/observability/logger';
import { Result } from '../../types/result';

/** Everything `GetGitStatusUseCase.execute` needs to read a project's working-tree status. */
export interface GetGitStatusInput {
  /** The project whose working tree to read. */
  readonly projectId: ProjectId;
}

/**
 * A project's git working-tree status: its current branch, its classified pending changes, and
 * its last-observed sync standing relative to the remote. Purely a local, live read — it carries
 * no ahead/behind counts (those are a numeric comparison against the remote, a separate use case)
 * and `syncStatus` is whatever the `GitRepository` row last recorded, not re-derived here.
 */
export interface GetGitStatusResult {
  /** The currently checked-out branch, as observed on the live working tree. */
  readonly currentBranch: string;
  /** Every pending (uncommitted) change, classified by kind and by staged/unstaged/untracked state. */
  readonly changes: readonly GitPendingChange[];
  /** The repository's synchronisation standing relative to its remote, as last observed. */
  readonly syncStatus: GitSyncStatus;
  /** The remote's default branch, or null if not yet known. */
  readonly defaultBranch: string | null;
  /** The last remote commit hash observed for the repository's current branch, or null if not yet known. */
  readonly lastKnownRemoteHead: string | null;
  /** Timestamp of the last successful synchronisation, or null if never synced. */
  readonly lastSyncAt: Date | null;
}

/**
 * Reads a project's git working-tree status: the current branch and every pending change (each
 * classified by kind and by staged/unstaged/untracked/conflicted state), combined with the
 * project's `GitRepository` sync metadata.
 *
 * Read-only and lock-free — this is a short, local working-tree read, not a mutating git action,
 * so it takes no single-flight guard and enforces no role beyond what the calling route requires.
 * It always reads the live working tree; it never substitutes a last-known status for one held up
 * by a concurrent mutating operation — that routing, if any, belongs to the caller that dispatches
 * this use case, not to the use case itself.
 */
export class GetGitStatusUseCase {
  /**
   * @param gitRepositoryRepo - Loads the project's repository link and its sync metadata.
   * @param commandRunner - Reads the live working tree's branch and pending changes.
   * @param logger - Optional sink for best-effort diagnostics.
   */
  constructor(
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitReadPort,
    private readonly logger?: Logger,
  ) {}

  /**
   * Reads the working-tree status for `input.projectId`.
   *
   * @param input - The project whose status to read.
   * @returns The working-tree status and repository sync metadata on success; a
   *   {@link RepositoryNotConnectedError} when the project has no repository link, or the
   *   {@link GitCommandFailedError} the working-tree read itself fails with.
   */
  async execute(input: GetGitStatusInput): Promise<Result<GetGitStatusResult, DomainError>> {
    const repository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (repository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const statusResult = await this.commandRunner.getStatus(input.projectId);
    if (!statusResult.success) return statusResult;

    return {
      success: true,
      value: {
        currentBranch: statusResult.value.currentBranch,
        changes: statusResult.value.changes,
        syncStatus: repository.syncStatus,
        defaultBranch: repository.defaultBranch,
        lastKnownRemoteHead: repository.lastKnownRemoteHead,
        lastSyncAt: repository.lastSyncAt,
      },
    };
  }
}
