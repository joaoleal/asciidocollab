import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { RequestContext } from '../../types/request-context';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { recordAuthorizationDenial } from '../audit-recording';

/** The resource type recorded on git-ignore-patterns authorization audit entries. */
export const GIT_IGNORE_PATTERNS_RESOURCE_TYPE = 'Project';

/** Details needed to check a caller's git-ignore-patterns authorization and audit a denial. */
export interface GitIgnorePatternsAuthzContext {
  /** The acting user. */
  readonly actorId: UserId;
  /** The project the action targets (tenant scope). */
  readonly projectId: ProjectId;
  /** Request origin, captured into audit metadata. */
  readonly context?: RequestContext;
}

/**
 * Ensures the caller is the project owner — the only role permitted to read or change a project's
 * maintainer-editable git-ignore patterns. On denial, records an audited `authz.denied` event and
 * returns the error; otherwise null.
 *
 * @returns A {@link PermissionDeniedError} when the caller is not the owner, or null when allowed.
 */
export async function requireGitIgnorePatternsOwner(
  projectMemberRepo: ProjectMemberRepository,
  auditLogRepo: AuditLogRepository,
  authz: GitIgnorePatternsAuthzContext,
  logger?: Logger,
): Promise<PermissionDeniedError | null> {
  const membership = await projectMemberRepo.findByCompositeKey(authz.projectId, authz.actorId);
  if (membership?.role.value === 'owner') {
    return null;
  }
  await recordAuthorizationDenial(
    auditLogRepo,
    {
      actorId: authz.actorId,
      projectId: authz.projectId,
      resourceType: GIT_IGNORE_PATTERNS_RESOURCE_TYPE,
      resourceId: authz.projectId.value,
      reason: membership ? 'insufficient_role' : 'not_a_project_member',
      context: authz.context,
    },
    logger,
  );
  return new PermissionDeniedError(
    'Permission denied',
    GIT_IGNORE_PATTERNS_RESOURCE_TYPE,
    authz.projectId.value,
    'not_owner',
  );
}
