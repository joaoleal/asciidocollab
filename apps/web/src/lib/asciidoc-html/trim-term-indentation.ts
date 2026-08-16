/**
 * @file Drop a horizontal description list's template indentation from its term cells.
 *
 * Asciidoctor writes a horizontal list's term with the template's own indentation around it.
 *
 * ```html
 * <td class="hdlist1">
 * lambda
 * </td>
 * ```
 *
 * The newlines around the term are the converter template's indentation, not the author's text. They
 * cost nothing in ordinary rendering: collapsible whitespace at the START of a line is removed, and
 * the term is the first thing on its line.
 *
 * They stop costing nothing the moment anything else is placed before them. The Print preview puts a
 * zero-width strut at the head of a block's first line — that is how it reproduces the renderer's own
 * `initial_gap + max_ascender` instead of the browser's rounded ascent — and with an atomic inline in
 * front of it the leading newline is no longer at the start of the line, so Chromium renders it as a
 * space. Measured on the fidelity fixtures: every term grew by 3.813px, the width of a space in the
 * body face and the same number for a two-letter term as for a wrapping one. That widened the column
 * the renderer sizes from the widest term, moved the description column 2.84pt right, and pushed the
 * term's own glyphs a space off their left edge.
 *
 * Removing it here rather than working around it in CSS is what keeps the fix honest: there is no CSS
 * length equal to a space's advance (`ch` is the advance of `0`), so every stylesheet-side answer was
 * either a hard-coded guess at one or a layout mode that traded the defect for another. The
 * whitespace is not content in the first place.
 *
 * Applied to the term cell only. The vertical list's `<dt>` is written on one line with its text, and
 * every other construct the preview struts holds its text in a `<p>`, which Asciidoctor writes with
 * no leading whitespace inside the tag.
 */

/**
 * A horizontal description list's term cell, up to the first non-whitespace of its content.
 *
 * Anchored on the opening tag and on the WHOLE class attribute, closing quote included, so
 * `class="hdlist10"` and `class="hdlist1 someRole"` are both left alone — this matches the one shape
 * `convert_dlist`'s horizontal branch emits and nothing that merely begins like it. `[^<>]*` allows
 * further attributes after the class without letting the match run past the tag. Excluding `<` as
 * well as `>` is what keeps that scan linear: with only `>` excluded, input consisting of the opening
 * literal repeated has every position start a scan that runs to the end of the string, which is the
 * quadratic shape `redos/no-vulnerable` rejects. No attribute value the converter writes contains a
 * `<`, so the narrower class costs nothing.
 *
 * The narrowness is the safety: a shape this does not recognise keeps its whitespace, which is the
 * behaviour every other construct already has, and the fidelity oracle measures the column width that
 * would then be wrong. It cannot fail silently in the direction that matters.
 */
const TERM_CELL_INDENT = /(<td class="hdlist1"[^<>]*>)\s+/g;

/**
 * Remove the converter's own indentation from the front of every horizontal-list term.
 *
 * @param html - Converted AsciiDoc.
 * @returns The same markup with each term cell's leading whitespace dropped.
 */
export function trimTermIndentation(html: string): string {
  return html.replaceAll(TERM_CELL_INDENT, '$1');
}
