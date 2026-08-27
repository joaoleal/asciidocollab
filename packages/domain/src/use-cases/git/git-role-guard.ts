import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { RequestContext } from '../../types/request-context';
import { InsufficientRoleError } from '../../errors/git/insufficient-role';
import { Result } from '../../types/result';
import { recordAuthorizationDenial } from '../audit-recording';

/** The resource type recorded on git authorization audit entries — every git action is project-scoped. */
export const GIT_RESOURCE_TYPE = 'Project';

/** A project role tier, ordered VIEWER < EDITOR < OWNER (data-model.md's git authorization matrix). */
export type GitRoleTier = 'viewer' | 'editor' | 'owner';

/** Ordinal ranking of the three tiers, low to high, so a role can be compared against a minimum. */
const ROLE_RANK: Record<GitRoleTier, number> = { viewer: 0, editor: 1, owner: 2 };

/** Narrows a `Role`'s raw string value to a {@link GitRoleTier}, without an unchecked type assertion. */
function isGitRoleTier(value: string): value is GitRoleTier {
  return value === 'viewer' || value === 'editor' || value === 'owner';
}

/** Details needed to check a caller's role against a git action's minimum and audit a denial. */
export interface GitRoleAuthzContext {
  /** The acting user. */
  readonly actorId: UserId;
  /** The project the git action targets. */
  readonly projectId: ProjectId;
  /**
   * The minimum role the action requires (data-model.md §8): `'viewer'` for read actions (status,
   * history, diff — and, equivalently, "is this caller a project member at all"); `'editor'` for
   * commit/push/pull/branch/switch/stage/resolve/discard; `'owner'` for connect/import/initialize/
   * disconnect/credential rotation.
   */
  readonly requiredRole: GitRoleTier;
  /** Request origin, captured into audit metadata. */
  readonly context?: RequestContext;
}

/**
 * The single shared authorization gate every git use case calls once it knows which action it is
 * performing and that action's minimum role. It resolves the caller's project membership, compares
 * it against `requiredRole` on the VIEWER < EDITOR < OWNER ordering, and on denial records an
 * audited `authz.denied` event before returning {@link InsufficientRoleError}.
 *
 * Reuses the existing `ProjectMemberRepository` — the same membership/role model every other
 * project use case resolves against — so this introduces no new role system. A caller with no
 * membership at all is simply ranked below VIEWER, so passing `requiredRole: 'viewer'` doubles as
 * a plain "is this caller a project member" check (used by route-level pre-checks that need to
 * reject a non-member before a coarser guard, such as a write-lock check, can leak project state).
 *
 * @param projectMemberRepo - Membership lookup for the role check.
 * @param auditLogRepo - Audit sink for a denial record.
 * @param authz - The acting user, project, and the action's minimum role.
 * @param logger - Optional observability sink for a swallowed audit failure.
 * @returns `{ success: true }` when the caller's role meets or exceeds `requiredRole`, otherwise
 *   `{ success: false, error: InsufficientRoleError }`.
 */
export async function requireGitRole(
  projectMemberRepo: ProjectMemberRepository,
  auditLogRepo: AuditLogRepository,
  authz: GitRoleAuthzContext,
  logger?: Logger,
): Promise<Result<void, InsufficientRoleError>> {
  const membership = await projectMemberRepo.findByCompositeKey(authz.projectId, authz.actorId);
  const actualRank =
    membership && isGitRoleTier(membership.role.value) ? ROLE_RANK[membership.role.value] : -1;
  const requiredRank = ROLE_RANK[authz.requiredRole];

  if (actualRank >= requiredRank) {
    return { success: true, value: undefined };
  }

  await recordAuthorizationDenial(
    auditLogRepo,
    {
      actorId: authz.actorId,
      projectId: authz.projectId,
      resourceType: GIT_RESOURCE_TYPE,
      resourceId: authz.projectId.value,
      reason: membership ? 'insufficient_role' : 'not_a_project_member',
      context: authz.context,
    },
    logger,
  );
  return { success: false, error: new InsufficientRoleError(authz.requiredRole) };
}
