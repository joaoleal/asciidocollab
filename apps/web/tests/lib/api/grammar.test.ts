import { grammarApi } from '@/lib/api/grammar';
import { API_BASE_URL, ApiError } from '@/lib/api/transport';

/** A minimal fetch Response stub returning `body` from `.json()`. */
function mockResponse(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** A Response stub whose `.json()` rejects — what an HTML error page from a proxy looks like. */
function unparseableResponse(ok: boolean, status: number): Response {
  return {
    ok,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  } as unknown as Response;
}

/** Installs a fetch mock that always answers with `response`, and returns it for assertions. */
function stubFetch(response: Response): jest.Mock {
  const fetchMock = jest.fn(async () => response);
  globalThis.fetch = fetchMock as never;
  return fetchMock;
}

/** The init object `apiRequest` builds for a bodyless request. */
const bodylessInit = { credentials: 'include', cache: 'no-store', headers: {} };

/** The init object `apiRequest` builds for a request that carries a JSON body. */
const jsonHeaders = { 'Content-Type': 'application/json' };

describe('grammarApi.listDictionary', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('GETs the project dictionary and returns the parsed envelope', async () => {
    const body = { data: { terms: [{ id: 'term-1', term: 'Asciidoctor', createdAt: '2026-01-01T00:00:00.000Z' }] } };
    const fetchMock = stubFetch(mockResponse(true, 200, body));

    await expect(grammarApi.listDictionary('proj-1')).resolves.toEqual(body);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/api/projects/proj-1/dictionary`, bodylessInit);
  });

  it('interpolates the project id into the path', async () => {
    const fetchMock = stubFetch(mockResponse(true, 200, { data: { terms: [] } }));

    await grammarApi.listDictionary('another-project');

    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/api/projects/another-project/dictionary`, bodylessInit);
  });

  it('surfaces a non-2xx envelope as an ApiError', async () => {
    stubFetch(mockResponse(false, 403, { error: { code: 'FORBIDDEN', message: 'Not a member of this project' } }));

    const error: unknown = await grammarApi.listDictionary('proj-1').catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('Not a member of this project');
  });

  it('reports an ApiError carrying the status when the server returns an HTML error page', async () => {
    // REWRITTEN with the transport fix. The body is now parsed only AFTER the response.ok check,
    // and defensively, so a proxy's HTML error page yields an ApiError with the real status rather
    // than a bare SyntaxError. The previous assertion — that `status` was undefined — documented
    // precisely the defect: the caller lost the status exactly when the failure was infrastructural.
    stubFetch(unparseableResponse(false, 502));

    const error: unknown = await grammarApi.listDictionary('proj-1').catch((error_: unknown) => error_);
    expect((error as { name?: string }).name).toBe('ApiError');
    expect((error as { status?: number }).status).toBe(502);
    expect((error as { code?: string }).code).toBe('UNKNOWN_ERROR');
    expect((error as Error).message).toBe('An unexpected error occurred');
  });
});

describe('grammarApi.addDictionaryTerm', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs the term as a JSON body and returns the stored term', async () => {
    const body = { data: { id: 'term-7', term: 'Asciidoctor', createdAt: '2026-01-01T00:00:00.000Z' } };
    const fetchMock = stubFetch(mockResponse(true, 201, body));

    await expect(grammarApi.addDictionaryTerm('proj-1', 'Asciidoctor')).resolves.toEqual(body);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/api/projects/proj-1/dictionary`, {
      method: 'POST',
      body: JSON.stringify({ term: 'Asciidoctor' }),
      credentials: 'include',
      cache: 'no-store',
      headers: jsonHeaders,
    });
  });

  it('serialises the term verbatim, quoting included', async () => {
    const fetchMock = stubFetch(mockResponse(true, 201, { data: { id: 'term-8', term: 'O"Neill' } }));

    await grammarApi.addDictionaryTerm('proj-2', 'O"Neill');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(String.raw`{"term":"O\"Neill"}`);
    expect(init.method).toBe('POST');
  });

  it('surfaces a validation rejection as an ApiError', async () => {
    stubFetch(
      mockResponse(false, 400, {
        statusCode: 400,
        error: 'Bad Request',
        message: 'body/term must NOT have fewer than 1 characters',
      }),
    );

    const error: unknown = await grammarApi.addDictionaryTerm('proj-1', '').catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.status).toBe(400);
    expect(error.code).toBe('UNKNOWN_ERROR');
    expect(error.message).toBe('body/term must NOT have fewer than 1 characters');
  });

  it('reports an ApiError carrying the status when the server returns an HTML error page', async () => {
    // REWRITTEN with the transport fix. The body is now parsed only AFTER the response.ok check,
    // and defensively, so a proxy's HTML error page yields an ApiError with the real status rather
    // than a bare SyntaxError. The previous assertion — that `status` was undefined — documented
    // precisely the defect: the caller lost the status exactly when the failure was infrastructural.
    stubFetch(unparseableResponse(false, 500));

    const error: unknown = await grammarApi.addDictionaryTerm('proj-1', 'x').catch((error_: unknown) => error_);
    expect((error as { name?: string }).name).toBe('ApiError');
    expect((error as { status?: number }).status).toBe(500);
    expect((error as { code?: string }).code).toBe('UNKNOWN_ERROR');
    expect((error as Error).message).toBe('An unexpected error occurred');
  });
});

describe('grammarApi.removeDictionaryTerm', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('DELETEs the term by id and resolves with nothing', async () => {
    const fetchMock = stubFetch(mockResponse(true, 200, { data: null }));

    await expect(grammarApi.removeDictionaryTerm('proj-1', 'term-9')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/api/projects/proj-1/dictionary/term-9`, {
      method: 'DELETE',
      credentials: 'include',
      cache: 'no-store',
      headers: {},
    });
  });

  it('sends no body, so no Content-Type is declared', async () => {
    const fetchMock = stubFetch(mockResponse(true, 200, { data: null }));

    await grammarApi.removeDictionaryTerm('proj-1', 'term-9');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({});
  });

  it('surfaces a missing term as an ApiError', async () => {
    stubFetch(mockResponse(false, 404, { error: { code: 'NOT_FOUND', message: 'Dictionary term not found' } }));

    const error: unknown = await grammarApi
      .removeDictionaryTerm('proj-1', 'term-gone')
      .catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.status).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Dictionary term not found');
  });

  it('falls back to the generic message when the error body carries nothing useful', async () => {
    stubFetch(mockResponse(false, 500, {}));

    const error: unknown = await grammarApi
      .removeDictionaryTerm('proj-1', 'term-9')
      .catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.status).toBe(500);
    expect(error.code).toBe('UNKNOWN_ERROR');
    expect(error.message).toBe('An unexpected error occurred');
  });
});

