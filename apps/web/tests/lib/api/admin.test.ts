/**
 * Direct unit tests for the admin API client (`src/lib/api/admin.ts`).
 *
 * The barrel-level suite in `tests/lib/api.test.ts` asserts that each URL *contains*
 * the expected path. These tests pin the whole request instead — the exact URL (so a
 * dropped endpoint or a stray query-string suffix is caught), the method, the
 * credentials and the exact JSON payload — plus the error paths.
 */
import { adminApi } from '@/lib/api/admin';
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

/** The request body of the single fetch, parsed back from JSON. */
function requestBody(): unknown {
  return JSON.parse(String(requestInit().body));
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('adminApi.inviteUser', () => {
  test('POSTs the invitee email to /admin/users/invite', async () => {
    okOnce(undefined);

    await adminApi.inviteUser('new@example.com');

    expect(requestUrl()).toBe(`${API_BASE_URL}/admin/users/invite`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().body).toBe(JSON.stringify({ email: 'new@example.com' }));
    expect(requestBody()).toEqual({ email: 'new@example.com' });
    expect(requestInit().credentials).toBe('include');
    expect((requestInit().headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  test('surfaces a rejected invitation', async () => {
    failOnce(409, { error: { code: 'USER_EXISTS', message: 'That user already has an account' } });

    await expect(adminApi.inviteUser('new@example.com')).rejects.toMatchObject({
      status: 409,
      code: 'USER_EXISTS',
      message: 'That user already has an account',
    });
  });
});

describe('adminApi.acceptInvite', () => {
  test('POSTs the token, display name and password to /auth/accept-invite', async () => {
    okOnce(undefined);

    await adminApi.acceptInvite('tok123', 'Alice', 'Password1!');

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/accept-invite`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().body).toBe(
      JSON.stringify({ token: 'tok123', displayName: 'Alice', password: 'Password1!' }),
    );
    expect(requestBody()).toEqual({ token: 'tok123', displayName: 'Alice', password: 'Password1!' });
  });

  test('surfaces an expired invitation token', async () => {
    failOnce(400, { error: { code: 'TOKEN_EXPIRED', message: 'Invitation has expired' } });

    await expect(adminApi.acceptInvite('tok123', 'Alice', 'Password1!')).rejects.toMatchObject({
      status: 400,
      code: 'TOKEN_EXPIRED',
      message: 'Invitation has expired',
    });
  });

  test('getAcceptInvitePreview GETs the URL-encoded token without a body', async () => {
    okOnce({ email: 'invited@example.com' });

    await adminApi.getAcceptInvitePreview('tok/123 abc');

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/accept-invite?token=${encodeURIComponent('tok/123 abc')}`);
    expect(requestInit().body).toBeUndefined();
    expect(requestInit().method).toBeUndefined();
  });
});

describe('adminApi.setAdminStatus', () => {
  test('PATCHes the isAdmin flag to /admin/users/:id/admin', async () => {
    okOnce(undefined);

    await adminApi.setAdminStatus('u1', true);

    expect(requestUrl()).toBe(`${API_BASE_URL}/admin/users/u1/admin`);
    expect(requestInit().method).toBe('PATCH');
    expect(requestInit().body).toBe(JSON.stringify({ isAdmin: true }));
    expect(requestBody()).toEqual({ isAdmin: true });
  });

  test('sends isAdmin false when revoking the privilege', async () => {
    okOnce(undefined);

    await adminApi.setAdminStatus('u1', false);

    expect(requestInit().body).toBe(JSON.stringify({ isAdmin: false }));
    expect(requestBody()).toEqual({ isAdmin: false });
  });

  test('surfaces a refusal to demote the last admin', async () => {
    failOnce(400, { error: { code: 'LAST_ADMIN', message: 'Cannot demote the last administrator' } });

    await expect(adminApi.setAdminStatus('u1', false)).rejects.toMatchObject({
      status: 400,
      code: 'LAST_ADMIN',
      message: 'Cannot demote the last administrator',
    });
  });
});

describe('adminApi.removeUser', () => {
  test('DELETEs /admin/users/:id without a JSON content type', async () => {
    okOnce(undefined);

    await adminApi.removeUser('u1');

    expect(requestUrl()).toBe(`${API_BASE_URL}/admin/users/u1`);
    expect(requestInit().method).toBe('DELETE');
    expect(requestInit().body).toBeUndefined();
    expect((requestInit().headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });
});

describe('adminApi settings', () => {
  test('getAdminSettings GETs /admin/settings', async () => {
    okOnce({ openRegistration: true, maxUploadSizeBytes: 1024 });

    const result = await adminApi.getAdminSettings();

    expect(requestUrl()).toBe(`${API_BASE_URL}/admin/settings`);
    expect(requestInit().method).toBeUndefined();
    expect(result).toEqual({ openRegistration: true, maxUploadSizeBytes: 1024 });
  });

  test('updateAdminSettings PATCHes the partial payload to /admin/settings', async () => {
    okOnce({ openRegistration: false });

    await adminApi.updateAdminSettings({ openRegistration: false, maxUploadSizeBytes: 2048 });

    expect(requestUrl()).toBe(`${API_BASE_URL}/admin/settings`);
    expect(requestInit().method).toBe('PATCH');
    expect(requestInit().body).toBe(JSON.stringify({ openRegistration: false, maxUploadSizeBytes: 2048 }));
    expect(requestBody()).toEqual({ openRegistration: false, maxUploadSizeBytes: 2048 });
    expect(requestInit().credentials).toBe('include');
  });

  test('updateAdminSettings surfaces a non-admin rejection', async () => {
    failOnce(403, { error: { code: 'FORBIDDEN', message: 'Administrator privileges required' } });

    await expect(adminApi.updateAdminSettings({ openRegistration: true })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Administrator privileges required',
    });
  });
});

describe('adminApi.getAuditLogs', () => {
  test('requests the bare /admin/audit-logs path when no filters are given', async () => {
    okOnce({ items: [], total: 0, page: 1, limit: 20 });

    await adminApi.getAuditLogs();

    // Exact, not `toContain`: with no filters the endpoint must carry no suffix at all.
    expect(requestUrl()).toBe(`${API_BASE_URL}/admin/audit-logs`);
    expect(requestInit().method).toBeUndefined();
  });

  test('requests the bare path when the filter object is present but empty', async () => {
    okOnce({ items: [], total: 0, page: 1, limit: 20 });

    await adminApi.getAuditLogs({});

    expect(requestUrl()).toBe(`${API_BASE_URL}/admin/audit-logs`);
  });

  test('appends every provided filter as a query string', async () => {
    okOnce({ items: [], total: 0, page: 2, limit: 50 });

    await adminApi.getAuditLogs({
      fromDate: '2026-01-01',
      toDate: '2026-02-01',
      userId: 'u1',
      actionType: 'LOGIN',
      page: 2,
      limit: 50,
    });

    expect(requestUrl()).toBe(
      `${API_BASE_URL}/admin/audit-logs?fromDate=2026-01-01&toDate=2026-02-01&userId=u1&actionType=LOGIN&page=2&limit=50`,
    );
  });

  test('omits filters that are not provided', async () => {
    okOnce({ items: [], total: 0, page: 1, limit: 20 });

    await adminApi.getAuditLogs({ actionType: 'LOGIN' });

    expect(requestUrl()).toBe(`${API_BASE_URL}/admin/audit-logs?actionType=LOGIN`);
  });

  test('surfaces a server failure while listing the audit log', async () => {
    failOnce(500, {});

    await expect(adminApi.getAuditLogs()).rejects.toMatchObject({
      status: 500,
      code: 'UNKNOWN_ERROR',
      message: 'An unexpected error occurred',
    });
  });

  test('getAuditLogActionTypes GETs the action-types endpoint', async () => {
    okOnce({ actionTypes: ['LOGIN', 'LOGOUT'] });

    const result = await adminApi.getAuditLogActionTypes();

    expect(requestUrl()).toBe(`${API_BASE_URL}/admin/audit-logs/action-types`);
    expect(result).toEqual({ actionTypes: ['LOGIN', 'LOGOUT'] });
  });
});

describe('adminApi verification and session endpoints', () => {
  test('resendVerification POSTs with no body, so no Content-Type is declared', async () => {
    okOnce(undefined);

    await adminApi.resendVerification();

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/resend-verification`);
    expect(requestInit().method).toBe('POST');
    expect(requestInit().body).toBeUndefined();
    expect((requestInit().headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  test('verifyEmail GETs the URL-encoded token', async () => {
    okOnce(undefined);

    await adminApi.verifyEmail('v tok&456');

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/verify-email?token=${encodeURIComponent('v tok&456')}`);
  });

  test('getSessionStatus GETs /auth/session-status with credentials', async () => {
    okOnce({ authenticated: true, emailVerified: false, isAdmin: true });

    const result = await adminApi.getSessionStatus();

    expect(requestUrl()).toBe(`${API_BASE_URL}/auth/session-status`);
    expect(requestInit().credentials).toBe('include');
    expect(result).toEqual({ authenticated: true, emailVerified: false, isAdmin: true });
  });
});
