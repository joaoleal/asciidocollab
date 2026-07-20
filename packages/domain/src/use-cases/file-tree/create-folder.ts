import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { FilePath } from '../../value-objects/files/file-path';
import { FileName } from '../../value-objects/files/file-name';
import { FileNodeType } from '../../value-objects/files/file-node-type';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { ProjectFileStore } from '../../ports/storage/project-file-store';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { buildParentPath } from './file-tree-helpers';
import { FileNodeNotFoundError } from '../../errors/file-tree/file-node-not-found';
import { FileConflictError } from '../../errors/file-tree/file-conflict';
import { DomainError } from '../../errors/domain-error';
import { Result } from '../../types/result';
import { FileNode } from '../../entities/file-node';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { RequestContext } from '../../types/request-context';
import { recordAuthorizationDenial, recordAuditSuccess } from '../audit-recording';
import { AUDIT_FOLDER_CREATED } from '../../audit-actions';
import { randomUUID } from 'crypto';

/** Creates a new folder node in the file tree and its directory on disk. */
export class CreateFolderUseCase {
  /** Initializes the use case with the repositories and file store required to create a folder. */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly fileStore: ProjectFileStore,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /** Validates membership, creates the directory on disk and the folder node in the database. */
  async execute(
    actorId: UserId,
    projectId: ProjectId,
    parentId: FileNodeId,
    name: string,
    context?: RequestContext,
  ): Promise<Result<{ fileNodeId: FileNodeId; path: FilePath }, DomainError>> {
    // Creating a folder mutates the project's structure, so it requires write
    // access (editor or owner). A viewer — including every member of a read-only
    // shared project such as the bundled demo — is denied here.
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

    const siblings = await this.fileNodeRepo.findByParentId(parentId);
    const duplicate = siblings.find((n) => n.name === name && n.type.value === 'folder');
    if (duplicate) {
      return { success: false, error: new FileConflictError(`Folder '${name}' already exists`, duplicate.id.value) };
    }

    FileName.create(name); // throws ValidationError for invalid names
    const parentPath = buildParentPath(parent.path.value);
    const newPath = FilePath.create(`${parentPath}${name}`);

    await this.fileStore.createDirectory(projectId, newPath);

    const fileNodeId = FileNodeId.create(randomUUID());
    const fileNode = new FileNode(fileNodeId, projectId, parentId, name, FileNodeType.create('folder'), newPath);
    await this.fileNodeRepo.save(fileNode);

    await recordAuditSuccess(this.auditLogRepo, {
      actorId,
      projectId,
      action: AUDIT_FOLDER_CREATED,
      resourceType: 'FileNode',
      resourceId: fileNodeId.value,
      metadata: { path: newPath.value },
      context,
    }, this.logger);

    return { success: true, value: { fileNodeId, path: newPath } };
  }
}
