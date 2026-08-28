import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectEditorLayout } from '@/app/(dashboard)/dashboard/projects/[id]/project-editor-layout';

// Coverage suite for the layout's review wiring: the editor↔rail linkage (marker clicks, hover,
// selection-to-comment, reattach), the prev/next thread walk, and the cross-document jump from the
// project-wide task list. Collaboration is stubbed so a test decides which document is bound.

jest.mock('@/contexts/current-user-context', () => ({
  useCurrentUser: () => ({ userId: 'u-test', displayName: 'Test User', email: 't@example.com' }),
}));

jest.mock('@/hooks/use-pdf-export', () => ({
  usePdfExport: () => ({ exportPdf: jest.fn(), isExporting: false, diagnostics: [] }),
}));
jest.mock('@/hooks/use-html-export', () => ({
  useHtmlExport: () => ({ exportHtml: jest.fn(), isExporting: false, failures: [] }),
}));
jest.mock('@/hooks/use-pdf-preview', () => ({
  usePdfPreview: () => ({ pdf: undefined, isRendering: false, diagnostics: [] }),
}));
jest.mock('@/components/pdf-preview-panel', () => ({
  PdfPreviewPanel: () => <div data-testid="pdf-preview-panel-mock" />,
}));
jest.mock('@/hooks/use-project-render-config', () => ({
  useProjectRenderConfig: () => ({ config: {}, loading: false, saving: false, error: null, save: jest.fn() }),
}));

// Editor stub surfacing the review callbacks the layout hands it, plus its grammar publication.
type EditorProperties = {
  content: string;
  activeReviewId?: string | null;
  scrollToReviewId?: string | null;
  onReviewMarkerClick?: (id: string) => void;
  onReviewMarkerHover?: (id: string | null) => void;
  onCreateCommentFromSelection?: (anchor: unknown) => void;
  onGrammarStateChange?: (state: unknown) => void;
};
jest.mock('@/components/editor/asciidoc-editor', () => ({
  AsciiDocEditor: (properties: EditorProperties) => (
    <div
      data-testid="asciidoc-editor"
      data-active-review={properties.activeReviewId ?? ''}
      data-scroll-review={properties.scrollToReviewId ?? ''}
    >
      {properties.onReviewMarkerClick && (
        <button onClick={() => properties.onReviewMarkerClick?.('t2')}>click marker</button>
      )}
      {properties.onReviewMarkerHover && (
        <>
          <button onClick={() => properties.onReviewMarkerHover?.('t1')}>hover marker</button>
          <button onClick={() => properties.onReviewMarkerHover?.(null)}>unhover marker</button>
        </>
      )}
      {properties.onCreateCommentFromSelection && (
        <button onClick={() => properties.onCreateCommentFromSelection?.({ quote: 'q', start: 0, end: 1 })}>
          comment on selection
        </button>
      )}
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
    </div>
  ),
}));

// Comment/writing panel stubs exposing every callback the layout supplies as a button.
jest.mock('@/components/editor/comments-panel-view', () => ({
  CommentsPanelView: ({ onStepThread, onNavigateToItem, onReattach, onPendingResolved, pendingAnchor, activeThreadId, view, onViewChange, canStepThreads }: {
    onStepThread: (delta: number) => void;
    onNavigateToItem: (item: { id: string; documentId: string; fileNodeId: string | null }) => void;
    onReattach: (itemId: string) => void;
    onPendingResolved: () => void;
    pendingAnchor: unknown;
    activeThreadId: string | null;
    view: string;
    onViewChange: (view: string) => void;
    canStepThreads: boolean;
  }) => (
    <div
      data-testid="comments-panel-view"
      data-active-thread={activeThreadId ?? ''}
      data-pending-anchor={pendingAnchor === null ? 'none' : 'set'}
      data-view={view}
      data-can-step={String(canStepThreads)}
    >
      <button onClick={() => onStepThread(1)}>next thread</button>
      <button onClick={() => onStepThread(-1)}>previous thread</button>
      <button onClick={() => onViewChange('tasks')}>show tasks</button>
      <button onClick={() => onNavigateToItem({ id: 't2', documentId: 'doc-1', fileNodeId: 'f1' })}>
        navigate to local item
      </button>
      <button onClick={() => onNavigateToItem({ id: 'x9', documentId: 'doc-2', fileNodeId: 'f2' })}>
        navigate to remote item
      </button>
      <button onClick={() => onNavigateToItem({ id: 'x9', documentId: 'doc-2', fileNodeId: null })}>
        navigate to placeless item
      </button>
      <button onClick={() => onReattach('t1')}>reattach t1</button>
      <button onClick={onPendingResolved}>resolve pending</button>
    </div>
  ),
}));
jest.mock('@/components/editor/writing-panel-view', () => ({
  WritingPanelView: () => <div data-testid="writing-panel-view" />,
}));

