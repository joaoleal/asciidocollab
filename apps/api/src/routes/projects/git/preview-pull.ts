import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError, type GitWorkerPreviewPullData } from '@asciidocollab/infrastructure';
import type { PullPreviewDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, sendGitWorkerUnavailableResponse } from '../../../lib/git-error-response';

/**
 * Maps the sync-RPC's pull-preview payload, plus the caller-computed `affectsOpenFiles` flag, to
 * the wire `PullPreviewDto`.
 */
export function toPullPreviewDto(data: GitWorkerPreviewPullData, affectsOpenFiles: boolean): PullPreviewDto {
  return {
    incomingCommits: data.incomingCommits.map((commit) => ({
      hash: commit.hash,
      message: commit.message,
      ...(commit.authorUserId !== undefined ? { authorUserId: commit.authorUserId } : {}),
      authoredAt: commit.authoredAt,
    })),
    changedPaths: [...data.changedPaths],
    affectsOpenFiles,
  };
}

/**
 * Registers `GET /projects/:projectId/git/preview/pull` — an editor's dry-run preview of what
 * pulling the project's current branch would bring in, without applying anything: a live fetch (so
 * the preview reflects the remote's current state), then the incoming commits and the paths they
 * touch.
 *
 * Requires EDITOR tier or above, the same tier the real `POST .../git/pull` requires — this
 * authenticates a live fetch with the project's stored credential, unlike the plain read-only
 * history/diff/blame routes every project member may call. It also carries the same rate-limit
 * config block those network/credential ops use, since a preview's fetch is exactly as expensive.
 *
 * `affectsOpenFiles` is computed here the SAME way `POST .../git/pull`'s own `409` gate computes it:
 * whether ANY document anywhere in the project currently has an active live editing session. Unlike
 * that gate, this route never blocks on it — it is informational only, so the caller can warn
 * before deciding whether to actually pull.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitPreviewPullRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string }; Querystring: { branch?: string } }>(
    '/api/projects/:projectId/git/preview/pull',
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
        result = await request.server.stores.gitWorkerClient.previewPull({
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

      const activeDocumentIds = await request.server.repos.collaborationSession.findActiveDocumentIds(projectId);

      return reply.status(200).send(toPullPreviewDto(result.data, activeDocumentIds.length > 0));
    },
  );
}
