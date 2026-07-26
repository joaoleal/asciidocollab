import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ProjectEditorLayout } from '@/app/(dashboard)/dashboard/projects/[id]/project-editor-layout';
import type { ProjectSymbol } from '@asciidocollab/shared';
import type { SymbolUsage } from '@/lib/api/projects';
import type { XrefTarget } from '@/lib/codemirror/asciidoc-link-handler';

// Focused coverage suite for the layout's handlers and conditional UI: preview toggle,
// main-file picker wiring, go-to-symbol + refactor dialogs, xref/usage navigation
// (index-backed lineOf), binary/image/error content branches, and keyboard shortcuts.

jest.mock('@/contexts/current-user-context', () => ({
  useCurrentUser: () => ({ userId: 'u-test', displayName: 'Test User', email: 't@example.com' }),
}));

// Stub the PDF export hook: its worker factory uses `import.meta.url`, which is unloadable under the
// commonjs jest transform, so the real module can never be imported here (mocked by design).
const mockExportPdf = jest.fn();
jest.mock('@/hooks/use-pdf-export', () => ({
  usePdfExport: () => ({ exportPdf: mockExportPdf, isExporting: false, diagnostics: [] }),
}));
// Same for the HTML export hook, which owns the render worker (`import.meta.url` again).
const mockExportHtml = jest.fn();
jest.mock('@/hooks/use-html-export', () => ({
  useHtmlExport: () => ({ exportHtml: mockExportHtml, isExporting: false, failures: [] }),
}));
jest.mock('@/hooks/use-project-render-config', () => ({
  useProjectRenderConfig: () => ({ config: {}, loading: false, saving: false, error: null, save: jest.fn() }),
}));

// Stub the live PDF preview hook AND its panel: both pull in the PDF worker/pdf.js, whose
// `import.meta.url` is unloadable under the commonjs jest transform, so the real modules can never
// be imported here (mocked by design).
jest.mock('@/hooks/use-pdf-preview', () => ({
  usePdfPreview: () => ({ pdf: undefined, isRendering: false, diagnostics: [] }),
}));
jest.mock('@/components/pdf-preview-panel', () => ({
  PdfPreviewPanel: () => <div data-testid="pdf-preview-panel-mock" />,
}));

// Editor stub that surfaces the navigation callbacks so tests can drive Ctrl+click flows. The
// Go to Symbol / Refactor buttons now live in the editor toolbar, so the stub renders them and
// seeds the refactor callback with a sample cursor symbol (real detection is unit-tested separately).
jest.mock('@/components/editor/asciidoc-editor', () => ({
  AsciiDocEditor: jest.fn((properties: {
    content: string;
    canEdit: boolean;
    projectId?: string;
    fileNodeId?: string;
    inheritedOffset?: number;
    onNavigateToFile?: (path: string) => void;
    onNavigateToXref?: (target: XrefTarget) => void;
    onOpenUrl?: (url: string) => void;
    onScrollLine?: (line: number) => void;
    onLineClick?: (line: number) => void;
    onChange?: (value: string) => void;
    onGoToSymbol?: () => void;
    onRefactor?: (initial: { kind: string; name: string } | null) => void;
    onGrammarStateChange?: (state: unknown) => void;
  }) => (
    <div
      data-testid="asciidoc-editor"
      data-can-edit={String(properties.canEdit)}
      data-file-node-id={properties.fileNodeId ?? ''}
      data-inherited-offset={String(properties.inheritedOffset ?? '')}
    >
      {properties.onGoToSymbol && <button onClick={() => properties.onGoToSymbol?.()}>Go to Symbol</button>}
      {properties.onRefactor && (
        <button onClick={() => properties.onRefactor?.({ kind: 'attribute', name: 'seeded' })}>Refactor</button>
      )}
      {/* Stands in for the checker reporting issues. The real editor publishes this from an effect; here
          it is a button so a test decides WHEN there is a checked document, which is what the right
          panel's availability turns on. */}
      {properties.onGrammarStateChange && (
        <button
          onClick={() =>
            properties.onGrammarStateChange?.({
              diagnostics: [{ from: 0, to: 4, diagnostic: { message: 'x', category: 'spelling', grammarSuggestions: [] } }],
              status: 'ready',
              lintScope: 'this-file',
              setLintScope: () => {},
              navigate: () => {},
              apply: () => {},
              dictionary: [],
              canManageDictionary: false,
              addDictionaryTerm: () => {},
              removeDictionaryTerm: () => {},
              addIssueWordToDictionary: () => {},
              ignore: null,
              canConfigureRules: false,
              ruleConfig: {},
              ruleDescriptions: {},
              setRule: () => {},
              resetRules: () => {},
            })
          }
        >
          publish grammar state
        </button>
      )}
      {properties.content}
    </div>
  )),
}));

