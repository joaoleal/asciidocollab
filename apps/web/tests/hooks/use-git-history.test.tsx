import { renderHook, act, waitFor } from '@testing-library/react';
import { useGitHistory } from '@/hooks/use-git-history';
import { getHistory } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { CommitDto } from '@asciidocollab/shared';

jest.mock('@/lib/api/git', () => ({ getHistory: jest.fn() }));

const mockGetHistory = getHistory as jest.MockedFunction<typeof getHistory>;

const COMMITS: CommitDto[] = [
  { hash: 'abc1234567', message: 'Initial commit', authorUserId: 'user1', authoredAt: '2026-08-24T00:00:00.000Z' },
  { hash: 'def4567890', message: 'Fix typo', authoredAt: '2026-08-23T00:00:00.000Z' },
];

describe('useGitHistory', () => {
  beforeEach(() => mockGetHistory.mockReset());

  it('loads the commit history for a connected project', async () => {
    mockGetHistory.mockResolvedValue({ commits: COMMITS });
    const { result } = renderHook(() => useGitHistory('proj1'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commits).toEqual(COMMITS);
    expect(result.current.connected).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mockGetHistory).toHaveBeenCalledWith('proj1', { path: undefined, limit: undefined });
  });

  it('passes path/limit options through to the client', async () => {
    mockGetHistory.mockResolvedValue({ commits: [] });
    renderHook(() => useGitHistory('proj1', { path: 'a.adoc', limit: 10 }));
    await waitFor(() => expect(mockGetHistory).toHaveBeenCalledWith('proj1', { path: 'a.adoc', limit: 10 }));
  });

  it('resolves to not-connected (not an error) when the project has no connected git repo (404)', async () => {
    mockGetHistory.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Project is not connected to a git repository'));
    const { result } = renderHook(() => useGitHistory('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commits).toEqual([]);
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a genuinely unexpected failure as an error, not connected', async () => {
    mockGetHistory.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
    const { result } = renderHook(() => useGitHistory('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commits).toEqual([]);
    expect(result.current.connected).toBe(false);
    expect(result.current.error).not.toBeNull();
  });

  it('treats a non-ApiError failure the same as an unexpected error', async () => {
    mockGetHistory.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useGitHistory('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commits).toEqual([]);
    expect(result.current.connected).toBe(false);
    expect(result.current.error).not.toBeNull();
  });

  it('exposes a refetch callback that reloads the history', async () => {
    mockGetHistory.mockResolvedValue({ commits: COMMITS });
    const { result } = renderHook(() => useGitHistory('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const updated: CommitDto[] = [...COMMITS, { hash: 'ffffff0000', message: 'Another commit', authoredAt: '2026-08-25T00:00:00.000Z' }];
    mockGetHistory.mockResolvedValue({ commits: updated });
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.commits).toEqual(updated);
    expect(mockGetHistory).toHaveBeenCalledTimes(2);
  });

  it('does not let a slower older refetch overwrite a newer one that resolves first', async () => {
    let resolveFirst!: (value: { commits: CommitDto[] }) => void;
    let resolveSecond!: (value: { commits: CommitDto[] }) => void;
    mockGetHistory.mockResolvedValueOnce({ commits: COMMITS });
    const { result } = renderHook(() => useGitHistory('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockGetHistory.mockReturnValueOnce(
      new Promise((resolveFunction) => {
        resolveFirst = resolveFunction;
      }),
    );
    mockGetHistory.mockReturnValueOnce(
      new Promise((resolveFunction) => {
        resolveSecond = resolveFunction;
      }),
    );

    let firstRefetch!: Promise<void>;
    let secondRefetch!: Promise<void>;
    act(() => {
      firstRefetch = result.current.refetch();
      secondRefetch = result.current.refetch();
    });

    const newerCommits: CommitDto[] = [{ hash: 'newer000001', message: 'Newer commit', authoredAt: '2026-08-26T00:00:00.000Z' }];
    const olderCommits: CommitDto[] = [{ hash: 'older000001', message: 'Stale commit', authoredAt: '2026-08-22T00:00:00.000Z' }];

    // The newer (second) request resolves before the older (first) one.
    await act(async () => {
      resolveSecond({ commits: newerCommits });
      await secondRefetch;
    });
    expect(result.current.commits).toEqual(newerCommits);

    // The older, slower request resolving afterward must not overwrite the newer result.
    await act(async () => {
      resolveFirst({ commits: olderCommits });
      await firstRefetch;
    });
    expect(result.current.commits).toEqual(newerCommits);
  });

  it('ignores a resolved load after unmount (no state update)', async () => {
    let resolve!: (value: { commits: CommitDto[] }) => void;
    mockGetHistory.mockReturnValue(
      new Promise((resolveFunction) => {
        resolve = resolveFunction;
      }),
    );
    const { unmount } = renderHook(() => useGitHistory('proj1'));
    unmount();
    await act(async () => {
      resolve({ commits: COMMITS });
    });
    expect(mockGetHistory).toHaveBeenCalled();
  });
});
