import { renderHook, act, waitFor } from '@testing-library/react';
import { useGitTreeStatus } from '@/hooks/use-git-tree-status';
import { getGitTreeStatus } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';

jest.mock('@/lib/api/git', () => ({ getGitTreeStatus: jest.fn() }));

const mockGetGitTreeStatus = getGitTreeStatus as jest.MockedFunction<typeof getGitTreeStatus>;

describe('useGitTreeStatus', () => {
  beforeEach(() => mockGetGitTreeStatus.mockReset());

  it('loads the status map for the project', async () => {
    mockGetGitTreeStatus.mockResolvedValue({
      statusByFileNodeId: { 'file-1': 'modified', 'file-2': 'staged' },
    });
    const { result } = renderHook(() => useGitTreeStatus('proj1'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.statusByFileNodeId).toEqual({ 'file-1': 'modified', 'file-2': 'staged' });
    expect(result.current.error).toBeNull();
    expect(mockGetGitTreeStatus).toHaveBeenCalledWith('proj1');
  });

  it('resolves to an empty map (not an error) when the project has no connected git repo (404)', async () => {
    mockGetGitTreeStatus.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Project is not connected to a git repository'));
    const { result } = renderHook(() => useGitTreeStatus('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.statusByFileNodeId).toEqual({});
    expect(result.current.error).toBeNull();
  });

  it('surfaces a genuinely unexpected failure as an error, with an empty map', async () => {
    mockGetGitTreeStatus.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
    const { result } = renderHook(() => useGitTreeStatus('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.statusByFileNodeId).toEqual({});
    expect(result.current.error).not.toBeNull();
  });

  it('treats a non-ApiError failure the same as an unexpected error', async () => {
    mockGetGitTreeStatus.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useGitTreeStatus('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.statusByFileNodeId).toEqual({});
    expect(result.current.error).not.toBeNull();
  });

  it('exposes a refetch callback that reloads the status map', async () => {
    mockGetGitTreeStatus.mockResolvedValue({ statusByFileNodeId: { 'file-1': 'modified' } });
    const { result } = renderHook(() => useGitTreeStatus('proj1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockGetGitTreeStatus.mockResolvedValue({ statusByFileNodeId: { 'file-1': 'staged' } });
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.statusByFileNodeId).toEqual({ 'file-1': 'staged' });
    expect(mockGetGitTreeStatus).toHaveBeenCalledTimes(2);
  });

  it('ignores a resolved load after unmount (no state update)', async () => {
    let resolve!: (value: { statusByFileNodeId: Record<string, never> }) => void;
    mockGetGitTreeStatus.mockReturnValue(
      new Promise((resolveFunction) => {
        resolve = resolveFunction;
      }),
    );
    const { unmount } = renderHook(() => useGitTreeStatus('proj1'));
    unmount();
    await act(async () => {
      resolve({ statusByFileNodeId: {} });
    });
    expect(mockGetGitTreeStatus).toHaveBeenCalled();
  });
});