jest.mock('@/components/file-tree/file-tree', () => ({
  FileTree: ({ onSelectFile, openPathRequest }: {
    onSelectFile?: (id: string, name: string, path: string, type: 'file' | 'folder') => void;
    openPathRequest?: { path: string; nonce: number } | null;
  }) => (
    <div data-testid="file-tree" data-open-path={openPathRequest?.path ?? ''}>
      <button onClick={() => onSelectFile?.('picked', 'picked.adoc', '/picked.adoc', 'file')}>pick file</button>
    </div>
  ),
}));

jest.mock('@/components/asciidoc-preview', () => ({
  AsciiDocPreview: jest.fn(({ onCollapse, onToggleScrollSync, onPreviewStyleChange, mainPath }: {
    onCollapse?: () => void;
    onToggleScrollSync?: () => void;
    onPreviewStyleChange?: (style: string) => void;
    mainPath?: string;
  }) => (
    <div data-testid="asciidoc-preview" data-main-path={mainPath ?? ''}>
      {onCollapse && <button aria-label="collapse preview" onClick={onCollapse} />}
      {onToggleScrollSync && <button aria-label="toggle scroll sync" onClick={onToggleScrollSync} />}
      {onPreviewStyleChange && <button aria-label="set style" onClick={() => onPreviewStyleChange('github')} />}
    </div>
  )),
  isAsciiDocFile: (name: string) => name.endsWith('.adoc'),
}));

jest.mock('@/components/image-preview', () => ({
  ImagePreview: ({ fileName }: { fileName: string }) => <div data-testid="image-preview">{fileName}</div>,
}));

jest.mock('@/lib/codemirror/asciidoc-image-extensions', () => ({
  isImageFile: (name: string) => name.endsWith('.png') || name.endsWith('.jpg'),
}));

jest.mock('react-resizable-panels', () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children, className, ...rest }: {
    children: React.ReactNode;
    className?: string;
    // react-resizable-panels props that must not leak onto the DOM div.
    id?: string;
    order?: number;
    defaultSize?: number;
    minSize?: number;
  }) => {
    const testId = (rest as Record<string, string>)['data-testid'];
    return <div className={className} data-testid={testId}>{children}</div>;
  },
  PanelResizeHandle: () => <div />,
}));

// Go-to-symbol stub: exposes open state + a button to select the seeded symbol.
const goToSymbolSelect: { current: ((symbol: ProjectSymbol) => void) | null } = { current: null };
jest.mock('@/components/editor/editor-go-to-symbol', () => ({
  EditorGoToSymbol: ({ open, symbols, pathOf, onSelect, onClose }: {
    open: boolean;
    symbols: ProjectSymbol[];
    pathOf: (id: string) => string | null;
    onSelect: (symbol: ProjectSymbol) => void;
    onClose: () => void;
  }) => {
    goToSymbolSelect.current = onSelect;
    if (!open) return null;
    return (
      <div data-testid="go-to-symbol" data-symbol-count={symbols.length} data-first-path={symbols[0] ? pathOf(symbols[0].fileId) ?? '' : ''}>
        <button onClick={() => onSelect(symbols[0])}>select first symbol</button>
        <button aria-label="close go to symbol" onClick={onClose} />
      </div>
    );
  },
}));

// Refactor stub: exposes open state plus navigate + renamed callbacks.
jest.mock('@/components/editor/editor-symbol-refactor', () => ({
  EditorSymbolRefactor: ({ open, initial, onNavigate, onRenamed, onClose }: {
    open: boolean;
    initial?: { kind: string; name: string } | null;
    onNavigate: (usage: SymbolUsage) => void;
    onRenamed: () => void;
    onClose: () => void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="refactor" data-initial-name={initial?.name ?? ''}>
        <button onClick={() => onNavigate({ fileNodeId: 'usage-file', path: '/usage.adoc', kind: 'xref', range: { from: 7, to: 12 } })}>
          navigate usage
        </button>
        <button onClick={() => onRenamed()}>trigger renamed</button>
        <button aria-label="close refactor" onClick={onClose} />
      </div>
    );
  },
}));

jest.mock('@/lib/api/projects', () => ({
  findSymbolUsages: jest.fn(),
  renameSymbol: jest.fn(),
}));

const mockGetCollabInfo = jest.fn();
jest.mock('@/lib/api/collab', () => ({ getCollabDocumentInfo: (...a: unknown[]) => mockGetCollabInfo(...a) }));

const mockGetDocumentContent = jest.fn();
jest.mock('@/lib/api/file-content', () => ({
  getDocumentContent: (...a: unknown[]) => mockGetDocumentContent(...a),
  API_BASE_URL: 'http://localhost:4000',
}));

let mockCollabDoc: { doc: unknown; awareness: unknown; connectionState: string } = {
  doc: null, awareness: null, connectionState: 'synced',
};
jest.mock('@/hooks/use-collab-document', () => ({
  useCollabDocument: () => mockCollabDoc,
}));

jest.mock('@/hooks/use-project-presence', () => ({
  useProjectPresence: () => new Map(),
}));

