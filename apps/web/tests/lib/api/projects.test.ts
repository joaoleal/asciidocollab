// Tests for apps/web/src/lib/api/projects.ts
import { API_BASE_URL } from '@/lib/api/base-url';
import { setProjectMainFile, findSymbolUsages, renameSymbol, projectsApi } from '@/lib/api/projects';

const mockFetch = jest.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('setProjectMainFile', () => {
  test('sends PUT with credentials + body to the main-file endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: 'p1', mainFileNodeId: 'f1' } }),
    });
    await setProjectMainFile('p1', 'f1');
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/projects/p1/main-file');
    expect(options.method).toBe('PUT');
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body as string)).toEqual({ mainFileNodeId: 'f1' });
  });

  test('returns the updated project DTO', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: 'p1', mainFileNodeId: 'f1' } }),
    });
    const project = await setProjectMainFile('p1', 'f1');
    expect(project).toEqual({ id: 'p1', mainFileNodeId: 'f1' });
  });

  test('sends null to clear the main file', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: 'p1', mainFileNodeId: null } }),
    });
    await setProjectMainFile('p1', null);
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({ mainFileNodeId: null });
  });

  test('throws with status + code on a 403 (use-case PermissionDenied)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { code: 'FORBIDDEN', message: 'Permission denied' } }),
    });
    await expect(setProjectMainFile('p1', 'f1')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('throws with the contract code on a 400 (non-adoc)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { code: 'MainFileNotAsciiDoc', message: 'not adoc' } }),
    });
    await expect(setProjectMainFile('p1', 'f1')).rejects.toMatchObject({ status: 400, code: 'MainFileNotAsciiDoc' });
  });
});

describe('findSymbolUsages', () => {
  test('GETs the symbol-usages endpoint with the URL-encoded name and returns the usages', async () => {
    const usages = [{ fileNodeId: 'f1', path: 'a.adoc', kind: 'xref', range: { from: 1, to: 5 } }];
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: { usages } }) });
    const result = await findSymbolUsages('p1', 'my id');
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/projects/p1/symbol-usages?name=my%20id');
    expect(options.credentials).toBe('include');
    expect(result).toEqual(usages);
  });

  test('appends the kind query param when a symbol kind is given', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: { usages: [] } }) });
    await findSymbolUsages('p1', 'intro', 'attribute');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('name=intro');
    expect(url).toContain('kind=attribute');
  });

  test('throws with status + code on a 403', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { code: 'FORBIDDEN', message: 'denied' } }),
    });
    await expect(findSymbolUsages('p1', 'x')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});

describe('renameSymbol', () => {
  test('POSTs the rename body and returns the outcome', async () => {
    const outcome = { rewrittenFiles: 2, updatedReferences: 3, warnings: [] };
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: outcome }) });
    const result = await renameSymbol('p1', { symbolKind: 'anchor', oldName: 'intro', newName: 'overview' });
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/projects/p1/symbol-rename');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ symbolKind: 'anchor', oldName: 'intro', newName: 'overview' });
    expect(result).toEqual(outcome);
  });

  test('throws the contract code on a 400 (invalid name / conflict)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { code: 'INVALID_SYMBOL_RENAME', message: 'bad' } }),
    });
    await expect(
      renameSymbol('p1', { symbolKind: 'anchor', oldName: 'a', newName: '1 bad' }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_SYMBOL_RENAME' });
  });

  test('throws with status + code on a 403', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { code: 'FORBIDDEN', message: 'denied' } }),
    });
    await expect(
      renameSymbol('p1', { symbolKind: 'attribute', oldName: 'a', newName: 'b' }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('falls back to REFACTORING_ERROR / a status-derived message when the body is empty', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await expect(
      renameSymbol('p1', { symbolKind: 'anchor', oldName: 'a', newName: 'b' }),
    ).rejects.toMatchObject({ status: 500, code: 'REFACTORING_ERROR', message: 'Rename failed: 500' });
  });

  test('falls back when the error body is not valid JSON', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, json: () => Promise.reject(new Error('nope')) });
    await expect(
      renameSymbol('p1', { symbolKind: 'anchor', oldName: 'a', newName: 'b' }),
    ).rejects.toMatchObject({ status: 502, code: 'REFACTORING_ERROR', message: 'Rename failed: 502' });
  });
});

