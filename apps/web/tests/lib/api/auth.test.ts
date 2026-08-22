/**
 * Direct unit tests for the auth API client (`src/lib/api/auth.ts`).
 *
 * The barrel-level suite in `tests/lib/api.test.ts` asserts which URL each helper hits.
 * These tests pin the rest of the request — the HTTP method, `credentials`, the
 * Content-Type header and the exact JSON payload — plus the error paths, so a helper
 * that dropped its body, its method or its endpoint cannot pass unnoticed.
 */
import { authApi } from '@/lib/api/auth';
import { API_BASE_URL } from '@/lib/api/base-url';

const fetchMock = jest.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

/** Queues one successful JSON response. */
function okOnce(body: unknown): void {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
}

/** Queues one non-ok JSON response. */
function failOnce(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => body });
}

/** The URL of the single fetch performed by the call under test. */
function requestUrl(): string {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return String(fetchMock.mock.calls[0][0]);
}

/** The init of the single fetch performed by the call under test. */
function requestInit(): RequestInit {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return fetchMock.mock.calls[0][1] as RequestInit;
}

/** The request headers of the single fetch performed by the call under test. */
function requestHeaders(): Record<string, string> {
  return (requestInit().headers ?? {}) as Record<string, string>;
}

/** The request body of the single fetch, parsed back from JSON. */
function requestBody(): unknown {
  return JSON.parse(String(requestInit().body));
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('authApi.login', () => {
  test('POSTs the credentials to /auth/login as a JSON body', async () => {
    okOnce({ message: 'Authenticated' });

    await authApi.login('alice@example.com', 'Password1!');

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/login`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().body).toBe(JSON.stringify({ email: 'alice@example.com', password: 'Password1!' }));
    expect(requestBody()).toEqual({ email: 'alice@example.com', password: 'Password1!' });
  });

  test('sends cookies and declares a JSON content type', async () => {
    okOnce({ message: 'Authenticated' });

    await authApi.login('alice@example.com', 'Password1!');

    expect(requestInit().credentials).toBe('include');
    expect(requestInit().cache).toBe('no-store');
    expect(requestHeaders()['Content-Type']).toBe('application/json');
  });

  test('returns the parsed message from the server', async () => {
    okOnce({ message: 'Authenticated' });

    await expect(authApi.login('alice@example.com', 'Password1!')).resolves.toEqual({ message: 'Authenticated' });
  });

  test('surfaces the server error envelope as status, code and message', async () => {
    failOnce(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Bad credentials' } });

    await expect(authApi.login('alice@example.com', 'nope')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
      message: 'Bad credentials',
    });
  });

  test('surfaces the retry delay of a rate-limited login', async () => {
    failOnce(429, { error: { code: 'RATE_LIMITED', message: 'Slow down', retryAfter: 42 } });

    await expect(authApi.login('alice@example.com', 'Password1!')).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Slow down',
      retryAfter: 42,
    });
  });

  test('reports an ApiError carrying the status when the server answers with non-JSON', async () => {
    // REWRITTEN with the transport fix. This previously asserted the SyntaxError propagated, because
    // the body was parsed BEFORE the `response.ok` check — which meant a proxy's HTML 502 destroyed
    // the status and code, and every `instanceof ApiError` branch fell through during an outage.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    const thrown = await authApi.login('alice@example.com', 'Password1!').catch((error: unknown) => error);

    expect((thrown as { name?: string }).name).toBe('ApiError');
    expect((thrown as { status?: number }).status).toBe(502);
    expect((thrown as { code?: string }).code).toBe('UNKNOWN_ERROR');
    expect((thrown as { message?: string }).message).toBe('An unexpected error occurred');
  });
});

describe('authApi.register', () => {
  test('POSTs email, password and display name to /auth/register', async () => {
    okOnce({ message: 'Account created' });

    await authApi.register('bob@example.com', 'Password1!', 'Bob');

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/register`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().body).toBe(
      JSON.stringify({ email: 'bob@example.com', password: 'Password1!', displayName: 'Bob' }),
    );
    expect(requestBody()).toEqual({ email: 'bob@example.com', password: 'Password1!', displayName: 'Bob' });
    expect(requestInit().credentials).toBe('include');
  });

  test('returns the verification flag from the server', async () => {
    okOnce({ message: 'Account created', requiresEmailVerification: true });

    await expect(authApi.register('bob@example.com', 'Password1!', 'Bob')).resolves.toEqual({
      message: 'Account created',
      requiresEmailVerification: true,
    });
  });

  test('surfaces a duplicate-email conflict', async () => {
    failOnce(409, { error: { code: 'EMAIL_TAKEN', message: 'Email already registered' } });

    await expect(authApi.register('bob@example.com', 'Password1!', 'Bob')).rejects.toMatchObject({
      status: 409,
      code: 'EMAIL_TAKEN',
      message: 'Email already registered',
    });
  });
});