const mockRefreshIndex = jest.fn();
const mockGetFiles = jest.fn(() => []);
const mockLineOf = jest.fn((_fileId: string, offset: number) => offset + 100);
const mockPathOf = jest.fn((id: string) => `/path/${id}.adoc`);
const mockInheritedOffset = jest.fn(() => 3);
const SYMBOLS: ProjectSymbol[] = [
  { kind: 'section', name: 'overview', fileId: 'sym-file', range: { from: 5, to: 9 } },
];
function makeIndex(activeFileId = 'f1') {
  return {
    activeFileId,
    symbols: SYMBOLS,
    pathOf: mockPathOf,
    lineOf: mockLineOf,
    inheritedOffset: mockInheritedOffset,
    inheritedAttributes: () => new Map<string, string>(),
  };
}
let mockIndexValue: ReturnType<typeof makeIndex> | null = makeIndex();
jest.mock('@/hooks/use-project-symbol-index', () => ({
  useProjectSymbolIndex: jest.fn(() => ({
    index: mockIndexValue,
    getIndex: () => mockIndexValue,
    getFiles: mockGetFiles,
    refresh: mockRefreshIndex,
    resolvedScopeOf: () => new Map<string, string>(),
    fileIdForPath: () => null,
    reachableDocVersion: 0,
  })),
}));

const mockSelectFile = jest.fn();
let mockFileSelection: {
  selectedFile: { nodeId: string; nodeName: string; path: string; nodeType: 'file' | 'folder' } | null;
  contentState: Record<string, unknown>;
};
jest.mock('@/hooks/use-file-selection', () => ({
  useFileSelection: () => ({
    selectedFile: mockFileSelection.selectedFile,
    contentState: mockFileSelection.contentState,
    selectFile: mockSelectFile,
    clearSelection: jest.fn(),
  }),
}));

// The stylesheet the reader currently has the preview in. Deliberately the NON-default of the two, so
// a fallback that silently hardcoded the default would be visible rather than accidentally correct.
const mockPreviewStyle = 'asciidoctor';

jest.mock('@/hooks/use-editor-preferences', () => ({
  useEditorPreferences: () => ({
    scrollSyncEnabled: true,
    setScrollSyncEnabled: jest.fn(),
    previewStyle: mockPreviewStyle,
    setPreviewStyle: jest.fn(),
    commentsPanelOpen: false,
    setCommentsPanelOpen: jest.fn(),
    // The panel-view preferences drive the left/right rails. They are part of the hook's contract,
    // so the stub has to supply them — an absent setter reaches a rail as an undefined onTabChange
    // and any tab click throws.
    leftPanelTab: 'files',
    setLeftPanelTab: jest.fn(),
    rightPanelTab: 'comments',
    setRightPanelTab: jest.fn(),
    showIncludedFiles: false,
    setShowIncludedFiles: jest.fn(),
    outlineScope: 'document',
    setOutlineScope: jest.fn(),
  }),
}));

// Review wiring (feature 038): the layout consumes the review hook + members API at mount; stub
// them so a bare mock Y.Doc never reaches the real anchor resolution.
jest.mock('@/hooks/use-review-items', () => ({
  useReviewItems: () => ({
    threads: [], ranges: [], anchorStates: new Map(),
    loading: false, error: null, refetch: jest.fn(),
    includeResolved: false, setIncludeResolved: jest.fn(),
  }),
}));
jest.mock('@/lib/api/members', () => ({
  membersApi: { list: jest.fn().mockResolvedValue({ data: { members: [] } }) },
}));

let mockStoredSelection: { nodeId: string; nodeName: string; nodeType: 'file' | 'folder'; path: string; line?: number } | null = null;
jest.mock('@/hooks/use-last-selection', () => ({
  readLastSelection: () => mockStoredSelection,
  useLastSelection: () => ({
    readLastSelection: () => mockStoredSelection,
    rememberFile: jest.fn(),
    rememberLine: jest.fn(),
    clearLastSelection: jest.fn(),
    rememberCursorLine: jest.fn(),
    readCursorLine: () => undefined,
    pruneCursor: jest.fn(),
  }),
}));

const defaultProps = {
  projectId: 'p1',
  projectName: 'Proj',
  projectDescription: 'A description',
  mainFileNodeId: null,
  canManage: true,
  canEdit: true,
  canModifyFiles: true,
  canManageDictionary: true,
  userId: 'u-test',
};

function adocFile(nodeId = 'f1') {
  return {
    selectedFile: { nodeId, nodeName: 'doc.adoc', path: '/doc.adoc', nodeType: 'file' as const },
    contentState: { content: '= Doc', etag: null, isLoading: false, error: null, isBinary: false, notFound: false },
  };
}

