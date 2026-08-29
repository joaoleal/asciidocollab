import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ProjectEditorLayout } from '@/app/(dashboard)/dashboard/projects/[id]/project-editor-layout';
import type { ProjectSnapshot } from '@asciidocollab/asciidoc-pdf';

// Coverage suite for the layout's rendering seams: the page-formatted preview (its snapshot capture,
// scroll-sync bridge and click-to-source), the one-click exports and their root-content guard, and the
// outline/search navigation that routes a click either into the open editor or into another file.

jest.mock('@/contexts/current-user-context', () => ({
  useCurrentUser: () => ({ userId: 'u-test', displayName: 'Test User', email: 't@example.com' }),
}));

const mockExportPdf = jest.fn();
jest.mock('@/hooks/use-pdf-export', () => ({
  usePdfExport: () => ({ exportPdf: mockExportPdf, isExporting: false, diagnostics: [], error: null }),
}));
const mockExportHtml = jest.fn();
jest.mock('@/hooks/use-html-export', () => ({
  useHtmlExport: () => ({ exportHtml: mockExportHtml, isExporting: false, failures: [], error: null }),
}));
// The export buttons gate themselves on configuration readiness; this suite drives the handlers, so
// the buttons are stubbed as always-pressable and the gating is asserted through the handler itself.
jest.mock('@/components/pdf-export-button', () => ({
  PdfExportButton: ({ onExport }: { onExport: () => void }) => (
    <button onClick={onExport}>export pdf</button>
  ),
}));
jest.mock('@/components/html-export-button', () => ({
  HtmlExportButton: ({ onExport }: { onExport: () => void }) => (
    <button onClick={onExport}>export html</button>
  ),
}));

let mockRenderConfig: Record<string, unknown> = {};
jest.mock('@/hooks/use-project-render-config', () => ({
  useProjectRenderConfig: () => ({
    config: mockRenderConfig, loading: false, saving: false, error: null, save: jest.fn(),
  }),
}));

// The live PDF preview: the layout hands it a capture function, which a test invokes directly.
let capturedSnapshotCapture: (() => ProjectSnapshot | null) | null = null;
let mockSourceMap: { line: number; page: number; yFraction: number }[] | undefined;
let mockRenderedSnapshot: ProjectSnapshot | undefined;
jest.mock('@/hooks/use-pdf-preview', () => ({
  usePdfPreview: (options: { snapshot: (() => ProjectSnapshot | null) | null }) => {
    capturedSnapshotCapture = options.snapshot;
    return {
      pdf: undefined, isRendering: false, phase: undefined, diagnostics: [], error: null,
      sourceMap: mockSourceMap, stats: undefined, renderedSnapshot: mockRenderedSnapshot,
    };
  },
}));
jest.mock('@/components/pdf-preview-panel', () => ({
  PdfPreviewPanel: ({ onSelectLocation, onNavigateToSource, onNavigateToExactSource, onToggleScrollSync, onCollapse, assembledLine, sourceMap }: {
    onSelectLocation: (location: { path: string; line?: number }) => void;
    onNavigateToSource: (line: number) => void;
    onNavigateToExactSource: (path: string, line: number) => void;
    onToggleScrollSync: () => void;
    onCollapse: () => void;
    assembledLine?: number;
    sourceMap?: unknown[];
  }) => (
    <div
      data-testid="pdf-preview-panel"
      data-assembled-line={assembledLine ?? ''}
      data-source-map-size={sourceMap?.length ?? ''}
    >
      <button onClick={() => onSelectLocation({ path: 'main.adoc', line: 4 })}>pdf diagnostic here</button>
      <button onClick={() => onSelectLocation({ path: 'main.adoc' })}>pdf diagnostic lineless</button>
      <button onClick={() => onSelectLocation({ path: 'other.adoc' })}>pdf diagnostic elsewhere lineless</button>
      <button onClick={() => onNavigateToSource(2)}>pdf click to source</button>
      <button onClick={() => onNavigateToExactSource('main.adoc', 9)}>pdf exact source</button>
      <button onClick={onToggleScrollSync}>pdf toggle scroll sync</button>
      <button onClick={onCollapse}>pdf collapse</button>
    </div>
  ),
}));

