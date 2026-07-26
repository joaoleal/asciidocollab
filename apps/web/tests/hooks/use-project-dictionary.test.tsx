import { renderHook, act, waitFor } from '@testing-library/react';
import { useProjectDictionary } from '@/hooks/use-project-dictionary';
import { grammarApi } from '@/lib/api/grammar';
import { ApiError } from '@/lib/api/transport';

jest.mock('@/lib/api/grammar', () => ({
  grammarApi: {
    listDictionary: jest.fn(),
    addDictionaryTerm: jest.fn(),
    removeDictionaryTerm: jest.fn(),
  },
}));

const mockedApi = grammarApi as jest.Mocked<typeof grammarApi>;

describe('useProjectDictionary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedApi.listDictionary.mockResolvedValue({ data: { terms: [{ id: 'k1', term: 'Kubernetes', createdByUserId: 'u', createdAt: '2026-07-25T00:00:00.000Z' }] } });
  });

  it('loads the project terms on mount', async () => {
    const { result } = renderHook(() => useProjectDictionary('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.terms).toEqual(['Kubernetes']);
    expect(mockedApi.listDictionary).toHaveBeenCalledWith('p1');
  });

  it('optimistically appends an added term (no duplicate on a case-insensitive match)', async () => {
    mockedApi.addDictionaryTerm.mockResolvedValue({
      data: { id: 't1', term: 'API', createdByUserId: 'u', createdAt: '2026-07-25T00:00:00.000Z' },
    });
    const { result } = renderHook(() => useProjectDictionary('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addTerm('API');
    });
    expect(result.current.terms).toEqual(['Kubernetes', 'API']);

    // Re-adding a case variant does not duplicate.
    mockedApi.addDictionaryTerm.mockResolvedValue({
      data: { id: 't1', term: 'API', createdByUserId: 'u', createdAt: '2026-07-25T00:00:00.000Z' },
    });
    await act(async () => {
      await result.current.addTerm('api');
    });
    expect(result.current.terms.filter((t) => t.toLowerCase() === 'api')).toHaveLength(1);
  });

  it('refetches after removing a term', async () => {
    mockedApi.removeDictionaryTerm.mockResolvedValue();
    mockedApi.listDictionary
      .mockResolvedValueOnce({ data: { terms: [{ id: 'k1', term: 'Kubernetes', createdByUserId: 'u', createdAt: '2026-07-25T00:00:00.000Z' }] } })
      .mockResolvedValueOnce({ data: { terms: [] } });
    const { result } = renderHook(() => useProjectDictionary('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.removeTerm('t1');
    });
    expect(mockedApi.removeDictionaryTerm).toHaveBeenCalledWith('p1', 't1');
    expect(result.current.terms).toEqual([]);
  });

  it('reports a failed load with the server’s message', async () => {
    mockedApi.listDictionary.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'Dictionary unavailable'));
    const { result } = renderHook(() => useProjectDictionary('p1'));
    await waitFor(() => expect(result.current.error).toBe('Dictionary unavailable'));
  });

  it('falls back to a readable load message for a non-API failure', async () => {
    mockedApi.listDictionary.mockRejectedValue(new TypeError('offline'));
    const { result } = renderHook(() => useProjectDictionary('p1'));
    await waitFor(() => expect(result.current.error).toBe('Failed to load the project dictionary.'));
  });

  it('reports a rejected add and says the term was not stored', async () => {
    mockedApi.addDictionaryTerm.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Editors only'));
    const { result } = renderHook(() => useProjectDictionary('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let added: boolean | undefined;
    await act(async () => {
      added = await result.current.addTerm('GraphQL');
    });
    expect(added).toBe(false);
    expect(result.current.error).toBe('Editors only');
    expect(result.current.terms).toEqual(['Kubernetes']);
  });

  it('falls back to a readable add message for a non-API failure', async () => {
    mockedApi.addDictionaryTerm.mockRejectedValue(new TypeError('offline'));
    const { result } = renderHook(() => useProjectDictionary('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.addTerm('GraphQL');
    });
    expect(result.current.error).toBe('Failed to add the term.');
  });

  it('removes a term and re-reads the list', async () => {
    mockedApi.removeDictionaryTerm.mockResolvedValue();
    const { result } = renderHook(() => useProjectDictionary('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let removed: boolean | undefined;
    await act(async () => {
      removed = await result.current.removeTerm('k1');
    });
    expect(removed).toBe(true);
    expect(mockedApi.removeDictionaryTerm).toHaveBeenCalledWith('p1', 'k1');
    expect(mockedApi.listDictionary).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected remove', async () => {
    mockedApi.removeDictionaryTerm.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Editors only'));
    const { result } = renderHook(() => useProjectDictionary('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let removed: boolean | undefined;
    await act(async () => {
      removed = await result.current.removeTerm('k1');
    });
    expect(removed).toBe(false);
    expect(result.current.error).toBe('Editors only');
  });

  it('falls back to a readable remove message for a non-API failure', async () => {
    mockedApi.removeDictionaryTerm.mockRejectedValue(new TypeError('offline'));
    const { result } = renderHook(() => useProjectDictionary('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.removeTerm('k1');
    });
    expect(result.current.error).toBe('Failed to remove the term.');
  });

  it('reads nothing when there is no project', async () => {
    const { result } = renderHook(() => useProjectDictionary(''));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockedApi.listDictionary).not.toHaveBeenCalled();
    expect(result.current.terms).toEqual([]);
  });

});
