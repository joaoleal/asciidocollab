import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId } from '@asciidocollab/domain';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireEditorRole } from '../../../lib/git-write-lock';
import {
  sendGitErrorResponse,
  sendGitWorkerUnavailableResponse,
  type GitErrorResponseBody,
} from '../../../lib/git-error-response';

/** Body accepted by `POST /projects/:projectId/git/checkout`. */
interface GitCheckoutBody {
  /** The branch to switch to. */
  name: string;
  /** Acknowledges that files open in live editing sessions may be affected by the switch. */
  confirmAffectsOpenFiles?: boolean;
  /**
   * Acknowledges that any uncommitted local changes should ride across the switch (stashed and
   * re-applied), rather than blocking the switch. Route-level only: never persisted onto the
   * enqueued `GitOperation` — the worker's switch handler already always preserves local edits.
   */
  stashLocal?: boolean;
}

/**
 * Registers `POST /projects/:projectId/git/checkout` — starts switching the project's checked-out
 * branch. ASYNCHRONOUS, like pull/push: this route never calls the git-worker's checkout RPC (there
 * isn't one — checkout only runs through the worker's queue). It only enqueues a `BRANCH_SWITCH`
 * `GitOperation` and answers `202`; the worker claims and runs it, and the outcome — a clean
 * switch, entering `AWAITING_CONFLICT`, or a failure — is observable only later, via the existing
 * `GET /projects/:projectId/git/operations/:opId` route.
 *
 * Requires EDITOR tier or above; that gate runs BEFORE any enqueue. Two further synchronous
 * refusals are possible, checked in this order:
 *
 * 1. **Uncommitted changes.** Unlike pull/push, a branch switch touches the working tree directly,
 *    so this route reads the live status via `gitWorkerClient.getStatus` first. If it reports any
 *    pending change and the caller has not passed `stashLocal: true`, this route answers `409`
 *    instead of enqueuing, so the caller can warn and retry with the acknowledgement. `stashLocal`
 *    itself is never written onto the operation — see {@link GitCheckoutBody}.
 * 2. **Open files.** As with pull: if editors currently have documents open anywhere in the
 *    project and the caller has not passed `confirmAffectsOpenFiles: true`, this route answers
 *    `409` instead of enqueuing.
 *
 * Any other refusal (a missing repository, a genuine merge conflict, a command failure) surfaces
 * later through the operation's state, not synchronously from this route.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitCheckoutRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: GitCheckoutBody }>(
    '/api/projects/:projectId/git/checkout',
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
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1 },
            confirmAffectsOpenFiles: { type: 'boolean' },
            stashLocal: { type: 'boolean' },
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

      const stashLocal = request.body.stashLocal === true;
      if (!stashLocal) {
        let statusResult;
        try {
          statusResult = await request.server.stores.gitWorkerClient.getStatus({
            projectId: projectId.value,
            actorId: actorId.value,
          });
        } catch (error) {
          if (error instanceof GitWorkerTransportError) {
            return sendGitWorkerUnavailableResponse(reply);
          }
          throw error;
        }

        if (!statusResult.ok) {
          return sendGitErrorResponse(reply, statusResult.error, statusResult.path);
        }

        if (statusResult.data.changes.length > 0) {
          return reply.status(409).send({
            error: {
              code: 'uncommitted_changes',
              message:
                'There are uncommitted local changes; retry with stashLocal to carry them across the switch.',
            },
          } satisfies GitErrorResponseBody);
        }
      }

      const confirmed = request.body.confirmAffectsOpenFiles === true;
      if (!confirmed) {
        const activeDocumentIds = await request.server.repos.collaborationSession.findActiveDocumentIds(
          projectId,
        );
        if (activeDocumentIds.length > 0) {
          return reply.status(409).send({
            error: {
              code: 'open_files_need_confirm',
              message:
                'Files are open in live editing sessions; switching branches may change them. Retry with confirmation.',
            },
          } satisfies GitErrorResponseBody);
        }
      }

      const operation = await request.server.repos.gitOperation.enqueue({
        projectId,
        kind: 'BRANCH_SWITCH',
        triggeredByUserId: actorId,
        branch: request.body.name,
      });

      return reply.status(202).send({
        operationId: operation.id.value,
        projectId: projectId.value,
      });
    },
  );
}
