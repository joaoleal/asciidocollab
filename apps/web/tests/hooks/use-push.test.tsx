import { act, renderHook, waitFor } from '@testing-library/react';
import { usePush } from '@/hooks/use-push';
import { ApiError } from '@/lib/api/transport';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

const mockStartPush = jest.fn();
const mockGetGitOperation = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  startPush: (...parameters: unknown[]) => mockStartPush(...parameters),
  getGitOperation: (...parameters: unknown[]) => mockGetGitOperation(...parameters),
}));

jest.useFakeTimers();

const RUNNING_STATUS = { id: 'op1', kind: 'PUSH', state: 'RUNNING', progress: 10, errorCode: null, driftSummary: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockStartPush.mockResolvedValue({ operationId: 'op1', projectId: 'proj1' });
  mockGetGitOperation.mockResolvedValue(RUNNING_STATUS);
});

afterEach(() => {
  jest.clearAllTimers();
});

describe('usePush start', () => {
  test('starts polling the queued operation on success', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePush('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockStartPush).toHaveBeenCalledWith('proj1'));
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledWith('proj1', 'op1'));
    expect(result.current.pending).toBe(true);
  });

  test('a second start() while a push is already pending does not issue a second startPush', async () => {
    const { result } = renderHook(() => usePush('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockStartPush).toHaveBeenCalledTimes(1));
    expect(result.current.pending).toBe(true);

    // A stale/double invocation while the first push is still in flight must be a no-op — no second
    // POST, no duplicate queued push.
    act(() => {
      result.current.start();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockStartPush).toHaveBeenCalledTimes(1);
  });

  test('surfaces a refused start as an error message', async () => {
    mockStartPush.mockRejectedValueOnce(new ApiError(403, 'insufficient_role', 'nope'));
    const { result } = renderHook(() => usePush('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.message).toEqual({ tone: 'error', text: 'You need editor access to push.' }));
    expect(result.current.pending).toBe(false);
    expect(mockGetGitOperation).not.toHaveBeenCalled();
  });

  test.each([
    ['git_worker_unavailable', 'The git service is unavailable. Try again shortly.'],
    ['repository_not_connected', 'This project has no connected repository.'],
    ['some_unmapped_code', 'The push could not be started.'],
  ])('maps a %s refusal of the queue request to its own wording', async (code, expectedText) => {
    mockStartPush.mockRejectedValueOnce(new ApiError(409, code, 'server said so'));
    const { result } = renderHook(() => usePush('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.message).toEqual({ tone: 'error', text: expectedText }));
    expect(result.current.pending).toBe(false);
    expect(mockGetGitOperation).not.toHaveBeenCalled();
  });

  test('falls back to generic wording when the queue request never reaches the server', async () => {
    mockStartPush.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => usePush('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(result.current.message).toEqual({ tone: 'error', text: 'The push could not be started.' }),
    );
    expect(result.current.pending).toBe(false);
  });
});

describe('usePush polling outcomes', () => {
  test('SUCCEEDED stops polling and triggers the refetch callback', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePush('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PUSH', state: 'SUCCEEDED', progress: 100, errorCode: null, driftSummary: null });
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

  test('FAILED with a non-fast-forward error code shows a specific message', async () => {
    const { result } = renderHook(() => usePush('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PUSH', state: 'FAILED', progress: 40, errorCode: 'non_fast_forward', driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() =>
      expect(result.current.message).toEqual({
        tone: 'error',
        text: 'The remote has commits this branch does not have — pull first, then push again.',
      }),
    );
    expect(result.current.pending).toBe(false);
  });

  test('FAILED with an unrecognized error code shows the generic failure message', async () => {
    const { result } = renderHook(() => usePush('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PUSH', state: 'FAILED', progress: 40, errorCode: 'PUSH_FAILED', driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(result.current.message).toEqual({ tone: 'error', text: 'The push failed.' }));
    expect(result.current.pending).toBe(false);
  });

  test('FAILED with a missing-credential error code shows a specific message', async () => {
    const { result } = renderHook(() => usePush('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'PUSH',
      state: 'FAILED',
      progress: 40,
      errorCode: 'PUSH_CREDENTIAL_NOT_FOUND',
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() =>
      expect(result.current.message).toEqual({
        tone: 'error',
        text: 'No stored credential was found for this repository. Connect one and try again.',
      }),
    );
    expect(result.current.pending).toBe(false);
  });

  test('FAILED with a repository-not-found error code shows a specific message', async () => {
    const { result } = renderHook(() => usePush('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'PUSH',
      state: 'FAILED',
      progress: 40,
      errorCode: 'PUSH_REPOSITORY_NOT_FOUND',
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() =>
      expect(result.current.message).toEqual({
        tone: 'error',
        text: "This project's repository could not be found on the remote.",
      }),
    );
    expect(result.current.pending).toBe(false);
  });

  test('ABORTED stops polling and reports the push as aborted', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePush('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PUSH', state: 'ABORTED', progress: 20, errorCode: null, driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(result.current.message).toEqual({ tone: 'error', text: 'The push was aborted.' }));
    expect(result.current.pending).toBe(false);
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  test('a poll that answers after the hook is gone reports nothing', async () => {
    const onSucceeded = jest.fn();
    let settle: (value: unknown) => void = noop;
    const pending = new Promise((resolve) => {
      settle = resolve;
    });
    const { result, unmount } = renderHook(() => usePush('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockReturnValue(pending);
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    unmount();
    await act(async () => {
      settle({ id: 'op1', kind: 'PUSH', state: 'SUCCEEDED', progress: 100, errorCode: null, driftSummary: null });
    });

    expect(onSucceeded).not.toHaveBeenCalled();
  });

  test('keeps polling on an interval while the operation is non-terminal', async () => {
    const { result } = renderHook(() => usePush('proj1', jest.fn()));

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

describe('usePush clear', () => {
  test('dismisses a lingering message without starting a new push', async () => {
    const { result } = renderHook(() => usePush('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PUSH', state: 'FAILED', progress: 40, errorCode: 'non_fast_forward', driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() => expect(result.current.message).not.toBeNull());

    mockGetGitOperation.mockClear();
    act(() => {
      result.current.clear();
    });

    expect(result.current.message).toBeNull();
    expect(result.current.pending).toBe(false);
    expect(mockStartPush).toHaveBeenCalledTimes(1);
    expect(mockGetGitOperation).not.toHaveBeenCalled();
  });
});
