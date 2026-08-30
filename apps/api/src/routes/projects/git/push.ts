import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import { sendGitErrorResponse } from '../../../lib/git-error-response';
import { enqueueGitOperation } from '../../../lib/git-enqueue';

/**
 * Registers `POST /projects/:projectId/git/push` — starts pushing the project's committed history to
 * its remote. ASYNCHRONOUS, unlike stage/unstage/commit: this route never calls the synchronous
 * git-worker RPC client. It only enqueues a `PUSH` `GitOperation` (branch `null` — the worker's push
 * handler reads the branch from the project's `GitRepository` row itself) and answers `202`; the
 * worker claims and runs it, and the outcome (including a non-fast-forward or credential failure) is
 * observable only later, via the existing `GET /projects/:projectId/git/operations/:opId` route.
 *
 * This deliberately does not pre-check repository connectivity — mirroring `POST /api/git/import`'s
 * fire-and-poll model — so a missing/misconfigured repository surfaces as the enqueued operation's
 * failure `errorCode`, not a synchronous response from this route.
 *
 * Requires EDITOR tier or above; the gate runs BEFORE the enqueue. This is the only synchronous
 * authorization outcome this route produces — the worker's own editor self-gate, and any 401 (bad
 * credential)/non-fast-forward remote refusal, both surface later through the operation's state.
 *
 * The enqueue itself can still refuse synchronously: a project may only have one active operation
 * at a time, so pushing while another operation is already queued or running answers
 * `409 git_operation_in_progress` — the same code, from the same shared error table, that the
 * synchronous git routes answer for that refusal.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitPushRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: Record<string, never> }>(
    '/api/projects/:projectId/git/push',
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

      const enqueued = await enqueueGitOperation(request, {
        projectId,
        kind: 'PUSH',
        triggeredByUserId: actorId,
        branch: null,
      });
      if (!enqueued.success) {
        return sendGitErrorResponse(reply, enqueued.error.name);
      }

      return reply.status(202).send({
        operationId: enqueued.value.id.value,
        projectId: projectId.value,
      });
    },
  );
}
