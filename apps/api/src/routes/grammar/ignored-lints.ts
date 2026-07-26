import type { FastifyInstance } from 'fastify';
import {
  GetIgnoredLintsUseCase,
  ReplaceIgnoredLintsUseCase,
  UserId,
  FileNodeId,
  PermissionDeniedError,
} from '@asciidocollab/domain';
import { ignoredLintsBlobSchema } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../plugins/require-auth';

/**
 * Registers the per-user, per-document ignored-lints endpoints (feature 042 / US6):
 *  - `GET /api/documents/:documentId/ignored-lints` — the CALLER's private blob (empty string when none).
 *  - `PUT /api/documents/:documentId/ignored-lints` — full replace of the caller's blob.
 *
 * The blob is exactly harper.js `exportIgnoredLints()` output — privacy-hashed, never document prose —
 * and is scoped to the authenticated user, so a caller can only ever read/write their own record. The
 * use case verifies the caller is a member of the document's project. Per contracts/api.md these carry
 * no dedicated rate limit (a single small private blob per user).
 */
export async function ignoredLintsRoutes(app: FastifyInstance): Promise<void> {
  const documentParameters = {
    type: 'object',
    required: ['documentId'],
    properties: { documentId: { type: 'string' } },
  } as const;

  app.get<{ Params: { documentId: string } }>(
    '/api/documents/:documentId/ignored-lints',
    { schema: { params: documentParameters } },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const documentId = FileNodeId.create(request.params.documentId);

      const useCase = new GetIgnoredLintsUseCase(
        request.server.repos.ignoredLint,
        request.server.repos.fileNode,
        request.server.repos.projectMember,
      );
      const result = await useCase.execute(actorId, documentId);
      if (!result.success) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: result.error.message } });
      }
      return reply.status(200).send({ data: { ignoredLintsJson: result.value } });
    },
  );

  app.put<{ Params: { documentId: string }; Body: unknown }>(
    '/api/documents/:documentId/ignored-lints',
    { schema: { params: documentParameters, body: { type: 'object' } } },
    async (request, reply) => {
      const parsed = ignoredLintsBlobSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: { code: 'ValidationFailed', message: parsed.error.message } });
      }

      const actorId = UserId.create(getAuthenticatedUserId(request));
      const documentId = FileNodeId.create(request.params.documentId);

      const useCase = new ReplaceIgnoredLintsUseCase(
        request.server.repos.ignoredLint,
        request.server.repos.fileNode,
        request.server.repos.projectMember,
      );
      const result = await useCase.execute(actorId, documentId, parsed.data.ignoredLintsJson);
      if (!result.success) {
        if (result.error instanceof PermissionDeniedError) {
          return reply.status(403).send({ error: { code: 'FORBIDDEN', message: result.error.message } });
        }
        return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save ignored lints' } });
      }
      return reply.status(200).send({ data: { ignoredLintsJson: parsed.data.ignoredLintsJson } });
    },
  );
}
