import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { FilePath } from '../../value-objects/files/file-path';
import { MimeType } from '../../value-objects/files/mime-type';
import { FileNodeType } from '../../value-objects/files/file-node-type';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { AssetRepository } from '../../ports/file-tree/asset.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { SystemSettingRepository } from '../../ports/admin/system-setting.repository';
import { ProjectFileStore } from '../../ports/storage/project-file-store';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { FileNodeNotFoundError } from '../../errors/file-tree/file-node-not-found';
import { ValidationError } from '../../errors/common/validation-error';
import { DomainError } from '../../errors/domain-error';
import { Result } from '../../types/result';
import { FileNode } from '../../entities/file-node';
import { Asset } from '../../entities/asset';
import { Document } from '../../entities/document';
import { ContentId } from '../../value-objects/ids/content-id';
import { YjsStateId } from '../../value-objects/ids/yjs-state-id';
import { DocumentId } from '../../value-objects/ids/document-id';
import { isThemeFilePath } from '@asciidocollab/asciidoc-core';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { RequestContext } from '../../types/request-context';
import { Logger } from '../../ports/observability/logger';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_FILE_UPLOADED } from '../../audit-actions';
import { SETTING_MAX_UPLOAD_SIZE_BYTES } from '../../constants';
import { randomUUID } from 'crypto';

/** Saves an uploaded file asset and persists its metadata. */
export class UploadAssetUseCase {
  private static readonly ALLOWED_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/bmp',
    'image/tiff',
    'application/pdf',
    'application/octet-stream',
    'text/plain',
    'text/csv',
  ]);
  /** Initializes the use case with the repositories and file store required to store and record an asset. */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly assetRepo: AssetRepository,
    private readonly documentRepo: DocumentRepository,
    private readonly fileStore: ProjectFileStore,
    private readonly systemSettingRepo: SystemSettingRepository,
    private readonly defaultMaxUploadSizeBytes: number,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /** Validates membership and file size, stores the bytes on disk, and creates the file node and asset metadata records. */
  async execute(
    actorId: UserId,
    projectId: ProjectId,
    parentId: FileNodeId,
    filename: string,
    mimeType: MimeType,
    bytes: Buffer,
    context?: RequestContext,
  ): Promise<Result<{ fileNodeId: FileNodeId; storagePath: string }, DomainError>> {
    // Uploading an asset adds a file to the project, so it requires write access
    // (editor or owner). A viewer — including every member of a read-only shared
    // project such as the bundled demo — is denied here.
    const member = await this.projectMemberRepo.findByCompositeKey(projectId, actorId);
    const role = member?.role.value;
    if (role !== 'owner' && role !== 'editor') {
      return { success: false, error: new PermissionDeniedError() };
    }

    if (!UploadAssetUseCase.ALLOWED_MIME_TYPES.has(mimeType.value)) {
      return { success: false, error: new ValidationError(`MIME type '${mimeType.value}' is not permitted`) };
    }

    const stored = await this.systemSettingRepo.get(SETTING_MAX_UPLOAD_SIZE_BYTES);
    const parsed = stored === null ? Number.NaN : Number(stored);
    const effectiveLimit = Number.isNaN(parsed) || parsed <= 0 ? this.defaultMaxUploadSizeBytes : parsed;

    if (bytes.length > effectiveLimit) {
      return { success: false, error: new ValidationError('File exceeds maximum permitted size') };
    }

    const parent = await this.fileNodeRepo.findById(parentId);
    if (!parent || parent.type.value !== 'folder' || parent.projectId.value !== projectId.value) {
      return { success: false, error: new FileNodeNotFoundError(parentId.value) };
    }

    const parentPath = parent.path.value === '/' ? '/' : `${parent.path.value}/`;
    const storagePath = `${parentPath}${filename}`;
    const filePath = FilePath.create(storagePath);

    const storeResult = await this.fileStore.createExclusive(projectId, filePath, bytes);
    if (!storeResult.success) {
      return { success: false, error: storeResult.error };
    }

    try {
      const fileNodeId = FileNodeId.create(randomUUID());
      const fileNode = new FileNode(fileNodeId, projectId, parentId, filename, FileNodeType.create('file'), filePath);
      await this.fileNodeRepo.save(fileNode);

      // A theme is an editable text file, not an opaque blob: it must arrive with the Yjs state that
      // makes it co-editable, exactly as if it had been created in the tree. Recorded as an asset it
      // would have none, and the editor would silently fall back to its read-only path — so the file
      // the theme editor exists to serve would be the one file it could not collaboratively edit.
      if (isThemeFilePath(filename)) {
        const document = new Document(
          DocumentId.create(randomUUID()),
          fileNodeId,
          ContentId.create(randomUUID()),
          YjsStateId.create(randomUUID()),
          mimeType,
        );
        await this.documentRepo.save(document);
      } else {
        // Asset.id == FileNode.id (1:1 FK relationship)
        const asset = new Asset(fileNodeId, mimeType, BigInt(bytes.length));
        await this.assetRepo.save(asset);
      }

      await recordAuditSuccess(
        this.auditLogRepo,
        {
          actorId,
          projectId,
          action: AUDIT_FILE_UPLOADED,
          resourceType: 'FileNode',
          resourceId: fileNodeId.value,
          metadata: { path: storagePath, sizeBytes: bytes.length },
          context,
        },
        this.logger,
      );

      return { success: true, value: { fileNodeId, storagePath } };
    } catch (error) {
      await this.fileStore.remove(projectId, filePath);
      throw error;
    }
  }
}
