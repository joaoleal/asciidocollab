import type { FastifyInstance } from 'fastify';
import {
  RenameFileUseCase,
  MoveFileUseCase,
  UserId,
  ProjectId,
  FileNodeId,
} from '@asciidocollab/domain';
import type { FileTreeEventDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../plugins/require-auth';
import { requestContextFrom } from '../../lib/request-context';
import { requestLogger } from '../../lib/request-logger';
import { isGitWriteLocked, requireProjectMembership, sendGitOperationInProgressError } from '../../lib/git-write-lock';
import { sendFileTreeError, toNodeType, isHiddenMetadataName, sendHiddenMetadataError } from './file-tree-errors';

type PatchBody = { name?: string; parentId?: string };

/** Registers PATCH /projects/:projectId/files/:fileNodeId. */
export async function fileTreePatchRoutes(app: FastifyInstance): Promise<void> {
  app.patch<{ Params: { projectId: string; fileNodeId: string }; Body: PatchBody }>(
    '/projects/:projectId/files/:fileNodeId',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            parentId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);
      const fileNodeId = FileNodeId.create(request.params.fileNodeId);
      const { name, parentId } = request.body;

      // A rename that lands the node on .git/.collab must be rejected before the file store or
      // database are touched (security boundary) — both the rename-only and combined branches
      // rename the node, so both are guarded here.
      if (name !== undefined && isHiddenMetadataName(name)) {
        return sendHiddenMetadataError(reply);
      }

      // Membership gate: a non-member must be refused (403) before the write-lock check below, or
      // its 409 would leak that the project exists and has active git activity. Covers every branch
      // below, same as the write-lock check.
      const membershipCheck = await requireProjectMembership(request, actorId, projectId);
      if (!membershipCheck.success) {
        return sendFileTreeError(reply, membershipCheck.error);
      }

      // Write-lock: a content-changing git operation (import/pull/checkout) is currently replacing
      // this project's working tree, so no file-tree mutation may run concurrently with it — this
      // covers every branch below (rename-only, move-only, and the combined rename+move).
      if (await isGitWriteLocked(request.server.repos.gitOperation, projectId)) {
        return sendGitOperationInProgressError(reply);
      }

      if (name !== undefined && parentId !== undefined) {
        const renameUseCase = new RenameFileUseCase(
          request.server.repos.projectMember,
          request.server.repos.fileNode,
          request.server.repos.auditLog,
          request.server.stores.fileStore,
          requestLogger(request),
          request.server.repos.project,
          request.server.repos.document,
          request.server.stores.collaborativeContentEditor,
          request.server.stores.collaborativeContentEditor,
        );
        const renameResult = await renameUseCase.execute(actorId, fileNodeId, name, projectId, requestContextFrom(request));
        if (!renameResult.success) return sendFileTreeError(reply, renameResult.error);

        const moveUseCase = new MoveFileUseCase(
          request.server.repos.projectMember,
          request.server.repos.fileNode,
          request.server.stores.fileStore,
          request.server.repos.auditLog,
          requestLogger(request),
          request.server.repos.document,
          request.server.stores.collaborativeContentEditor,
          request.server.stores.collaborativeContentEditor,
        );
        const newParentId = FileNodeId.create(parentId);
        const moveResult = await moveUseCase.execute(actorId, projectId, fileNodeId, newParentId, requestContextFrom(request));
        if (!moveResult.success) return sendFileTreeError(reply, moveResult.error);

        const updatedNode = await request.server.repos.fileNode.findById(fileNodeId);
        if (updatedNode) {
          const event: FileTreeEventDto = {
            type: 'moved',
            fileNodeId: fileNodeId.value,
            nodeType: toNodeType(updatedNode.type.value),
            name,
            path: moveResult.value.newPath.value,
            parentId,
          };
          request.server.fileTreeEventBus.emit(projectId.value, event);
        }
        return reply.status(204).send();
      } else if (name !== undefined) {
        const useCase = new RenameFileUseCase(
          request.server.repos.projectMember,
          request.server.repos.fileNode,
          request.server.repos.auditLog,
          request.server.stores.fileStore,
          requestLogger(request),
          request.server.repos.project,
          request.server.repos.document,
          request.server.stores.collaborativeContentEditor,
          request.server.stores.collaborativeContentEditor,
        );
        const result = await useCase.execute(actorId, fileNodeId, name, projectId, requestContextFrom(request));
        if (!result.success) return sendFileTreeError(reply, result.error);
        const renamedNode = await request.server.repos.fileNode.findById(fileNodeId);
        if (renamedNode) {
          const event: FileTreeEventDto = { type: 'renamed', fileNodeId: fileNodeId.value, nodeType: toNodeType(renamedNode.type.value), name, path: result.value.newPath.value, parentId: renamedNode.parentId?.value ?? null };
          request.server.fileTreeEventBus.emit(projectId.value, event);
        }
        return reply.status(204).send();
      } else if (parentId !== undefined) {
        const useCase = new MoveFileUseCase(
          request.server.repos.projectMember,
          request.server.repos.fileNode,
          request.server.stores.fileStore,
          request.server.repos.auditLog,
          requestLogger(request),
          request.server.repos.document,
          request.server.stores.collaborativeContentEditor,
          request.server.stores.collaborativeContentEditor,
        );
        const newParentId = FileNodeId.create(parentId);
        const result = await useCase.execute(actorId, projectId, fileNodeId, newParentId, requestContextFrom(request));
        if (!result.success) return sendFileTreeError(reply, result.error);
        const movedNode = await request.server.repos.fileNode.findById(fileNodeId);
        if (movedNode) {
          const event: FileTreeEventDto = { type: 'moved', fileNodeId: fileNodeId.value, nodeType: toNodeType(movedNode.type.value), name: movedNode.name, path: result.value.newPath.value, parentId: parentId };
          request.server.fileTreeEventBus.emit(projectId.value, event);
        }
        return reply.status(204).send();
      }

      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Provide name or parentId' } });
    },
  );
}
