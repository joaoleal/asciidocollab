import { renderHook, act, waitFor } from '@testing-library/react';
import { useProjectGit } from '@/app/(dashboard)/dashboard/projects/[id]/use-project-git';
import { ApiError } from '@/lib/api/transport';

// Hook-level coverage for the undo-last-pull affordance's set/clear wiring in `use-project-git.ts`,
// focused on the BLOCKER this suite exists to prove fixed: the affordance must clear the MOMENT a
// new pull/switch/push is INITIATED — not only on its success — because a pull or switch that pauses
// in `AWAITING_CONFLICT` never fires its own success callback. Clearing on success alone would leave
// a PRIOR clean op's "Undo" button stranded through conflict resolution; clicking it would call
// `undoPull`, which prioritizes the now-paused op and abort the conflict resolution in progress
// instead of undoing the unrelated earlier op.
//
// Every mutation hook below is stubbed exactly enough to drive `use-project-git.ts`'s own wrapping —
// `onSucceeded` is CAPTURED so a test can fire it like the real hook would on a terminal `SUCCEEDED`
// poll, and `start`/`handleConfirmed`/`switchBranch`/`createBranch` are spies so a test can both
// invoke `use-project-git.ts`'s wrapped versions AND assert they still delegate to the real ones.

jest.mock('@/hooks/use-git-tree-status', () => ({
  useGitTreeStatus: () => ({ statusByFileNodeId: {}, loading: false, error: null, refetch: jest.fn() }),
}));
// The git status is a NON-polling read model: it changes only when something calls its `refetch`.
// This stub therefore stands in for the server's own transition — `refetch` flips the value the next
// render will see — so a test can prove that a pull/switch pausing on conflicts really does surface
// a `CONFLICTED` status (the flag the toolbar's "Resolve conflicts" button is gated on).
const mockRefetchGitStatus = jest.fn(() => {
  mockGitStatusValue = { syncStatus: 'CONFLICTED', unstaged: [], untracked: [] };
});
let mockGitStatusValue: { syncStatus: string; unstaged: { path: string }[]; untracked: { path: string }[] } | null =
  null;
jest.mock('@/hooks/use-git-status', () => ({
  useGitStatus: () => ({
    status: mockGitStatusValue,
    connected: true,
    loading: false,
    error: null,
    refetch: mockRefetchGitStatus,
  }),
}));
jest.mock('@/hooks/use-behind-ahead', () => ({
  useBehindAhead: () => ({ behindAhead: null, loading: false, error: null, refetch: jest.fn().mockResolvedValue(undefined) }),
}));
jest.mock('@/hooks/use-git-activity', () => ({
  useGitActivity: () => ({ activeOperation: null, loading: false, error: null }),
}));

let capturedPullSucceeded: (() => void) | null = null;
// `onPaused` is captured the same way `onSucceeded` is, so a test can fire it like the real hook
// would when a poll lands on `AWAITING_CONFLICT` instead of `SUCCEEDED`.
let capturedPullPaused: (() => void) | null = null;
const mockPullStart = jest.fn();
const mockPullHandleConfirmed = jest.fn();
jest.mock('@/hooks/use-pull', () => ({
  usePull: (_projectId: string, onSucceeded: () => void, onPaused?: () => void) => {
    capturedPullSucceeded = onSucceeded;
    capturedPullPaused = onPaused ?? null;
    return {
      confirmOpen: false, closeConfirm: jest.fn(),
      handleConfirmed: mockPullHandleConfirmed,
      pending: false, message: null, start: mockPullStart, openPreview: jest.fn(),
    };
  },
}));

// Push's own `onSucceeded` isn't exercised by this suite (its success-path clearing is already
// covered by `project-editor-layout-git-undo.test.tsx`) — only its `start` initiation-path clearing.
const mockPushStart = jest.fn();
jest.mock('@/hooks/use-push', () => ({
  usePush: (_projectId: string, _onSucceeded: () => void) => ({
    pending: false, message: null, start: mockPushStart, clear: jest.fn(),
  }),
}));

let capturedBranchSwitchSucceeded: (() => void) | null = null;
let capturedBranchSwitchPaused: (() => void) | null = null;
const mockSwitchBranch = jest.fn();
const mockCreateBranch = jest.fn().mockResolvedValue(undefined);
jest.mock('@/hooks/use-branches', () => ({
  useBranches: (_projectId: string, onSucceeded: () => void, onPaused?: () => void) => {
    capturedBranchSwitchSucceeded = onSucceeded;
    capturedBranchSwitchPaused = onPaused ?? null;
    return {
      current: 'main', branches: [], loading: false, error: null, refetch: jest.fn(),
      createBranch: mockCreateBranch, switchBranch: mockSwitchBranch, switchPending: false,
      switchMessage: null, confirmOpen: false, confirmBranchName: null, confirmCode: null,
      closeConfirm: jest.fn(), handleConfirmed: jest.fn(),
    };
  },
}));