describe('authApi.logout', () => {
  test('POSTs an empty JSON object to /auth/logout', async () => {
    okOnce({ message: 'Logged out' });

    await authApi.logout();

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/logout`);
    expect(requestInit().method).toBe('POST');
    // An explicit `{}` body — a bodyless POST would make the transport omit the
    // Content-Type header, which the server's JSON parser requires here.
    expect(requestInit().body).toBe('{}');
    expect(requestHeaders()['Content-Type']).toBe('application/json');
    expect(requestInit().credentials).toBe('include');
  });

  test('returns the confirmation message', async () => {
    okOnce({ message: 'Logged out' });

    await expect(authApi.logout()).resolves.toEqual({ message: 'Logged out' });
  });

  test('surfaces a rejected logout', async () => {
    failOnce(401, { error: { code: 'UNAUTHORIZED', message: 'No session' } });

    await expect(authApi.logout()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'No session' });
  });
});

describe('authApi read endpoints', () => {
  test('setupStatus GETs /auth/setup-status without a body', async () => {
    okOnce({
      configured: false,
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
    });

    const result = await authApi.setupStatus();

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/setup-status`);
    expect(requestInit().method).toBeUndefined();
    expect(requestInit().body).toBeUndefined();
    // No body to describe, so the transport must not declare a Content-Type.
    expect(requestHeaders()['Content-Type']).toBeUndefined();
    expect(requestInit().credentials).toBe('include');
    expect(result.passwordPolicy.minLength).toBe(12);
  });

  test('me GETs /auth/me and returns the identity', async () => {
    okOnce({ userId: 'u1', displayName: 'Alice', email: 'alice@example.com' });

    const result = await authApi.me();

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/me`);
    expect(requestInit().body).toBeUndefined();
    expect(result).toEqual({ userId: 'u1', displayName: 'Alice', email: 'alice@example.com' });
  });

  test('me surfaces an unauthenticated session', async () => {
    failOnce(401, { error: { code: 'UNAUTHORIZED', message: 'Not signed in' } });

    await expect(authApi.me()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'Not signed in' });
  });
});

describe('authApi password endpoints', () => {
  test('requestPasswordReset POSTs the email to /auth/password/reset/request', async () => {
    okOnce({ message: 'Reset link sent' });

    await authApi.requestPasswordReset('alice@example.com');

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/password/reset/request`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().body).toBe(JSON.stringify({ email: 'alice@example.com' }));
    expect(requestBody()).toEqual({ email: 'alice@example.com' });
  });

  test('resetPassword POSTs the token and the new password to /auth/password/reset', async () => {
    okOnce({ message: 'Password reset' });

    await authApi.resetPassword('tok123', 'NewPass1!');

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/password/reset`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().body).toBe(JSON.stringify({ token: 'tok123', newPassword: 'NewPass1!' }));
    expect(requestBody()).toEqual({ token: 'tok123', newPassword: 'NewPass1!' });
  });

  test('resetPassword surfaces an expired token', async () => {
    failOnce(400, { error: { code: 'TOKEN_EXPIRED', message: 'Reset link has expired' } });

    await expect(authApi.resetPassword('tok123', 'NewPass1!')).rejects.toMatchObject({
      status: 400,
      code: 'TOKEN_EXPIRED',
      message: 'Reset link has expired',
    });
  });

  test('changePassword POSTs both passwords to /auth/password/change', async () => {
    okOnce({ message: 'Password changed' });

    await authApi.changePassword('OldPass1!', 'NewPass1!');

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/password/change`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().body).toBe(JSON.stringify({ currentPassword: 'OldPass1!', newPassword: 'NewPass1!' }));
    expect(requestBody()).toEqual({ currentPassword: 'OldPass1!', newPassword: 'NewPass1!' });
  });

  test('changePassword surfaces a wrong current password', async () => {
    failOnce(400, { error: { code: 'INVALID_PASSWORD', message: 'Current password is incorrect' } });

    await expect(authApi.changePassword('wrong', 'NewPass1!')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_PASSWORD',
      message: 'Current password is incorrect',
    });
  });
});

describe('authApi profile endpoints', () => {
  test('updateProfile PATCHes the whole payload to /auth/me/profile', async () => {
    okOnce({ message: 'Profile updated' });

    await authApi.updateProfile({ displayName: 'Renamed', avatarKey: null, appTheme: 'dark' });

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/me/profile`);
    expect(requestInit().method).toBe('PATCH');
    expect(requestBody()).toEqual({ displayName: 'Renamed', avatarKey: null, appTheme: 'dark' });
  });

  test('requestEmailChange POSTs the new address to /auth/email/change-request', async () => {
    okOnce({ message: 'Verification sent' });

    await authApi.requestEmailChange('new@example.com');

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/email/change-request`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().body).toBe(JSON.stringify({ newEmail: 'new@example.com' }));
    expect(requestBody()).toEqual({ newEmail: 'new@example.com' });
  });

  test('requestEmailChange surfaces a Fastify validation failure', async () => {
    failOnce(400, { statusCode: 400, error: 'Bad Request', code: 'FST_ERR_VALIDATION', message: 'body/newEmail must match format "email"' });

    await expect(authApi.requestEmailChange('not-an-email')).rejects.toMatchObject({
      status: 400,
      code: 'FST_ERR_VALIDATION',
      message: 'body/newEmail must match format "email"',
    });
  });
});
