import type { FastifyInstance } from 'fastify';
import {
  GetPdfExtensionCatalogueUseCase,
  GetProjectRenderConfigUseCase,
  PermissionDeniedError,
  ProjectId,
  UserId,
} from '@asciidocollab/domain';
import { safeNormalizeRenderConfig } from '@asciidocollab/shared';
import { SHIPPED_PDF_EXTENSION_MANIFESTS, SHIPPED_PDF_EXTENSION_SOURCES } from '../../lib/pdf-extensions';
import { getAuthenticatedUserId } from '../../plugins/require-auth';

/**
 * Registers the PDF converter-extension endpoints:
 *  - `GET /api/projects/:projectId/pdf-extensions` — the catalogue this project may choose from.
 *  - `GET /api/projects/:projectId/pdf-extensions/:extensionId/source` — one extension's Ruby source,
 *    fetched by the browser at render time.
 *
 * Both handlers are DELIBERATELY thin: they translate HTTP to a use-case call and a `Result` back to
 * a status code, and hold no assembly logic and no permission check of their own. Merging the shipped
 * and administrator sets, resolving stale selections and deciding what a duplicate id means are
 * product decisions that live in the use case; authorization lives there too, so it cannot be
 * forgotten by a future caller that does not come through this route.
 *
 * `:extensionId` is resolved by CATALOGUE LOOKUP and never joined onto a filesystem path. That is the
 * property which makes the parameter safe regardless of what a client sends.
 */
export async function pdfExtensionRoutes(app: FastifyInstance): Promise<void> {
  const parametersSchema = {
    type: 'object',
    required: ['projectId'],
    properties: { projectId: { type: 'string' } },
  } as const;

  const sourceParametersSchema = {
    type: 'object',
    required: ['projectId', 'extensionId'],
    properties: { projectId: { type: 'string' }, extensionId: { type: 'string' } },
  } as const;

  const catalogueRateLimit = {
    max: app.config.project.pdfExtensions.rateLimitMax,
    timeWindow: app.config.project.pdfExtensions.rateLimitWindow,
  };
  const sourceRateLimit = {
    max: app.config.project.pdfExtensions.sourceRateLimitMax,
    timeWindow: app.config.project.pdfExtensions.sourceRateLimitWindow,
  };

  /** The project's currently enabled ids, which the catalogue needs to resolve stale selections. */
  async function enabledIdsFor(
    server: FastifyInstance,
    actorId: UserId,
    projectId: ProjectId,
  ): Promise<readonly string[] | null> {
    const useCase = new GetProjectRenderConfigUseCase(
      server.repos.projectRenderConfig,
      server.repos.projectMember,
    );
    const result = await useCase.execute(actorId, projectId);
    if (!result.success) return null;
    // The stored config is untyped JSON, so it is read through the shared schema — the single
    // validation authority — rather than by asserting a shape onto it here. A config that no longer
    // parses yields no selection rather than a crash.
    const parsed = safeNormalizeRenderConfig(result.value?.config ?? {});
    return parsed.success ? (parsed.data.extensions?.enabled ?? []) : [];
  }

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/pdf-extensions',
    { config: { rateLimit: catalogueRateLimit }, schema: { params: parametersSchema } },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const enabledIds = await enabledIdsFor(request.server, actorId, projectId);
      if (enabledIds === null) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Not a project member' } });
      }

      const useCase = new GetPdfExtensionCatalogueUseCase(
        request.server.repos.projectMember,
        SHIPPED_PDF_EXTENSION_MANIFESTS,
        request.server.stores.pdfExtensionSource,
      );
      const result = await useCase.execute({ actorId, projectId, enabledIds });

      if (!result.success) {
        if (result.error instanceof PermissionDeniedError) {
          return reply.status(403).send({ error: { code: 'FORBIDDEN', message: result.error.message } });
        }
        return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
      }

      return reply.status(200).send({ data: result.value });
    },
  );

  app.get<{ Params: { projectId: string; extensionId: string } }>(
    '/api/projects/:projectId/pdf-extensions/:extensionId/source',
    { config: { rateLimit: sourceRateLimit }, schema: { params: sourceParametersSchema } },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);

      const enabledIds = await enabledIdsFor(request.server, actorId, projectId);
      if (enabledIds === null) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Not a project member' } });
      }

      // The catalogue is consulted FIRST, and the requested id must appear in it. This is what makes
      // `:extensionId` safe: it is matched against entries the server assembled, never turned into a
      // path. A client can send anything; only something the catalogue already offers resolves.
      const useCase = new GetPdfExtensionCatalogueUseCase(
        request.server.repos.projectMember,
        SHIPPED_PDF_EXTENSION_MANIFESTS,
        request.server.stores.pdfExtensionSource,
      );
      const catalogue = await useCase.execute({ actorId, projectId, enabledIds });
      if (!catalogue.success) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: catalogue.error.message } });
      }

      const entry = catalogue.value.entries.find(
        (candidate) => candidate.manifest.id === request.params.extensionId && candidate.available,
      );
      if (entry === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Extension not found' } });
      }

      if (entry.origin === 'shipped') {
        const source = SHIPPED_PDF_EXTENSION_SOURCES[entry.manifest.id];
        if (source === undefined) {
          return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Extension source not found' } });
        }
        return reply.status(200).type('text/plain; charset=utf-8').send(source);
      }

      const listed = await request.server.stores.pdfExtensionSource.list();
      if (!listed.success) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Extension source not found' } });
      }
      const discovered = listed.value.extensions.find(
        (candidate) => candidate.manifest.id === entry.manifest.id,
      );
      if (discovered === undefined) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Extension source not found' } });
      }

      const source = await request.server.stores.pdfExtensionSource.readSource(discovered.handle);
      if (!source.success) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Extension source not found' } });
      }
      return reply.status(200).type('text/plain; charset=utf-8').send(source.value);
    },
  );
}
