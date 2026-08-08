import Fastify from 'fastify';
import { ListAuditLogsUseCase } from '@asciidocollab/domain';
import { auditLogsRoute } from '../../../src/routes/admin/audit-logs';
import { decorateApp } from '../../helpers/decorate-app';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

jest.mock('../../../src/plugins/require-admin', () => ({
  requireAdmin: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
}));

const mockAuditLogs = [
  {
    id: { value: 'log-1111-1111-1111-111111111111' },
    userId: { value: '550e8400-e29b-41d4-a716-446655440001' },
    projectId: null,
    action: 'ACTION_A',
    resourceType: 'PAGE',
    resourceId: '/test',
    timestamp: new Date('2024-01-01T00:00:00Z'),
    metadata: {},
  },
];

function buildTestServer(overrides?: Partial<{ findWithFiltersResult: unknown; findDistinctResult: unknown }>) {
  const app = Fastify();

  decorateApp(app, 'repos', {
    auditLog: {
      findWithFilters: jest.fn().mockResolvedValue({
        items: mockAuditLogs,
        total: 1,
        page: 1,
        limit: 50,
      }),
      findDistinctActionTypes: jest.fn().mockResolvedValue(['ACTION_A', 'ACTION_B']),
      ...overrides,
    },
    user: {
      findById: jest.fn().mockResolvedValue({
        id: { value: '550e8400-e29b-41d4-a716-446655440001' },
        displayName: 'Admin User',
        isAdmin: true,
      }),
    },
  });

  decorateApp(app, 'config', {
    admin: { auditLog: { rateLimitMax: 1000, rateLimitWindow: 60_000 } },
  });

  app.register(auditLogsRoute);
  return app;
}

function buildNonAdminServer() {
  const { requireAdmin } = jest.requireMock('../../../src/plugins/require-admin');
  (requireAdmin as jest.Mock).mockImplementationOnce((_r: unknown, reply: { status: (n: number) => { send: (b: unknown) => void } }) => {
    reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Admin required' } });
  });
  return buildTestServer();
}

describe('GET /admin/audit-logs', () => {
  test('returns paged audit logs with correct shape', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/admin/audit-logs' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('page');
    expect(body).toHaveProperty('limit');
    expect(body.items[0]).toHaveProperty('action', 'ACTION_A');
  });

  test('defaults limit to 50 when not specified', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/admin/audit-logs' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.limit).toBe(50);
  });

  test('wires filter query params to repository', async () => {
    const app = buildTestServer();
    await app.inject({ method: 'GET', url: '/admin/audit-logs?actionType=ACTION_A&page=2&limit=10' });
    const repos = (app as unknown as { repos: { auditLog: { findWithFilters: jest.Mock } } }).repos;
    expect(repos.auditLog.findWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'ACTION_A' }),
      expect.objectContaining({ page: 2, limit: 10 }),
    );
  });

  test('returns 403 for non-admin', async () => {
    const app = buildNonAdminServer();
    const response = await app.inject({ method: 'GET', url: '/admin/audit-logs' });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /admin/audit-logs/action-types', () => {
  test('returns distinct action types', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/admin/audit-logs/action-types' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('actionTypes');
    expect(Array.isArray(body.actionTypes)).toBe(true);
  });
});

describe('Rate limiting', () => {
  test('GET /admin/audit-logs returns 429 when limit is exceeded', async () => {
    const rateLimit = require('@fastify/rate-limit') as { default: typeof import('@fastify/rate-limit')['default'] };
    const app = Fastify();

    decorateApp(app, 'repos', {
      auditLog: {
        findWithFilters: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 }),
        findDistinctActionTypes: jest.fn().mockResolvedValue([]),
      },
      user: { findById: jest.fn().mockResolvedValue({ id: { value: 'u1' }, displayName: 'Admin', isAdmin: true }) },
    });
    decorateApp(app, 'config', { admin: { auditLog: { rateLimitMax: 1, rateLimitWindow: 60_000 } } });

    await app.register(rateLimit.default, { global: false });
    app.register(auditLogsRoute);
    await app.ready();

    await app.inject({ method: 'GET', url: '/admin/audit-logs' });
    const response = await app.inject({ method: 'GET', url: '/admin/audit-logs' });
    expect(response.statusCode).toBe(429);
  });
});

describe('GET /admin/audit-logs — use case failure', () => {
  afterEach(() => jest.restoreAllMocks());

  test('returns 403 FORBIDDEN when use case returns failure', async () => {
    jest.spyOn(ListAuditLogsUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: Object.assign(new Error('Permission denied'), { name: 'PermissionDeniedError' }) as never,
    });
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/admin/audit-logs' });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN');
  });
});

describe('GET /admin/audit-logs — filter and DTO branches', () => {
  test('parses fromDate and toDate when provided', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit-logs?fromDate=2024-01-01T00:00:00Z&toDate=2024-12-31T23:59:59Z',
    });
    expect(response.statusCode).toBe(200);
    const repos = (app as unknown as { repos: { auditLog: { findWithFilters: jest.Mock } } }).repos;
    expect(repos.auditLog.findWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        fromDate: expect.any(Date),
        toDate: expect.any(Date),
      }),
      expect.anything(),
    );
  });

  test('maps null userId to null in DTO', async () => {
    const app = buildTestServer();
    // Override mock to return log with no userId
    const repos = (app as unknown as { repos: { auditLog: { findWithFilters: jest.Mock } } }).repos;
    repos.auditLog.findWithFilters.mockResolvedValue({
      items: [{
        id: { value: 'log-null-user' },
        userId: null,
        projectId: null,
        action: 'ACTION_NULL',
        resourceType: 'PAGE',
        resourceId: '/page',
        timestamp: new Date('2024-06-01T00:00:00Z'),
        metadata: {},
      }],
      total: 1,
      page: 1,
      limit: 50,
    });
    const response = await app.inject({ method: 'GET', url: '/admin/audit-logs' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.items[0].userId).toBeNull();
  });
});
