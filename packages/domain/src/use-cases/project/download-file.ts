import { FileNode } from '../../entities/file-node';
import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { FilePath } from '../../value-objects/files/file-path';
import { ProjectRepository } from '../../ports/project/project.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { ProjectFileStore } from '../../ports/storage/project-file-store';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { CollaborationSessionRepository } from '../../ports/project/collaboration-session.repository';
import { CollaborativeContentReader } from '../../ports/storage/collaborative-content-reader';
import { Logger } from '../../ports/observability/logger';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { FileNodeNotFoundError } from '../../errors/file-tree/file-node-not-found';
import { ValidationError } from '../../errors/common/validation-error';
import { DomainError } from '../../errors/domain-error';
import { Result } from '../../types/result';
import { ResolvedWithFallback, buildResolverDeps, resolveDownloadContentSource } from './download-content-source';

/** Return value carrying the file node, its storage path, and the resolved content source. */
export interface DownloadFileResult {
  /** The resolved file node entity. */
  fileNode: FileNode;
  /** Absolute storage path used to open a read stream for the stored case. */
  filePath: FilePath;
  /** Resolved content source: live inline bytes or a signal to stream from disk. */
  source: ResolvedWithFallback;
}

/** Authorises and resolves a single-file download request for a project member. */
export class DownloadFileUseCase {
  /**
   * @param projectRepo - Resolves project entities.
   * @param fileNodeRepo - Resolves file-node entities.
   * @param projectMemberRepo - Checks project membership.
   * @param fileStore - Opens read streams for stored files.
   * @param documentRepo - Optional: detects whether the file has a collaborative document.
   * @param collaborationSessionRepo - Optional: gates the live read to active sessions.
   * @param collaborativeContentReader - Optional: reads live Yjs text from the collab server.
   * @param logger - Optional: observability sink for fallback warnings.
   */
  constructor(
    private readonly projectRepo: ProjectRepository,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly fileStore: ProjectFileStore,
    private readonly documentRepo?: DocumentRepository,
    private readonly collaborationSessionRepo?: CollaborationSessionRepository,
    private readonly collaborativeContentReader?: CollaborativeContentReader,
    private readonly logger?: Logger,
  ) {}

  /**
   * Verifies membership, resolves the file node (IDOR-guarded), and returns the path and
   * content source. Authorization runs BEFORE any live read — the reader is never called on
   * an auth failure.
   */
  async execute(
    actorId: UserId,
    projectId: ProjectId,
    fileNodeId: FileNodeId,
  ): Promise<Result<DownloadFileResult, DomainError>> {
    const membership = await this.projectMemberRepo.findByCompositeKey(projectId, actorId);
    if (!membership) {
      return { success: false, error: new PermissionDeniedError() };
    }

    const fileNode = await this.fileNodeRepo.findById(fileNodeId);
    if (!fileNode || fileNode.projectId.value !== projectId.value) {
      return { success: false, error: new FileNodeNotFoundError(fileNodeId.value) };
    }

    if (fileNode.type.value !== 'file') {
      return { success: false, error: new ValidationError('Cannot download a folder — select a file node') };
    }

    // Resolve content source strictly AFTER authorization — reader is never called on auth failure.
    const resolverDeps = buildResolverDeps(
      this.documentRepo,
      this.collaborationSessionRepo,
      this.collaborativeContentReader,
      this.logger,
    );
    const source: ResolvedWithFallback = resolverDeps
      ? await resolveDownloadContentSource(resolverDeps, projectId, fileNode, 'fallback')
      : { kind: 'stored' };

    return { success: true, value: { fileNode, filePath: fileNode.path, source } };
  }
}
