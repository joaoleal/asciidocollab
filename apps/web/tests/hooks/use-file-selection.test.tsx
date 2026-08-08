import { renderHook, act } from '@testing-library/react';
import { useFileSelection } from '@/hooks/use-file-selection';
import { getCollabDocumentInfo } from '@/lib/api/collab';

jest.mock('@/lib/api/collab', () => ({ getCollabDocumentInfo: jest.fn() }));
const mockGetCollabInfo = getCollabDocumentInfo as jest.Mock;

const API_BASE = 'http://localhost:4000';

// Most tests exercise the legacy REST path: no collaborative document (the
// collab discovery returns null), so the GET /content fetch runs as before.
beforeEach(() => {
  mockGetCollabInfo.mockReset();
  mockGetCollabInfo.mockResolvedValue(null);
});

function makeFetchResponse(body: string, contentType: string, ok = true): Response {
  return {
    ok,
    headers: new Headers({ 'Content-Type': contentType }),
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

describe('useFileSelection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // (a): selectFile triggers fetch to correct URL
  it('selectFile fetches content from correct URL', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeFetchResponse('hello', 'text/plain'),
    );
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/projects/p1/files/n1/content`,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  // isLoading transitions to true while fetching
  it('contentState.isLoading is true while fetch is in-flight', async () => {
    let resolveFetch!: (value: Response) => void;
    globalThis.fetch = jest.fn().mockImplementation(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));

    const { result } = renderHook(() => useFileSelection('p1'));

    act(() => { result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file'); });

    // isLoading is set synchronously before the collab check + content fetch.
    expect(result.current.contentState.isLoading).toBe(true);
    expect(result.current.contentState.isBinary).toBe(false);
    expect(result.current.contentState.error).toBeNull();

    // Let the collab discovery resolve (null → legacy) so the content fetch starts.
    await act(async () => { await Promise.resolve(); });
    expect(result.current.contentState.isLoading).toBe(true);

    // Cleanup by resolving the content fetch.
    await act(async () => {
      resolveFetch(makeFetchResponse('content', 'text/plain'));
      await Promise.resolve();
    });
  });

  // (b): text/plain response sets content and isLoading=false
  it('text/plain response sets contentState.content and isLoading=false', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse('Hello World', 'text/plain'),
    );

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });

    expect(result.current.contentState.content).toBe('Hello World');
    expect(result.current.contentState.isLoading).toBe(false);
    expect(result.current.contentState.error).toBeNull();
    expect(result.current.contentState.isBinary).toBe(false);
  });

  // (c): image/png response sets isBinary=true, content=null
  it('image/png response sets isBinary=true and content=null', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse('', 'image/png'),
    );

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('n1', 'image.png', '/image.png', 'file');
    });

    expect(result.current.contentState.isBinary).toBe(true);
    expect(result.current.contentState.content).toBeNull();
    expect(result.current.contentState.isLoading).toBe(false);
  });

  // Guard B: a TEXT file with no collaborative document (GET /collab 404) must be flagged
  // collabUnavailable so the editor opens read-only instead of the clobbering legacy autosave path.
  it('text file with no collab document sets collabUnavailable=true (read-only, never legacy edit)', async () => {
    mockGetCollabInfo.mockResolvedValue(null); // 404 → no collaborative document
    globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse('= Title\n\nbody', 'text/asciidoc'));

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });

    expect(result.current.contentState.collabUnavailable).toBe(true);
    expect(result.current.contentState.content).toBe('= Title\n\nbody');
    expect(result.current.contentState.isBinary).toBe(false);
  });

  // Guard B: binary assets are legitimately non-collaborative; they must NOT be flagged.
  it('binary asset with no collab document does NOT set collabUnavailable', async () => {
    mockGetCollabInfo.mockResolvedValue(null);
    globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse('', 'image/png'));

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('n1', 'image.png', '/image.png', 'file');
    });

    expect(result.current.contentState.collabUnavailable).toBe(false);
    expect(result.current.contentState.isBinary).toBe(true);
  });

  // (d): network error sets contentState.error
  it('network error sets contentState.error', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network failure'));

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });

    expect(result.current.contentState.error).toBe('Network failure');
    expect(result.current.contentState.content).toBeNull();
    expect(result.current.contentState.isLoading).toBe(false);
    expect(result.current.contentState.isBinary).toBe(false);
  });

  // non-Error rejection falls back to generic message
  it('sets generic error message when rejection value is not an Error', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue('string-error');

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });

    expect(result.current.contentState.error).toBe('An error occurred.');
  });

  // DOMException with non-AbortError name must set error state, not be silently ignored
  it('DOMException with non-AbortError name sets error state', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new DOMException('Network error', 'NetworkError'));

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });

    expect(result.current.contentState.error).not.toBeNull();
  });

  // AbortError must be silently ignored (no error state)
  it('AbortError from DOMException is silently ignored', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });

    // AbortError should not set error state
    expect(result.current.contentState.error).toBeNull();
  });

  // (e): calling selectFile twice aborts the first fetch
  it('calling selectFile twice aborts the first fetch via AbortController', async () => {
    let firstSignalAborted = false;
    let resolveFirst!: () => void;
    const firstFetchDone = new Promise<void>((resolve) => { resolveFirst = resolve; });

    globalThis.fetch = jest
      .fn()
      .mockImplementationOnce((_url: string, { signal }: RequestInit) => {
        signal?.addEventListener('abort', () => { firstSignalAborted = true; });
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')); });
          firstFetchDone.then(() => _resolve(makeFetchResponse('first', 'text/plain')));
        });
      })
      .mockImplementationOnce(() => Promise.resolve(makeFetchResponse('second', 'text/plain')));

    const { result } = renderHook(() => useFileSelection('p1'));

    act(() => { result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file'); });
    // Let the collab discovery resolve so the first content fetch actually starts.
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      await result.current.selectFile('n2', 'other.adoc', '/other.adoc', 'file');
    });

    expect(firstSignalAborted).toBe(true);
    resolveFirst();
  });

  // C3: unmounting while a fetch is in-flight must abort the request so setState is never called
  it('aborts any in-flight fetch when the hook is unmounted', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    globalThis.fetch = jest.fn().mockImplementation((_url: string, { signal }: RequestInit) => {
      capturedSignal = signal;
      return new Promise(() => {}); // never resolves
    });

    const { result, unmount } = renderHook(() => useFileSelection('p1'));
    act(() => { result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file'); });
    // Let the collab discovery resolve so the content fetch (and its signal) is created.
    await act(async () => { await Promise.resolve(); });

    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  // C2: clicking a folder must NOT trigger a fetch — nodeType 'folder' sets selection but skips loading
  it('selectFile with nodeType=folder sets selectedFile but does not fetch content', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('folder-1', 'src', '/src', 'folder');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.selectedFile).toMatchObject({ nodeId: 'folder-1', nodeType: 'folder' });
    expect(result.current.contentState.isLoading).toBe(false);
    expect(result.current.contentState.content).toBeNull();
  });

  it('clearSelection aborts an in-flight fetch', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    globalThis.fetch = jest.fn().mockImplementation((_url: string, { signal }: RequestInit) => {
      capturedSignal = signal;
      return new Promise(() => {}); // never resolves — stays in-flight
    });

    const { result } = renderHook(() => useFileSelection('p1'));
    act(() => { result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file'); });
    // Let the collab discovery resolve so the content fetch (and its signal) is created.
    await act(async () => { await Promise.resolve(); });

    expect(capturedSignal?.aborted).toBe(false);

    // clearSelection must abort the in-flight fetch
    act(() => { result.current.clearSelection(); });

    // With L93 mutation (false/BlockStatement): abort is NOT called → signal remains un-aborted → fails
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('clearSelection on a fresh hook (no fetch in progress) does not throw', () => {
    const { result } = renderHook(() => useFileSelection('p1'));
    expect(() => act(() => { result.current.clearSelection(); })).not.toThrow();
  });

  it('selectFile with 4th argument omitted defaults nodeType to "file" and fetches content', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse('content', 'text/plain'));
    const { result } = renderHook(() => useFileSelection('p1'));
    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc');
    });
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  // A non-OK (404) content response must surface a `notFound` signal without
  // populating content or error, so the layout can clear stale memory and fall back gracefully.
  it('non-OK (404) content response sets notFound and leaves content/error empty', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse('Not Found', 'text/plain', false),
    );

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('gone-1', 'gone.adoc', '/gone.adoc', 'file');
    });

    expect(result.current.contentState.notFound).toBe(true);
    expect(result.current.contentState.content).toBeNull();
    expect(result.current.contentState.error).toBeNull();
    expect(result.current.contentState.isLoading).toBe(false);
  });

  it('an OK content response leaves notFound false', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse('hi', 'text/plain'));
    const { result } = renderHook(() => useFileSelection('p1'));
    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });
    expect(result.current.contentState.notFound).toBe(false);
  });

  // (f): clearSelection resets state
  it('clearSelection resets selectedFile and contentState', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      makeFetchResponse('content', 'text/plain'),
    );

    const { result } = renderHook(() => useFileSelection('p1'));

    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });

    expect(result.current.selectedFile).not.toBeNull();

    act(() => { result.current.clearSelection(); });

    expect(result.current.selectedFile).toBeNull();
    expect(result.current.contentState.content).toBeNull();
    expect(result.current.contentState.isLoading).toBe(false);
    expect(result.current.contentState.error).toBeNull();
    expect(result.current.contentState.isBinary).toBe(false);
  });
});

// On the collab path the GET /content fetch must be SKIPPED (the
// collaboration server owns load/save); on 404 (asset) the legacy fetch runs.
describe('useFileSelection — collab path (REST-skip refactor guard)', () => {
  it('skips the GET /content fetch when the file is a collaborative document', async () => {
    mockGetCollabInfo.mockResolvedValue({ yjsStateId: 'yjs-1', role: 'editor' });
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useFileSelection('p1'));
    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.contentState.collab).toEqual({ yjsStateId: 'yjs-1', role: 'editor' });
    expect(result.current.contentState.content).toBeNull();
    expect(result.current.contentState.isLoading).toBe(false);
  });

  it('runs the legacy GET /content fetch when there is no collaborative document (404 → null)', async () => {
    mockGetCollabInfo.mockResolvedValue(null);
    const fetchMock = jest.fn().mockResolvedValue(makeFetchResponse('= Legacy', 'text/plain'));
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useFileSelection('p1'));
    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/projects/p1/files/n1/content`,
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(result.current.contentState.collab).toBeNull();
    expect(result.current.contentState.content).toBe('= Legacy');
  });

  it('surfaces an error and does NOT silently open the legacy editor when collab discovery throws', async () => {
    // A non-404 failure (401/403/5xx) means the file IS a collaborative document but we could not
    // confirm it. Falling through to the legacy REST GET/PUT path would mount an editable editor
    // whose autosave PUTs bypass the Yjs document — a split-brain write. So surface an error and
    // do NOT fetch /content.
    mockGetCollabInfo.mockRejectedValue(new Error('api down'));
    const fetchMock = jest.fn().mockResolvedValue(makeFetchResponse('= Fallback', 'text/plain'));
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useFileSelection('p1'));
    await act(async () => {
      await result.current.selectFile('n1', 'doc.adoc', '/doc.adoc', 'file');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.contentState.error).toBe('api down');
    expect(result.current.contentState.content).toBeNull();
    expect(result.current.contentState.isLoading).toBe(false);
  });
});

// Issue 3: use-file-selection must not define its own API_BASE — it must use
// fileContentUrl from lib/api/file-content so the content URL stays in sync.
describe('use-file-selection URL must match fileContentUrl', () => {
  test('use-file-selection.ts does not define its own NEXT_PUBLIC_API_URL constant', () => {
    const fs = require('node:fs');
    const source: string = fs.readFileSync(
      require.resolve('@/hooks/use-file-selection'),
      'utf8',
    );
    expect(source).not.toContain('process.env.NEXT_PUBLIC_API_URL');
    expect(source).toContain('fileContentUrl');
  });
});
