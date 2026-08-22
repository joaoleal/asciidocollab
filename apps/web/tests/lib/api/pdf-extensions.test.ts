import { pdfExtensionsApi } from '@/lib/api/pdf-extensions';
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

/** A `text/plain` Response stub, as the extension-source endpoint serves. */
function textResponse(ok: boolean, status: number, text: () => Promise<string>): Response {
  return { ok, status, text } as unknown as Response;
}

/** Installs a fetch mock that always answers with `response`, and returns it for assertions. */
function stubFetch(response: Response): jest.Mock {
  const fetchMock = jest.fn(async () => response);
  globalThis.fetch = fetchMock as never;
  return fetchMock;
}

/** The init object `apiRequest` builds for a bodyless request. */
const bodylessInit = { credentials: 'include', cache: 'no-store', headers: {} };

/** The init `getSource` passes to `fetch` directly, bypassing `apiRequest`. */
const sourceInit = { credentials: 'include', cache: 'no-store' };

/** A catalogue body with all four sections populated. */
const catalogue = {
  entries: [{ id: 'chart', name: 'Chart', description: 'Bar charts', origin: 'shipped' }],
  staleSelections: ['removed-ext'],
  excluded: [{ source: 'broken.rb', reason: 'Not valid Ruby' }],
  conflicts: [{ id: 'chart', reason: 'The administrator copy shadows the shipped one' }],
};

describe('pdfExtensionsApi.get', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('GETs the project catalogue and returns the parsed envelope', async () => {
    const fetchMock = stubFetch(mockResponse(true, 200, { data: catalogue }));

    await expect(pdfExtensionsApi.get('proj-1')).resolves.toEqual({ data: catalogue });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/api/projects/proj-1/pdf-extensions`, bodylessInit);
  });

  it('interpolates the project id into the path', async () => {
    const fetchMock = stubFetch(
      mockResponse(true, 200, { data: { entries: [], staleSelections: [], excluded: [], conflicts: [] } }),
    );

    await pdfExtensionsApi.get('another-project');

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/projects/another-project/pdf-extensions`,
      bodylessInit,
    );
  });

  it('surfaces a non-2xx envelope as an ApiError', async () => {
    stubFetch(mockResponse(false, 403, { error: { code: 'FORBIDDEN', message: 'Not a member of this project' } }));

    const error: unknown = await pdfExtensionsApi.get('proj-1').catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('Not a member of this project');
  });

  it('falls back to the generic message when the error body carries nothing useful', async () => {
    stubFetch(mockResponse(false, 500, {}));

    const error: unknown = await pdfExtensionsApi.get('proj-1').catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.status).toBe(500);
    expect(error.code).toBe('UNKNOWN_ERROR');
    expect(error.message).toBe('An unexpected error occurred');
  });

  it('reports an ApiError carrying the status when the server returns an HTML error page', async () => {
    // REWRITTEN with the transport fix. The body is now parsed only AFTER the response.ok check,
    // and defensively, so a proxy's HTML error page yields an ApiError with the real status rather
    // than a bare SyntaxError. The previous assertion — that `status` was undefined — documented
    // precisely the defect: the caller lost the status exactly when the failure was infrastructural.
    stubFetch(unparseableResponse(false, 502));

    const error: unknown = await pdfExtensionsApi.get('proj-1').catch((error_: unknown) => error_);
    expect((error as { name?: string }).name).toBe('ApiError');
    expect((error as { status?: number }).status).toBe(502);
    expect((error as { code?: string }).code).toBe('UNKNOWN_ERROR');
    expect((error as Error).message).toBe('An unexpected error occurred');
  });
});

describe('pdfExtensionsApi.getSource', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches the source with credentials and no caching, and returns the text', async () => {
    const source = "require 'asciidoctor'\nputs 'hello'\n";
    const fetchMock = stubFetch(textResponse(true, 200, async () => source));

    await expect(pdfExtensionsApi.getSource('proj-1', 'chart')).resolves.toBe(source);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/projects/proj-1/pdf-extensions/chart/source`,
      sourceInit,
    );
  });

  it('percent-encodes the extension id so it can never widen the path', async () => {
    const fetchMock = stubFetch(textResponse(true, 200, async () => ''));

    await pdfExtensionsApi.getSource('proj-1', '../secret rb');

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/projects/proj-1/pdf-extensions/..%2Fsecret%20rb/source`,
      sourceInit,
    );
  });

  it('returns an empty source unchanged rather than treating it as a failure', async () => {
    stubFetch(textResponse(true, 200, async () => ''));

    await expect(pdfExtensionsApi.getSource('proj-1', 'chart')).resolves.toBe('');
  });

  it('throws EXTENSION_SOURCE_UNAVAILABLE naming the extension when the id is unknown', async () => {
    stubFetch(textResponse(false, 404, async () => 'Not Found'));

    const error: unknown = await pdfExtensionsApi
      .getSource('proj-1', 'missing-ext')
      .catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.status).toBe(404);
    expect(error.code).toBe('EXTENSION_SOURCE_UNAVAILABLE');
    expect(error.message).toBe('The source for extension "missing-ext" could not be read.');
  });

  it('carries the server status through, and never reads the error body', async () => {
    const text = jest.fn(async () => 'internal stack trace');
    stubFetch(textResponse(false, 500, text));

    const error: unknown = await pdfExtensionsApi.getSource('proj-1', 'chart').catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.status).toBe(500);
    expect(error.code).toBe('EXTENSION_SOURCE_UNAVAILABLE');
    expect(error.message).toBe('The source for extension "chart" could not be read.');
    expect(text).not.toHaveBeenCalled();
  });
});
