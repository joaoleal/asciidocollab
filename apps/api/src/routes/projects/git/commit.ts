import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import type { CommitDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/** Body accepted by `POST /projects/:projectId/git/commit`. */
interface GitCommitBody {
  /** The commit message. Deliberately unvalidated by schema (see route doc) — an empty/whitespace
   * message is left to reach the worker, which reports `EmptyCommitMessageError` (422). */
  message: string;
}

/**
 * Registers `POST /projects/:projectId/git/commit` — commits the currently staged changes.
 * Synchronous, via the git-worker's `commitChanges` RPC, which owns the project's single-flight
 * guard the same way stage/unstage do.
 *
 * The response's `commit.authorUserId` is stamped from the authenticated actor, not resolved from
 * the worker's reply: the shared `CommitDto`/worker `GitWorkerCommitData` carry no display-name
 * field, and the git commit itself already records the author's display name and email worker-side.
 * A client-facing display-name projection belongs to a later commit-history read, not this route.
 *
 * The body schema deliberately has NO `minLength` on `message`: a schema rejection would preempt the
 * worker's own `EmptyCommitMessageError` -> `422` refusal with a `400`, which would violate the
 * contract this route commits to.
 *
 * Requires EDITOR tier or above; the gate runs BEFORE the worker call, as defense-in-depth alongside
 * the worker's own editor self-gate.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitCommitRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: GitCommitBody }>(
    '/projects/:projectId/git/commit',
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
          required: ['message'],
          properties: {
            message: { type: 'string' },
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
        result = await request.server.stores.gitWorkerClient.commitChanges({
          projectId: projectId.value,
          actorId: actorId.value,
          message: request.body.message,
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

      const commit: CommitDto = {
        hash: result.data.commit.hash,
        message: result.data.commit.message,
        authorUserId: actorId.value,
        authoredAt: result.data.commit.authoredAt,
      };
      return reply.status(200).send({ commit });
    },
  );
}
