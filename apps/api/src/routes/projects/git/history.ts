import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError, type GitWorkerHistoryData } from '@asciidocollab/infrastructure';
import type { CommitDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireProjectMembership } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/** Maps the sync-RPC's history payload straight to the wire commits list (the same shape as `CommitDto`). */
export function toHistoryCommits(data: GitWorkerHistoryData): CommitDto[] {
  return data.commits.map((commit) => ({
    hash: commit.hash,
    message: commit.message,
    ...(commit.authorUserId !== undefined ? { authorUserId: commit.authorUserId } : {}),
    authoredAt: commit.authoredAt,
  }));
}

/**
 * Registers `GET /projects/:projectId/git/history` — a project member's read of a project's (or,
 * with `?path=`, a single file's) commit history, each commit's git author already resolved to a
 * platform user where possible.
 *
 * Any project member (viewer tier and up) may read history; the route gates membership itself
 * BEFORE calling the worker, since the underlying worker call performs no authorization of its own.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitHistoryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string }; Querystring: { path?: string; limit?: string } }>(
    '/projects/:projectId/git/history',
    {
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            limit: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const membershipCheck = await requireProjectMembership(request, actorId, projectId);
      if (!membershipCheck.success) {
        return sendGitErrorResponse(reply, membershipCheck.error.name);
      }

      const { path, limit: rawLimit } = request.query;
      let limit: number | undefined;
      if (rawLimit !== undefined) {
        limit = Number(rawLimit);
        if (!Number.isFinite(limit) || limit < 0) {
          return reply
            .status(400)
            .send({ error: { code: 'invalid_limit', message: 'limit must be a non-negative number' } });
        }
      }

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.getHistory({
          projectId: projectId.value,
          actorId: actorId.value,
          ...(path !== undefined ? { path } : {}),
          ...(limit !== undefined ? { limit } : {}),
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

      return reply.status(200).send({ commits: toHistoryCommits(result.data) });
    },
  );
}
