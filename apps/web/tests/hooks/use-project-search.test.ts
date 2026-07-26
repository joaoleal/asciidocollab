/* @jest-environment jsdom */
import { renderHook, act, waitFor } from '@testing-library/react';
import { useProjectSearch } from '@/hooks/use-project-search';

const searchProjectContent = jest.fn();
const replaceProjectContent = jest.fn();

jest.mock('@/lib/api/project-search', () => ({
  searchProjectContent: (...arguments_: unknown[]) => searchProjectContent(...arguments_),
  replaceProjectContent: (...arguments_: unknown[]) => replaceProjectContent(...arguments_),
  ProjectSearchApiError: class extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message);
    }
  },
}));

const emptyResult = { groups: [], totalMatches: 0, returnedMatches: 0, capped: false, skippedFiles: 0 };

describe('useProjectSearch', () => {
  beforeEach(() => {
    searchProjectContent.mockReset();
    replaceProjectContent.mockReset();
    replaceProjectContent.mockResolvedValue({ filesChanged: 1, replacements: 1 });
  });

  it('is idle with an empty query and never calls the API', async () => {
    const { result } = renderHook(() => useProjectSearch('p1'));
    expect(result.current.status).toBe('idle');
    await act(async () => { await Promise.resolve(); });
    expect(searchProjectContent).not.toHaveBeenCalled();
  });

  it('clears match exclusions when the query changes (stale ordinals must not carry over)', async () => {
    searchProjectContent.mockResolvedValue(emptyResult);
    const { result } = renderHook(() => useProjectSearch('p1'));
    act(() => result.current.setQuery({ query: 'foo' }));
    act(() => result.current.toggleExcluded('file-1', 3));
    expect(result.current.isExcluded('file-1', 3)).toBe(true);

    act(() => result.current.setQuery({ query: 'bar' }));
    // The new query renumbers matches, so file-1:3 must no longer be excluded.
    await waitFor(() => expect(result.current.isExcluded('file-1', 3)).toBe(false));
  });

  it('runs a debounced search and passes an abort signal', async () => {
    searchProjectContent.mockResolvedValue(emptyResult);
    const { result } = renderHook(() => useProjectSearch('p1'));
    act(() => result.current.setQuery({ query: 'foo' }));

    await waitFor(() => expect(searchProjectContent).toHaveBeenCalled());
    const [projectId, dto, signal] = searchProjectContent.mock.calls[0];
    expect(projectId).toBe('p1');
    expect(dto).toMatchObject({ query: 'foo', mode: 'literal' });
    expect(signal).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(result.current.status).toBe('success'));
  });

  it('coalesces rapid edits, firing a single request for the latest query', async () => {
    searchProjectContent.mockResolvedValue(emptyResult);
    const { result } = renderHook(() => useProjectSearch('p1'));
    act(() => result.current.setQuery({ query: 'a' }));
    act(() => result.current.setQuery({ query: 'ab' }));
    act(() => result.current.setQuery({ query: 'abc' }));

    await waitFor(() => expect(searchProjectContent).toHaveBeenCalledTimes(1));
    expect(searchProjectContent.mock.calls[0][1]).toMatchObject({ query: 'abc' });
  });
});

/** Two files, two matches each, so scope and exclusion can be told apart. */
const twoFileResult = {
  groups: [
    {
      fileNodeId: 'file-1',
      path: '/a.adoc',
      matches: [
        { ordinal: 0, line: 1, matchText: 'foo', lineText: 'foo one' },
        { ordinal: 1, line: 2, matchText: 'foo', lineText: 'foo two' },
      ],
    },
    {
      fileNodeId: 'file-2',
      path: '/b.adoc',
      matches: [{ ordinal: 0, line: 5, matchText: 'foo', lineText: 'foo three' }],
    },
  ],
  totalMatches: 3,
  returnedMatches: 3,
  capped: false,
  skippedFiles: 0,
};

/** Drive the hook to a loaded result set for 'foo'. */
async function loaded() {
  searchProjectContent.mockResolvedValue(twoFileResult);
  const rendered = renderHook(() => useProjectSearch('p1'));
  act(() => rendered.result.current.setQuery({ query: 'foo' }));
  await waitFor(() => expect(rendered.result.current.status).toBe('success'));
  return rendered;
}

