import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { CollabBinding } from '@/components/editor/asciidoc-editor';

// Coverage for the AsciiDoc editor's collaboration path: collab binding threading
// (collabExtension/remountKey), observer read-only gating, collab-unavailable banner,
// the presence bar, and the change/retry/draft handlers that branch on projectId/fileNodeId.

// Reuse the same CodeMirror mock shape as the main editor suite so the component can mount.
jest.mock('@codemirror/view', () => ({
  EditorView: class MockEditorView {
    dom: HTMLDivElement;
    scrollDOM: HTMLDivElement;
    state: { doc: { toString: () => string; length: number }; readOnly: boolean };
    constructor({ state, parent }: { state: { doc: { toString: () => string }; readOnly?: boolean }; parent: HTMLElement }) {
      const readOnly = !!state.readOnly;
      this.dom = document.createElement('div');
      this.dom.setAttribute('contenteditable', readOnly ? 'false' : 'true');
      this.dom.dataset['testid'] = 'cm-editor';
      this.dom.textContent = state.doc.toString();
      this.scrollDOM = document.createElement('div');
      this.state = { doc: { toString: () => state.doc.toString(), length: state.doc.toString().length }, readOnly };
      parent.append(this.dom);
    }
    dispatch() { /* no-op */ }
    destroy() { this.dom.remove(); }
  },
  keymap: { of: () => ({}) },
  hoverTooltip: () => ({}),
  lineNumbers: () => ({}),
  highlightActiveLine: () => ({}),
  highlightSpecialChars: () => ({}),
  drawSelection: () => ({}),
  dropCursor: () => ({}),
  rectangularSelection: () => ({}),
  foldGutter: () => ({}),
  crosshairCursor: () => ({}),
  highlightActiveLineGutter: () => ({}),
  ViewPlugin: { fromClass: () => ({}), define: () => ({}) },
  Decoration: { line: () => ({}), replace: () => ({}), none: { update: () => ({}) } },
  WidgetType: class {},
  GutterMarker: class {},
  gutter: () => ({}),
  EditorView_lineWrapping: {},
}));

jest.mock('@codemirror/language-data', () => ({ languages: [] }));
jest.mock('@codemirror/lint', () => ({ linter: () => ({}), lintGutter: () => ({}) }));
jest.mock('@codemirror/state', () => ({
  EditorState: {
    create: (config: { doc: string; extensions?: unknown[] }) => ({ doc: { toString: () => config.doc }, readOnly: false, _extensions: config.extensions ?? [] }),
    readOnly: { of: (value: boolean) => ({ readOnly: value }) },
  },
  StateField: { define: () => ({ field: true }) },
  Facet: { define: () => ({ of: (value: unknown) => ({ facet: value }) }) },
  StateEffect: { appendConfig: { of: (extension: unknown) => ({ appendConfig: extension }) }, define: () => ({ of: (value: unknown) => ({ value }) }) },
  Compartment: class { of(extension: unknown) { return extension; } reconfigure(extension: unknown) { return extension; } },
  Prec: { highest: (extension: unknown) => extension, high: (extension: unknown) => extension, default: (extension: unknown) => extension, low: (extension: unknown) => extension, lowest: (extension: unknown) => extension },
}));
jest.mock('@codemirror/commands', () => ({ history: () => ({}), defaultKeymap: [], historyKeymap: [] }));
jest.mock('@codemirror/language', () => ({ codeFolding: () => ({}), foldGutter: () => ({}), syntaxHighlighting: () => ({}), defaultHighlightStyle: {} }));
jest.mock('@codemirror/search', () => ({ search: () => ({}), searchKeymap: [] }));
jest.mock('@codemirror/autocomplete', () => ({ autocompletion: () => ({}), completionKeymap: [] }));
jest.mock('@/lib/codemirror/asciidoc-language', () => ({ asciidoc: () => ({}) }));
jest.mock('@/components/editor/editor-collab-extensions', () => ({
  collabExtensions: jest.fn(() => ({})),
  COLLAB_YTEXT_KEY: 'codemirror',
}));
jest.mock('@/lib/codemirror/asciidoc-completions', () => {
  const noopSource = jest.fn();
  return {
    createAttributeCompletionSource: jest.fn(() => noopSource),
    createXrefCompletionSource: jest.fn(() => noopSource),
    attributeCompletionSource: noopSource,
    xrefCompletionSource: noopSource,
    sourceLanguageCompletionSource: noopSource,
    tableSnippetCompletionSource: noopSource,
    tableCellCompletionSource: noopSource,
    captionCompletionSource: noopSource,
    createIncludeCompletionSource: jest.fn(() => noopSource),
    createImageCompletionSource: jest.fn(() => noopSource),
  };
});
jest.mock('@/lib/codemirror/asciidoc-link-handler', () => ({ createLinkHandler: () => ({ handleMousedown: jest.fn() }) }));
jest.mock('@/hooks/use-include-completions', () => ({ useIncludeCompletions: () => [], useImagePaths: () => [] }));
jest.mock('@/hooks/use-section-outline', () => ({
  useSectionOutline: jest.fn(() => ({ entries: [], effectiveScope: 'current', unresolved: [] })),
}));
jest.mock('@/lib/codemirror/asciidoc-outline', () => ({ outlineField: { field: true } }));
jest.mock('@replit/codemirror-minimap', () => ({ showMinimap: { of: () => ({}) } }));
jest.mock('@/lib/codemirror/asciidoc-theme', () => ({ asciidocTheme: [] }));
jest.mock('@/lib/codemirror/asciidoc-fold', () => ({ asciidocFold: {} }));
jest.mock('@/lib/codemirror/asciidoc-table-context', () => ({ tableContextField: { field: true } }));

