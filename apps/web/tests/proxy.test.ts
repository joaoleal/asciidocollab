// Tests for the Next.js proxy (middleware) in src/proxy.ts — auth + email-verification gate.

import { NextRequest } from 'next/server';
import { proxy, config } from '@/proxy';

const PROTECTED_PATH = '/dashboard/projects/42';

/** Builds a NextRequest for a dashboard path, optionally carrying a Cookie header. */
function buildRequest(pathname: string, cookieHeader?: string): NextRequest {
  const headers = new Headers();
  if (cookieHeader !== undefined) headers.set('cookie', cookieHeader);
  return new NextRequest(new URL(`https://app.example.com${pathname}`), { headers });
}

/** The slice of `Response` the proxy reads. */
type FakeResponse = Pick<Response, 'ok' | 'json'>;

/** Builds a fake fetch Response resolving to the given session-status body. */
function sessionResponse(body: unknown, ok = true): FakeResponse {
  const json = jest.fn().mockResolvedValue(body);
  return { ok, json };
}

describe('proxy', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('passes through (NextResponse.next) for a verified, authenticated user', async () => {
    fetchMock.mockResolvedValue(sessionResponse({ authenticated: true, emailVerified: true }));

    const response = await proxy(buildRequest(PROTECTED_PATH, 'sessionId=abc'));

    // NextResponse.next() carries the x-middleware-next marker and no redirect Location.
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  test('forwards the incoming cookie header to the session-status endpoint with no-store', async () => {
    fetchMock.mockResolvedValue(sessionResponse({ authenticated: true, emailVerified: true }));

    await proxy(buildRequest(PROTECTED_PATH, 'sessionId=abc; _csrf=xyz'));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/session-status'),
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: 'sessionId=abc; _csrf=xyz' }),
        cache: 'no-store',
      }),
    );
  });

  test('sends an empty cookie header when the request carries no cookies', async () => {
    fetchMock.mockResolvedValue(sessionResponse({ authenticated: true, emailVerified: true }));

    await proxy(buildRequest(PROTECTED_PATH));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: '' }) }),
    );
  });

  test('redirects to /login with reason=unauthenticated when the session API returns non-ok', async () => {
    fetchMock.mockResolvedValue(sessionResponse({}, false));

    const response = await proxy(buildRequest(PROTECTED_PATH));
    const location = response.headers.get('location') ?? '';
    const url = new URL(location);

    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('reason')).toBe('unauthenticated');
    expect(url.searchParams.get('redirect')).toBe(PROTECTED_PATH);
  });

  test('redirects unauthenticated users to /login preserving the requested path', async () => {
    fetchMock.mockResolvedValue(sessionResponse({ authenticated: false }));

    const response = await proxy(buildRequest(PROTECTED_PATH));
    const url = new URL(response.headers.get('location') ?? '');

    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('reason')).toBe('unauthenticated');
    expect(url.searchParams.get('redirect')).toBe(PROTECTED_PATH);
  });

  test('redirects authenticated-but-unverified users to /verify-email-required', async () => {
    fetchMock.mockResolvedValue(sessionResponse({ authenticated: true, emailVerified: false }));

    const response = await proxy(buildRequest(PROTECTED_PATH));
    const url = new URL(response.headers.get('location') ?? '');

    expect(url.pathname).toBe('/verify-email-required');
  });

  test('treats a missing emailVerified flag as unverified', async () => {
    fetchMock.mockResolvedValue(sessionResponse({ authenticated: true }));

    const response = await proxy(buildRequest(PROTECTED_PATH));
    const url = new URL(response.headers.get('location') ?? '');

    expect(url.pathname).toBe('/verify-email-required');
  });

  test('redirects to /login (catch branch) when the session fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const response = await proxy(buildRequest(PROTECTED_PATH));
    const url = new URL(response.headers.get('location') ?? '');

    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('reason')).toBe('unauthenticated');
    // The catch branch does not have access to the resolved pathname for ?redirect.
    expect(url.searchParams.get('redirect')).toBeNull();
  });

  test('redirects to /login (catch branch) when the response body is not valid JSON', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: jest.fn().mockRejectedValue(new Error('bad json')) });

    const response = await proxy(buildRequest(PROTECTED_PATH));
    const url = new URL(response.headers.get('location') ?? '');

    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('reason')).toBe('unauthenticated');
  });

  test('treats a null session body as unauthenticated', async () => {
    fetchMock.mockResolvedValue(sessionResponse(null));

    const response = await proxy(buildRequest(PROTECTED_PATH));
    const url = new URL(response.headers.get('location') ?? '');

    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('reason')).toBe('unauthenticated');
  });

  test('config matcher scopes the middleware to /dashboard subpaths only', () => {
    expect(config.matcher).toEqual(['/dashboard/:path*']);
  });
});

describe('proxy INTERNAL_API_URL resolution', () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('prefers INTERNAL_API_URL over NEXT_PUBLIC_API_URL', async () => {
    process.env = { ...ORIGINAL_ENV, INTERNAL_API_URL: 'http://internal:5000', NEXT_PUBLIC_API_URL: 'http://public:6000' };
    jest.resetModules();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ authenticated: true, emailVerified: true }) });
    globalThis.fetch = fetchMock;

    const { proxy: freshProxy } = require('@/proxy');
    await freshProxy(buildRequest(PROTECTED_PATH));

    expect(fetchMock).toHaveBeenCalledWith('http://internal:5000/auth/session-status', expect.anything());
  });

  test('falls back to NEXT_PUBLIC_API_URL when INTERNAL_API_URL is unset', async () => {
    process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_API_URL: 'http://public:6000' };
    delete process.env.INTERNAL_API_URL;
    jest.resetModules();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ authenticated: true, emailVerified: true }) });
    globalThis.fetch = fetchMock;

    const { proxy: freshProxy } = require('@/proxy');
    await freshProxy(buildRequest(PROTECTED_PATH));

    expect(fetchMock).toHaveBeenCalledWith('http://public:6000/auth/session-status', expect.anything());
  });

  test('falls back to the localhost default when no API URL env is set', async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.INTERNAL_API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    jest.resetModules();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ authenticated: true, emailVerified: true }) });
    globalThis.fetch = fetchMock;

    const { proxy: freshProxy } = require('@/proxy');
    await freshProxy(buildRequest(PROTECTED_PATH));

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/auth/session-status', expect.anything());
  });
});