describe('useProjectSearch — replace', () => {
  beforeEach(() => {
    searchProjectContent.mockReset();
    replaceProjectContent.mockReset();
    replaceProjectContent.mockResolvedValue({ filesChanged: 1, replacements: 1 });
  });

  it('counts every match as included until one is excluded', async () => {
    const { result } = await loaded();
    expect(result.current.includedMatchCount).toBe(3);
    act(() => result.current.toggleExcluded('file-1', 1));
    expect(result.current.includedMatchCount).toBe(2);
    // Toggling the same match again puts it back.
    act(() => result.current.toggleExcluded('file-1', 1));
    expect(result.current.includedMatchCount).toBe(3);
  });

  it('a project-scope replace sends every included match, and only those', async () => {
    const { result } = await loaded();
    act(() => result.current.toggleExcluded('file-1', 1));
    await act(async () => {
      await result.current.replace({ scope: 'project' });
    });
    const [, request] = replaceProjectContent.mock.calls[0]!;
    expect(request.scope).toBe('project');
    expect(request.files).toEqual([
      { fileNodeId: 'file-1', selections: [{ ordinal: 0, expectedText: 'foo' }] },
      { fileNodeId: 'file-2', selections: [{ ordinal: 0, expectedText: 'foo' }] },
    ]);
  });

  it('a file-scope replace touches only that file', async () => {
    const { result } = await loaded();
    await act(async () => {
      await result.current.replace({ scope: 'file', fileNodeId: 'file-2' });
    });
    expect(replaceProjectContent.mock.calls[0]![1].files).toEqual([
      { fileNodeId: 'file-2', selections: [{ ordinal: 0, expectedText: 'foo' }] },
    ]);
  });

  it('a single-match replace sends exactly that ordinal, ignoring exclusions', async () => {
    const { result } = await loaded();
    // Excluded from a bulk replace, but replacing THIS match is an explicit instruction about it.
    act(() => result.current.toggleExcluded('file-1', 1));
    await act(async () => {
      await result.current.replace({ scope: 'match', fileNodeId: 'file-1', ordinal: 1 });
    });
    expect(replaceProjectContent.mock.calls[0]![1].files).toEqual([
      { fileNodeId: 'file-1', selections: [{ ordinal: 1, expectedText: 'foo' }] },
    ]);
  });

  it('sends nothing when every match has been excluded', async () => {
    const { result } = await loaded();
    act(() => {
      result.current.toggleExcluded('file-1', 0);
      result.current.toggleExcluded('file-1', 1);
      result.current.toggleExcluded('file-2', 0);
    });
    await act(async () => {
      await result.current.replace({ scope: 'project' });
    });
    expect(replaceProjectContent).not.toHaveBeenCalled();
  });

  it('does nothing before a search has produced a result', async () => {
    const { result } = renderHook(() => useProjectSearch('p1'));
    await act(async () => {
      await result.current.replace({ scope: 'project' });
    });
    expect(replaceProjectContent).not.toHaveBeenCalled();
  });

  it('re-searches after a successful replace and drops stale exclusions', async () => {
    const { result } = await loaded();
    act(() => result.current.toggleExcluded('file-1', 1));
    await act(async () => {
      await result.current.replace({ scope: 'project' });
    });
    await waitFor(() => expect(searchProjectContent).toHaveBeenCalledTimes(2));
    expect(result.current.isExcluded('file-1', 1)).toBe(false);
    expect(result.current.replaceStatus).toBe('idle');
  });

  it('surfaces a rejected replacement template with the server’s code', async () => {
    const { ProjectSearchApiError } = jest.requireMock('@/lib/api/project-search') as {
      ProjectSearchApiError: new (status: number, code: string, message: string) => Error;
    };
    replaceProjectContent.mockRejectedValue(
      new ProjectSearchApiError(400, 'INVALID_REPLACEMENT', 'Unknown capture group $9'),
    );
    const { result } = await loaded();
    await act(async () => {
      await result.current.replace({ scope: 'project' });
    });
    expect(result.current.replaceStatus).toBe('error');
    expect(result.current.replaceError).toEqual({
      code: 'INVALID_REPLACEMENT',
      message: 'Unknown capture group $9',
    });
  });

  it('falls back to a generic replace error for a non-API failure', async () => {
    replaceProjectContent.mockRejectedValue(new TypeError('offline'));
    const { result } = await loaded();
    await act(async () => {
      await result.current.replace({ scope: 'project' });
    });
    expect(result.current.replaceError).toEqual({ code: 'REPLACE_ERROR', message: 'offline' });
  });

  it('falls back to a message even when the failure is not an Error at all', async () => {
    replaceProjectContent.mockRejectedValue('exploded');
    const { result } = await loaded();
    await act(async () => {
      await result.current.replace({ scope: 'project' });
    });
    expect(result.current.replaceError).toEqual({ code: 'REPLACE_ERROR', message: 'Replace failed' });
  });
});
