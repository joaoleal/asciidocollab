import { FileNode } from '../../entities/file-node';
import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { ProjectRepository } from '../../ports/project/project.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { CollaborationSessionRepository } from '../../ports/project/collaboration-session.repository';
import { CollaborativeContentReader } from '../../ports/storage/collaborative-content-reader';
import { Logger } from '../../ports/observability/logger';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { ProjectNotFoundError } from '../../errors/project/project-not-found';
import { DomainError } from '../../errors/domain-error';
import { Result } from '../../types/result';
import { ResolvedWithFallback, ResolveDownloadContentSourceDeps, buildResolverDeps, resolveDownloadContentSource } from './download-content-source';

/** Single file entry within the project download archive. */
export interface DownloadProjectFile {
  /** The resolved file node entity. */
  fileNode: FileNode;
  /** Path relative to the project root, with no leading slash. */
  relativePath: string;
  /** Resolved content source: live inline bytes or a signal to stream from disk. */
  source: ResolvedWithFallback;
}

/** Return value containing the project name and all its downloadable files. */
export interface DownloadProjectResult {
  /** Human-readable project name, used as the ZIP archive filename prefix. */
  projectName: string;
  /** All FILE-type nodes with their relative paths and resolved content sources. */
  files: DownloadProjectFile[];
}

/** Collects all files for a project ZIP download after verifying membership. */
export class DownloadProjectUseCase {
  /**
   * @param projectRepo - Resolves project entities.
   * @param fileNodeRepo - Resolves file-node entities.
   * @param projectMemberRepo - Checks project membership.
   * @param documentRepo - Optional: detects whether each file has a collaborative document.
   * @param collaborationSessionRepo - Optional: gates live reads to active sessions.
   * @param collaborativeContentReader - Optional: reads live Yjs text from the collab server.
   * @param logger - Optional: observability sink for fallback warnings.
   */
  constructor(
    private readonly projectRepo: ProjectRepository,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly documentRepo?: DocumentRepository,
    private readonly collaborationSessionRepo?: CollaborationSessionRepository,
    private readonly collaborativeContentReader?: CollaborativeContentReader,
    private readonly logger?: Logger,
    private readonly concurrencyCap: number = 10,
  ) {}

  /**
   * Verifies membership, fetches all FILE nodes, resolves each file's content source (live vs
   * stored), and returns them. Authorization runs before any live read; the authorized projectId is
   * always passed to the reader so no cross-tenant read can occur.
   */
  async execute(
    actorId: UserId,
    projectId: ProjectId,
  ): Promise<Result<DownloadProjectResult, DomainError>> {
    const membership = await this.projectMemberRepo.findByCompositeKey(projectId, actorId);
    if (!membership) {
      return { success: false, error: new PermissionDeniedError() };
    }

    const project = await this.projectRepo.findById(projectId);
    if (!project) {
      return { success: false, error: new ProjectNotFoundError(projectId.value) };
    }

    const allNodes = await this.fileNodeRepo.findByProjectId(projectId);
    const fileNodes = allNodes.filter((node) => node.type.value === 'file');

    const files = await this.resolveFileSources(projectId, fileNodes);

    return {
      success: true,
      value: { projectName: project.name.value, files },
    };
  }

  private async resolveFileSources(projectId: ProjectId, fileNodes: FileNode[]): Promise<DownloadProjectFile[]> {
    if (!buildResolverDeps(this.documentRepo, this.collaborationSessionRepo, this.collaborativeContentReader)) {
      const storedSource: ResolvedWithFallback = { kind: 'stored' };
      return fileNodes.map((node) => ({
        fileNode: node,
        relativePath: node.path.value.replace(/^\//, ''),
        source: storedSource,
      }));
    }
    // buildResolverDeps confirmed all three deps are present; non-null assertions are safe here.
    const documentRepo = this.documentRepo!;
    const collaborationSessionRepo = this.collaborationSessionRepo!;
    const collaborativeContentReader = this.collaborativeContentReader!;

    // Batch-fetch all documents in one query, then use an in-memory lookup per file.
    const fileNodeIds: FileNodeId[] = fileNodes.map((n) => n.id);
    const documents = await documentRepo.findByFileNodeIds(fileNodeIds);
    const documentMap = new Map(documents.map((d) => [d.fileNodeId.value, d]));

    // Batch-fetch all active session document IDs once — avoids N+1 isActive calls.
    const activeDocumentIds = await collaborationSessionRepo.findActiveDocumentIds(projectId);
    const activeSet = new Set(activeDocumentIds.map((id) => id.value));

    const resolverDeps: ResolveDownloadContentSourceDeps = {
      documentRepo: { findByFileNodeId: async (id) => documentMap.get(id.value) ?? null },
      collaborationSessionRepo: { isActive: async (_pid, documentId) => activeSet.has(documentId.value) },
      collaborativeContentReader,
      logger: this.logger,
    };

    // Process in chunks to bound peak concurrency (Redis + collab HTTP calls).
    const results: DownloadProjectFile[] = [];
    for (let index = 0; index < fileNodes.length; index += this.concurrencyCap) {
      const chunk = fileNodes.slice(index, index + this.concurrencyCap);
      const chunkResults = await Promise.all(
        chunk.map(async (node) => ({
          fileNode: node,
          relativePath: node.path.value.replace(/^\//, ''),
          source: await resolveDownloadContentSource(resolverDeps, projectId, node, 'fallback'),
        })),
      );
      results.push(...chunkResults);
    }
    return results;
  }
}
