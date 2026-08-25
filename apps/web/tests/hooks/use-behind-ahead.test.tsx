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
