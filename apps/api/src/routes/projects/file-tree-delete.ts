import type { FastifyInstance } from 'fastify';
import {
  DeleteFileUseCase,
  UserId,
  ProjectId,
  FileNodeId,
} from '@asciidocollab/domain';
import type { FileTreeEventDto } from '@asciidocollab/shared';
import { getAuthenticatedUserId } from '../../plugins/require-auth';
import { requestContextFrom } from '../../lib/request-context';
import { requestLogger } from '../../lib/request-logger';
import { isGitWriteLocked, sendGitOperationInProgressError } from '../../lib/git-write-lock';
import { sendFileTreeError, toNodeType, pathHasHiddenMetadataSegment, sendHiddenMetadataError } from './file-tree-errors';

/** Registers DELETE /projects/:projectId/files/:fileNodeId. */
export async function fileTreeDeleteRoutes(app: FastifyInstance): Promise<void> {
  app.delete<{ Params: { projectId: string; fileNodeId: string } }>(
    '/projects/:projectId/files/:fileNodeId',
    async (request, reply) => {
      const actorId = UserId.create(getAuthenticatedUserId(request));
      const projectId = ProjectId.create(request.params.projectId);
      const fileNodeId = FileNodeId.create(request.params.fileNodeId);

      const useCase = new DeleteFileUseCase(
        request.server.repos.projectMember,
        request.server.repos.fileNode,
        request.server.repos.document,
        request.server.repos.auditLog,
        request.server.stores.fileStore,
        request.server.stores.yjsStateStore,
        requestLogger(request),
        request.server.repos.project,
      );

      const fileNodeBeforeDelete = await request.server.repos.fileNode.findById(fileNodeId);

      // Defense-in-depth: a node whose stored path resolves into .git/.collab must never be
      // deleted through the app, even if such a node somehow exists (it can never be created or
      // renamed into one via this API — see file-tree-create.ts / file-tree-patch.ts).
      if (fileNodeBeforeDelete && pathHasHiddenMetadataSegment(fileNodeBeforeDelete.path.value)) {
        return sendHiddenMetadataError(reply);
      }

      // Write-lock: a content-changing git operation (import/pull/checkout) is currently replacing
      // this project's working tree, so no file-tree mutation may run concurrently with it.
      if (await isGitWriteLocked(request.server.repos.gitOperation, projectId)) {
        return sendGitOperationInProgressError(reply);
      }

      const result = await useCase.execute(actorId, fileNodeId, projectId, requestContextFrom(request));
      if (!result.success) {
        return sendFileTreeError(reply, result.error);
      }
      if (fileNodeBeforeDelete) {
        const event: FileTreeEventDto = { type: 'deleted', fileNodeId: fileNodeId.value, nodeType: toNodeType(fileNodeBeforeDelete.type.value), name: fileNodeBeforeDelete.name, path: fileNodeBeforeDelete.path.value, parentId: fileNodeBeforeDelete.parentId?.value ?? null };
        request.server.fileTreeEventBus.emit(projectId.value, event);
      }
      return reply.status(204).send();
    },
  );
}
