import type { Project } from '../../entities/project';
import type { ProjectRepository } from '../../ports/project/project.repository';
import type { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import type { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import type { Logger } from '../../ports/observability/logger';
import type { UserId } from '../../value-objects/ids/user-id';
import type { ProjectId } from '../../value-objects/ids/project-id';
import type { RequestContext } from '../../types/request-context';
import type { Result } from '../../types/result';
import type { DomainError } from '../../errors/domain-error';
import { ProjectNotFoundError } from '../../errors/project/project-not-found';
import { ValidationError } from '../../errors/common/validation-error';
import { AUDIT_PROJECT_GIT_IGNORE_PATTERNS_UPDATED } from '../../audit-actions';
import { recordAuditSuccess } from '../audit-recording';
import { requireGitIgnorePatternsOwner, GIT_IGNORE_PATTERNS_RESOURCE_TYPE } from './git-ignore-patterns-authorization';

/**
 * Validates authorization and persists a project's maintainer-editable git-ignore patterns (merged
 * into the managed `.gitignore` by the worker, alongside the always-ignored internal entries).
 * Only the project owner may change them; the change is audited.
 */
export class SaveProjectGitIgnorePatternsUseCase {
  /**
   * @param projectRepo - Loads and persists the project.
   * @param projectMemberRepo - Resolves the caller's membership for the owner-only check.
   * @param auditLogRepo - Records the denial and success audit entries.
   * @param logger - Optional observability sink for a swallowed audit failure.
   */
  constructor(
    private readonly projectRepo: ProjectRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * @param actorId - The user changing the patterns.
   * @param projectId - The project whose patterns to write.
   * @param patterns - Newline-separated pattern lines, or null to clear.
   * @param context - Optional request origin captured into the audit records.
   * @returns The updated project, or a typed domain error.
   */
  async execute(
    actorId: UserId,
    projectId: ProjectId,
    patterns: string | null,
    context?: RequestContext,
  ): Promise<Result<Project, DomainError>> {
    const project = await this.projectRepo.findById(projectId);
    if (!project) {
      return { success: false, error: new ProjectNotFoundError(projectId.value) };
    }

    const denied = await requireGitIgnorePatternsOwner(
      this.projectMemberRepo,
      this.auditLogRepo,
      { actorId, projectId, context },
      this.logger,
    );
    if (denied) {
      return { success: false, error: denied };
    }

    try {
      project.setGitIgnorePatterns(patterns);
    } catch (error) {
      if (error instanceof ValidationError) {
        return { success: false, error };
      }
      throw error;
    }

    await this.projectRepo.save(project);

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId,
        projectId,
        action: AUDIT_PROJECT_GIT_IGNORE_PATTERNS_UPDATED,
        resourceType: GIT_IGNORE_PATTERNS_RESOURCE_TYPE,
        resourceId: projectId.value,
        context,
      },
      this.logger,
    );

    return { success: true, value: project };
  }
}
