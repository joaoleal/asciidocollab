import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ProjectEditorLayout } from '@/app/(dashboard)/dashboard/projects/[id]/project-editor-layout';
import type { FileTreeEventDto } from '@asciidocollab/shared';

jest.mock('@/contexts/current-user-context', () => ({
  useCurrentUser: () => ({ userId: 'u-test', displayName: 'Test User', email: 't@example.com', avatarKey: null }),
}));

// Stub the PDF export hook: its worker factory uses `import.meta.url`, which is unloadable under the
// commonjs jest transform, so the real module can never be imported here (mocked by design).
jest.mock('@/hooks/use-pdf-export', () => ({
  usePdfExport: () => ({ exportPdf: jest.fn(), isExporting: false, diagnostics: [] }),
}));
jest.mock('@/hooks/use-html-export', () => ({
  useHtmlExport: () => ({ exportHtml: jest.fn(), isExporting: false, failures: [] }),
}));
jest.mock('@/hooks/use-project-render-config', () => ({
  useProjectRenderConfig: () => ({ config: {}, loading: false, saving: false, error: null, save: jest.fn() }),
}));

// Stub the live PDF preview hook AND its panel: both pull in the PDF worker/pdf.js, whose
// `import.meta.url` is unloadable under the commonjs jest transform, so the real modules can never
// be imported here (mocked by design).
// The theme editor runs its own sample preview, which is legitimately enabled while a theme is open.
// Mocked out here so `pdfPreviewCalls` records only the LAYOUT's document preview — the thing these
// tests are about — exactly as `AsciiDocEditor` is mocked for the editor.
jest.mock('@/components/theme-editor/theme-editor', () => ({
  ThemeEditor: () => <div data-testid="theme-editor" />,
}));

const pdfPreviewCalls: { isEnabled: boolean }[] = [];
jest.mock('@/hooks/use-pdf-preview', () => ({
  usePdfPreview: (options: { isEnabled: boolean }) => {
    pdfPreviewCalls.push({ isEnabled: options.isEnabled });
    return { pdf: undefined, isRendering: false, diagnostics: [] };
  },
}));
jest.mock('@/components/pdf-preview-panel', () => ({
  PdfPreviewPanel: () => <div data-testid="pdf-preview-panel-mock" />,
}));

// Mock the AsciiDocEditor so tests don't depend on CodeMirror/Lezer.
// jest.fn() wrapper lets tests inspect the props passed to the editor (e.g., onChange).
jest.mock('@/components/editor/asciidoc-editor', () => ({
  AsciiDocEditor: jest.fn(({ content, canEdit, projectId, fileNodeId }: { content: string; canEdit: boolean; projectId?: string; fileNodeId?: string; onChange?: (v: string) => void }) => (
    <div
      data-testid="asciidoc-editor"
      data-can-edit={String(canEdit)}
      data-project-id={projectId ?? ''}
      data-file-node-id={fileNodeId ?? ''}
    >{content}</div>
  )),
}));

// Mock file-tree-node so rendered nodes are simple divs; clicking a file invokes onSelect.
jest.mock('@/components/file-tree/file-tree-node', () => ({
  FileTreeNode: ({ node, onSelect }: {
    node: { name: string; id: string; path: string; type: 'file' | 'folder' };
    onSelect?: (nodeId: string, nodeName: string, nodePath: string, nodeType: 'file' | 'folder') => void;
  }) => (
    <div
      data-testid={`node-${node.name}`}
      onClick={() => node.type === 'file' && onSelect?.(node.id, node.name, node.path, node.type)}
    >{node.name}</div>
  ),
}));

jest.mock('@/components/file-tree/drag-drop-zone', () => ({
  DragDropZone: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/hooks/use-key-bindings', () => ({
  useKeyBindings: jest.fn(() => new Map()),
}));

jest.mock('@/hooks/use-file-tree-key-handler', () => ({
  useFileTreeKeyHandler: jest.fn(),
}));

const mockUseFileTreeEvents = jest.fn();
jest.mock('@/hooks/use-file-tree-events', () => ({
  useFileTreeEvents: (...arguments_: unknown[]) => mockUseFileTreeEvents(...arguments_),
}));
// The cross-file symbol index has its own tests and registers its own useFileTreeEvents
// consumer; stub it here so it doesn't interfere with the file-tree SSE assertions below. A jest.fn
// (defaulting to the empty index) so a test can supply a populated index to drive the preview root.
const mockUseProjectSymbolIndex = jest.fn(() => ({ index: null, getIndex: () => null }));
jest.mock('@/hooks/use-project-symbol-index', () => ({
  useProjectSymbolIndex: (...arguments_: unknown[]) => mockUseProjectSymbolIndex(...arguments_),
}));

