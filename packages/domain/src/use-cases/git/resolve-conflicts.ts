import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { ConflictResolution } from '../../types/conflict-resolution';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { ConflictStageStore } from '../../ports/git/conflict-stage-store';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { NoConflictInProgressError } from '../../errors/git/no-conflict-in-progress';
import { GitConflictNotFoundError } from '../../errors/git/git-conflict-not-found';
import { InvalidResolutionError } from '../../errors/git/invalid-resolution';
import { requireGitRole } from './git-role-guard';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_CONFLICT_RESOLVED } from '../../audit-actions';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';

/** Everything `ResolveConflictsUseCase.execute` needs to record one file's conflict resolution. */
export interface ResolveConflictsInput {
  /** The user resolving the conflict. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose awaiting conflict this resolves a file for. */
  readonly projectId: ProjectId;
  /** The conflicting file's path, as recorded on the `GitConflict`. */
  readonly path: string;
  /** The chosen resolution for this file. */
  readonly resolution: ConflictResolution;
  /** The user-edited merged text. Required iff `resolution === 'merged'`; ignored otherwise. */
  readonly mergedContent?: string;
  /** Request origin, captured into audit metadata. */
  readonly context?: RequestContext;
}

/** What a successful resolution hands back. */
export type ResolveConflictsResult = {
  /** Always `true` on success — there is no other success outcome. */
  readonly resolved: true;
};

/**
 * Records a per-file resolution decision for one file of a conflicted pull/switch: keep-local
 * (`ours`), take-incoming (`theirs`), or a user-edited three-way merge (`merged`).
 *
 * Short, synchronous, and guard-free: unlike `PullChangesUseCase` (which runs under the worker's
 * claimed `RUNNING` row) or `CommitChangesUseCase` (which takes `withGuard`), this use case takes
 * NO lock of its own. The project's operation already sitting in `AWAITING_CONFLICT` IS the guard
 * — this only edits that operation's `GitConflict` rows and the off-tree stage store, never the
 * working tree, so nothing here can race a `withGuard`-gated action.
 *
 * Records one conflict at a time; it does NOT check whether every conflict on the operation is
 * now resolved, and it does NOT transition the operation. The operation stays `AWAITING_CONFLICT`
 * until a later use case blocks completion on any unresolved conflict and lands the whole merge.
 */
export class ResolveConflictsUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial and the successful resolution.
   * @param gitOperationRepo - Locates the awaiting operation, its conflicts, and persists the resolution.
   * @param conflictStageStore - Records the merged bytes for a `merged` resolution.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly conflictStageStore: ConflictStageStore,
    private readonly logger?: Logger,
  ) {}

  /**
   * Records `input.resolution` for `input.path` on the project's currently awaiting conflict.
   *
   * @param input - The acting user, the project, the path, and the chosen resolution.
   * @returns `{resolved: true}` on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link NoConflictInProgressError} when the project has no operation `AWAITING_CONFLICT`,
   *   {@link GitConflictNotFoundError} when `input.path` is not among that operation's conflicts,
   *   or {@link InvalidResolutionError} when a `merged` resolution is missing `mergedContent` or
   *   targets a binary conflict.
   */
  async execute(input: ResolveConflictsInput): Promise<Result<ResolveConflictsResult, DomainError>> {
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
    const conflict = conflicts.find((candidate) => candidate.path === input.path);
    if (!conflict) {
      return { success: false, error: new GitConflictNotFoundError(input.path) };
    }

    if (input.resolution === 'merged') {
      if (input.mergedContent === undefined) {
        return {
          success: false,
          error: new InvalidResolutionError("A 'merged' resolution requires mergedContent"),
        };
      }
      if (conflict.isBinary) {
        return {
          success: false,
          error: new InvalidResolutionError("A binary conflict cannot take a 'merged' resolution"),
        };
      }

      const write = await this.conflictStageStore.writeMerged(
        operation.id,
        input.path,
        Buffer.from(input.mergedContent, 'utf8'),
      );
      if (!write.success) return write;
    }

    const resolveResult = await this.gitOperationRepo.resolveConflict(operation.id, input.path, input.resolution);
    if (!resolveResult.success) return resolveResult;

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_CONFLICT_RESOLVED,
        resourceType: 'GitConflict',
        resourceId: resolveResult.value.id.value,
        metadata: { path: input.path, resolution: input.resolution },
        context: input.context,
      },
      this.logger,
    );

    return { success: true, value: { resolved: true } };
  }
}
