/* @jest-environment jsdom */

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { setDiagnostics } from '@codemirror/lint';
import {
  collectGrammarDiagnostics,
  groupByCategory,
  categoryCounts,
  grammarDiagnosticsListener,
  type PositionedGrammarDiagnostic,
} from '@/lib/codemirror/harper/grammar-diagnostics';
import type { GrammarDiagnostic } from '@/lib/codemirror/harper/lint-to-diagnostic';
import type { GrammarCategory } from '@/lib/codemirror/harper/category-colors';

function grammarDiagnostic(from: number, to: number, category: GrammarCategory): GrammarDiagnostic {
  return {
    from,
    to,
    severity: 'info',
    // Now the rule that fired, not the engine's name — CodeMirror shows this under the message.
    source: 'SpellCheck',
    message: 'x',
    category,
    grammarSuggestions: [],
    // Required by `GrammarDiagnostic` and always present in production (`lintToDiagnostic` sets both).
    // `grammarLint` is also what identifies a diagnostic as ours, now that `source` varies per rule.
    // Omitting them went unnoticed because apps/web's jest is transpile-only and tsc excludes tests/.
    grammarLint: {
      span: { start: 0, end: 1 },
      kind: 'Spelling',
      rule: 'SpellCheck',
      message: 'x',
      suggestions: [],
    },
    grammarSegmentText: 'the wrold and a cat',
  };
}

function positioned(category: GrammarCategory): PositionedGrammarDiagnostic {
  return { from: 0, to: 1, diagnostic: grammarDiagnostic(0, 1, category) };
}

describe('collectGrammarDiagnostics', () => {
  test('reads only the grammar-source diagnostics from the lint field, with live positions', () => {
    const view = new EditorView({ state: EditorState.create({ doc: 'the wrold and a cat' }) });
    view.dispatch(
      setDiagnostics(view.state, [
        grammarDiagnostic(4, 9, 'spelling'),
        // A non-grammar diagnostic (e.g. from the cross-file diagnostics source) must be ignored.
        { from: 0, to: 3, severity: 'warning', source: 'asciidoc', message: 'other' },
      ]),
    );
    const collected = collectGrammarDiagnostics(view.state);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ from: 4, to: 9 });
    expect(collected[0].diagnostic.category).toBe('spelling');
    view.destroy();
  });
});

describe('groupByCategory', () => {
  test('groups by category in display order and omits empty categories', () => {
    const groups = groupByCategory([positioned('style'), positioned('spelling'), positioned('spelling')]);
    expect([...groups.keys()]).toEqual(['spelling', 'style']); // grammar omitted; spelling before style
    expect(groups.get('spelling')).toHaveLength(2);
  });
});

describe('categoryCounts', () => {
  test('counts per category plus a total', () => {
    const counts = categoryCounts([positioned('spelling'), positioned('grammar'), positioned('spelling')]);
    expect(counts).toEqual({ spelling: 2, grammar: 1, style: 0, total: 3 });
  });
});

describe('grammarDiagnosticsListener', () => {
  test('reports the diagnostics when a lint transaction updates them', () => {
    const seen: PositionedGrammarDiagnostic[][] = [];
    const view = new EditorView({
      state: EditorState.create({
        doc: 'the wrold',
        extensions: [grammarDiagnosticsListener((diagnostics) => seen.push(diagnostics))],
      }),
    });
    view.dispatch(setDiagnostics(view.state, [grammarDiagnostic(4, 9, 'spelling')]));
    const last = seen.at(-1);
    expect(last).toHaveLength(1);
    expect(last?.[0].diagnostic.category).toBe('spelling');
    view.destroy();
  });

  test('does not re-emit when an effect-bearing transaction leaves the diagnostics unchanged', () => {
    let emits = 0;
    const view = new EditorView({
      state: EditorState.create({
        doc: 'the wrold',
        extensions: [grammarDiagnosticsListener(() => emits++)],
      }),
    });
    view.dispatch(setDiagnostics(view.state, [grammarDiagnostic(4, 9, 'spelling')]));
    expect(emits).toBe(1);
    // Re-applying the SAME diagnostics is an effect-bearing transaction but changes nothing the panel
    // shows — it must not trigger another emit (which would re-render the panel needlessly).
    view.dispatch(setDiagnostics(view.state, [grammarDiagnostic(4, 9, 'spelling')]));
    expect(emits).toBe(1);
    view.destroy();
  });

  test('re-emits when the diagnostics actually change', () => {
    let emits = 0;
    const view = new EditorView({
      state: EditorState.create({
        doc: 'the wrold and teh cat',
        extensions: [grammarDiagnosticsListener(() => emits++)],
      }),
    });
    view.dispatch(setDiagnostics(view.state, [grammarDiagnostic(4, 9, 'spelling')]));
    expect(emits).toBe(1);
    view.dispatch(setDiagnostics(view.state, [grammarDiagnostic(4, 9, 'spelling'), grammarDiagnostic(14, 17, 'spelling')]));
    expect(emits).toBe(2);
    view.destroy();
  });
});
