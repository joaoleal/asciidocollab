import { apiRequest, ApiError, API_BASE_URL } from '@/lib/api/transport';

/** A minimal fetch Response stub returning `body` from `.json()`. */
function mockResponse(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** One recorded call to the fetch stub. */
interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Installs a fetch stub that records every (url, init) pair it receives and answers
 * `200 { }`, and returns the (initially empty) recording it will fill in.
 */
function recordFetch(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return mockResponse(true, 200, {});
  }) as never;
  return calls;
}

/** Runs `apiRequest` and returns whatever it rejected with, as an ApiError. */
async function rejection(endpoint: string): Promise<ApiError> {
  const error: unknown = await apiRequest(endpoint).catch((error_: unknown) => error_);
  if (!(error instanceof ApiError)) {
    throw new TypeError(`expected an ApiError, got ${String(error)}`);
  }
  return error;
}

describe('apiRequest error handling', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('surfaces our { error: { code, message } } envelope', async () => {
    globalThis.fetch = jest.fn(async () => mockResponse(false, 403, { error: { code: 'FORBIDDEN', message: 'nope' } })) as never;
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'nope' });
  });

  test('surfaces a Fastify-native { statusCode, error, message } shape', async () => {
    globalThis.fetch = jest.fn(async () =>
      mockResponse(false, 400, { statusCode: 400, error: 'Bad Request', message: 'body/op must be equal to one of the allowed values' }),
    ) as never;
    const error: unknown = await apiRequest('/x').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.message).toMatch(/allowed values/);
  });

  test('uses a top-level code when present (Fastify validation)', async () => {
    globalThis.fetch = jest.fn(async () => mockResponse(false, 400, { code: 'FST_ERR_VALIDATION', message: 'bad' })) as never;
    const error: unknown = await apiRequest('/x').catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.code).toBe('FST_ERR_VALIDATION');
  });

  test('falls back to the string error body when no message is present', async () => {
    globalThis.fetch = jest.fn(async () => mockResponse(false, 429, { error: 'Too Many Requests' })) as never;
    const error: unknown = await apiRequest('/x').catch((error_: unknown) => error_);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.message).toBe('Too Many Requests');
  });

  test('uses the generic message when the body carries nothing useful', async () => {
    globalThis.fetch = jest.fn(async () => mockResponse(false, 500, {})) as never;
    await expect(apiRequest('/x')).rejects.toMatchObject({ code: 'UNKNOWN_ERROR', message: 'An unexpected error occurred' });
  });

  test('returns the parsed JSON on a successful response', async () => {
    globalThis.fetch = jest.fn(async () => mockResponse(true, 200, { data: 42 })) as never;
    await expect(apiRequest<{ data: number }>('/x')).resolves.toEqual({ data: 42 });
  });

  test('carries the whole envelope — name, status, code, message and retryAfter', async () => {
    globalThis.fetch = jest.fn(async () =>
      mockResponse(false, 429, { error: { code: 'RATE_LIMITED', message: 'slow down', retryAfter: 30 } }),
    ) as never;
    const error = await rejection('/x');
    expect(error.name).toBe('ApiError');
    expect(error.status).toBe(429);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.message).toBe('slow down');
    expect(error.retryAfter).toBe(30);
  });

  test('reports the generic failure when the body is null rather than throwing on it', async () => {
    globalThis.fetch = jest.fn(async () => mockResponse(false, 502, null)) as never;
    const error = await rejection('/x');
    expect(error.name).toBe('ApiError');
    expect(error.status).toBe(502);
    expect(error.code).toBe('UNKNOWN_ERROR');
    expect(error.message).toBe('An unexpected error occurred');
    expect(error.retryAfter).toBeUndefined();
  });

  test('reports the generic failure when the body is not an object at all', async () => {
    globalThis.fetch = jest.fn(async () => mockResponse(false, 500, 'gateway said no')) as never;
    const error = await rejection('/x');
    expect(error.code).toBe('UNKNOWN_ERROR');
    expect(error.message).toBe('An unexpected error occurred');
    expect(error.retryAfter).toBeUndefined();
  });

  test('ignores a top-level message and code that are not strings', async () => {
    globalThis.fetch = jest.fn(async () => mockResponse(false, 500, { message: 42, code: 7 })) as never;
    const error = await rejection('/x');
    expect(error.message).toBe('An unexpected error occurred');
    expect(error.code).toBe('UNKNOWN_ERROR');
  });

  test('never uses an object `error` as the message, but still reads its code and retryAfter', async () => {
    globalThis.fetch = jest.fn(async () => mockResponse(false, 503, { error: { code: 'UNAVAILABLE', retryAfter: 5 } })) as never;
    const error = await rejection('/x');
    expect(error.message).toBe('An unexpected error occurred');
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.retryAfter).toBe(5);
  });
});

describe('apiRequest request init', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sends a bodyless request with credentials, no cache and no Content-Type', async () => {
    const calls = recordFetch();
    await apiRequest('/projects');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API_BASE_URL}/projects`);
    expect(calls[0]?.init).toEqual({
      credentials: 'include',
      cache: 'no-store',
      headers: {},
    });
  });

  test('declares Content-Type: application/json when there is a body', async () => {
    const calls = recordFetch();
    await apiRequest('/projects', { method: 'POST', body: JSON.stringify({ name: 'p' }) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API_BASE_URL}/projects`);
    expect(calls[0]?.init).toEqual({
      method: 'POST',
      body: '{"name":"p"}',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  test("caller headers are merged over the transport's own", async () => {
    const calls = recordFetch();
    await apiRequest('/projects/1', {
      method: 'PATCH',
      body: '{}',
      headers: { 'Content-Type': 'text/plain', 'X-Trace': 'abc' },
    });
    expect(calls[0]?.init?.headers).toEqual({ 'Content-Type': 'text/plain', 'X-Trace': 'abc' });
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.credentials).toBe('include');
  });
});
