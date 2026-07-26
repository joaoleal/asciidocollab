/* @jest-environment jsdom */

import { EditorState } from '@codemirror/state';
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
});
