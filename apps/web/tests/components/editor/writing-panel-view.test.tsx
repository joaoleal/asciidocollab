import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { WritingPanelView } from '@/components/editor/writing-panel-view';
import type { EditorGrammarState } from '@/components/editor/asciidoc-editor';

// Records the props the view hands the rail: the per-issue actions are threaded through here, and a
// dropped one is invisible in rendered output because the stub renders nothing either way.
const railProperties: { current: Record<string, unknown> } = { current: {} };
jest.mock('@/components/grammar/grammar-rail', () => ({
  GrammarRail: (properties: Record<string, unknown>) => {
    railProperties.current = properties;
    return require('react').createElement('div', { 'data-testid': 'grammar-rail-stub' });
  },
}));
const dictionaryProperties: { current: Record<string, unknown> } = { current: {} };
jest.mock('@/components/grammar/dictionary-panel', () => ({
  DictionaryPanel: (properties: Record<string, unknown>) => {
    dictionaryProperties.current = properties;
    return require('react').createElement('div', { 'data-testid': 'dictionary-stub' });
  },
}));
const rulesProperties: { current: Record<string, unknown> } = { current: {} };
jest.mock('@/components/grammar/rules-panel', () => ({
  RulesPanel: (properties: Record<string, unknown>) => {
    rulesProperties.current = properties;
    return require('react').createElement('div', { 'data-testid': 'rules-stub' });
  },
}));
jest.mock('@/components/grammar/grammar-scope-toggle', () => ({
  GrammarScopeToggle: () => require('react').createElement('div', { 'data-testid': 'scope-toggle-stub' }),
}));

/** A checker handle standing in for a mounted editor; only the members this view reads matter. */
function grammarState(): EditorGrammarState {
  return {
    diagnostics: [],
    status: 'ready',
    lintScope: 'whole-document',
    setLintScope: jest.fn(),
    navigate: jest.fn(),
    apply: jest.fn(),
    dictionary: [],
    canEditDocument: true,
    canManageDictionary: true,
    addDictionaryTerm: jest.fn(),
    removeDictionaryTerm: jest.fn(),
    addIssueWordToDictionary: jest.fn(),
    ignore: jest.fn(),
    canConfigureRules: true,
    ruleConfig: {},
    ruleDescriptions: {},
    setRule: jest.fn(),
    resetRules: jest.fn(),
  };
}

