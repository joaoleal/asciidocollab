import { act, renderHook, waitFor } from '@testing-library/react';
import { useBranches } from '@/hooks/use-branches';
import { ApiError } from '@/lib/api/transport';

const mockGetBranches = jest.fn();
const mockCreateBranch = jest.fn();
const mockCheckoutBranch = jest.fn();
const mockGetGitOperation = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  getBranches: (...parameters: unknown[]) => mockGetBranches(...parameters),
  createBranch: (...parameters: unknown[]) => mockCreateBranch(...parameters),
  checkoutBranch: (...parameters: unknown[]) => mockCheckoutBranch(...parameters),
  getGitOperation: (...parameters: unknown[]) => mockGetGitOperation(...parameters),
}));

jest.useFakeTimers();

const BRANCH_LIST = {
  current: 'main',
  branches: [
    { name: 'main', isCurrent: true },
    { name: 'dev', isCurrent: false },
  ],
};

const RUNNING_STATUS = { id: 'op1', kind: 'BRANCH_SWITCH', state: 'RUNNING', progress: 10, errorCode: null, driftSummary: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBranches.mockResolvedValue(BRANCH_LIST);
  mockCheckoutBranch.mockResolvedValue({ operationId: 'op1', projectId: 'proj1' });
  mockGetGitOperation.mockResolvedValue(RUNNING_STATUS);
});

afterEach(() => {
  jest.clearAllTimers();
});

async function startSwitch(result: ReturnType<typeof renderHook<ReturnType<typeof useBranches>, unknown>>['result']) {
  await act(async () => {
    result.current.switchBranch('dev');
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));
}

describe('useBranches list load', () => {
  test('loads the branch list on mount', async () => {
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.current).toBe('main');
    expect(result.current.branches).toEqual(BRANCH_LIST.branches);
    expect(result.current.error).toBeNull();
  });

  test('surfaces a genuine load failure', async () => {
    mockGetBranches.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));

    await waitFor(() => expect(result.current.error).toBe('Failed to load branches.'));
    expect(result.current.current).toBeNull();
    expect(result.current.branches).toEqual([]);
  });

  test('resolves quietly (not an error) when the project has no connected git repo (404)', async () => {
    mockGetBranches.mockRejectedValueOnce(
      new ApiError(404, 'repository_not_connected', 'This project has no connected Git repository'),
    );
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.current).toBeNull();
    expect(result.current.branches).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  test('refetch reloads the list', async () => {
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockGetBranches.mockResolvedValueOnce({
      current: 'dev',
      branches: [{ name: 'main', isCurrent: false }, { name: 'dev', isCurrent: true }],
    });
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.current).toBe('dev');
  });

  test('an older list load resolving after a newer one does not overwrite fresher state', async () => {
    let resolveFirst!: (value: typeof BRANCH_LIST) => void;
    let resolveSecond!: (value: typeof BRANCH_LIST) => void;
    mockGetBranches
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const { result } = renderHook(() => useBranches('proj1', jest.fn()));
    expect(result.current.loading).toBe(true);

    // Start a second (newer) load before the mount's (older) load has resolved.
    let refetchPromise!: Promise<void>;
    act(() => {
      refetchPromise = result.current.refetch();
    });

    const NEWER = {
      current: 'dev',
      branches: [{ name: 'main', isCurrent: false }, { name: 'dev', isCurrent: true }],
    };

    // The newer load resolves first.
    await act(async () => {
      resolveSecond(NEWER);
      await refetchPromise;
    });
    expect(result.current.current).toBe('dev');
    expect(result.current.branches).toEqual(NEWER.branches);

    // The older (mount) load resolves last, with stale data — it must not overwrite the newer state.
    await act(async () => {
      resolveFirst(BRANCH_LIST);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.current).toBe('dev');
    expect(result.current.branches).toEqual(NEWER.branches);
    expect(result.current.loading).toBe(false);
  });
});

