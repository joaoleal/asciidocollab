import type { FastifyInstance } from 'fastify';
import { ProjectId, UserId, recordAuditSuccess, AUDIT_GIT_CREDENTIAL_ROTATED } from '@asciidocollab/domain';
import { getAuthenticatedUserId } from '../../../plugins/require-auth';
import { requireOwnerRole } from '../../../lib/git-write-lock';
import { requestContextFrom } from '../../../lib/request-context';
import { requestLogger } from '../../../lib/request-logger';
import { sendGitErrorResponse } from '../../../lib/git-error-response';

/** Body accepted by `PUT /projects/:projectId/git/credential`. */
interface GitCredentialBody {
  /** The plaintext access token to authenticate with. Never echoed back or logged. */
  token: string;
}

/**
 * Registers `PUT /projects/:projectId/git/credential` — rotates the access credential stored for
 * a project's already-connected remote. `GitCredentialStore.save` is an upsert that preserves
 * `createdByUserId` on update, so calling it again with a new token IS rotation; there is no
 * separate domain "rotate" method.
 *
 * SYNCHRONOUS and requires an existing `GitRepository` link (there is nothing to rotate a
 * credential for otherwise); performs NO synchronous remote verification (an `ls-remote` check
 * would need a worker hop, out of scope here) — a bad token instead surfaces as the next git
 * operation's failure.
 *
 * OWNER-gated (data-model.md's git authorization matrix); the gate runs BEFORE the connection
 * check.
 *
 * @param app - The Fastify instance the endpoint is registered on.
 */
export async function gitCredentialRoutes(app: FastifyInstance): Promise<void> {
  app.put<{ Params: { projectId: string }; Body: GitCredentialBody }>(
    '/api/projects/:projectId/git/credential',
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
          required: ['token'],
          properties: {
            token: { type: 'string', minLength: 1 },
          },
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

      const existing = await request.server.repos.gitRepository.findByProjectId(projectId);
      if (existing === null) {
        return sendGitErrorResponse(reply, 'RepositoryNotConnectedError');
      }

      const { gitCredentialStore } = request.server.services;
      if (!gitCredentialStore) {
        request.log.error({ projectId: projectId.value }, 'Git credential store is not configured');
        return reply.status(500).send({
          error: { code: 'internal_error', message: 'The credential could not be rotated' },
        });
      }

      const { token } = request.body;
      await gitCredentialStore.save(projectId, {
        token,
        provider: existing.provider,
        createdByUserId: actorId,
      });

      // The store derives the display hint from the token itself; reading it back rather than
      // recomputing it here keeps this route from ever holding a second opinion about what a safe
      // hint looks like.
      const record = await gitCredentialStore.load(projectId);

      // Best-effort, post-commit: the rotation already succeeded above, so a failure recording this
      // can never turn it into an error response. Metadata deliberately carries only the provider —
      // never the token or any part of it.
      await recordAuditSuccess(
        request.server.repos.auditLog,
        {
          actorId,
          projectId,
          action: AUDIT_GIT_CREDENTIAL_ROTATED,
          resourceType: 'Project',
          resourceId: projectId.value,
          metadata: { provider: existing.provider.value },
          context: requestContextFrom(request),
        },
        requestLogger(request),
      );

      return reply.status(200).send({ tokenHint: record?.tokenHint ?? null });
    },
  );
}
