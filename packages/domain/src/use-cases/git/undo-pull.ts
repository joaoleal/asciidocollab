import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitOperationId } from '../../value-objects/ids/git-operation-id';
import { GitRepository } from '../../entities/git-repository';
import { GitCommandRunner } from '../../ports/git/git-command-runner';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { ConflictStageStore } from '../../ports/git/conflict-stage-store';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { GitSyncStatus } from '../../types/git-sync-status';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { NothingToUndoError } from '../../errors/git/nothing-to-undo';
import { requireGitRole } from './git-role-guard';
import { FileChangeReconciler } from './pull-changes';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_PULL_UNDONE } from '../../audit-actions';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
// Referenced only from this file's own JSDoc @link tags; kept imported so the links resolve.
import type { InsufficientRoleError } from '../../errors/git/insufficient-role';
import type { GitOperationInProgressError } from '../../errors/git/git-operation-in-progress';

/** Everything `UndoPullUseCase.execute` needs to undo a project's most recent pull. */
export interface UndoPullInput {
  /** The user undoing the pull. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose most recent pull to undo. */
  readonly projectId: ProjectId;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/** What a successful undo hands back. */
export interface UndoPullResult {
  /** The pull operation that was undone. */
  readonly operationId: GitOperationId;
  /** The commit the working tree was restored to (the pull's pre-operation `HEAD`). */
  readonly headCommit: string;
}

/**
 * Undoes a project's most recent pull, restoring the working tree (and the docs/live editors it
 * lands into) to the state captured just before that pull began. Covers both entry points
 * the feature describes as "the most recent pull/merge":
 *
 * - **A conflicted pull still `AWAITING_CONFLICT`** — the user abandons resolution instead of
 *   completing it. Undoes the SAME operation, transitioning it to `ABORTED`.
 * - **A clean pull that already `SUCCEEDED`**, with no operation currently active for the project —
 *   the pre-operation snapshot every pull records (clean or conflicted) is still retained, so it can
 *   still be undone. The pull operation itself stays `SUCCEEDED` (already terminal); only the
 *   project's working tree/docs and the audit trail record the undo. No new operation row is
 *   created for this.
 *
 * Runs SYNC (over the internal git RPC), not through the worker's poll/claim queue — the same
 * seam `CompleteMergeUseCase` uses. All-or-nothing: the working-tree reset is atomic and
 * runs first, so any later failure (reconciling, refreshing the row) still leaves the tree at the
 * safe pre-operation state; the pre-operation snapshot is only cleared once every step before it has
 * succeeded, so a failure leaves it in place for a retry.
 */
export class UndoPullUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial and the successful undo.
   * @param gitRepositoryRepo - Loads the project's repository link and writes it back once undone.
   * @param gitOperationRepo - Locates the awaiting/most-recent pull operation and drives its transitions.
   * @param commandRunner - Restores the working tree to the pull's pre-operation snapshot.
   * @param conflictStageStore - Reads whether a snapshot is still retained, and clears it once undone.
   * @param reconciler - Reverts the restored change-set into the project's docs/live editors.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly commandRunner: GitCommandRunner,
    private readonly conflictStageStore: ConflictStageStore,
    private readonly reconciler: FileChangeReconciler,
    private readonly logger?: Logger,
  ) {}

  /**
   * Undoes `input.projectId`'s most recent pull.
   *
   * @param input - The acting user and the project.
   * @returns The undone operation's id and the commit the tree was restored to on success; a typed
   *   refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link RepositoryNotConnectedError} when the project has no connected repository,
   *   {@link NothingToUndoError} when no pull is `AWAITING_CONFLICT` and no prior pull's
   *   pre-operation snapshot is still retained,
   *   {@link GitOperationInProgressError} when another operation is active and is not the
   *   `AWAITING_CONFLICT` pull this undoes, or a {@link GitCommandFailedError} when restoring the
   *   snapshot or reverting the change-set fails.
   */
  async execute(input: UndoPullInput): Promise<Result<UndoPullResult, DomainError>> {
    const roleCheck = await requireGitRole(
      this.projectMemberRepo,
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        requiredRole: 'editor',
        context: input.context,
      },
      this.logger,
    );
    if (!roleCheck.success) return roleCheck;

    const activeOperation = await this.gitOperationRepo.findActiveOperation(input.projectId);
    if (activeOperation && activeOperation.kind === 'PULL' && activeOperation.state === 'AWAITING_CONFLICT') {
      return this.undoAwaitingConflict(input, activeOperation.id);
    }

    // No AWAITING_CONFLICT pull to undo directly: acquire the single-flight guard so this cannot
    // race a new operation, then look for the most recent clean pull that still has a snapshot.
    // If another operation IS active (any kind/state other than the case above), `withGuard` itself
    // refuses with `GitOperationInProgressError` — the correct outcome, since something else really
    // is in progress.
    const guarded = await this.gitOperationRepo.withGuard(input.projectId, () =>
      this.undoMostRecentSucceededPull(input),
    );
    return guarded.success ? guarded.value : guarded;
  }

  /** Case A: undoes the pull currently `AWAITING_CONFLICT`, transitioning it to `ABORTED`. */
  private async undoAwaitingConflict(
    input: UndoPullInput,
    operationId: GitOperationId,
  ): Promise<Result<UndoPullResult, DomainError>> {
    const gitRepository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (gitRepository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const transitioned = await this.gitOperationRepo.transition(operationId, 'RUNNING');
    if (!transitioned.success) return transitioned;

    const restored = await this.commandRunner.restoreToSnapshot(input.projectId, { operationId });
    if (!restored.success) {
      await this.gitOperationRepo.transition(operationId, 'AWAITING_CONFLICT');
      return restored;
    }

    const reverted = await this.reconciler.apply(input.projectId, restored.value.changes);
    if (!reverted.success) {
      await this.gitOperationRepo.transition(operationId, 'AWAITING_CONFLICT');
      return reverted;
    }

    await this.refreshRowAfterUndo(gitRepository, input.projectId);
    await this.gitOperationRepo.clearConflicts(operationId);
    await this.conflictStageStore.clear(operationId);
    await this.gitOperationRepo.transition(operationId, 'ABORTED');

    await this.audit(input, operationId, 'awaiting_conflict');

    return { success: true, value: { operationId, headCommit: restored.value.headCommit } };
  }

  /**
   * Case B: no operation is currently active for the project. Finds the most recent `PULL`
   * operation (any state, since it must be terminal here — nothing active exists) and, only if it
   * `SUCCEEDED` and still has a retained snapshot, restores to it. The pull operation itself is left
   * exactly as it was (already terminal); no new operation row is created.
   */
  private async undoMostRecentSucceededPull(input: UndoPullInput): Promise<Result<UndoPullResult, DomainError>> {
    const gitRepository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (gitRepository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const pull = await this.gitOperationRepo.findMostRecentByKind(input.projectId, 'PULL');
    if (!pull || pull.state !== 'SUCCEEDED') {
      return { success: false, error: new NothingToUndoError() };
    }

    const snapshot = await this.conflictStageStore.readSnapshot(pull.id);
    if (!snapshot.success) return snapshot;
    if (snapshot.value === null) {
      return { success: false, error: new NothingToUndoError() };
    }

    const restored = await this.commandRunner.restoreToSnapshot(input.projectId, { operationId: pull.id });
    if (!restored.success) return restored;

    const reverted = await this.reconciler.apply(input.projectId, restored.value.changes);
    if (!reverted.success) return reverted;

    await this.refreshRowAfterUndo(gitRepository, input.projectId);
    await this.conflictStageStore.clear(pull.id);

    await this.audit(input, pull.id, 'succeeded_pull');

    return { success: true, value: { operationId: pull.id, headCommit: restored.value.headCommit } };
  }

  private async audit(input: UndoPullInput, operationId: GitOperationId, undoCase: string): Promise<void> {
    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_PULL_UNDONE,
        resourceType: 'GitOperation',
        resourceId: operationId.value,
        metadata: { case: undoCase },
        context: input.context,
      },
      this.logger,
    );
  }

  /**
   * Recomputes the repository link's sync status against the already-fetched remote-tracking ref
   * (the reset touches only the local branch, never the tracking ref) and rewrites the loaded row
   * with it. Every other field is carried over unchanged. A recompute failure is swallowed and the
   * row's prior status is kept — a best-effort refresh, not itself part of the undo's correctness.
   */
  private async refreshRowAfterUndo(loaded: GitRepository, projectId: ProjectId): Promise<void> {
    const behindAhead = await this.commandRunner.getBehindAhead(projectId, loaded.currentBranch);
    const syncStatus: GitSyncStatus = behindAhead.success
      ? deriveSyncStatus(behindAhead.value.behind, behindAhead.value.ahead)
      : loaded.syncStatus;

    const updated = new GitRepository(
      loaded.id,
      loaded.projectId,
      loaded.provider,
      loaded.remoteUrl,
      loaded.credentialReference,
      loaded.currentBranch,
      syncStatus,
      loaded.defaultBranch,
      loaded.lastKnownRemoteHead,
      loaded.lastSyncAt,
      loaded.createdAt,
      loaded.connectedByUserId,
    );
    await this.gitRepositoryRepo.save(updated);
  }
}

/** Maps a behind/ahead count pair to the closest `GitSyncStatus`. */
function deriveSyncStatus(behind: number, ahead: number): GitSyncStatus {
  if (behind > 0 && ahead > 0) return 'DIVERGED';
  if (behind > 0) return 'BEHIND';
  if (ahead > 0) return 'AHEAD';
  return 'UP_TO_DATE';
}
