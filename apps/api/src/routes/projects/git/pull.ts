import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse, type GitErrorResponseBody } from '../../../lib/git-error-response';

/**
 * Registers `POST /projects/:projectId/git/pull` — starts pulling the project's remote history into
 * its committed history. ASYNCHRONOUS, like push: this route never calls the synchronous git-worker
 * RPC client. It only enqueues a `PULL` `GitOperation` (branch `null` — the worker's pull handler
 * reads the branch from the project's `GitRepository` row itself) and answers `202`; the worker
 * claims and runs it, and the outcome — a clean merge, entering `AWAITING_CONFLICT`, or a failure —
 * is observable only later, via the existing `GET /projects/:projectId/git/operations/:opId` route.
 *
 * This deliberately does not pre-check repository connectivity — mirroring push's fire-and-poll
 * model — so a missing/misconfigured repository surfaces as the enqueued operation's failure
 * `errorCode`, not a synchronous response from this route.
 *
 * Requires EDITOR tier or above; that gate runs BEFORE any enqueue. Once past it, a second
 * synchronous refusal is possible: if editors currently have documents open in live editing
 * sessions anywhere in the project and the caller has not passed `confirmAffectsOpenFiles: true`,
 * this route answers `409` instead of enqueuing, so the caller can warn and retry with
 * confirmation. This route only detects that project-wide live sessions exist — it does not
 * resolve which documents they are, since the caller (the web client) already knows which files
 * its own user has open, and enumerating every other collaborator's affected files is a separate,
 * later safety concern.
 *
 * These two gates are the only synchronous refusals this route produces — any other refusal (a
 * missing repository, a merge conflict, a credential failure) surfaces later through the
 * operation's state.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitPullRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: { confirmAffectsOpenFiles?: boolean } }>(
    '/projects/:projectId/git/pull',
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
          properties: { confirmAffectsOpenFiles: { type: 'boolean' } },
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

      const confirmed = request.body?.confirmAffectsOpenFiles === true;
      if (!confirmed) {
        const activeDocumentIds = await request.server.repos.collaborationSession.findActiveDocumentIds(
          projectId,
        );
        if (activeDocumentIds.length > 0) {
          return reply.status(409).send({
            error: {
              code: 'open_files_need_confirm',
              message:
                'Files are open in live editing sessions; pulling may change them. Retry with confirmation.',
            },
          } satisfies GitErrorResponseBody);
        }
      }

      const operation = await request.server.repos.gitOperation.enqueue({
        projectId,
        kind: 'PULL',
        triggeredByUserId: actorId,
        branch: null,
      });

      return reply.status(202).send({
        operationId: operation.id.value,
        projectId: projectId.value,
      });
    },
  );
}