function collabAdocFile(nodeId = 'cf1') {
  return {
    selectedFile: { nodeId, nodeName: 'doc.adoc', path: '/doc.adoc', nodeType: 'file' as const },
    contentState: {
      content: '= Doc', etag: null, isLoading: false, error: null, isBinary: false, notFound: false,
      collab: { yjsStateId: 'y1', role: 'editor' as const },
    },
  };
}

beforeEach(() => {
  mockIndexValue = makeIndex();
  mockFileSelection = adocFile();
  mockCollabDoc = { doc: null, awareness: null, connectionState: 'synced' };
  mockSelectFile.mockReset();
  mockRefreshIndex.mockReset();
  mockGetFiles.mockReset();
  mockGetFiles.mockReturnValue([]);
  mockExportPdf.mockReset();
  mockExportHtml.mockReset();
  mockGetCollabInfo.mockReset();
  mockGetDocumentContent.mockReset();
  mockLineOf.mockClear();
  mockPathOf.mockReset();
  mockPathOf.mockImplementation((id: string) => `/path/${id}.adoc`);
  mockStoredSelection = null;
  goToSymbolSelect.current = null;
  jest.requireMock('@/components/editor/asciidoc-editor').AsciiDocEditor.mockClear();
  jest.requireMock('@/components/asciidoc-preview').AsciiDocPreview.mockClear();
  sessionStorage.clear();
});

function lastEditorProperties() {
  const editor = jest.requireMock('@/components/editor/asciidoc-editor').AsciiDocEditor;
  return editor.mock.calls.at(-1)?.[0];
}
function lastPreviewProperties() {
  const preview = jest.requireMock('@/components/asciidoc-preview').AsciiDocPreview;
  return preview.mock.calls.at(-1)?.[0];
}

describe('ProjectEditorLayout — preview toggle & scroll sync', () => {
  test('expanding the preview persists open state and threads scroll/line handlers', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /expand preview/i }));
    expect(screen.getByTestId('asciidoc-preview')).toBeInTheDocument();
    expect(sessionStorage.getItem('asciidoc-preview-open')).toBe('true');
    // With the preview open + scrollSyncEnabled, the editor receives scroll/line handlers.
    expect(typeof lastEditorProperties()?.onScrollLine).toBe('function');
    expect(typeof lastEditorProperties()?.onLineClick).toBe('function');
  });

  test('restores the preview-open state from sessionStorage on mount', async () => {
    sessionStorage.setItem('asciidoc-preview-open', 'true');
    render(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId('asciidoc-preview')).toBeInTheDocument());
  });

  test('collapsing the preview hides it and persists the closed state', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /expand preview/i }));
    fireEvent.click(screen.getByRole('button', { name: /collapse preview/i }));
    expect(screen.queryByTestId('asciidoc-preview')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('asciidoc-preview-open')).toBe('false');
  });

  // The right panel is a member of the editor's panel group, so a collapsed-preview strip rendered
  // AFTER that group would sit beyond the right panel's rail instead of before it. Keeping the strip
  // inside the group is what holds it in the preview's own place: editor | preview | right panel.
  test('the collapsed preview strip keeps the preview\'s place in the row, inside the panel group', () => {
    render(<ProjectEditorLayout {...defaultProps} />);

    const strip = screen.getByRole('button', { name: /expand preview/i });
    const editorPanel = screen.getByTestId('content-panel');

    // Same container as the editor panel — i.e. still within the panel group, not a sibling after it.
    expect(editorPanel.parentElement?.contains(strip)).toBe(true);
    // ...and positioned after the editor, so it stands where the preview would open.
    expect(editorPanel.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('scroll-sync handler dedups identical lines, line-click always re-fires', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /expand preview/i }));
    const props = lastEditorProperties();
    act(() => { props.onScrollLine(5); });
    act(() => { props.onScrollLine(5); });
    act(() => { props.onLineClick(8); });
    expect(lastPreviewProperties()?.scrollToLine).toEqual({ line: 8 });
  });

  test('preview scroll-sync + style toggles invoke their handlers', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /expand preview/i }));
    fireEvent.click(screen.getByRole('button', { name: /toggle scroll sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /set style/i }));
    // No throw — handlers are wired through to the preference setters.
    expect(screen.getByTestId('asciidoc-preview')).toBeInTheDocument();
  });
});

