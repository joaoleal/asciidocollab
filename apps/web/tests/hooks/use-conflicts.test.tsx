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

  it('ignores an older list load resolving after a newer one', async () => {
    let resolveFirst!: (value: ConflictListDto) => void;
    let resolveSecond!: (value: ConflictListDto) => void;
    mockGetConflicts
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const { result } = renderHook(() => useConflicts('proj1', jest.fn()));
    expect(result.current.loading).toBe(true);

    // Start a second (newer) load before the mount's (older) load has resolved.
    let refetchPromise!: Promise<void>;
    act(() => {
      refetchPromise = result.current.refetch();
    });

    const NEWER: ConflictListDto = {
      operationId: 'op2',
      files: [{ path: 'c.adoc', isBinary: false, resolved: false }],
    };

    // The newer load resolves first.
    await act(async () => {
      resolveSecond(NEWER);
      await refetchPromise;
    });
    expect(result.current.operationId).toBe('op2');
    expect(result.current.files).toEqual(NEWER.files);

    // The older (mount) load resolves last, with stale data — it must not overwrite the newer state.
    await act(async () => {
      resolveFirst(LIST);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.operationId).toBe('op2');
    expect(result.current.files).toEqual(NEWER.files);
    expect(result.current.loading).toBe(false);
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
      driftSummary: null,
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

  it('SUCCEEDED with a dropped-change drift summary shows a neutral recovery message', async () => {
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
      driftSummary: {
        total: 1,
        droppedCount: 1,
        anomalies: [{ path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false }],
      },
    });

    act(() => {
      result.current.complete();
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    await waitFor(() => expect(result.current.completing).toBe(false));
    expect(onResolvedAndCleared).toHaveBeenCalled();
    expect(result.current.message?.tone).toBe('neutral');
    expect(result.current.message?.text).toContain('Conflicts resolved');
    expect(result.current.message?.text).toContain('docs');
    expect(result.current.message?.text).toContain('Remove or rename the folder');
    expect(result.current.message?.text).toContain('try the operation again');
    expect(result.current.message?.text).not.toContain('pull again');
  });

  it('SUCCEEDED with no drift summary sets no message', async () => {
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
      driftSummary: null,
    });

    act(() => {
      result.current.complete();
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    await waitFor(() => expect(result.current.completing).toBe(false));
    expect(onResolvedAndCleared).toHaveBeenCalled();
    expect(result.current.message).toBeNull();
  });

  it('an older poll tick resolving after a newer tick does not incorrectly settle complete()', async () => {
    mockGetConflicts.mockResolvedValue({ operationId: 'op1', files: [] });
    const onResolvedAndCleared = jest.fn();
    const { result } = renderHook(() => useConflicts('proj1', onResolvedAndCleared));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockCompletePull.mockResolvedValue({ operationId: 'complete-op' });
    let resolveTick1!: (value: Awaited<ReturnType<typeof getGitOperation>>) => void;
    let resolveTick2!: (value: Awaited<ReturnType<typeof getGitOperation>>) => void;
    mockGetGitOperation
      .mockImplementationOnce(() => new Promise((resolve) => { resolveTick1 = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveTick2 = resolve; }));

    act(() => {
      result.current.complete();
    });
    expect(result.current.completing).toBe(true);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    // A second (newer) tick starts before the first (older) tick has resolved.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1500);
    });
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(2));

    // The newer tick resolves first, with a still-running status.
    await act(async () => {
      resolveTick2({
        id: 'complete-op',
        kind: 'RESOLVE',
        state: 'RUNNING',
        progress: 10,
        errorCode: null,
        driftSummary: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.completing).toBe(true);

    // The older tick resolves last, with a stale SUCCEEDED status — since a newer tick has already
    // been observed as still running, this must be ignored rather than incorrectly settling complete().
    await act(async () => {
      resolveTick1({
        id: 'complete-op',
        kind: 'RESOLVE',
        state: 'SUCCEEDED',
        progress: 100,
        errorCode: null,
        driftSummary: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.completing).toBe(true);
    expect(onResolvedAndCleared).not.toHaveBeenCalled();
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
      driftSummary: null,
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
