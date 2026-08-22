// authApi behavior — SameSite+Origin approach (no manual CSRF tokens)

function mockOkResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
  });
}

function mockErrorResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    json: jest.fn().mockResolvedValue(body),
  });
}

describe('authApi behavior', () => {
  let fetchMock: jest.Mock;
  let authApi: typeof import('@/lib/api').authApi;
  let ApiError: typeof import('@/lib/api').ApiError;

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ authApi, ApiError } = require('@/lib/api'));
  });

  test('login sends credentials without a CSRF token fetch', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ message: 'Authenticated' }));

    await authApi.login('user@example.com', 'Password1!');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/login');
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('x-csrf-token');
  });

  test('register sends credentials without a CSRF token fetch', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ message: 'Account created' }));

    await authApi.register('user@example.com', 'Password1!', 'User');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/register');
  });

  test('logout does not send a CSRF token', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ message: 'Logged out' }));

    await authApi.logout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('x-csrf-token');
  });

  test('login propagates API errors', async () => {
    fetchMock.mockReturnValueOnce(
      mockErrorResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Bad credentials' } }),
    );

    await expect(authApi.login('user@example.com', 'wrong')).rejects.toBeInstanceOf(ApiError);
  });

  test('error response without an error field falls back to default code and message', async () => {
    fetchMock.mockReturnValueOnce(mockErrorResponse(500, {}));
    await expect(authApi.login('user@example.com', 'wrong')).rejects.toMatchObject({
      status: 500,
      code: 'UNKNOWN_ERROR',
      message: 'An unexpected error occurred',
      retryAfter: undefined,
    });
  });

  test('error response propagates retryAfter when present', async () => {
    fetchMock.mockReturnValueOnce(
      mockErrorResponse(429, { error: { code: 'RATE_LIMITED', message: 'Slow down', retryAfter: 30 } }),
    );
    await expect(authApi.login('user@example.com', 'wrong')).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      retryAfter: 30,
    });
  });

  test('multiple calls do not generate extra requests', async () => {
    fetchMock
      .mockReturnValueOnce(mockOkResponse({ message: 'Authenticated' }))
      .mockReturnValueOnce(mockOkResponse({ message: 'Authenticated' }));

    await authApi.login('user@example.com', 'Password1!');
    await authApi.login('user@example.com', 'Password1!');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('setupStatus fetches /auth/setup-status', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ configured: true, passwordPolicy: { minLength: 8, requireUppercase: true, requireLowercase: true, requireDigits: true, requireSymbols: false } }));
    const result = await authApi.setupStatus();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/setup-status');
    expect(result.configured).toBe(true);
  });

  test('me fetches /auth/me', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ userId: 'u1', displayName: 'Alice', email: 'alice@example.com' }));
    const result = await authApi.me();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/me');
    expect(result.userId).toBe('u1');
  });

  test('requestPasswordReset sends POST to /auth/password/reset/request', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ message: 'Reset link sent' }));
    await authApi.requestPasswordReset('alice@example.com');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/password/reset/request');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  test('resetPassword sends POST to /auth/password/reset', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ message: 'Password reset' }));
    await authApi.resetPassword('tok123', 'NewPass1!');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/password/reset');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  test('changePassword sends POST to /auth/password/change', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ message: 'Password changed' }));
    await authApi.changePassword('OldPass1!', 'NewPass1!');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/password/change');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  test('requestEmailChange sends POST to /auth/email/change-request', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ message: 'Verification sent' }));
    await authApi.requestEmailChange('new@example.com');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/email/change-request');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  test('updateProfile sends PATCH to /auth/me/profile with the payload', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ message: 'Profile updated' }));
    const result = await authApi.updateProfile({ displayName: 'Renamed' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/me/profile');
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(fetchMock.mock.calls[0][1].body).toContain('Renamed');
    expect(result.message).toBe('Profile updated');
  });
});

