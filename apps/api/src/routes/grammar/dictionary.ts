import type { FastifyInstance } from 'fastify';
import {
  AddDictionaryTermUseCase,
  RemoveDictionaryTermUseCase,
  ListDictionaryTermsUseCase,
  UserId,
  ProjectId,
  ProjectDictionaryTermId,
  PermissionDeniedError,
  DictionaryTermNotFoundError,
} from '@asciidocollab/domain';
import { addDictionaryTermSchema } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../plugins/require-auth';
import { requestContextFrom } from '../../lib/request-context';

/**
 * Registers the project-dictionary endpoints (feature 042 / US5):
 *  - `GET /api/projects/:projectId/dictionary` — any member reads every accepted term (for `importWords`).
 *  - `POST /api/projects/:projectId/dictionary` — an editor/owner adds a term (idempotent on a
 *    case-insensitive duplicate).
 *  - `DELETE /api/projects/:projectId/dictionary/:termId` — an editor/owner removes a term.
 *
 * Term validation uses the shared `addDictionaryTermSchema` (the single validation authority);
 * authorization lives entirely in the use cases. Per contracts/api.md these routes carry NO dedicated
 * rate limit — they are authenticated, project-scoped, and bounded (a small term list, cached client-side).
 */
export async function dictionaryRoutes(app: FastifyInstance): Promise<void> {
  const projectParameters = {
    type: 'object',
    required: ['projectId'],
    properties: { projectId: { type: 'string' } },
  } as const;

  const termParameters = {
    type: 'object',
    required: ['projectId', 'termId'],
    properties: { projectId: { type: 'string' }, termId: { type: 'string' } },
  } as const;

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/dictionary',
    { schema: { params: projectParameters } },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const useCase = new ListDictionaryTermsUseCase(
        request.server.repos.projectDictionary,
        request.server.repos.projectMember,
      );
      const result = await useCase.execute(actorId, projectId);
      if (!result.success) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: result.error.message } });
      }
      return reply.status(200).send({
        data: {
          terms: result.value.map((term) => ({
            id: term.id.value,
            term: term.term,
            createdByUserId: term.createdByUserId.value,
            createdAt: term.createdAt.toISOString(),
          })),
        },
      });
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/dictionary',
    { schema: { params: projectParameters, body: { type: 'object' } } },
    async (request, reply) => {
      const parsed = addDictionaryTermSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: 'ValidationFailed', message: parsed.error.message } });
      }

      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const useCase = new AddDictionaryTermUseCase(
        request.server.repos.projectDictionary,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
      );
      const result = await useCase.execute(actorId, projectId, parsed.data.term, requestContextFrom(request));
      if (!result.success) {
        if (result.error instanceof PermissionDeniedError) {
          return reply.status(403).send({ error: { code: 'FORBIDDEN', message: result.error.message } });
        }
        return reply.status(400).send({ error: { code: 'ValidationFailed', message: result.error.message } });
      }

      const term = result.value;
      return reply.status(201).send({
        data: {
          id: term.id.value,
          term: term.term,
          createdByUserId: term.createdByUserId.value,
          createdAt: term.createdAt.toISOString(),
        },
      });
    },
  );

  app.delete<{ Params: { projectId: string; termId: string } }>(
    '/api/projects/:projectId/dictionary/:termId',
    { schema: { params: termParameters } },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);
      const termId = ProjectDictionaryTermId.create(request.params.termId);

      const useCase = new RemoveDictionaryTermUseCase(
        request.server.repos.projectDictionary,
        request.server.repos.projectMember,
        request.server.repos.auditLog,
      );
      const result = await useCase.execute(actorId, projectId, termId, requestContextFrom(request));
      if (!result.success) {
        if (result.error instanceof PermissionDeniedError) {
          return reply.status(403).send({ error: { code: 'FORBIDDEN', message: result.error.message } });
        }
        if (result.error instanceof DictionaryTermNotFoundError) {
          return reply.status(404).send({ error: { code: 'NOT_FOUND', message: result.error.message } });
        }
        return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Failed to remove term' } });
      }
      return reply.status(204).send();
    },
  );
}
