import type { FastifyInstance } from 'fastify';
import { DisconnectRepositoryUseCase, ProjectId, UserId } from '@asciidocollab/domain';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireOwnerRole } from '../../../lib/git-write-lock';
import { requestContextFrom } from '../../../lib/request-context';
import { requestLogger } from '../../../lib/request-logger';
import { sendGitErrorResponse } from '../../../lib/git-error-response';

/**
 * Registers `POST /projects/:projectId/git/disconnect` — unlinks a project from its remote:
 * deletes the stored access credential and the project's `GitRepository` link, leaving its current
 * files untouched (it reverts to a normal, reconnectable non-git project).
 *
 * SYNCHRONOUS, unlike initialize/import: `DisconnectRepositoryUseCase` is pure repo/credential-store
 * deletes, so this route runs it directly in the API process rather than enqueuing a `GitOperation`
 * for the worker.
 *
 * OWNER-gated (data-model.md's git authorization matrix); the route-level gate runs BEFORE the use
 * case, as defense-in-depth alongside the use case's own owner self-gate.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitDisconnectRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: Record<string, never> }>(
    '/projects/:projectId/git/disconnect',
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

      const ownerCheck = await requireOwnerRole(request, actorId, projectId);
      if (!ownerCheck.success) {
        return sendGitErrorResponse(reply, ownerCheck.error.name);
      }

      const { gitCredentialStore } = request.server.services;
      if (!gitCredentialStore) {
        request.log.error({ projectId: projectId.value }, 'Git credential store is not configured');
        return reply.status(500).send({
          error: { code: 'internal_error', message: 'The disconnect could not be completed' },
        });
      }

      const useCase = new DisconnectRepositoryUseCase(
        request.server.repos.projectMember,
        request.server.repos.auditLog,
        request.server.repos.gitRepository,
        gitCredentialStore,
        request.server.repos.gitOperation,
        requestLogger(request),
      );

      const result = await useCase.execute({
        actorId,
        projectId,
        context: requestContextFrom(request),
      });

      if (!result.success) {
        return sendGitErrorResponse(reply, result.error.name);
      }

      return reply.status(200).send({ ok: true });
    },
  );
}
