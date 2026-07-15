/**
 * Post-process a mermaid-rendered SVG so the downstream PDF renderer (prawn-svg, inside the Ruby wasm
 * engine) draws its text labels correctly.
 *
 * Mermaid (with `htmlLabels: false`) emits each label as NESTED tspans — one "row" tspan per wrapped
 * line, each holding one `text-inner-tspan` per word:
 *
 *   <text text-anchor="middle">
 *     <tspan class="text-outer-tspan row" x="0" dy="1.1em" text-anchor="middle">
 *       <tspan class="text-inner-tspan">Square</tspan>
 *       <tspan class="text-inner-tspan">Rect</tspan>
 *     </tspan>
 *   </text>
 *
 * A browser flows those inner tspans inline (so the HTML preview renders "Square Rect" correctly), but
 * prawn-svg positions every inner tspan at the row's anchor `x` instead of advancing — so the words pile
 * up at the same spot and interleave ("Square" + "Rect" → "SRqeucatre"). This is why the on-screen
 * preview looks right while the embedded PDF diagram text is mangled.
 *
 * The fix unwraps the per-word inner tspans, leaving each row tspan holding its text directly (one run
 * prawn-svg positions once). The whitespace mermaid places BETWEEN the inner tspans lives in text nodes
 * outside them, so it survives — the label still reads "Square Rect". Multi-line labels keep their
 * separate row tspans (and their `dy` line advance), so wrapped labels still stack. Vector text is
 * preserved — nothing is rasterized.
 *
 * This is a pure string transform (no DOM), so it runs identically on every path the mermaid shim takes
 * — the browser main-thread pre-pass, a worker, and the Node parity harness — which is what keeps the
 * committed reference SVG byte-identical to what the app renders. It relies only on mermaid's stable
 * emitted markup: an inner tspan is a leaf carrying its class and word text and never contains a nested
 * `<` (mermaid escapes label text), so a single non-overlapping regex removes each wrapper in linear time.
 * It runs only on the PDF path (the shim); the on-screen preview keeps mermaid's native output untouched.
 */

/**
 * Matches one mermaid per-word inner-label tspan and captures its text. The class attribute is required
 * (so only mermaid's label word-wrappers are touched, never a structural tspan), and the body is `[^<]*`
 * — an inner tspan is a leaf whose text carries no nested markup — so the match is bounded to a single
 * element and the global scan cannot overlap into the next tag (linear time, no backtracking).
 */
const INNER_LABEL_TSPAN_RE = /<tspan\b[^>]*\btext-inner-tspan\b[^>]*>([^<]*)<\/tspan>/g;

/**
 * Flatten mermaid's nested per-word label tspans into one text run per row so prawn-svg lays the text
 * out correctly in the exported PDF. Returns the SVG unchanged when it carries no such inner tspans.
 *
 * @param svg - The mermaid-rendered SVG markup.
 * @returns The SVG with each label's inner per-word tspans unwrapped to their text (spacing preserved).
 */
export function flattenMermaidLabelTspans(svg: string): string {
  if (!svg.includes('text-inner-tspan')) {
    return svg;
  }
  return svg.replace(INNER_LABEL_TSPAN_RE, (_whole, text: string) => text);
}
