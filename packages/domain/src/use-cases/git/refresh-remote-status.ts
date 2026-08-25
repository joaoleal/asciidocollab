import { ProjectId } from '../../value-objects/ids/project-id';
import { GitRepository } from '../../entities/git-repository';
import { GitCommandRunner } from '../../ports/git/git-command-runner';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { GitSyncStatus } from '../../types/git-sync-status';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { Logger } from '../../ports/observability/logger';
import { Result } from '../../types/result';

/**
 * Everything `RefreshRemoteStatusUseCase.execute` needs to fetch a project's remote-tracking ref
 * and recompute its stored sync status. Unlike `ConnectRepository`/`ImportRepository`, this use
 * case never touches the credential store — the caller (a route or a background scheduler) has
 * already loaded and decrypted the stored credential by the time this runs, and hands the
 * plaintext token straight through here.
 */
export interface RefreshRemoteStatusInput {
  /** The project whose remote-tracking ref to refresh. */
  readonly projectId: ProjectId;
  /**
   * The plaintext access token to authenticate with. Passed straight through to
   * `GitCommandRunner.fetch` and never persisted or logged here.
   */
  readonly token: string;
}

/** What a successful refresh hands back. */
export interface RefreshRemoteStatusResult {
  /** The repository's sync status after this refresh — the derived status, or the row's
   *  preserved `CONFLICTED` status when the row was already conflicted. */
  readonly syncStatus: GitSyncStatus;
  /** The number of commits the remote-tracking ref has that the local branch does not. */
  readonly behind: number;
  /** The number of commits the local branch has that the remote-tracking ref does not. */
  readonly ahead: number;
  /** The tip of the remote-tracking ref after the fetch. */
  readonly lastKnownRemoteHead: string;
}

/**
 * Fetches a project's remote-tracking ref and recomputes+stores its `syncStatus`, so a "behind by
 * N — pull available" prompt stays meaningful without requiring a full pull.
 *
 * "Remote status only, no content egress": this only fetches refs (`GitCommandRunner.fetch`) and
 * compares them (`getBehindAhead`) — it never reads or downloads any file content, which only
 * happens in a pull/merge.
 *
 * No self-gate — the caller (a VIEWER-gated route triggering a sync, or a background scheduler)
 * decides when this runs and with what authorization; that scheduling is out of scope here.
 */
export class RefreshRemoteStatusUseCase {
  /**
   * @param gitRepositoryRepo - Loads the project's repository link and writes it back on success.
   * @param commandRunner - Fetches the remote-tracking ref and compares it to the local branch.
   * @param logger - Optional sink for best-effort diagnostics.
   */
  constructor(
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitCommandRunner,
    private readonly logger?: Logger,
  ) {}

  /**
   * Refreshes `input.projectId`'s remote-tracking ref and recomputes its stored sync status,
   * using `input.token` to authenticate.
   *
   * @param input - The project and the credential to fetch with.
   * @returns The refreshed sync status, behind/ahead counts, and remote head on success; a
   *   {@link RepositoryNotConnectedError} when the project has no connected repository, or
   *   whatever typed error `fetch`/`getBehindAhead` fails with. Every failure leaves the
   *   project's `GitRepository` link untouched.
   */
  async execute(input: RefreshRemoteStatusInput): Promise<Result<RefreshRemoteStatusResult, DomainError>> {
    const gitRepository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (gitRepository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const fetchResult = await this.commandRunner.fetch(input.projectId, {
      remoteUrl: gitRepository.remoteUrl,
      token: input.token,
      branch: gitRepository.currentBranch,
    });
    if (!fetchResult.success) return fetchResult;

    const countsResult = await this.commandRunner.getBehindAhead(input.projectId, gitRepository.currentBranch);
    if (!countsResult.success) return countsResult;

    const { behind, ahead } = countsResult.value;
    const derivedSyncStatus = deriveSyncStatus(behind, ahead);
    // A repo with unresolved merge conflicts stays CONFLICTED until resolved — a fetch/refresh
    // never clears that status on its own.
    const syncStatus: GitSyncStatus =
      gitRepository.syncStatus === 'CONFLICTED' ? 'CONFLICTED' : derivedSyncStatus;

    // Reuses the loaded row's own id, provider, remote URL, credential reference, branch, default
    // branch, and creation metadata — this write only completes the fields the refresh observed.
    const updatedRepository = new GitRepository(
      gitRepository.id,
      gitRepository.projectId,
      gitRepository.provider,
      gitRepository.remoteUrl,
      gitRepository.credentialReference,
      gitRepository.currentBranch,
      syncStatus,
      gitRepository.defaultBranch,
      fetchResult.value.remoteHead,
      new Date(),
      gitRepository.createdAt,
      gitRepository.connectedByUserId,
    );
    await this.gitRepositoryRepo.save(updatedRepository);

    return {
      success: true,
      value: { syncStatus, behind, ahead, lastKnownRemoteHead: fetchResult.value.remoteHead },
    };
  }
}

/** Derives a sync status purely from behind/ahead counts — never itself preserves CONFLICTED. */
function deriveSyncStatus(behind: number, ahead: number): GitSyncStatus {
  if (behind === 0 && ahead === 0) return 'UP_TO_DATE';
  if (behind > 0 && ahead === 0) return 'BEHIND';
  if (behind === 0 && ahead > 0) return 'AHEAD';
  return 'DIVERGED';
}