describe('useBranches createBranch', () => {
  test('success creates the branch and refetches the list', async () => {
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockCreateBranch.mockResolvedValueOnce({ branch: { name: 'feature/x', isCurrent: false } });
    mockGetBranches.mockResolvedValueOnce({
      current: 'main',
      branches: [...BRANCH_LIST.branches, { name: 'feature/x', isCurrent: false }],
    });

    await act(async () => {
      await result.current.createBranch('feature/x');
    });

    expect(mockCreateBranch).toHaveBeenCalledWith('proj1', 'feature/x');
    expect(result.current.branches).toEqual(
      expect.arrayContaining([{ name: 'feature/x', isCurrent: false }]),
    );
  });

  test('failure surfaces by rejecting, without touching the loaded list', async () => {
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockCreateBranch.mockRejectedValueOnce(new ApiError(409, 'validation_error', 'bad name'));

    await expect(
      act(async () => {
        await result.current.createBranch('bad name');
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(result.current.branches).toEqual(BRANCH_LIST.branches);
  });
});

describe('useBranches switchBranch', () => {
  test('starts polling the queued operation on success', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => useBranches('proj1', onSucceeded));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.switchBranch('dev');
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockCheckoutBranch).toHaveBeenCalledWith('proj1', { name: 'dev' }));
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledWith('proj1', 'op1'));
    expect(result.current.switchPending).toBe(true);
    expect(result.current.confirmOpen).toBe(false);
  });

  test('opens the confirm dialog (not an error) on a 409 uncommitted_changes refusal', async () => {
    mockCheckoutBranch.mockRejectedValueOnce(new ApiError(409, 'uncommitted_changes', 'uncommitted'));
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.switchBranch('dev');
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.confirmOpen).toBe(true));
    expect(result.current.confirmBranchName).toBe('dev');
    expect(result.current.confirmCode).toBe('uncommitted_changes');
    expect(result.current.switchMessage).toBeNull();
    expect(result.current.switchPending).toBe(false);
    expect(mockGetGitOperation).not.toHaveBeenCalled();
  });

  test('opens the confirm dialog on a 409 open_files_need_confirm refusal', async () => {
    mockCheckoutBranch.mockRejectedValueOnce(new ApiError(409, 'open_files_need_confirm', 'open files'));
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.switchBranch('dev');
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.confirmOpen).toBe(true));
    expect(result.current.confirmCode).toBe('open_files_need_confirm');
  });

  test('surfaces any other refusal as an error message, not the confirm dialog', async () => {
    mockCheckoutBranch.mockRejectedValueOnce(new ApiError(403, 'insufficient_role', 'nope'));
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.switchBranch('dev');
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(result.current.switchMessage).toEqual({
        tone: 'error',
        text: 'You need editor access to switch branches.',
      }),
    );
    expect(result.current.confirmOpen).toBe(false);
    expect(result.current.switchPending).toBe(false);
  });

  test('handleConfirmed closes the dialog and starts polling the confirmed operation', async () => {
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.handleConfirmed({ operationId: 'op2', projectId: 'proj1' }));

    expect(result.current.confirmOpen).toBe(false);
    expect(result.current.switchPending).toBe(true);
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledWith('proj1', 'op2'));
  });

  test('closeConfirm closes the dialog without starting a poll', async () => {
    mockCheckoutBranch.mockRejectedValueOnce(new ApiError(409, 'uncommitted_changes', 'uncommitted'));
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.switchBranch('dev');
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.confirmOpen).toBe(true));

    act(() => result.current.closeConfirm());
    expect(result.current.confirmOpen).toBe(false);
    expect(result.current.confirmBranchName).toBeNull();
    expect(result.current.confirmCode).toBeNull();
  });
});

