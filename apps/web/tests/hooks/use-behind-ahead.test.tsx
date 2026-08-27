import { renderHook, act, waitFor } from '@testing-library/react';
import { useBehindAhead } from '@/hooks/use-behind-ahead';
import { getBehindAhead } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { BehindAheadDto } from '@asciidocollab/shared';

jest.mock('@/lib/api/git', () => ({ getBehindAhead: jest.fn() }));

const mockGetBehindAhead = getBehindAhead as jest.MockedFunction<typeof getBehindAhead>;

const COUNTS: BehindAheadDto = { behind: 3, ahead: 1 };

describe('useBehindAhead', () => {
  beforeEach(() => mockGetBehindAhead.mockReset());

  it('loads the counts for a connected project', async () => {
    mockGetBehindAhead.mockResolvedValue(COUNTS);
    const { result } = renderHook(() => useBehindAhead('proj1'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.behindAhead).toEqual(COUNTS);
    expect(result.current.error).toBeNull();
    expect(mockGetBehindAhead).toHaveBeenCalledWith('proj1');
  });

  it('resolves to null counts (not an error) when the project has no connected git repo (404)', async () => {
    mockGetBehindAhead.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Project is not connected to a git repository'));
    const { result } = renderHook(() => useBehindAhead('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.behindAhead).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('surfaces a genuinely unexpected failure as an error', async () => {
    mockGetBehindAhead.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
    const { result } = renderHook(() => useBehindAhead('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.behindAhead).toBeNull();
    expect(result.current.error).not.toBeNull();
  });

  it('does not let a slower OLDER request that resolves last overwrite a newer value', async () => {
    let resolveA!: (value: BehindAheadDto) => void;
    let resolveB!: (value: BehindAheadDto) => void;
    const A: BehindAheadDto = { behind: 5, ahead: 2 };
    const B: BehindAheadDto = { behind: 1, ahead: 0 };

    // Load A: the initial on-mount load, left in flight.
    mockGetBehindAhead.mockReturnValueOnce(
      new Promise((resolveFunction) => {
        resolveA = resolveFunction;
      }),
    );
    const { result } = renderHook(() => useBehindAhead('proj1'));

    // Load B: a refetch started while A is still in flight — B is the LATEST-started load.
    mockGetBehindAhead.mockReturnValueOnce(
      new Promise((resolveFunction) => {
        resolveB = resolveFunction;
      }),
    );
    let refetchPromise!: Promise<void>;
    act(() => {
      refetchPromise = result.current.refetch();
    });

    // B resolves first (it's the newer load) and its value is applied.
    await act(async () => {
      resolveB(B);
      await refetchPromise;
    });
    expect(result.current.behindAhead).toEqual(B);

    // A — the OLDER request — resolves last. Its (stale) result must be dropped, not applied.
    await act(async () => {
      resolveA(A);
      await Promise.resolve();
    });
    expect(result.current.behindAhead).toEqual(B);
  });

  it('keeps the last-good counts when a poll refresh hits a transient (non-404) error', async () => {
    jest.useFakeTimers();
    try {
      // Initial load succeeds with real counts.
      mockGetBehindAhead.mockResolvedValueOnce(COUNTS);
      const { result } = renderHook(() => useBehindAhead('proj1'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.behindAhead).toEqual(COUNTS);

      // The next poll cycle hits a transient 500. The counts must NOT blank to null — the Push/Pull
      // affordance stays put rather than flickering away for the cycle.
      mockGetBehindAhead.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });

      expect(result.current.behindAhead).toEqual(COUNTS);
      expect(result.current.error).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the counts to null when a poll refresh reports the repo is no longer connected (404)', async () => {
    jest.useFakeTimers();
    try {
      mockGetBehindAhead.mockResolvedValueOnce(COUNTS);
      const { result } = renderHook(() => useBehindAhead('proj1'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.behindAhead).toEqual(COUNTS);

      // A 404 genuinely means "not connected" — that resolves to null (and no error) even mid-poll.
      mockGetBehindAhead.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'not connected'));
      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });

      expect(result.current.behindAhead).toBeNull();
      expect(result.current.error).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('surfaces loading only for the initial load, not for a background poll refresh', async () => {
    jest.useFakeTimers();
    try {
      // Initial load: the spinner shows, then settles.
      mockGetBehindAhead.mockResolvedValueOnce(COUNTS);
      const { result } = renderHook(() => useBehindAhead('proj1'));
      expect(result.current.loading).toBe(true);
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.loading).toBe(false);

      // The next poll is still in flight — `loading` must NOT flip back to true (which would flash a
      // spinner over the already-loaded counts every cycle).
      let resolvePoll!: (value: BehindAheadDto) => void;
      mockGetBehindAhead.mockReturnValueOnce(
        new Promise((resolveFunction) => {
          resolvePoll = resolveFunction;
        }),
      );
      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      expect(result.current.loading).toBe(false);
      await act(async () => {
        resolvePoll(COUNTS);
      });
      expect(result.current.loading).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a transient error visible until a later poll succeeds, then clears it', async () => {
    jest.useFakeTimers();
    try {
      mockGetBehindAhead.mockResolvedValueOnce(COUNTS);
      const { result } = renderHook(() => useBehindAhead('proj1'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.error).toBeNull();

      // A transient 500 surfaces an error that persists across cycles (not cleared-then-reset).
      mockGetBehindAhead.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });
      expect(result.current.error).not.toBeNull();

      // A later poll succeeds: the error clears and the counts are refreshed.
      mockGetBehindAhead.mockResolvedValueOnce(COUNTS);
      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });
      expect(result.current.error).toBeNull();
      expect(result.current.behindAhead).toEqual(COUNTS);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not poll (or even fetch once) for a project that is not git-connected', async () => {
    jest.useFakeTimers();
    try {
      mockGetBehindAhead.mockResolvedValue(COUNTS);
      const { result } = renderHook(() => useBehindAhead('proj1', false));
      await act(async () => {
        await Promise.resolve();
      });

      // Not connected: null counts, not loading, and — crucially — no request at all, not even a
      // first one that would 404. Advancing well past several poll intervals must not change that.
      expect(result.current.behindAhead).toBeNull();
      expect(result.current.loading).toBe(false);
      await act(async () => {
        jest.advanceTimersByTime(20_000);
        await Promise.resolve();
      });
      expect(mockGetBehindAhead).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('starts polling once a project that was not connected becomes connected', async () => {
    jest.useFakeTimers();
    try {
      mockGetBehindAhead.mockResolvedValue(COUNTS);
      const { result, rerender } = renderHook(({ enabled }) => useBehindAhead('proj1', enabled), {
        initialProps: { enabled: false },
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockGetBehindAhead).not.toHaveBeenCalled();

      // The project becomes git-connected: polling begins and the counts load.
      rerender({ enabled: true });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockGetBehindAhead).toHaveBeenCalledTimes(1);
      expect(result.current.behindAhead).toEqual(COUNTS);

      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });
      expect(mockGetBehindAhead).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('exposes a refetch callback that reloads the counts', async () => {
    mockGetBehindAhead.mockResolvedValue(COUNTS);
    const { result } = renderHook(() => useBehindAhead('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const updated: BehindAheadDto = { behind: 0, ahead: 0 };
    mockGetBehindAhead.mockResolvedValue(updated);
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.behindAhead).toEqual(updated);
    expect(mockGetBehindAhead).toHaveBeenCalledTimes(2);
  });

  it('re-fetches the counts on a fixed interval while mounted', async () => {
    jest.useFakeTimers();
    try {
      mockGetBehindAhead.mockResolvedValue(COUNTS);
      renderHook(() => useBehindAhead('proj1'));
      // Flush the initial on-mount load.
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockGetBehindAhead).toHaveBeenCalledTimes(1);

      // Each poll interval triggers exactly one further re-fetch.
      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });
      expect(mockGetBehindAhead).toHaveBeenCalledTimes(2);

      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });
      expect(mockGetBehindAhead).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops polling once unmounted (interval cleared)', async () => {
    jest.useFakeTimers();
    try {
      mockGetBehindAhead.mockResolvedValue(COUNTS);
      const { unmount } = renderHook(() => useBehindAhead('proj1'));
      await act(async () => {
        await Promise.resolve();
      });
      const callsBeforeUnmount = mockGetBehindAhead.mock.calls.length;

      unmount();
      await act(async () => {
        jest.advanceTimersByTime(12_000);
        await Promise.resolve();
      });

      expect(mockGetBehindAhead).toHaveBeenCalledTimes(callsBeforeUnmount);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a resolved load after unmount (no state update)', async () => {
    let resolve!: (value: BehindAheadDto) => void;
    mockGetBehindAhead.mockReturnValue(
      new Promise((resolveFunction) => {
        resolve = resolveFunction;
      }),
    );
    const { unmount } = renderHook(() => useBehindAhead('proj1'));
    unmount();
    await act(async () => {
      resolve(COUNTS);
    });
    expect(mockGetBehindAhead).toHaveBeenCalled();
  });
});
