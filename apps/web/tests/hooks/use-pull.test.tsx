import { act, renderHook, waitFor } from '@testing-library/react';
import { usePull } from '@/hooks/use-pull';
import { ApiError } from '@/lib/api/transport';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

const mockStartPull = jest.fn();
const mockGetGitOperation = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  startPull: (...parameters: unknown[]) => mockStartPull(...parameters),
  getGitOperation: (...parameters: unknown[]) => mockGetGitOperation(...parameters),
}));

jest.useFakeTimers();

const RUNNING_STATUS = { id: 'op1', kind: 'PULL', state: 'RUNNING', progress: 10, errorCode: null, driftSummary: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockStartPull.mockResolvedValue({ operationId: 'op1', projectId: 'proj1' });
  mockGetGitOperation.mockResolvedValue(RUNNING_STATUS);
});

afterEach(() => {
  jest.clearAllTimers();
});

describe('usePull start', () => {
  test('starts polling the queued operation on success', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePull('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockStartPull).toHaveBeenCalledWith('proj1'));
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledWith('proj1', 'op1'));
    expect(result.current.pending).toBe(true);
    expect(result.current.confirmOpen).toBe(false);
  });

  test('opens the confirm dialog (not an error) on a 409 open_files_need_confirm refusal', async () => {
    mockStartPull.mockRejectedValueOnce(new ApiError(409, 'open_files_need_confirm', 'files are open'));
    const { result } = renderHook(() => usePull('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.confirmOpen).toBe(true));
    expect(result.current.message).toBeNull();
    expect(result.current.pending).toBe(false);
    expect(mockGetGitOperation).not.toHaveBeenCalled();
  });

  test('surfaces any other refusal as an error message, not the confirm dialog', async () => {
    mockStartPull.mockRejectedValueOnce(new ApiError(403, 'insufficient_role', 'nope'));
    const { result } = renderHook(() => usePull('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.message).toEqual({ tone: 'error', text: 'You need editor access to pull.' }));
    expect(result.current.confirmOpen).toBe(false);
    expect(result.current.pending).toBe(false);
  });
});

describe('usePull confirmation retry', () => {
  test('handleConfirmed closes the dialog and starts polling the confirmed operation', async () => {
    const { result } = renderHook(() => usePull('proj1', jest.fn()));

    act(() => result.current.handleConfirmed({ operationId: 'op2', projectId: 'proj1' }));

    expect(result.current.confirmOpen).toBe(false);
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledWith('proj1', 'op2'));
  });

  test('closeConfirm closes the dialog without starting a poll', async () => {
    const { result } = renderHook(() => usePull('proj1', jest.fn()));
    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => result.current.closeConfirm());
    expect(result.current.confirmOpen).toBe(false);
  });

  test('openPreview opens the confirm dialog without attempting a pull', () => {
    const { result } = renderHook(() => usePull('proj1', jest.fn()));

    act(() => result.current.openPreview());

    expect(result.current.confirmOpen).toBe(true);
    expect(mockStartPull).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });

  test('openPreview clears any leftover message from a previous attempt', async () => {
    mockStartPull.mockRejectedValueOnce(new ApiError(403, 'insufficient_role', 'nope'));
    const { result } = renderHook(() => usePull('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.message).not.toBeNull());

    act(() => result.current.openPreview());

    expect(result.current.message).toBeNull();
  });
});

describe('usePull polling outcomes', () => {
  test('stops polling and shows a neutral paused message on AWAITING_CONFLICT (does not loop past it)', async () => {
    const onSucceeded = jest.fn();
    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PULL', state: 'AWAITING_CONFLICT', progress: 50, errorCode: null, driftSummary: null });
    const { result } = renderHook(() => usePull('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(result.current.message).toEqual({ tone: 'neutral', text: 'Pull paused — conflicts need resolving.' }),
    );
    expect(result.current.pending).toBe(false);

    const callsAtPause = mockGetGitOperation.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockGetGitOperation.mock.calls.length).toBe(callsAtPause);
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  // A paused pull deliberately never fires `onSucceeded`, but SOMETHING has to tell the caller to
  // re-read the git status: the pause is the moment `syncStatus` becomes `CONFLICTED`, which gates
  // the toolbar's only "Resolve conflicts" entry point. Without this callback the paused message and
  // the button offering to act on it disagreed until a page reload.
  test('AWAITING_CONFLICT fires onPaused (and never onSucceeded) so the caller can re-read the git status', async () => {
    const onSucceeded = jest.fn();
    const onPaused = jest.fn();
    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PULL', state: 'AWAITING_CONFLICT', progress: 50, errorCode: null, driftSummary: null });
    const { result } = renderHook(() => usePull('proj1', onSucceeded, onPaused));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(onPaused).toHaveBeenCalledTimes(1));
    expect(onSucceeded).not.toHaveBeenCalled();
    expect(result.current.message?.tone).toBe('neutral');
  });

  test('SUCCEEDED stops polling and triggers the refetch callback', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePull('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PULL', state: 'SUCCEEDED', progress: 100, errorCode: null, driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(result.current.pending).toBe(false);
    expect(result.current.message).toBeNull();

    const callsAtSuccess = mockGetGitOperation.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockGetGitOperation.mock.calls.length).toBe(callsAtSuccess);
  });

  test('SUCCEEDED with a dropped-change drift summary shows a neutral recovery message and still calls onSucceeded', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePull('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'PULL',
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
    expect(result.current.message?.tone).toBe('neutral');
    expect(result.current.message?.text).toContain('docs');
    expect(result.current.message?.text).toContain('folder');
    expect(result.current.message?.text).toContain('pull again');
  });

  test('SUCCEEDED with a file-occupies-ancestor drop says a file (not a folder) is in the way', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePull('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'PULL',
      state: 'SUCCEEDED',
      progress: 100,
      errorCode: null,
      driftSummary: {
        total: 1,
        droppedCount: 1,
        anomalies: [{ path: 'notes', kind: 'content_dropped_file_occupies_ancestor_path', applied: false }],
      },
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(result.current.message?.tone).toBe('neutral');
    expect(result.current.message?.text).toContain('notes');
    expect(result.current.message?.text).toContain('file');
    expect(result.current.message?.text).not.toContain('folder');
    expect(result.current.message?.text).toContain('pull again');
  });

  test('SUCCEEDED with a dropped binary-into-open-document change tells the user to close the document', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePull('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'PULL',
      state: 'SUCCEEDED',
      progress: 100,
      errorCode: null,
      driftSummary: {
        total: 1,
        droppedCount: 1,
        anomalies: [{ path: 'diagram.png', kind: 'content_dropped_binary_open_document', applied: false }],
      },
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(result.current.message?.tone).toBe('neutral');
    expect(result.current.message?.text).toContain('diagram.png');
    expect(result.current.message?.text).toContain('document is open in the editor');
    expect(result.current.message?.text).toContain('Close the document');
    expect(result.current.message?.text).toContain('pull again');
    expect(result.current.message?.text).not.toContain('No action is needed');
    expect(result.current.message?.text).not.toContain('nothing was lost');
    expect(result.current.message?.text).not.toContain('auto-reconcile');
  });

  test('SUCCEEDED with mixed drop kinds (folder-occupied + binary-open-document) uses a generic combined message', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePull('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'PULL',
      state: 'SUCCEEDED',
      progress: 100,
      errorCode: null,
      driftSummary: {
        total: 2,
        droppedCount: 2,
        anomalies: [
          { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false },
          { path: 'diagram.png', kind: 'content_dropped_binary_open_document', applied: false },
        ],
      },
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(result.current.message?.tone).toBe('neutral');
    expect(result.current.message?.text).toContain('docs');
    expect(result.current.message?.text).toContain('diagram.png');
    expect(result.current.message?.text).toContain('document is open in the editor');
    expect(result.current.message?.text).toContain('pull again');
    expect(result.current.message?.text).not.toContain('No action is needed');
    expect(result.current.message?.text).not.toContain('nothing was lost');
  });

  test('SUCCEEDED with a benign-only (all auto-repaired) drift summary shows no message', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePull('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'PULL',
      state: 'SUCCEEDED',
      progress: 100,
      errorCode: null,
      driftSummary: {
        total: 1,
        droppedCount: 0,
        anomalies: [{ path: 'ghost.adoc', kind: 'modified_missing_node', applied: true }],
      },
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(result.current.message).toBeNull();
  });

  test('FAILED stops polling and shows an error message', async () => {
    const { result } = renderHook(() => usePull('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PULL', state: 'FAILED', progress: 40, errorCode: 'merge_conflict', driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(result.current.message).toEqual({ tone: 'error', text: 'The pull failed.' }));
    expect(result.current.pending).toBe(false);
  });

  test('ABORTED stops polling and reports the pull as aborted', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePull('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PULL', state: 'ABORTED', progress: 20, errorCode: null, driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(result.current.message).toEqual({ tone: 'error', text: 'The pull was aborted.' }));
    expect(result.current.pending).toBe(false);
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  test('a poll that answers after the hook is gone reports nothing', async () => {
    const onSucceeded = jest.fn();
    let settle: (value: unknown) => void = noop;
    const settling = new Promise((resolve) => {
      settle = resolve;
    });
    const { result, unmount } = renderHook(() => usePull('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockReturnValue(settling);
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    unmount();
    await act(async () => {
      settle({ id: 'op1', kind: 'PULL', state: 'SUCCEEDED', progress: 100, errorCode: null, driftSummary: null });
    });

    expect(onSucceeded).not.toHaveBeenCalled();
  });

  test('keeps polling on an interval while the operation is non-terminal', async () => {
    const { result } = renderHook(() => usePull('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(mockGetGitOperation.mock.calls.length).toBeGreaterThan(1);
  });
});
