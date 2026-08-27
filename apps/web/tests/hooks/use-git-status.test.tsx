import { renderHook, act, waitFor } from '@testing-library/react';
import { useGitStatus } from '@/hooks/use-git-status';
import { getGitStatus } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { GitStatusDto } from '@asciidocollab/shared';

jest.mock('@/lib/api/git', () => ({ getGitStatus: jest.fn() }));

const mockGetGitStatus = getGitStatus as jest.MockedFunction<typeof getGitStatus>;

const STATUS: GitStatusDto = {
  branch: 'main',
  syncStatus: 'UP_TO_DATE',
  ahead: 0,
  behind: 0,
  lastSyncAt: '2026-08-24T00:00:00.000Z',
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
};

describe('useGitStatus', () => {
  beforeEach(() => mockGetGitStatus.mockReset());

  it('loads the status for a connected project', async () => {
    mockGetGitStatus.mockResolvedValue(STATUS);
    const { result } = renderHook(() => useGitStatus('proj1'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toEqual(STATUS);
    expect(result.current.connected).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mockGetGitStatus).toHaveBeenCalledWith('proj1');
  });

  it('resolves to not-connected (not an error) when the project has no connected git repo (404)', async () => {
    mockGetGitStatus.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Project is not connected to a git repository'));
    const { result } = renderHook(() => useGitStatus('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a genuinely unexpected failure as an error, not connected', async () => {
    mockGetGitStatus.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
    const { result } = renderHook(() => useGitStatus('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(result.current.error).not.toBeNull();
  });

  it('treats a non-ApiError failure the same as an unexpected error', async () => {
    mockGetGitStatus.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useGitStatus('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(result.current.error).not.toBeNull();
  });

  it('does not let a slower OLDER request that resolves last overwrite a newer value', async () => {
    let resolveA!: (value: GitStatusDto) => void;
    let resolveB!: (value: GitStatusDto) => void;
    const B: GitStatusDto = { ...STATUS, syncStatus: 'AHEAD' };

    // Load A: the initial on-mount load, left in flight.
    mockGetGitStatus.mockReturnValueOnce(
      new Promise((resolveFunction) => {
        resolveA = resolveFunction;
      }),
    );
    const { result } = renderHook(() => useGitStatus('proj1'));

    // Load B: a refetch started while A is still in flight — B is the LATEST-started load.
    mockGetGitStatus.mockReturnValueOnce(
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
    expect(result.current.status).toEqual(B);
    expect(result.current.connected).toBe(true);

    // A — the OLDER request — resolves last. Its (stale) result must be dropped, not applied.
    await act(async () => {
      resolveA(STATUS);
      await Promise.resolve();
    });
    expect(result.current.status).toEqual(B);
  });

  it('recovers from a transient (non-404) failure via a scheduled retry, without a page reload', async () => {
    jest.useFakeTimers();
    try {
      mockGetGitStatus.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
      const { result } = renderHook(() => useGitStatus('proj1'));
      await act(async () => {
        await Promise.resolve();
      });
      // The bar is not permanently disabled by a transient failure: an error is surfaced but a
      // retry is already scheduled, so this recovers on its own.
      expect(result.current.connected).toBe(false);
      expect(result.current.error).not.toBeNull();
      expect(result.current.loading).toBe(false);

      mockGetGitStatus.mockResolvedValueOnce(STATUS);
      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });

      expect(result.current.connected).toBe(true);
      expect(result.current.status).toEqual(STATUS);
      expect(result.current.error).toBeNull();
      expect(mockGetGitStatus).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a previously-connected status during a transient failure (no flip to not-connected)', async () => {
    jest.useFakeTimers();
    try {
      mockGetGitStatus.mockResolvedValueOnce(STATUS);
      const { result } = renderHook(() => useGitStatus('proj1'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.connected).toBe(true);

      mockGetGitStatus.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
      await act(async () => {
        await result.current.refetch();
      });
      expect(result.current.connected).toBe(true);
      expect(result.current.status).toEqual(STATUS);
      expect(result.current.error).not.toBeNull();

      mockGetGitStatus.mockResolvedValueOnce(STATUS);
      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });
      expect(result.current.connected).toBe(true);
      expect(result.current.error).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not re-flash loading or clear the error on a retry during a sustained transient failure', async () => {
    jest.useFakeTimers();
    try {
      mockGetGitStatus.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
      const { result } = renderHook(() => useGitStatus('proj1'));
      // The very first load still shows the spinner.
      expect(result.current.loading).toBe(true);
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.error).not.toBeNull();
      const firstError = result.current.error;

      // The retry's request is left pending so the loading/error state DURING the retry (not just
      // after it settles) is observable — a re-flash would show up right here.
      let resolveRetry!: (value: GitStatusDto) => void;
      mockGetGitStatus.mockReturnValueOnce(
        new Promise((resolveFunction) => {
          resolveRetry = resolveFunction;
        }),
      );
      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe(firstError);
      expect(mockGetGitStatus).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveRetry(STATUS);
        await Promise.resolve();
      });
      expect(result.current.connected).toBe(true);
      expect(result.current.error).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('exposes a refetch callback that reloads the status', async () => {
    mockGetGitStatus.mockResolvedValue(STATUS);
    const { result } = renderHook(() => useGitStatus('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const updated: GitStatusDto = { ...STATUS, syncStatus: 'AHEAD' };
    mockGetGitStatus.mockResolvedValue(updated);
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.status).toEqual(updated);
    expect(mockGetGitStatus).toHaveBeenCalledTimes(2);
  });

  it('ignores a resolved load after unmount (no state update)', async () => {
    let resolve!: (value: GitStatusDto) => void;
    mockGetGitStatus.mockReturnValue(
      new Promise((resolveFunction) => {
        resolve = resolveFunction;
      }),
    );
    const { unmount } = renderHook(() => useGitStatus('proj1'));
    unmount();
    await act(async () => {
      resolve(STATUS);
    });
    expect(mockGetGitStatus).toHaveBeenCalled();
  });

  it('ignores a refetch that settles AFTER unmount (no state update on an unmounted component)', async () => {
    // The initial on-mount load resolves normally.
    mockGetGitStatus.mockResolvedValueOnce(STATUS);
    const { result, unmount } = renderHook(() => useGitStatus('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Start a refetch, leave it in flight, then unmount before it settles.
    let resolveRefetch!: (value: GitStatusDto) => void;
    mockGetGitStatus.mockReturnValueOnce(
      new Promise((resolveFunction) => {
        resolveRefetch = resolveFunction;
      }),
    );
    let refetchPromise!: Promise<void>;
    act(() => {
      refetchPromise = result.current.refetch();
    });
    unmount();

    // The refetch settling after unmount must not call setState — React would emit an act()
    // warning if it did. Fail the test on any console.error (that warning included).
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => {
        resolveRefetch({ ...STATUS, syncStatus: 'AHEAD' });
        await refetchPromise;
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not fire a refetch retry after unmount (transient failure while unmounted)', async () => {
    jest.useFakeTimers();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockGetGitStatus.mockResolvedValueOnce(STATUS);
      const { result, unmount } = renderHook(() => useGitStatus('proj1'));
      await act(async () => {
        await Promise.resolve();
      });

      // A refetch fails transiently, which would normally schedule a retry.
      mockGetGitStatus.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
      await act(async () => {
        await result.current.refetch();
      });
      unmount();

      // The unmount cleanup cancels the pending retry; advancing time must not re-invoke the load
      // or touch state on the unmounted component.
      const callsAfterRefetch = mockGetGitStatus.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
      });
      expect(mockGetGitStatus).toHaveBeenCalledTimes(callsAfterRefetch);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
