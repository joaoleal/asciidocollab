import { renderHook, act, waitFor } from '@testing-library/react';
import { useConflicts } from '@/hooks/use-conflicts';
import {
  completePull,
  getConflicts,
  getGitOperation,
  resolveConflict,
  undoPull,
} from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { ConflictListDto } from '@asciidocollab/shared';

jest.mock('@/lib/api/git', () => ({
  getConflicts: jest.fn(),
  resolveConflict: jest.fn(),
  completePull: jest.fn(),
  undoPull: jest.fn(),
  getGitOperation: jest.fn(),
  isGitOperationTerminal: jest.fn((state: string) => ['SUCCEEDED', 'FAILED', 'ABORTED'].includes(state)),
}));

const mockGetConflicts = getConflicts as jest.MockedFunction<typeof getConflicts>;
const mockResolveConflict = resolveConflict as jest.MockedFunction<typeof resolveConflict>;
const mockCompletePull = completePull as jest.MockedFunction<typeof completePull>;
const mockUndoPull = undoPull as jest.MockedFunction<typeof undoPull>;
const mockGetGitOperation = getGitOperation as jest.MockedFunction<typeof getGitOperation>;

const LIST: ConflictListDto = {
  operationId: 'op1',
  files: [
    { path: 'a.adoc', isBinary: false, resolved: false },
    { path: 'b.adoc', isBinary: false, resolved: false },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useConflicts loading', () => {
  it('loads the conflict list for a paused pull', async () => {
    mockGetConflicts.mockResolvedValue(LIST);
    const onResolvedAndCleared = jest.fn();
    const { result } = renderHook(() => useConflicts('proj1', onResolvedAndCleared));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.files).toEqual(LIST.files);
    expect(result.current.operationId).toBe('op1');
    expect(result.current.error).toBeNull();
    expect(result.current.allResolved).toBe(false);
  });

  it('resolves to not-in-conflict (not an error) on a 404', async () => {
    mockGetConflicts.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'no conflicts'));
    const { result } = renderHook(() => useConflicts('proj1', jest.fn()));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.files).toEqual([]);
    expect(result.current.operationId).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('surfaces a genuinely unexpected load failure as an error', async () => {
    mockGetConflicts.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
    const { result } = renderHook(() => useConflicts('proj1', jest.fn()));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).not.toBeNull();
  });

  it('surfaces a network failure as an error', async () => {
    mockGetConflicts.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useConflicts('proj1', jest.fn()));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).not.toBeNull();
  });

  it('ignores a resolved load after unmount (no state update)', async () => {
    let resolveLoad!: (value: ConflictListDto) => void;
    mockGetConflicts.mockReturnValue(
      new Promise((resolveFunction) => {
        resolveLoad = resolveFunction;
      }),
    );
    const { unmount } = renderHook(() => useConflicts('proj1', jest.fn()));
    unmount();
    await act(async () => {
      resolveLoad(LIST);
    });
    expect(mockGetConflicts).toHaveBeenCalled();
  });
});

describe('useConflicts resolve', () => {
  it('resolves a file then refetches, flipping allResolved once every file is resolved', async () => {
    mockGetConflicts.mockResolvedValueOnce(LIST);
    const { result } = renderHook(() => useConflicts('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockResolveConflict.mockResolvedValue({ resolved: true });
    mockGetConflicts.mockResolvedValueOnce({
      operationId: 'op1',
      files: [
        { path: 'a.adoc', isBinary: false, resolved: true },
        { path: 'b.adoc', isBinary: false, resolved: false },
      ],
    });

    await act(async () => {
      await result.current.resolve('a.adoc', 'ours');
    });

    expect(mockResolveConflict).toHaveBeenCalledWith('proj1', 'a.adoc', { resolution: 'ours', mergedContent: undefined });
    expect(result.current.allResolved).toBe(false);

    mockGetConflicts.mockResolvedValueOnce({
      operationId: 'op1',
      files: [
        { path: 'a.adoc', isBinary: false, resolved: true },
        { path: 'b.adoc', isBinary: false, resolved: true },
      ],
    });

    await act(async () => {
      await result.current.resolve('b.adoc', 'theirs');
    });

    expect(result.current.allResolved).toBe(true);
  });

  it('passes mergedContent through for a merged resolution', async () => {
    mockGetConflicts.mockResolvedValue(LIST);
    const { result } = renderHook(() => useConflicts('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockResolveConflict.mockResolvedValue({ resolved: true });

    await act(async () => {
      await result.current.resolve('a.adoc', 'merged', 'final text');
    });

    expect(mockResolveConflict).toHaveBeenCalledWith('proj1', 'a.adoc', {
      resolution: 'merged',
      mergedContent: 'final text',
    });
  });
});

describe('useConflicts complete', () => {
  it('polls the queued operation to SUCCEEDED, then refetches and fires onResolvedAndCleared', async () => {
    mockGetConflicts.mockResolvedValue({ operationId: 'op1', files: [] });
    const onResolvedAndCleared = jest.fn();
    const { result } = renderHook(() => useConflicts('proj1', onResolvedAndCleared));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockCompletePull.mockResolvedValue({ operationId: 'complete-op' });
    mockGetGitOperation.mockResolvedValue({
      id: 'complete-op',
      kind: 'RESOLVE',
      state: 'SUCCEEDED',
      progress: 100,
      errorCode: null,
    });

    act(() => {
      result.current.complete();
    });
    expect(result.current.completing).toBe(true);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    await waitFor(() => expect(result.current.completing).toBe(false));
    expect(onResolvedAndCleared).toHaveBeenCalled();
  });

  it('maps a 409 unresolved_conflicts refusal to an error message', async () => {
    mockGetConflicts.mockResolvedValue({ operationId: 'op1', files: [] });
    const { result } = renderHook(() => useConflicts('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockCompletePull.mockRejectedValue(new ApiError(409, 'unresolved_conflicts', 'still unresolved'));

    await act(async () => {
      result.current.complete();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.completing).toBe(false);
    expect(result.current.message).toEqual({
      tone: 'error',
      text: 'Every conflicting file must be resolved first.',
    });
  });
});

describe('useConflicts undo', () => {
  it('polls the queued operation to SUCCEEDED, then refetches and fires onResolvedAndCleared', async () => {
    mockGetConflicts.mockResolvedValue({ operationId: 'op1', files: [] });
    const onResolvedAndCleared = jest.fn();
    const { result } = renderHook(() => useConflicts('proj1', onResolvedAndCleared));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockUndoPull.mockResolvedValue({ operationId: 'undo-op' });
    mockGetGitOperation.mockResolvedValue({
      id: 'undo-op',
      kind: 'UNDO_PULL',
      state: 'SUCCEEDED',
      progress: 100,
      errorCode: null,
    });

    act(() => {
      result.current.undo();
    });
    expect(result.current.completing).toBe(true);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    await waitFor(() => expect(result.current.completing).toBe(false));
    expect(onResolvedAndCleared).toHaveBeenCalled();
  });

  it('maps a 409 nothing_to_undo refusal to an error message', async () => {
    mockGetConflicts.mockResolvedValue({ operationId: 'op1', files: [] });
    const { result } = renderHook(() => useConflicts('proj1', jest.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockUndoPull.mockRejectedValue(new ApiError(409, 'nothing_to_undo', 'nothing to undo'));

    await act(async () => {
      result.current.undo();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.completing).toBe(false);
    expect(result.current.message).toEqual({
      tone: 'error',
      text: 'There is no paused pull to undo.',
    });
  });
});
