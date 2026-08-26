import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitCommandRunner } from '../../ports/git/git-command-runner';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { ValidationError } from '../../errors/common/validation-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { requireGitRole } from './git-role-guard';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_CHANGES_STAGED, AUDIT_GIT_CHANGES_UNSTAGED } from '../../audit-actions';

/** Which side of the index a `StageChangesUseCase` call moves files toward. */
export type StageChangesAction = 'stage' | 'unstage';

/** Everything `StageChangesUseCase.execute` needs to stage or unstage a set of files. */
export interface StageChangesInput {
  /** The user asking to stage/unstage files. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose working tree to act on. */
  readonly projectId: ProjectId;
  /** Workspace-relative POSIX paths, no leading slash, of the files to stage/unstage. */
  readonly paths: readonly string[];
  /** Which direction to move `paths`: onto the index (`'stage'`) or off it (`'unstage'`). */
  readonly action: StageChangesAction;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/** What a successful stage/unstage hands back. */
export interface StageChangesResult {
  /** Every path currently staged for the next commit, read fresh from the working tree afterward. */
  readonly staged: readonly string[];
}

/**
 * Stages or unstages individual files in a project's working tree, ahead of the next commit.
 *
 * A MUTATING short op (data-model.md's git authorization matrix lists stage under EDITOR): like
 * every other short mutating git action it self-gates role and takes the project's single-flight
 * guard, rather than going through the full operation queue a whole-project action like commit or
 * push uses.
 */
export class StageChangesUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial.
   * @param gitRepositoryRepo - Confirms the project has a connected repository.
   * @param gitOperationRepo - Single-flight guard so this cannot race another git action.
   * @param commandRunner - Runs the actual stage/unstage and re-reads the resulting status.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly commandRunner: GitCommandRunner,
    private readonly logger?: Logger,
  ) {}

  /**
   * Stages or unstages `input.paths`, depending on `input.action`.
   *
   * @param input - The acting user, project, the files to move, and which direction to move them.
   * @returns The paths staged for the next commit after the change, on success; a typed refusal
   *   otherwise — {@link InsufficientRoleError} when the actor is not at least an EDITOR, a
   *   {@link ValidationError} when `paths` is empty, {@link RepositoryNotConnectedError} when the
   *   project has no connected repository, the {@link GitCommandFailedError} the underlying git
   *   command fails with, or a {@link GitOperationInProgressError} when another git action is
   *   already in flight for this project.
   */
  async execute(input: StageChangesInput): Promise<Result<StageChangesResult, DomainError>> {
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

    if (input.paths.length === 0) {
      return {
        success: false,
        error: new ValidationError('no files specified to stage/unstage'),
      };
    }

    const repository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (repository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const guarded = await this.gitOperationRepo.withGuard(input.projectId, () =>
      this.stageWhileGuarded(input),
    );
    // `withGuard` wraps the inner Result in its own Result (its failure is
    // `GitOperationInProgressError`, a peer of the inner step's own refusals) — unwrap so callers
    // see one flat Result regardless of which layer refused.
    return guarded.success ? guarded.value : guarded;
  }

  /**
   * Runs the actual stage/unstage against the working tree and re-reads the resulting status —
   * the part of the flow held under the project's single-flight guard.
   */
  private async stageWhileGuarded(
    input: StageChangesInput,
  ): Promise<Result<StageChangesResult, DomainError>> {
    const commandResult =
      input.action === 'stage'
        ? await this.commandRunner.stage(input.projectId, input.paths)
        : await this.commandRunner.unstage(input.projectId, input.paths);
    if (!commandResult.success) return commandResult;

    const statusResult = await this.commandRunner.getStatus(input.projectId);
    if (!statusResult.success) return statusResult;

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: input.action === 'stage' ? AUDIT_GIT_CHANGES_STAGED : AUDIT_GIT_CHANGES_UNSTAGED,
        resourceType: 'Project',
        resourceId: input.projectId.value,
        metadata: { count: input.paths.length },
        context: input.context,
      },
      this.logger,
    );

    return {
      success: true,
      value: {
        staged: statusResult.value.changes
          .filter((change) => change.state === 'staged')
          .map((change) => change.path),
      },
    };
  }
}
