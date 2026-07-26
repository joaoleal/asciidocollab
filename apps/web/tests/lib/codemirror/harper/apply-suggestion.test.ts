/* @jest-environment jsdom */

import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  suggestionChange,
  applyGrammarSuggestion,
  suggestionLabel,
  grammarSuggestionActions,
} from '@/lib/codemirror/harper/apply-suggestion';
import type { EngineSuggestion } from '@/lib/codemirror/harper/harper-engine';

const replace = (text: string): EngineSuggestion => ({ text, kind: 'replace' });
const remove = (): EngineSuggestion => ({ text: '', kind: 'remove' });
const insertAfter = (text: string): EngineSuggestion => ({ text, kind: 'insert-after' });

/** A view over `text` that the reader may not edit — what an observer/viewer gets. */
function readOnlyView(text: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc: text, extensions: [EditorState.readOnly.of(true)] }),
  });
}

describe('suggestionChange', () => {
  test('a replace suggestion swaps the problem span for the replacement text', () => {
    expect(suggestionChange(2, 5, replace('world'))).toEqual({ from: 2, to: 5, insert: 'world' });
  });

  test('a remove suggestion deletes the problem span', () => {
    expect(suggestionChange(4, 9, remove())).toEqual({ from: 4, to: 9, insert: '' });
  });

  test('an insert-after suggestion inserts at the end of the span without deleting it', () => {
    expect(suggestionChange(2, 5, insertAfter(','))).toEqual({ from: 5, to: 5, insert: ',' });
  });
});

describe('applyGrammarSuggestion', () => {
  test('applies the fix as an ordinary document change', () => {
    const view = new EditorView({ state: EditorState.create({ doc: 'a wrold here' }) });
    applyGrammarSuggestion(view, 2, 7, replace('world'));
    expect(view.state.doc.toString()).toBe('a world here');
    view.destroy();
  });

  test('applies the fix as a real document change an update listener observes (the only shared write)', () => {
    const documentChanges: string[] = [];
    const observer = EditorView.updateListener.of((update) => {
      if (update.docChanged) documentChanges.push(update.state.doc.toString());
    });
    const view = new EditorView({ state: EditorState.create({ doc: 'a wrold here', extensions: [observer] }) });
    applyGrammarSuggestion(view, 2, 7, replace('world'));
    // Exactly one document change, carrying the correction — the same path a keystroke takes, so
    // y-codemirror.next propagates it as an ordinary collaborative edit.
    expect(documentChanges).toEqual(['a world here']);
    view.destroy();
  });

  // Accepting a fix is the ONE grammar action that writes shared content, and CodeMirror's readOnly
  // facet only refuses USER input — a programmatic dispatch goes straight through it. Before this
  // guard, a viewer/observer could click a fix chip (or a lint tooltip action) and the document
  // actually changed under them, diverging from the copy the collaboration server keeps.
  describe('a read-only editor', () => {
    test('refuses the fix and leaves the document untouched', () => {
      const view = readOnlyView('a wrold here');
      expect(applyGrammarSuggestion(view, 2, 7, replace('world'))).toBe(false);
      expect(view.state.doc.toString()).toBe('a wrold here');
      view.destroy();
    });

    test('dispatches no transaction at all, so no collaborator sees an edit', () => {
      const documentChanges: string[] = [];
      const observer = EditorView.updateListener.of((update) => {
        if (update.docChanged) documentChanges.push(update.state.doc.toString());
      });
      const view = new EditorView({
        state: EditorState.create({ doc: 'a wrold here', extensions: [EditorState.readOnly.of(true), observer] }),
      });
      applyGrammarSuggestion(view, 2, 7, replace('world'));
      expect(documentChanges).toEqual([]);
      view.destroy();
    });

    test('refuses every suggestion kind, not only replacements', () => {
      const view = readOnlyView('a wrold here');
      expect(applyGrammarSuggestion(view, 2, 7, remove())).toBe(false);
      expect(applyGrammarSuggestion(view, 2, 7, insertAfter(','))).toBe(false);
      expect(view.state.doc.toString()).toBe('a wrold here');
      view.destroy();
    });

    test('applies again as soon as the reader regains permission', () => {
      // The check reads the view's live state rather than anything captured when the fix was offered,
      // so an observer promoted mid-session does not have to reopen the file.
      const readOnly = new Compartment();
      const view = new EditorView({
        state: EditorState.create({
          doc: 'a wrold here',
          extensions: [readOnly.of(EditorState.readOnly.of(true))],
        }),
      });
      expect(applyGrammarSuggestion(view, 2, 7, replace('world'))).toBe(false);
      view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(false)) });
      expect(applyGrammarSuggestion(view, 2, 7, replace('world'))).toBe(true);
      expect(view.state.doc.toString()).toBe('a world here');
      view.destroy();
    });
  });
});

describe('suggestionLabel', () => {
  test('labels each suggestion kind for a fix button', () => {
    expect(suggestionLabel(replace('world'))).toBe('world');
    expect(suggestionLabel(remove())).toBe('Remove');
    expect(suggestionLabel(insertAfter(','))).toBe('Insert “,”');
  });
});

describe('grammarSuggestionActions', () => {
  test('builds one lint action per suggestion that applies the fix on click', () => {
    const actions = grammarSuggestionActions([replace('world')]);
    expect(actions).toHaveLength(1);
    expect(actions[0].name).toBe('world');
    const view = new EditorView({ state: EditorState.create({ doc: 'a wrold here' }) });
    actions[0].apply(view, 2, 7);
    expect(view.state.doc.toString()).toBe('a world here');
    view.destroy();
  });

  test('the action refuses on a read-only editor, so a stale tooltip cannot edit the document', () => {
    // The linter strips these actions for a reader who may not edit, but the action itself must also
    // refuse: a tooltip rendered before the permission changed is still on screen and still clickable.
    const actions = grammarSuggestionActions([replace('world')]);
    const view = new EditorView({
      state: EditorState.create({ doc: 'a wrold here', extensions: [EditorState.readOnly.of(true)] }),
    });
    actions[0].apply(view, 2, 7);
    expect(view.state.doc.toString()).toBe('a wrold here');
    view.destroy();
  });
});