// The conflict list is fetched only while the panel is open, so the `enabled` flag this hook is
// handed is captured to prove the panel's own open state is what gates it.
let capturedConflictsEnabled: boolean | undefined;
jest.mock('@/hooks/use-conflicts', () => ({
  useConflicts: (_projectId: string, _onResolvedAndCleared: () => void, options?: { enabled?: boolean }) => {
    capturedConflictsEnabled = options?.enabled;
    return {
      operationId: null, files: [], loading: false, error: null, allResolved: false,
      resolve: jest.fn(), complete: jest.fn(), undo: jest.fn(), completing: false,
      message: null, refetch: jest.fn(),
    };
  },
}));

const mockUndoPull = jest.fn();
const mockGetGitOperation = jest.fn();
jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  undoPull: (...parameters: unknown[]) => mockUndoPull(...parameters),
  getGitOperation: (...parameters: unknown[]) => mockGetGitOperation(...parameters),
}));

beforeEach(() => {
  capturedPullSucceeded = null;
  capturedPullPaused = null;
  capturedBranchSwitchSucceeded = null;
  capturedBranchSwitchPaused = null;
  capturedConflictsEnabled = undefined;
  mockGitStatusValue = null;
  mockRefetchGitStatus.mockClear();
  mockPullStart.mockClear();
  mockPullHandleConfirmed.mockClear();
  mockPushStart.mockClear();
  mockSwitchBranch.mockClear();
  mockCreateBranch.mockClear();
  mockUndoPull.mockReset();
  mockGetGitOperation.mockReset();
});

describe('useProjectGit — undo affordance clears at INITIATION, not only on success', () => {
  test('starting a second pull clears a prior clean pull\'s affordance immediately — even if the second pull then pauses on conflicts and never succeeds', () => {
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));

    act(() => capturedPullSucceeded?.());
    expect(result.current.undoable).toEqual({ kind: 'pull', label: 'Pulled' });

    // Simulates the user starting a SECOND pull that will go on to pause in AWAITING_CONFLICT —
    // its own onSucceeded is deliberately never invoked, exactly like the real hook when a poll
    // lands on AWAITING_CONFLICT instead of SUCCEEDED.
    act(() => result.current.pull.start());

    expect(result.current.undoable).toBeNull();
    expect(mockPullStart).toHaveBeenCalledTimes(1);
  });

  test('the confirmed-pull retry path (what the status bar\'s normal Pull entry actually uses) also clears at initiation', () => {
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));

    act(() => capturedPullSucceeded?.());
    expect(result.current.undoable).not.toBeNull();

    act(() => result.current.pull.handleConfirmed({ operationId: 'op2', projectId: 'p1' }));

    expect(result.current.undoable).toBeNull();
    expect(mockPullHandleConfirmed).toHaveBeenCalledWith({ operationId: 'op2', projectId: 'p1' });
  });

  test('starting a branch switch clears a prior affordance immediately, even if the switch then pauses on conflicts', () => {
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));

    act(() => capturedPullSucceeded?.());
    expect(result.current.undoable).not.toBeNull();

    act(() => result.current.branches.switchBranch('feature-x'));

    expect(result.current.undoable).toBeNull();
    expect(mockSwitchBranch).toHaveBeenCalledWith('feature-x');
  });

  test('creating a branch clears a prior affordance too', async () => {
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));

    act(() => capturedBranchSwitchSucceeded?.());
    expect(result.current.undoable).not.toBeNull();

    await act(async () => {
      await result.current.branches.createBranch('feature-y');
    });

    expect(result.current.undoable).toBeNull();
    expect(mockCreateBranch).toHaveBeenCalledWith('feature-y');
  });

  test('starting a push clears a prior affordance immediately, at initiation', () => {
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));

    act(() => capturedPullSucceeded?.());
    expect(result.current.undoable).not.toBeNull();

    act(() => result.current.push.start());

    expect(result.current.undoable).toBeNull();
    expect(mockPushStart).toHaveBeenCalledTimes(1);
  });

  test('opening the commit dialog clears a prior affordance', () => {
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));

    act(() => capturedBranchSwitchSucceeded?.());
    expect(result.current.undoable).not.toBeNull();

    act(() => result.current.setCommitDialogOpen(true));

    expect(result.current.undoable).toBeNull();
  });

  test('opening the discard dialog clears a prior affordance', () => {
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));

    act(() => capturedPullSucceeded?.());
    expect(result.current.undoable).not.toBeNull();

    act(() => result.current.setDiscardDialogOpen(true));

    expect(result.current.undoable).toBeNull();
  });
});

describe('useProjectGit — undoLast failure wording is undo-specific, not pull-specific', () => {
  test('an unmapped refusal code falls back to an undo-flavored message, not "complete the pull"', async () => {
    mockUndoPull.mockRejectedValue(new ApiError(500, 'something_else', 'boom'));
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));
    act(() => capturedBranchSwitchSucceeded?.());

    await act(async () => {
      result.current.undoLast();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.undoMessage?.text).toBe("Couldn't undo the last change.");
    expect(result.current.undoMessage?.text).not.toContain('pull');
  });

  test('a nothing_to_undo refusal clears the affordance without any message', async () => {
    mockUndoPull.mockRejectedValue(new ApiError(409, 'nothing_to_undo', 'nothing to undo'));
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));
    act(() => capturedPullSucceeded?.());

    await act(async () => {
      result.current.undoLast();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.undoable).toBeNull();
    expect(result.current.undoMessage).toBeNull();
  });
});

