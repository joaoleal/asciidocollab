import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { YjsStateId, UserId, ProjectId, AuthorizeCollabConnectionUseCase, AuthorizeProjectPresenceUseCase } from '@asciidocollab/domain';
import {
  COLLAB_AUTH_DOCUMENT_PATH,
  COLLAB_AUTH_PRESENCE_PATH,
  type CollabDocumentAuthResponse,
  type CollabPresenceAuthResponse,
} from '@asciidocollab/shared';
import { logAuthorizationDenial } from '../audit-log-denial';
import { sendGitOperationInProgressError } from '../../lib/git-write-lock';

const uuidProperty = { type: 'string', format: 'uuid' } as const;

/** Returns the authenticated user id, or sends 401 and returns null. */
function requireSessionUserId(request: FastifyRequest, reply: FastifyReply): string | null {
  if (!request.session.userId) {
    reply.status(401).send({ error: 'Unauthorized' });
    return null;
  }
  return request.session.userId;
}

/** Logs an authorization denial (actor, resource, reason — never the cookie) and sends 403. */
function denyForbidden(request: FastifyRequest, reply: FastifyReply, actor: string, resource: string, reason: string): void {
  logAuthorizationDenial(request.log, { actor, resource, reason });
  reply.status(403).send({ error: 'Forbidden' });
}

/**
 * Registers the internal collaboration auth endpoints, split by resource so each has a single
 * responsibility and a typed response. Document rooms authorize by membership, document ownership,
 * and role; presence rooms authorize by project membership only (read-only awareness). Query params
 * are UUID-validated by the JSON schema, so the handlers receive well-formed ids.
 *
 * These run on the internal server (loopback plus optional mTLS), so that trust boundary is the
 * primary protection and the routes are intentionally not rate-limited, consistent with the other
 * internal routes. The collab server's per-user connect-rate limit runs after the auth hook, so it
 * bounds established connections rather than the rate of these auth calls.
 */
export async function collabAuthRoute(app: FastifyInstance): Promise<void> {
  // Document room → { role, userId }
  app.get<{ Querystring: { projectId: string; yjsStateId: string } }>(
    COLLAB_AUTH_DOCUMENT_PATH,
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['projectId', 'yjsStateId'],
          properties: { projectId: uuidProperty, yjsStateId: uuidProperty },
        },
      },
    },
    async (request, reply) => {
      const userId = requireSessionUserId(request, reply);
      if (!userId) return;

      const { projectId, yjsStateId } = request.query;
      const useCase = new AuthorizeCollabConnectionUseCase(
        request.server.repos.projectMember,
        request.server.repos.fileNode,
        request.server.repos.document,
        request.server.repos.gitOperation,
      );
      const result = await useCase.execute(UserId.create(userId), ProjectId.create(projectId), YjsStateId.create(yjsStateId));
      if (!result.success) {
        if (result.error.reason === 'git_operation_in_progress') {
          logAuthorizationDenial(request.log, {
            actor: userId,
            resource: `document:${projectId}/${yjsStateId}`,
            reason: result.error.reason,
          });
          return sendGitOperationInProgressError(reply);
        }
        return denyForbidden(request, reply, userId, `document:${projectId}/${yjsStateId}`, result.error.reason);
      }
      return reply.status(200).send({ role: result.value.role, userId } satisfies CollabDocumentAuthResponse);
    },
  );

  // Presence room → { userId }
  app.get<{ Querystring: { projectId: string } }>(
    COLLAB_AUTH_PRESENCE_PATH,
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: uuidProperty },
        },
      },
    },
    async (request, reply) => {
      const userId = requireSessionUserId(request, reply);
      if (!userId) return;

      const { projectId } = request.query;
      const useCase = new AuthorizeProjectPresenceUseCase(request.server.repos.projectMember);
      const result = await useCase.execute(UserId.create(userId), ProjectId.create(projectId));
      if (!result.success) {
        return denyForbidden(request, reply, userId, `presence:${projectId}`, result.error.reason);
      }
      return reply.status(200).send({ userId } satisfies CollabPresenceAuthResponse);
    },
  );
}
