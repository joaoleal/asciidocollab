import type { FastifyInstance, FastifyReply } from 'fastify';
import { GitOperationId, ProjectId, UserId } from '@asciidocollab/domain';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireProjectMembership } from '../../../lib/git-write-lock';
import { toGitOperationStatusDto } from '../../../lib/git-operation-dto';

/**
 * Registers `GET /projects/:projectId/git/operations/:opId` — the progress-polling endpoint a
 * client repeatedly reads after a `202` (import/pull/push/…) to learn how that operation is
 * progressing.
 *
 * Authorization here is an OR, not a plain membership check. An in-flight IMPORT targets a brand
 * new, invisible project: the worker only grants the importing user their owner membership once
 * the import succeeds (see `POST /api/git/import`), so the very user who started it is not yet a
 * project member, and a pure membership check would lock them out of polling their own import. A
 * caller may read the status when EITHER holds:
 *  - they are the user who triggered the operation (covers the invisible-import case), or
 *  - they hold at least viewer-tier membership on the project (covers every operation on an
 *    already-visible project — pull, push, checkout, and so on).
 *
 * A caller who is neither is refused the same way an unknown operation id, or one belonging to a
 * different project than the URL names, is: a plain `404`. This is deliberate — an unauthorized
 * caller must never be able to tell "this operation doesn't exist" apart from "it exists, but you
 * may not see it", mirroring the non-leaking shape the write-lock's non-member pre-check already
 * uses for file-tree mutations.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitOperationStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string; opId: string } }>(
    '/api/projects/:projectId/git/operations/:opId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['projectId', 'opId'],
          properties: {
            projectId: { type: 'string' },
            opId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);
      const operationId = GitOperationId.create(request.params.opId);

      const operation = await request.server.repos.gitOperation.findById(operationId);
      if (!operation || operation.projectId.value !== projectId.value) {
        return sendGitOperationNotFoundError(reply);
      }

      // The triggerer is always authorized, even before checking membership — this is the
      // invisible-import case, and short-circuiting here also avoids logging a spurious authz
      // denial for a caller who is in fact entitled to see this operation.
      const isTriggerer = operation.triggeredByUserId.value === actorId.value;
      if (!isTriggerer) {
        const membershipCheck = await requireProjectMembership(request, actorId, projectId);
        if (!membershipCheck.success) {
          return sendGitOperationNotFoundError(reply);
        }
      }

      return reply.status(200).send(toGitOperationStatusDto(operation));
    },
  );
}

/**
 * Sends the standard `404` response for an operation the caller may not see — an unknown id, an
 * id belonging to a different project than the URL names, or a known operation the caller is
 * neither a member of the project nor the triggerer of. Deliberately identical in every one of
 * those cases; see the route's docs above for why.
 */
function sendGitOperationNotFoundError(reply: FastifyReply) {
  return reply.status(404).send({
    error: { code: 'NOT_FOUND', message: 'Git operation not found' },
  });
}
