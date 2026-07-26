import type { EditorView } from '@codemirror/view';
import type { ChangeSpec } from '@codemirror/state';
import type { Action } from '@codemirror/lint';
import type { EngineSuggestion } from './harper-engine';

/**
 * Applies a grammar suggestion as an ordinary CodeMirror document change. This is the ONE place grammar
 * checking mutates shared content: the change is dispatched through the normal `view.dispatch` path, so
 * `y-codemirror.next` observes it and propagates it as a normal collaborative edit through the CRDT —
 * exactly like a keystroke (research R5). Diagnostics, counts, and tooltips never take this path, which
 * is what keeps grammar feedback out of the shared Yjs document (Principle VII / FR-011).
 *
 * Harper's three suggestion kinds each reduce to a minimal edit on the lint's mapped document span, so
 * we replace just that span rather than rewriting the whole segment (research U2) — the tight edit
 * merges cleanly under a concurrent edit elsewhere in the same region.
 */

/**
 * Compute the minimal document change for applying a suggestion to a lint's mapped `[from, to]` span.
 *
 * @param from - Document offset of the start of the problem span.
 * @param to - Document offset just past the problem span.
 * @param suggestion - The suggestion to apply.
 * @returns The change (replace, delete, or insert-after) to dispatch.
 */
export function suggestionChange(
  from: number,
  to: number,
  suggestion: EngineSuggestion,
): { from: number; to: number; insert: string } {
  if (suggestion.kind === 'insert-after') {
    // Insert the text at the end of the span, leaving the original text in place.
    return { from: to, to, insert: suggestion.text };
  }
  // Replace (or remove, whose replacement text is empty) the problem span.
  return { from, to, insert: suggestion.text };
}

/**
 * Apply a suggestion to the document as a normal editor transaction.
 *
 * Accepting a fix is the ONLY grammar action that writes shared content, so permission is re-checked
 * HERE rather than trusted from whichever surface offered it. `EditorState.readOnly` carries the
 * editor's live effective edit permission (set from `effectiveCanEdit`, which folds in the observer
 * role and a missing collaborative backing), and CodeMirror only applies it to USER input — a
 * programmatic `dispatch` goes straight through. Without this guard a fix chip left on screen by a
 * stale render, a lint action invoked from the keyboard, or any other programmatic caller would edit a
 * document the reader may not change: the collaboration server drops an observer's updates, so the
 * text would silently diverge from everyone else's.
 *
 * @param view - The editor view whose document is edited.
 * @param from - Document offset of the start of the problem span.
 * @param to - Document offset just past the problem span.
 * @param suggestion - The suggestion to apply.
 * @returns Whether the fix was applied; false when the editor is read-only for this reader.
 */
export function applyGrammarSuggestion(
  view: EditorView,
  from: number,
  to: number,
  suggestion: EngineSuggestion,
): boolean {
  if (view.state.readOnly) return false;
  const change: ChangeSpec = suggestionChange(from, to, suggestion);
  view.dispatch({ changes: change });
  return true;
}

/**
 * A short human-readable label for a suggestion, used on the fix chip / action button.
 *
 * @param suggestion - The suggestion to label.
 * @returns The button label (the replacement text, "Remove", or an insertion label).
 */
export function suggestionLabel(suggestion: EngineSuggestion): string {
  if (suggestion.kind === 'remove') return 'Remove';
  if (suggestion.kind === 'insert-after') return `Insert “${suggestion.text}”`;
  return suggestion.text;
}

/**
 * Build the `@codemirror/lint` diagnostic actions for a set of suggestions, so the inline lint tooltip
 * offers each fix as a one-click button. CodeMirror supplies the `(view, from, to)` at click time, so
 * this needs no editor reference.
 *
 * @param suggestions - The suggestions to turn into actions.
 * @returns One action per suggestion that applies it via {@link applyGrammarSuggestion}.
 */
export function grammarSuggestionActions(suggestions: EngineSuggestion[]): Action[] {
  return suggestions.map((suggestion) => ({
    name: suggestionLabel(suggestion),
    apply: (view: EditorView, from: number, to: number) => {
      applyGrammarSuggestion(view, from, to, suggestion);
    },
  }));
}
