import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import type { BehindAheadDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireProjectMembership } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/**
 * Registers `GET /projects/:projectId/git/behind-ahead` — a project member's read of how far the
 * connected repository's current branch stands from its already-fetched remote-tracking ref: a
 * cheap, local, no-credential comparison, not a network fetch — its counts are only as fresh as the
 * last time the remote-tracking ref was updated.
 *
 * Any project member (viewer tier and up) may read this; the route gates membership itself BEFORE
 * calling the worker, since the underlying worker call performs no authorization of its own.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitBehindAheadRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/git/behind-ahead',
    {
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
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

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.getBehindAhead({
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

      const dto: BehindAheadDto = { behind: result.data.behind, ahead: result.data.ahead };
      return reply.status(200).send(dto);
    },
  );
}
