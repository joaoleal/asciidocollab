import { ProjectId } from '../../value-objects/ids/project-id';
import { GitReadPort, GitRemotePort } from '../../ports/git/git-command-runner';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { GitSyncStatus } from '../../types/git-sync-status';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { Logger } from '../../ports/observability/logger';
import { Result } from '../../types/result';
import { deriveSyncStatus } from './derive-sync-status';

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
  /**
   * The repository's sync status after this refresh — the derived status, or the row's
   *  preserved `CONFLICTED` status when the row was already conflicted.
   */
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
    private readonly commandRunner: GitRemotePort & GitReadPort,
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

    // A conditional persist scoped to ONLY the fields this refresh observed (status, remote head,
    // last-sync time) — it never rewrites `currentBranch`/`remoteUrl`/`credentialReference`/etc.
    // from the loaded (now possibly stale) snapshot, so a user action that changed one of those
    // during the multi-second fetch is not reverted. It also never clears a `CONFLICTED` status a
    // concurrent pull may have set between this use case's load and this write: when the loaded row
    // was itself CONFLICTED, `syncStatus` above is CONFLICTED and the write proceeds (updating
    // head/last-sync while keeping the conflict); only a derived non-conflicted status is blocked
    // against a concurrently stored conflict.
    const persisted = await this.gitRepositoryRepo.saveRefreshedStatus({
      projectId: gitRepository.projectId,
      syncStatus,
      // The status this use case observed when it loaded the row, before the fetch. It guards the
      // CONFLICTED-preserving write: re-asserting CONFLICTED must land only while the row still holds
      // this observed status, so a concurrent resolve (a complete-merge that cleared the conflict
      // during the fetch) leaves it unmatched instead of being stomped back to CONFLICTED. A false
      // return then flows into the re-read/derive path below.
      expectedCurrentStatus: gitRepository.syncStatus,
      lastKnownRemoteHead: fetchResult.value.remoteHead,
      lastSyncAt: new Date(),
    });

    // A `false` return from the conditional write means the row was NOT written, but conflates two
    // distinct races: (a) a concurrent pull set the row `CONFLICTED` between this use case's load
    // and its write, so the guard blocked the derived (non-conflicted) status; or (b) the row is
    // gone — the repository was disconnected/deleted during the multi-second fetch, so there was
    // nothing to update. The boolean alone cannot tell these apart, so re-read the row (best-effort)
    // to disambiguate: only a still-present `CONFLICTED` row is a genuine conflict to report; a
    // missing (or since-resolved) row means there is no conflict to preserve, so report the derived
    // status. This keeps a caller from ever seeing "up to date" over a kept conflict (case a) while
    // no longer misreporting a disconnected repository as `CONFLICTED` (case b).
    let effectiveSyncStatus: GitSyncStatus = syncStatus;
    if (!persisted) {
      const latest = await this.gitRepositoryRepo.findByProjectId(input.projectId);
      effectiveSyncStatus = latest?.syncStatus === 'CONFLICTED' ? 'CONFLICTED' : derivedSyncStatus;
    }

    return {
      success: true,
      value: {
        syncStatus: effectiveSyncStatus,
        behind,
        ahead,
        lastKnownRemoteHead: fetchResult.value.remoteHead,
      },
    };
  }
}
