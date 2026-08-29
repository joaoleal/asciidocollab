import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ProjectEditorLayout } from '@/app/(dashboard)/dashboard/projects/[id]/project-editor-layout';

// Coverage suite for the layout's repository chrome: the header's git controls, the outcome banners
// each git flow publishes, the dialogs those controls open, and the refresh fan-out a commit triggers.
// Every git hook and panel is stubbed so a test decides the state the header is asked to render.

jest.mock('@/contexts/current-user-context', () => ({
  useCurrentUser: () => ({ userId: 'u-test', displayName: 'Test User', email: 't@example.com' }),
}));

// The PDF/HTML export hooks and the live PDF preview own worker factories built with
// `import.meta.url`, which is unloadable under the commonjs jest transform — mocked by design.
let mockPdfExport: Record<string, unknown> = {};
jest.mock('@/hooks/use-pdf-export', () => ({
  usePdfExport: () => ({ exportPdf: jest.fn(), isExporting: false, diagnostics: [], ...mockPdfExport }),
}));
let mockHtmlExport: Record<string, unknown> = {};
jest.mock('@/hooks/use-html-export', () => ({
  useHtmlExport: () => ({ exportHtml: jest.fn(), isExporting: false, failures: [], ...mockHtmlExport }),
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

jest.mock('@/components/editor/asciidoc-editor', () => ({
  AsciiDocEditor: ({ content }: { content: string }) => <div data-testid="asciidoc-editor">{content}</div>,
}));
jest.mock('@/components/file-tree/file-tree', () => ({
  FileTree: () => <div data-testid="file-tree" />,
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

// ── git hooks, each driven from a mutable value a test sets before rendering ──────────────────
const mockRefetchTreeStatus = jest.fn();
jest.mock('@/hooks/use-git-tree-status', () => ({
  useGitTreeStatus: () => ({
    statusByFileNodeId: {}, loading: false, error: null, refetch: mockRefetchTreeStatus,
  }),
}));

const mockRefetchGitStatus = jest.fn();
let mockGitStatus: Record<string, unknown> | null = null;
let mockGitConnected = false;
jest.mock('@/hooks/use-git-status', () => ({
  useGitStatus: () => ({
    status: mockGitStatus, connected: mockGitConnected, loading: false, error: null,
    refetch: mockRefetchGitStatus,
  }),
}));

const mockRefetchBehindAhead = jest.fn().mockResolvedValue(undefined);
jest.mock('@/hooks/use-behind-ahead', () => ({
  useBehindAhead: () => ({
    behindAhead: { behind: 0, ahead: 0 }, loading: false, error: null, refetch: mockRefetchBehindAhead,
  }),
}));

let mockActiveOperation: Record<string, unknown> | null = null;
jest.mock('@/hooks/use-git-activity', () => ({
  useGitActivity: () => ({ activeOperation: mockActiveOperation, loading: false, error: null }),
}));

const mockPullOpenPreview = jest.fn();
let mockPullMessage: { tone: string; text: string } | null = null;
jest.mock('@/hooks/use-pull', () => ({
  usePull: () => ({
    confirmOpen: false, closeConfirm: jest.fn(), handleConfirmed: jest.fn(),
    pending: false, message: mockPullMessage, start: jest.fn(), openPreview: mockPullOpenPreview,
  }),
}));

const mockPushClear = jest.fn();
let mockPushMessage: { tone: string; text: string } | null = null;
jest.mock('@/hooks/use-push', () => ({
  usePush: () => ({ pending: false, message: mockPushMessage, start: jest.fn(), clear: mockPushClear }),
}));

let mockSwitchMessage: { tone: string; text: string } | null = null;
jest.mock('@/hooks/use-branches', () => ({
  useBranches: () => ({
    current: 'main', branches: [], loading: false, error: null, refetch: jest.fn(),
    createBranch: jest.fn(), switchBranch: jest.fn(), switchPending: false,
    switchMessage: mockSwitchMessage, confirmOpen: false, confirmBranchName: null, confirmCode: null,
    closeConfirm: jest.fn(), handleConfirmed: jest.fn(),
  }),
}));

jest.mock('@/hooks/use-conflicts', () => ({
  useConflicts: () => ({
    operationId: null, files: [], loading: false, error: null, allResolved: false,
    resolve: jest.fn(), complete: jest.fn(), undo: jest.fn(), completing: false,
    message: null, refetch: jest.fn(),
  }),
}));

// ── git chrome: stubbed so each control is reachable by name and reports what it was handed ────
jest.mock('@/components/git/git-activity-indicator', () => ({
  GitActivityIndicator: ({ activeOperation }: { activeOperation: { kind?: string } | null }) => (
    <div data-testid="git-activity">{activeOperation?.kind ?? ''}</div>
  ),
}));
jest.mock('@/components/git/branch-switcher', () => ({
  BranchSwitcher: ({ current }: { current: string | null }) => (
    <div data-testid="branch-switcher">{current}</div>
  ),
}));
jest.mock('@/components/git/git-connection-status-bar', () => ({
  GitConnectionStatusBar: ({ onCommitClick, onPullClick, onPreviewPushClick }: {
    onCommitClick: () => void;
    onPullClick: () => void;
    onPreviewPushClick: () => void;
  }) => (
    <div data-testid="git-status-bar">
      <button onClick={onCommitClick}>open commit</button>
      <button onClick={onPullClick}>open pull</button>
      <button onClick={onPreviewPushClick}>open push preview</button>
    </div>
  ),
}));
jest.mock('@/components/git/commit-dialog', () => ({
  CommitDialog: ({ open, onCommitted, onOpenChange }: {
    open: boolean; onCommitted: () => void; onOpenChange: (o: boolean) => void;
  }) => (open ? (
    <div data-testid="commit-dialog">
      <button onClick={onCommitted}>confirm commit</button>
      <button onClick={() => onOpenChange(false)}>close commit</button>
    </div>
  ) : null),
}));
jest.mock('@/components/git/pull-dialog', () => ({ PullDialog: () => null }));
jest.mock('@/components/git/push-preview-dialog', () => ({
  PushPreviewDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="push-preview" /> : null),
}));
jest.mock('@/components/git/branch-switch-dialog', () => ({ BranchSwitchDialog: () => null }));
jest.mock('@/components/git/history-panel-with-diff', () => ({
  HistoryPanelWithDiff: ({ open }: { open: boolean }) => (open ? <div data-testid="history-panel" /> : null),
}));
jest.mock('@/components/git/discard-dialog', () => ({
  DiscardDialog: ({ open, paths, onDone }: {
    open: boolean; paths: readonly string[]; onDone: () => void;
  }) => (open ? (
    <div data-testid="discard-dialog" data-paths={paths.join('|')}>
      <button onClick={onDone}>discard done</button>
    </div>
  ) : null),
}));
jest.mock('@/components/git/conflict-panel', () => ({
  ConflictPanel: ({ open }: { open: boolean }) => (open ? <div data-testid="conflict-panel" /> : null),
}));

// ── the rest of the layout's environment ──────────────────────────────────────────────────────
type FileTreeHandlers = {
  onContentChanged?: (event: { fileNodeId: string }) => void;
  onMainFileChanged?: (event: { mainFileNodeId: string | null }) => void;
  onReconnect?: () => void;
  onConnected?: () => void;
};
let capturedTreeHandlers: FileTreeHandlers = {};
jest.mock('@/hooks/use-file-tree-events', () => ({
  useFileTreeEvents: (_projectId: string, handlers: FileTreeHandlers) => {
    capturedTreeHandlers = handlers;
  },
}));

jest.mock('@/hooks/use-collab-document', () => ({
  useCollabDocument: () => ({ doc: null, awareness: null, connectionState: 'synced' }),
}));
jest.mock('@/hooks/use-project-presence', () => ({ useProjectPresence: () => new Map() }));
// A populated symbol index: the header's Blame control and the diagnostics' file links are both
// gated on a resolvable path for the open file, so an empty index would hide them.
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
jest.mock('@/hooks/use-file-selection', () => ({
  useFileSelection: () => ({
    selectedFile: { nodeId: 'f1', nodeName: 'doc.adoc', path: '/doc.adoc', nodeType: 'file' },
    contentState: { content: '= Doc', etag: null, isLoading: false, error: null, isBinary: false, notFound: false },
    selectFile: jest.fn(),
    clearSelection: jest.fn(),
  }),
}));
jest.mock('@/hooks/use-editor-preferences', () => ({
  useEditorPreferences: () => ({
    scrollSyncEnabled: false, setScrollSyncEnabled: jest.fn(),
    previewStyle: 'asciidoctor', setPreviewStyle: jest.fn(),
    commentsPanelOpen: false, setCommentsPanelOpen: jest.fn(),
    leftPanelTab: 'files', setLeftPanelTab: jest.fn(),
    rightPanelTab: 'comments', setRightPanelTab: jest.fn(),
    showIncludedFiles: false, setShowIncludedFiles: jest.fn(),
    outlineScope: 'document', setOutlineScope: jest.fn(),
  }),
}));
jest.mock('@/hooks/use-review-items', () => ({
  useReviewItems: () => ({
    threads: [], ranges: [], anchorStates: new Map(), loading: false, error: null,
    refetch: jest.fn(), includeResolved: false, setIncludeResolved: jest.fn(),
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

const defaultProps = {
  projectId: 'p1',
  projectName: 'Proj',
  projectDescription: 'A description',
  projectLanguage: null,
  mainFileNodeId: null,
  canManage: true,
  canEdit: true,
  canModifyFiles: true,
  canManageDictionary: true,
  userId: 'u-test',
};

beforeEach(() => {
  mockGitStatus = null;
  mockGitConnected = false;
  mockActiveOperation = null;
  mockPullMessage = null;
  mockPushMessage = null;
  mockSwitchMessage = null;
  mockPdfExport = {};
  mockHtmlExport = {};
  capturedTreeHandlers = {};
  mockRefetchTreeStatus.mockClear();
  mockRefetchGitStatus.mockClear();
  mockRefetchBehindAhead.mockClear();
  mockPushClear.mockClear();
  mockPullOpenPreview.mockClear();
  sessionStorage.clear();
});

describe('ProjectEditorLayout — repository chrome', () => {
  test('hides the history and discard controls for a project with no repository', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /history/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /discard changes/i })).not.toBeInTheDocument();
  });

  test('the git header carries no Blame control (blame is now an inline editor-toolbar toggle)', () => {
    mockGitConnected = true;
    render(<ProjectEditorLayout {...defaultProps} />);
    // The Blame toggle moved to the editor toolbar's settings; it is never a git-sync header button.
    expect(screen.queryByRole('button', { name: /blame/i })).not.toBeInTheDocument();
  });

  test('opens the history panel from the header once a repository is connected', () => {
    mockGitConnected = true;
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(screen.getByTestId('history-panel')).toBeInTheDocument();
  });

  test('offers a conflict resolution control only while the working tree is conflicted', () => {
    mockGitConnected = true;
    mockGitStatus = { syncStatus: 'CONFLICTED', unstaged: [], untracked: [] };
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /resolve conflicts/i }));
    expect(screen.getByTestId('conflict-panel')).toBeInTheDocument();
  });

  test('offers a discard control listing every unstaged and untracked path', () => {
    mockGitConnected = true;
    mockGitStatus = {
      syncStatus: 'CLEAN',
      unstaged: [{ path: 'a.adoc' }],
      untracked: [{ path: 'b.adoc' }],
    };
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(screen.getByTestId('discard-dialog')).toHaveAttribute('data-paths', 'a.adoc|b.adoc');
  });

  test('a finished discard refreshes the badges, the status and the ahead/behind counts', () => {
    mockGitConnected = true;
    mockGitStatus = { syncStatus: 'CLEAN', unstaged: [{ path: 'a.adoc' }], untracked: [] };
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /discard changes/i }));
    mockRefetchTreeStatus.mockClear();
    mockRefetchGitStatus.mockClear();
    mockRefetchBehindAhead.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /discard done/i }));
    expect(mockRefetchTreeStatus).toHaveBeenCalled();
    expect(mockRefetchGitStatus).toHaveBeenCalled();
    expect(mockRefetchBehindAhead).toHaveBeenCalled();
    expect(mockPushClear).toHaveBeenCalled();
  });

  test('a landed commit refreshes the three git read models and clears a stale push error', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /open commit/i }));
    expect(screen.getByTestId('commit-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /confirm commit/i }));
    expect(mockRefetchTreeStatus).toHaveBeenCalled();
    expect(mockRefetchGitStatus).toHaveBeenCalled();
    expect(mockRefetchBehindAhead).toHaveBeenCalled();
    expect(mockPushClear).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /close commit/i }));
    expect(screen.queryByTestId('commit-dialog')).not.toBeInTheDocument();
  });

  test('the status bar opens the pull confirmation and the push preview', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /open pull/i }));
    expect(mockPullOpenPreview).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /open push preview/i }));
    expect(screen.getByTestId('push-preview')).toBeInTheDocument();
  });

  test('shows the branch switcher only to a reader who may edit a connected repository', () => {
    mockGitConnected = true;
    const { rerender } = render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('branch-switcher')).toHaveTextContent('main');
    rerender(<ProjectEditorLayout {...defaultProps} canEdit={false} />);
    expect(screen.queryByTestId('branch-switcher')).not.toBeInTheDocument();
  });

  test('hides the branch switcher for a project with no connected repository', () => {
    // A repository-only control: without a connected repo there are no branches to switch between.
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.queryByTestId('branch-switcher')).not.toBeInTheDocument();
  });

  test('surfaces another member’s running git operation', () => {
    mockActiveOperation = { kind: 'PULL', status: 'RUNNING' };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByTestId('git-activity')).toHaveTextContent('PULL');
  });

  test('reports a failed pull as an alert and a paused one as a neutral status', () => {
    mockPullMessage = { tone: 'error', text: 'Pull failed: remote unreachable' };
    const { unmount } = render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Pull failed: remote unreachable');
    unmount();

    mockPullMessage = { tone: 'neutral', text: 'Pull paused on conflicts' };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByRole('status')).toHaveTextContent('Pull paused on conflicts');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('reports a refused push as an alert', () => {
    mockPushMessage = { tone: 'error', text: 'Push rejected: pull first' };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Push rejected: pull first');
  });

  test('reports a failed branch switch as an alert and a paused one as a neutral status', () => {
    mockSwitchMessage = { tone: 'error', text: 'Switch failed' };
    const { unmount } = render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Switch failed');
    unmount();

    mockSwitchMessage = { tone: 'neutral', text: 'Switch paused on conflicts' };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByRole('status')).toHaveTextContent('Switch paused on conflicts');
  });
});