describe('useBranches polling outcomes', () => {
  test('stops polling and shows a neutral paused message on AWAITING_CONFLICT', async () => {
    const onSucceeded = jest.fn();
    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'BRANCH_SWITCH', state: 'AWAITING_CONFLICT', progress: 50, errorCode: null, driftSummary: null });
    const { result } = renderHook(() => useBranches('proj1', onSucceeded));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await startSwitch(result);

    await waitFor(() =>
      expect(result.current.switchMessage).toEqual({
        tone: 'neutral',
        text: 'Branch switch paused — conflicts need resolving.',
      }),
    );
    expect(result.current.switchPending).toBe(false);

    const callsAtPause = mockGetGitOperation.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockGetGitOperation.mock.calls.length).toBe(callsAtPause);
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  // A paused switch deliberately never fires `onSucceeded`, but SOMETHING has to tell the caller to
  // re-read the git status: the pause is the moment `syncStatus` becomes `CONFLICTED`, which gates
  // the toolbar's only "Resolve conflicts" entry point. Mirrors `usePull`'s own `onPaused` test.
  test('AWAITING_CONFLICT fires onPaused (and never onSucceeded) so the caller can re-read the git status', async () => {
    const onSucceeded = jest.fn();
    const onPaused = jest.fn();
    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'BRANCH_SWITCH', state: 'AWAITING_CONFLICT', progress: 50, errorCode: null, driftSummary: null });
    const { result } = renderHook(() => useBranches('proj1', onSucceeded, onPaused));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await startSwitch(result);

    await waitFor(() => expect(onPaused).toHaveBeenCalledTimes(1));
    expect(onSucceeded).not.toHaveBeenCalled();
    expect(result.current.switchMessage?.tone).toBe('neutral');
  });

  test('SUCCEEDED stops polling, refetches the list, and calls onSucceeded', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => useBranches('proj1', onSucceeded));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await startSwitch(result);

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'BRANCH_SWITCH', state: 'SUCCEEDED', progress: 100, errorCode: null, driftSummary: null });
    mockGetBranches.mockResolvedValueOnce({
      current: 'dev',
      branches: [{ name: 'main', isCurrent: false }, { name: 'dev', isCurrent: true }],
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.current).toBe('dev'));
    expect(result.current.switchPending).toBe(false);
    expect(result.current.switchMessage).toBeNull();
  });

  test('SUCCEEDED with a dropped-change drift summary shows a neutral recovery message', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => useBranches('proj1', onSucceeded));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await startSwitch(result);

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'BRANCH_SWITCH',
      state: 'SUCCEEDED',
      progress: 100,
      errorCode: null,
      driftSummary: {
        total: 1,
        droppedCount: 1,
        anomalies: [{ path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false }],
      },
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(result.current.switchMessage?.tone).toBe('neutral');
    expect(result.current.switchMessage?.text).toContain('Branch switch applied');
    expect(result.current.switchMessage?.text).toContain('docs');
    expect(result.current.switchMessage?.text).toContain('Remove or rename the folder');
    expect(result.current.switchMessage?.text).toContain('switch to that branch again');
    expect(result.current.switchMessage?.text).not.toContain('pull again');
  });

  test('SUCCEEDED with no drift summary sets no switch message', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => useBranches('proj1', onSucceeded));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await startSwitch(result);

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'BRANCH_SWITCH', state: 'SUCCEEDED', progress: 100, errorCode: null, driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(result.current.switchMessage).toBeNull();
  });

  test('FAILED stops polling and shows an error message', async () => {
    const { result } = renderHook(() => useBranches('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await startSwitch(result);

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'BRANCH_SWITCH', state: 'FAILED', progress: 40, errorCode: 'git_command_failed', driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(result.current.switchMessage).toEqual({ tone: 'error', text: 'The branch switch failed.' }));
    expect(result.current.switchPending).toBe(false);
  });

  test('an older poll tick resolving after a newer tick does not incorrectly settle the switch', async () => {
    const onSucceeded = jest.fn();
    let resolveTick1!: (value: typeof RUNNING_STATUS) => void;
    let resolveTick2!: (value: typeof RUNNING_STATUS) => void;
    mockGetGitOperation
      .mockImplementationOnce(() => new Promise((resolve) => { resolveTick1 = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveTick2 = resolve; }));

    const { result } = renderHook(() => useBranches('proj1', onSucceeded));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.switchBranch('dev');
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    // A second (newer) tick starts before the first (older) tick has resolved.
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(2));

    // The newer tick resolves first, with a still-running status.
    await act(async () => {
      resolveTick2(RUNNING_STATUS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.switchPending).toBe(true);

    // The older tick resolves last, with a stale SUCCEEDED status — since a newer tick has already
    // been observed as still running, this must be ignored rather than incorrectly settling the switch.
    await act(async () => {
      resolveTick1({ id: 'op1', kind: 'BRANCH_SWITCH', state: 'SUCCEEDED', progress: 100, errorCode: null, driftSummary: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.switchPending).toBe(true);
    expect(result.current.switchMessage).toBeNull();
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  test('no state update after unmount', async () => {
    const { result, unmount } = renderHook(() => useBranches('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await startSwitch(result);

    unmount();

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'BRANCH_SWITCH', state: 'SUCCEEDED', progress: 100, errorCode: null, driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    // No assertion beyond "did not throw" — React would log a state-update-after-unmount warning,
    // which the `active` cleanup flag in the poll effect prevents.
  });
});
