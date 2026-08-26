import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/**
 * Registers `POST /projects/:projectId/git/pull/complete` — completes the project's currently
 * conflicted operation: a re-run merge with a resolving commit for a conflicted `PULL`, or a
 * resolved-changes landing with no commit for a conflicted `BRANCH_SWITCH` (the use case dispatches
 * on the awaiting operation's kind; this is the single route for both).
 *
 * SYNCHRONOUS, like stage/unstage/commit: this route calls the git-worker's `completePull` RPC
 * directly rather than enqueuing. The `202` in the contract is honoured shape-wise — the work is
 * already done by the time this responds, so a client polling `GET .../operations/:opId` afterward
 * observes an already-terminal operation.
 *
 * Requires EDITOR tier or above; the gate runs BEFORE the worker call. A `409 unresolved_conflicts`
 * (some conflict still lacks a recorded resolution) is the domain's own refusal, mapped through the
 * shared error table like every other git route.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitPullCompleteRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: Record<string, never> }>(
    '/api/projects/:projectId/git/pull/complete',
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

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.completePull({
          projectId: projectId.value,
          actorId: actorId.value,
        });
      } catch (error) {
        if (error instanceof GitWorkerTransportError) {
          return sendGitWorkerUnavailableResponse(reply);
        }
        throw error;
      }

      if (!result.ok) {
        return sendGitErrorResponse(reply, result.error, result.path);
      }

      return reply.status(202).send({ operationId: result.data.operationId });
    },
  );
}