describe('ProjectEditorLayout — PDF export', () => {
  test('the Export to PDF action builds a snapshot (fetching referenced assets) and renders it', async () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export to pdf/i }));
    });
    // The open file resolves to a render-root path (mockPathOf), so the export path awaits the (empty)
    // asset fetch and hands the resulting snapshot to the render hook.
    await waitFor(() => expect(mockExportPdf).toHaveBeenCalledTimes(1));
    expect(mockExportPdf.mock.calls[0][0]).toEqual(expect.objectContaining({ rootPath: expect.any(String) }));
  });

  // Race guard: the render root's content is fetched asynchronously by the symbol index, so it can be
  // transiently absent from `getFiles()` even while the main-file path is known and the button is
  // enabled (at first load, or for a frame after an SSE invalidation refetches it). Dispatching then
  // produces a snapshot whose rootPath has no content and the engine fails with "root document is
  // missing from the project snapshot" — the flake this test pins closed.
  test('the export waits for a transiently-absent render root to (re)load before dispatching', async () => {
    mockFileSelection = adocFile('mainfile-1');
    const rootPath = '/path/mainfile-1.adoc';
    // The root is missing from the snapshot source until a rebuild (re)loads it.
    let rootAvailable = false;
    mockGetFiles.mockImplementation(() => (rootAvailable ? { [rootPath]: '= Doc' } : {}));
    mockRefreshIndex.mockImplementation(() => {
      rootAvailable = true;
      return Promise.resolve();
    });

    render(<ProjectEditorLayout {...defaultProps} mainFileNodeId="mainfile-1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export to pdf/i }));
    });

    // The guard forced a rebuild and only dispatched once the root content had arrived.
    await waitFor(() => expect(mockExportPdf).toHaveBeenCalledTimes(1));
    expect(mockRefreshIndex).toHaveBeenCalled();
    expect(mockExportPdf.mock.calls[0][0]).toEqual(expect.objectContaining({ rootPath }));
  });

  test('the export does not force a rebuild when the render root is already loaded', async () => {
    mockFileSelection = adocFile('mainfile-1');
    mockGetFiles.mockReturnValue({ '/path/mainfile-1.adoc': '= Doc' });

    render(<ProjectEditorLayout {...defaultProps} mainFileNodeId="mainfile-1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export to pdf/i }));
    });

    await waitFor(() => expect(mockExportPdf).toHaveBeenCalledTimes(1));
    expect(mockRefreshIndex).not.toHaveBeenCalled();
  });
});

describe('ProjectEditorLayout — HTML export', () => {
  test('the Export to HTML action sits beside the PDF one and exports the whole document', async () => {
    mockFileSelection = adocFile('mainfile-1');
    mockGetFiles.mockReturnValue({ '/path/mainfile-1.adoc': '= Doc' });

    render(<ProjectEditorLayout {...defaultProps} mainFileNodeId="mainfile-1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export to html/i }));
    });

    await waitFor(() => expect(mockExportHtml).toHaveBeenCalledTimes(1));
    // The configured main document is the root, exactly as the PDF export does it — never the open
    // file, which for a multi-file project would export a fragment of the document. The project name
    // travels with it, because that — not the root — is what the download is named after.
    expect(mockExportHtml.mock.calls[0][0]).toEqual(
      expect.objectContaining({ rootPath: '/path/mainfile-1.adoc', projectName: 'Proj' }),
    );
  });

  test('it applies the project defaults when the project has configured nothing', async () => {
    // The render-config mock returns `{}`, so every option falls back: one self-contained file, the
    // light palette, and — rather than a fixed stylesheet — whichever one the reader currently has the
    // preview in, so an unconfigured export matches the panel it was taken from.
    render(<ProjectEditorLayout {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export to html/i }));
    });

    await waitFor(() => expect(mockExportHtml).toHaveBeenCalledTimes(1));
    expect(mockExportHtml.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        packaging: 'single-file',
        theme: 'light',
        style: mockPreviewStyle,
      }),
    );
  });

  test('it waits for a transiently-absent render root, like the PDF export', async () => {
    mockFileSelection = adocFile('mainfile-1');
    const rootPath = '/path/mainfile-1.adoc';
    let rootAvailable = false;
    mockGetFiles.mockImplementation(() => (rootAvailable ? { [rootPath]: '= Doc' } : {}));
    mockRefreshIndex.mockImplementation(() => {
      rootAvailable = true;
      return Promise.resolve();
    });

    render(<ProjectEditorLayout {...defaultProps} mainFileNodeId="mainfile-1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export to html/i }));
    });

    await waitFor(() => expect(mockExportHtml).toHaveBeenCalledTimes(1));
    expect(mockRefreshIndex).toHaveBeenCalled();
    expect(mockExportHtml.mock.calls[0][0].files).toEqual({ [rootPath]: '= Doc' });
  });
});

describe('ProjectEditorLayout — main-file picker wiring', () => {
  test('the assembled-document preview path is used when the open file is the main file', () => {
    mockFileSelection = adocFile('mainfile-1');
    render(<ProjectEditorLayout {...defaultProps} mainFileNodeId="mainfile-1" />);
    fireEvent.click(screen.getByRole('button', { name: /expand preview/i }));
    expect(lastPreviewProperties()?.mainPath).toBe('/path/mainfile-1.adoc');
  });
});

