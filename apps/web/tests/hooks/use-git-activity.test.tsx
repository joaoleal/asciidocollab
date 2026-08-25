import { act, renderHook, waitFor } from '@testing-library/react';
import { useGitActivity } from '@/hooks/use-git-activity';
import { ApiError } from '@/lib/api/transport';

const mockGetActiveGitOperation = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  getActiveGitOperation: (...parameters: unknown[]) => mockGetActiveGitOperation(...parameters),
}));

jest.useFakeTimers();

const RUNNING_OPERATION = { id: 'op1', kind: 'PULL', state: 'RUNNING', progress: 40, errorCode: null };

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

  test('clears the previous interval and reloads when projectId changes', async () => {
    const { rerender } = renderHook(({ projectId }) => useGitActivity(projectId), {
      initialProps: { projectId: 'proj1' },
    });
    await waitFor(() => expect(mockGetActiveGitOperation).toHaveBeenCalledWith('proj1'));

    rerender({ projectId: 'proj2' });
    await waitFor(() => expect(mockGetActiveGitOperation).toHaveBeenCalledWith('proj2'));
  });
});
