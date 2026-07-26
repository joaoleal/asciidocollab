/**
 * The three writing-issue categories the UI colours distinctly — spelling, grammar, and style — plus
 * the mapping from Harper's fine-grained `lint_kind()` values onto them. Categories drive one set of
 * design tokens (`--syntax-grammar-*` in `globals.css`) reused across the underline, gutter, tooltip,
 * panel, and status bar, so there are no colour literals anywhere (Principle V).
 *
 * The `lint_kind` set is engine-defined and changes between Harper versions, so the mapping is a
 * best-effort grouping with a `grammar` fallback for anything unrecognised — never an exhaustive list
 * the code depends on.
 */

/** A coarse writing-issue category the UI colours. */
export type GrammarCategory = 'spelling' | 'grammar' | 'style';

/** All grammar categories, in display order. */
export const GRAMMAR_CATEGORIES = ['spelling', 'grammar', 'style'] as const;

/** Harper `lint_kind()` values grouped as spelling. */
const SPELLING_KINDS: ReadonlySet<string> = new Set(['Spelling', 'Typo']);

/** Harper `lint_kind()` values grouped as style (readability/wording, not correctness). */
const STYLE_KINDS: ReadonlySet<string> = new Set([
  'Style',
  'Readability',
  'Redundancy',
  'Repetition',
  'Enhancement',
  'WordChoice',
  'Formatting',
]);

/**
 * Classify a Harper `lint_kind()` into a UI category. Anything not explicitly spelling or style is
 * treated as grammar, so a new engine kind degrades to the neutral correctness colour rather than going
 * unstyled.
 *
 * @param lintKind - The value from Harper's `Lint.lint_kind()`.
 * @returns The UI category the lint belongs to.
 */
export function categoryForLintKind(lintKind: string): GrammarCategory {
  if (SPELLING_KINDS.has(lintKind)) return 'spelling';
  if (STYLE_KINDS.has(lintKind)) return 'style';
  return 'grammar';
}

/** The CSS mark class applied to a diagnostic's underline for each category (styled by the theme). */
export const GRAMMAR_CATEGORY_MARK_CLASS: Readonly<Record<GrammarCategory, string>> = {
  spelling: 'cm-grammar-spelling',
  grammar: 'cm-grammar-grammar',
  style: 'cm-grammar-style',
};

/**
 * The background-colour class for a category's swatch outside the editor — panel legends, the issue
 * list, the status bar, the popover.
 *
 * This is deliberately NOT {@link GRAMMAR_CATEGORY_MARK_CLASS}. That one is matched by the CodeMirror
 * theme only as `.cm-lintRange.cm-grammar-*`, and only to set `text-decoration`; used as a background
 * class in ordinary markup it matches nothing and paints an invisible dot. Both read the same
 * `--syntax-grammar-*` tokens, so underline and swatch stay the same colour (Principle V).
 */
export const GRAMMAR_CATEGORY_DOT_CLASS: Readonly<Record<GrammarCategory, string>> = {
  spelling: 'bg-[hsl(var(--syntax-grammar-spelling))]',
  grammar: 'bg-[hsl(var(--syntax-grammar-grammar))]',
  style: 'bg-[hsl(var(--syntax-grammar-style))]',
};