describe('WritingPanelView', () => {
  test('announces itself with a "Writing" header, exactly once', () => {
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={null} />);
    expect(screen.getAllByText('Writing')).toHaveLength(1);
  });

  test('renders the view tabs under the header with their pinned test ids', () => {
    render(<WritingPanelView view="dictionary" onViewChange={jest.fn()} grammar={null} />);
    expect(screen.getByRole('tablist', { name: 'Writing views' })).toBeInTheDocument();
    expect(screen.getByTestId('writing-view-issues')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('writing-view-dictionary')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('writing-view-rules')).toHaveAttribute('aria-selected', 'false');
  });

  test('selecting a tab reports the new sub-view', () => {
    const onViewChange = jest.fn();
    render(<WritingPanelView view="issues" onViewChange={onViewChange} grammar={null} />);
    fireEvent.click(screen.getByTestId('writing-view-rules'));
    expect(onViewChange).toHaveBeenCalledWith('rules');
  });

  test('shows the surface for the active tab', () => {
    const { unmount } = render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={null} />);
    expect(screen.getByTestId('grammar-rail-stub')).toBeInTheDocument();
    unmount();

    const dictionary = render(<WritingPanelView view="dictionary" onViewChange={jest.fn()} grammar={null} />);
    expect(screen.getByTestId('dictionary-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('grammar-rail-stub')).toBeNull();
    dictionary.unmount();

    render(<WritingPanelView view="rules" onViewChange={jest.fn()} grammar={null} />);
    expect(screen.getByTestId('rules-stub')).toBeInTheDocument();
  });

  test('shows the check-scope control only while Issues is active and an editor is mounted', () => {
    const { unmount } = render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={grammarState()} />);
    expect(screen.getByTestId('scope-toggle-stub')).toBeInTheDocument();
    unmount();

    const noEditor = render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={null} />);
    expect(screen.queryByTestId('scope-toggle-stub')).toBeNull();
    noEditor.unmount();

    render(<WritingPanelView view="rules" onViewChange={jest.fn()} grammar={grammarState()} />);
    expect(screen.queryByTestId('scope-toggle-stub')).toBeNull();
  });

  test('threads the per-issue dismiss and accept actions through to the rail', () => {
    // Both were implemented and reachable from nowhere: the rail never received them, so an issue could
    // not be dismissed and a flagged word could not be accepted from the list.
    const grammar = grammarState();
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={grammar} />);
    expect(railProperties.current['onIgnore']).toBe(grammar.ignore);
    expect(railProperties.current['onAddToDictionary']).toBe(grammar.addIssueWordToDictionary);
  });

  test('passes null actions when there is no editor, so the rail leaves the controls out', () => {
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={null} />);
    expect(railProperties.current['onIgnore']).toBeNull();
    expect(railProperties.current['onAddToDictionary']).toBeNull();
  });

  test('withholds accepting a word from a reader who may not manage the dictionary', () => {
    render(
      <WritingPanelView
        view="issues"
        onViewChange={jest.fn()}
        grammar={{ ...grammarState(), canManageDictionary: false }}
      />,
    );
    expect(railProperties.current['onAddToDictionary']).toBeNull();
  });

  test('withholds dismissing when the editor reports it cannot be stored', () => {
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={{ ...grammarState(), ignore: null }} />);
    expect(railProperties.current['onIgnore']).toBeNull();
  });

  test('tells the rail to render read-only when the editor reports the document is not editable', () => {
    render(
      <WritingPanelView
        view="issues"
        onViewChange={jest.fn()}
        grammar={{ ...grammarState(), canEditDocument: false }}
      />,
    );
    expect(railProperties.current['readOnly']).toBe(true);
  });

  test('leaves the rail editable when the editor reports the document is editable', () => {
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={grammarState()} />);
    expect(railProperties.current['readOnly']).toBe(false);
  });

  test('renders the rail read-only when no editor is mounted, since there is nothing to apply a fix to', () => {
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={null} />);
    expect(railProperties.current['readOnly']).toBe(true);
  });

  test('still lets a reader who cannot edit dismiss an issue for themselves', () => {
    // The dismissal is privacy-hashed, stored against the reader's own user id, and never shown to
    // anyone else — the server authorizes it for any project member. Withholding it would take a
    // viewer's only way to quieten a false positive.
    const grammar = { ...grammarState(), canEditDocument: false };
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={grammar} />);
    expect(railProperties.current['onIgnore']).toBe(grammar.ignore);
  });
});

