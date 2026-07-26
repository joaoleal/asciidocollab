import { renderHook, act, waitFor } from '@testing-library/react';
import { useIgnoredLints } from '@/hooks/use-ignored-lints';
import { grammarApi } from '@/lib/api/grammar';
import { ApiError } from '@/lib/api/transport';

jest.mock('@/lib/api/grammar', () => ({
  grammarApi: {
    getIgnoredLints: jest.fn(),
    putIgnoredLints: jest.fn(),
  },
}));

const mockedApi = grammarApi as jest.Mocked<typeof grammarApi>;

describe('useIgnoredLints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedApi.getIgnoredLints.mockResolvedValue({ data: { ignoredLintsJson: '["hash-a"]' } });
    mockedApi.putIgnoredLints.mockResolvedValue();
  });

  it('loads the caller’s blob for the open document', async () => {
    const { result } = renderHook(() => useIgnoredLints('doc1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.blob).toBe('["hash-a"]');
    expect(mockedApi.getIgnoredLints).toHaveBeenCalledWith('doc1');
  });

  it('does not fetch when no document is open', async () => {
    const { result } = renderHook(() => useIgnoredLints(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.blob).toBe('');
    expect(mockedApi.getIgnoredLints).not.toHaveBeenCalled();
  });

  it('persists a new blob on save', async () => {
    const { result } = renderHook(() => useIgnoredLints('doc1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.save('["hash-a","hash-b"]');
    });
    expect(mockedApi.putIgnoredLints).toHaveBeenCalledWith('doc1', '["hash-a","hash-b"]');
    expect(result.current.blob).toBe('["hash-a","hash-b"]');
  });

  it('reports a failed load without pretending the caller has ignored nothing', async () => {
    // An empty blob is indistinguishable from "no ignores", so a failed GET must be visible: otherwise
    // the next save would replace the stored record with an empty one and wipe every ignore.
    mockedApi.getIgnoredLints.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'Upstream exploded'));
    const { result } = renderHook(() => useIgnoredLints('doc1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Upstream exploded');
  });

  it('falls back to a readable message when the load failure is not an API error', async () => {
    mockedApi.getIgnoredLints.mockRejectedValue(new TypeError('offline'));
    const { result } = renderHook(() => useIgnoredLints('doc1'));
    await waitFor(() => expect(result.current.error).toBe('Failed to load ignored issues.'));
  });

  it('reports a failed save and keeps the previously loaded blob', async () => {
    mockedApi.putIgnoredLints.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Not your document'));
    const { result } = renderHook(() => useIgnoredLints('doc1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.save('["hash-b"]');
    });
    expect(saved).toBe(false);
    expect(result.current.error).toBe('Not your document');
    expect(result.current.blob).toBe('["hash-a"]');
  });

  it('falls back to a readable message when the save failure is not an API error', async () => {
    mockedApi.putIgnoredLints.mockRejectedValue(new TypeError('offline'));
    const { result } = renderHook(() => useIgnoredLints('doc1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.save('["hash-b"]');
    });
    expect(result.current.error).toBe('Failed to save ignored issues.');
  });

  it('refuses to save when no document is open', async () => {
    const { result } = renderHook(() => useIgnoredLints(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.save('["hash-b"]');
    });
    expect(saved).toBe(false);
    expect(mockedApi.putIgnoredLints).not.toHaveBeenCalled();
  });

  it('clears a stale blob when the document is closed', async () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useIgnoredLints(id), {
      initialProps: { id: 'doc1' as string | null },
    });
    await waitFor(() => expect(result.current.blob).toBe('["hash-a"]'));
    rerender({ id: null });
    await waitFor(() => expect(result.current.blob).toBe(''));
  });

  it('reports success when the write lands', async () => {
    const { result } = renderHook(() => useIgnoredLints('doc1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.save('["hash-b"]');
    });
    expect(saved).toBe(true);
    expect(result.current.error).toBeNull();
  });

});
