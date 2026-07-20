import { UserId } from '../../value-objects/ids/user-id';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { ProjectFileStore } from '../../ports/storage/project-file-store';
import { YjsStateStore } from '../../ports/storage/yjs-state-store';
import { YjsStateId } from '../../value-objects/ids/yjs-state-id';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { FileNodeNotFoundError } from '../../errors/file-tree/file-node-not-found';
import { CannotDeleteRootFolderError } from '../../errors/file-tree/cannot-delete-root-folder';
import { DomainError } from '../../errors/domain-error';
import { Result } from '../../types/result';
import { Logger } from '../../ports/observability/logger';
import { RequestContext } from '../../types/request-context';
import { recordAuthorizationDenial, recordAuditSuccess } from '../audit-recording';
import { ProjectRepository } from '../../ports/project/project.repository';

/**
 * Deletes a file or folder (and its descendants) from a project.
 * Requires the actorId to be a member of the project.
 * The root folder cannot be deleted.
 */
export class DeleteFileUseCase {
  /** Creates a new DeleteFileUseCase instance. */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly documentRepo: DocumentRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly fileStore?: ProjectFileStore,
    private readonly yjsStateStore?: YjsStateStore,
    private readonly logger?: Logger,
    // Optional: when injected, clears the project main-file configuration if the
    // deleted file (or a file beneath a deleted folder) was the main file.
    private readonly projectRepo?: ProjectRepository,
  ) {}

  /**
   * Deletes a file or folder (and its descendants) from a project.
   *
   * @param actorId - The user requesting the deletion.
   * @param fileNodeId - The file or folder to delete.
   * @param projectId - The project containing the file or folder.
   * @returns Void on success.
   * On failure returns `PermissionDeniedError` if `actorId` is not a project member,
   * `FileNodeNotFoundError` if the file node does not exist, or
   * `CannotDeleteRootFolderError` if the target is the project root folder.
   */
  async execute(
    actorId: UserId,
    fileNodeId: FileNodeId,
    projectId: ProjectId,
    context?: RequestContext,
  ): Promise<Result<{ mainFileCleared: boolean }, DomainError>> {
    // Deleting a file mutates the project's structure, so it requires write
    // access (editor or owner). A viewer — including every member of a read-only
    // shared project such as the bundled demo — is denied here.
    const member = await this.projectMemberRepo.findByCompositeKey(projectId, actorId);
    const role = member?.role.value;
    if (role !== 'owner' && role !== 'editor') {
      await recordAuthorizationDenial(this.auditLogRepo, {
        actorId,
        projectId,
        resourceType: 'FileNode',
        resourceId: fileNodeId.value,
        reason: member ? 'insufficient_role' : 'not_a_project_member',
        context,
      }, this.logger);
      return { success: false, error: new PermissionDeniedError() };
    }

    const fileNode = await this.fileNodeRepo.findById(fileNodeId);
    if (!fileNode || fileNode.projectId.value !== projectId.value) {
      return { success: false, error: new FileNodeNotFoundError(fileNodeId.value) };
    }

    if (fileNode.parentId === null) {
      return { success: false, error: new CannotDeleteRootFolderError(fileNodeId.value) };
    }

    // Hoist document lookup to avoid a second DB round-trip in the deletion path below.
    const document = fileNode.type.value === 'file'
      ? await this.documentRepo.findByFileNodeId(fileNodeId)
      : null;

    // decide BEFORE deletion whether the configured main file is removed by
    // this operation (the file itself, or a file beneath a deleted folder), so the
    // configuration can be cleared rather than left dangling.
    const projectForMainFile = this.projectRepo ? await this.projectRepo.findById(projectId) : null;
    let mainFileAffected = false;
    if (projectForMainFile?.mainFileNodeId) {
      const mainFileNodeId = projectForMainFile.mainFileNodeId;
      if (fileNode.type.value === 'file') {
        mainFileAffected = mainFileNodeId.value === fileNodeId.value;
      } else {
        const mainFileNode = await this.fileNodeRepo.findById(mainFileNodeId);
        mainFileAffected = mainFileNode !== null && mainFileNode.path.value.startsWith(fileNode.path.value + '/');
      }
    }

    // Note: deletion is allowed even while a collaboration room is open for this file. The
    // CollaborationSession row is removed by the cascade on the deleted Document, and any
    // connected clients are disconnected when the room's document disappears. Blocking the
    // delete instead would make any file the user has merely opened impossible to delete.
    if (fileNode.type.value === 'file') {
      if (document) {
        await this.documentRepo.delete(document.id);
      }
      await this.fileNodeRepo.delete(fileNodeId);
      // Filesystem cleanup after DB deletions (RT-5 ordering)
      if (this.fileStore) {
        await this.fileStore.remove(projectId, fileNode.path);
      }
      if (document && this.yjsStateStore) {
        try {
          await this.yjsStateStore.delete(projectId, document.yjsStateId);
        } catch {
          // Yjs state cleanup failed; DB records are already deleted so the deletion
          // is semantically complete. The orphaned blob will need manual cleanup.
        }
      }
    } else {
      await this.deleteFolderRecursively(fileNodeId, projectId);
      if (this.fileStore) {
        await this.fileStore.removeDirectory(projectId, fileNode.path);
      }
    }

    let mainFileCleared = false;
    if (mainFileAffected && projectForMainFile && this.projectRepo) {
      projectForMainFile.setMainFile(null);
      await this.projectRepo.save(projectForMainFile);
      mainFileCleared = true;
    }

    await recordAuditSuccess(this.auditLogRepo, {
      actorId,
      projectId,
      action: 'file.deleted',
      resourceType: 'FileNode',
      resourceId: fileNodeId.value,
      context,
    }, this.logger);

    return { success: true, value: { mainFileCleared } };
  }

  private async deleteFolderRecursively(folderId: FileNodeId, projectId: ProjectId): Promise<void> {
    const stack: FileNodeId[] = [folderId];
    const toDelete: FileNodeId[] = [];
    const yjsStateIds: YjsStateId[] = [];

    while (stack.length > 0) {
      const currentId = stack.pop()!;
      toDelete.push(currentId);

      const children = await this.fileNodeRepo.findByParentId(currentId);

      for (const child of children) {
        if (child.type.value === 'file') {
          const document = await this.documentRepo.findByFileNodeId(child.id);
          if (document) {
            yjsStateIds.push(document.yjsStateId);
            await this.documentRepo.delete(document.id);
          }
          toDelete.push(child.id);
        } else {
          stack.push(child.id);
        }
      }
    }

    for (const id of toDelete.toReversed()) {
      await this.fileNodeRepo.delete(id);
    }

    if (this.yjsStateStore) {
      for (const stateId of yjsStateIds) {
        try {
          await this.yjsStateStore.delete(projectId, stateId);
        } catch {
          // Yjs state cleanup failed; DB records are already deleted so the deletion
          // is semantically complete. The orphaned blob will need manual cleanup.
        }
      }
    }
  }
}
