import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/** Body accepted by `POST /projects/:projectId/git/unstage`. */
interface GitUnstageBody {
  /** Workspace-relative paths to unstage. */
  paths: readonly string[];
}

/**
 * Registers `POST /projects/:projectId/git/unstage` — unstages the given files. Synchronous,
 * EDITOR-gated, and single-flight-guarded worker-side exactly like {@link
 * import('./stage').gitStageRoutes} — see that route's doc for the shared rationale.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitUnstageRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: GitUnstageBody }>(
    '/projects/:projectId/git/unstage',
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
        result = await request.server.stores.gitWorkerClient.unstageChanges({
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