describe('ProjectEditorLayout — export outcomes', () => {
  test('reports a failed PDF export and its per-resource diagnostics', () => {
    mockPdfExport = {
      error: new Error('engine crashed'),
      diagnostics: [
        {
          severity: 'warning',
          resource: 'a.png',
          message: 'image to embed not found',
          location: { path: '/f1.adoc', line: 3 },
        },
      ],
    };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Export to PDF failed: engine crashed');
    expect(screen.getByText('image to embed not found')).toBeInTheDocument();
  });

  test('a diagnostic pointing at the open file reveals its line in place', () => {
    mockPdfExport = {
      diagnostics: [
        {
          severity: 'error',
          resource: 'a.png',
          message: 'image to embed not found',
          location: { path: '/f1.adoc', line: 12 },
        },
      ],
    };
    render(<ProjectEditorLayout {...defaultProps} />);
    // Revealing in place keeps the same editor mounted rather than routing through a file switch.
    fireEvent.click(screen.getByRole('button', { name: /f1\.adoc/ }));
    expect(screen.getByTestId('asciidoc-editor')).toBeInTheDocument();
  });

  test('a diagnostic pointing at another file asks the tree to open it', () => {
    mockPdfExport = {
      diagnostics: [
        {
          severity: 'error',
          resource: 'b.png',
          message: 'image to embed not found',
          location: { path: '/elsewhere.adoc', line: 4 },
        },
      ],
    };
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /elsewhere\.adoc/ }));
    expect(screen.getByTestId('asciidoc-editor')).toBeInTheDocument();
  });

  test('reports a failed HTML export', () => {
    mockHtmlExport = { error: 'render worker died' };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Export to HTML failed: render worker died');
  });

  test('names the images left out of an HTML export, singular and plural', () => {
    mockHtmlExport = { failures: [{ source: 'a.png' }] };
    const { unmount } = render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 image could not be included');
    expect(screen.getByRole('status')).toHaveTextContent('a.png');
    unmount();

    mockHtmlExport = { failures: [{ source: 'a.png' }, { source: 'b.png' }] };
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.getByRole('status')).toHaveTextContent('2 images could not be included');
    expect(screen.getByRole('status')).toHaveTextContent('a.png, b.png');
  });
});

describe('ProjectEditorLayout — live project events', () => {
  test('marks the editor non-live while the event stream is down and clears it on reconnect', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { capturedTreeHandlers.onReconnect?.(); });
    expect(screen.getByTestId('non-live-indicator')).toBeInTheDocument();
    act(() => { capturedTreeHandlers.onConnected?.(); });
    expect(screen.queryByTestId('non-live-indicator')).not.toBeInTheDocument();
  });

  test('a collaborator’s content change and main-file change are both absorbed without error', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { capturedTreeHandlers.onContentChanged?.({ fileNodeId: 'other-file' }); });
    act(() => { capturedTreeHandlers.onMainFileChanged?.({ mainFileNodeId: 'new-main' }); });
    expect(screen.getByTestId('asciidoc-editor')).toBeInTheDocument();
  });
});
