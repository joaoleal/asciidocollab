import type { FastifyInstance } from 'fastify';
import {
  CreateFileUseCase,
  CreateFolderUseCase,
  UserId,
  ProjectId,
  FileNodeId,
  MimeType,
} from '@asciidocollab/domain';
import type { FileTreeEventDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../plugins/require-auth';
import { requestContextFrom } from '../../lib/request-context';
import { requestLogger } from '../../lib/request-logger';
import { isGitWriteLocked, requireProjectMembership, sendGitOperationInProgressError } from '../../lib/git-write-lock';
import { sendFileTreeError, isHiddenMetadataName, sendHiddenMetadataError } from './file-tree-errors';

type CreateBody = { type: 'file' | 'folder'; parentId: string; name: string; mimeType?: string };

/** Registers POST /projects/:projectId/files. */
export async function fileTreeCreateRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: CreateBody }>(
    '/projects/:projectId/files',
    {
      schema: {
        body: {
          type: 'object',
          required: ['type', 'parentId', 'name'],
          properties: {
            type: { type: 'string', enum: ['file', 'folder'] },
            parentId: { type: 'string' },
            name: { type: 'string' },
            mimeType: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);
      const { type, parentId, name, mimeType } = request.body;

      // .git/.collab are internal siblings of the tracked project tree, never project content
      // (security boundary): reject before touching the file store or the database.
      if (isHiddenMetadataName(name)) {
        return sendHiddenMetadataError(reply);
      }

      // Membership gate: a non-member must be refused (403) before the write-lock check below, or
      // its 409 would leak that the project exists and has active git activity.
      const membershipCheck = await requireProjectMembership(request, actorId, projectId);
      if (!membershipCheck.success) {
        return sendFileTreeError(reply, membershipCheck.error);
      }

      // Write-lock: a content-changing git operation (import/pull/checkout) is currently replacing
      // this project's working tree, so no file-tree mutation may run concurrently with it.
      if (await isGitWriteLocked(request.server.repos.gitOperation, projectId)) {
        return sendGitOperationInProgressError(reply);
      }

      const parentFileNodeId = FileNodeId.create(parentId);

      if (type === 'folder') {
        const useCase = new CreateFolderUseCase(
          request.server.repos.projectMember,
          request.server.repos.fileNode,
          request.server.stores.fileStore,
          request.server.repos.auditLog,
          requestLogger(request),
        );
        const result = await useCase.execute(actorId, projectId, parentFileNodeId, name, requestContextFrom(request));

        if (!result.success) return sendFileTreeError(reply, result.error);
        const event: FileTreeEventDto = { type: 'created', fileNodeId: result.value.fileNodeId.value, nodeType: 'folder', name, path: result.value.path.value, parentId: parentId };
        request.server.fileTreeEventBus.emit(projectId.value, event);
        return reply.status(201).send({ fileNodeId: result.value.fileNodeId.value, path: result.value.path.value });
      } else {
        const mime = MimeType.create(mimeType ?? 'text/asciidoc');
        const useCase = new CreateFileUseCase(
          request.server.repos.projectMember,
          request.server.repos.fileNode,
          request.server.repos.document,
          request.server.stores.fileStore,
          request.server.repos.auditLog,
          requestLogger(request),
        );
        const result = await useCase.execute(actorId, projectId, parentFileNodeId, name, mime, Buffer.alloc(0), requestContextFrom(request));

        if (!result.success) return sendFileTreeError(reply, result.error);
        const event: FileTreeEventDto = { type: 'created', fileNodeId: result.value.fileNodeId.value, nodeType: 'file', name, path: result.value.path.value, parentId: parentId };
        request.server.fileTreeEventBus.emit(projectId.value, event);
        return reply.status(201).send({ fileNodeId: result.value.fileNodeId.value, path: result.value.path.value });
      }
    },
  );
}
