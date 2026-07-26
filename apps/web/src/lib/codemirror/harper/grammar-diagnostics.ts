import type { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { forEachDiagnostic } from '@codemirror/lint';
import { GRAMMAR_CATEGORIES, type GrammarCategory } from './category-colors';
import type { GrammarDiagnostic } from './lint-to-diagnostic';

/**
 * Reads the current grammar diagnostics out of the editor state and groups/counts them for the panel
 * and status bar. Diagnostics are view-local state (never in the Yjs document), so this is a pure read
 * of the `@codemirror/lint` field — the bridge that surfaces them to React.
 */

/**
 * A grammar diagnostic paired with its live document position. The lint field keeps positions mapped
 * through edits, so `from`/`to` here are always current even after the document changed.
 */
export interface PositionedGrammarDiagnostic {
  /** Current document offset of the issue start. */
  from: number;
  /** Current document offset just past the issue. */
  to: number;
  /** The grammar diagnostic (message, category, suggestions). */
  diagnostic: GrammarDiagnostic;
}

/**
 * True when a lint diagnostic is one of ours (produced by the Harper source), narrowing its type.
 *
 * Identified by the fields it carries rather than by its `source` string: `source` is reader-facing and
 * now holds the name of the rule that fired, which varies per issue. `grammarLint` is what actually
 * makes a diagnostic ours — it is the engine's own lint object, carried by identity, and nothing else
 * on this surface has one. The other lint source here (the nspell spellchecker) sets no `source` at
 * all, so nothing is lost by no longer comparing it.
 */
function isGrammarDiagnostic(diagnostic: { source?: string }): diagnostic is GrammarDiagnostic {
  return 'grammarLint' in diagnostic && 'category' in diagnostic;
}

/**
 * Collect all grammar diagnostics currently in the editor state, in document order, with live
 * positions.
 *
 * @param state - The editor state to read the lint field from.
 * @returns The grammar diagnostics with their current document ranges.
 */
export function collectGrammarDiagnostics(state: EditorState): PositionedGrammarDiagnostic[] {
  const collected: PositionedGrammarDiagnostic[] = [];
  forEachDiagnostic(state, (diagnostic, from, to) => {
    if (isGrammarDiagnostic(diagnostic)) {
      collected.push({ from, to, diagnostic });
    }
  });
  return collected;
}

/**
 * Group diagnostics by their writing-issue category, preserving category display order.
 *
 * @param diagnostics - The diagnostics to group.
 * @returns A map from category to its diagnostics (categories with none are omitted).
 */
export function groupByCategory(
  diagnostics: PositionedGrammarDiagnostic[],
): Map<GrammarCategory, PositionedGrammarDiagnostic[]> {
  const groups = new Map<GrammarCategory, PositionedGrammarDiagnostic[]>();
  for (const category of GRAMMAR_CATEGORIES) {
    const inCategory = diagnostics.filter((entry) => entry.diagnostic.category === category);
    if (inCategory.length > 0) groups.set(category, inCategory);
  }
  return groups;
}

/**
 * Count diagnostics per category (zero for categories with none).
 *
 * @param diagnostics - The diagnostics to count.
 * @returns A record of category to count, plus a `total`.
 */
export function categoryCounts(
  diagnostics: PositionedGrammarDiagnostic[],
): Record<GrammarCategory, number> & { total: number } {
  const counts = { spelling: 0, grammar: 0, style: 0, total: 0 };
  for (const entry of diagnostics) {
    counts[entry.diagnostic.category] += 1;
    counts.total += 1;
  }
  return counts;
}

/** True when two grammar-diagnostic lists are equivalent for the panel (same issues at same positions). */
function sameGrammarDiagnostics(
  a: PositionedGrammarDiagnostic[],
  b: PositionedGrammarDiagnostic[],
): boolean {
  if (a.length !== b.length) return false;
  for (const [index, left] of a.entries()) {
    const right = b[index];
    if (
      left.from !== right.from ||
      left.to !== right.to ||
      left.diagnostic.category !== right.diagnostic.category ||
      left.diagnostic.message !== right.diagnostic.message
    ) {
      return false;
    }
  }
  return true;
}

/**
 * An editor extension that surfaces the current grammar diagnostics to React whenever they actually
 * change. A document edit or an effect-bearing transaction is only a *candidate* for change — many
 * effects are unrelated (selection reveal, compartment reconfigures, heading/review-marker effects) —
 * so the collected diagnostics are compared to the last emitted set and `onChange` fires only when
 * they truly differ. This keeps the panel and status bar from re-rendering on cursor moves and
 * unrelated config toggles.
 *
 * @param onChange - Called with the current grammar diagnostics after a real change.
 * @returns The update-listener extension to add to the editor.
 */
export function grammarDiagnosticsListener(
  onChange: (diagnostics: PositionedGrammarDiagnostic[]) => void,
): Extension {
  let previous: PositionedGrammarDiagnostic[] | null = null;
  return EditorView.updateListener.of((update) => {
    const mayHaveChanged =
      update.docChanged || (update.transactions ?? []).some((transaction) => transaction.effects.length > 0);
    if (!mayHaveChanged) return;
    const next = collectGrammarDiagnostics(update.state);
    if (previous !== null && sameGrammarDiagnostics(previous, next)) return;
    previous = next;
    onChange(next);
  });
}