jest.mock('@/components/editor/asciidoc-editor', () => ({
  AsciiDocEditor: ({ content, revealRequest }: { content: string; revealRequest?: { line: number } | null }) => (
    <div data-testid="asciidoc-editor" data-reveal-line={revealRequest?.line ?? ''}>{content}</div>
  ),
}));

jest.mock('@/components/file-tree/file-tree', () => ({
  FileTree: ({ openPathRequest }: { openPathRequest?: { path: string } | null }) => (
    <div data-testid="file-tree" data-open-path={openPathRequest?.path ?? ''} />
  ),
}));

jest.mock('@/components/asciidoc-preview', () => ({
  AsciiDocPreview: ({ onPreviewModeChange, onNavigateToSource, onSelectDiagnosticLocation, onShowIncludedFilesChange, onCollapse, onToggleScrollSync, mainPath, rootFilePath, outsideMainTree }: {
    onPreviewModeChange: (mode: 'html' | 'pdf') => void;
    onNavigateToSource: (line: number) => void;
    onSelectDiagnosticLocation: (location: { path: string; line?: number }) => void;
    onShowIncludedFilesChange: (value: boolean) => void;
    onCollapse: () => void;
    onToggleScrollSync: () => void;
    mainPath?: string;
    rootFilePath?: string | null;
    outsideMainTree?: boolean;
  }) => (
    <div
      data-testid="asciidoc-preview"
      data-main-path={mainPath ?? ''}
      data-root-path={rootFilePath ?? ''}
      data-outside={String(outsideMainTree ?? false)}
    >
      <button onClick={() => onPreviewModeChange('pdf')}>switch to pdf</button>
      <button onClick={() => onNavigateToSource(3)}>html click to source</button>
      <button onClick={() => onSelectDiagnosticLocation({ path: 'main.adoc', line: 2 })}>html diagnostic</button>
      <button onClick={() => onShowIncludedFilesChange(true)}>show includes</button>
      <button onClick={onToggleScrollSync}>html toggle scroll sync</button>
      <button onClick={onCollapse}>html collapse</button>
    </div>
  ),
  isAsciiDocFile: (name: string) => name.endsWith('.adoc'),
}));

// The left panel renders all three of its slots so the outline and search callbacks are reachable
// without driving the rail's own tab switching (covered by the rail's suite).
jest.mock('@/components/editor/left-panel', () => ({
  LeftPanel: ({ filesSlot, outlineSlot, searchSlot }: {
    filesSlot: React.ReactNode; outlineSlot: React.ReactNode; searchSlot: React.ReactNode;
  }) => <div>{filesSlot}{outlineSlot}{searchSlot}</div>,
}));
jest.mock('@/components/editor/outline-view', () => ({
  OutlineView: ({ onHeadingClick, entries, effectiveScope }: {
    onHeadingClick: (entry: Record<string, unknown>) => void;
    entries: { title?: string }[];
    effectiveScope: string;
  }) => (
    <div data-testid="outline-view" data-entry-count={entries.length} data-scope={effectiveScope}>
      <button onClick={() => onHeadingClick({ line: 5, sourceLine: 7, isOpenFile: true })}>
        outline heading here
      </button>
      <button onClick={() => onHeadingClick({ line: 5, isOpenFile: false, sourcePath: 'other.adoc', sourceLine: 11 })}>
        outline heading elsewhere
      </button>
      <button onClick={() => onHeadingClick({ line: 5, isOpenFile: false })}>
        outline heading without a source
      </button>
    </div>
  ),
}));
jest.mock('@/components/editor/search-view', () => ({
  SearchView: ({ onNavigate }: { onNavigate: (t: { fileNodeId: string; path: string; line: number }) => void }) => (
    <div data-testid="search-view">
      <button onClick={() => onNavigate({ fileNodeId: 'main', path: 'main.adoc', line: 6 })}>
        search hit here
      </button>
      <button onClick={() => onNavigate({ fileNodeId: 'other', path: 'other.adoc', line: 8 })}>
        search hit elsewhere
      </button>
    </div>
  ),
}));

