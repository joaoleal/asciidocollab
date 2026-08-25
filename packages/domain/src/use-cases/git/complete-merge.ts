import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitOperationId } from '../../value-objects/ids/git-operation-id';
import { GitRepository } from '../../entities/git-repository';
import { GitConflict } from '../../entities/git-conflict';
import { GitCommandRunner, GitMergeFileChange } from '../../ports/git/git-command-runner';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { ConflictStageStore } from '../../ports/git/conflict-stage-store';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { NoConflictInProgressError } from '../../errors/git/no-conflict-in-progress';
import { UnresolvedConflictsError } from '../../errors/git/unresolved-conflicts';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { requireGitRole } from './git-role-guard';
import { FileChangeReconciler } from './pull-changes';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_CONFLICTS_RESOLVED } from '../../audit-actions';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
// Referenced only from this file's own JSDoc @link tags; kept imported so the links resolve.
import type { InsufficientRoleError } from '../../errors/git/insufficient-role';

/** Everything `CompleteMergeUseCase.execute` needs to complete a project's currently conflicted operation. */
export interface CompleteMergeInput {
  /** The user completing the operation. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose awaiting conflict to complete. */
  readonly projectId: ProjectId;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/** What a successful completion hands back. */
export interface CompleteMergeResult {
  /** Always `'resolved'` on success — there is no other success outcome. */
  readonly status: 'resolved';
  /** The completed operation. */
  readonly operationId: GitOperationId;
  /**
   * The resolving merge commit's hash, for a completed `PULL`. A completed `BRANCH_SWITCH` never
   * takes a commit (a switch never commits), so this is an empty string for that kind — kept for
   * the result shape's parity across both kinds rather than a separate per-kind result type.
   */
  readonly headCommit: string;
}

/**
 * Completes a project's currently conflicted operation, once every one of its conflicts has a
 * recorded resolution: a conflicted `PULL` re-runs the merge, drops each file's chosen resolution
 * onto its path, and takes a genuine resolving commit; a conflicted `BRANCH_SWITCH` builds
 * the resolved change-set directly from the recorded resolutions and lands it — a switch never
 * commits, so there is no merge to re-run. Either way, the landed change-set is reconciled into the
 * project's docs/live editors exactly as a clean pull/switch would.
 *
 * Named generically (not "CompletePull") because it serves both conflict origins from one flow,
 * dispatching on the awaiting operation's `kind`.
 *
 * Runs SYNC (over the internal git RPC), not through the worker's poll/claim queue: the awaiting
 * operation already holds the project's single-flight slot, so this use case operates on that
 * EXISTING row (`AWAITING_CONFLICT → RUNNING → SUCCEEDED`) rather than enqueuing a new one. Any
 * mid-op failure moves the operation back to `AWAITING_CONFLICT` (retryable) and lands nothing —
 * all-or-nothing.
 */
export class CompleteMergeUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial and the successful completion.
   * @param gitRepositoryRepo - Loads the project's repository link and writes it back once completed.
   * @param gitOperationRepo - Locates the awaiting operation, its conflicts, and drives its transitions.
   * @param commandRunner - Re-runs the merge (for a `PULL`) and takes the resolving commit.
   * @param conflictStageStore - Reads each resolved file's bytes (for a `BRANCH_SWITCH`) and is cleared on completion.
   * @param reconciler - Lands the completed change-set into the project's docs/live editors.
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
   * Completes `input.projectId`'s currently awaiting conflicted operation.
   *
   * @param input - The acting user and the project.
   * @returns The completed operation's id and resolving commit (empty for a completed switch) on
   *   success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link NoConflictInProgressError} when the project has no operation `AWAITING_CONFLICT`,
   *   {@link UnresolvedConflictsError} when at least one conflict still has no recorded resolution
   *   (no state change on this path),
   *   {@link RepositoryNotConnectedError} when the project has no connected repository, or a
   *   {@link GitCommandFailedError} when the re-run merge/landing fails (the operation reverts to
   *   `AWAITING_CONFLICT`, nothing lands).
   */
  async execute(input: CompleteMergeInput): Promise<Result<CompleteMergeResult, DomainError>> {
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

    const operation = await this.gitOperationRepo.findActiveOperation(input.projectId);
    if (!operation || operation.state !== 'AWAITING_CONFLICT') {
      return { success: false, error: new NoConflictInProgressError() };
    }

    const conflicts = await this.gitOperationRepo.listConflicts(operation.id);
    if (conflicts.some((conflict) => !conflict.resolved)) {
      // Completion is blocked until every conflict is resolved: no state change, nothing landed.
      return { success: false, error: new UnresolvedConflictsError() };
    }

    const gitRepository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (gitRepository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const transitioned = await this.gitOperationRepo.transition(operation.id, 'RUNNING');
    if (!transitioned.success) return transitioned;

    const changesResult =
      operation.kind === 'PULL'
        ? await this.resolvePull(gitRepository, operation.id, conflicts)
        : await this.resolveSwitch(operation.id, conflicts);

    if (!changesResult.success) {
      await this.gitOperationRepo.transition(operation.id, 'AWAITING_CONFLICT');
      return changesResult;
    }

    const landed = await this.reconciler.apply(input.projectId, changesResult.value.changes);
    if (!landed.success) {
      await this.gitOperationRepo.transition(operation.id, 'AWAITING_CONFLICT');
      return landed;
    }

    if (operation.kind === 'PULL') {
      await this.refreshRowForPull(gitRepository, changesResult.value.headCommit);
    } else {
      await this.refreshRowForSwitch(gitRepository);
    }

    await this.gitOperationRepo.clearConflicts(operation.id);
    await this.conflictStageStore.clear(operation.id);
    await this.gitOperationRepo.transition(operation.id, 'SUCCEEDED');

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_CONFLICTS_RESOLVED,
        resourceType: 'GitOperation',
        resourceId: operation.id.value,
        metadata: { kind: operation.kind },
        context: input.context,
      },
      this.logger,
    );

    return {
      success: true,
      value: { status: 'resolved', operationId: operation.id, headCommit: changesResult.value.headCommit },
    };
  }

  /**
   * `PULL` completion: re-runs the merge with every conflict's chosen resolution and takes the
   * resolving commit. `stillConflicted` (a caller/validation bug, since every conflict is confirmed
   * resolved above) is treated as a completion failure, not a success.
   */
  private async resolvePull(
    gitRepository: GitRepository,
    operationId: GitOperationId,
    conflicts: readonly GitConflict[],
  ): Promise<Result<{ headCommit: string; changes: readonly GitMergeFileChange[] }, DomainError>> {
    const resolved = await this.commandRunner.resolveMerge(gitRepository.projectId, {
      branch: gitRepository.currentBranch,
      operationId,
      resolutions: conflicts.map((conflict) => ({
        path: conflict.path,
        // Every conflict is confirmed resolved before this runs — `resolution` is never null here.
        resolution: conflict.resolution!,
      })),
    });
    if (!resolved.success) return resolved;

    if (resolved.value.status === 'stillConflicted') {
      return {
        success: false,
        error: new GitCommandFailedError('The merge could not be completed: some conflicts remain unresolved.'),
      };
    }

    return { success: true, value: { headCommit: resolved.value.headCommit, changes: resolved.value.changes } };
  }

  /**
   * `BRANCH_SWITCH` completion: a switch never commits, so there is no merge to re-run. The
   * resolved change-set is built directly from each conflict's chosen resolution, reading the
   * losing/winning bytes back from the `ConflictStageStore` (the captured stages for `ours`/
   * `theirs`, or the recorded bytes for `merged`).
   */
  private async resolveSwitch(
    operationId: GitOperationId,
    conflicts: readonly GitConflict[],
  ): Promise<Result<{ headCommit: string; changes: readonly GitMergeFileChange[] }, DomainError>> {
    const changes: GitMergeFileChange[] = [];

    for (const conflict of conflicts) {
      const content = await this.readResolvedBytes(operationId, conflict);
      if (!content.success) return content;

      changes.push({
        type: 'modified',
        path: conflict.path,
        content: content.value,
        mimeType: fallbackMimeType(conflict.isBinary),
      });
    }

    return { success: true, value: { headCommit: '', changes } };
  }

  /** Reads the bytes a single conflict's chosen resolution resolves to, off the stage store. */
  private async readResolvedBytes(
    operationId: GitOperationId,
    conflict: GitConflict,
  ): Promise<Result<Buffer, DomainError>> {
    if (conflict.resolution === 'merged') {
      const merged = await this.conflictStageStore.readMerged(operationId, conflict.path);
      if (!merged.success) return merged;
      if (merged.value === null) {
        return {
          success: false,
          error: new GitCommandFailedError(`No merged content was recorded for '${conflict.path}'.`),
        };
      }
      return { success: true, value: merged.value };
    }

    const stages = await this.conflictStageStore.readStages(operationId, conflict.path);
    if (!stages.success) return stages;
    if (stages.value === null) {
      return {
        success: false,
        error: new GitCommandFailedError(`No captured stages were recorded for '${conflict.path}'.`),
      };
    }

    return { success: true, value: conflict.resolution === 'ours' ? stages.value.ours : stages.value.theirs };
  }

  /**
   * Rewrites the loaded repository link after a completed `PULL`: `UP_TO_DATE`, the resolving
   * commit as the observed remote head, and a fresh `lastSyncAt` — the same shape `PullChangesUseCase`
   * writes on a clean merge. Every other field is carried over from the loaded row.
   */
  private async refreshRowForPull(loaded: GitRepository, headCommit: string): Promise<void> {
    const updated = new GitRepository(
      loaded.id,
      loaded.projectId,
      loaded.provider,
      loaded.remoteUrl,
      loaded.credentialReference,
      loaded.currentBranch,
      'UP_TO_DATE',
      loaded.defaultBranch,
      headCommit,
      new Date(),
      loaded.createdAt,
      loaded.connectedByUserId,
    );
    await this.gitRepositoryRepo.save(updated);
  }

  /**
   * Rewrites the loaded repository link after a completed `BRANCH_SWITCH`: only `syncStatus` moves
   * to `UP_TO_DATE` — the branch and remote head were already set to their post-switch values when
   * the original conflicted switch recorded `CONFLICTED` (`SwitchBranchUseCase`'s own `refreshRow`),
   * so nothing else here needs to change.
   */
  private async refreshRowForSwitch(loaded: GitRepository): Promise<void> {
    const updated = new GitRepository(
      loaded.id,
      loaded.projectId,
      loaded.provider,
      loaded.remoteUrl,
      loaded.credentialReference,
      loaded.currentBranch,
      'UP_TO_DATE',
      loaded.defaultBranch,
      loaded.lastKnownRemoteHead,
      loaded.lastSyncAt,
      loaded.createdAt,
      loaded.connectedByUserId,
    );
    await this.gitRepositoryRepo.save(updated);
  }
}

/**
 * A conservative fallback MIME type for a conflict's resolved bytes, classified only as text vs
 * binary (the only distinction `GitConflict.isBinary` carries). Never actually consulted for an
 * existing file: `GitChangeReconciler` only reads a `modified` change's `mimeType` when the file's
 * node is unexpectedly missing (an anomaly, not the normal case for a conflict on an already-tracked
 * file) — this exists solely to satisfy the change-set's shape.
 */
function fallbackMimeType(isBinary: boolean): string {
  return isBinary ? 'application/octet-stream' : 'text/plain';
}
