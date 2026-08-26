import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitCommandRunner } from '../../ports/git/git-command-runner';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { requireGitRole } from './git-role-guard';
import { FileChangeReconciler } from './pull-changes';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_CHANGES_DISCARDED } from '../../audit-actions';

/** Everything `DiscardChangesUseCase.execute` needs to restore one or more files. */
export interface DiscardChangesInput {
  /** The user asking to discard/restore. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose working tree to restore. */
  readonly projectId: ProjectId;
  /** Project-relative paths (no leading slash) of the files to restore. */
  readonly paths: readonly string[];
  /** When given, restores each path to its content at this commit instead of dropping back to HEAD. */
  readonly fromCommit?: string;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/** What a successful discard/restore hands back. */
export interface DiscardChangesResult {
  /** Workspace-relative paths (no leading slash) of every file this run restored. */
  readonly restoredPaths: readonly string[];
}

/**
 * Discards a file's uncommitted working-tree changes, or restores it to a chosen commit — a
 * whole-project mutating git action (the authorization matrix lists discard under EDITOR): it
 * self-gates role and takes the project's single-flight guard.
 *
 * Unlike commit/pull, this deliberately does NOT capture or preserve any open document's live
 * text — the whole point of a discard is to throw that live text away. The restored (committed)
 * content the runner produces is landed back into the project, INCLUDING into any currently open
 * collaborative editor, via the injected {@link FileChangeReconciler}: for a file whose document
 * has an open room, the reconciler routes the restored content through the collaborative source of
 * truth, overwriting the user's discarded live text with what was just restored. That is the
 * intended behavior, not a bug.
 */
export class DiscardChangesUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial.
   * @param gitRepositoryRepo - Confirms the project has a connected repository.
   * @param gitOperationRepo - Single-flight guard so this cannot race another git action.
   * @param commandRunner - Restores the given paths in the working tree and produces the change-set.
   * @param reconciler - Lands the restored change-set into the project, including any open editor.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly commandRunner: GitCommandRunner,
    private readonly reconciler: FileChangeReconciler,
    private readonly logger?: Logger,
  ) {}

  /**
   * Restores `input.paths` in the project's working tree — to HEAD, or, with `input.fromCommit`, to
   * their content at that commit — and lands the result into the project.
   *
   * @param input - The acting user, the project, the paths to restore, and the optional commit to
   *   restore them from.
   * @returns The restored paths on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link RepositoryNotConnectedError} when the project has no connected repository, the
   *   {@link GitCommandFailedError} the underlying git command fails with, or a
   *   {@link GitOperationInProgressError} when another git action is already in flight for this
   *   project.
   */
  async execute(input: DiscardChangesInput): Promise<Result<DiscardChangesResult, DomainError>> {
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

    const repository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (repository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const guarded = await this.gitOperationRepo.withGuard(input.projectId, () =>
      this.discardWhileGuarded(input),
    );
    // `withGuard` wraps the inner Result in its own Result (its failure is
    // `GitOperationInProgressError`, a peer of the inner step's own refusals) — unwrap so callers
    // see one flat Result regardless of which layer refused.
    return guarded.success ? guarded.value : guarded;
  }

  /**
   * Restores the given paths and lands the resulting change-set — the part of the flow held under
   * the project's single-flight guard.
   */
  private async discardWhileGuarded(
    input: DiscardChangesInput,
  ): Promise<Result<DiscardChangesResult, DomainError>> {
    const changeSet = await this.commandRunner.discardChanges(input.projectId, {
      paths: input.paths,
      fromCommit: input.fromCommit,
    });
    if (!changeSet.success) return changeSet;

    const landed = await this.reconciler.apply(input.projectId, changeSet.value);
    if (!landed.success) return landed;

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_CHANGES_DISCARDED,
        resourceType: 'Project',
        resourceId: input.projectId.value,
        metadata: { count: landed.value.changedPaths.length },
        context: input.context,
      },
      this.logger,
    );

    return { success: true, value: { restoredPaths: landed.value.changedPaths } };
  }
}