jest.mock('@/hooks/use-editor-preferences', () => ({
  useEditorPreferences: () => ({ fontSize: 14, theme: 'default', softWrap: true, spellIgnore: [], setFontSize: jest.fn(), setTheme: jest.fn(), setSoftWrap: jest.fn() }),
}));

// Surface the collab presence bar so we can assert it renders on the collab path.
jest.mock('@/components/editor/collab-presence-bar', () => ({
  CollabPresenceBar: () => <div data-testid="presence-bar" />,
}));

// Capture the table context so the context-toolbar branch can be exercised.
let mockTableContext: { tableFrom: number; tableTo: number } | null = null;
jest.mock('@/hooks/use-table-context', () => ({ useTableContext: () => mockTableContext }));
jest.mock('@/components/editor/editor-table-context-toolbar', () => ({
  EditorTableContextToolbar: () => <div data-testid="table-toolbar" />,
}));

// The two grammar hooks that would otherwise reach the network on every render of this suite. Their
// real behaviour is covered in the main editor suite; here they only have to settle.
jest.mock('@/hooks/use-grammar-settings', () => ({
  useGrammarSettings: () => ({ enabled: false, languageIsEnglish: false, dialect: 'en-GB', loaded: true }),
}));
jest.mock('@/hooks/use-ignored-lints', () => ({
  useIgnoredLints: () => ({ blob: '', loading: false, error: null, save: jest.fn(async () => true) }),
}));

// The project dictionary is shared content, so its two writes are captured to prove a reader who may
// not manage it never reaches them.
const mockAddDictionaryTerm = jest.fn(async () => true);
const mockRemoveDictionaryTerm = jest.fn(async () => true);
jest.mock('@/hooks/use-project-dictionary', () => ({
  useProjectDictionary: () => ({
    entries: [{ id: 't1', term: 'Kubernetes', createdByUserId: 'u1', createdAt: '2026-01-01T00:00:00Z' }],
    terms: ['Kubernetes'],
    loading: false,
    error: null,
    addTerm: mockAddDictionaryTerm,
    removeTerm: mockRemoveDictionaryTerm,
    refetch: jest.fn(),
  }),
}));

