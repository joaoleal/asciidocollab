import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError, type GitWorkerPreviewPushData } from '@asciidocollab/infrastructure';
import type { PushPreviewDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/** Maps the sync-RPC's push-preview payload to the wire `PushPreviewDto`. */
export function toPushPreviewDto(data: GitWorkerPreviewPushData): PushPreviewDto {
  return {
    outgoingCommits: data.outgoingCommits.map((commit) => ({
      hash: commit.hash,
      message: commit.message,
      ...(commit.authorUserId !== undefined ? { authorUserId: commit.authorUserId } : {}),
      authoredAt: commit.authoredAt,
    })),
    changedPaths: [...data.changedPaths],
  };
}

/**
 * Registers `GET /projects/:projectId/git/preview/push` — an editor's dry-run preview of what
 * pushing the project's current branch would send out, without applying anything: the outgoing
 * commits and the paths they touch.
 *
 * Requires EDITOR tier or above, for consistency with the pull preview and with the real
 * `POST .../git/push`. Unlike the pull preview, this carries NO rate-limit config block: it is
 * purely local — no network, no credential — as cheap as a status/history read.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitPreviewPushRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string }; Querystring: { branch?: string } }>(
    '/projects/:projectId/git/preview/push',
    {
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          properties: { branch: { type: 'string' } },
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

      const { branch } = request.query;

      let result;
      try {
        result = await request.server.stores.gitWorkerClient.previewPush({
          projectId: projectId.value,
          actorId: actorId.value,
          ...(branch !== undefined ? { branch } : {}),
        });
      } catch (error) {
        if (error instanceof GitWorkerTransportError) {
          return sendGitWorkerUnavailableResponse(reply);
        }
        throw error;
      }

      if (!result.ok) {
        return sendGitErrorResponse(reply, result.error);
      }

      return reply.status(200).send(toPushPreviewDto(result.data));
    },
  );
}
