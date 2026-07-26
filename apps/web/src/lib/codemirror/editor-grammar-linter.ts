import { linter, forceLinting } from '@codemirror/lint';
import { StateEffect, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { harperLintSource, type HarperLintSourceDeps } from '@/lib/codemirror/harper/harper-linter-source';

/** Debounce (ms) before an edit triggers a re-lint — hides the checking latency from the typing path. */
const GRAMMAR_LINT_DELAY_MS = 400;

/**
 * Marks a transaction as "the grammar inputs changed, re-run the lint source" — the scope toggle, a
 * dictionary reconcile, or an ignored-lints import. Those inputs live outside the document, so without
 * this marker `@codemirror/lint` sees no reason to re-run (it only re-lints on a document change or a
 * lint-config change) and the stale diagnostics stay on screen until the next keystroke.
 */
export const grammarRefreshEffect = StateEffect.define<null>();

/**
 * Re-runs the grammar lint source now, for a change the document itself does not carry. Dispatches
 * {@link grammarRefreshEffect} so the lint plugin schedules a run, then forces that run immediately:
 * these are all discrete user actions (toggling scope, accepting a term, dismissing an issue) where
 * waiting out the typing debounce would only read as the action having failed. Forcing the run also
 * clears the pending debounce timer, so it costs one lint pass, not two.
 *
 * @param view - The editor view to re-lint.
 */
export function refreshGrammarLints(view: EditorView): void {
  view.dispatch({ effects: grammarRefreshEffect.of(null) });
  forceLinting(view);
}

/**
 * Builds the Harper grammar-check lint extension. Shared by the initial extension assembly and the
 * hook's live compartment reconfigure so both produce an identical source. Returns an empty extension
 * when grammar checking is not active, so the compartment is simply emptied to disable it (and the
 * nspell spell-check compartment takes over as the fallback).
 *
 * @param deps - The worker client plus the live dialect/hydration/scope getters, or null when inactive.
 * @returns A CodeMirror lint extension for grammar checking, or an empty extension when inactive.
 */
export function createGrammarLinter(deps: HarperLintSourceDeps | null): Extension {
  if (!deps) return [];
  return linter(harperLintSource(deps), {
    delay: GRAMMAR_LINT_DELAY_MS,
    needsRefresh: (update) =>
      update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(grammarRefreshEffect)),
      ),
  });
}
