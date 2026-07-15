/**
 * Shared editor→preview scroll-sync helper: lift a block's mapped source line to its VISUAL start.
 *
 * Both preview engines key their source→position maps on Asciidoctor's block source location, which
 * points at a block's opening delimiter (or first content line) — never at the block title (`.Caption`)
 * or attribute lines (`[source,ruby]`, `[[anchor]]`, `[.role]`) that sit directly above it. Without this
 * adjustment a click on a block's title line has no matching entry and the "nearest line ≤ cursor"
 * lookup falls back to the PREVIOUS block, scrolling above the intended target. Walking up over the
 * contiguous title/attribute metadata makes a click anywhere in a block's leading metadata resolve to the
 * block itself. The HTML render worker and the PDF preview both use this so the two stay in parity.
 */

// A block title line: a leading `.` followed by a non-`.`, non-space char (so a `....`/`...` literal
// delimiter is never mistaken for one), e.g. `.Example block`, `.Code caption`.
const BLOCK_TITLE_LINE_RE = /^\.[^.\s]/;
// A block attribute/anchor line, e.g. `[source,ruby]`, `[example]`, `[[section-anchor]]`, `[.role]`.
const BLOCK_ATTR_LINE_RE = /^\[.+]$/;

/**
 * The line where a block VISUALLY begins in the source — the topmost of the contiguous title/attribute
 * metadata lines directly above its delimiter/content line, stopping at the first blank or content line.
 *
 * @param sourceLines - The document split into lines (0-based array of 1-based source lines).
 * @param lineNumber - The block's 1-based Asciidoctor source line (its delimiter/content line).
 * @returns The 1-based line of the topmost contiguous metadata line, or `lineNumber` when there is none.
 */
export function blockStartLine(sourceLines: readonly string[], lineNumber: number): number {
  let start = lineNumber;
  for (let above = lineNumber - 1; above >= 1; above -= 1) {
    const text = sourceLines[above - 1];
    if (text === undefined) break;
    const trimmed = text.trim();
    if (BLOCK_TITLE_LINE_RE.test(trimmed) || BLOCK_ATTR_LINE_RE.test(trimmed)) {
      start = above;
    } else {
      break;
    }
  }
  return start;
}
