import { FileNode } from '../../entities/file-node';
import { Timestamps } from '../../value-objects/common/timestamps';
import { cascadePathUpdate } from './file-tree-helpers';
import { UserId } from '../../value-objects/ids/user-id';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { FilePath } from '../../value-objects/files/file-path';
import { FileName } from '../../value-objects/files/file-name';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { ProjectFileStore } from '../../ports/storage/project-file-store';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { CollaborativeContentEditor } from '../../ports/storage/collaborative-content-editor';
import { CollaborativeContentReader } from '../../ports/storage/collaborative-content-reader';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { FileNodeNotFoundError } from '../../errors/file-tree/file-node-not-found';
import { Logger } from '../../ports/observability/logger';
import { RequestContext } from '../../types/request-context';
import { recordAuthorizationDenial, recordAuditSuccess } from '../audit-recording';
import { AUDIT_FILE_RENAMED } from '../../audit-actions';
import { DomainError } from '../../errors/domain-error';
import { Result } from '../../types/result';
import { ProjectRepository } from '../../ports/project/project.repository';
import {
  rewriteReferencesForPathChanges,
  capturePathChanges,
  clearMainFileIfMatches,
} from './reference-rewrite';
import { isAsciiDocumentFileName } from '../../value-objects/files/asciidoc-file-name';

/**
 * Renames a file or folder within a project and records an audit log entry.
 * Requires the actorId to be a member of the project.
 */
export class RenameFileUseCase {
  /** Creates a new RenameFileUseCase instance. */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly fileStore?: ProjectFileStore,
    private readonly logger?: Logger,
    // Optional: maintains the project main-file configuration on rename.
    private readonly projectRepo?: ProjectRepository,
    // Optional pair: when both are supplied, references in a file that is a collaborative Document
    // are rewritten through the Yjs source of truth instead of the file store (avoids live-clobber).
    private readonly documentRepo?: Pick<DocumentRepository, 'findByFileNodeId'>,
    private readonly collaborativeContentEditor?: CollaborativeContentEditor,
    // Optional: lets the reference-rewrite SCAN read a referencing file's live Yjs content so an
    // unsaved reference is still found and corrected (mirrors the symbol-rename scan).
    private readonly collaborativeContentReader?: CollaborativeContentReader,
  ) {}

  /**
   * Renames a file or folder within a project and records an audit log entry.
   *
   * @param actorId - The user performing the rename.
   * @param fileNodeId - The file or folder to rename.
   * @param newName - The new name for the file or folder.
   * @param projectId - The project containing the file or folder.
   * @returns The updated file node ID, new name, and new path.
   * On failure returns `PermissionDeniedError` if `actorId` is not a project member,
   * or `FileNodeNotFoundError` if the file node does not exist.
   */
  async execute(
    actorId: UserId,
    fileNodeId: FileNodeId,
    newName: string,
    projectId: ProjectId,
    context?: RequestContext,
  ): Promise<Result<{ fileNodeId: FileNodeId; newName: string; newPath: FilePath; mainFileCleared: boolean }, DomainError>> {
    // Renaming a file mutates the project's structure, so it requires write
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

    FileName.create(newName); // throws ValidationError for invalid names
    const previousName = fileNode.name;
    const pathString = fileNode.path.value;
    const lastSlash = pathString.lastIndexOf('/');
    const parentPath = pathString.slice(0, lastSlash + 1);
    const newPath = FilePath.create(parentPath + newName);

    // Capture the old → new path map BEFORE the cascade rewrites descendant paths
    // For a file it is a single entry; for a folder, every descendant file.
    // The rewrite needs the file store to read/write content, so it is skipped when absent.
    const pathChanges = this.fileStore
      ? await capturePathChanges(this.fileNodeRepo, fileNode, newPath)
      : new Map<string, string>();

    if (this.fileStore) {
      const moveResult = await this.fileStore.move(projectId, fileNode.path, newPath);
      if (!moveResult.success) {
        return { success: false, error: moveResult.error };
      }
    }

    try {
      const updatedFileNode = new FileNode(
        fileNode.id,
        fileNode.projectId,
        fileNode.parentId,
        newName,
        fileNode.type,
        newPath,
        new Timestamps(fileNode.createdAt, new Date()),
      );

      await this.fileNodeRepo.save(updatedFileNode);

      if (fileNode.type.value === 'folder') {
        await cascadePathUpdate(this.fileNodeRepo, fileNodeId, fileNode.path.value + '/', newPath.value + '/');
      }
    } catch (error) {
      if (this.fileStore) {
        try {
          await this.fileStore.move(projectId, newPath, fileNode.path);
        } catch {
          // Rollback failed — filesystem and DB are now inconsistent.
          // The original error is re-thrown below.
        }
      }
      throw error;
    }

    if (this.fileStore) {
      // Best-effort: the rename has already persisted, so a reference-rewrite
      // I/O failure must not fail the rename — log and continue (as audit writes do).
      try {
        await rewriteReferencesForPathChanges(
          {
            fileNodeRepo: this.fileNodeRepo,
            fileStore: this.fileStore,
            ...(this.documentRepo && { documentRepo: this.documentRepo }),
            ...(this.collaborativeContentEditor && { collaborativeContentEditor: this.collaborativeContentEditor }),
            ...(this.collaborativeContentReader && { collaborativeContentReader: this.collaborativeContentReader }),
            ...(this.logger && { logger: this.logger }),
          },
          projectId,
          pathChanges,
        );
      } catch (error) {
        this.logger?.warn('Cross-file reference rewrite failed after rename', { error, fileNodeId: fileNodeId.value });
      }
    }

    // If the renamed node is the configured main file and its new name is
    // no longer an AsciiDoc document, the configuration can no longer point at a
    // valid main file — clear it (resolution falls back to current-file-only).
    let mainFileCleared = false;
    if (this.projectRepo && fileNode.type.value === 'file' && !isAsciiDocumentFileName(newName)) {
      mainFileCleared = await clearMainFileIfMatches(
        this.projectRepo,
        projectId,
        (mainFileNodeId) => mainFileNodeId.value === fileNodeId.value,
      );
    }

    await recordAuditSuccess(this.auditLogRepo, {
      actorId,
      projectId,
      action: AUDIT_FILE_RENAMED,
      resourceType: 'FileNode',
      resourceId: fileNodeId.value,
      metadata: { previousName, newName },
      context,
    }, this.logger);

    return {
      success: true,
      value: { fileNodeId, newName, newPath, mainFileCleared },
    };
  }
}
