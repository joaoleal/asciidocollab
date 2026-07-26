/**
 * @file The single source of truth for review-item ordering. Both review surfaces — the per-file
 * comment rail and the project-wide comments & tasks panel — must list items in the order their
 * anchors appear in the document, so reading the panel top-to-bottom walks the document. Neither
 * the database nor the API can compute that order: a review anchor is an opaque Yjs
 * relative-position pair whose live offset only exists once the shared document is loaded in the
 * browser. The rule therefore lives here, in one pure module, rather than being restated (and drifting)
 * in each component.
 */

import type { ReviewItemDto, ThreadDto } from '@asciidocollab/shared';

/**
 * The position given to an item that has none. An orphaned (detached) anchor resolves to nothing, so
 * it cannot be interleaved with the located items; it sorts to the END of the list, after every
 * positioned item. Last — not first — because the head of the list then stays a faithful walk of the
 * document, and the items needing a human decision (reattach or resolve) collect in one predictable
 * place instead of pushing the document's own comments down.
 */
const ORPHAN_POSITION = Number.POSITIVE_INFINITY;

/** A review item reduced to just the fields the ordering rule compares. */
export interface ReviewOrderKey {
  /**
   * The rank of the item's file within the document. Every item shares one rank on a single-file
   * surface; a cross-file surface ranks by file first, keeping each file's items contiguous.
   */
  fileRank: number;
  /** The anchor's position inside its file, or null when the anchor no longer resolves. */
  position: number | null;
  /** The item's ISO-8601 creation timestamp — the first tie-break between two equal positions. */
  createdAt: string;
  /** The item's id — the final tie-break, which makes the order total so renders never flicker. */
  id: string;
}

/** A resolved live anchor range, as produced for the editor's highlight layer. */
export interface ResolvedAnchorPosition {
  /** The root review item id this range belongs to. */
  id: string;
  /** The passage's start offset in the live document. */
  from: number;
}

/**
 * Compares two strings by code unit. Deterministic in every environment, unlike locale-aware
 * collation, which is what a tie-break must be.
 *
 * @param a - The left string.
 * @param b - The right string.
 * @returns A negative number when `a` sorts first, positive when `b` does, 0 when they are equal.
 */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Compares two review items by document order: file rank, then position within the file, then
 * creation time, then id. An item whose anchor no longer resolves sorts after every located item
 * (see {@link ORPHAN_POSITION}). Timestamps compare by code unit, which is exact here because the
 * wire DTO always serialises them through `Date.prototype.toISOString`.
 *
 * @param a - The left item's order key.
 * @param b - The right item's order key.
 * @returns A negative number when `a` precedes `b`, positive when it follows, 0 when identical.
 */
export function compareReviewOrder(a: ReviewOrderKey, b: ReviewOrderKey): number {
  if (a.fileRank !== b.fileRank) return a.fileRank - b.fileRank;
  const positionA = a.position ?? ORPHAN_POSITION;
  const positionB = b.position ?? ORPHAN_POSITION;
  if (positionA !== positionB) return positionA < positionB ? -1 : 1;
  const byCreatedAt = compareStrings(a.createdAt, b.createdAt);
  return byCreatedAt === 0 ? compareStrings(a.id, b.id) : byCreatedAt;
}

/**
 * Orders ONE document's threads by where their anchors currently sit in that document. The positions
 * come from the live ranges resolved against the shared `Y.Text` — the very same offsets the editor
 * paints its highlights at — so the rail and the document can never disagree. A thread with no
 * resolved range (a detached anchor, or any thread while the collaborative document is still loading)
 * has no position and sorts last, tie-broken by creation time then id.
 *
 * @param threads - The document's threads, in any order.
 * @param ranges - The live resolved anchor ranges, keyed by root item id.
 * @returns A new array holding the same threads in document order.
 */
export function sortThreadsByDocumentOrder(
  threads: readonly ThreadDto[],
  ranges: readonly ResolvedAnchorPosition[],
): ThreadDto[] {
  const positionById = new Map(ranges.map((range) => [range.id, range.from]));
  return threads
    .map((thread) => ({
      thread,
      key: {
        // A single document is one file, so every thread shares the same file rank.
        fileRank: 0,
        position: positionById.get(thread.root.id) ?? null,
        createdAt: thread.root.createdAt,
        id: thread.root.id,
      } satisfies ReviewOrderKey,
    }))
    .toSorted((a, b) => compareReviewOrder(a.key, b.key))
    .map((entry) => entry.thread);
}

/** The stable per-file sort key for a cross-file item: its display file name, else its document id. */
function filePathKey(item: ReviewItemDto): string {
  return item.fileName ?? item.documentId;
}

/**
 * The stored position of a cross-file item, or null when it has none: a detached anchor points
 * nowhere, and an anchor may predate the line hint.
 *
 * The hint is a LINE, not an offset, so two items anchored on the same line compare equal here and
 * fall through to the creation-time tie-break — the one place this surface is coarser than the
 * per-file rail, which compares exact offsets.
 *
 * @param item - The review item to locate.
 * @returns The 1-based line hint, or null when the item has no usable position.
 */
function storedPosition(item: ReviewItemDto): number | null {
  const { anchor } = item;
  if (!anchor || anchor.state === 'detached' || anchor.lineHint === undefined) return null;
  return anchor.lineHint;
}

/**
 * Orders the project-wide, cross-file list of review items. Because that list spans documents the
 * browser has not opened, there is no live `Y.Doc` to resolve anchors against, so within a file it
 * orders by the anchor's stored `lineHint`, and across files by a stable path order (file name,
 * falling back to document id), since this surface has no view of the root document's include order.
 * Detached and hintless items sort last within their own file, tie-broken by creation time then id.
 *
 * The `lineHint` is no longer the line captured when the item was created: the collaboration server
 * re-measures every anchor of a document against the live shared state on each write-back (see
 * `apps/collab/src/extensions/review-anchor-hints.ts`), so the stored line tracks the document
 * instead of freezing at creation and drifting with every subsequent edit. Two bounded
 * approximations remain, and both are deliberate: the hint is a LINE (same-line items tie-break by
 * creation time, where the rail would compare offsets), and it is as fresh as the last write-back and
 * this list's last fetch — so an edit made while the panel is open can be moments ahead of the order
 * shown. Neither can drift without bound the way the creation-time hint did.
 *
 * @param items - The project's review items, in any order.
 * @returns A new array holding the same items in document order.
 */
export function sortReviewItemsByDocumentOrder(items: readonly ReviewItemDto[]): ReviewItemDto[] {
  const files = [...new Set(items.map(filePathKey))].toSorted(compareStrings);
  return items
    .map((item) => ({
      item,
      key: {
        fileRank: files.indexOf(filePathKey(item)),
        position: storedPosition(item),
        createdAt: item.createdAt,
        id: item.id,
      } satisfies ReviewOrderKey,
    }))
    .toSorted((a, b) => compareReviewOrder(a.key, b.key))
    .map((entry) => entry.item);
}