jest.mock('@/hooks/use-file-selection', () => ({
  useFileSelection: jest.fn(() => ({
    selectedFile: null,
    contentState: { content: null, isLoading: false, error: null, isBinary: false },
    selectFile: jest.fn(),
    clearSelection: jest.fn(),
  })),
}));

jest.mock('@/hooks/use-editor-preferences', () => ({
  useEditorPreferences: jest.fn(() => ({
    fontSize: 14,
    theme: 'default',
    scrollSyncEnabled: false,
    setFontSize: jest.fn(),
    setTheme: jest.fn(),
    setScrollSyncEnabled: jest.fn(),
  })),
}));

const mockReadLastSelection = jest.fn(() => null as unknown);
const mockRememberFile = jest.fn();
const mockRememberLine = jest.fn();
const mockClearLastSelection = jest.fn();
const mockRememberCursorLine = jest.fn();
const mockReadCursorLine = jest.fn(() => undefined as number | undefined);
const mockPruneCursor = jest.fn();
jest.mock('@/hooks/use-last-selection', () => ({
  // Standalone export used by the layout's first-open flag (isFirstOpen); mirrors the hook's value.
  // Wrapped in an arrow so the reference is deferred past this factory's hoist (the const below is in
  // its temporal dead zone when the factory first evaluates).
  readLastSelection: () => mockReadLastSelection(),
  useLastSelection: jest.fn(() => ({
    readLastSelection: mockReadLastSelection,
    rememberFile: mockRememberFile,
    rememberLine: mockRememberLine,
    clearLastSelection: mockClearLastSelection,
    rememberCursorLine: mockRememberCursorLine,
    readCursorLine: mockReadCursorLine,
    pruneCursor: mockPruneCursor,
  })),
}));

// jest.fn() wrapper lets tests inspect content/scrollToLine props passed to the preview.
jest.mock('@/components/asciidoc-preview', () => ({
  AsciiDocPreview: jest.fn(({ onCollapse }: { content?: string; onCollapse?: () => void }) => (
    <div data-testid="asciidoc-preview">
      {onCollapse && <button aria-label="collapse preview" onClick={onCollapse} />}
    </div>
  )),
  isAsciiDocFile: (name: string) => name.endsWith('.adoc'),
}));

const emptyRoot = {
  id: 'root-1',
  name: 'root',
  type: 'folder' as const,
  path: '/',
  parentId: null,
  children: [],
};

function mockFetch(tree = emptyRoot) {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(tree),
  } as Response);
}

const defaultProps = {
  projectId: 'p1',
  projectName: 'My Project',
  projectDescription: null,
  mainFileNodeId: null,
  canManage: true,
  canEdit: true,
  canModifyFiles: true,
  userId: 'user-1',
};