describe('projectsApi behavior', () => {
  let fetchMock: jest.Mock;
  let projectsApi: typeof import('@/lib/api').projectsApi;
  let ApiError: typeof import('@/lib/api').ApiError;

  const mockProject = { id: 'p1', name: 'Test', description: null, owners: [], tags: [], rootFolderId: null, archivedAt: null, createdAt: '', updatedAt: '' };

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ projectsApi, ApiError } = require('@/lib/api'));
  });

  test('list fetches /api/projects without query string when no params', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } }));
    await projectsApi.list();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/projects');
    expect(url).not.toContain('?');
  });

  test('list appends page, limit, archived params when provided', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: [], pagination: { page: 2, limit: 5, total: 10, totalPages: 2 } }));
    await projectsApi.list({ page: 2, limit: 5, archived: false });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('page=2');
    expect(url).toContain('limit=5');
    expect(url).toContain('archived=false');
  });

  test('get fetches /api/projects/:id and returns the project', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: mockProject }));
    const result = await projectsApi.get('p1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/projects/p1');
    expect(result.data.id).toBe('p1');
  });

  test('create sends POST and returns created project', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: mockProject }));
    const result = await projectsApi.create({ name: 'Test', description: 'desc' });
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(result.data.name).toBe('Test');
  });

  test('update sends PATCH to /api/projects/:id', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: { ...mockProject, name: 'Updated' } }));
    const result = await projectsApi.update('p1', { name: 'Updated' });
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/projects/p1');
    expect(result.data.name).toBe('Updated');
  });

  test('archive sends POST to /api/projects/:id/archive', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: { id: 'p1', archivedAt: '2024-01-01T00:00:00Z' } }));
    const result = await projectsApi.archive('p1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/archive');
    expect(result.data.archivedAt).toBe('2024-01-01T00:00:00Z');
  });

  test('restore sends POST to /api/projects/:id/restore', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: { id: 'p1', archivedAt: null } }));
    const result = await projectsApi.restore('p1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/restore');
    expect(result.data.archivedAt).toBeNull();
  });

  test('delete sends DELETE to /api/projects/:id', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: { id: 'p1' } }));
    await projectsApi.delete('p1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/projects/p1');
  });

  test('list throws ApiError on non-ok response', async () => {
    fetchMock.mockReturnValueOnce(mockErrorResponse(403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } }));
    await expect(projectsApi.list()).rejects.toBeInstanceOf(ApiError);
  });

  test('create throws ApiError on non-ok response', async () => {
    fetchMock.mockReturnValueOnce(mockErrorResponse(409, { error: { code: 'CONFLICT', message: 'Name taken' } }));
    await expect(projectsApi.create({ name: 'Taken' })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('membersApi behavior', () => {
  let fetchMock: jest.Mock;
  let membersApi: typeof import('@/lib/api').membersApi;
  let ApiError: typeof import('@/lib/api').ApiError;

  const mockMember = { userId: 'u1', email: 'alice@example.com', displayName: 'Alice', role: 'viewer' as const, joinedAt: '' };

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ membersApi, ApiError } = require('@/lib/api'));
  });

  test('list fetches /api/projects/:id/members', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: { members: [mockMember] } }));
    const result = await membersApi.list('p1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/projects/p1/members');
    expect(result.data.members).toHaveLength(1);
  });

  test('invite sends POST and returns new member', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: mockMember }));
    const result = await membersApi.invite('p1', { email: 'alice@example.com', role: 'viewer' });
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(result.data.userId).toBe('u1');
  });

  test('updateRole sends PATCH to /api/projects/:id/members/:userId', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: { userId: 'u1', role: 'editor' } }));
    const result = await membersApi.updateRole('p1', 'u1', 'editor');
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/members/u1');
    expect(result.data.role).toBe('editor');
  });

  test('remove sends DELETE to /api/projects/:id/members/:userId', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: { message: 'Removed' } }));
    await membersApi.remove('p1', 'u1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/members/u1');
  });

  test('invite throws ApiError on non-ok response', async () => {
    fetchMock.mockReturnValueOnce(mockErrorResponse(404, { error: { code: 'USER_NOT_FOUND', message: 'User not found' } }));
    await expect(membersApi.invite('p1', { email: 'nobody@example.com', role: 'viewer' })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('usersApi behavior', () => {
  let fetchMock: jest.Mock;
  let usersApi: typeof import('@/lib/api').usersApi;

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ usersApi } = require('@/lib/api'));
  });

  test('search fetches /api/users/search with query param', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: { users: [] } }));
    await usersApi.search('alice');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/users/search');
    expect(url).toContain('q=alice');
  });

  test('search includes excludeProjectId when provided', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: { users: [] } }));
    await usersApi.search('alice', 'p1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('excludeProjectId=p1');
  });

  test('search omits excludeProjectId when not provided', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ data: { users: [] } }));
    await usersApi.search('bob');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('excludeProjectId');
  });
});