describe('ProjectEditorLayout — go to symbol', () => {
  test('toolbar button opens the palette seeded with the index symbols', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /go to symbol/i }));
    expect(screen.getByTestId('go-to-symbol')).toHaveAttribute('data-symbol-count', '1');
  });

  test('Ctrl+Shift+O keyboard shortcut opens the palette', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => {
      fireEvent.keyDown(globalThis, { key: 'o', ctrlKey: true, shiftKey: true });
    });
    expect(screen.getByTestId('go-to-symbol')).toBeInTheDocument();
  });

  test('selecting a symbol navigates via lineOf and closes the palette', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /go to symbol/i }));
    fireEvent.click(screen.getByRole('button', { name: /select first symbol/i }));
    expect(mockLineOf).toHaveBeenCalledWith('sym-file', 5);
    expect(screen.queryByTestId('go-to-symbol')).not.toBeInTheDocument();
  });

  test('selecting a symbol is a no-op when the index is unavailable', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /go to symbol/i }));
    mockIndexValue = null;
    act(() => { goToSymbolSelect.current?.(SYMBOLS[0]); });
    expect(mockLineOf).not.toHaveBeenCalled();
  });

  test('closing the palette via onClose hides it', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /go to symbol/i }));
    fireEvent.click(screen.getByRole('button', { name: /close go to symbol/i }));
    expect(screen.queryByTestId('go-to-symbol')).not.toBeInTheDocument();
  });
});

describe('ProjectEditorLayout — refactor dialog', () => {
  test('toolbar button opens the refactor dialog seeded with the cursor symbol', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /refactor/i }));
    const dialog = screen.getByTestId('refactor');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('data-initial-name', 'seeded');
  });

  test('Ctrl+Shift+R keyboard shortcut opens the dialog cold (no cursor seed)', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => {
      fireEvent.keyDown(globalThis, { key: 'r', ctrlKey: true, shiftKey: true });
    });
    const dialog = screen.getByTestId('refactor');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('data-initial-name', '');
  });

  test('navigating to a cross-file usage uses lineOf and switches files', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /refactor/i }));
    fireEvent.click(screen.getByRole('button', { name: /navigate usage/i }));
    expect(mockLineOf).toHaveBeenCalledWith('usage-file', 7);
    // Cross-file usage requests the tree to open the usage path.
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-open-path', '/usage.adoc');
  });

  test('onRenamed refreshes the project symbol index', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /refactor/i }));
    fireEvent.click(screen.getByRole('button', { name: /trigger renamed/i }));
    expect(mockRefreshIndex).toHaveBeenCalled();
  });

  test('usage navigation is a no-op when the index is unavailable', () => {
    mockIndexValue = null;
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /refactor/i }));
    fireEvent.click(screen.getByRole('button', { name: /navigate usage/i }));
    expect(mockLineOf).not.toHaveBeenCalled();
  });

  test('closing the refactor dialog via onClose hides it', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /refactor/i }));
    fireEvent.click(screen.getByRole('button', { name: /close refactor/i }));
    expect(screen.queryByTestId('refactor')).not.toBeInTheDocument();
  });
});

describe('ProjectEditorLayout — editor navigation callbacks', () => {
  test('onNavigateToFile asks the tree to reveal the path', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { lastEditorProperties().onNavigateToFile('/includes/child.adoc'); });
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-open-path', '/includes/child.adoc');
  });

  test('same-file xref reveals in place via revealRequest', async () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { lastEditorProperties().onNavigateToXref({ fileId: 'f1', path: null, line: 42, sameFile: true }); });
    await waitFor(() => expect(lastEditorProperties()?.revealRequest).toEqual({ line: 42, nonce: expect.any(Number) }));
  });

  test('cross-file xref opens the defining file', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { lastEditorProperties().onNavigateToXref({ fileId: 'other', path: '/other.adoc', line: 9, sameFile: false }); });
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-open-path', '/other.adoc');
  });

  test('onOpenUrl opens a new tab with safe rel options', () => {
    const openSpy = jest.spyOn(globalThis, 'open').mockImplementation(() => null);
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { lastEditorProperties().onOpenUrl('https://example.com'); });
    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  test('the editor receives the inherited heading-level offset from the index', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-inherited-offset', '3');
  });

  test('the file picked from the tree is selected (handleSelectFile)', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /pick file/i }));
    expect(mockSelectFile).toHaveBeenCalledWith('picked', 'picked.adoc', '/picked.adoc', 'file');
  });
});

