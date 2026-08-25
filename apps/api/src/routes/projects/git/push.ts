import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse } from '../../../lib/git-error-response';

/**
 * Registers `POST /projects/:projectId/git/push` — starts pushing the project's committed history to
 * its remote. ASYNCHRONOUS, unlike stage/unstage/commit: this route never calls the synchronous
 * git-worker RPC client. It only enqueues a `PUSH` `GitOperation` (branch `null` — the worker's push
 * handler reads the branch from the project's `GitRepository` row itself) and answers `202`; the
 * worker claims and runs it, and the outcome (including a non-fast-forward or credential failure) is
 * observable only later, via the existing `GET /projects/:projectId/git/operations/:opId` route.
 *
 * This deliberately does not pre-check repository connectivity — mirroring `POST /api/git/import`'s
 * fire-and-poll model — so a missing/misconfigured repository surfaces as the enqueued operation's
 * failure `errorCode`, not a synchronous response from this route.
 *
 * Requires EDITOR tier or above; the gate runs BEFORE the enqueue. This is the only synchronous
 * authorization outcome this route produces — the worker's own editor self-gate, and any 401 (bad
 * credential)/non-fast-forward remote refusal, both surface later through the operation's state.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitPushRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: Record<string, never> }>(
    '/projects/:projectId/git/push',
    {
      config: {
        rateLimit: {
          max: app.config.git.rateLimitMax,
          timeWindow: app.config.git.rateLimitWindow,
        },
      },
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
        },
        body: {
          type: 'object',
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const editorCheck = await requireEditorRole(request, actorId, projectId);
      if (!editorCheck.success) {
        return sendGitErrorResponse(reply, editorCheck.error.name);
      }

      const operation = await request.server.repos.gitOperation.enqueue({
        projectId,
        kind: 'PUSH',
        triggeredByUserId: actorId,
        branch: null,
      });

      return reply.status(202).send({
        operationId: operation.id.value,
        projectId: projectId.value,
      });
    },
  );
}
