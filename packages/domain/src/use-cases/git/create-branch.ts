import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitCreatedBranch, GitMutationPort } from '../../ports/git/git-command-runner';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { ValidationError } from '../../errors/common/validation-error';
import { requireGitRole } from './git-role-guard';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_BRANCH_CREATED } from '../../audit-actions';

/** Everything `CreateBranchUseCase.execute` needs to create a new branch. */
export interface CreateBranchInput {
  /** The user asking to create the branch. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project to create the branch in. */
  readonly projectId: ProjectId;
  /** The new branch's name. Rejected if empty or whitespace-only. */
  readonly name: string;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/** What a successful branch creation hands back. */
export interface CreateBranchResult {
  /** The branch that was created. */
  readonly branch: GitCreatedBranch;
}

/**
 * Creates a new branch from the working tree's current branch tip.
 *
 * A cheap, synchronous git action that creates a ref without touching working-tree content — it
 * does not take the project's single-flight guard (unlike a whole-project mutating action such as
 * committing or pushing). It self-gates role: the caller must be at least an EDITOR.
 */
export class CreateBranchUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial.
   * @param gitRepositoryRepo - Confirms the project has a connected repository.
   * @param commandRunner - Creates the branch.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitMutationPort,
    private readonly logger?: Logger,
  ) {}

  /**
   * Creates a branch named `input.name` from the project's currently checked-out branch.
   *
   * @param input - The acting user, the project, and the new branch's name.
   * @returns The created branch on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link RepositoryNotConnectedError} when the project has no connected repository,
   *   {@link ValidationError} when the name is empty or whitespace-only, or the
   *   {@link GitCommandFailedError} the underlying git command fails with.
   */
  async execute(input: CreateBranchInput): Promise<Result<CreateBranchResult, DomainError>> {
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

    const name = input.name.trim();
    if (name === '') {
      return { success: false, error: new ValidationError('Branch name must not be empty') };
    }

    const createResult = await this.commandRunner.createBranch(input.projectId, { name });
    if (!createResult.success) return createResult;

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_BRANCH_CREATED,
        resourceType: 'Project',
        resourceId: input.projectId.value,
        metadata: { name },
        context: input.context,
      },
      this.logger,
    );

    return { success: true, value: { branch: createResult.value } };
  }
}