describe('ProjectEditorLayout', () => {
  beforeEach(() => {
    mockFetch();
    sessionStorage.clear();
    mockUseFileTreeEvents.mockReset();
    jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
      selectedFile: null,
      contentState: { content: null, isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });
    jest.requireMock('@/components/editor/asciidoc-editor').AsciiDocEditor.mockClear();
    jest.requireMock('@/components/asciidoc-preview').AsciiDocPreview.mockClear();
    mockReadLastSelection.mockReset();
    mockReadLastSelection.mockReturnValue(null);
    mockRememberFile.mockReset();
    mockRememberLine.mockReset();
    mockClearLastSelection.mockReset();
    mockUseProjectSymbolIndex.mockReturnValue({ index: null, getIndex: () => null });
    pdfPreviewCalls.length = 0;
  });

  describe('the document preview only renders documents', () => {
    /** Open `nodeName` and return whether the PDF preview was activated for it. */
    function previewActivatedFor(nodeName: string): boolean {
      jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
        selectedFile: { nodeId: 'id-x', nodeName, nodePath: `/${nodeName}`, nodeType: 'file' },
        contentState: { content: 'x', isLoading: false, error: null, isBinary: false },
        selectFile: jest.fn(),
        clearSelection: jest.fn(),
      });
      pdfPreviewCalls.length = 0;
      render(<ProjectEditorLayout {...defaultProps} />);
      return pdfPreviewCalls.some((call) => call.isEnabled);
    }

    it('does not render a theme file as a document', () => {
      // A theme is YAML with its own preview inside the theme editor. Rendering it as a document
      // produced a PDF of raw YAML text — and because the last successful render is retained, that
      // page of YAML was then shown for a few seconds when the author opened a real document.
      expect(previewActivatedFor('local-theme.yaml')).toBe(false);
      expect(previewActivatedFor('corporate-theme.yml')).toBe(false);
    });

    it('does not render other non-AsciiDoc files as documents either', () => {
      expect(previewActivatedFor('config.yml')).toBe(false);
      expect(previewActivatedFor('notes.txt')).toBe(false);
    });
  });

  it('previews an out-of-tree file on its own and flags it as not part of the main document', async () => {
    // A main document is configured but the open file is NOT reachable from it, so the preview must
    // root at the open file (rootFilePath null = standalone) and pass the "outside main tree" flag.
    const files = { 'main.adoc': '= Main\n\ninclude::chapter.adoc[]\n', 'chapter.adoc': '== Chapter\n', 'orphan.adoc': '= Orphan\n\nBody.\n' };
    const pathById: Record<string, string> = { 'id-main': 'main.adoc', 'id-orphan': 'orphan.adoc' };
    const idByPath: Record<string, string> = { 'main.adoc': 'id-main', 'orphan.adoc': 'id-orphan' };
    mockUseProjectSymbolIndex.mockReturnValue({
      index: {
        pathOf: (id: string) => pathById[id] ?? null,
        inheritedOffset: () => 0,
        inheritedAttributes: () => new Map(),
        symbols: [],
      },
      getIndex: () => null,
      getFiles: () => files,
      resolvedScopeOf: () => new Map(),
      refresh: jest.fn(),
      fileIdForPath: (path: string) => idByPath[path] ?? null,
      reachableDocVersion: 0,
    } as unknown as ReturnType<typeof mockUseProjectSymbolIndex>);
    jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'id-orphan', nodeName: 'orphan.adoc', nodePath: '/orphan.adoc', nodeType: 'file' },
      contentState: { content: '= Orphan\n\nBody.\n', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });

    const { AsciiDocPreview } = jest.requireMock('@/components/asciidoc-preview');
    render(<ProjectEditorLayout {...defaultProps} mainFileNodeId="id-main" />);
    // The preview starts collapsed; expand it so the HTML preview (AsciiDocPreview) mounts.
    fireEvent.click(await screen.findByLabelText('expand preview'));

    await waitFor(() => expect(AsciiDocPreview).toHaveBeenCalled());
    // The HTML preview received the standalone-root signal: outsideMainTree true, rootFilePath null.
    const lastCall = AsciiDocPreview.mock.calls.at(-1)?.[0];
    expect(lastCall.outsideMainTree).toBe(true);
    expect(lastCall.rootFilePath).toBeNull();
  });

  it('does not flag the main document itself as outside its own tree', async () => {
    const files = { 'main.adoc': '= Main\n\nBody.\n' };
    mockUseProjectSymbolIndex.mockReturnValue({
      index: { pathOf: (id: string) => (id === 'id-main' ? 'main.adoc' : null), inheritedOffset: () => 0, inheritedAttributes: () => new Map(), symbols: [] },
      getIndex: () => null,
      getFiles: () => files,
      resolvedScopeOf: () => new Map(),
      refresh: jest.fn(),
      fileIdForPath: (path: string) => (path === 'main.adoc' ? 'id-main' : null),
      reachableDocVersion: 0,
    } as unknown as ReturnType<typeof mockUseProjectSymbolIndex>);
    jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'id-main', nodeName: 'main.adoc', nodePath: '/main.adoc', nodeType: 'file' },
      contentState: { content: '= Main\n\nBody.\n', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });

    const { AsciiDocPreview } = jest.requireMock('@/components/asciidoc-preview');
    render(<ProjectEditorLayout {...defaultProps} mainFileNodeId="id-main" />);
    fireEvent.click(await screen.findByLabelText('expand preview'));

    await waitFor(() => expect(AsciiDocPreview).toHaveBeenCalled());
    expect(AsciiDocPreview.mock.calls.at(-1)?.[0].outsideMainTree).toBe(false);
  });

  // shell renders with required data-testids
  it('renders without crashing and has required data-testids', async () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId('file-tree-panel')).toBeInTheDocument());
    expect(screen.getByTestId('content-panel')).toBeInTheDocument();
    // preview-panel is only rendered when an AsciiDoc file is selected
    expect(screen.queryByTestId('preview-panel')).not.toBeInTheDocument();
  });

  it('preview panel appears when an AsciiDoc file is selected', async () => {
    const { useFileSelection } = jest.requireMock('@/hooks/use-file-selection');
    useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'f1', nodeName: 'doc.adoc', nodePath: '/doc.adoc', nodeType: 'file' },
      contentState: { content: '= Hello', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });

    render(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId('preview-panel')).toBeInTheDocument());
  });

  // sidebar panel toggle
  it('sidebar is visible initially and can be collapsed', async () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId('file-tree-panel')).toBeInTheDocument());

    expect(document.querySelector('#left-panel-body')).not.toHaveClass('hidden');

    const toggleButton = screen.getByRole('button', { name: /collapse sidebar/i });
    fireEvent.click(toggleButton);

    // Only the body hides; the rail stays as the activity bar (see the LeftPanel docs).
    expect(document.querySelector('#left-panel-body')).toHaveClass('hidden');
    expect(screen.getByRole('tablist', { name: 'Left panel views' })).toBeVisible();
  });

  // (a): canManage=true shows Settings and Members links
  it('shows Settings and Members links for owner', async () => {
    render(<ProjectEditorLayout {...defaultProps} canManage={true} />);
    await waitFor(() => expect(screen.getByTestId('file-tree-panel')).toBeInTheDocument());
    const settingsLink = screen.getByRole('link', { name: /settings/i });
    const membersLink = screen.getByRole('link', { name: /members/i });
    expect(settingsLink).toHaveAttribute('href', '/dashboard/projects/p1/settings');
    expect(membersLink).toHaveAttribute('href', '/dashboard/projects/p1/members');
  });

  // (b): canManage=false hides Settings and Members links
  it('does not show Settings or Members links for non-owner', async () => {
    render(<ProjectEditorLayout {...defaultProps} canManage={false} />);
    await waitFor(() => expect(screen.getByTestId('file-tree-panel')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /members/i })).not.toBeInTheDocument();
  });

  // (c): Back to projects link always present
  it('shows Back to projects link for all roles', async () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId('file-tree-panel')).toBeInTheDocument());
    const backLink = screen.getByRole('link', { name: /back to projects/i });
    expect(backLink).toHaveAttribute('href', '/dashboard');
  });

  // collapse/expand buttons use Lucide icons, not raw unicode ‹/›
  it('sidebar collapse/expand buttons render SVG icons, not raw unicode ‹ or › characters', async () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId('file-tree-panel')).toBeInTheDocument());

    const collapseButton = screen.getByRole('button', { name: /collapse sidebar/i });
    // Should not contain raw unicode characters
    expect(collapseButton.textContent?.trim()).not.toBe('‹');
    expect(collapseButton.textContent?.trim()).not.toBe('›');
    // Should contain an SVG (Lucide icon)
    expect(collapseButton.querySelector('svg')).toBeInTheDocument();

    // Click to collapse, then check expand button also uses SVG
    fireEvent.click(collapseButton);
    const expandButton = screen.getByRole('button', { name: /expand sidebar/i });
    expect(expandButton.textContent?.trim()).not.toBe('›');
    expect(expandButton.querySelector('svg')).toBeInTheDocument();
  });

  // header navigation links render as icon-bearing buttons (redesigned header)
  it('header navigation links render lucide icons', async () => {
    render(<ProjectEditorLayout {...defaultProps} canManage={true} />);
    await waitFor(() => expect(screen.getByTestId('file-tree-panel')).toBeInTheDocument());

    const backLink = screen.getByRole('link', { name: /back to projects/i });
    const settingsLink = screen.getByRole('link', { name: /settings/i });
    const membersLink = screen.getByRole('link', { name: /members/i });

    for (const link of [backLink, settingsLink, membersLink]) {
      expect(link.querySelector('svg')).toBeInTheDocument();
    }
  });

  // the content panel is edge-to-edge (no padding) so the editor reaches the panel edges.
  it('content panel has no padding', async () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId('content-panel')).toBeInTheDocument());

    const contentPanel = screen.getByTestId('content-panel');
    expect(contentPanel).not.toHaveClass('p-4');
  });

  // SSE wiring — useFileTreeEvents called with correct projectId and events propagate
  it('calls useFileTreeEvents with correct projectId and tree updates on SSE event', async () => {
    const treeWithFile = {
      ...emptyRoot,
      children: [
        { id: 'file-1', name: 'doc.adoc', type: 'file' as const, path: '/doc.adoc', parentId: 'root-1', children: [] },
      ],
    };
    mockFetch(treeWithFile);

    render(<ProjectEditorLayout {...defaultProps} projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());

    expect(mockUseFileTreeEvents).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ onFileTreeEvent: expect.any(Function) }),
    );

    // The layout registers several SSE consumers (the file tree, and the rename/non-live subscription);
    // pick the file-tree one — the handler that applies structural events to the rendered tree.
    const fileTreeCall = mockUseFileTreeEvents.mock.calls.find(
      (call) => call[0] === 'p1' && typeof (call[1] as { onFileTreeEvent?: unknown }).onFileTreeEvent === 'function',
    );
    const onEvent: (event: FileTreeEventDto) => void = (
      fileTreeCall![1] as { onFileTreeEvent: (event: FileTreeEventDto) => void }
    ).onFileTreeEvent;
    const createdEvent: FileTreeEventDto = {
      type: 'created',
      fileNodeId: 'file-2',
      nodeType: 'file',
      name: 'new-file.adoc',
      path: '/new-file.adoc',
      parentId: 'root-1',
    };

    act(() => { onEvent(createdEvent); });

    await waitFor(() => expect(screen.getByTestId('node-new-file.adoc')).toBeInTheDocument());
  });

  // Issue C2: switching files must mount a fresh editor (new DOM element) so internal
  // state (including any stale closures over fileNodeId) is completely reset.
  it('creates a new AsciiDocEditor DOM element when switching to a different file', async () => {
    const { useFileSelection } = jest.requireMock('@/hooks/use-file-selection');
    useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'file-1', nodeName: 'first.adoc', path: '/first.adoc', nodeType: 'file' },
      contentState: { content: 'First file', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });

    const { rerender } = render(<ProjectEditorLayout {...defaultProps} projectId="proj-1" />);
    await waitFor(() => expect(screen.getByTestId('asciidoc-editor')).toBeInTheDocument());
    const firstEditorElement = screen.getByTestId('asciidoc-editor');

    // Simulate switching to a different file
    useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'file-2', nodeName: 'second.adoc', path: '/second.adoc', nodeType: 'file' },
      contentState: { content: 'Second file', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });
    rerender(<ProjectEditorLayout {...defaultProps} projectId="proj-1" />);

    await waitFor(() => expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-file-node-id', 'file-2'));
    const secondEditorElement = screen.getByTestId('asciidoc-editor');
    // Verify it is a NEW DOM element (not the same reference reused),
    // which proves the editor remounted and reset its internal state.
    expect(secondEditorElement).not.toBe(firstEditorElement);
  });

  // Issue C8: when content prop changes for the same file (e.g. external-change reload),
  // AsciiDocEditor must display the new content. With key=fileNodeId this only applies
  // when content updates for the same file without a file switch. We verify the rendered
  // content always matches the current contentState.
  it('AsciiDocEditor displays updated content when contentState changes for the same file', async () => {
    const { useFileSelection } = jest.requireMock('@/hooks/use-file-selection');
    useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'file-x', nodeName: 'doc.adoc', path: '/doc.adoc', nodeType: 'file' },
      contentState: { content: 'original content', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });

    const { rerender } = render(<ProjectEditorLayout {...defaultProps} projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('asciidoc-editor')).toBeInTheDocument());
    expect(screen.getByTestId('asciidoc-editor')).toHaveTextContent('original content');

    // Simulate external change: same file, new content
    useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'file-x', nodeName: 'doc.adoc', path: '/doc.adoc', nodeType: 'file' },
      contentState: { content: 'updated content', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });
    rerender(<ProjectEditorLayout {...defaultProps} projectId="p1" />);

    await waitFor(() => expect(screen.getByTestId('asciidoc-editor')).toHaveTextContent('updated content'));
  });

  // Issue 4: liveContent must NOT be reset by external contentState.content changes while the user is editing
  it('keeps user-typed content in the preview after an external contentState.content update', async () => {
    const { useFileSelection } = jest.requireMock('@/hooks/use-file-selection');
    useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'f1', nodeName: 'doc.adoc', nodePath: '/doc.adoc', nodeType: 'file' },
      contentState: { content: 'saved content', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });

    const { rerender } = render(<ProjectEditorLayout {...defaultProps} />);

    // Open the preview panel
    const expandButton = await screen.findByRole('button', { name: /expand preview/i });
    fireEvent.click(expandButton);
    await waitFor(() => expect(screen.getByTestId('asciidoc-preview')).toBeInTheDocument());

    // Trigger onChange (simulates user typing)
    const { AsciiDocEditor: MockEditor } = jest.requireMock('@/components/editor/asciidoc-editor');
    const onChangeCallback: ((v: string) => void) | undefined = MockEditor.mock.calls.at(-1)?.[0]?.onChange;
    expect(onChangeCallback).toBeDefined();
    act(() => onChangeCallback!('user typed content'));

    // Simulate an external content update (e.g., a background save poll returns new content)
    useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'f1', nodeName: 'doc.adoc', nodePath: '/doc.adoc', nodeType: 'file' },
      contentState: { content: 'server updated content', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });
    rerender(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => {});

    // The preview must still show the user's typed content, not the server's version
    const { AsciiDocPreview: MockPreview } = jest.requireMock('@/components/asciidoc-preview');
    const lastPreviewContent: string | undefined = MockPreview.mock.calls.at(-1)?.[0]?.content;
    expect(lastPreviewContent).toBe('user typed content');
  });

  // Issue 6: switching files must remount AsciiDocPreview so stale HTML is never shown
  it('remounts AsciiDocPreview when switching between different AsciiDoc files', async () => {
    const { useFileSelection } = jest.requireMock('@/hooks/use-file-selection');
    useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'file-a', nodeName: 'a.adoc', nodePath: '/a.adoc', nodeType: 'file' },
      contentState: { content: '= File A', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });

    const { rerender } = render(<ProjectEditorLayout {...defaultProps} />);
    const expandButton = await screen.findByRole('button', { name: /expand preview/i });
    fireEvent.click(expandButton);
    await waitFor(() => expect(screen.getByTestId('asciidoc-preview')).toBeInTheDocument());

    const firstPreviewElement = screen.getByTestId('asciidoc-preview');

    // Switch to a different AsciiDoc file
    useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'file-b', nodeName: 'b.adoc', nodePath: '/b.adoc', nodeType: 'file' },
      contentState: { content: '= File B', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });
    rerender(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId('asciidoc-preview')).toBeInTheDocument());

    const secondPreviewElement = screen.getByTestId('asciidoc-preview');

    // key={selectedFile.nodeId} must force a remount — a new DOM element must appear
    expect(secondPreviewElement).not.toBe(firstPreviewElement);
  });

  // Issue C1: AsciiDocEditor must receive projectId and fileNodeId for auto-save to work
  it('passes projectId and fileNodeId to AsciiDocEditor when a file is selected', async () => {
    const { useFileSelection } = jest.requireMock('@/hooks/use-file-selection');
    useFileSelection.mockReturnValue({
      selectedFile: { nodeId: 'file-abc', nodeName: 'chapter.adoc', path: '/chapter.adoc', nodeType: 'file' },
      contentState: { content: '= Chapter', isLoading: false, error: null, isBinary: false },
      selectFile: jest.fn(),
      clearSelection: jest.fn(),
    });

    render(<ProjectEditorLayout {...defaultProps} projectId="proj-123" />);

    await waitFor(() => expect(screen.getByTestId('asciidoc-editor')).toBeInTheDocument());
    const editor = screen.getByTestId('asciidoc-editor');
    expect(editor).toHaveAttribute('data-project-id', 'proj-123');
    expect(editor).toHaveAttribute('data-file-node-id', 'file-abc');
  });

  // restore the last selection on mount and persist selections.
  describe('last-selection restore & persistence', () => {
    const treeWithFile = {
      ...emptyRoot,
      children: [
        { id: 'file-1', name: 'doc.adoc', type: 'file' as const, path: '/doc.adoc', parentId: 'root-1', children: [] },
      ],
    };

    it('auto-selects the stored file exactly once on mount', async () => {
      const selectFile = jest.fn();
      jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
        selectedFile: null,
        contentState: { content: null, isLoading: false, error: null, isBinary: false },
        selectFile,
        clearSelection: jest.fn(),
      });
      mockReadLastSelection.mockReturnValue({ nodeId: 'f1', nodeName: 'intro.adoc', nodeType: 'file', path: '/intro.adoc' });

      const { rerender } = render(<ProjectEditorLayout {...defaultProps} />);

      await waitFor(() => expect(selectFile).toHaveBeenCalledWith('f1', 'intro.adoc', '/intro.adoc', 'file'));

      // Re-rendering must not re-trigger restoration (one-shot ref).
      rerender(<ProjectEditorLayout {...defaultProps} />);
      expect(selectFile).toHaveBeenCalledTimes(1);
    });

    it('does not auto-select anything when no selection is stored', async () => {
      const selectFile = jest.fn();
      jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
        selectedFile: null,
        contentState: { content: null, isLoading: false, error: null, isBinary: false },
        selectFile,
        clearSelection: jest.fn(),
      });
      mockReadLastSelection.mockReturnValue(null);

      render(<ProjectEditorLayout {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('file-tree-panel')).toBeInTheDocument());
      expect(selectFile).not.toHaveBeenCalled();
    });

    it('persists the file via rememberFile when a file is selected in the tree', async () => {
      mockFetch(treeWithFile);
      const selectFile = jest.fn();
      jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
        selectedFile: null,
        contentState: { content: null, isLoading: false, error: null, isBinary: false },
        selectFile,
        clearSelection: jest.fn(),
      });

      render(<ProjectEditorLayout {...defaultProps} />);
      await waitFor(() => expect(screen.getByTestId('node-doc.adoc')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('node-doc.adoc'));

      expect(selectFile).toHaveBeenCalledWith('file-1', 'doc.adoc', '/doc.adoc', 'file');
      expect(mockRememberFile).toHaveBeenCalledWith({ nodeId: 'file-1', nodeName: 'doc.adoc', nodeType: 'file', path: '/doc.adoc' });
    });

    // a restored file whose content 404s clears the stale memory and resets the view.
    it('clears stored memory and resets selection when the restored file is not found', async () => {
      const clearSelection = jest.fn();
      jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
        selectedFile: { nodeId: 'gone-1', nodeName: 'gone.adoc', path: '/gone.adoc', nodeType: 'file' },
        contentState: { content: null, isLoading: false, error: null, isBinary: false, notFound: true },
        selectFile: jest.fn(),
        clearSelection,
      });
      mockReadLastSelection.mockReturnValue({ nodeId: 'gone-1', nodeName: 'gone.adoc', nodeType: 'file', path: '/gone.adoc' });

      render(<ProjectEditorLayout {...defaultProps} />);

      // Stale memory is cleared (not retried on a future visit) and the selection is reset.
      await waitFor(() => expect(mockClearLastSelection).toHaveBeenCalled());
      expect(clearSelection).toHaveBeenCalled();
      // No error UI is surfaced for a missing file.
      expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    });

    it('passes the stored line to the editor as initialLine when restoring that file', async () => {
      jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
        selectedFile: { nodeId: 'f1', nodeName: 'intro.adoc', path: '/intro.adoc', nodeType: 'file' },
        contentState: { content: '= Intro', isLoading: false, error: null, isBinary: false, notFound: false },
        selectFile: jest.fn(),
        clearSelection: jest.fn(),
      });
      mockReadLastSelection.mockReturnValue({ nodeId: 'f1', nodeName: 'intro.adoc', nodeType: 'file', path: '/intro.adoc', line: 40 });

      render(<ProjectEditorLayout {...defaultProps} />);

      const { AsciiDocEditor: MockEditor } = jest.requireMock('@/components/editor/asciidoc-editor');
      await waitFor(() => expect(MockEditor.mock.calls.at(-1)?.[0]?.initialLine).toBe(40));
    });

    it('debounces rememberLine for cursor moves in AsciiDoc files only', async () => {
      jest.useFakeTimers();
      try {
        jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
          selectedFile: { nodeId: 'f1', nodeName: 'intro.adoc', path: '/intro.adoc', nodeType: 'file' },
          contentState: { content: '= Intro', isLoading: false, error: null, isBinary: false, notFound: false },
          selectFile: jest.fn(),
          clearSelection: jest.fn(),
        });

        render(<ProjectEditorLayout {...defaultProps} />);
        const { AsciiDocEditor: MockEditor } = jest.requireMock('@/components/editor/asciidoc-editor');
        const onCursorLineChange: ((line: number) => void) | undefined = MockEditor.mock.calls.at(-1)?.[0]?.onCursorLineChange;
        expect(onCursorLineChange).toBeDefined();

        act(() => { onCursorLineChange!(12); });
        act(() => { jest.advanceTimersByTime(500); });
        expect(mockRememberLine).toHaveBeenCalledWith(12);
      } finally {
        jest.useRealTimers();
      }
    });

    it('flushes a pending line-persistence debounce to the OUTGOING file on switch (no cross-file contamination)', async () => {
      jest.useFakeTimers();
      try {
        const useFileSelection = jest.requireMock('@/hooks/use-file-selection').useFileSelection;
        useFileSelection.mockReturnValue({
          selectedFile: { nodeId: 'file-a', nodeName: 'a.adoc', path: '/a.adoc', nodeType: 'file' },
          contentState: { content: '= A', isLoading: false, error: null, isBinary: false, notFound: false },
          selectFile: jest.fn(),
          clearSelection: jest.fn(),
        });

        const { rerender } = render(<ProjectEditorLayout {...defaultProps} />);
        const MockEditor = jest.requireMock('@/components/editor/asciidoc-editor').AsciiDocEditor;
        const onCursorLineChangeA: ((line: number) => void) | undefined = MockEditor.mock.calls.at(-1)?.[0]?.onCursorLineChange;

        // User moves the cursor on file A (starts a 500ms debounce)...
        act(() => { onCursorLineChangeA!(10); });

        // ...then switches to file B *before* the debounce fires.
        useFileSelection.mockReturnValue({
          selectedFile: { nodeId: 'file-b', nodeName: 'b.adoc', path: '/b.adoc', nodeType: 'file' },
          contentState: { content: '= B', isLoading: false, error: null, isBinary: false, notFound: false },
          selectFile: jest.fn(),
          clearSelection: jest.fn(),
        });
        rerender(<ProjectEditorLayout {...defaultProps} />);

        // The switch FLUSHES the pending save to file A's PER-FILE entry — its cursor position is
        // preserved, not dropped — keyed by the captured nodeId so it lands on file A,
        // never file B. The single last-selection `line` is deliberately NOT written on a switch: it
        // now belongs to file B, so writing file A's line there would contaminate B's restore.
        expect(mockRememberCursorLine).toHaveBeenCalledWith('file-a', 10);
        expect(mockRememberCursorLine).not.toHaveBeenCalledWith('file-b', 10);
        expect(mockRememberLine).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not persist a line for non-AsciiDoc files', async () => {
      jest.useFakeTimers();
      try {
        jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
          selectedFile: { nodeId: 'f2', nodeName: 'notes.txt', path: '/notes.txt', nodeType: 'file' },
          contentState: { content: 'plain', isLoading: false, error: null, isBinary: false, notFound: false },
          selectFile: jest.fn(),
          clearSelection: jest.fn(),
        });

        render(<ProjectEditorLayout {...defaultProps} />);
        const { AsciiDocEditor: MockEditor } = jest.requireMock('@/components/editor/asciidoc-editor');
        const onCursorLineChange: ((line: number) => void) | undefined = MockEditor.mock.calls.at(-1)?.[0]?.onCursorLineChange;

        act(() => { onCursorLineChange?.(7); });
        act(() => { jest.advanceTimersByTime(500); });
        expect(mockRememberLine).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    // the view renders its default/interactive state immediately; restoration never blocks it.
    it('renders the default empty content state immediately even when a restore is pending', async () => {
      const selectFile = jest.fn();
      jest.requireMock('@/hooks/use-file-selection').useFileSelection.mockReturnValue({
        selectedFile: null,
        contentState: { content: null, isLoading: false, error: null, isBinary: false },
        selectFile,
        clearSelection: jest.fn(),
      });
      mockReadLastSelection.mockReturnValue({ nodeId: 'f1', nodeName: 'intro.adoc', nodeType: 'file', path: '/intro.adoc' });

      render(<ProjectEditorLayout {...defaultProps} />);
      // The content panel and its empty-state copy are present on first paint — not blocked on restore.
      expect(screen.getByTestId('content-panel')).toBeInTheDocument();
      expect(screen.getByText(/select a file from the tree/i)).toBeInTheDocument();
    });
  });
});
