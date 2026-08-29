import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ProjectEditorLayout } from '@/app/(dashboard)/dashboard/projects/[id]/project-editor-layout';
import { ApiError } from '@/lib/api/transport';

// Coverage suite for the status bar's transient "✓ Pulled — Undo" / "✓ Switched to <branch> — Undo"
// affordance: it appears only after a CLEAN pull or branch-switch success, clicking Undo calls the
// same `undo-pull` route the conflict panel's Undo uses, and any other landed git action (push,
// commit, …) clears it. Mirrors `project-editor-layout-git.test.tsx`'s boilerplate, but the mutation
// hooks below CAPTURE the `onSucceeded` callback `use-project-git.ts` wraps, so a test can fire it
// directly rather than driving the real hook's operation polling.

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

// ── git read-model hooks: fixed stand-ins, not the focus of this suite ───────────────────────────
jest.mock('@/hooks/use-git-tree-status', () => ({
  useGitTreeStatus: () => ({ statusByFileNodeId: {}, loading: false, error: null, refetch: jest.fn() }),
}));
const mockRefetchGitStatus = jest.fn();
jest.mock('@/hooks/use-git-status', () => ({
  useGitStatus: () => ({
    status: { syncStatus: 'UP_TO_DATE', unstaged: [], untracked: [] },
    connected: true,
    loading: false,
    error: null,
    refetch: mockRefetchGitStatus,
  }),
}));
jest.mock('@/hooks/use-behind-ahead', () => ({
  useBehindAhead: () => ({
    behindAhead: { behind: 0, ahead: 0 }, loading: false, error: null,
    refetch: jest.fn().mockResolvedValue(undefined),
  }),
}));
jest.mock('@/hooks/use-git-activity', () => ({
  useGitActivity: () => ({ activeOperation: null, loading: false, error: null }),
}));

// ── mutation hooks: each captures the `onSucceeded` callback `use-project-git.ts` passes in, so a
// test can invoke it directly — exactly what the real hook does once its polled operation reaches
// `SUCCEEDED` — without driving the (separately tested) polling loop itself. ─────────────────────
let capturedPullSucceeded: (() => void) | null = null;
jest.mock('@/hooks/use-pull', () => ({
  usePull: (_projectId: string, onSucceeded: () => void) => {
    capturedPullSucceeded = onSucceeded;
    return {
      confirmOpen: false, closeConfirm: jest.fn(), handleConfirmed: jest.fn(),
      pending: false, message: null, start: jest.fn(), openPreview: jest.fn(),
    };
  },
}));

let capturedPushSucceeded: (() => void) | null = null;
const mockPushClear = jest.fn();
jest.mock('@/hooks/use-push', () => ({
  usePush: (_projectId: string, onSucceeded: () => void) => {
    capturedPushSucceeded = onSucceeded;
    return { pending: false, message: null, start: jest.fn(), clear: mockPushClear };
  },
}));

jest.mock('@/hooks/use-branches', () => ({
  useBranches: (_projectId: string, onSucceeded: () => void) => ({
    current: 'main', branches: [], loading: false, error: null, refetch: jest.fn(),
    createBranch: jest.fn(), switchBranch: jest.fn(), switchPending: false,
    switchMessage: null, confirmOpen: false, confirmBranchName: null, confirmCode: null,
    closeConfirm: jest.fn(), handleConfirmed: jest.fn(),
    // Not exercised by this suite (see `project-editor-layout-git.test.tsx` for the branch-switcher
    // surface); captured only so `useBranches`'s call shape stays honest.
    __onSucceeded: onSucceeded,
  }),
}));

jest.mock('@/hooks/use-conflicts', () => ({
  useConflicts: () => ({
    operationId: null, files: [], loading: false, error: null, allResolved: false,
    resolve: jest.fn(), complete: jest.fn(), undo: jest.fn(), completing: false,
    message: null, refetch: jest.fn(),
  }),
}));

const mockUndoPull = jest.fn();
jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  undoPull: (...parameters: unknown[]) => mockUndoPull(...parameters),
}));

