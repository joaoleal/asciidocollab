import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/** Body accepted by `POST /projects/:projectId/git/stage`. */
interface GitStageBody {
  /** Workspace-relative paths to stage for the next commit. */
  paths: readonly string[];
}

/**
 * Registers `POST /projects/:projectId/git/stage` — stages the given files for the next commit.
 * Synchronous: the actual staging runs in the git-worker via {@link
 * import('@asciidocollab/infrastructure').GitWorkerClient.stageChanges}, which also owns the
 * project's single-flight guard (an in-progress operation comes back as a `GitOperationInProgressError`
 * domain refusal, mapped to `409` by the shared error helper — this route never guards it itself).
 *
 * Requires EDITOR tier or above; the gate runs BEFORE the worker call, as defense-in-depth alongside
 * the worker's own editor self-gate.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitStageRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: GitStageBody }>(
    '/projects/:projectId/git/stage',
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
          required: ['paths'],
          properties: {
            paths: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          },
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
        result = await request.server.stores.gitWorkerClient.stageChanges({
          projectId: projectId.value,
          actorId: actorId.value,
          paths: request.body.paths,
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

      return reply.status(200).send({ staged: result.data.staged });
    },
  );
}
