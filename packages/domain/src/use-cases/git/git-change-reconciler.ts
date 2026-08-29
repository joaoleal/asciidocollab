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

/**
 * How the reconciler responded to a merge change that did not line up with the project's `FileNode`
 * tree. Most values still land the pulled content (materialized fresh, or written into the node
 * already at the path) or are a benign no-op. The exceptions carry `applied: false`: they all DROP
 * the pulled bytes — nothing is written to disk — because no file could safely hold them.
 * `content_dropped_folder_occupies_path` and `content_dropped_file_occupies_ancestor_path` drop the
 * change because a folder sits on the leaf path, or a file sits on an ancestor path;
 * `content_dropped_binary_open_document` drops it because the target path is held by a document open
 * in the editor and the room's next writeback would clobber whatever was written there — the user
 * must close the document to recover the content.
 *
 * `removed_path_occupied_by_folder` is BENIGN and audit-only (`applied: true`), exactly like
 * `removed_missing_node`: a pulled removal targeted a path where a FOLDER (with children) sits locally,
 * so the removal was skipped rather than deleting the folder and everything under it. NOTHING is lost —
 * the local folder and its contents are preserved intact; the upstream removal simply could not be
 * propagated. Because it is `applied: true`, `buildGitDriftSummary` leaves `droppedCount` at 0 and
 * surfaces no user-facing "dropped/recover" warning for an otherwise-lossless pull.
 */
export type GitReconcileAnomalyKind =
  | 'added_path_occupied'
  | 'modified_missing_node'
  | 'removed_missing_node'
  | 'removed_path_occupied_by_folder'
  | 'renamed_source_missing_dest_exists'
  | 'renamed_source_missing'
  | 'content_dropped_folder_occupies_path'
  | 'content_dropped_file_occupies_ancestor_path'
  | 'content_dropped_binary_open_document';

/**
 * One drift anomaly the reconciler hit while landing a merge. Reported (not only logged) so the pull
 * flow can persist it to the audit log and surface a count to the user, who otherwise has no way to
 * know a pulled change was auto-repaired or — for the collision/drop cases — dropped.
 */
export interface GitReconcileAnomaly {
  /** Workspace-relative POSIX path (no leading slash) the anomaly concerns; the destination for a rename. */
  readonly path: string;
  /** Which drift was hit and how it was handled. */
  readonly kind: GitReconcileAnomalyKind;
  /**
   * Whether the pulled content survived. `true` for every kind that landed the content or was a
   * benign no-op; `false` for the three drop kinds (`content_dropped_folder_occupies_path`,
   * `content_dropped_file_occupies_ancestor_path`, `content_dropped_binary_open_document`), where
   * nothing was written to disk and the user must resolve the obstruction (a folder/file collision, or
   * closing the document open in the editor) to recover the content.
   */
  readonly applied: boolean;
  /** A user-readable sentence describing what happened and what, if anything, was lost. */
  readonly message: string;
}

/**
 * Shapes reconciler anomalies for an audit-log `metadata` field: the total, a dropped-change count,
 * and the per-anomaly list (path, kind, whether the content survived, and the user-readable message).
 * Returns an empty object when there were none, so a caller can spread it into an existing metadata
 * object and add nothing on a clean apply. Centralized so every git use case that lands a change-set
 * records drift the same way.
 */
export function anomalyAuditMetadata(anomalies: readonly GitReconcileAnomaly[]): Record<string, unknown> {
  if (anomalies.length === 0) return {};
  return {
    total: anomalies.length,
    droppedCount: anomalies.filter((anomaly) => !anomaly.applied).length,
    anomalies: anomalies.map((anomaly) => ({
      path: anomaly.path,
      kind: anomaly.kind,
      applied: anomaly.applied,
      message: anomaly.message,
    })),
  };
}

/** What a successful reconcile hands back: every workspace-relative path it touched, and any drift anomalies. */
export interface GitChangeReconcileResult {
  /** Workspace-relative POSIX paths (no leading slash) of every file this run created, changed, moved, or removed. */
  readonly changedPaths: readonly string[];
  /**
   * Drift anomalies surfaced while landing the change-set, in the order they occurred. Empty on a
   * clean apply. Each is also logged; reporting them here lets the pull flow record them to the audit
   * log and surface a count to the user.
   */
  readonly anomalies: readonly GitReconcileAnomaly[];
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
 * what was pulled — that rewrite exists only for a user-initiated rename.
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
    const activeDocumentIdList = await this.collaborationSessionRepo.findActiveDocumentIds(projectId);
    const activeDocumentIds = new Set(activeDocumentIdList.map((id) => id.value));

