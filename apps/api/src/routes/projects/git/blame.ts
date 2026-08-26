import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError, type GitWorkerBlameData } from '@asciidocollab/infrastructure';
import type { BlameDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireProjectMembership } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/** Maps the sync-RPC's blame payload straight to the wire `BlameDto` (same shape). */
export function toBlameDto(data: GitWorkerBlameData): BlameDto {
  return {
    lines: data.lines.map((line) => ({
      lineNumber: line.lineNumber,
      hash: line.hash,
      ...(line.authorUserId !== undefined ? { authorUserId: line.authorUserId } : {}),
      authoredAt: line.authoredAt,
      content: line.content,
    })),
  };
}

/**
 * Registers `GET /projects/:projectId/git/blame` — a project member's read of a single file's
 * per-line authorship (`?path=`, required), optionally as of a given commit (`?ref=`), each line's
 * git author already resolved to a platform user where possible.
 *
 * Any project member (viewer tier and up) may read blame; the route gates membership itself BEFORE
 * calling the worker, since the underlying worker call performs no authorization of its own.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitBlameRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string }; Querystring: { path?: string; ref?: string } }>(
    '/projects/:projectId/git/blame',
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
            ref: { type: 'string' },
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

      const { path, ref } = request.query;
      if (!path) {
        return reply.status(400).send({ error: { code: 'missing_path', message: 'A file path is required' } });
      }

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.getBlame({
          projectId: projectId.value,
          actorId: actorId.value,
          path,
          ...(ref !== undefined ? { ref } : {}),
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

      return reply.status(200).send(toBlameDto(result.data));
    },
  );
}
