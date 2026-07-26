/**
 * Best-effort inverse of the PDF scroll-sync map: turn a click position on a rendered page back into the
 * assembled-document line of the block at that position. The engine's {@link PdfSourceMap} is forward-only
 * (source line → `(page, yFraction)`), so this reverses it by LAYOUT position — the governing block is the
 * lowest one laid out at or above the click point, found by comparing positions rather than by trusting
 * the map's line order to match its layout order. It is inherently approximate (block granularity, no
 * glyph mapping), which is why click-to-source on the PDF is documented as best-effort.
 */

import type { PdfSourceMap, PdfSourceMapEntry } from '@asciidocollab/asciidoc-pdf';

/**
 * Compare two layout positions in reading order: page first, then vertical position down the page.
 * Negative when `a` is laid out above `b`, positive when below, zero when they share a position.
 *
 * @param a - The first layout position.
 * @param b - The position to compare it against.
 * @returns A negative, zero, or positive ordering value.
 */
function comparePosition(a: PdfSourceMapEntry, b: PdfSourceMapEntry): number {
  return a.page === b.page ? a.yFraction - b.yFraction : a.page - b.page;
}

/**
 * The source-map entry of the block governing a click at `(page, yFraction)`: the entry with the LOWEST
 * layout position (page, then vertical position) that is still at or before the click point. A click above
 * the first mapped block on the first page resolves to that first block; a click below all blocks resolves
 * to the last. Returns undefined only when the map is empty. Preview entries carry the exact source origin
 * (`path`/`sourceLine`); the caller uses that when present and otherwise falls back to the assembled `line`.
 *
 * The whole map is scanned and compared by POSITION rather than walked in line order until the click's
 * page is passed. Line order is not layout order in general — a keep-together measurement, a floated
 * block, or a term stamped at its inking point can put a later line above an earlier one — and the
 * short-circuit version treated the first entry beyond the click's page as proof that nothing after it
 * could govern. One such entry collapsed every click on the pages after it onto a single line. The map is
 * a few dozen entries, so the full scan costs nothing.
 *
 * TIE-BREAK: entries sharing one position are real, not noise — a `[horizontal]` dlist inks its term and
 * description on the same row, and a qanda question and answer share a single capture point. The FIRST
 * such entry in the map (which is line-sorted, so the earliest line) wins, because that is the line the
 * shared row begins at: clicking a horizontal dlist row lands on its term, not on the description.
 *
 * @param sourceMap - The engine source map, sorted by assembled line.
 * @param page - The 1-based PDF page the click landed on.
 * @param yFraction - The click's vertical position as a fraction of page height from the top, in `[0, 1]`.
 * @returns The governing block's source-map entry, or undefined when the map is empty.
 */
export function assembledEntryAtPdfPosition(
  sourceMap: PdfSourceMap,
  page: number,
  yFraction: number,
): PdfSourceMapEntry | undefined {
  if (sourceMap.length === 0) return undefined;
  const click: PdfSourceMapEntry = { line: 0, page, yFraction };
  let governing: PdfSourceMapEntry | undefined;
  for (const entry of sourceMap) {
    if (comparePosition(entry, click) > 0) continue;
    // Strictly greater, so on a tie the earlier entry (the earlier line) is kept.
    if (governing === undefined || comparePosition(entry, governing) > 0) governing = entry;
  }
  // A click above every mapped block still resolves to the document's first block (top-of-document).
  return governing ?? sourceMap[0];
}
