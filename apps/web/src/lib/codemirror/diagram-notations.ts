/**
 * The set of diagram notation names the editor recognises on a block declaration line
 * (`[mermaid]`, `[graphviz]`, `[vega]`, `[vegalite]`) so it can highlight the declaration
 * distinctly from a generic `[source,lang]` listing.
 *
 * This set is the SINGLE source of truth for the editor side and MUST stay in lockstep with the
 * renderer's supported notations. It lives in its own tiny module so the block tokenizer, the
 * diagram-language highlighters, and the cross-package consistency test can all import it without
 * colliding on edits to the larger codemirror source files.
 *
 * Asciidoctor accepts `vega-lite` as an alias of `vegalite`; {@link normalizeDiagramNotation}
 * folds it (and any casing) to the canonical lowercase name.
 */
export const DIAGRAM_NOTATIONS = ['mermaid', 'graphviz', 'vega', 'vegalite'] as const;

/**
 * The canonical lowercase name of a diagram notation the editor recognises.
 */
export type DiagramNotation = (typeof DIAGRAM_NOTATIONS)[number];

const DIAGRAM_NOTATION_SET: ReadonlySet<string> = new Set(DIAGRAM_NOTATIONS);

/**
 * Type guard narrowing an arbitrary string to a canonical {@link DiagramNotation}.
 *
 * @param value - The candidate notation name.
 * @returns `true` when the value is a recognised canonical notation.
 */
function isDiagramNotation(value: string): value is DiagramNotation {
  return DIAGRAM_NOTATION_SET.has(value);
}

/**
 * Normalise a raw block-name string to a canonical diagram notation, or `null` when it is not a
 * recognised notation. Casing is ignored and `vega-lite` folds to `vegalite`.
 *
 * @param name - The raw block name (the first attribute of a `[...]` line).
 * @returns The canonical {@link DiagramNotation}, or `null` when unrecognised.
 */
export function normalizeDiagramNotation(name: string): DiagramNotation | null {
  const lower = name.toLowerCase();
  const canonical = lower === 'vega-lite' ? 'vegalite' : lower;
  return isDiagramNotation(canonical) ? canonical : null;
}
