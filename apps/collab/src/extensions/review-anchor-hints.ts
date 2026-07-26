import * as Y from 'yjs';
import type { Extension, onStoreDocumentPayload } from '@hocuspocus/server';
import type { Logger } from 'pino';
import type {
  DocumentId,
  ProjectId,
  ReviewCommentRepository,
} from '@asciidocollab/domain';
import { isPresenceRoom, unpackRelativePositionPair } from '@asciidocollab/shared';
import { parseRoomName, type DocumentByYjsStateLookup } from '../server.js';

/**
 * The `Y.Text` name the CodeMirror binding (and persistence) uses for document content. Duplicated
 * from the persistence extension rather than shared, so this extension has no reason to import it.
 */
const CODEMIRROR_TEXT = 'codemirror';

/**
 * Returns the 1-based number of the line containing `offset`, matching CodeMirror's
 * `state.doc.lineAt(pos).number` — which is what captured the hint in the first place, so the
 * refreshed value stays on the same scale as an anchor created in the browser. An offset landing on a
 * `\n` belongs to the line that newline TERMINATES, and an out-of-range offset is clamped into the
 * document. Line breaks are `\n` (and therefore `\r\n`, which contains one); a document using a LONE
 * `\r` as its terminator would count as a single line here where CodeMirror splits it, which no
 * editor-authored content produces. Linear-time, no regex.
 *
 * @param text - The full document text.
 * @param offset - A character offset into `text`.
 * @returns The 1-based line number.
 */
export function lineNumberAt(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let index = text.indexOf('\n'); index !== -1 && index < clamped; index = text.indexOf('\n', index + 1)) {
    line += 1;
  }
  return line;
}

/**
 * Resolves a review anchor's stored relative-position pair against the live document and returns the
 * 1-based line its passage STARTS on, or null when the anchor no longer resolves.
 *
 * This deliberately mirrors the browser's `resolveAnchor` exactly: both endpoints must resolve, and
 * the passage starts at the lower of the two indices. Requiring both is what keeps the two review
 * surfaces consistent — an anchor the editor's highlight layer would not place must not be given a
 * fresh position in the cross-file panel either. When it returns null the caller leaves the stored
 * hint alone: a last-known line is more useful to a reader than no line at all, and the browser can
 * still find such an item by its text quote.
 *
 * @param relativePos - The stored, packed relative-position pair.
 * @param ydoc - The live document to resolve against.
 * @param text - That document's current text (already materialised by the caller).
 * @returns The 1-based line number, or null when either endpoint no longer resolves.
 */
export function resolveAnchorLine(relativePos: Uint8Array, ydoc: Y.Doc, text: string): number | null {
  const unpacked = unpackRelativePositionPair(relativePos);
  if (!unpacked) return null;
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unpacked.start), ydoc);
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unpacked.end), ydoc);
    if (!start || !end) return null;
    return lineNumberAt(text, Math.min(start.index, end.index));
  } catch {
    // Corrupt bytes: Y.decodeRelativePosition throws rather than returning null.
    return null;
  }
}

/** Dependencies for {@link ReviewAnchorHintExtension}. */
export interface ReviewAnchorHintOptions {
  /** Reads and writes the document's review items (the anchors whose hints get re-measured). */
  reviewCommentRepo: ReviewCommentRepository;
  /** Resolves the room's `yjsStateId` to its `Document`, whose id scopes the review items. */
  documentRepo: DocumentByYjsStateLookup;
  /** Logger for best-effort failure diagnostics. */
  logger: Logger;
}

/**
 * Hocuspocus extension that re-measures every review anchor's stored `lineHint` for a document at
 * write-back.
 *
 * A review anchor's authoritative position is a Yjs relative-position pair, which only yields an
 * offset once resolved against the shared document. Its `lineHint` is a DERIVED convenience for
 * readers that have no such document loaded — above all the project-wide comments & tasks panel,
 * which spans files the browser never opened and therefore orders each file's items by that hint.
 * The hint was captured when the item was created and never refreshed, so the panel's within-file
 * order was right at creation and drifted with every subsequent edit: insert a paragraph above three
 * comments and all three hints are silently wrong, permanently.
 *
 * The collaboration server is the one place that both HAS the resolved document state and already
 * runs on every save, so re-measuring here fixes the staleness at source, for every consumer, and
 * needs no new schema — `lineHint` is simply given a fresher value. Only anchors whose line actually
 * moved are written back, and the re-measurement never stamps `updatedAt` (see
 * `ReviewComment.refreshAnchorLineHint`), so a quiet document costs one read and no writes.
 *
 * Every failure is absorbed and logged: a hint is a convenience, and it must never be able to break
 * the write-back of a user's actual content. For the same reason the composition root registers this
 * extension AFTER the persistence extension, so the authoritative writes are already done before
 * this one spends a query.
 */
export class ReviewAnchorHintExtension implements Extension {
  private readonly reviewCommentRepo: ReviewCommentRepository;
  private readonly documentRepo: DocumentByYjsStateLookup;
  private readonly logger: Logger;

  /** Creates the extension wired to the review-item repository and the document lookup. */
  constructor(options: ReviewAnchorHintOptions) {
    this.reviewCommentRepo = options.reviewCommentRepo;
    this.documentRepo = options.documentRepo;
    this.logger = options.logger;
  }

  /**
   * Re-measures the stored line hints of the document being written back. A presence room and a
   * document whose record is gone (the file was deleted while its room was open) are skipped.
   *
   * @param payload - The Hocuspocus store payload (room name plus the live `Y.Doc`).
   */
  async onStoreDocument({ documentName, document }: onStoreDocumentPayload): Promise<void> {
    if (isPresenceRoom(documentName)) return;
    try {
      const { projectId, yjsStateId } = parseRoomName(documentName);
      const record = await this.documentRepo.findByYjsStateId(yjsStateId);
      if (!record) return;
      await this.refreshHints(projectId, record.id, document);
    } catch (error) {
      this.logger.warn(
        { err: error, documentName },
        'Failed to refresh review anchor line hints (best-effort); the cross-file panel order may lag',
      );
    }
  }

  /**
   * Re-measures and persists the changed hints of one document's review items.
   *
   * @param projectId - The tenant scope.
   * @param documentId - The document whose items to re-measure.
   * @param ydoc - The live document to resolve each anchor against.
   * @returns The number of items whose stored hint was updated.
   */
  private async refreshHints(projectId: ProjectId, documentId: DocumentId, ydoc: Y.Doc): Promise<number> {
    // `includeResolved: true`: a resolved thread is still listed (the panel's "All"/"Resolved"
    // filters show it), so its hint must stay as fresh as an open one's.
    const items = await this.reviewCommentRepo.listByDocument(projectId, documentId, {
      includeResolved: true,
    });
    const text = ydoc.getText(CODEMIRROR_TEXT).toString();
    let updated = 0;
    for (const item of items) {
      // Replies carry no anchor; a root without a relative-position pair has nothing to resolve.
      const relativePos = item.anchor?.relPos;
      if (!relativePos) continue;
      const line = resolveAnchorLine(relativePos, ydoc, text);
      if (line === null) continue;
      if (!item.refreshAnchorLineHint(line)) continue;
      await this.reviewCommentRepo.update(item);
      updated += 1;
    }
    return updated;
  }
}
