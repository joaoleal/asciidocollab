import { renderHook, act } from '@testing-library/react';
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
jest.mock('@/hooks/use-git-status', () => ({
  useGitStatus: () => ({ status: null, connected: true, loading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('@/hooks/use-behind-ahead', () => ({
  useBehindAhead: () => ({ behindAhead: null, loading: false, error: null, refetch: jest.fn().mockResolvedValue(undefined) }),
}));
jest.mock('@/hooks/use-git-activity', () => ({
  useGitActivity: () => ({ activeOperation: null, loading: false, error: null }),
}));

let capturedPullSucceeded: (() => void) | null = null;
const mockPullStart = jest.fn();
const mockPullHandleConfirmed = jest.fn();
jest.mock('@/hooks/use-pull', () => ({
  usePull: (_projectId: string, onSucceeded: () => void) => {
    capturedPullSucceeded = onSucceeded;
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
const mockSwitchBranch = jest.fn();
const mockCreateBranch = jest.fn().mockResolvedValue(undefined);
jest.mock('@/hooks/use-branches', () => ({
  useBranches: (_projectId: string, onSucceeded: () => void) => {
    capturedBranchSwitchSucceeded = onSucceeded;
    return {
      current: 'main', branches: [], loading: false, error: null, refetch: jest.fn(),
      createBranch: mockCreateBranch, switchBranch: mockSwitchBranch, switchPending: false,
      switchMessage: null, confirmOpen: false, confirmBranchName: null, confirmCode: null,
      closeConfirm: jest.fn(), handleConfirmed: jest.fn(),
    };
  },
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

beforeEach(() => {
  capturedPullSucceeded = null;
  capturedBranchSwitchSucceeded = null;
  mockPullStart.mockClear();
  mockPullHandleConfirmed.mockClear();
  mockPushStart.mockClear();
  mockSwitchBranch.mockClear();
  mockCreateBranch.mockClear();
  mockUndoPull.mockReset();
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
