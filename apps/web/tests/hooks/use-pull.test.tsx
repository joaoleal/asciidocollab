import { act, renderHook, waitFor } from '@testing-library/react';
import { usePull } from '@/hooks/use-pull';
import { ApiError } from '@/lib/api/transport';

const mockStartPull = jest.fn();
const mockGetGitOperation = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  startPull: (...parameters: unknown[]) => mockStartPull(...parameters),
  getGitOperation: (...parameters: unknown[]) => mockGetGitOperation(...parameters),
}));

jest.useFakeTimers();

const RUNNING_STATUS = { id: 'op1', kind: 'PULL', state: 'RUNNING', progress: 10, errorCode: null };

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
});

describe('usePull polling outcomes', () => {
  test('stops polling and shows a neutral paused message on AWAITING_CONFLICT (does not loop past it)', async () => {
    const onSucceeded = jest.fn();
    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PULL', state: 'AWAITING_CONFLICT', progress: 50, errorCode: null });
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

  test('SUCCEEDED stops polling and triggers the refetch callback', async () => {
    const onSucceeded = jest.fn();
    const { result } = renderHook(() => usePull('proj1', onSucceeded));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PULL', state: 'SUCCEEDED', progress: 100, errorCode: null });
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

  test('FAILED stops polling and shows an error message', async () => {
    const { result } = renderHook(() => usePull('proj1', jest.fn()));

    await act(async () => {
      result.current.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'PULL', state: 'FAILED', progress: 40, errorCode: 'merge_conflict' });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(result.current.message).toEqual({ tone: 'error', text: 'The pull failed.' }));
    expect(result.current.pending).toBe(false);
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