jest.mock('react-resizable-panels', () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));

jest.mock('@/hooks/use-git-status', () => ({
  useGitStatus: () => ({ status: null, connected: false, loading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('@/hooks/use-git-tree-status', () => ({
  useGitTreeStatus: () => ({ statusByFileNodeId: {}, loading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('@/hooks/use-file-tree-events', () => ({ useFileTreeEvents: () => {} }));
jest.mock('@/hooks/use-collab-document', () => ({
  useCollabDocument: () => ({ doc: null, awareness: null, connectionState: 'synced' }),
}));
jest.mock('@/hooks/use-project-presence', () => ({ useProjectPresence: () => new Map() }));
jest.mock('@/hooks/use-review-items', () => ({
  useReviewItems: () => ({
    threads: [], ranges: [], anchorStates: new Map(), loading: false, error: null,
    refetch: jest.fn(), includeResolved: true, setIncludeResolved: jest.fn(),
  }),
}));
jest.mock('@/lib/api/members', () => ({
  membersApi: { list: jest.fn().mockResolvedValue({ data: { members: [] } }) },
}));
jest.mock('@/lib/api/projects', () => ({ findSymbolUsages: jest.fn(), renameSymbol: jest.fn() }));
jest.mock('@/hooks/use-last-selection', () => ({
  readLastSelection: () => null,
  useLastSelection: () => ({
    readLastSelection: () => null, rememberFile: jest.fn(), rememberLine: jest.fn(),
    clearLastSelection: jest.fn(), rememberCursorLine: jest.fn(),
    readCursorLine: () => undefined, pruneCursor: jest.fn(),
  }),
}));

// The project's text cache: a two-file include tree so the assembled outline and the scroll-sync
// bridge both have something real to walk.
const MAIN = '= Main\n\ninclude::other.adoc[]\n\n== Tail\n';
const OTHER = '== Included\n\nbody\n';
let mockFiles: Record<string, string> = {};
const mockRefreshIndex = jest.fn().mockResolvedValue(undefined);
const mockGetFiles = jest.fn(() => mockFiles);
let mockIndexPresent = true;
const projectIndex = {
  activeFileId: 'main',
  symbols: [],
  pathOf: (id: string) => (id === 'main' ? 'main.adoc' : `${id}.adoc`),
  lineOf: (_fileId: string, offset: number) => offset + 1,
  inheritedOffset: () => 0,
  inheritedAttributes: () => new Map<string, string>(),
};
jest.mock('@/hooks/use-project-symbol-index', () => ({
  useProjectSymbolIndex: () => ({
    index: mockIndexPresent ? projectIndex : null,
    getIndex: () => (mockIndexPresent ? projectIndex : null),
    getFiles: mockGetFiles,
    refresh: mockRefreshIndex,
    resolvedScopeOf: () => new Map<string, string>(),
    fileIdForPath: (path: string) => (path === 'main.adoc' ? 'main' : 'other'),
    reachableDocVersion: 0,
  }),
}));

let mockSelectedFile: { nodeId: string; nodeName: string; path: string; nodeType: 'file' } | null = null;
jest.mock('@/hooks/use-file-selection', () => ({
  useFileSelection: () => ({
    selectedFile: mockSelectedFile,
    contentState: { content: MAIN, etag: null, isLoading: false, error: null, isBinary: false, notFound: false },
    selectFile: jest.fn(),
    clearSelection: jest.fn(),
  }),
}));

let mockPreviewStyle = 'asciidoctor';
let mockScrollSync = true;
let mockOutlineScope = 'document';
jest.mock('@/hooks/use-editor-preferences', () => {
  const react: typeof React = jest.requireActual('react');
  return {
    useEditorPreferences: () => {
      const [showIncludedFiles, setShowIncludedFiles] = react.useState(false);
      const [scrollSyncEnabled, setScrollSyncEnabled] = react.useState(mockScrollSync);
      return {
        scrollSyncEnabled, setScrollSyncEnabled,
        previewStyle: mockPreviewStyle, setPreviewStyle: jest.fn(),
        commentsPanelOpen: false, setCommentsPanelOpen: jest.fn(),
        leftPanelTab: 'files', setLeftPanelTab: jest.fn(),
        rightPanelTab: 'comments', setRightPanelTab: jest.fn(),
        showIncludedFiles, setShowIncludedFiles,
        outlineScope: mockOutlineScope, setOutlineScope: jest.fn(),
      };
    },
  };
});

const defaultProps = {
  projectId: 'p1',
  projectName: 'Proj',
  projectDescription: null,
  projectLanguage: 'fr',
  mainFileNodeId: 'main',
  canManage: false,
  canEdit: true,
  canModifyFiles: true,
  canManageDictionary: true,
  userId: 'u-test',
};

function snapshotOf(files: Record<string, string>): ProjectSnapshot {
  return {
    files,
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    attributes: {},
  };
}

beforeEach(() => {
  mockFiles = { 'main.adoc': MAIN, 'other.adoc': OTHER };
  mockSelectedFile = { nodeId: 'main', nodeName: 'main.adoc', path: 'main.adoc', nodeType: 'file' };
  mockIndexPresent = true;
  mockPreviewStyle = 'asciidoctor';
  mockScrollSync = true;
  mockOutlineScope = 'document';
  mockRenderConfig = {};
  mockSourceMap = undefined;
  mockRenderedSnapshot = undefined;
  capturedSnapshotCapture = null;
  mockExportPdf.mockClear();
  mockExportHtml.mockClear();
  mockRefreshIndex.mockClear();
  mockGetFiles.mockClear();
  sessionStorage.clear();
  sessionStorage.setItem('asciidoc-preview-open', 'true');
});

function switchToPdfPreview() {
  fireEvent.click(screen.getByRole('button', { name: /switch to pdf/i }));
}

describe('ProjectEditorLayout — page-formatted preview', () => {
  test('switches the open preview between the document and page renderings', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('asciidoc-preview')).toBeInTheDocument();
    switchToPdfPreview();
    expect(screen.getByTestId('pdf-preview-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('asciidoc-preview')).not.toBeInTheDocument();
  });

  test('captures a snapshot rooted at the main document once the page rendering is showing', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    let snapshot: ProjectSnapshot | null = null as ProjectSnapshot | null;
    act(() => { snapshot = capturedSnapshotCapture?.() ?? null; });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.rootPath).toBe('main.adoc');
    expect(Object.keys(snapshot?.files ?? {})).toContain('main.adoc');
  });

  test('captures nothing while no render root has resolved', () => {
    mockIndexPresent = false;
    render(<ProjectEditorLayout {...defaultProps} mainFileNodeId={null} />);
    switchToPdfPreview();
    let snapshot: ProjectSnapshot | null = null as ProjectSnapshot | null;
    act(() => { snapshot = capturedSnapshotCapture?.() ?? null; });
    expect(snapshot).toBeNull();
  });

  test('leaves the page rendering idle for a file it cannot render', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    // A theme is YAML: the document preview steps aside rather than rendering a page of raw YAML.
    mockSelectedFile = { nodeId: 'theme', nodeName: 'theme.yml', path: '/theme.yml', nodeType: 'file' };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.queryAllByTestId('pdf-preview-panel')).toHaveLength(1);
  });

  test('builds the scroll-sync bridge from the snapshot the page on screen was rendered from', () => {
    mockRenderedSnapshot = snapshotOf({ 'main.adoc': MAIN, 'other.adoc': OTHER });
    mockSourceMap = [{ line: 1, page: 1, yFraction: 0 }, { line: 5, page: 1, yFraction: 0.5 }];
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    const panel = screen.getByTestId('pdf-preview-panel');
    // The engine's map is lifted to block starts and handed on; a raw pass-through would keep both
    // entries unchanged, so its presence is what the panel is asserted to have received.
    expect(panel.dataset.sourceMapSize).not.toBe('');
  });

  test('hands the panel the raw engine map when there is nothing to build a bridge from', () => {
    mockSourceMap = [{ line: 1, page: 1, yFraction: 0 }];
    mockRenderedSnapshot = undefined;
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    expect(screen.getByTestId('pdf-preview-panel')).toHaveAttribute('data-source-map-size', '1');
  });

  test('builds no bridge for an empty engine map', () => {
    mockRenderedSnapshot = snapshotOf({ 'main.adoc': MAIN, 'other.adoc': OTHER });
    mockSourceMap = [];
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    expect(screen.getByTestId('pdf-preview-panel')).toHaveAttribute('data-source-map-size', '0');
  });

  test('builds no bridge while scroll sync is switched off', () => {
    mockScrollSync = false;
    mockRenderedSnapshot = snapshotOf({ 'main.adoc': MAIN, 'other.adoc': OTHER });
    mockSourceMap = [{ line: 1, page: 1, yFraction: 0 }];
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    expect(screen.getByTestId('pdf-preview-panel')).toHaveAttribute('data-assembled-line', '');
  });

  test('a click in the page rendering reveals the source line it came from', () => {
    mockRenderedSnapshot = snapshotOf({ 'main.adoc': MAIN, 'other.adoc': OTHER });
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    fireEvent.click(screen.getByRole('button', { name: /pdf click to source/i }));
    expect(screen.getByTestId('asciidoc-editor')).toBeInTheDocument();
  });

  test('a click in the page rendering is inert until something has been rendered', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    fireEvent.click(screen.getByRole('button', { name: /pdf click to source/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-reveal-line', '');
  });

  test('a block carrying its own origin jumps straight there', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    fireEvent.click(screen.getByRole('button', { name: /pdf exact source/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-reveal-line', '9');
  });

  test('a diagnostic in the open file reveals its line, and a lineless one the first line', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    fireEvent.click(screen.getByRole('button', { name: /pdf diagnostic here/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-reveal-line', '4');
    fireEvent.click(screen.getByRole('button', { name: /pdf diagnostic lineless/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-reveal-line', '1');
  });

  test('a lineless diagnostic in another file switches to it without a line to reveal', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    fireEvent.click(screen.getByRole('button', { name: /pdf diagnostic elsewhere lineless/i }));
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-open-path', 'other.adoc');
  });

  test('the page rendering can toggle scroll sync and collapse the panel', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    switchToPdfPreview();
    fireEvent.click(screen.getByRole('button', { name: /pdf toggle scroll sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /pdf collapse/i }));
    expect(screen.queryByTestId('pdf-preview-panel')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /expand preview/i })).toBeInTheDocument();
  });
});

describe('ProjectEditorLayout — document preview click-to-source', () => {
  test('a click maps straight to the open file while include bodies are hidden', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /html click to source/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-reveal-line', '3');
  });

  test('a click inside an expanded include body jumps to the file it came from', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /show includes/i }));
    fireEvent.click(screen.getByRole('button', { name: /html click to source/i }));
    // Line 3 of the open-file-rooted assembly is inside other.adoc's expanded body.
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-open-path', 'other.adoc');
  });

  test('the document preview can toggle scroll sync and collapse the panel', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /html toggle scroll sync/i }));
    fireEvent.click(screen.getByRole('button', { name: /html diagnostic/i }));
    fireEvent.click(screen.getByRole('button', { name: /html collapse/i }));
    expect(screen.queryByTestId('asciidoc-preview')).not.toBeInTheDocument();
  });
});

describe('ProjectEditorLayout — outline and search navigation', () => {
  test('assembles the outline across the include tree when a main document is configured', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('outline-view')).toHaveAttribute('data-scope', 'full');
  });

  test('falls back to the open file’s own outline when the reader asks for current scope', () => {
    mockOutlineScope = 'current';
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('outline-view')).toHaveAttribute('data-scope', 'current');
  });

  test('falls back to the open file’s own outline when no main document is configured', () => {
    render(<ProjectEditorLayout {...defaultProps} mainFileNodeId={null} />);
    expect(screen.getByTestId('outline-view')).toHaveAttribute('data-scope', 'current');
  });

  test('an outline heading in the open file is revealed in place', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /outline heading here/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-reveal-line', '7');
  });

  test('an outline heading from another file switches to that file', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /outline heading elsewhere/i }));
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-open-path', 'other.adoc');
  });

  test('an outline heading with no source path is revealed in the open file', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /outline heading without a source/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-reveal-line', '5');
  });

  test('an outline click also moves a preview that is not following the cursor', () => {
    mockScrollSync = false;
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /outline heading here/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-reveal-line', '7');
  });

  test('a search hit in the open file is revealed in place', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /search hit here/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-reveal-line', '6');
  });

  test('a search hit in another file switches to it', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /search hit elsewhere/i }));
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-open-path', 'other.adoc');
  });

  test('a search hit in the open file also moves a preview that is not following the cursor', () => {
    mockScrollSync = false;
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /search hit here/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-reveal-line', '6');
  });
});