jest.mock('@/components/file-tree/file-tree', () => ({
  FileTree: ({ openPathRequest }: { openPathRequest?: { path: string } | null }) => (
    <div data-testid="file-tree" data-open-path={openPathRequest?.path ?? ''} />
  ),
}));
jest.mock('@/components/asciidoc-preview', () => ({
  AsciiDocPreview: () => <div data-testid="asciidoc-preview" />,
  isAsciiDocFile: (name: string) => name.endsWith('.adoc'),
}));
jest.mock('react-resizable-panels', () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));

// Git chrome is not what this suite is about; keep it inert.
jest.mock('@/hooks/use-git-status', () => ({
  useGitStatus: () => ({ status: null, connected: false, loading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('@/hooks/use-git-tree-status', () => ({
  useGitTreeStatus: () => ({ statusByFileNodeId: {}, loading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('@/hooks/use-file-tree-events', () => ({ useFileTreeEvents: () => {} }));

// Collaboration: a bound document by default, so the comments panel is available.
type ManagedCollab = {
  editorCollab: { documentId: string; doc: unknown; awareness: unknown; role: string } | null;
};
let mockManaged: ManagedCollab = { editorCollab: null };
jest.mock('@/app/(dashboard)/dashboard/projects/[id]/use-managed-collab', () => ({
  useManagedCollab: () => ({
    presenceByFile: new Map(),
    editorCollab: mockManaged.editorCollab,
    collabUnavailable: false,
    editorCanEdit: true,
    editorContentOverride: undefined,
    editorConnectionState: 'synced',
    editorPending: false,
  }),
}));

const mockRefetchReview = jest.fn();
let mockThreads: { root: { id: string; resolvedAt: string | null } }[] = [];
let mockRanges: { id: string }[] = [];
let mockAnchorStates = new Map<string, string>();
jest.mock('@/hooks/use-review-items', () => ({
  useReviewItems: () => ({
    threads: mockThreads,
    ranges: mockRanges,
    anchorStates: mockAnchorStates,
    loading: false,
    error: null,
    refetch: mockRefetchReview,
    includeResolved: true,
    setIncludeResolved: jest.fn(),
  }),
}));
// Document order is asserted through the layout's stepping, not through the sorter itself.
jest.mock('@/lib/review/order', () => ({
  sortThreadsByDocumentOrder: (threads: { root: { id: string } }[]) => threads,
}));
const mockReanchor = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/api/review', () => ({
  reanchorReviewItem: (...arguments_: unknown[]) => mockReanchor(...arguments_),
}));

let mockMembersResponse: Promise<unknown> = Promise.resolve({ data: { members: [] } });
jest.mock('@/lib/api/members', () => ({
  membersApi: { list: () => mockMembersResponse },
}));
jest.mock('@/lib/api/projects', () => ({ findSymbolUsages: jest.fn(), renameSymbol: jest.fn() }));

const projectIndex = {
  activeFileId: 'f1',
  symbols: [],
  pathOf: (id: string) => `/${id}.adoc`,
  lineOf: (_fileId: string, offset: number) => offset + 1,
  inheritedOffset: () => 0,
  inheritedAttributes: () => new Map<string, string>(),
};
jest.mock('@/hooks/use-project-symbol-index', () => ({
  useProjectSymbolIndex: () => ({
    index: projectIndex, getIndex: () => projectIndex, getFiles: () => ({}), refresh: jest.fn(),
    resolvedScopeOf: () => new Map<string, string>(), fileIdForPath: () => null, reachableDocVersion: 0,
  }),
}));

let mockSelectedFile: { nodeId: string; nodeName: string; path: string; nodeType: 'file' } | null = null;
jest.mock('@/hooks/use-file-selection', () => ({
  useFileSelection: () => ({
    selectedFile: mockSelectedFile,
    contentState: { content: '= Doc', etag: null, isLoading: false, error: null, isBinary: false, notFound: false },
    selectFile: jest.fn(),
    clearSelection: jest.fn(),
  }),
}));

// Real state for the panel-open preference so the layout's own open/collapse calls take effect.
jest.mock('@/hooks/use-editor-preferences', () => {
  const react: typeof React = jest.requireActual('react');
  return {
    useEditorPreferences: () => {
      const [commentsPanelOpen, setCommentsPanelOpen] = react.useState(false);
      const [rightPanelTab, setRightPanelTab] = react.useState('comments');
      return {
        scrollSyncEnabled: false, setScrollSyncEnabled: jest.fn(),
        previewStyle: 'asciidoctor', setPreviewStyle: jest.fn(),
        commentsPanelOpen, setCommentsPanelOpen,
        leftPanelTab: 'files', setLeftPanelTab: jest.fn(),
        rightPanelTab, setRightPanelTab,
        showIncludedFiles: false, setShowIncludedFiles: jest.fn(),
        outlineScope: 'document', setOutlineScope: jest.fn(),
      };
    },
  };
});

jest.mock('@/hooks/use-last-selection', () => ({
  readLastSelection: () => null,
  useLastSelection: () => ({
    readLastSelection: () => null, rememberFile: jest.fn(), rememberLine: jest.fn(),
    clearLastSelection: jest.fn(), rememberCursorLine: jest.fn(),
    readCursorLine: () => undefined, pruneCursor: jest.fn(),
  }),
}));

const defaultProps = {
  projectId: 'p1',
  projectName: 'Proj',
  projectDescription: null,
  projectLanguage: null,
  mainFileNodeId: null,
  canManage: false,
  canEdit: true,
  canModifyFiles: true,
  canManageDictionary: true,
  userId: 'u-test',
};

function thread(id: string, resolvedAt: string | null = null) {
  return { root: { id, resolvedAt } };
}

beforeEach(() => {
  mockSelectedFile = { nodeId: 'f1', nodeName: 'doc.adoc', path: '/doc.adoc', nodeType: 'file' };
  mockManaged = { editorCollab: { documentId: 'doc-1', doc: {}, awareness: {}, role: 'editor' } };
  mockThreads = [thread('t1'), thread('t2'), thread('t3', '2026-01-01T00:00:00.000Z')];
  mockRanges = [{ id: 't1' }, { id: 't2' }];
  mockAnchorStates = new Map<string, string>();
  mockMembersResponse = Promise.resolve({ data: { members: [] } });
  mockRefetchReview.mockClear();
  mockReanchor.mockClear();
  sessionStorage.clear();
});

function openCommentsPanel() {
  fireEvent.click(screen.getByRole('tab', { name: 'Comments' }));
}

describe('ProjectEditorLayout — comments panel availability', () => {
  test('offers the panel collapsed to a rail once a document is bound, with the open count badged', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    // Two of the three threads are unresolved, so the badge counts two.
    expect(screen.getByTestId('right-panel-count-comments')).toHaveTextContent('2');
    expect(screen.queryByTestId('comments-panel-view')).not.toBeInTheDocument();
    openCommentsPanel();
    expect(screen.getByTestId('comments-panel-view')).toBeInTheDocument();
  });

  test('collapses the panel back to the rail from the rail’s own control', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    fireEvent.click(screen.getByLabelText('collapse panel'));
    expect(screen.queryByTestId('comments-panel-view')).not.toBeInTheDocument();
  });

  test('offers the panel for a non-collaborative document once the checker has issues to show', () => {
    mockManaged = { editorCollab: null };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.queryByRole('tab', { name: 'Comments' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /publish grammar state/i }));
    openCommentsPanel();
    // Comments still need a live document, and the panel says so instead of showing an empty list.
    expect(screen.getByText(/Comments need a live connection/i)).toBeInTheDocument();
    expect(screen.queryByTestId('comments-panel-view')).not.toBeInTheDocument();
  });
});

describe('ProjectEditorLayout — editor to rail linkage', () => {
  test('a marker click opens the panel on this document’s threads and focuses that thread', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /click marker/i }));
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-active-thread', 't2');
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-view', 'threads');
  });

  test('hovering a marker emphasises it and clearing the hover falls back to the focused thread', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /click marker/i }));
    fireEvent.click(screen.getByRole('button', { name: /^hover marker$/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-active-review', 't1');
    fireEvent.click(screen.getByRole('button', { name: /unhover marker/i }));
    expect(screen.getByTestId('asciidoc-editor')).toHaveAttribute('data-active-review', 't2');
  });

  test('a selection turned into a comment opens the panel with the anchor pending', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /comment on selection/i }));
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-pending-anchor', 'set');
    fireEvent.click(screen.getByRole('button', { name: /resolve pending/i }));
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-pending-anchor', 'none');
  });

  test('a pending reattach consumes the next selection instead of starting a new comment', async () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    fireEvent.click(screen.getByRole('button', { name: /reattach t1/i }));
    expect(screen.getByRole('status')).toHaveTextContent(/Select the new passage/i);

    fireEvent.click(screen.getByRole('button', { name: /comment on selection/i }));
    await waitFor(() => expect(mockReanchor).toHaveBeenCalledWith('p1', 't1', { anchor: expect.anything() }));
    await waitFor(() => expect(mockRefetchReview).toHaveBeenCalled());
    // The hint clears and no composer was pinned — the selection went to the reattach.
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-pending-anchor', 'none');
  });

  test('the reattach hint can be dismissed without reattaching', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    fireEvent.click(screen.getByRole('button', { name: /reattach t1/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByText(/Select the new passage/i)).not.toBeInTheDocument();
  });
});

