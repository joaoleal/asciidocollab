import { act, renderHook, waitFor } from '@testing-library/react';
import { useGitActivity } from '@/hooks/use-git-activity';
import { ApiError } from '@/lib/api/transport';
import type { GitOperationStatusDto } from '@asciidocollab/shared';

const mockGetActiveGitOperation = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  getActiveGitOperation: (...parameters: unknown[]) => mockGetActiveGitOperation(...parameters),
}));

jest.useFakeTimers();

const RUNNING_OPERATION: GitOperationStatusDto = { id: 'op1', kind: 'PULL', state: 'RUNNING', progress: 40, errorCode: null, driftSummary: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetActiveGitOperation.mockResolvedValue({ operation: null });
});

afterEach(() => {
  jest.clearAllTimers();
});

describe('useGitActivity', () => {
  test('resolves the active operation on mount', async () => {
    mockGetActiveGitOperation.mockResolvedValue({ operation: RUNNING_OPERATION });
    const { result } = renderHook(() => useGitActivity('proj1'));

    await waitFor(() => expect(result.current.activeOperation).toEqual(RUNNING_OPERATION));
    expect(mockGetActiveGitOperation).toHaveBeenCalledWith('proj1');
    expect(result.current.error).toBeNull();
  });

  test('polls on an interval while mounted', async () => {
    const { result } = renderHook(() => useGitActivity('proj1'));
    await waitFor(() => expect(mockGetActiveGitOperation).toHaveBeenCalledTimes(1));

    mockGetActiveGitOperation.mockResolvedValue({ operation: RUNNING_OPERATION });
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    await waitFor(() => expect(mockGetActiveGitOperation.mock.calls.length).toBeGreaterThanOrEqual(2));

    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    await waitFor(() => expect(mockGetActiveGitOperation.mock.calls.length).toBeGreaterThanOrEqual(3));

    expect(result.current.activeOperation).toEqual(RUNNING_OPERATION);
  });

  test('a 404 resolves to activeOperation: null, with no error surfaced', async () => {
    mockGetActiveGitOperation.mockRejectedValue(new ApiError(404, 'repository_not_connected', 'no repo'));
    const { result } = renderHook(() => useGitActivity('proj1'));

    await waitFor(() => expect(mockGetActiveGitOperation).toHaveBeenCalled());
    expect(result.current.activeOperation).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test('does not poll (or even fetch once) for a project that is not git-connected', async () => {
    const { result } = renderHook(() => useGitActivity('proj1', false));
    await act(async () => {
      await Promise.resolve();
    });

    // Not connected: null active operation and — crucially — no request at all, not even a first one
    // that would 404. Advancing well past several poll intervals must not change that.
    expect(result.current.activeOperation).toBeNull();
    expect(result.current.error).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(mockGetActiveGitOperation).not.toHaveBeenCalled();
  });

  test('a genuine failure surfaces an error', async () => {
    mockGetActiveGitOperation.mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
    const { result } = renderHook(() => useGitActivity('proj1'));

    await waitFor(() => expect(result.current.error).toBe('Failed to load git activity.'));
    expect(result.current.activeOperation).toBeNull();
  });

  test('stops polling on unmount — no call after unmount', async () => {
    const { unmount } = renderHook(() => useGitActivity('proj1'));
    await waitFor(() => expect(mockGetActiveGitOperation).toHaveBeenCalledTimes(1));

    unmount();
    const callsAtUnmount = mockGetActiveGitOperation.mock.calls.length;

    await act(async () => {
      jest.advanceTimersByTime(20_000);
    });
    expect(mockGetActiveGitOperation.mock.calls.length).toBe(callsAtUnmount);
  });

  test('does not let a slower OLDER poll that resolves last overwrite a newer value', async () => {
    let resolveOlder!: (value: { operation: GitOperationStatusDto | null }) => void;
    let resolveNewer!: (value: { operation: GitOperationStatusDto | null }) => void;

    // Older poll: the initial on-mount load, which sees the operation still RUNNING. Left in flight.
    mockGetActiveGitOperation.mockReturnValueOnce(
      new Promise((resolveFunction) => {
        resolveOlder = resolveFunction;
      }),
    );
    const { result } = renderHook(() => useGitActivity('proj1'));

    // Newer poll: the next interval poll, started while the first is still in flight. The operation
    // has since finished, so this one sees no active operation — it is the LATEST-started load.
    mockGetActiveGitOperation.mockReturnValueOnce(
      new Promise((resolveFunction) => {
        resolveNewer = resolveFunction;
      }),
    );
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });

    // The newer poll resolves first and its value (operation finished → null) is applied.
    await act(async () => {
      resolveNewer({ operation: null });
      await Promise.resolve();
    });
    expect(result.current.activeOperation).toBeNull();

    // The OLDER poll resolves last with its stale "still RUNNING" snapshot. It must be dropped, not
    // applied — otherwise the indicator would show a running operation after it had finished.
    await act(async () => {
      resolveOlder({ operation: RUNNING_OPERATION });
      await Promise.resolve();
    });
    expect(result.current.activeOperation).toBeNull();
  });

  test('clears the previous interval and reloads when projectId changes', async () => {
    const { rerender } = renderHook(({ projectId }) => useGitActivity(projectId), {
      initialProps: { projectId: 'proj1' },
    });
    await waitFor(() => expect(mockGetActiveGitOperation).toHaveBeenCalledWith('proj1'));

    rerender({ projectId: 'proj2' });
    await waitFor(() => expect(mockGetActiveGitOperation).toHaveBeenCalledWith('proj2'));
  });
});
