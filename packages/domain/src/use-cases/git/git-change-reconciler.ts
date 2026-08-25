import { randomUUID } from 'crypto';
import { isThemeFilePath } from '@asciidocollab/asciidoc-core';
import { FileNode } from '../../entities/file-node';
import { Document } from '../../entities/document';
import { Asset } from '../../entities/asset';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { DocumentId } from '../../value-objects/ids/document-id';
import { ContentId } from '../../value-objects/ids/content-id';
import { YjsStateId } from '../../value-objects/ids/yjs-state-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { MimeType } from '../../value-objects/files/mime-type';
import { FileNodeType } from '../../value-objects/files/file-node-type';
import { FilePath } from '../../value-objects/files/file-path';
import { isAsciiDocumentFileName } from '../../value-objects/files/asciidoc-file-name';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { AssetRepository } from '../../ports/file-tree/asset.repository';
import { ProjectFileStore } from '../../ports/storage/project-file-store';
import { CollaborationSessionRepository } from '../../ports/project/collaboration-session.repository';
import { CollaborativeContentWriter } from '../../ports/storage/collaborative-content-writer';
import { Logger } from '../../ports/observability/logger';
import { GitMergeFileChange } from '../../ports/git/git-command-runner';
import { DomainError } from '../../errors/domain-error';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { Result } from '../../types/result';

/** What a successful reconcile hands back: every workspace-relative path it touched. */
export interface GitChangeReconcileResult {
  /** Workspace-relative POSIX paths (no leading slash) of every file this run created, changed, moved, or removed. */
  readonly changedPaths: readonly string[];
}

/**
 * Lands a clean merge's file-change-set into a project: writes the merged bytes to the file store,
 * routes content for live-edited documents through the collaborative source of truth, and reconciles
 * the project's `FileNode`/`Document`/`Asset` rows to match.
 *
 * This is a standalone domain service — the pull flow (and later branch-switch / conflict-resolution
 * landing) hand it a change-set already produced by a clean git merge and let it apply the whole set.
 * It reuses the exact per-file construction the repository-import flow uses (id minting, path
 * normalization, the AsciiDoc/theme-versus-asset classification), so a file that arrives through a
 * pull is indistinguishable from one that arrived through the original import.
 *
 * Content landing is where the collaborative source of truth matters. The file store is only a
 * projection of a live document's Yjs state: writing it directly is invisible to anyone editing the
 * file live and is silently reverted by the next Yjs writeback. So for a `modified`/`renamed` file
 * whose document currently has an OPEN collaboration room, the merged content is routed through
 * {@link CollaborativeContentWriter.replaceContent} (in addition to the projection write); a document
 * with no open room, and every asset, gets the projection write alone. Whether a room is open is read
 * once, up front, via {@link CollaborationSessionRepository.findActiveDocumentIds} — never one
 * `isActive` call per change.
 *
 * A merge change-set is expected to line up with the project's `FileNode` tree, but this service never
 * throws on drift: a pull must not half-apply and then crash. A `modified`/`renamed` change whose node
 * is missing is materialized fresh at its target (as though it were `added`); a `removed` change whose
 * node is missing is a no-op. Each such anomaly is logged and the batch continues.
 *
 * A git-sourced rename is applied exactly as received — the path/name change is reconciled directly
 * against the repositories and the store. No cross-file reference rewrite runs here: the reference
 * bodies in the merged content already came from the remote, so rewriting them locally would corrupt
 * what was pulled. (That rewrite exists only for a user-initiated rename.)
 */
export class GitChangeReconciler {
  /**
   * @param fileNodeRepo - Reads the current tree and writes created/moved/removed nodes.
   * @param documentRepo - Reads a file's document (to route live content) and writes/removes document rows.
   * @param assetRepo - Writes/removes the row for every non-document file.
   * @param fileStore - Holds the projected bytes every change writes, moves, or removes.
   * @param collaborationSessionRepo - Read once to learn which documents currently have an open room.
   * @param collaborativeContentWriter - Routes merged content into a live document's Yjs source of truth.
   * @param logger - Optional sink for drift anomalies that must stay visible without failing the batch.
   */
  constructor(
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly documentRepo: DocumentRepository,
    private readonly assetRepo: AssetRepository,
    private readonly fileStore: ProjectFileStore,
    private readonly collaborationSessionRepo: CollaborationSessionRepository,
    private readonly collaborativeContentWriter: CollaborativeContentWriter,
    private readonly logger?: Logger,
  ) {}

