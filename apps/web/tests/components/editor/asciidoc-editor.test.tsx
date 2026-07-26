import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

function extractReadOnly(value: unknown): boolean | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = Object.fromEntries(Object.entries(value));
    if (typeof object['readOnly'] === 'boolean') return object['readOnly'];
  }
  return undefined;
}

// Mock CodeMirror EditorView since it requires a real DOM environment
jest.mock('@codemirror/view', () => {
  return {
    EditorView: class MockEditorView {
      dom: HTMLDivElement;
      scrollDOM: HTMLDivElement;
      state: { doc: { toString: () => string }; readOnly: boolean; selection: { main: { head: number } }; lines: number };
      private updateListeners: Array<(update: unknown) => void> = [];
      static updateListener = {
        of: (function_: unknown) => ({ _isUpdateListener: true, _fn: function_ }),
      };
      static lineWrapping = {};
      static editable = { of: (value: unknown) => ({ editable: value }) };
      static domEventHandlers = (handlers: Record<string, unknown>) => {
        const sink = globalThis as unknown as Record<string, unknown[]>;
        (sink['__cmDomHandlers'] ??= []).push(handlers);
        return {};
      };
      static inputHandler = { of: (function_: unknown) => ({ function_ }) };

      constructor({ state, parent }: {
        state: { doc: { toString: () => string }; readOnly?: boolean; _extensions?: unknown[] };
        parent: HTMLElement;
      }) {
        const readOnly = !!state.readOnly;
        this.dom = document.createElement('div');
        this.dom.setAttribute('contenteditable', readOnly ? 'false' : 'true');
        this.dom.dataset['testid'] = 'cm-editor';
        this.dom.textContent = state.doc.toString();
        this.scrollDOM = document.createElement('div');
        this.state = {
          doc: {
            toString: () => state.doc.toString(),
            lineAt: (_pos: number) => ({ number: 1, from: 0, text: '' }),
            line: (number_: number) => ({ number: number_, from: 0, text: '' }),
            lines: 1,
          },
          readOnly,
          selection: { main: { head: 0 } },
          lines: 1,
          field: (_fieldDefinition: unknown) => [],
        };
        parent.append(this.dom);
        // Collect updateListener callbacks from state's extensions
        this.updateListeners = [];
        const scanExtensions = (extensions: unknown[]) => {
          for (const extension of extensions) {
            if (Array.isArray(extension)) { scanExtensions(extension); continue; }
            if (extension && typeof extension === 'object' && (extension as { _isUpdateListener?: boolean })._isUpdateListener) {
              this.updateListeners.push((extension as { _fn: (u: unknown) => void })._fn);
            }
          }
        };
        if ((state as { _extensions?: unknown[] })._extensions) {
          scanExtensions((state as { _extensions: unknown[] })._extensions);
        }
      }

      dispatch(transaction: { changes?: { insert?: string }; effects?: { readOnly?: boolean } | Array<{ readOnly?: boolean }>; selection?: { anchor: number }; scrollIntoView?: boolean }) {
        // Record selection dispatches (used to assert initialLine restore on mount).
        if (transaction.selection) {
          const sink = (globalThis as unknown as Record<string, unknown>);
          const list = (sink['__cmSelectionDispatches'] as Array<unknown> | undefined) ?? [];
          list.push({ anchor: transaction.selection.anchor, scrollIntoView: transaction.scrollIntoView });
          sink['__cmSelectionDispatches'] = list;
        }
        let docChanged = false;
        if (transaction.changes && typeof transaction.changes.insert === 'string') {
          const newContent = transaction.changes.insert;
          this.state = {
            ...this.state,
            doc: {
              toString: () => newContent,
              lineAt: (_pos: number) => ({ number: 1, from: 0, text: '' }),
              lines: 1,
            },
          };
          this.dom.textContent = newContent;
          docChanged = true;
        }
        if (transaction.effects) {
          const effects = Array.isArray(transaction.effects) ? transaction.effects : [transaction.effects];
          for (const effect of effects) {
            if (typeof (effect as { readOnly?: boolean }).readOnly === 'boolean') {
              const ro = (effect as { readOnly: boolean }).readOnly;
              this.state = { ...this.state, readOnly: ro };
              this.dom.setAttribute('contenteditable', ro ? 'false' : 'true');
            }
          }
        }
        // Fire updateListeners so the editor component's state tracking works
        for (const listener of this.updateListeners) {
          listener({ docChanged, state: this.state });
        }
      }
      destroy() { this.dom.remove(); }
    },
    keymap:                { of: () => ({}) },
    hoverTooltip:          () => ({}),
    lineNumbers:           () => ({}),
    highlightActiveLine:   () => ({}),
    highlightSpecialChars: () => ({}),
    drawSelection:         () => ({}),
    dropCursor:            () => ({}),
    rectangularSelection:  () => ({}),
    foldGutter:            () => ({}),
    crosshairCursor:       () => ({}),
    highlightActiveLineGutter: () => ({}),
    ViewPlugin:            { fromClass: () => ({}), define: () => ({}) },
    Decoration:            { line: () => ({}), replace: () => ({}), mark: () => ({}), set: () => ({}), none: { update: () => ({}) } },
    WidgetType:            class {},
    GutterMarker:          class {},
    gutter:                () => ({}),
  };
});