describe('setProjectMainFile fallback errors', () => {
  test('falls back to SET_MAIN_FILE_ERROR / a status-derived message when the body is empty', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await expect(setProjectMainFile('p1', 'f1')).rejects.toMatchObject({
      status: 500,
      code: 'SET_MAIN_FILE_ERROR',
      message: 'Set main file failed: 500',
    });
  });

  test('falls back when the error body is not valid JSON', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.reject(new Error('nope')) });
    await expect(setProjectMainFile('p1', 'f1')).rejects.toMatchObject({
      status: 503,
      code: 'SET_MAIN_FILE_ERROR',
    });
  });
});

describe('findSymbolUsages fallback errors', () => {
  test('falls back to REFACTORING_ERROR / a status-derived message when the body is empty', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await expect(findSymbolUsages('p1', 'x')).rejects.toMatchObject({
      status: 500,
      code: 'REFACTORING_ERROR',
      message: 'Find usages failed: 500',
    });
  });

  test('falls back when the error body is not valid JSON', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, json: () => Promise.reject(new Error('nope')) });
    await expect(findSymbolUsages('p1', 'x')).rejects.toMatchObject({
      status: 502,
      code: 'REFACTORING_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// The exact request the client puts on the wire. These assert the WHOLE URL and
// the WHOLE init object rather than a substring/field, because a substring match
// still passes when the URL grows a suffix and a missing `method` silently
// downgrades a POST to a GET.
// ---------------------------------------------------------------------------

/** Resolves to an ok response whose `.json()` yields `body`. */
function okResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

/** The `[url, init]` pair of the single fetch the call under test performed. */
function singleFetchCall(): [string, RequestInit] {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  return mockFetch.mock.calls[0] as [string, RequestInit];
}

const emptyPage = { data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } };

describe('projectsApi request shape', () => {
  test('list() with no parameters hits the bare collection URL — no query suffix at all', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(emptyPage));
    await projectsApi.list();
    const [url] = singleFetchCall();
    expect(url).toBe(`${API_BASE_URL}/api/projects`);
  });

  test('list() with parameters appends exactly one `?`-prefixed query string', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(emptyPage));
    await projectsApi.list({ page: 2, limit: 5, archived: true });
    const [url] = singleFetchCall();
    expect(url).toBe(`${API_BASE_URL}/api/projects?page=2&limit=5&archived=true`);
  });

  test('create() POSTs the serialized payload to the exact collection URL', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ data: { id: 'p1' } }));
    await projectsApi.create({ name: 'Test', description: 'desc', tags: ['a'] });
    const [url, options] = singleFetchCall();
    expect(url).toBe(`${API_BASE_URL}/api/projects`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Test', description: 'desc', tags: ['a'] });
  });

  test('archive() POSTs to the exact archive URL — a bodyless request still needs the POST verb', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ data: { id: 'p1', archivedAt: '2024-01-01T00:00:00Z' } }));
    await projectsApi.archive('p1');
    const [url, options] = singleFetchCall();
    expect(url).toBe(`${API_BASE_URL}/api/projects/p1/archive`);
    expect(options.method).toBe('POST');
  });

  test('restore() POSTs to the exact restore URL — a bodyless request still needs the POST verb', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ data: { id: 'p1', archivedAt: null } }));
    await projectsApi.restore('p1');
    const [url, options] = singleFetchCall();
    expect(url).toBe(`${API_BASE_URL}/api/projects/p1/restore`);
    expect(options.method).toBe('POST');
  });
});

describe('setProjectMainFile request shape', () => {
  test('declares the JSON content type so the API parses the body', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ data: { id: 'p1', mainFileNodeId: 'f1' } }));
    await setProjectMainFile('p1', 'f1');
    const [url, options] = singleFetchCall();
    expect(url).toBe(`${API_BASE_URL}/projects/p1/main-file`);
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('setProjectMainFile with a null error body', () => {
  test('falls back to the status-derived message and code when json() resolves null', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve(null) });
    const error = (await setProjectMainFile('p1', 'f1').catch((error_: unknown) => error_)) as Error & {
      status?: number;
      code?: string;
    };
    expect(error.message).toBe('Set main file failed: 500');
    expect(error.status).toBe(500);
    expect(error.code).toBe('SET_MAIN_FILE_ERROR');
  });

  test('still reports the fallback code when json() resolves an error-less body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, json: () => Promise.resolve({}) });
    const error = (await setProjectMainFile('p1', 'f1').catch((error_: unknown) => error_)) as Error & {
      code?: string;
    };
    expect(error.message).toBe('Set main file failed: 502');
    expect(error.code).toBe('SET_MAIN_FILE_ERROR');
  });

  test('prefers the server-supplied message and code over the fallbacks', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { message: 'not an adoc file', code: 'MainFileNotAsciiDoc' } }),
    });
    const error = (await setProjectMainFile('p1', 'f1').catch((error_: unknown) => error_)) as Error & {
      code?: string;
    };
    expect(error.message).toBe('not an adoc file');
    expect(error.code).toBe('MainFileNotAsciiDoc');
  });
});