    const changedPaths: string[] = [];
    const anomalies: GitReconcileAnomaly[] = [];

    for (const change of changes) {
      switch (change.type) {
        case 'added': {
          // Normally the path is new, but under FileNode/working-tree drift a node may already exist
          // there (e.g. a prior local add landed it). Land into that node rather than mint a duplicate
          // at the same path — the same destination-occupied guard the modified/renamed branches apply.
          const existing = nodesByPath.get(toAbsolute(change.path));
          if (existing) {
            // `landContent` is the single source of truth for the destination-occupied outcome: it
            // writes the bytes into an existing FILE (returning true), or — when a FOLDER occupies the
            // path, or the file is an OPEN collaborative document taking BINARY content — drops the
            // bytes and records the one accurate `applied: false` anomaly (returning false). Push
            // the optimistic "updated in place" `added_path_occupied` anomaly ONLY when the content was
            // actually applied; pushing it up front would double-count a dropped change and
            // pair it with a second, contradictory `applied` flag while the bytes never landed.
            const landed = await this.landContent(projectId, existing, change.content, activeDocumentIds, anomalies);
            if (!landed.success) return landed;
            if (landed.value) {
              this.logger?.warn('Pulled an added change for a path that already has a file node; updating it', {
                path: change.path,
                change: 'added',
              });
              anomalies.push({
                path: change.path,
                kind: 'added_path_occupied',
                applied: true,
                message: `Pulled a new file "${change.path}", but that path already existed here; its content was updated in place.`,
              });
              changedPaths.push(change.path);
            }
          } else {
            const created = await this.materializeFile(projectId, change.path, change.content, change.mimeType, nodesByPath, anomalies);
            if (created) changedPaths.push(change.path);
          }
          break;
        }
        case 'modified': {
          const node = nodesByPath.get(toAbsolute(change.path));
          if (node) {
            const landed = await this.landContent(projectId, node, change.content, activeDocumentIds, anomalies);
            if (!landed.success) return landed;
            if (landed.value) changedPaths.push(change.path);
          } else {
            // The materialize can be dropped by an ancestor file/folder collision (it records its own
            // applied:false anomaly); only when it actually created the file is this a "created a new
            // file" repair, so the modified_missing_node anomaly is pushed on that outcome alone —
            // never paired with a contradictory collision anomaly for the same change.
            const created = await this.materializeFile(projectId, change.path, change.content, change.mimeType, nodesByPath, anomalies);
            if (created) {
              this.logger?.warn('Pulled a change to a file with no matching node; treating it as a new file', {
                path: change.path,
                change: 'modified',
              });
              anomalies.push({
                path: change.path,
                kind: 'modified_missing_node',
                applied: true,
                message: `Pulled a change to "${change.path}", which did not exist here; it was created as a new file.`,
              });
              changedPaths.push(change.path);
            }
          }
          break;
        }
        case 'removed': {
          const node = nodesByPath.get(toAbsolute(change.path));
          if (!node) {
            this.logger?.warn('Pulled a removal for a file with no matching node; nothing to remove', {
              path: change.path,
              change: 'removed',
            });
            anomalies.push({
              path: change.path,
              kind: 'removed_missing_node',
              applied: true,
              message: `Pulled a removal of "${change.path}", which was already gone here; nothing to remove.`,
            });
            break;
          }
          const removed = await this.removeFile(projectId, node, nodesByPath, anomalies);
          if (removed) changedPaths.push(change.path);
          break;
        }
        case 'renamed': {
          const node = nodesByPath.get(toAbsolute(change.fromPath));
          if (node) {
            const landed = await this.applyRename(projectId, node, change, activeDocumentIds, nodesByPath, anomalies);
            if (!landed.success) return landed;
            if (landed.value) changedPaths.push(change.toPath);
          } else {
            // The source node is gone (drift). The missing-source check keys on fromPath, but a node
            // may already exist at toPath (e.g. a prior local rename/add landed the destination) — so
            // materializing unconditionally would mint a SECOND FileNode at the same path. When the
            // destination is already occupied, land the content into that node instead of creating a
            // duplicate; only materialize when toPath is genuinely empty.
            const existingAtDestination = nodesByPath.get(toAbsolute(change.toPath));
            if (existingAtDestination) {
              // `landContent` is the single source of truth for the destination-occupied outcome: it
              // writes the bytes into an existing FILE (returning true), or — when a FOLDER occupies the
              // destination, or the file is an OPEN collaborative document taking BINARY content —
              // drops the bytes and records the one accurate `applied: false` anomaly (returning
              // false). Push the optimistic "updated in place" `renamed_source_missing_dest_exists`
              // anomaly ONLY when the content was actually applied; pushing it up front would
              // double-count a dropped change and pair it with a second, contradictory
              // `applied` flag while the bytes never landed.
              const landed = await this.landContent(projectId, existingAtDestination, change.content, activeDocumentIds, anomalies);
              if (!landed.success) return landed;
              if (landed.value) {
                this.logger?.warn('Pulled a rename whose source has no node but whose destination exists; updating it', {
                  fromPath: change.fromPath,
                  toPath: change.toPath,
                  change: 'renamed',
                });
                anomalies.push({
                  path: change.toPath,
                  kind: 'renamed_source_missing_dest_exists',
                  applied: true,
                  message: `Pulled a rename to "${change.toPath}", whose original was missing but whose destination already existed; its content was updated in place.`,
                });
                changedPaths.push(change.toPath);
              }
            } else {
              // As with the modified-missing branch, an ancestor collision can drop the materialize
              // (recording its own applied:false anomaly); push the renamed_source_missing repair only
              // when the file was actually created, so the change is never double-counted.
              const created = await this.materializeFile(projectId, change.toPath, change.content, change.mimeType, nodesByPath, anomalies);
              if (created) {
                this.logger?.warn('Pulled a rename whose source file has no matching node; treating it as a new file', {
                  fromPath: change.fromPath,
                  toPath: change.toPath,
                  change: 'renamed',
                });
                anomalies.push({
                  path: change.toPath,
                  kind: 'renamed_source_missing',
                  applied: true,
                  message: `Pulled a rename of "${change.fromPath}", which did not exist here; "${change.toPath}" was created as a new file.`,
                });
                changedPaths.push(change.toPath);
              }
            }
          }
          break;
        }
      }
    }