// ── git chrome: BranchSwitcher and the connection status bar are stubbed so the header renders
// predictably — the Undo affordance lives directly in the real (unmocked) `GitToolbar`. ──────────
jest.mock('@/components/git/branch-switcher', () => ({
  BranchSwitcher: ({ current }: { current: string | null }) => (
    <div data-testid="branch-switcher">{current}</div>
  ),
}));
jest.mock('@/components/git/git-connection-status-bar', () => ({
  GitConnectionStatusBar: ({ onCommitClick }: { onCommitClick: () => void }) => (
    <div data-testid="git-status-bar">
      <button onClick={onCommitClick}>open commit</button>
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
jest.mock('@/components/git/push-preview-dialog', () => ({ PushPreviewDialog: () => null }));
jest.mock('@/components/git/branch-switch-dialog', () => ({ BranchSwitchDialog: () => null }));
jest.mock('@/components/git/history-panel-with-diff', () => ({ HistoryPanelWithDiff: () => null }));
jest.mock('@/components/git/discard-dialog', () => ({ DiscardDialog: () => null }));
jest.mock('@/components/git/conflict-panel', () => ({ ConflictPanel: () => null }));

// ── the rest of the layout's environment, unrelated to git — copied from the sibling git-chrome
// suite so the full layout renders without error. ─────────────────────────────────────────────
jest.mock('@/hooks/use-file-tree-events', () => ({
  useFileTreeEvents: () => {},
}));
jest.mock('@/hooks/use-collab-document', () => ({
  useCollabDocument: () => ({ doc: null, awareness: null, connectionState: 'synced' }),
}));
jest.mock('@/hooks/use-project-presence', () => ({ useProjectPresence: () => new Map() }));
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
  capturedPullSucceeded = null;
  capturedPushSucceeded = null;
  mockRefetchGitStatus.mockClear();
  mockPushClear.mockClear();
  mockUndoPull.mockReset();
  sessionStorage.clear();
});

describe('ProjectEditorLayout — undo-last-pull affordance', () => {
  test('does not appear before any pull/switch has landed', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo the last pull/i })).not.toBeInTheDocument();
  });

  test('appears with an Undo button after a clean pull succeeds', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(capturedPullSucceeded).not.toBeNull();

    act(() => { capturedPullSucceeded?.(); });

    expect(screen.getByText('Pulled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /undo the last pull/i })).toBeInTheDocument();
  });

  test('does not appear after a push succeeds (only pull/switch offer undo)', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    expect(capturedPushSucceeded).not.toBeNull();

    act(() => { capturedPushSucceeded?.(); });

    expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo the last/i })).not.toBeInTheDocument();
  });

  test('does not appear after a commit succeeds', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /open commit/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm commit/i }));

    expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo the last/i })).not.toBeInTheDocument();
  });

  test('a landed push clears an affordance a prior clean pull had set', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { capturedPullSucceeded?.(); });
    expect(screen.getByRole('button', { name: /undo the last pull/i })).toBeInTheDocument();

    act(() => { capturedPushSucceeded?.(); });

    expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo the last/i })).not.toBeInTheDocument();
  });

  test('a landed commit clears an affordance a prior clean pull had set', () => {
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { capturedPullSucceeded?.(); });
    expect(screen.getByRole('button', { name: /undo the last pull/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open commit/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm commit/i }));

    expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /undo the last/i })).not.toBeInTheDocument();
  });

  test('clicking Undo calls the undo-pull route and clears the affordance on success', async () => {
    mockUndoPull.mockResolvedValue({ operationId: 'op-undo-1' });
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { capturedPullSucceeded?.(); });
    expect(screen.getByRole('button', { name: /undo the last pull/i })).toBeInTheDocument();
    mockRefetchGitStatus.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /undo the last pull/i }));

    expect(mockUndoPull).toHaveBeenCalledWith('p1');
    await waitFor(() => expect(screen.queryByText('Pulled')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /undo the last/i })).not.toBeInTheDocument();
    // Undoing refetches the same read models a pull does.
    expect(mockRefetchGitStatus).toHaveBeenCalled();
  });

  test('a nothing_to_undo refusal clears the affordance without an error banner', async () => {
    mockUndoPull.mockRejectedValue(new ApiError(409, 'nothing_to_undo', 'nothing to undo'));
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { capturedPullSucceeded?.(); });

    fireEvent.click(screen.getByRole('button', { name: /undo the last pull/i }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /undo the last/i })).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('any other undo refusal surfaces as an alert and leaves the affordance in place', async () => {
    mockUndoPull.mockRejectedValue(new ApiError(403, 'insufficient_role', 'nope'));
    render(<ProjectEditorLayout {...defaultProps} />);
    act(() => { capturedPullSucceeded?.(); });

    fireEvent.click(screen.getByRole('button', { name: /undo the last pull/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /undo the last pull/i })).toBeInTheDocument();
  });
});
