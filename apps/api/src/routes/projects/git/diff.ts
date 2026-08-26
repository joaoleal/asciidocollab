import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError, type GitWorkerDiffData } from '@asciidocollab/infrastructure';
import type { DiffDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireProjectMembership } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/** Maps the sync-RPC's diff payload straight to the wire `DiffDto` (same shape). */
export function toDiffDto(data: GitWorkerDiffData): DiffDto {
  return { unified: data.unified };
}

/**
 * Registers `GET /projects/:projectId/git/diff` — a project member's read of a unified diff: either
 * between two commits (`?from=&to=`), or, with neither, of the uncommitted working changes against
 * HEAD, optionally scoped to a single file (`?path=`).
 *
 * Any project member (viewer tier and up) may read a diff; the route gates membership itself
 * BEFORE calling the worker, since the underlying worker call performs no authorization of its own.
 * The route passes `path`/`from`/`to` straight through — the domain use case itself decides whether
 * an open file's live editor content should override its stale on-disk copy.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitDiffRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string }; Querystring: { path?: string; from?: string; to?: string } }>(
    '/projects/:projectId/git/diff',
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
            from: { type: 'string' },
            to: { type: 'string' },
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

      const { path, from, to } = request.query;

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.getDiff({
          projectId: projectId.value,
          actorId: actorId.value,
          ...(path !== undefined ? { path } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
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

      return reply.status(200).send(toDiffDto(result.data));
    },
  );
}