describe('ProjectEditorLayout — content branches', () => {
  test('renders an image preview for binary image files', () => {
    mockFileSelection = {
      selectedFile: { nodeId: 'img1', nodeName: 'pic.png', path: '/pic.png', nodeType: 'file' },
      contentState: { content: null, etag: null, isLoading: false, error: null, isBinary: true, notFound: false },
    };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('image-preview')).toHaveTextContent('pic.png');
  });

  test('shows the not-available message for non-image binary files', () => {
    mockFileSelection = {
      selectedFile: { nodeId: 'bin1', nodeName: 'data.bin', path: '/data.bin', nodeType: 'file' },
      contentState: { content: null, etag: null, isLoading: false, error: null, isBinary: true, notFound: false },
    };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByText(/preview not available for binary files/i)).toBeInTheDocument();
  });

  test('shows the content error message when the fetch failed', () => {
    mockFileSelection = {
      selectedFile: { nodeId: 'e1', nodeName: 'doc.adoc', path: '/doc.adoc', nodeType: 'file' },
      contentState: { content: null, etag: null, isLoading: false, error: 'Boom', isBinary: false, notFound: false },
    };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  test('shows the loading skeleton while content is loading', () => {
    mockFileSelection = {
      selectedFile: { nodeId: 'l1', nodeName: 'doc.adoc', path: '/doc.adoc', nodeType: 'file' },
      contentState: { content: null, etag: null, isLoading: true, error: null, isBinary: false, notFound: false },
    };
    const { container } = render(<ProjectEditorLayout {...defaultProps} />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });
});

// Queried fresh on each call: collapsing re-renders, so a captured element goes stale.
const leftPanelBody = () => document.querySelector('#left-panel-body');
const leftRail = () => screen.getByRole('tablist', { name: 'Left panel views' });
const filesTab = () => screen.getByRole('tab', { name: 'Files' });

describe('ProjectEditorLayout — sidebar expand', () => {
  // Collapsing hides the BODY and leaves the rail on screen as the editor's activity bar, so the
  // views stay visible and one click away — the panel wrapper itself never hides.
  test('collapsing then expanding the sidebar toggles the body, keeping the rail visible', () => {
    render(<ProjectEditorLayout {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(leftPanelBody()).toHaveClass('hidden');
    expect(leftRail()).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /expand sidebar/i }));
    expect(leftPanelBody()).not.toHaveClass('hidden');
    expect(leftRail()).toBeVisible();
  });

  test('activating the view already showing collapses the panel, and activating it again reopens it', () => {
    render(<ProjectEditorLayout {...defaultProps} />);

    expect(leftPanelBody()).not.toHaveClass('hidden');
    fireEvent.click(filesTab());
    expect(leftPanelBody()).toHaveClass('hidden');
    fireEvent.click(filesTab());
    expect(leftPanelBody()).not.toHaveClass('hidden');
  });

  test('activating a DIFFERENT view while collapsed reopens the panel onto that view', () => {
    render(<ProjectEditorLayout {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(leftPanelBody()).toHaveClass('hidden');

    // (The stubbed preference hook does not persist the new tab, so this asserts the reopen only.)
    fireEvent.click(screen.getByRole('tab', { name: 'Outline' }));
    expect(leftPanelBody()).not.toHaveClass('hidden');
  });
});

describe('ProjectEditorLayout — viewer gating & description', () => {
  test('renders the project description in the header', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByText('A description')).toBeInTheDocument();
  });

  test('does not render Settings/Members for non-managers', () => {
    render(<ProjectEditorLayout {...defaultProps} canManage={false} />);
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /members/i })).not.toBeInTheDocument();
  });
});

describe('ProjectEditorLayout — keyboard shortcut variants', () => {
  test('Cmd+Shift+O (uppercase) opens go-to-symbol', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { fireEvent.keyDown(globalThis, { key: 'O', metaKey: true, shiftKey: true }); });
    expect(screen.getByTestId('go-to-symbol')).toBeInTheDocument();
  });

  test('Cmd+Shift+R (uppercase) opens the refactor dialog', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { fireEvent.keyDown(globalThis, { key: 'R', metaKey: true, shiftKey: true }); });
    expect(screen.getByTestId('refactor')).toBeInTheDocument();
  });
});

describe('ProjectEditorLayout — go-to-symbol path resolution', () => {
  test('the palette resolves each symbol file id to its path via the index', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /go to symbol/i }));
    expect(screen.getByTestId('go-to-symbol')).toHaveAttribute('data-first-path', '/path/sym-file.adoc');
  });
});

describe('ProjectEditorLayout — cross-file xref then selection threads the line', () => {
  test('a cross-file xref carries its line to the next selection as initialLine', async () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    // Cross-file xref stores the pending line and asks the tree to open the file...
    act(() => { lastEditorProperties().onNavigateToXref({ fileId: 'other', path: '/other.adoc', line: 17, sameFile: false }); });
    // ...then the tree selecting that file applies the pending line as the restored line.
    fireEvent.click(screen.getByRole('button', { name: /pick file/i }));
    // The next selection consumes the pending line; selectFile was invoked for the picked node.
    expect(mockSelectFile).toHaveBeenCalledWith('picked', 'picked.adoc', '/picked.adoc', 'file');
  });
});