  /**
   * Applies every change in `changes` to the project, in order.
   *
   * @param projectId - The project the change-set lands in.
   * @param changes - The clean-merge file changes to apply.
   * @returns The workspace-relative paths touched on success; a typed failure when routing merged
   *   content into a live document could not be delivered.
   */
  async apply(
    projectId: ProjectId,
    changes: readonly GitMergeFileChange[],
  ): Promise<Result<GitChangeReconcileResult, DomainError>> {
    // A single working view of the tree, keyed by leading-slash absolute path, kept current as the
    // batch proceeds so a folder created for an early `added` is visible to a later change.
    const nodesByPath = new Map<string, FileNode>();
    for (const node of await this.fileNodeRepo.findByProjectId(projectId)) {
      nodesByPath.set(node.path.value, node);
    }

    // Which documents currently have an open collaboration room — read once, not per change.
    const activeDocIds = new Set(
      (await this.collaborationSessionRepo.findActiveDocumentIds(projectId)).map((id) => id.value),
    );

    const changedPaths: string[] = [];

    for (const change of changes) {
      switch (change.type) {
        case 'added': {
          await this.materializeFile(projectId, change.path, change.content, change.mimeType, nodesByPath);
          changedPaths.push(change.path);
          break;
        }
        case 'modified': {
          const node = nodesByPath.get(toAbsolute(change.path));
          if (!node) {
            this.logger?.warn('Pulled a change to a file with no matching node; treating it as a new file', {
              path: change.path,
              change: 'modified',
            });
            await this.materializeFile(projectId, change.path, change.content, change.mimeType, nodesByPath);
          } else {
            const landed = await this.landContent(projectId, node, change.content, activeDocIds);
            if (!landed.success) return landed;
          }
          changedPaths.push(change.path);
          break;
        }
        case 'removed': {
          const node = nodesByPath.get(toAbsolute(change.path));
          if (!node) {
            this.logger?.warn('Pulled a removal for a file with no matching node; nothing to remove', {
              path: change.path,
              change: 'removed',
            });
            break;
          }
          await this.removeFile(projectId, node, nodesByPath);
          changedPaths.push(change.path);
          break;
        }
        case 'renamed': {
          const node = nodesByPath.get(toAbsolute(change.fromPath));
          if (!node) {
            this.logger?.warn('Pulled a rename whose source file has no matching node; treating it as a new file', {
              fromPath: change.fromPath,
              toPath: change.toPath,
              change: 'renamed',
            });
            await this.materializeFile(projectId, change.toPath, change.content, change.mimeType, nodesByPath);
          } else {
            const landed = await this.applyRename(projectId, node, change, activeDocIds, nodesByPath);
            if (!landed.success) return landed;
          }
          changedPaths.push(change.toPath);
          break;
        }
      }
    }

    return { success: true, value: { changedPaths } };
  }

  /**
   * Creates a fresh `FileNode` (and, on demand, its parent folder chain) for the file at `path`,
   * writes its bytes, and records it as a `Document` or an `Asset` by the same rule the import flow
   * uses. Serves both `added` changes and the drift fallback for a `modified`/`renamed` change whose
   * node is missing.
   */
  private async materializeFile(
    projectId: ProjectId,
    path: string,
    content: Buffer,
    mimeType: string,
    nodesByPath: Map<string, FileNode>,
  ): Promise<void> {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    const fileName = segments[segments.length - 1];
    const parentId = await this.ensureFolder(projectId, segments.slice(0, -1), nodesByPath);

    const fileNodeId = FileNodeId.create(randomUUID());
    const filePath = FilePath.create(`/${segments.join('/')}`);
    const node = new FileNode(fileNodeId, projectId, parentId, fileName, FileNodeType.create('file'), filePath);
    await this.fileNodeRepo.save(node);
    nodesByPath.set(filePath.value, node);

    await this.fileStore.write(projectId, filePath, content);

    const mime = MimeType.create(mimeType);
    // A pulled AsciiDoc or theme file becomes a co-editable Document; everything else an opaque Asset —
    // the same classification the import flow applies to a cloned file.
    if (isAsciiDocumentFileName(fileName) || isThemeFilePath(path)) {
      await this.documentRepo.save(
        new Document(DocumentId.create(randomUUID()), fileNodeId, ContentId.create(randomUUID()), YjsStateId.create(randomUUID()), mime),
      );
    } else {
      // Asset.id == FileNode.id (1:1 FK relationship).
      await this.assetRepo.save(new Asset(fileNodeId, mime, BigInt(content.length)));
    }
  }

