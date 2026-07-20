import type { FastifyInstance, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import {
  UploadAssetUseCase,
  GetAssetContentUseCase,
  GetAssetContentByPathUseCase,
  UserId,
  ProjectId,
  FileNodeId,
  MimeType,
  PermissionDeniedError,
  FileNodeNotFoundError,
  FileConflictError,
  ValidationError,
  ContentNotFoundError,
} from '@asciidocollab/domain';
import type { FileTreeEventDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../plugins/require-auth';
import { requestContextFrom } from '../../lib/request-context';
import { requestLogger } from '../../lib/request-logger';
import { sanitizeContentDispositionFilename } from '../../lib/sanitize-filename';

interface AssetContent {
  bytes: Buffer;
  mimeType: { value: string };
  filename: string;
}
type AssetContentResult = { success: true; value: AssetContent } | { success: false; error: unknown };

/**
 * Maps a get-asset-content result onto an HTTP reply. Shared by the by-id (download) and by-path
 * (inline image) GET routes, which differ only in Content-Disposition, caching, and 404 wording.
 */
function sendAssetContent(
  reply: FastifyReply,
  result: AssetContentResult,
  options: { disposition: 'inline' | 'attachment'; cacheControl?: string; notFoundMessage: string },
): FastifyReply {
  if (!result.success) {
    if (result.error instanceof PermissionDeniedError) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: result.error.message } });
    }
    if (result.error instanceof FileNodeNotFoundError || result.error instanceof ContentNotFoundError) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: options.notFoundMessage } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  }

  const disposition = options.disposition === 'attachment'
    ? `attachment; filename="${sanitizeContentDispositionFilename(result.value.filename)}"`
    : 'inline';
  reply.status(200)
    .header('Content-Type', result.value.mimeType.value)
    .header('Content-Disposition', disposition);
  if (options.cacheControl) reply.header('Cache-Control', options.cacheControl);
  return reply.send(result.value.bytes);
}

/** Registers asset upload and retrieval routes under /projects/:projectId/assets. */
export async function assetsRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { limits: { fileSize: app.config.storage.maxUploadSizeBytes } });

  app.post<{ Params: { projectId: string }; Querystring: { parentId: string } }>(
    '/projects/:projectId/assets',
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);
      if (!request.query.parentId) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'parentId query parameter is required' } });
      }
      const parentId = FileNodeId.create(request.query.parentId);

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'No file provided' } });
      }

      const bytes = await data.toBuffer();
      const mimeType = MimeType.create(data.mimetype || 'application/octet-stream');

      const useCase = new UploadAssetUseCase(
        request.server.repos.projectMember,
        request.server.repos.fileNode,
        request.server.repos.asset,
        request.server.repos.document,
        request.server.stores.fileStore,
        request.server.repos.systemSetting,
        request.server.config.storage.maxUploadSizeBytes,
        request.server.repos.auditLog,
        requestLogger(request),
      );

      const result = await useCase.execute(actorId, projectId, parentId, data.filename, mimeType, bytes, requestContextFrom(request));

      if (!result.success) {
        if (result.error instanceof PermissionDeniedError) {
          return reply.status(403).send({ error: { code: 'FORBIDDEN', message: result.error.message } });
        }
        if (result.error instanceof ValidationError) {
          if (result.error.message.includes('MIME type')) {
            return reply.status(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: result.error.message } });
          }
          return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: 'File exceeds maximum permitted size' } });
        }
        if (result.error instanceof FileConflictError) {
          return reply.status(409).send({ error: { code: 'CONFLICT', message: result.error.message } });
        }
        if (result.error instanceof FileNodeNotFoundError) {
          return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Parent folder not found' } });
        }
        return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
      }

      const event: FileTreeEventDto = { type: 'created', fileNodeId: result.value.fileNodeId.value, nodeType: 'file', name: data.filename, path: result.value.storagePath, parentId: request.query.parentId };
      request.server.fileTreeEventBus.emit(projectId.value, event);

      return reply.status(201).send({
        assetId: result.value.fileNodeId.value,
        storagePath: result.value.storagePath,
      });
    },
  );

  app.get<{ Params: { projectId: string; assetId: string } }>(
    '/projects/:projectId/assets/:assetId',
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);
      const fileNodeId = FileNodeId.create(request.params.assetId);

      const useCase = new GetAssetContentUseCase(
        request.server.repos.projectMember,
        request.server.repos.asset,
        request.server.repos.fileNode,
        request.server.stores.fileStore,
      );

      const result = await useCase.execute(actorId, projectId, fileNodeId);
      return sendAssetContent(reply, result, { disposition: 'attachment', notFoundMessage: 'Asset not found' });
    },
  );

  // Serves a project asset addressed by its path (e.g. /projects/:id/images/diagram.png).
  // This is the base path the preview's `imagesdir` points at, so AsciiDoc image macros —
  // which reference files by path, not id — resolve. Disposition is `inline` so browsers
  // render the image in <img> rather than treating it as a download.
  app.get<{ Params: { projectId: string; '*': string } }>(
    '/projects/:projectId/images/*',
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);
      const path = request.params['*']
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');

      const useCase = new GetAssetContentByPathUseCase(
        request.server.repos.projectMember,
        request.server.repos.asset,
        request.server.repos.fileNode,
        request.server.stores.fileStore,
      );

      const result = await useCase.execute(actorId, projectId, path);
      return sendAssetContent(reply, result, {
        disposition: 'inline',
        cacheControl: 'private, max-age=60',
        notFoundMessage: 'Image not found',
      });
    },
  );
}