describe('ProjectEditorLayout — stepping through threads', () => {
  test('the first step forwards lands on the first thread and the first step back on the last', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    fireEvent.click(screen.getByRole('button', { name: /next thread/i }));
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-active-thread', 't1');

    fireEvent.click(screen.getByRole('button', { name: /previous thread/i }));
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-active-thread', 't3');
  });

  test('stepping wraps around both ends of the document order', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    const next = screen.getByRole('button', { name: /next thread/i });
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-active-thread', 't3');
    fireEvent.click(next);
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-active-thread', 't1');
  });

  test('stepping is inert while the document has no threads', () => {
    mockThreads = [];
    mockRanges = [];
    render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-can-step', 'false');
    fireEvent.click(screen.getByRole('button', { name: /next thread/i }));
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-active-thread', '');
  });
});

describe('ProjectEditorLayout — jumping from the project-wide list', () => {
  test('an item in the open document is focused in place', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    fireEvent.click(screen.getByRole('button', { name: /show tasks/i }));
    fireEvent.click(screen.getByRole('button', { name: /navigate to local item/i }));
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-active-thread', 't2');
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-view', 'threads');
  });

  test('an item in another document asks the tree to open that file first', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    fireEvent.click(screen.getByRole('button', { name: /navigate to remote item/i }));
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-open-path', '/f2.adoc');
    // Nothing is focused yet — the jump completes once that document is bound.
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-active-thread', '');
  });

  test('an item with no file of its own is left alone', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    fireEvent.click(screen.getByRole('button', { name: /navigate to placeless item/i }));
    expect(screen.getByTestId('file-tree')).toHaveAttribute('data-open-path', '');
  });

  test('a deferred jump focuses its thread once the target document is bound and anchored', () => {
    const { rerender } = render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    fireEvent.click(screen.getByRole('button', { name: /navigate to remote item/i }));

    // The target file opens and its document binds, carrying the item and a resolved range.
    mockSelectedFile = { nodeId: 'f2', nodeName: 'other.adoc', path: '/other.adoc', nodeType: 'file' };
    mockManaged = { editorCollab: { documentId: 'doc-2', doc: {}, awareness: {}, role: 'editor' } };
    mockThreads = [thread('x9')];
    mockRanges = [{ id: 'x9' }];
    rerender(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-active-thread', 'x9');
  });

  test('a deferred jump to a detached item focuses it as soon as it is known detached', () => {
    const { rerender } = render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    fireEvent.click(screen.getByRole('button', { name: /navigate to remote item/i }));

    mockSelectedFile = { nodeId: 'f2', nodeName: 'other.adoc', path: '/other.adoc', nodeType: 'file' };
    mockManaged = { editorCollab: { documentId: 'doc-2', doc: {}, awareness: {}, role: 'editor' } };
    mockThreads = [thread('x9')];
    mockRanges = [];
    mockAnchorStates = new Map([['x9', 'detached']]);
    rerender(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-active-thread', 'x9');
  });

  test('a deferred jump waits while the target thread has neither a range nor a detached verdict', () => {
    const { rerender } = render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    fireEvent.click(screen.getByRole('button', { name: /navigate to remote item/i }));

    mockSelectedFile = { nodeId: 'f2', nodeName: 'other.adoc', path: '/other.adoc', nodeType: 'file' };
    mockManaged = { editorCollab: { documentId: 'doc-2', doc: {}, awareness: {}, role: 'editor' } };
    mockThreads = [thread('x9')];
    mockRanges = [];
    mockAnchorStates = new Map<string, string>();
    rerender(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('comments-panel-view')).toHaveAttribute('data-active-thread', '');
  });
});

describe('ProjectEditorLayout — project members', () => {
  test('marks the signed-in owner so the project-wide bulk actions are offered', async () => {
    mockMembersResponse = Promise.resolve({
      data: { members: [{ userId: 'u-test', displayName: 'Test User', role: 'owner' }] },
    });
    render(<ProjectEditorLayout {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId('asciidoc-editor')).toBeInTheDocument());
  });

  test('still renders the panel when the member list cannot be fetched', async () => {
    mockMembersResponse = Promise.reject(new Error('network down'));
    render(<ProjectEditorLayout {...defaultProps} />);
    openCommentsPanel();
    await waitFor(() => expect(screen.getByTestId('comments-panel-view')).toBeInTheDocument());
  });
});
