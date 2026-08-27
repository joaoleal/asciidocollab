import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  CONTENT_CHANGING_GIT_OPERATION_KINDS,
  requireGitRole,
  type GitOperationRepository,
  type ProjectId,
  type UserId,
  type InsufficientRoleError,
  type Result,
} from '@asciidocollab/domain';
import { requestContextFrom } from './request-context';
import { requestLogger } from './request-logger';

/**
 * The write-lock check shared by file-tree mutation routes and the collab edit-session gate: while
 * a content-changing git operation (import/pull/checkout — see `CONTENT_CHANGING_GIT_OPERATION_KINDS`)
 * is active for a project, neither may proceed. Read-only operations, and every other operation kind,
 * never trip this.
 *
 * @param gitOperationRepo - The repository to query for the project's active operation.
 * @param projectId - The project to check.
 * @returns True when a content-changing operation is currently active for the project.
 */
export async function isGitWriteLocked(
  gitOperationRepo: GitOperationRepository,
  projectId: ProjectId,
): Promise<boolean> {
  const active = await gitOperationRepo.findActiveOperation(projectId);
  return active !== null && CONTENT_CHANGING_GIT_OPERATION_KINDS.includes(active.kind);
}

/**
 * Rejects a caller who is not a project member at all — the pre-check every file-tree mutation
 * route runs BEFORE {@link isGitWriteLocked}. Ordering matters for information disclosure: without
 * it, a non-member hitting a mutation route on someone else's project during an active
 * content-changing operation would see the write-lock's `409`, leaking that the project exists and
 * has git activity, instead of the `403` a non-member gets on every other path.
 *
 * This does not duplicate the finer-grained editor/owner check the mutating use case still performs
 * on its own: `'viewer'` is the lowest role tier, so any real member (including a VIEWER, who the
 * use case will still deny) passes this gate unchanged and falls through to that check.
 *
 * @param request - The current Fastify request (source of the membership and audit-log repos).
 * @param actorId - The authenticated caller.
 * @param projectId - The project the mutation targets.
 * @returns `{ success: true }` for any project member, otherwise `{ success: false, error: InsufficientRoleError }`.
 */
export async function requireProjectMembership(
  request: FastifyRequest,
  actorId: UserId,
  projectId: ProjectId,
): Promise<Result<void, InsufficientRoleError>> {
  return requireGitRole(
    request.server.repos.projectMember,
    request.server.repos.auditLog,
    { actorId, projectId, requiredRole: 'viewer', context: requestContextFrom(request) },
    requestLogger(request),
  );
}

/**
 * The EDITOR-tier gate every git mutation route (stage/unstage/commit/push) calls FIRST, before the
 * worker RPC or the async enqueue. Mirrors {@link requireProjectMembership} exactly but with
 * `requiredRole: 'editor'`.
 *
 * This is defense-in-depth, not the only check: the worker's own use case (for stage/unstage/commit)
 * or the domain push use case self-gates editor again once it runs. Both checks are intentional —
 * this one rejects a non-editor before any worker call/enqueue is even made; do not remove either
 * side. It also does not replace the worker's single-flight guard: an in-progress operation is a
 * `GitOperationInProgressError` domain refusal the worker/enqueue path returns on its own, not
 * something this route-level gate is responsible for.
 *
 * @param request - The current Fastify request (source of the membership and audit-log repos).
 * @param actorId - The authenticated caller.
 * @param projectId - The project the mutation targets.
 * @returns `{ success: true }` for an editor (or owner), otherwise `{ success: false, error: InsufficientRoleError }`.
 */
export async function requireEditorRole(
  request: FastifyRequest,
  actorId: UserId,
  projectId: ProjectId,
): Promise<Result<void, InsufficientRoleError>> {
  return requireGitRole(
    request.server.repos.projectMember,
    request.server.repos.auditLog,
    { actorId, projectId, requiredRole: 'editor', context: requestContextFrom(request) },
    requestLogger(request),
  );
}

/**
 * The OWNER-tier gate every repository-lifecycle route (initialize/disconnect/credential rotation)
 * calls FIRST, before any pre-check, worker RPC, or async enqueue. Mirrors {@link requireEditorRole}
 * exactly but with `requiredRole: 'owner'` — the tier data-model.md's git authorization matrix
 * requires for connect/import/initialize/disconnect/credential rotation.
 *
 * This is defense-in-depth, not the only check: the underlying use case (disconnect) or the
 * worker's own handler (initialize) self-gates owner again once it runs. Both checks are
 * intentional — this one rejects a non-owner before any worker call/enqueue is even made.
 *
 * @param request - The current Fastify request (source of the membership and audit-log repos).
 * @param actorId - The authenticated caller.
 * @param projectId - The project the lifecycle action targets.
 * @returns `{ success: true }` for an owner, otherwise `{ success: false, error: InsufficientRoleError }`.
 */
export async function requireOwnerRole(
  request: FastifyRequest,
  actorId: UserId,
  projectId: ProjectId,
): Promise<Result<void, InsufficientRoleError>> {
  return requireGitRole(
    request.server.repos.projectMember,
    request.server.repos.auditLog,
    { actorId, projectId, requiredRole: 'owner', context: requestContextFrom(request) },
    requestLogger(request),
  );
}

/**
 * Sends the standard `409` response for a mutation (or new edit session) refused because a
 * content-changing git operation is currently running for the project.
 */
export function sendGitOperationInProgressError(reply: FastifyReply) {
  return reply.status(409).send({
    error: {
      code: 'git_operation_in_progress',
      message: 'A git operation is already in progress for this project',
    },
  });
}