// Capture the mount-hook inputs so we can assert collabExtension/remountKey threading. The view's
// dispatch is module-scoped so a document edit attempted through the grammar panel is observable.
const mockViewDispatch = jest.fn();
const mountSpy = jest.fn();
// The Harper worker handle the rule-config writes go through. Stubbed so `setRule`/`resetRules` are
// observable: without it `getHarperClient()` yields nothing and both bail before their permission
// guard is reached, which would make a "no write happened" assertion pass for the wrong reason.
const mockSetLintConfig = jest.fn();
const mockHarperClient = {
  getLintConfig: jest.fn(() => Promise.resolve({ SpellCheck: null })),
  getLintDescriptions: jest.fn(() => Promise.resolve({})),
  setLintConfig: mockSetLintConfig,
};

jest.mock('@/hooks/use-editor-mount', () => ({
  useEditorMount: (options: Record<string, unknown>) => {
    mountSpy(options);
    const containerReference = { current: document.createElement('div') };
    const viewReference = {
      current: {
        state: {
          doc: { toString: () => 'live content', length: 12, sliceString: () => 'tbl' },
          // What the flagged span holds, read by "add this word to the dictionary".
          sliceDoc: () => 'wrold',
        },
        dispatch: mockViewDispatch,
      },
    };
    return {
      containerReference,
      viewReference,
      handleHeadingClick: jest.fn(),
      getHarperClient: () => mockHarperClient,
    };
  },
}));

/**
 * The document-changing transactions the view received. The editor dispatches effect-only transactions
 * of its own on mount (review ranges, the active review), so "nothing was edited" has to mean "no
 * transaction carried changes", not "nothing was dispatched".
 */
function documentEdits(): unknown[] {
  return mockViewDispatch.mock.calls
    .map((call) => call[0])
    .filter((transaction) => transaction != null && 'changes' in (transaction as object));
}

const mockSave = jest.fn();
let capturedDraftRecovered: ((draft: string) => void) | undefined;
let capturedExternalChange: (() => void) | undefined;
jest.mock('@/hooks/use-auto-save', () => ({
  useAutoSave: jest.fn((options: { onDraftRecovered?: (d: string) => void; onExternalChange?: () => void }) => {
    capturedDraftRecovered = options.onDraftRecovered;
    capturedExternalChange = options.onExternalChange;
    return { saveState: 'saved', save: mockSave };
  }),
}));

import { AsciiDocEditor } from '@/components/editor/asciidoc-editor';
import { useAutoSave } from '@/hooks/use-auto-save';
const mockUseAutoSave = useAutoSave as jest.Mock;

function makeBinding(role: 'editor' | 'observer'): CollabBinding {
  return {
    doc: {} as unknown as Y.Doc,
    awareness: {} as unknown as Awareness,
    connectionState: 'synced',
    role,
    yjsStateId: 'y-room-1',
  };
}

beforeEach(() => {
  mountSpy.mockClear();
  mockSave.mockClear();
  mockUseAutoSave.mockClear();
  mockViewDispatch.mockClear();
  mockAddDictionaryTerm.mockClear();
  mockRemoveDictionaryTerm.mockClear();
  mockSetLintConfig.mockClear();
  mockTableContext = null;
  capturedDraftRecovered = undefined;
  capturedExternalChange = undefined;
});