  /**
   * Writes merged content for an existing file: always to the file store, and — for a document whose
   * room is currently open — into the collaborative source of truth so open editors see it and it
   * survives the next writeback. A dormant document or an asset gets the projection write alone.
   */
  private async landContent(
    projectId: ProjectId,
    node: FileNode,
    content: Buffer,
    activeDocIds: Set<string>,
  ): Promise<Result<void, DomainError>> {
    await this.fileStore.write(projectId, node.path, content);

    const document = await this.documentRepo.findByFileNodeId(node.id);
    if (document && activeDocIds.has(document.id.value)) {
      const written = await this.collaborativeContentWriter.replaceContent(
        projectId,
        document.yjsStateId,
        content.toString('utf8'),
      );
      if (!written.success) {
        return { success: false, error: new GitCommandFailedError(written.error.message) };
      }
    }

    return { success: true, value: undefined };
  }

  /**
   * Applies a rename to an existing node: re-saves it (SAME id) at the destination path and name,
   * moves its stored bytes, then lands the merged content exactly as `modified` does. The repository's
   * own `move` only reparents, so the path/name change is applied by re-saving the entity.
   */
  private async applyRename(
    projectId: ProjectId,
    node: FileNode,
    change: Extract<GitMergeFileChange, { type: 'renamed' }>,
    activeDocIds: Set<string>,
    nodesByPath: Map<string, FileNode>,
  ): Promise<Result<void, DomainError>> {
    const segments = change.toPath.split('/').filter((segment) => segment.length > 0);
    const newName = segments[segments.length - 1];
    const parentId = await this.ensureFolder(projectId, segments.slice(0, -1), nodesByPath);
    const newPath = FilePath.create(`/${segments.join('/')}`);

    const movedNode = new FileNode(node.id, projectId, parentId, newName, node.type, newPath);
    await this.fileNodeRepo.save(movedNode);
    nodesByPath.delete(node.path.value);
    nodesByPath.set(newPath.value, movedNode);

    const moved = await this.fileStore.move(projectId, node.path, newPath);
    if (!moved.success) return moved;

    return this.landContent(projectId, movedNode, change.content, activeDocIds);
  }

  /** Removes an existing file: its document/asset row, its node, and its stored bytes. */
  private async removeFile(projectId: ProjectId, node: FileNode, nodesByPath: Map<string, FileNode>): Promise<void> {
    const document = await this.documentRepo.findByFileNodeId(node.id);
    if (document) await this.documentRepo.delete(document.id);
    // Safe when the node was never an asset — a delete of a missing row is a no-op.
    await this.assetRepo.delete(node.id);
    await this.fileNodeRepo.delete(node.id);
    await this.fileStore.remove(projectId, node.path);
    nodesByPath.delete(node.path.value);
  }

  /**
   * Returns the id of the folder at `segments` under the project root, creating it — and every
   * ancestor it needs — on demand, and recording each created folder in the working view. Empty
   * `segments` resolves to the project root folder (path `/`), which always already exists.
   */
  private async ensureFolder(
    projectId: ProjectId,
    segments: readonly string[],
    nodesByPath: Map<string, FileNode>,
  ): Promise<FileNodeId> {
    const path = `/${segments.join('/')}`;
    const existing = nodesByPath.get(path);
    if (existing) return existing.id;

    const parentId = await this.ensureFolder(projectId, segments.slice(0, -1), nodesByPath);
    const folderId = FileNodeId.create(randomUUID());
    const name = segments[segments.length - 1];
    const filePath = FilePath.create(path);
    const folder = new FileNode(folderId, projectId, parentId, name, FileNodeType.create('folder'), filePath);
    await this.fileNodeRepo.save(folder);
    nodesByPath.set(path, folder);
    return folderId;
  }
}

/** Turns a workspace-relative git path (no leading slash) into the leading-slash key the tree uses. */
function toAbsolute(path: string): string {
  return `/${path}`;
}
