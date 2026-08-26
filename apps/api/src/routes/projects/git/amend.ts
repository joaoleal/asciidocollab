import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import type { CommitDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/** Body accepted by `POST /projects/:projectId/git/amend`. */
interface GitAmendBody {
  /** The replacement commit message. When absent, the amended commit keeps its existing message. */
  message?: string;
}

/**
 * Registers `POST /projects/:projectId/git/amend` — amends the project's most-recent commit,
 * folding any currently staged changes into it and, when a message is supplied, replacing it.
 * Synchronous, via the git-worker's `amendCommit` RPC, which owns the project's single-flight
 * guard the same way commit does.
 *
 * As with commit, `commit.authorUserId` is stamped from the authenticated actor rather than
 * resolved from the worker's reply — the amended commit is re-authored as the acting user (the
 * underlying use case records them as the commit's author), and the shared `CommitDto`/worker wire
 * result carry no display-name field.
 *
 * Amending a commit already pushed to the remote would rewrite shared history: the worker reports
 * this as a `CommitAlreadyPushedError` refusal, which this route maps to `409 commit_already_pushed`
 * via the shared error table.
 *
 * Requires EDITOR tier or above; the gate runs BEFORE the worker call, as defense-in-depth alongside
 * the worker's own editor self-gate.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitAmendRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: GitAmendBody }>(
    '/projects/:projectId/git/amend',
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

      const message = request.body?.message;

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.amendCommit({
          projectId: projectId.value,
          actorId: actorId.value,
          ...(message !== undefined ? { message } : {}),
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