jest.mock('@codemirror/language-data', () => ({ languages: [] }));

// `forceLinting` is reached once grammar actually activates (refreshGrammarLints calls it after a rule
// change), so it has to exist here even though nothing asserts on it.
jest.mock('@codemirror/lint', () => ({ linter: () => ({}), lintGutter: () => ({}), forEachDiagnostic: () => {}, forceLinting: () => {} }));

jest.mock('@codemirror/state', () => {
  return {
    EditorState: {
      create: (config: { doc: string; extensions?: unknown[] }) => {
        const extensions = config.extensions ?? [];
        let readOnly = false;
        function scan(array: unknown[]) {
          for (const extension of array) {
            if (Array.isArray(extension)) { scan(extension); continue; }
            const extracted = extractReadOnly(extension);
            if (extracted !== undefined) readOnly = extracted;
          }
        }
        scan(extensions);
        return { doc: { toString: () => config.doc }, readOnly, _extensions: extensions };
      },
      readOnly: { of: (value: boolean) => ({ readOnly: value }) },
    },
    StateField: {
      define: () => ({ field: true }),
    },
    Facet: {
      define: () => ({ of: (value: unknown) => ({ facet: value }) }),
    },
    StateEffect: {
      appendConfig: { of: (extension: unknown) => ({ appendConfig: extension }) },
      define: () => ({ of: (value: unknown) => ({ value }) }),
    },
    Compartment: class {
      of(extension: unknown) { return extension; }
      reconfigure(extension: unknown) { return extension; }
    },
    Prec: {
      highest: (extension: unknown) => extension,
      high: (extension: unknown) => extension,
      default: (extension: unknown) => extension,
      low: (extension: unknown) => extension,
      lowest: (extension: unknown) => extension,
    },
  };
});

jest.mock('@codemirror/commands', () => ({
  history: () => ({}),
  defaultKeymap: [],
  historyKeymap: [],
}));

jest.mock('@codemirror/language', () => ({
  codeFolding: () => ({}),
  foldGutter: () => ({}),
  syntaxHighlighting: () => ({}),
  defaultHighlightStyle: {},
  // The diagram source-language highlighters (dot/mermaid) build languages at
  // module-eval time and read `.parser` off the result, so the stubs must return a
  // language-shaped object. `codemirror-lang-mermaid` (pulled in transitively) also
  // builds LRLanguages and LanguageDescriptions at its own module-eval time under the
  // same mock, so those constructors must be present too.
  StreamLanguage: { define: jest.fn(() => ({ parser: {} })) },
  LRLanguage: { define: jest.fn(() => ({ parser: {} })) },
  LanguageDescription: { of: jest.fn(() => ({})) },
  LanguageSupport: class {},
  foldService: { of: jest.fn(() => ({})) },
}));

jest.mock('@codemirror/search', () => ({
  search: () => ({}),
  searchKeymap: [],
}));

jest.mock('@/lib/codemirror/asciidoc-language', () => ({
  asciidoc: () => ({}),
}));

// The collab extensions module pulls in y-codemirror.next (ESM) which touches the real
// @codemirror/state at load; this suite mocks that module, so stub the collab binding too.
jest.mock('@/components/editor/editor-collab-extensions', () => ({
  collabExtensions: jest.fn(() => ({})),
  COLLAB_YTEXT_KEY: 'codemirror',
}));

