import { apiRequest, ApiError } from '@/lib/api/transport';

/** A minimal fetch Response stub returning `body` from `.json()`. */
function mockResponse(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, json: async () => body } as unknown as Response;
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
});