describe('grammarApi.getIgnoredLints', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('GETs the ignored-lints blob for a document', async () => {
    const body = { data: { ignoredLintsJson: '{"h1":true}' } };
    const fetchMock = stubFetch(mockResponse(true, 200, body));

    await expect(grammarApi.getIgnoredLints('doc-1')).resolves.toEqual(body);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/api/documents/doc-1/ignored-lints`, bodylessInit);
  });

  it('interpolates the document id into the path', async () => {
    const fetchMock = stubFetch(mockResponse(true, 200, { data: { ignoredLintsJson: '' } }));

    await grammarApi.getIgnoredLints('doc-42');

    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/api/documents/doc-42/ignored-lints`, bodylessInit);
  });

  it('surfaces an unauthenticated read as an ApiError', async () => {
    stubFetch(mockResponse(false, 401, { error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }));

    const error: unknown = await grammarApi.getIgnoredLints('doc-1').catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.status).toBe(401);
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toBe('Sign in required');
  });

  it('propagates the parse failure when the server returns an HTML error page', async () => {
    stubFetch(unparseableResponse(false, 504));

    const error: unknown = await grammarApi.getIgnoredLints('doc-1').catch((error_: unknown) => error_);
    expect((error as { name?: string }).name).toBe('ApiError');
    expect((error as { status?: number }).status).toBe(504);
    expect((error as { code?: string }).code).toBe('UNKNOWN_ERROR');
    expect((error as Error).message).toBe('An unexpected error occurred');
  });
});

describe('grammarApi.putIgnoredLints', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('PUTs the blob as a JSON body and resolves with nothing', async () => {
    const fetchMock = stubFetch(mockResponse(true, 200, { data: { ignoredLintsJson: '{"h1":true}' } }));

    await expect(grammarApi.putIgnoredLints('doc-1', '{"h1":true}')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/api/documents/doc-1/ignored-lints`, {
      method: 'PUT',
      body: JSON.stringify({ ignoredLintsJson: '{"h1":true}' }),
      credentials: 'include',
      cache: 'no-store',
      headers: jsonHeaders,
    });
  });

  it('double-encodes the blob, so the payload stays a single JSON string field', async () => {
    const fetchMock = stubFetch(mockResponse(true, 200, { data: { ignoredLintsJson: '' } }));

    await grammarApi.putIgnoredLints('doc-1', '{"a":1}');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(String.raw`{"ignoredLintsJson":"{\"a\":1}"}`);
    expect(init.method).toBe('PUT');
  });

  it('surfaces an oversized-blob rejection as an ApiError', async () => {
    stubFetch(mockResponse(false, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Ignored-lints blob too large' } }));

    const error: unknown = await grammarApi.putIgnoredLints('doc-1', '{}').catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.status).toBe(413);
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.message).toBe('Ignored-lints blob too large');
  });

  it('reports an ApiError carrying the status when the server returns an HTML error page', async () => {
    // REWRITTEN with the transport fix. The body is now parsed only AFTER the response.ok check,
    // and defensively, so a proxy's HTML error page yields an ApiError with the real status rather
    // than a bare SyntaxError. The previous assertion — that `code` was undefined — documented
    // precisely the defect: the caller lost the status exactly when the failure was infrastructural.
    stubFetch(unparseableResponse(false, 502));

    const error: unknown = await grammarApi.putIgnoredLints('doc-1', '{}').catch((error_: unknown) => error_);
    expect((error as { name?: string }).name).toBe('ApiError');
    expect((error as { status?: number }).status).toBe(502);
    expect((error as { code?: string }).code).toBe('UNKNOWN_ERROR');
    expect((error as Error).message).toBe('An unexpected error occurred');
  });
});