describe('AsciiDocEditor — collaboration path', () => {
  test('threads the collab extension and the room id as the remount key into the mount hook', () => {
    render(<AsciiDocEditor content="x" canEdit collab={makeBinding('editor')} projectId="p1" fileNodeId="f1" />);
    const options = mountSpy.mock.calls.at(-1)?.[0];
    expect(options.collabExtension).toBeDefined();
    expect(options.remountKey).toBe('y-room-1');
  });

  test('renders the presence bar when a collab binding is present', () => {
    render(<AsciiDocEditor content="x" canEdit collab={makeBinding('editor')} projectId="p1" fileNodeId="f1" />);
    expect(screen.getByTestId('presence-bar')).toBeInTheDocument();
  });

  test('disables autosave on the collab path (collaboration server owns persistence)', () => {
    render(<AsciiDocEditor content="x" canEdit collab={makeBinding('editor')} projectId="p1" fileNodeId="f1" />);
    expect(mockUseAutoSave).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  test('an observer gets a read-only editor even when canEdit is true', () => {
    render(<AsciiDocEditor content="x" canEdit collab={makeBinding('observer')} projectId="p1" fileNodeId="f1" />);
    expect(mountSpy.mock.calls.at(-1)?.[0].canEdit).toBe(false);
  });

  test('passes the initial etag through to autosave when provided', () => {
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" initialEtag="etag-123" />);
    expect(mockUseAutoSave).toHaveBeenCalledWith(expect.objectContaining({ initialEtag: 'etag-123' }));
  });
});

describe('AsciiDocEditor — collab-unavailable read-only fallback', () => {
  test('forces read-only and disables autosave', () => {
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" collabUnavailable />);
    expect(mountSpy.mock.calls.at(-1)?.[0].canEdit).toBe(false);
    expect(mockUseAutoSave).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});

describe('AsciiDocEditor — change handler branches', () => {
  test('a change saves and forwards to onChange when projectId+fileNodeId are set', () => {
    const onChange = jest.fn();
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" onChange={onChange} />);
    const onDocChange = mountSpy.mock.calls.at(-1)?.[0].onDocChange;
    act(() => { onDocChange('typed'); });
    expect(mockSave).toHaveBeenCalledWith('typed');
    expect(onChange).toHaveBeenCalledWith('typed');
  });

  test('a change without projectId/fileNodeId still forwards to onChange but does not save', () => {
    const onChange = jest.fn();
    render(<AsciiDocEditor content="x" canEdit onChange={onChange} />);
    const onDocChange = mountSpy.mock.calls.at(-1)?.[0].onDocChange;
    act(() => { onDocChange('typed'); });
    expect(mockSave).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('typed');
  });

  test('cursor changes report the line up for persistence', () => {
    const onCursorLineChange = jest.fn();
    render(<AsciiDocEditor content="x" canEdit onCursorLineChange={onCursorLineChange} />);
    const onCursorChange = mountSpy.mock.calls.at(-1)?.[0].onCursorChange;
    act(() => { onCursorChange({ line: 4, col: 2, totalLines: 10 }); });
    expect(onCursorLineChange).toHaveBeenCalledWith(4);
  });
});

describe('AsciiDocEditor — table context toolbar', () => {
  test('renders the table toolbar when an editable table context is active', () => {
    mockTableContext = { tableFrom: 0, tableTo: 3 };
    render(<AsciiDocEditor content="|===" canEdit projectId="p1" fileNodeId="f1" />);
    expect(screen.getByTestId('table-toolbar')).toBeInTheDocument();
  });

  test('hides the table toolbar for a read-only (observer) editor', () => {
    mockTableContext = { tableFrom: 0, tableTo: 3 };
    render(<AsciiDocEditor content="|===" canEdit collab={makeBinding('observer')} projectId="p1" fileNodeId="f1" />);
    expect(screen.queryByTestId('table-toolbar')).not.toBeInTheDocument();
  });
});

describe('AsciiDocEditor — retry & draft handlers', () => {
  afterEach(() => {
    mockUseAutoSave.mockImplementation((options: { onDraftRecovered?: (d: string) => void; onExternalChange?: () => void }) => {
      capturedDraftRecovered = options.onDraftRecovered;
      capturedExternalChange = options.onExternalChange;
      return { saveState: 'saved', save: mockSave };
    });
  });

  test('retry saves the current editor view content', () => {
    mockUseAutoSave.mockReturnValue({ saveState: 'error', save: mockSave });
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" />);
    fireEvent.click(screen.getByRole('button', { name: /retry save/i }));
    expect(mockSave).toHaveBeenCalledWith('live content');
  });

  test('restoring a recovered draft dispatches the insert and saves it', () => {
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" />);
    act(() => capturedDraftRecovered?.('recovered text'));
    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    expect(mockSave).toHaveBeenCalledWith('recovered text');
  });

  test('discarding a draft clears local storage for the file', () => {
    const removeSpy = jest.spyOn(Storage.prototype, 'removeItem');
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" />);
    act(() => capturedDraftRecovered?.('recovered text'));
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(removeSpy).toHaveBeenCalledWith(expect.stringContaining('f1'));
    removeSpy.mockRestore();
  });
});

describe('AsciiDocEditor — external-change banner', () => {
  test('shows the external-change banner when autosave reports a remote edit, and dismisses it', () => {
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" />);
    act(() => capturedExternalChange?.());
    const dismiss = screen.getByRole('button', { name: /dismiss/i });
    expect(dismiss).toBeInTheDocument();
    fireEvent.click(dismiss);
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });
});

describe('AsciiDocEditor — plain-text (non-AsciiDoc) chrome', () => {
  test('hides the toolbar and outline panel for non-AsciiDoc files', () => {
    render(<AsciiDocEditor content="plain" canEdit isAsciiDoc={false} projectId="p1" fileNodeId="f1" />);
    expect(screen.queryByRole('button', { name: /collapse outline panel/i })).not.toBeInTheDocument();
  });

  test('omits the status bar when projectId/fileNodeId are absent', () => {
    render(<AsciiDocEditor content="plain" canEdit />);
    expect(screen.queryByText(/Ln/i)).not.toBeInTheDocument();
  });
});

// The writing surfaces (in-editor tooltip, Writing panel, dictionary) are driven by the handle the
// editor publishes, so this is where the permission gate has to be right. It was not: the dictionary
// permission was computed from the raw `canEdit` prop, which knows only the reader's PROJECT role —
// so an observer, and a text file with no collaborative backing, were both offered every mutating
// action, and applying a fix really did change the document under them.
describe('AsciiDocEditor — grammar actions and edit permission', () => {
  /** The grammar handle the editor publishes for a given set of props. */
  function publishedGrammarState(properties: Record<string, unknown>) {
    const published = jest.fn();
    render(
      <AsciiDocEditor
        content="the wrold is round"
        canEdit
        projectId="p1"
        fileNodeId="f1"
        onGrammarStateChange={published}
        {...properties}
      />,
    );
    return published.mock.calls.at(-1)![0];
  }

  /** One positioned issue with a fix, shaped as the panel hands it back to the editor. */
  const issue = {
    from: 4,
    to: 9,
    diagnostic: {
      from: 4,
      to: 9,
      severity: 'info' as const,
      message: '“wrold” may be misspelled',
      category: 'spelling' as const,
      grammarSuggestions: [{ text: 'world', kind: 'replace' as const }],
      grammarSegmentText: 'the wrold is round',
      grammarLint: {
        span: { start: 4, end: 9 },
        kind: 'Spelling',
        rule: 'SpellCheck',
        message: '“wrold” may be misspelled',
        suggestions: [{ text: 'world', kind: 'replace' as const }],
      },
    },
  };
  const fix = { text: 'world', kind: 'replace' as const };

  describe('an editor-role collaborator', () => {
    test('may edit the document, manage the dictionary, and configure rules', () => {
      const grammar = publishedGrammarState({ collab: makeBinding('editor') });
      expect(grammar.canEditDocument).toBe(true);
      expect(grammar.canManageDictionary).toBe(true);
      expect(grammar.canConfigureRules).toBe(true);
    });

    test('applying a fix reaches the document', () => {
      const grammar = publishedGrammarState({ collab: makeBinding('editor') });
      act(() => grammar.apply(issue, fix));
      expect(documentEdits()).toEqual([{ changes: { from: 4, to: 9, insert: 'world' } }]);
    });

    test('the dictionary writes reach the server', () => {
      const grammar = publishedGrammarState({ collab: makeBinding('editor') });
      act(() => {
        grammar.addDictionaryTerm('Kubernetes');
        grammar.removeDictionaryTerm('t1');
        grammar.addIssueWordToDictionary(issue);
      });
      expect(mockAddDictionaryTerm).toHaveBeenCalledWith('Kubernetes');
      expect(mockAddDictionaryTerm).toHaveBeenCalledWith('wrold');
      expect(mockRemoveDictionaryTerm).toHaveBeenCalledWith('t1');
    });

    test('the rule toggles reach the checker', async () => {
      const grammar = publishedGrammarState({ collab: makeBinding('editor') });
      await act(async () => {
        grammar.setRule('SpellCheck', false);
      });
      expect(mockSetLintConfig).toHaveBeenCalledWith({ SpellCheck: false });
    });
  });

  describe('an observer, whose project role still says they may edit', () => {
    test('may neither edit the document nor manage the dictionary', () => {
      // The reported bug: `canManageDictionary` was the raw `canEdit`, so this was true and the
      // Add-to-dictionary controls rendered for a read-only viewer.
      const grammar = publishedGrammarState({ collab: makeBinding('observer') });
      expect(grammar.canEditDocument).toBe(false);
      expect(grammar.canManageDictionary).toBe(false);
      expect(grammar.canConfigureRules).toBe(false);
    });

    test('applying a fix changes nothing — no transaction is dispatched at all', () => {
      const grammar = publishedGrammarState({ collab: makeBinding('observer') });
      act(() => grammar.apply(issue, fix));
      expect(documentEdits()).toEqual([]);
    });

    test('no dictionary write is attempted, so the server is never asked for a 403', () => {
      const grammar = publishedGrammarState({ collab: makeBinding('observer') });
      act(() => {
        grammar.addDictionaryTerm('Kubernetes');
        grammar.removeDictionaryTerm('t1');
        grammar.addIssueWordToDictionary(issue);
      });
      expect(mockAddDictionaryTerm).not.toHaveBeenCalled();
      expect(mockRemoveDictionaryTerm).not.toHaveBeenCalled();
    });

    test('no rule change reaches the checker', async () => {
      // The rule config is view-local, so this is consistency rather than authorization: a reader who
      // cannot apply a suggestion is offered no control over which checks run either. The panel
      // disables the toggles; these handlers refuse as well, so a stale render cannot slip past.
      const grammar = publishedGrammarState({ collab: makeBinding('observer') });
      await act(async () => {
        grammar.setRule('SpellCheck', false);
        grammar.resetRules();
      });
      expect(mockSetLintConfig).not.toHaveBeenCalled();
    });

    test('still sees the issues and the project dictionary', () => {
      // Reading is not gated: the checker keeps running and the terms stay listed.
      const grammar = publishedGrammarState({ collab: makeBinding('observer') });
      expect(grammar.dictionary).toHaveLength(1);
      expect(grammar.diagnostics).toEqual([]);
    });
  });

  // `canEdit` carries the global-admin bypass; `requireDictionaryEditor` authorizes on project
  // membership alone. A global admin who is only a VIEWER of this project therefore arrives with
  // canEdit=true and the role-only permission false, and must not be offered a dictionary control the
  // API answers 403 to. Nothing downstream covers this case — a dictionary write is a REST call with
  // no collaboration session to force read-only, unlike a document edit.
  describe('a global admin who is only a viewer of this project', () => {
    const asAdminViewer = { canEdit: true, canManageDictionary: false };

    test('may edit the document but not manage the dictionary', () => {
      const grammar = publishedGrammarState(asAdminViewer);
      expect(grammar.canEditDocument).toBe(true);
      expect(grammar.canManageDictionary).toBe(false);
    });

    test('no dictionary write is attempted, so the server is never asked for a 403', () => {
      const grammar = publishedGrammarState(asAdminViewer);
      act(() => {
        grammar.addDictionaryTerm('Kubernetes');
        grammar.removeDictionaryTerm('t1');
        grammar.addIssueWordToDictionary(issue);
      });
      expect(mockAddDictionaryTerm).not.toHaveBeenCalled();
      expect(mockRemoveDictionaryTerm).not.toHaveBeenCalled();
    });

    test('applying a fix still reaches the document (that permission is unaffected)', () => {
      const grammar = publishedGrammarState(asAdminViewer);
      act(() => grammar.apply(issue, fix));
      expect(documentEdits()).toEqual([{ changes: { from: 4, to: 9, insert: 'world' } }]);
    });

    test('omitting the prop falls back to canEdit, for hosts that do not distinguish the two', () => {
      const grammar = publishedGrammarState({ canEdit: true });
      expect(grammar.canManageDictionary).toBe(true);
    });
  });

  describe('a file with no collaborative backing (forced read-only)', () => {
    // The document is read-only — there is no collaborative record to write through — but the
    // DICTIONARY is scoped to the project, not to this file, and the server authorizes it on the
    // project role alone. Revoking it here would let one unbacked file strip an owner of a
    // project-level capability the server would grant, silently no-opping Add/Remove.
    //
    // These props are the combination the PROJECT EDITOR really produces for an owner on such a file:
    // the layout passes `editorCanEdit` (already false — `use-managed-collab.ts` folds
    // `offline || collabUnavailable` into it) as `canEdit`, alongside the role-only
    // `canManageDictionary` and `canConfigureRules`. Passing `canEdit` as true here instead would test
    // a shape production never renders, and did: it hid that the rules gate was reading the narrowed
    // prop and disabling itself for an owner.
    const asUnbackedOwner = {
      collabUnavailable: true,
      canEdit: false,
      canManageDictionary: true,
      canConfigureRules: true,
    };

    test('cannot edit the document, but may still manage the project dictionary and configure rules', () => {
      const grammar = publishedGrammarState(asUnbackedOwner);
      expect(grammar.canEditDocument).toBe(false);
      expect(grammar.canManageDictionary).toBe(true);
      // Same reasoning as the dictionary, and more plainly so: the rule config is view-local — never
      // persisted, never sent to anyone — so an unbacked file has no business disabling it.
      expect(grammar.canConfigureRules).toBe(true);
    });

    test('a rule toggle still reaches the checker', async () => {
      const grammar = publishedGrammarState(asUnbackedOwner);
      await act(async () => {
        grammar.setRule('SpellCheck', false);
      });
      expect(mockSetLintConfig).toHaveBeenCalledWith({ SpellCheck: false });
    });

    // The regression witness for the coupling itself. Without the role-only prop the narrowed
    // `canEdit` is the only signal the editor has, and the rule gate collapses with it — which is
    // exactly what shipped, and why the layout now threads the un-narrowed value past it.
    test('without the role-only prop the narrowed canEdit governs — the bug this prop exists to fix', () => {
      const grammar = publishedGrammarState({ canEdit: false, collabUnavailable: true });
      expect(grammar.canConfigureRules).toBe(false);
    });

    test('an observer on such a file still may not configure rules', () => {
      // The role gate is the one that survives: `canConfigureRules` is a host claim about the project
      // role, so an observer session must still override it.
      const grammar = publishedGrammarState({ ...asUnbackedOwner, collab: makeBinding('observer') });
      expect(grammar.canConfigureRules).toBe(false);
    });

    test('applies no fix, yet a dictionary term still reaches the server', () => {
      const grammar = publishedGrammarState(asUnbackedOwner);
      act(() => {
        grammar.apply(issue, fix);
        grammar.addDictionaryTerm('Kubernetes');
        grammar.addIssueWordToDictionary(issue);
      });
      expect(documentEdits()).toEqual([]); // the document itself is untouched
      expect(mockAddDictionaryTerm).toHaveBeenCalledWith('Kubernetes');
      expect(mockAddDictionaryTerm).toHaveBeenCalledWith('wrold');
    });
  });

  describe('a project viewer (no write permission at all)', () => {
    test('may neither edit the document nor manage the dictionary', () => {
      const published = jest.fn();
      render(
        <AsciiDocEditor
          content="the wrold is round"
          canEdit={false}
          projectId="p1"
          fileNodeId="f1"
          onGrammarStateChange={published}
        />,
      );
      const grammar = published.mock.calls.at(-1)![0];
      expect(grammar.canEditDocument).toBe(false);
      expect(grammar.canManageDictionary).toBe(false);
      act(() => grammar.apply(issue, fix));
      expect(documentEdits()).toEqual([]);
    });
  });
});