describe('ProjectEditorLayout — cursor-line debounce restart', () => {
  test('a second cursor move within the window clears the prior timer before scheduling', () => {
    jest.useFakeTimers();
    try {
      render(<ProjectEditorLayout {...defaultProps} />);
      const props = lastEditorProperties();
      act(() => { props.onCursorLineChange(3); });
      act(() => { props.onCursorLineChange(4); });
      act(() => { jest.advanceTimersByTime(500); });
      // No throw and the timer-restart branch (clearTimeout of the existing handle) is exercised.
      expect(screen.getByTestId('asciidoc-editor')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ProjectEditorLayout — collaboration-backed selection', () => {
  test('a collab file whose Y.Doc is not ready yet shows the pending placeholder (no REST editor)', () => {
    mockFileSelection = collabAdocFile();
    mockCollabDoc = { doc: null, awareness: null, connectionState: 'connecting' };
    const { container } = render(<ProjectEditorLayout {...defaultProps} />);
    // collabPending → loading skeleton, the legacy editor must not mount.
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('asciidoc-editor')).not.toBeInTheDocument();
  });

  test('a ready collab binding mounts the editor with the collab connection state', () => {
    mockFileSelection = collabAdocFile();
    mockCollabDoc = { doc: {}, awareness: {}, connectionState: 'synced' };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('asciidoc-editor')).toBeInTheDocument();
    expect(lastEditorProperties()?.collab?.role).toBe('editor');
  });

  test('the offline fallback seeds the editor read-only from GET /content', async () => {
    mockFileSelection = collabAdocFile();
    mockCollabDoc = { doc: {}, awareness: {}, connectionState: 'offline' };
    mockGetDocumentContent.mockResolvedValue('= Offline body');
    render(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId('asciidoc-editor')).toHaveTextContent('= Offline body'));
    expect(lastEditorProperties()?.canEdit).toBe(false);
    expect(mockGetDocumentContent).toHaveBeenCalledWith('p1', 'cf1');
  });

  test('the offline fallback falls back to an empty buffer when GET /content fails', async () => {
    mockFileSelection = collabAdocFile();
    mockCollabDoc = { doc: {}, awareness: {}, connectionState: 'offline' };
    mockGetDocumentContent.mockRejectedValue(new Error('boom'));
    render(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(mockGetDocumentContent).toHaveBeenCalled());
    // The editor still mounts read-only with an empty override rather than getting stuck pending.
    await waitFor(() => expect(screen.getByTestId('asciidoc-editor')).toBeInTheDocument());
  });

  test('a reconnect that re-checks the role to observer flips the editor read-only', async () => {
    mockFileSelection = collabAdocFile();
    mockCollabDoc = { doc: {}, awareness: {}, connectionState: 'synced' };
    mockGetCollabInfo.mockResolvedValue({ yjsStateId: 'y1', role: 'observer' });

    const { rerender } = render(<ProjectEditorLayout {...defaultProps} />);
    expect(lastEditorProperties()?.collab?.role).toBe('editor');

    mockCollabDoc = { doc: {}, awareness: {}, connectionState: 'reconnecting' };
    rerender(<ProjectEditorLayout {...defaultProps} />);
    mockCollabDoc = { doc: {}, awareness: {}, connectionState: 'synced' };
    rerender(<ProjectEditorLayout {...defaultProps} />);

    await waitFor(() => expect(lastEditorProperties()?.collab?.role).toBe('observer'));
    expect(mockGetCollabInfo).toHaveBeenCalledWith('p1', 'cf1');
  });
});

describe('ProjectEditorLayout — restored-line & index-null edge branches', () => {
  test('a stored selection with a line threads it to the editor as initialLine', async () => {
    mockStoredSelection = { nodeId: 'f1', nodeName: 'doc.adoc', nodeType: 'file', path: '/doc.adoc', line: 88 };
    render(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(lastEditorProperties()?.initialLine).toBe(88));
  });

  test('the go-to-symbol palette tolerates a null project index for path resolution', () => {
    mockIndexValue = null;
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /go to symbol/i }));
    // index null → symbolPathOf returns null; the palette still renders (empty symbol list).
    expect(screen.getByTestId('go-to-symbol')).toHaveAttribute('data-symbol-count', '0');
  });

  test('the assembled-document preview path is omitted when the main file has no resolvable path', () => {
    mockFileSelection = adocFile('mainfile-1');
    mockPathOf.mockImplementation(() => null);
    render(<ProjectEditorLayout {...defaultProps} mainFileNodeId="mainfile-1" />);
    fireEvent.click(screen.getByRole('button', { name: /expand preview/i }));
    expect(lastPreviewProperties()?.mainPath).toBeUndefined();
  });
});

describe('ProjectEditorLayout — Writing panel without collaboration', () => {
  test('the right panel stays out of the way until there is something to show', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.queryByTestId('right-panel-tab-writing')).not.toBeInTheDocument();
  });

  test('the Writing view and its issue count are reachable on a non-collaborative document', async () => {
    // Grammar checking is entirely local and was still underlining the text; gating the whole right
    // panel on a live Y.Doc hid the Issues list and the count for every document without collab.
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'publish grammar state' }));
    expect(await screen.findByTestId('right-panel-tab-writing')).toBeInTheDocument();
    expect(screen.getByTestId('right-panel-count-writing')).toHaveTextContent('1');
  });
});
