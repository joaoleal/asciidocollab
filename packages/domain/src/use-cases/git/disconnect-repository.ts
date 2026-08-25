import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitRepositoryId } from '../../value-objects/ids/git-repository-id';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { GitCredentialStore } from '../../ports/git/git-credential-store';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { requireGitRole } from './git-role-guard';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_REPOSITORY_DISCONNECTED } from '../../audit-actions';

/** Everything `DisconnectRepositoryUseCase.execute` needs to unlink a project's remote. */
export interface DisconnectRepositoryInput {
  /** The user asking to disconnect the repository. Must be the project's OWNER. */
  readonly actorId: UserId;
  /** The project to disconnect. */
  readonly projectId: ProjectId;
  /** Request origin, captured into audit metadata. */
  readonly context?: RequestContext;
}

/** What a successful disconnection hands back to its caller. */
export interface DisconnectRepositoryResult {
  readonly ok: true;
}

/**
 * Disconnects a project from its external Git remote: deletes the stored access credential and
 * the project's `GitRepository` link. The project's current files are left untouched — it reverts
 * to a normal, non-git project that can be reconnected later.
 *
 * OWNER-gated (data-model.md's git authorization matrix), the same tier {@link
 * ConnectRepositoryUseCase} requires to establish the link in the first place.
 */
export class DisconnectRepositoryUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial and the successful disconnection.
   * @param gitRepositoryRepo - Reads and deletes the project's `GitRepository` link.
   * @param gitCredentialStore - Deletes the project's stored access credential.
   * @param gitOperationRepo - Single-flight guard so a disconnect cannot race another git action.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly gitCredentialStore: GitCredentialStore,
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Disconnects the project from its remote.
   *
   * @param input - The acting user and the project to disconnect.
   * @returns `{ ok: true }` on success; a typed refusal otherwise — {@link InsufficientRoleError}
   *   when the actor is not the project's OWNER, {@link RepositoryNotConnectedError} when the
   *   project has no repository link, or {@link GitOperationInProgressError} when another git
   *   action is already in flight for this project.
   */
  async execute(
    input: DisconnectRepositoryInput,
  ): Promise<Result<DisconnectRepositoryResult, DomainError>> {
    const roleCheck = await requireGitRole(
      this.projectMemberRepo,
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        requiredRole: 'owner',
        context: input.context,
      },
      this.logger,
    );
    if (!roleCheck.success) return roleCheck;

    const existing = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (existing === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const guarded = await this.gitOperationRepo.withGuard(input.projectId, () =>
      this.disconnectWhileGuarded(input, existing.id),
    );
    // `withGuard` wraps the inner Result in its own Result (its failure is
    // `GitOperationInProgressError`, a peer of the inner step's own refusals) — unwrap so callers
    // see one flat Result regardless of which layer refused.
    return guarded.success ? guarded.value : guarded;
  }

  /**
   * Deletes the credential, then the repository link, and audits the disconnect — the part of the
   * flow held under the project's single-flight guard.
   *
   * The credential is deleted first: it is the secret, so it goes promptly regardless of what
   * happens next, and the store's `delete` is idempotent — a retry after a mid-op failure re-finds
   * the (still-present) row and simply no-ops the already-deleted credential before retrying the
   * row delete. An orphaned row with no credential would read as "connected but unusable"; an
   * orphaned, already-deleted credential with a row still present is harmless and exactly what a
   * safe retry expects to find.
   */
  private async disconnectWhileGuarded(
    input: DisconnectRepositoryInput,
    repositoryId: GitRepositoryId,
  ): Promise<Result<DisconnectRepositoryResult, DomainError>> {
    await this.gitCredentialStore.delete(input.projectId);
    await this.gitRepositoryRepo.delete(repositoryId);

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_REPOSITORY_DISCONNECTED,
        resourceType: 'GitRepository',
        resourceId: repositoryId.value,
        context: input.context,
      },
      this.logger,
    );

    return { success: true, value: { ok: true } };
  }
}
