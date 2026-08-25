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
});
