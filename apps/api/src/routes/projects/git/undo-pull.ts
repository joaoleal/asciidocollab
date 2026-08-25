import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/**
 * Registers `POST /projects/:projectId/git/undo-pull` — undoes the project's most recent pull,
 * restoring the working tree (and the docs/live editors it reconciles into) to the pre-operation
 * state. Covers both entry states the domain use case handles: a pull still `AWAITING_CONFLICT`
 * (the user abandons resolution), and no active operation but the most recent pull `SUCCEEDED` (a
 * clean pull the user wants reverted).
 *
 * SYNCHRONOUS, like stage/unstage/commit: this route calls the git-worker's `undoPull` RPC directly
 * rather than enqueuing. The response surfaces whatever `{operationId, headCommit}` the RPC
 * returns — this route does not synthesize an id.
 *
 * Requires EDITOR tier or above; the gate runs BEFORE the worker call. A `409 nothing_to_undo` (no
 * awaiting pull and no retained pre-operation snapshot) is the domain's own refusal, mapped through
 * the shared error table like every other git route.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitUndoPullRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: Record<string, never> }>(
    '/projects/:projectId/git/undo-pull',
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
        result = await request.server.stores.gitWorkerClient.undoPull({
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