    return { success: true, value: { changedPaths, anomalies } };
  }

  /**
   * Creates a fresh `FileNode` (and, on demand, its parent folder chain) for the file at `path`,
   * writes its bytes, and records it as a `Document` or an `Asset` by the same rule the import flow
   * uses. Serves both `added` changes and the drift fallback for a `modified`/`renamed` change whose
   * node is missing.
   *
   * @returns `true` when the file was created; `false` when it was dropped because a file node
   *   occupies one of its ancestor paths (drift) — {@link ensureFolder} has already recorded the one
   *   accurate `content_dropped_file_occupies_ancestor_path` anomaly, so the caller must add none.
   */
  private async materializeFile(
    projectId: ProjectId,
    path: string,
    content: Buffer,
    mimeType: string,
    nodesByPath: Map<string, FileNode>,
    anomalies: GitReconcileAnomaly[],
  ): Promise<boolean> {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    const fileName = segments.at(-1)!;
    const parentId = await this.ensureFolder(projectId, segments.slice(0, -1), nodesByPath, anomalies, path);
    if (parentId === null) return false;

    const fileNodeId = FileNodeId.create(randomUUID());
    const filePath = FilePath.create(`/${segments.join('/')}`);
    const node = new FileNode(fileNodeId, projectId, parentId, fileName, FileNodeType.create('file'), filePath);
    await this.fileNodeRepo.save(node);
    nodesByPath.set(filePath.value, node);

    await this.fileStore.write(projectId, filePath, content);

    const mime = MimeType.create(mimeType);
    // A pulled AsciiDoc or theme file becomes a co-editable Document; everything else an opaque Asset
    // (Asset.id == FileNode.id, a 1:1 FK relationship) — the same classification the import flow
    // applies to a cloned file.
    await (isAsciiDocumentFileName(fileName) || isThemeFilePath(path)
      ? this.documentRepo.save(
          new Document(DocumentId.create(randomUUID()), fileNodeId, ContentId.create(randomUUID()), YjsStateId.create(randomUUID()), mime),
        )
      : this.assetRepo.save(new Asset(fileNodeId, mime, BigInt(content.length))));
    return true;
  }

  /**
   * Writes merged content for an existing file: to the file store, and — for a document whose room is
   * currently open — also into the collaborative source of truth so open editors see it and it
   * survives the next writeback. A dormant document or an asset gets the projection write alone.
   *
   * Binary content targeting a path held by an OPEN document is the one case that writes NOTHING: the
   * room's own writeback owns that file and would clobber any bytes landed here on its next save, and
   * there is no mechanism that re-applies them once the room closes — so writing them would be a
   * pointless, misleading no-op. The change is dropped instead, with an actionable anomaly.
   *
   * @returns `true` when the content was landed; `false` when it was dropped — a folder occupies the
   *   path, or binary content targets a path an open document holds. The caller uses this to keep a
   *   dropped path out of `changedPaths`, which must list only files that actually changed.
   */
  private async landContent(
    projectId: ProjectId,
    node: FileNode,
    content: Buffer,
    activeDocumentIds: Set<string>,
    anomalies: GitReconcileAnomaly[],
  ): Promise<Result<boolean, DomainError>> {
    const gitPath = node.path.value.replace(/^\/+/, '');
    if (node.type.value !== 'file') {
      // Drift: a folder occupies the path a content change targets. Writing file bytes onto a folder
      // path would corrupt the tree, so skip the landing and warn rather than overwrite it — the same
      // never-throw-on-drift posture the missing-node branches take. Unlike those, this DROPS the
      // pulled bytes (they have nowhere safe to land), so it is reported with `applied: false`.
      this.logger?.warn('Pulled content targets a path held by a non-file node; skipping to avoid corrupting the tree', {
        path: node.path.value,
      });
      anomalies.push({
        path: gitPath,
        kind: 'content_dropped_folder_occupies_path',
        applied: false,
        message: `Pulled content for "${gitPath}" could not be applied because a folder occupies that path; the change was dropped. Remove or rename the folder to recover the change.`,
      });
      return { success: true, value: false };
    }

    // Read the file's Document row ONCE: reused below both to decide the binary-into-open-document
    // drop and — when the change lands — to decide whether the content also routes through the
    // collaborative writer. A second, identical findByFileNodeId for the same node is exactly the
    // redundant read this single fetch exists to avoid.
    const document = await this.documentRepo.findByFileNodeId(node.id);

    if (this.wouldDropBinaryIntoOpenDocument(node.name, gitPath, document, activeDocumentIds)) {
      // Binary content cannot land in a path held by an OPEN live document: the room owns that file and
      // its next writeback would clobber any bytes written here, and nothing re-applies them once the
      // room closes. DROP the change — write nothing — and tell the user how to recover it.
      this.recordBinaryOpenDocumentDrop(anomalies, gitPath);
      return { success: true, value: false };
    }

    // Reached only when the change WILL apply: the projection write lands the bytes.
    await this.fileStore.write(projectId, node.path, content);

    if (document && activeDocumentIds.has(document.id.value)) {
      // Guaranteed editable text here (the binary case returned above).
      const written = await this.collaborativeContentWriter.replaceContent(
        projectId,
        document.yjsStateId,
        content.toString('utf8'),
      );
      if (!written.success) {
        return { success: false, error: new GitCommandFailedError(written.error.message) };
      }
    }

    return { success: true, value: true };
  }

  /**
   * Whether landing content at the file classified by the given `fileName` and workspace-relative
   * `gitPath` would be DROPPED as `content_dropped_binary_open_document`: `document` (the file's
   * Document row, already looked up by the caller — `null` when it has none) is in an OPEN
   * collaboration room AND the content is not co-editable text by the reconciler's name-based rule
   * (`isAsciiDocumentFileName || isThemeFilePath`). The single source of truth for that outcome, so
   * {@link landContent} and the `renamed` branch decide it identically.
   *
   * Takes the already-fetched `document` rather than a `fileNodeId` to look up itself: the caller reads
   * the Document row once and reuses it (in `landContent`, also for deciding whether to route content
   * through the collaborative writer), rather than this predicate re-reading it internally on every
   * call. For a rename, the caller passes the row fetched for the SOURCE node's id evaluated against the
   * DESTINATION's name/path, because {@link reconcileRowClassification} KEEPS the source's live Document
   * row in place at the destination — that kept row is the "open document at the destination"; it does
   * not assume a Document already exists there under a different id.
   */
  private wouldDropBinaryIntoOpenDocument(
    fileName: string,
    gitPath: string,
    document: Document | null,
    activeDocumentIds: Set<string>,
  ): boolean {
    // Only co-editable TEXT may be pushed into an open collaboration room. A demoting rename into an
    // open room (e.g. notes.adoc → logo.png) keeps the live Document row intact (see
    // reconcileRowClassification), so without this guard binary bytes would be decoded as UTF-8 and
    // written into every connected editor — mojibake. Classify text-vs-binary the SAME way the
    // reconciler tells a Document from an Asset: by name.
    const isEditableText = isAsciiDocumentFileName(fileName) || isThemeFilePath(gitPath);
    if (isEditableText) return false;
    return document !== null && activeDocumentIds.has(document.id.value);
  }

  /** Logs and records the one truthful `content_dropped_binary_open_document` anomaly for `gitPath`. */
  private recordBinaryOpenDocumentDrop(anomalies: GitReconcileAnomaly[], gitPath: string): void {
    this.logger?.warn('Pulled binary content targets an open collaborative document; dropping rather than writing bytes the room would clobber', {
      path: gitPath,
    });
    anomalies.push({
      path: gitPath,
      kind: 'content_dropped_binary_open_document',
      applied: false,
      message: `Pulled binary content for "${gitPath}" could not be applied because a document is open in the editor at that path; the change was dropped. Close the document to recover the content.`,
    });
  }

  /**
   * Applies a rename to an existing node: re-saves it (SAME id) at the destination path and name,
   * moves its stored bytes, then lands the merged content exactly as `modified` does. The repository's
   * own `move` only reparents, so the path/name change is applied by re-saving the entity.
   *
   * A demoting rename into an OPEN room (e.g. notes.adoc → logo.png with binary content) is decided
   * UP FRONT: because {@link reconcileRowClassification} keeps the source's live Document row at the
   * destination, {@link landContent} would drop the binary content there — but only after the node was
   * already re-saved and its bytes already moved, leaving the mutated tree disagreeing with an
   * `applied: false` result. So when the destination would drop, the rename is skipped WHOLE — nothing
   * is re-saved, moved, or reclassified — and the one truthful drop anomaly is recorded instead.
   */
  private async applyRename(
    projectId: ProjectId,
    node: FileNode,
    change: Extract<GitMergeFileChange, { type: 'renamed' }>,
    activeDocumentIds: Set<string>,
    nodesByPath: Map<string, FileNode>,
    anomalies: GitReconcileAnomaly[],
  ): Promise<Result<boolean, DomainError>> {
    const segments = change.toPath.split('/').filter((segment) => segment.length > 0);
    const newName = segments.at(-1)!;

    // Decide the binary-into-open-document drop BEFORE mutating anything (before ensureFolder can even
    // create a parent folder). Read this node's Document row because reconcileRowClassification KEEPS
    // its live Document row at the destination. If it would drop, skip the rename entirely so the
    // persisted tree and the reported result cannot disagree.
    const sourceDocument = await this.documentRepo.findByFileNodeId(node.id);
    if (this.wouldDropBinaryIntoOpenDocument(newName, change.toPath, sourceDocument, activeDocumentIds)) {
      this.recordBinaryOpenDocumentDrop(anomalies, change.toPath);
      return { success: true, value: false };
    }

    const parentId = await this.ensureFolder(projectId, segments.slice(0, -1), nodesByPath, anomalies, change.toPath);
    // A file node on an ancestor of the destination cannot hold a child; ensureFolder has recorded the
    // one accurate applied:false collision anomaly, so drop the rename before mutating anything.
    if (parentId === null) return { success: true, value: false };
    const newPath = FilePath.create(`/${segments.join('/')}`);

    const movedNode = new FileNode(node.id, projectId, parentId, newName, node.type, newPath);
    await this.fileNodeRepo.save(movedNode);
    nodesByPath.delete(node.path.value);
    nodesByPath.set(newPath.value, movedNode);

    const moved = await this.fileStore.move(projectId, node.path, newPath);
    if (!moved.success) return moved;

    // A rename can change the classifying name (notes.txt → notes.adoc, or the reverse), which flips
    // whether the file is a co-editable Document or an opaque Asset. The node keeps its id but its row
    // type must follow the new name — otherwise a pulled .adoc stays a non-editable Asset (or a .png
    // keeps a stale Document), unlike the same file arriving through import/materialize.
    await this.reconcileRowClassification(newName, change.toPath, node.id, change.content, change.mimeType, activeDocumentIds);

    return this.landContent(projectId, movedNode, change.content, activeDocumentIds, anomalies);
  }

  /**
   * Ensures the file node's persistence row matches what its (possibly renamed) name now classifies
   * as: a co-editable `Document` for an AsciiDoc/theme file, an opaque `Asset` otherwise — the same
   * rule {@link materializeFile} applies. Swaps the row only when the classification actually changed,
   * so a same-category rename touches nothing.
   *
   * When a rename would demote a Document whose collaboration room is currently open, the demotion is
   * skipped: deleting the live row would orphan the open editors — the follow-up {@link landContent}
   * would find no document, skip the collaborative write, and the next Yjs writeback would target a
   * deleted row. The live Document row is kept intact — so co-editable text content still lands into
   * the open room, while binary content is dropped by {@link landContent}'s own guard — and the
   * reclassification is deferred until the room is closed, the same never-destroy-a-live-document
   * posture {@link landContent} takes with active documents.
   */
  private async reconcileRowClassification(
    fileName: string,
    gitPath: string,
    fileNodeId: FileNodeId,
    content: Buffer,
    mimeType: string,
    activeDocumentIds: Set<string>,
  ): Promise<void> {
    const shouldBeDocument = isAsciiDocumentFileName(fileName) || isThemeFilePath(gitPath);
    const existingDocument = await this.documentRepo.findByFileNodeId(fileNodeId);
    if (shouldBeDocument === (existingDocument !== null)) return;

    if (existingDocument && activeDocumentIds.has(existingDocument.id.value)) {
      // The demotion target is a live document; keep its row so open editors are not orphaned.
      this.logger?.warn('Pulled a rename demotes an open document to a non-document; keeping the live document row', {
        path: gitPath,
        documentId: existingDocument.id.value,
      });
      return;
    }

    const mime = MimeType.create(mimeType);
    if (existingDocument) {
      // Was a Document; the new name is not one. Remove the document row and record it as an Asset.
      await this.documentRepo.delete(existingDocument.id);
      await this.assetRepo.save(new Asset(fileNodeId, mime, BigInt(content.length)));
    } else {
      // Was an Asset; the new name is a Document. Remove the asset row (no-op if absent) and mint it.
      await this.assetRepo.delete(fileNodeId);
      await this.documentRepo.save(
        new Document(DocumentId.create(randomUUID()), fileNodeId, ContentId.create(randomUUID()), YjsStateId.create(randomUUID()), mime),
      );
    }
  }

  /**
   * Removes an existing file: its document/asset row, its node, and its stored bytes.
   *
   * Under drift the pulled removal can target a path where a FOLDER (with children) now sits locally.
   * `FileNodeRepository.delete` is a bare row delete with no cascade, so deleting the folder would
   * orphan its children (their `parentId` would point at a deleted row) or throw on the foreign key —
   * either way breaking the never-throw-on-drift posture. So a non-file node is left untouched: the
   * removal is skipped, one benign `removed_path_occupied_by_folder` anomaly is recorded, and nothing
   * on disk changes.
   *
   * @returns `true` when the file was removed; `false` when the removal was skipped because a folder
   *   occupies the path (anomaly already recorded), so the caller keeps the path out of `changedPaths`.
   */
  private async removeFile(
    projectId: ProjectId,
    node: FileNode,
    nodesByPath: Map<string, FileNode>,
    anomalies: GitReconcileAnomaly[],
  ): Promise<boolean> {
    if (node.type.value !== 'file') {
      const gitPath = node.path.value.replace(/^\/+/, '');
      this.logger?.warn('Pulled a removal for a path held by a folder node; skipping to avoid deleting the folder and its contents', {
        path: node.path.value,
      });
      anomalies.push({
        path: gitPath,
        kind: 'removed_path_occupied_by_folder',
        applied: true,
        message: `Pulled a removal of "${gitPath}", but a folder occupies that path locally; the removal was skipped to avoid deleting the folder and its contents.`,
      });
      return false;
    }

    const document = await this.documentRepo.findByFileNodeId(node.id);
    if (document) await this.documentRepo.delete(document.id);
    // Safe when the node was never an asset — a delete of a missing row is a no-op.
    await this.assetRepo.delete(node.id);
    await this.fileNodeRepo.delete(node.id);
    await this.fileStore.remove(projectId, node.path);
    nodesByPath.delete(node.path.value);
    return true;
  }

  /**
   * Returns the id of the folder at `segments` under the project root, creating it — and every
   * ancestor it needs — on demand, and recording each created folder in the working view. Empty
   * `segments` resolves to the project root folder (path `/`).
   *
   * Two drift cases are guarded rather than assumed away. When a FILE node already occupies an
   * ancestor path, the pulled file cannot be parented under it without corrupting the tree, so the
   * change is DROPPED: one `content_dropped_file_occupies_ancestor_path` anomaly (`applied: false`) is
   * recorded and `null` is returned, propagated up so no node is created and the caller adds no anomaly
   * of its own. When empty `segments` finds no `/` node (root missing from the working view), the root
   * is resolved by its `null` parent instead of recursing on the unchanged empty list — which would
   * never terminate; a project with genuinely no root is corrupt and fails loudly.
   *
   * @returns The resolved/created folder id, or `null` when the change was dropped for an ancestor
   *   file/folder collision (anomaly already recorded).
   */
  private async ensureFolder(
    projectId: ProjectId,
    segments: readonly string[],
    nodesByPath: Map<string, FileNode>,
    anomalies: GitReconcileAnomaly[],
    targetPath: string,
  ): Promise<FileNodeId | null> {
    const path = `/${segments.join('/')}`;
    const existing = nodesByPath.get(path);
    if (existing) {
      if (existing.type.value !== 'folder') {
        // Drift: a FILE node sits on an ancestor path where a folder is needed. Parenting the pulled
        // file under a file would corrupt the tree, so drop the change — the same never-corrupt-the-tree
        // posture landContent takes when a folder occupies a leaf path — with one accurate applied:false
        // anomaly. Counts stay correct: callers push no anomaly of their own for a null (dropped) result.
        const ancestorPath = path.replace(/^\/+/, '');
        this.logger?.warn('Pulled a file whose ancestor path is held by a file node; skipping to avoid corrupting the tree', {
          path: targetPath,
          ancestorPath,
        });
        anomalies.push({
          path: ancestorPath,
          kind: 'content_dropped_file_occupies_ancestor_path',
          applied: false,
          message: `Pulled file "${targetPath}" could not be created because "${ancestorPath}" is a file, not a folder; the change was dropped. Remove or rename that file to recover the change.`,
        });
        return null;
      }
      return existing.id;
    }

    if (segments.length === 0) {
      // The project root ('/') is absent from the working view. Resolve it by its null parent rather
      // than recurse on the unchanged empty segment list (which would loop forever); a project with no
      // root at all is corrupt and cannot land a change, so fail with a clear domain error.
      for (const rootNode of nodesByPath.values()) {
        if (rootNode.parentId === null) return rootNode.id;
      }
      throw new GitCommandFailedError('Cannot land the pulled change: the project has no root folder.');
    }

    const parentId = await this.ensureFolder(projectId, segments.slice(0, -1), nodesByPath, anomalies, targetPath);
    if (parentId === null) return null;
    const folderId = FileNodeId.create(randomUUID());
    const name = segments.at(-1)!;
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