describe('findSymbolUsages request shape', () => {
  test('omits the kind parameter entirely when no kind is given', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ data: { usages: [] } }));
    await findSymbolUsages('p1', 'intro');
    const [url] = singleFetchCall();
    expect(url).toBe(`${API_BASE_URL}/projects/p1/symbol-usages?name=intro`);
  });

  test('appends `&kind=` after the name when a kind is given', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ data: { usages: [] } }));
    await findSymbolUsages('p1', 'intro', 'attribute');
    const [url] = singleFetchCall();
    expect(url).toBe(`${API_BASE_URL}/projects/p1/symbol-usages?name=intro&kind=attribute`);
  });
});

describe('refactoringError with a null error body', () => {
  test('findSymbolUsages falls back when json() resolves null', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve(null) });
    const error = (await findSymbolUsages('p1', 'x').catch((error_: unknown) => error_)) as Error & {
      status?: number;
      code?: string;
    };
    expect(error.message).toBe('Find usages failed: 500');
    expect(error.status).toBe(500);
    expect(error.code).toBe('REFACTORING_ERROR');
  });

  test('renameSymbol falls back when json() resolves null', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve(null) });
    const error = (await renameSymbol('p1', { symbolKind: 'anchor', oldName: 'a', newName: 'b' }).catch(
      (error_: unknown) => error_,
    )) as Error & { status?: number; code?: string };
    expect(error.message).toBe('Rename failed: 503');
    expect(error.status).toBe(503);
    expect(error.code).toBe('REFACTORING_ERROR');
  });

  test('renameSymbol prefers the server-supplied message and code', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: { message: 'id already taken', code: 'SYMBOL_RENAME_CONFLICT' } }),
    });
    const error = (await renameSymbol('p1', { symbolKind: 'anchor', oldName: 'a', newName: 'b' }).catch(
      (error_: unknown) => error_,
    )) as Error & { code?: string };
    expect(error.message).toBe('id already taken');
    expect(error.code).toBe('SYMBOL_RENAME_CONFLICT');
  });
});

describe('renameSymbol request shape', () => {
  test('sends the session cookie and declares the JSON content type', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ data: { rewrittenFiles: 0, updatedReferences: 0, warnings: [] } }));
    await renameSymbol('p1', { symbolKind: 'anchor', oldName: 'a', newName: 'b' });
    const [url, options] = singleFetchCall();
    expect(url).toBe(`${API_BASE_URL}/projects/p1/symbol-rename`);
    expect(options.credentials).toBe('include');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('projectsApi.clone', () => {
  test('POSTs the requested name to the clone endpoint and returns the created project', async () => {
    const created = { id: 'p2', name: 'Copy of Docs', fileCount: 3, memberCount: 1, role: 'owner' };
    mockFetch.mockResolvedValueOnce(okResponse({ data: created }));
    const response = await projectsApi.clone('p1', 'Copy of Docs');
    const [url, options] = singleFetchCall();
    expect(url).toBe(`${API_BASE_URL}/api/projects/p1/clone`);
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Copy of Docs' });
    expect(response.data).toEqual(created);
  });

  test('rejects with the server status, code and message when the response is not ok', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: { code: 'CLONE_IN_PROGRESS', message: 'already running' } }),
    });
    await expect(projectsApi.clone('p1', 'Copy of Docs')).rejects.toMatchObject({
      status: 409,
      code: 'CLONE_IN_PROGRESS',
      message: 'already running',
    });
  });

  test('carries the structured details the server attaches to an unreadable-content failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () =>
        Promise.resolve({
          error: {
            code: 'LIVE_CONTENT_UNAVAILABLE',
            message: 'Could not read the current content of /chapters/intro.adoc',
            details: { path: '/chapters/intro.adoc' },
          },
        }),
    });
    await expect(projectsApi.clone('p1', 'Copy of Docs')).rejects.toMatchObject({
      status: 503,
      code: 'LIVE_CONTENT_UNAVAILABLE',
      details: { path: '/chapters/intro.adoc' },
    });
  });

  test('propagates a network failure to the caller', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(projectsApi.clone('p1', 'Copy of Docs')).rejects.toThrow('Failed to fetch');
  });
});
