import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { FilePath } from '../../value-objects/files/file-path';
import { FileName } from '../../value-objects/files/file-name';
import { MimeType } from '../../value-objects/files/mime-type';
import { ContentId } from '../../value-objects/ids/content-id';
import { YjsStateId } from '../../value-objects/ids/yjs-state-id';
import { DocumentId } from '../../value-objects/ids/document-id';
import { FileNodeType } from '../../value-objects/files/file-node-type';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { ProjectFileStore } from '../../ports/storage/project-file-store';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { buildParentPath } from './file-tree-helpers';
import { FileNodeNotFoundError } from '../../errors/file-tree/file-node-not-found';
import { DomainError } from '../../errors/domain-error';
import { Result } from '../../types/result';
import { FileNode } from '../../entities/file-node';
import { Document } from '../../entities/document';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { RequestContext } from '../../types/request-context';
import { recordAuthorizationDenial, recordAuditSuccess } from '../audit-recording';
import { AUDIT_FILE_CREATED } from '../../audit-actions';
import { randomUUID } from 'crypto';

/** Creates a new AsciiDoc document node in the file tree and its corresponding content file. */
export class CreateFileUseCase {
  /** Initializes the use case with the repositories and file store required to create a file. */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly documentRepo: DocumentRepository,
    private readonly fileStore: ProjectFileStore,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /** Validates membership, creates the file on disk and in the database, and returns the new node's ID and path. */
  async execute(
    actorId: UserId,
    projectId: ProjectId,
    parentId: FileNodeId,
    name: string,
    mimeType: MimeType,
    initialContent: Buffer,
    context?: RequestContext,
  ): Promise<Result<{ fileNodeId: FileNodeId; path: FilePath }, DomainError>> {
    // Creating a file mutates the project's structure, so it requires write
    // access (editor or owner). A viewer — including every member of a read-only
    // shared project such as the bundled demo — is denied here, mirroring the
    // role gate already enforced by content replace/rename.
    const member = await this.projectMemberRepo.findByCompositeKey(projectId, actorId);
    const role = member?.role.value;
    if (role !== 'owner' && role !== 'editor') {
      await recordAuthorizationDenial(this.auditLogRepo, {
        actorId,
        projectId,
        resourceType: 'Project',
        resourceId: projectId.value,
        reason: member ? 'insufficient_role' : 'not_a_project_member',
        context,
      }, this.logger);
      return { success: false, error: new PermissionDeniedError() };
    }

    const parent = await this.fileNodeRepo.findById(parentId);
    if (!parent || parent.type.value !== 'folder') {
      return { success: false, error: new FileNodeNotFoundError(parentId.value) };
    }

    FileName.create(name); // throws ValidationError for invalid names
    const parentPath = buildParentPath(parent.path.value);
    const newPath = FilePath.create(`${parentPath}${name}`);

    const storeResult = await this.fileStore.createExclusive(projectId, newPath, initialContent);
    if (!storeResult.success) {
      return { success: false, error: storeResult.error };
    }

    try {
      const fileNodeId = FileNodeId.create(randomUUID());
      const fileNode = new FileNode(fileNodeId, projectId, parentId, name, FileNodeType.create('file'), newPath);
      await this.fileNodeRepo.save(fileNode);

      const documentId = DocumentId.create(randomUUID());
      const document = new Document(
        documentId,
        fileNodeId,
        ContentId.create(randomUUID()),
        YjsStateId.create(randomUUID()),
        mimeType,
      );
      await this.documentRepo.save(document);

      await recordAuditSuccess(this.auditLogRepo, {
        actorId,
        projectId,
        action: AUDIT_FILE_CREATED,
        resourceType: 'FileNode',
        resourceId: fileNodeId.value,
        metadata: { path: newPath.value },
        context,
      }, this.logger);

      return { success: true, value: { fileNodeId, path: newPath } };
    } catch (error) {
      await this.fileStore.remove(projectId, newPath);
      throw error;
    }
  }
}
