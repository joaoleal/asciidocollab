import { linter, forceLinting, type Diagnostic } from '@codemirror/lint';
import { StateEffect, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { harperLintSource, type HarperLintSourceDeps } from '@/lib/codemirror/harper/harper-linter-source';
import { suggestionLabel } from '@/lib/codemirror/harper/apply-suggestion';
import type { GrammarDiagnostic } from '@/lib/codemirror/harper/lint-to-diagnostic';

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
 * The fixes a diagnostic carries, if it is one of ours. `lintToDiagnostic` attaches exactly one lint
 * action per suggestion, in order and BEFORE any the lint source appends afterwards, so this count is
 * also the index at which the non-mutating actions (`Ignore`) begin.
 *
 * Typed as a partial grammar diagnostic rather than narrowed with an assertion: every `Diagnostic` is
 * structurally assignable to it, so a plain one simply reports no suggestions.
 *
 * @param diagnostic - The diagnostic to read.
 * @returns Its suggested fixes, or an empty list for a diagnostic that carries none.
 */
function grammarSuggestions(diagnostic: Partial<GrammarDiagnostic>): GrammarDiagnostic['grammarSuggestions'] {
  return diagnostic.grammarSuggestions ?? [];
}

/**
 * Re-render an issue's tooltip message with its fixes named as plain text.
 *
 * `renderMessage` is the tooltip's own rendering hook, so this changes only what the in-editor popover
 * shows — the Writing panel reads `diagnostic.message` and is unaffected. That separation is the point:
 * the reader must still be able to see what the checker would have changed the text to, which in the
 * built-in tooltip is otherwise visible only as the fix buttons themselves.
 *
 * @param diagnostic - The issue being rendered read-only.
 * @returns A `renderMessage` implementation showing the message plus the suggested corrections.
 */
function renderReadOnlyMessage(diagnostic: Diagnostic & Partial<GrammarDiagnostic>): () => Node {
  const labels = grammarSuggestions(diagnostic).map((suggestion) => `“${suggestionLabel(suggestion)}”`);
  return () => {
    const wrapper = document.createElement('div');
    const message = document.createElement('div');
    message.textContent = diagnostic.message;
    wrapper.append(message);
    if (labels.length > 0) {
      const note = document.createElement('div');
      // <em> rather than a class name: the tooltip is CodeMirror's own DOM, which this app adds no
      // stylesheet to, so a class here would style nothing.
      const emphasis = document.createElement('em');
      emphasis.textContent = `Suggested: ${labels.join(', ')} — read-only, you cannot change this file.`;
      note.append(emphasis);
      wrapper.append(note);
    }
    return wrapper;
  };
}

/**
 * The read-only rendering of one grammar diagnostic: the issue and its suggested corrections stay
 * visible, but the one-click fixes that would edit the document are removed.
 *
 * Only the FIX actions go. Actions appended after them by the lint source are left alone, because they
 * are not writes to shared content — `Ignore` stores a privacy-hashed dismissal against the reader's
 * own user id, is never shown to anyone else, and is authorized server-side for any project member
 * (see `requireDocumentMember`). Taking it away would remove a viewer's only way to quieten a false
 * positive in a document they are reading.
 *
 * @param diagnostic - The diagnostic as produced for an editable document.
 * @returns The same diagnostic with its mutating actions removed and its fixes named in the message.
 */
export function readOnlyGrammarDiagnostic(diagnostic: Diagnostic): Diagnostic {
  const fixCount = grammarSuggestions(diagnostic).length;
  const actions = (diagnostic.actions ?? []).slice(fixCount);
  return {
    ...diagnostic,
    actions,
    renderMessage: renderReadOnlyMessage(diagnostic),
  };
}

/**
 * Builds the Harper grammar-check lint extension. Shared by the initial extension assembly and the
 * hook's live compartment reconfigure so both produce an identical source. Returns an empty extension
 * when grammar checking is not active, so the compartment is simply emptied to disable it (and the
 * nspell spell-check compartment takes over as the fallback).
 *
 * Checking itself is never gated on edit permission — a reader is entitled to see the writing issues in
 * a document they can read — but the fixes offered in the tooltip are, and the state is read from the
 * view on every pass rather than captured here, so a permission change needs no rebuild of the linter.
 *
 * @param deps - The worker client plus the live dialect/hydration/scope getters, or null when inactive.
 * @returns A CodeMirror lint extension for grammar checking, or an empty extension when inactive.
 */
export function createGrammarLinter(deps: HarperLintSourceDeps | null): Extension {
  if (!deps) return [];
  const source = harperLintSource(deps);
  return linter(
    async (view: EditorView): Promise<Diagnostic[]> => {
      const diagnostics = await source(view);
      return view.state.readOnly ? diagnostics.map(readOnlyGrammarDiagnostic) : diagnostics;
    },
    {
      delay: GRAMMAR_LINT_DELAY_MS,
      needsRefresh: (update) =>
        update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(grammarRefreshEffect)),
        ),
    },
  );
}
