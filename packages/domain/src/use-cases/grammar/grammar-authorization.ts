import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { RequestContext } from '../../types/request-context';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { recordAuthorizationDenial } from '../audit-recording';

/** The resource type recorded on project-dictionary authorization audit entries. */
export const DICTIONARY_RESOURCE_TYPE = 'ProjectDictionary';

/** Roles allowed to change a project's shared dictionary. */
const EDITOR_ROLES = new Set(['editor', 'owner']);

/** Details needed to check a caller's dictionary-write authorization and audit a denial. */
export interface DictionaryAuthzContext {
  /** The acting user. */
  readonly actorId: UserId;
  /** The project the action targets (tenant scope). */
  readonly projectId: ProjectId;
  /** Request origin, captured into audit metadata. */
  readonly context?: RequestContext;
}

/**
 * Ensures the caller may write the project's dictionary (editor or owner). On denial, records an
 * audited `authz.denied` event and returns the error; otherwise null.
 *
 * @param projectMemberRepo - Membership lookup for the write authorization check.
 * @param auditLogRepo - Audit sink for the denial record.
 * @param authz - The acting user, project, and request context.
 * @param logger - Optional observability sink for a swallowed audit failure.
 * @returns A {@link PermissionDeniedError} when denied, or null when allowed.
 */
export async function requireDictionaryEditor(
  projectMemberRepo: ProjectMemberRepository,
  auditLogRepo: AuditLogRepository,
  authz: DictionaryAuthzContext,
  logger?: Logger,
): Promise<PermissionDeniedError | null> {
  const membership = await projectMemberRepo.findByCompositeKey(authz.projectId, authz.actorId);
  if (membership && EDITOR_ROLES.has(membership.role.value)) {
    return null;
  }
  await recordAuthorizationDenial(
    auditLogRepo,
    {
      actorId: authz.actorId,
      projectId: authz.projectId,
      resourceType: DICTIONARY_RESOURCE_TYPE,
      resourceId: authz.projectId.value,
      reason: membership ? 'insufficient_role' : 'not_a_project_member',
      context: authz.context,
    },
    logger,
  );
  return new PermissionDeniedError(
    'Permission denied',
    DICTIONARY_RESOURCE_TYPE,
    authz.projectId.value,
    'not_editor',
  );
}

/**
 * Ensures the caller is at least a project member (any role) — used by the read path. No audit on
 * denial (reads are cheap and non-mutating).
 *
 * @param projectMemberRepo - Membership lookup.
 * @param projectId - The project being read.
 * @param actorId - The acting user.
 * @returns A {@link PermissionDeniedError} when denied, or null when allowed.
 */
export async function requireDictionaryMember(
  projectMemberRepo: ProjectMemberRepository,
  projectId: ProjectId,
  actorId: UserId,
): Promise<PermissionDeniedError | null> {
  const membership = await projectMemberRepo.findByCompositeKey(projectId, actorId);
  return membership
    ? null
    : new PermissionDeniedError('Permission denied', DICTIONARY_RESOURCE_TYPE, projectId.value, 'not_a_member');
}