describe('adminApi behavior', () => {
  let fetchMock: jest.Mock;
  let adminApi: typeof import('@/lib/api').adminApi;

  beforeEach(() => {
    jest.resetModules();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    ({ adminApi } = require('@/lib/api'));
  });

  test('inviteUser sends POST to /admin/users/invite', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse(undefined));
    await adminApi.inviteUser('new@example.com');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/admin/users/invite');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  test('getAcceptInvitePreview fetches /auth/accept-invite with token', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ email: 'invited@example.com' }));
    const result = await adminApi.getAcceptInvitePreview('tok123');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/accept-invite');
    expect(String(fetchMock.mock.calls[0][0])).toContain('tok123');
    expect(result.email).toBe('invited@example.com');
  });

  test('acceptInvite sends POST to /auth/accept-invite', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse(undefined));
    await adminApi.acceptInvite('tok123', 'Alice', 'Pass1!');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/accept-invite');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  test('getAdminUsers fetches /admin/users', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ users: [] }));
    const result = await adminApi.getAdminUsers();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/admin/users');
    expect(result.users).toHaveLength(0);
  });

  test('setAdminStatus sends PATCH to /admin/users/:id/admin', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse(undefined));
    await adminApi.setAdminStatus('u1', true);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/admin/users/u1/admin');
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
  });

  test('getUserRemovalPreview fetches /admin/users/:id/removal-preview', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ projectsToTransfer: [] }));
    const result = await adminApi.getUserRemovalPreview('u1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/removal-preview');
    expect(result.projectsToTransfer).toHaveLength(0);
  });

  test('removeUser sends DELETE to /admin/users/:id', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse(undefined));
    await adminApi.removeUser('u1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/admin/users/u1');
  });

  test('getAdminSettings fetches /admin/settings', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ openRegistration: true }));
    const result = await adminApi.getAdminSettings();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/admin/settings');
    expect(result.openRegistration).toBe(true);
  });

  test('updateAdminSettings sends PATCH to /admin/settings', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ openRegistration: false }));
    const result = await adminApi.updateAdminSettings({ openRegistration: false });
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(result.openRegistration).toBe(false);
  });

  test('getOpenRegistrationStatus fetches /auth/open-registration-status', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ openRegistration: true }));
    await adminApi.getOpenRegistrationStatus();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/open-registration-status');
  });

  test('resendVerification sends POST to /auth/resend-verification', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse(undefined));
    await adminApi.resendVerification();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/resend-verification');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  test('verifyEmail fetches /auth/verify-email with token', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse(undefined));
    await adminApi.verifyEmail('vtok456');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/verify-email');
    expect(String(fetchMock.mock.calls[0][0])).toContain('vtok456');
  });

  test('getSessionStatus fetches /auth/session-status', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ authenticated: true, emailVerified: true, isAdmin: false }));
    const result = await adminApi.getSessionStatus();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/session-status');
    expect(result.authenticated).toBe(true);
  });

  test('getAuditLogs without filters omits the query string', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ items: [], total: 0, page: 1, limit: 20 }));
    await adminApi.getAuditLogs();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/admin/audit-logs');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('?');
  });

  test('getAuditLogs encodes every provided filter into the query string', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ items: [], total: 0, page: 2, limit: 50 }));
    await adminApi.getAuditLogs({
      fromDate: '2026-01-01',
      toDate: '2026-02-01',
      userId: 'u1',
      actionType: 'LOGIN',
      page: 2,
      limit: 50,
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('fromDate=2026-01-01');
    expect(url).toContain('toDate=2026-02-01');
    expect(url).toContain('userId=u1');
    expect(url).toContain('actionType=LOGIN');
    expect(url).toContain('page=2');
    expect(url).toContain('limit=50');
  });

  test('getAuditLogActionTypes fetches /admin/audit-logs/action-types', async () => {
    fetchMock.mockReturnValueOnce(mockOkResponse({ actionTypes: ['LOGIN', 'LOGOUT'] }));
    const result = await adminApi.getAuditLogActionTypes();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/admin/audit-logs/action-types');
    expect(result.actionTypes).toEqual(['LOGIN', 'LOGOUT']);
  });
});