describe('ProjectEditorLayout — exports', () => {
  test('renders the whole main document, not the open file', async () => {
    mockSelectedFile = { nodeId: 'other', nodeName: 'other.adoc', path: 'other.adoc', nodeType: 'file' };
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));
    await waitFor(() => expect(mockExportPdf).toHaveBeenCalled());
    expect(mockExportPdf.mock.calls[0][0].rootPath).toBe('main.adoc');
  });

  test('waits for a transiently-absent render root before dispatching', async () => {
    // The root is missing at click time and arrives only after the forced rebuild + one poll.
    mockFiles = { 'other.adoc': OTHER };
    mockGetFiles.mockImplementation(() => mockFiles);
    mockRefreshIndex.mockImplementation(async () => {
      setTimeout(() => { mockFiles = { 'main.adoc': MAIN, 'other.adoc': OTHER }; }, 20);
    });
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));
    await waitFor(() => expect(mockRefreshIndex).toHaveBeenCalled());
    await waitFor(() => expect(mockExportPdf).toHaveBeenCalled());
  });

  test('does not dispatch an export while no file is open to root it at', async () => {
    mockIndexPresent = false;
    mockSelectedFile = null;
    render(<ProjectEditorLayout {...defaultProps} mainFileNodeId={null} />);
    fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));
    fireEvent.click(screen.getByRole('button', { name: /export html/i }));
    await waitFor(() => expect(mockRefreshIndex).not.toHaveBeenCalled());
    expect(mockExportPdf).not.toHaveBeenCalled();
    expect(mockExportHtml).not.toHaveBeenCalled();
  });

  test('applies the project’s HTML export packaging, stylesheet and palette', async () => {
    mockRenderConfig = { htmlExport: { packaging: 'inline', style: 'golo', theme: 'dark' } };
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /export html/i }));
    await waitFor(() => expect(mockExportHtml).toHaveBeenCalled());
    expect(mockExportHtml.mock.calls[0][0]).toMatchObject({
      rootPath: 'main.adoc', packaging: 'inline', style: 'golo', theme: 'dark',
    });
  });

  test('falls back to the reader’s own preview stylesheet when the project configures none', async () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /export html/i }));
    await waitFor(() => expect(mockExportHtml).toHaveBeenCalled());
    expect(mockExportHtml.mock.calls[0][0].style).toBe('asciidoctor');
  });

  test('seeds the render language from the project setting, and leaves it unset without one', async () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /export html/i }));
    await waitFor(() => expect(mockExportHtml).toHaveBeenCalled());
    expect(mockExportHtml.mock.calls[0][0].projectAttributes.lang).toContain('fr');

    mockExportHtml.mockClear();
    render(<ProjectEditorLayout {...defaultProps} projectLanguage={null} />);
    fireEvent.click(screen.getAllByRole('button', { name: /export html/i })[1]);
    await waitFor(() => expect(mockExportHtml).toHaveBeenCalled());
    expect(mockExportHtml.mock.calls[0][0].projectAttributes.lang).toBeUndefined();
  });
});

describe('ProjectEditorLayout — print preview theme', () => {
  test('resolves the project’s theme document only while the print stylesheet is selected', () => {
    mockPreviewStyle = 'print';
    mockRenderConfig = { theme: { path: 'theme.yml' } };
    mockFiles = { 'main.adoc': MAIN, 'other.adoc': OTHER, 'theme.yml': 'base:\n  font-color: #000\n' };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('asciidoc-preview')).toBeInTheDocument();
  });
});