// The inline "Undo" affordance's undo goes through the SAME `undo-pull` route the conflict panel
// uses, which is SYNCHRONOUS: it awaits the whole revert server-side and returns only once it has
// landed, so `undoLast` handles the response directly — no polling. These prove the synchronous
// contract: a 2xx clears the affordance and refreshes the read models WITHOUT surfacing the returned
// op's `driftSummary` (which is the ORIGINAL pull's drift, not the undo's own — surfacing it would be
// a FALSE "the undo dropped a change" banner), and a refusal keeps the affordance and shows the error.
describe('useProjectGit — undoLast handles the synchronous undo response directly', () => {
  test('a 2xx clears the affordance and refreshes, and surfaces NO drift banner from the returned op', async () => {
    // The returned op still carries the ORIGINAL pull's drift (the undo does not rewrite it on that
    // row); the synchronous handler must NOT read it, or it would falsely blame the undo for a drop
    // the pull made.
    mockUndoPull.mockResolvedValue({
      operationId: 'pull-op',
      driftSummary: {
        total: 1,
        droppedCount: 1,
        anomalies: [{ path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false }],
      },
    });
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));
    act(() => capturedPullSucceeded?.());
    expect(result.current.undoable).not.toBeNull();

    await act(async () => {
      result.current.undoLast();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.undoPending).toBe(false));

    // The revert already landed server-side: the affordance is cleared and NO message is shown — the
    // returned op's drift is never surfaced, and the operation is never polled.
    expect(result.current.undoable).toBeNull();
    expect(result.current.undoMessage).toBeNull();
    expect(mockGetGitOperation).not.toHaveBeenCalled();
  });

  test('a refusal keeps the affordance and shows the undo-specific error', async () => {
    mockUndoPull.mockRejectedValue(new ApiError(503, 'git_worker_unavailable', 'down'));
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));
    act(() => capturedPullSucceeded?.());

    await act(async () => {
      result.current.undoLast();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.undoPending).toBe(false));

    // The revert never ran: the affordance stays so the still-un-reverted op can be retried, and the
    // error is surfaced — never a silent success.
    expect(result.current.undoable).not.toBeNull();
    expect(result.current.undoMessage?.tone).toBe('error');
    expect(result.current.undoMessage?.text).toBe('The git service is unavailable. Try again shortly.');
  });
});

// A pull or switch that pauses in `AWAITING_CONFLICT` never fires its success callback, and
// `useGitStatus` never polls — so before the `onPaused` wiring below, NOTHING re-read the status at
// the moment it became `CONFLICTED`. The banner and the activity indicator announced the pause while
// the toolbar's "Resolve conflicts" button — the only entry point to the panel, gated on exactly
// that status — never rendered until a page reload. These prove the two can no longer disagree.
describe('useProjectGit — a pull/switch PAUSED on conflicts refreshes the git status', () => {
  test('a paused pull re-reads the git status, so the CONFLICTED-gated entry point appears', () => {
    const { result, rerender } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));
    expect(capturedPullPaused).not.toBeNull();
    expect(result.current.gitStatus).toBeNull();

    // Fired exactly as the real hook does when its poll lands on AWAITING_CONFLICT; its own
    // `onSucceeded` is deliberately never invoked.
    act(() => capturedPullPaused?.());

    expect(mockRefetchGitStatus).toHaveBeenCalled();
    rerender();
    expect(result.current.gitStatus?.syncStatus).toBe('CONFLICTED');
  });

  test('a paused branch switch does the same', () => {
    const { result, rerender } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));
    expect(capturedBranchSwitchPaused).not.toBeNull();

    act(() => capturedBranchSwitchPaused?.());

    expect(mockRefetchGitStatus).toHaveBeenCalled();
    rerender();
    expect(result.current.gitStatus?.syncStatus).toBe('CONFLICTED');
  });

  test('a pause offers no "Undo" affordance of its own — that is still success-only', () => {
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));

    act(() => capturedPullPaused?.());

    expect(result.current.undoable).toBeNull();
  });
});

// The conflict list is loaded by the panel's own open state, exactly like the history panel gates
// `useGitHistory`: the editor mounts this hook against a (usually healthy) repository long before
// any pull pauses, so a mount-only load left the panel showing an empty list forever.
describe('useProjectGit — the conflict list is gated on the panel being open', () => {
  test('the hook is mounted disabled and becomes enabled when the panel opens', () => {
    const { result } = renderHook(() => useProjectGit({ projectId: 'p1', canEdit: true }));
    expect(capturedConflictsEnabled).toBe(false);

    act(() => result.current.setConflictPanelOpen(true));

    expect(capturedConflictsEnabled).toBe(true);
  });
});
