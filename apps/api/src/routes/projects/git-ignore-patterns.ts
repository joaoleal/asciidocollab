import type { FastifyInstance } from 'fastify';
import {
  GetProjectGitIgnorePatternsUseCase,
  SaveProjectGitIgnorePatternsUseCase,
  UserId,
  ProjectId,
  PermissionDeniedError,
  ProjectNotFoundError,
  ValidationError,
} from '@asciidocollab/domain';
import { getAuthenticatedUserId } from '../../plugins/require-auth';
import { requestContextFrom } from '../../lib/request-context';

/**
 * Registers the project git-ignore-patterns endpoints — the project owner's maintainer-editable
 * lines merged by the git-worker into the managed `.gitignore`, alongside the always-ignored
 * internal entries (`.collab/`, temp-write artifacts):
 *  - `GET /api/projects/:projectId/git-ignore-patterns` — owner-only read.
 *  - `PUT /api/projects/:projectId/git-ignore-patterns` — owner-only write.
 *
 * Unlike most project-settings reads, the read here is also owner-gated (not open to every
 * member) — authorization lives entirely in the use cases (no route-level permission check).
 */
export async function gitIgnorePatternsRoutes(app: FastifyInstance): Promise<void> {
  const parametersSchema = {
    type: 'object',
    required: ['projectId'],
    properties: { projectId: { type: 'string' } },
  } as const;

  const rateLimit = {
    max: app.config.project.gitIgnorePatterns.rateLimitMax,
    timeWindow: app.config.project.gitIgnorePatterns.rateLimitWindow,
  };

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/git-ignore-patterns',
    { config: { rateLimit }, schema: { params: parametersSchema } },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const useCase = new GetProjectGitIgnorePatternsUseCase(
        request.server.repos.project,
        request.server.repos.projectMember,
      );
      const result = await useCase.execute(actorId, projectId);

      if (!result.success) {
        return sendGitIgnorePatternsError(reply, result.error);
      }

      return reply.status(200).send({ data: { gitIgnorePatterns: result.value.gitIgnorePatterns } });
    },
  );

  app.put<{ Params: { projectId: string }; Body: { gitIgnorePatterns: string | null } }>(
    '/api/projects/:projectId/git-ignore-patterns',
    {
      config: { rateLimit },
      schema: {
        params: parametersSchema,
        body: {
          type: 'object',
          required: ['gitIgnorePatterns'],
          properties: { gitIgnorePatterns: { type: ['string', 'null'] } },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const useCase = new SaveProjectGitIgnorePatternsUseCase(
        request.server.repos.project,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
      );
      const result = await useCase.execute(
        actorId,
        projectId,
        request.body.gitIgnorePatterns,
        requestContextFrom(request),
      );

      if (!result.success) {
        return sendGitIgnorePatternsError(reply, result.error);
      }

      return reply.status(200).send({ data: { gitIgnorePatterns: result.value.gitIgnorePatterns } });
    },
  );
}

/** Maps a git-ignore-patterns use-case error to the appropriate HTTP response. */
function sendGitIgnorePatternsError(reply: import('fastify').FastifyReply, error: Error) {
  if (error instanceof PermissionDeniedError) {
    return reply.status(403).send({ error: { code: 'FORBIDDEN', message: error.message } });
  }
  if (error instanceof ProjectNotFoundError) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: error.message } });
  }
  if (error instanceof ValidationError) {
    return reply.status(400).send({ error: { code: 'ValidationFailed', message: error.message } });
  }
  return reply
    .status(500)
    .send({ error: { code: 'INTERNAL_ERROR', message: 'Failed to process git-ignore patterns' } });
}