jest.mock('@codemirror/autocomplete', () => ({
  autocompletion: () => ({}),
  completionKeymap: [],
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

jest.mock('@/lib/codemirror/asciidoc-link-handler', () => ({
  createLinkHandler: () => ({ handleMousedown: jest.fn() }),
}));

jest.mock('@/hooks/use-include-completions', () => ({
  useIncludeCompletions: () => [],
  useImagePaths: () => [],
}));

jest.mock('@/hooks/use-section-outline', () => ({
  useSectionOutline: jest.fn(() => ({ entries: [], effectiveScope: 'current', unresolved: [] })),
}));

jest.mock('@/lib/codemirror/asciidoc-outline', () => ({
  outlineField: { field: true },
  outlineResolvedScopeFacet: { of: () => ({}) },
}));

jest.mock('@replit/codemirror-minimap', () => ({
  showMinimap: { of: () => ({}) },
}));

jest.mock('@/hooks/use-editor-preferences', () => ({
  useEditorPreferences: jest.fn(() => ({ fontSize: 14, theme: 'default', setFontSize: jest.fn(), setTheme: jest.fn() })),
}));

jest.mock('@/lib/codemirror/asciidoc-theme', () => ({
  asciidocTheme: [],
}));

jest.mock('@/lib/codemirror/search-panel-theme', () => ({
  searchPanelTheme: [],
}));

jest.mock('@/lib/codemirror/asciidoc-fold', () => ({
  asciidocFold: {},
}));

jest.mock('@/lib/codemirror/asciidoc-table-context', () => ({
  tableContextField: { field: true },
}));

jest.mock('@/hooks/use-table-context', () => ({
  useTableContext: () => null,
}));

jest.mock('@/hooks/use-auto-save', () => ({
  useAutoSave: jest.fn(() => ({ saveState: 'saved', save: jest.fn() })),
}));

jest.mock('@/hooks/use-grammar-settings', () => ({
  useGrammarSettings: jest.fn(() => ({ enabled: false, languageIsEnglish: false, dialect: 'en-GB', loaded: true })),
}));

jest.mock('@/hooks/use-ignored-lints', () => ({
  useIgnoredLints: jest.fn(() => ({ blob: '', save: jest.fn(async () => true) })),
}));

// Stand in for the on-device engine so the rule-config round trip can be driven and observed. Only the
// two config methods behave; everything else the client touches is absorbed, via a Proxy, so this fake
// does not have to be re-taught every method the engine grows. Read lazily (the factory returns a
// function that resolves `fakeEngine` when CALLED, after beforeEach has assigned it).
let engineLintConfig: Record<string, boolean | null> = {};
let engineSetLintConfig = jest.fn();
const fakeEngine = new Proxy(
  {
    getLintConfig: async () => ({ ...engineLintConfig }),
    setLintConfig: async (next: Record<string, boolean | null>) => {
      engineSetLintConfig(next);
      engineLintConfig = { ...next }; // the real API REPLACES, so model that faithfully
    },
  } as Record<string, unknown>,
  {
    get: (target, property) =>
      property in target ? target[property as string] : async () => undefined,
  },
);
jest.mock('@/lib/create-harper-worker', () => ({ createHarperEngine: () => fakeEngine }));

// Import after mocks
import { AsciiDocEditor } from '@/components/editor/asciidoc-editor';
import { useEditorPreferences } from '@/hooks/use-editor-preferences';
import { useAutoSave } from '@/hooks/use-auto-save';
import { useGrammarSettings } from '@/hooks/use-grammar-settings';
import { useIgnoredLints } from '@/hooks/use-ignored-lints';
const mockUseAutoSave = useAutoSave as jest.Mock;
const mockUseGrammarSettings = useGrammarSettings as jest.Mock;
const mockUseIgnoredLints = useIgnoredLints as jest.Mock;

type DropHandler = { drop: (event: unknown, view: unknown) => boolean };
function getDropHandler(): DropHandler {
  const handlers = (globalThis as unknown as Record<string, DropHandler[]>)['__cmDomHandlers'] ?? [];
  const found = handlers.find((h) => typeof h.drop === 'function');
  if (!found) throw new Error('no drop handler registered');
  return found;
}
function makeFakeView(editable: boolean, docLength: number) {
  const dispatched: Array<{ changes?: { from: number; insert: string }; selection?: { anchor: number } }> = [];
  const view = {
    state: {
      facet: () => editable,
      selection: { main: { head: 0 } },
      doc: { length: docLength, sliceString: () => 'x' },
    },
    posAtCoords: () => 2,
    dispatch: (tr: { changes?: { from: number; insert: string }; selection?: { anchor: number } }) => dispatched.push(tr),
    focus: jest.fn(),
  };
  return { view, dispatched };
}

describe('AsciiDocEditor file drop', () => {
  beforeEach(() => { (globalThis as unknown as Record<string, unknown>)['__cmDomHandlers'] = []; });

  test('dropping a tree file inserts the matching macro', () => {
    render(<AsciiDocEditor content="line one\nline two" canEdit projectId="p1" fileNodeId="f1" />);
    const { view, dispatched } = makeFakeView(true, 10);
    const event = { dataTransfer: { getData: () => JSON.stringify({ path: 'New Folder/pic.png' }) }, preventDefault: jest.fn(), clientX: 0, clientY: 0 };
    const handled = getDropHandler().drop(event, view);
    expect(handled).toBe(true);
    expect(dispatched[0].changes?.insert).toContain('image::New Folder/pic.png[pic]');
  });

  test('a non-node drop is left to CodeMirror (returns false)', () => {
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" />);
    const { view } = makeFakeView(true, 1);
    const event = { dataTransfer: { getData: () => '' }, preventDefault: jest.fn() };
    expect(getDropHandler().drop(event, view)).toBe(false);
  });

  test('drop with no coords falls back to the cursor and skips padding at an empty-doc edge', () => {
    render(<AsciiDocEditor content="" canEdit projectId="p1" fileNodeId="f1" />);
    const dispatched: Array<{ changes?: { insert: string } }> = [];
    const view = {
      state: { facet: () => true, selection: { main: { head: 0 } }, doc: { length: 0, sliceString: () => '' } },
      posAtCoords: () => null,
      dispatch: (tr: { changes?: { insert: string } }) => dispatched.push(tr),
      focus: jest.fn(),
    };
    const event = { dataTransfer: { getData: () => JSON.stringify({ path: 'a/b.adoc' }) }, preventDefault: jest.fn() };
    expect(getDropHandler().drop(event, view)).toBe(true);
    expect(dispatched[0].changes?.insert).toBe('include::a/b.adoc[]');
  });

  test('a drop on a read-only editor is ignored (returns false)', () => {
    render(<AsciiDocEditor content="x" canEdit={false} projectId="p1" fileNodeId="f1" />);
    const { view, dispatched } = makeFakeView(false, 1);
    const event = { dataTransfer: { getData: () => JSON.stringify({ path: 'a.png' }) }, preventDefault: jest.fn() };
    expect(getDropHandler().drop(event, view)).toBe(false);
    expect(dispatched).toHaveLength(0);
  });
});

describe('AsciiDocEditor', () => {
  test('renders a CM6 editor element (not a <pre>) when given text content', () => {
    render(<AsciiDocEditor content="= Hello World\n\nSome text." canEdit={true} />);
    // Should have a CM6 editor element, not a <pre>
    expect(screen.queryByRole('code')).toBeNull();
    expect(screen.getByTestId('cm-editor')).toBeInTheDocument();
  });

  test('the editor is read-only when canEdit={false}', () => {
    render(<AsciiDocEditor content="Some text" canEdit={false} />);
    const editor = screen.getByTestId('cm-editor');
    expect(editor.getAttribute('contenteditable')).toBe('false');
  });

  // The REST autosave machinery must stay disabled on the collab path — including the
  // OFFLINE read-only fallback (collab binding absent but a connectionState present). Otherwise
  // ETag polling, beforeunload keepalive, and draft-recovery banners reactivate on a collab file.
  test('disables autosave on the offline collab fallback (connectionState set, no binding)', () => {
    mockUseAutoSave.mockClear();
    render(<AsciiDocEditor content="x" canEdit={false} projectId="p1" fileNodeId="f1" connectionState="offline" />);
    expect(mockUseAutoSave).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  test('enables autosave on the legacy path (no collab binding, no connectionState)', () => {
    mockUseAutoSave.mockClear();
    render(<AsciiDocEditor content="x" canEdit={true} projectId="p1" fileNodeId="f1" />);
    expect(mockUseAutoSave).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  test('the editor is editable when canEdit={true}', () => {
    render(<AsciiDocEditor content="Some text" canEdit={true} />);
    const editor = screen.getByTestId('cm-editor');
    expect(editor.getAttribute('contenteditable')).toBe('true');
  });

  test('component unmounts without errors', () => {
    const { unmount } = render(<AsciiDocEditor content="test" canEdit={true} />);
    expect(() => unmount()).not.toThrow();
  });

  // The editor lifts outline state via onOutlineChange (028); it never calls useSectionOutline.
  test('editor renders without calling useSectionOutline', () => {
    const { useSectionOutline } = jest.requireMock('@/hooks/use-section-outline');
    useSectionOutline.mockClear();
    render(<AsciiDocEditor content="== Heading\n\nBody" canEdit={true} />);
    expect(useSectionOutline).not.toHaveBeenCalled();
  });

  // 028: the right-hand outline panel was removed; the outline now lives in the left panel, fed by
  // the lifted onOutlineChange callback.
  test('does not render an in-editor outline panel (collapse/expand controls absent)', () => {
    render(<AsciiDocEditor content="== Heading\n\nBody" canEdit={true} />);
    expect(screen.queryByRole('button', { name: /collapse outline panel/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /expand outline panel/i })).not.toBeInTheDocument();
  });

  // Issue 6: canEdit prop changes after mount must update the editor's readOnly state
  test('editor becomes editable when canEdit prop changes from false to true', () => {
    const { rerender } = render(<AsciiDocEditor content="Some text" canEdit={false} />);
    expect(screen.getByTestId('cm-editor').getAttribute('contenteditable')).toBe('false');

    rerender(<AsciiDocEditor content="Some text" canEdit={true} />);

    expect(screen.getByTestId('cm-editor').getAttribute('contenteditable')).toBe('true');
  });

  test('editor becomes read-only when canEdit prop changes from true to false', () => {
    const { rerender } = render(<AsciiDocEditor content="Some text" canEdit={true} />);
    expect(screen.getByTestId('cm-editor').getAttribute('contenteditable')).toBe('true');

    rerender(<AsciiDocEditor content="Some text" canEdit={false} />);

    expect(screen.getByTestId('cm-editor').getAttribute('contenteditable')).toBe('false');
  });

  // Issue 5: outline must NOT depend on useSectionOutline being called during render.
  // Issue C8: when the content prop changes (e.g. external reload), the editor view must update
  test('updates editor content when content prop changes after mount', () => {
    const { rerender } = render(<AsciiDocEditor content="original content" canEdit={true} />);
    expect(screen.getByTestId('cm-editor')).toHaveTextContent('original content');

    rerender(<AsciiDocEditor content="externally updated content" canEdit={true} />);

    expect(screen.getByTestId('cm-editor')).toHaveTextContent('externally updated content');
  });

  // Issue 5: discardDraft must use OFFLINE_QUEUE_KEY_PREFIX so it stays in sync
  // if the constant is ever renamed.
  test('discardDraft removes the draft using OFFLINE_QUEUE_KEY_PREFIX, not a hardcoded string', () => {
    // Source-level structural check: the file must NOT contain the hardcoded prefix
    // literal. After the fix, only the imported constant is used.
    const fs = require('node:fs');
    const source: string = fs.readFileSync(
      require.resolve('@/components/editor/asciidoc-editor'),
      'utf8',
    );
    expect(source).not.toContain("'asciidocollab:editor-draft:'");
    expect(source).toContain('OFFLINE_QUEUE_KEY_PREFIX');
  });

  describe('font size and theme preferences', () => {
    const mockUseEditorPreferences = useEditorPreferences as jest.MockedFunction<typeof useEditorPreferences>;

    afterEach(() => {
      mockUseEditorPreferences.mockReset();
      mockUseEditorPreferences.mockImplementation(() => ({
        fontSize: 14, theme: 'default', setFontSize: jest.fn(), setTheme: jest.fn(),
      }));
    });

    // This test verifies the CSS rules that apply font-size and theme styles are
    // loaded.  Without the import, var(--editor-font-size) and [data-theme] have
    // no effect even though the DOM attributes are correctly set.
    test('editor-themes.css is imported so its CSS rules are active', () => {
      const fs = require('node:fs');
      const source: string = fs.readFileSync(
        require.resolve('@/components/editor/asciidoc-editor'),
        'utf8',
      );
      expect(source).toContain("import './editor-themes.css'");
    });

    test('editor wrapper applies --editor-font-size CSS variable from preference', () => {
      mockUseEditorPreferences.mockReturnValue({
        fontSize: 20, theme: 'default', setFontSize: jest.fn(), setTheme: jest.fn(),
      });
      const { container } = render(<AsciiDocEditor content="test" canEdit={true} />);
      const wrapper = container.querySelector('.asciidoc-editor');
      expect(wrapper).not.toBeNull();
      expect((wrapper as HTMLElement).style.getPropertyValue('--editor-font-size')).toBe('20px');
    });

    test('editor wrapper applies data-theme attribute from preference', () => {
      mockUseEditorPreferences.mockReturnValue({
        fontSize: 14, theme: 'high-contrast', setFontSize: jest.fn(), setTheme: jest.fn(),
      });
      const { container } = render(<AsciiDocEditor content="test" canEdit={true} />);
      const wrapper = container.querySelector('.asciidoc-editor');
      expect(wrapper).toHaveAttribute('data-theme', 'high-contrast');
    });

    test('editor wrapper updates --editor-font-size when font size preference changes', () => {
      mockUseEditorPreferences.mockReturnValue({
        fontSize: 16, theme: 'default', setFontSize: jest.fn(), setTheme: jest.fn(),
      });
      const { rerender, container } = render(<AsciiDocEditor content="test" canEdit={true} />);
      expect((container.querySelector('.asciidoc-editor') as HTMLElement).style.getPropertyValue('--editor-font-size')).toBe('16px');

      mockUseEditorPreferences.mockReturnValue({
        fontSize: 24, theme: 'default', setFontSize: jest.fn(), setTheme: jest.fn(),
      });
      rerender(<AsciiDocEditor content="test" canEdit={true} />);
      expect((container.querySelector('.asciidoc-editor') as HTMLElement).style.getPropertyValue('--editor-font-size')).toBe('24px');
    });
  });

  describe('draft recovery banner', () => {
    beforeEach(() => {
      mockUseAutoSave.mockReset();
    });

    afterEach(() => {
      mockUseAutoSave.mockImplementation(() => ({ saveState: 'saved', save: jest.fn() }));
    });

    test('shows recovery banner when useAutoSave calls onDraftRecovered', () => {
      let capturedOnDraftRecovered: ((content: string) => void) | undefined;
      mockUseAutoSave.mockImplementation((options: { onDraftRecovered?: (c: string) => void }) => {
        capturedOnDraftRecovered = options.onDraftRecovered;
        return { saveState: 'saved', save: jest.fn() };
      });

      render(<AsciiDocEditor content="test" canEdit={true} />);
      expect(screen.queryByText('An unsaved draft was recovered.')).not.toBeInTheDocument();

      act(() => capturedOnDraftRecovered?.('recovered draft'));
      expect(screen.getByText('An unsaved draft was recovered.')).toBeInTheDocument();
    });

    test('discardDraft clears the banner when Discard is clicked', () => {
      let capturedOnDraftRecovered: ((content: string) => void) | undefined;
      mockUseAutoSave.mockImplementation((options: { onDraftRecovered?: (c: string) => void }) => {
        capturedOnDraftRecovered = options.onDraftRecovered;
        return { saveState: 'saved', save: jest.fn() };
      });

      render(<AsciiDocEditor content="test" canEdit={true} />);
      act(() => capturedOnDraftRecovered?.('recovered draft'));
      expect(screen.getByText('An unsaved draft was recovered.')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /discard/i }));
      expect(screen.queryByText('An unsaved draft was recovered.')).not.toBeInTheDocument();
    });

    test('restoreDraft clears the banner when Restore is clicked', () => {
      let capturedOnDraftRecovered: ((content: string) => void) | undefined;
      mockUseAutoSave.mockImplementation((options: { onDraftRecovered?: (c: string) => void }) => {
        capturedOnDraftRecovered = options.onDraftRecovered;
        return { saveState: 'saved', save: jest.fn() };
      });

      render(<AsciiDocEditor content="test" canEdit={true} />);
      act(() => capturedOnDraftRecovered?.('recovered draft'));

      fireEvent.click(screen.getByRole('button', { name: /restore/i }));
      expect(screen.queryByText('An unsaved draft was recovered.')).not.toBeInTheDocument();
    });
  });

  describe('status bar retry', () => {
    afterEach(() => {
      mockUseAutoSave.mockImplementation(() => ({ saveState: 'saved', save: jest.fn() }));
    });

    test('shows Retry button in status bar when saveState is error and projectId+fileNodeId are set', () => {
      mockUseAutoSave.mockReturnValue({ saveState: 'error', save: jest.fn() });
      render(<AsciiDocEditor content="test" canEdit={true} projectId="p1" fileNodeId="f1" />);
      expect(screen.getByRole('button', { name: /retry save/i })).toBeInTheDocument();
    });

    test('clicking Retry calls save with current editor content', () => {
      const mockSave = jest.fn();
      mockUseAutoSave.mockReturnValue({ saveState: 'error', save: mockSave });

      render(<AsciiDocEditor content="= Hello" canEdit={true} projectId="p1" fileNodeId="f1" />);
      fireEvent.click(screen.getByRole('button', { name: /retry save/i }));
      expect(mockSave).toHaveBeenCalled();
    });
  });

  // Cursor-line reporting and initialLine restore threading.
  describe('cursor line reporting and initialLine restore', () => {
    test('onCursorLineChange fires with the 1-based line when the cursor moves', () => {
      const onCursorLineChange = jest.fn();
      const { rerender } = render(
        <AsciiDocEditor content="line one" canEdit={true} onCursorLineChange={onCursorLineChange} />,
      );
      // Trigger an update (content change fires the CM updateListener → onCursorChange → onCursorLineChange).
      act(() => { rerender(<AsciiDocEditor content="line two" canEdit={true} onCursorLineChange={onCursorLineChange} />); });
      expect(onCursorLineChange).toHaveBeenCalledWith(1);
    });

    test('threads initialLine into the mount, dispatching a scrolled selection', () => {
      (globalThis as unknown as Record<string, unknown>)['__cmSelectionDispatches'] = [];
      render(<AsciiDocEditor content="a\nb\nc" canEdit={true} initialLine={2} />);
      const dispatches = (globalThis as unknown as Record<string, Array<{ scrollIntoView?: boolean }>>)['__cmSelectionDispatches'];
      expect(dispatches.length).toBeGreaterThan(0);
      expect(dispatches.some((d) => d.scrollIntoView === true)).toBe(true);
    });

    test('omitting onCursorLineChange causes no error when the cursor moves', () => {
      const { rerender } = render(<AsciiDocEditor content="x" canEdit={true} />);
      expect(() => act(() => { rerender(<AsciiDocEditor content="y" canEdit={true} />); })).not.toThrow();
    });
  });

  describe('soft-wrap integration', () => {
    test('EditorView.lineWrapping is included when softWrap=true', () => {
      const { EditorState } = require('@codemirror/state');
      const { EditorView } = require('@codemirror/view');
      let capturedExtensions: unknown[] = [];
      const originalCreate = EditorState.create;
      EditorState.create = (config: { doc: string; extensions?: unknown[] }) => {
        capturedExtensions = (config.extensions ?? []).flat(Infinity);
        return originalCreate(config);
      };
      render(<AsciiDocEditor content="test" canEdit={true} softWrap={true} />);
      EditorState.create = originalCreate;
      expect(capturedExtensions).toContain(EditorView.lineWrapping);
    });

    test('EditorView.lineWrapping is absent when softWrap=false', () => {
      const { EditorState } = require('@codemirror/state');
      const { EditorView } = require('@codemirror/view');
      let capturedExtensions: unknown[] = [];
      const originalCreate = EditorState.create;
      EditorState.create = (config: { doc: string; extensions?: unknown[] }) => {
        capturedExtensions = (config.extensions ?? []).flat(Infinity);
        return originalCreate(config);
      };
      render(<AsciiDocEditor content="test" canEdit={true} softWrap={false} />);
      EditorState.create = originalCreate;
      expect(capturedExtensions).not.toContain(EditorView.lineWrapping);
    });
  });
});

describe('AsciiDocEditor grammar gating', () => {
  beforeEach(() => {
    mockUseGrammarSettings.mockClear();
    mockUseIgnoredLints.mockClear();
  });

  test('does not enable grammar until the render-config has actually loaded', () => {
    // English + config says enabled, but the config has NOT been read yet (loaded=false). Enabling
    // now would warm up (and immediately tear down) the WASM engine for a possibly-disabled project.
    // The gate observes `grammarEnabled` via the ignored-lints hook, which is passed null when off.
    mockUseGrammarSettings.mockReturnValue({ enabled: true, languageIsEnglish: true, dialect: 'en-GB', loaded: false });
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" />);
    expect(mockUseIgnoredLints).toHaveBeenLastCalledWith(null);
  });

  test('enables grammar once the config has loaded and reports it enabled', () => {
    mockUseGrammarSettings.mockReturnValue({ enabled: true, languageIsEnglish: true, dialect: 'en-GB', loaded: true });
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" />);
    expect(mockUseIgnoredLints).toHaveBeenLastCalledWith('f1');
  });

  test('defaults the grammar language to English when the project leaves its language unset', () => {
    // No spellcheckLanguage prop → the editor must gate grammar on the SAME English default the
    // spellchecker uses, not on the raw null (which would disable grammar for every project that
    // never set an explicit language — the common default).
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" />);
    expect(mockUseGrammarSettings).toHaveBeenCalledWith('p1', 'en');
  });

  test('passes an explicitly configured project language through unchanged', () => {
    render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" spellcheckLanguage="fr" />);
    expect(mockUseGrammarSettings).toHaveBeenCalledWith('p1', 'fr');
  });
});

describe('AsciiDocEditor grammar state lifetime', () => {
  test('publishes the grammar state while mounted', () => {
    const onGrammarStateChange = jest.fn();
    render(
      <AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" onGrammarStateChange={onGrammarStateChange} />,
    );
    expect(onGrammarStateChange).toHaveBeenCalled();
    expect(onGrammarStateChange.mock.calls.at(-1)![0]).not.toBeNull();
  });

  test('takes the panel down with the editor', () => {
    // This is the only publisher, so nothing else can tell the layout the issues are gone. Without it,
    // opening an image or a theme file left the Writing panel listing the previous document's issues,
    // with navigate/apply bound to a destroyed view.
    const onGrammarStateChange = jest.fn();
    const { unmount } = render(
      <AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" onGrammarStateChange={onGrammarStateChange} />,
    );
    unmount();
    expect(onGrammarStateChange).toHaveBeenLastCalledWith(null);
  });

  // Regression: toggling one rule wiped every other rule out of the Writing → Rules list, leaving a
  // single entry and no way back (Reset derived its key set from the same collapsed config). Cause:
  // harper.js's `setLintConfig` REPLACES the whole configuration, and the editor was sending only the
  // toggled rule.
  describe('rule toggling preserves the rest of the config', () => {
    beforeEach(() => {
      engineLintConfig = { RuleA: null, RuleB: true, RuleC: false };
      engineSetLintConfig = jest.fn();
      mockUseGrammarSettings.mockReturnValue({ enabled: true, languageIsEnglish: true, dialect: 'en-GB', loaded: true });
    });

    /** Renders with grammar active and resolves the published grammar state once the engine is wired. */
    async function grammarState(): Promise<{ setRule: (rule: string, enabled: boolean) => void; resetRules: () => void }> {
      const published = jest.fn();
      render(<AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" onGrammarStateChange={published} />);
      for (let attempt = 0; attempt < 40; attempt++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      return published.mock.calls.at(-1)![0];
    }

    test('sends the full config with only the toggled rule changed', async () => {
      const state = await grammarState();
      await act(async () => {
        state.setRule('RuleB', false);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(engineSetLintConfig).toHaveBeenCalled();
      // The whole rule set must survive the write — not just the rule that was clicked.
      expect(engineSetLintConfig.mock.calls.at(-1)![0]).toEqual({ RuleA: null, RuleB: false, RuleC: false });
    });

    test('reset clears every rule, not only the last one toggled', async () => {
      const state = await grammarState();
      await act(async () => {
        state.setRule('RuleB', false);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        state.resetRules();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(engineSetLintConfig.mock.calls.at(-1)![0]).toEqual({ RuleA: null, RuleB: null, RuleC: null });
    });
  });

  test('offers dismissal only when there is a document to store it against', () => {
    const withDocument = jest.fn();
    const { unmount } = render(
      <AsciiDocEditor content="x" canEdit projectId="p1" fileNodeId="f1" onGrammarStateChange={withDocument} />,
    );
    expect(withDocument.mock.calls.at(-1)![0].ignore).not.toBeNull();
    unmount();

    const withoutDocument = jest.fn();
    render(<AsciiDocEditor content="x" canEdit projectId="p1" onGrammarStateChange={withoutDocument} />);
    expect(withoutDocument.mock.calls.at(-1)![0].ignore).toBeNull();
  });
});
