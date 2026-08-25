import { ProjectId } from '../../value-objects/ids/project-id';
import { YjsStateId } from '../../value-objects/ids/yjs-state-id';
import { Result } from '../../types/result';

/**
 * Port for replacing the ENTIRE live content of a document whose authoritative source of truth
 * is the collaborative Yjs document owned by the collaboration server.
 *
 * A server-side operation that lands externally-produced content (e.g., merging remote git
 * changes into a document that is open for collaborative editing) must NOT overwrite such a
 * document by writing the plain-text file store directly: the file store is only a projection of
 * the Yjs state, so a direct write is invisible to anyone editing the document live AND is
 * overwritten by the next Yjs writeback, silently reverting the change. Replacing the content
 * through this port routes it into the Yjs source of truth instead — it appears live for
 * connected editors and is persisted by the normal writeback.
 *
 * Implementations reconcile the live Yjs text toward `targetContent` with a minimal diff (rather
 * than a wholesale delete-and-insert), applied as a single Yjs transaction, so the change merges
 * cleanly with any concurrent edits and preserves collaborators' cursor positions where the text
 * around them is unchanged.
 */
export interface CollaborativeContentWriter {
  /**
   * Replaces the current text of the document identified by `yjsStateId` with `targetContent`.
   *
   * @param projectId - The project that owns the document.
   * @param yjsStateId - The Yjs state identifier of the document's collaborative room.
   * @param targetContent - The full document content the live document is reconciled toward.
   * @returns Success once the live document matches `targetContent`; or an error when the
   *   replacement could not be delivered (for instance, the collaboration server is unreachable).
   */
  replaceContent(
    projectId: ProjectId,
    yjsStateId: YjsStateId,
    targetContent: string,
  ): Promise<Result<void, Error>>;
}