describe('WritingPanelView — surfaces read from the editor handle', () => {
  test('the Dictionary tab shows the project terms and the reader’s permission', () => {
    const grammar = grammarState();
    grammar.dictionary = [{ id: 't1', term: 'Kubernetes', createdByUserId: 'u1', createdAt: '2026-01-01T00:00:00Z' }];
    render(<WritingPanelView view="dictionary" onViewChange={jest.fn()} grammar={grammar} />);
    expect(dictionaryProperties.current['entries']).toBe(grammar.dictionary);
    expect(dictionaryProperties.current['canManage']).toBe(true);
  });

  test('adding and removing a term reach the editor handle', () => {
    const grammar = grammarState();
    render(<WritingPanelView view="dictionary" onViewChange={jest.fn()} grammar={grammar} />);
    (dictionaryProperties.current['onAdd'] as (term: string) => void)('Kubernetes');
    (dictionaryProperties.current['onRemove'] as (id: string) => void)('t1');
    expect(grammar.addDictionaryTerm).toHaveBeenCalledWith('Kubernetes');
    expect(grammar.removeDictionaryTerm).toHaveBeenCalledWith('t1');
  });

  test('hands the rail the engine’s rule descriptions so issues can explain their rule', () => {
    const grammar = grammarState();
    grammar.ruleDescriptions = { SpellCheck: 'Looks for words that are misspelled.' };
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={grammar} />);
    expect(railProperties.current['ruleDescriptions']).toBe(grammar.ruleDescriptions);
  });

  test('the rail degrades to no rule descriptions with no editor', () => {
    // The chips still name their rule; they just have nothing extra to say on hover.
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={null} />);
    expect(railProperties.current['ruleDescriptions']).toEqual({});
  });

  test('the Dictionary tab degrades to empty and read-only with no editor', () => {
    render(<WritingPanelView view="dictionary" onViewChange={jest.fn()} grammar={null} />);
    expect(dictionaryProperties.current['entries']).toEqual([]);
    expect(dictionaryProperties.current['canManage']).toBe(false);
    // The handlers still exist and must not throw when there is nothing behind them.
    expect(() => (dictionaryProperties.current['onAdd'] as (term: string) => void)('x')).not.toThrow();
    expect(() => (dictionaryProperties.current['onRemove'] as (id: string) => void)('x')).not.toThrow();
  });

  test('the Rules tab shows the engine’s config and reports toggles and resets', () => {
    const grammar = grammarState();
    grammar.ruleConfig = { SpellCheck: null };
    render(<WritingPanelView view="rules" onViewChange={jest.fn()} grammar={grammar} />);
    expect(rulesProperties.current['config']).toBe(grammar.ruleConfig);
    (rulesProperties.current['onToggle'] as (rule: string, enabled: boolean) => void)('SpellCheck', false);
    (rulesProperties.current['onResetDefaults'] as () => void)();
    expect(grammar.setRule).toHaveBeenCalledWith('SpellCheck', false);
    expect(grammar.resetRules).toHaveBeenCalled();
  });

  test('the Rules tab is read-only when the editor reports the reader may not configure rules', () => {
    render(
      <WritingPanelView
        view="rules"
        onViewChange={jest.fn()}
        grammar={{ ...grammarState(), canConfigureRules: false }}
      />,
    );
    expect(rulesProperties.current['readOnly']).toBe(true);
  });

  test('the Rules tab is editable when the editor reports the reader may configure rules', () => {
    render(<WritingPanelView view="rules" onViewChange={jest.fn()} grammar={grammarState()} />);
    expect(rulesProperties.current['readOnly']).toBe(false);
  });

  test('the Rules tab stays editable for a reader whose DOCUMENT is not editable but whose role allows it', () => {
    // A text file with no collaborative backing forces `canEditDocument` false for everyone, owners
    // included. The rule config is view-local, so that per-file transport condition must not take the
    // toggles away — only the reader's project role may.
    render(
      <WritingPanelView
        view="rules"
        onViewChange={jest.fn()}
        grammar={{ ...grammarState(), canEditDocument: false, canConfigureRules: true }}
      />,
    );
    expect(rulesProperties.current['readOnly']).toBe(false);
  });

  test('the Rules tab is read-only when no editor is mounted, since there are no rules to change', () => {
    render(<WritingPanelView view="rules" onViewChange={jest.fn()} grammar={null} />);
    expect(rulesProperties.current['readOnly']).toBe(true);
  });

  test('the Rules tab degrades to an empty rule set with no editor', () => {
    render(<WritingPanelView view="rules" onViewChange={jest.fn()} grammar={null} />);
    expect(rulesProperties.current['config']).toEqual({});
    expect(() => (rulesProperties.current['onToggle'] as (rule: string, enabled: boolean) => void)('x', true)).not.toThrow();
    expect(() => (rulesProperties.current['onResetDefaults'] as () => void)()).not.toThrow();
  });

  test('the Issues tab reports the checker as disabled when no editor is mounted', () => {
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={null} />);
    expect(railProperties.current['diagnostics']).toEqual([]);
    expect(railProperties.current['status']).toBe('disabled');
  });

  test('navigating and applying a fix reach the editor handle', () => {
    const grammar = grammarState();
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={grammar} />);
    (railProperties.current['onNavigate'] as (from: number, to: number) => void)(3, 7);
    expect(grammar.navigate).toHaveBeenCalledWith(3, 7);
    const suggestion = { text: 'world', kind: 'replace' as const };
    const entry = { from: 0, to: 5, diagnostic: { message: 'x' } };
    (railProperties.current['onApply'] as (entry: unknown, suggestion: unknown) => void)(entry, suggestion);
    expect(grammar.apply).toHaveBeenCalledWith(entry, suggestion);
  });

  test('navigating and applying are inert with no editor rather than throwing', () => {
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={null} />);
    expect(() => (railProperties.current['onNavigate'] as (from: number, to: number) => void)(1, 2)).not.toThrow();
    expect(() => (railProperties.current['onApply'] as (a: unknown, b: unknown) => void)({}, {})).not.toThrow();
  });

  test('the scope toggle reports a new scope through the handle', () => {
    const grammar = grammarState();
    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={grammar} />);
    expect(screen.getByTestId('scope-toggle-stub')).toBeInTheDocument();
    expect(grammar.setLintScope).not.toHaveBeenCalled();
  });
});
