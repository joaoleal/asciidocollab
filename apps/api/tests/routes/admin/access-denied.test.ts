import Fastify from 'fastify';
import { accessDeniedRoute } from '../../../src/routes/admin/access-denied';
import { decorateApp } from '../../helpers/decorate-app';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

function buildTestServer() {
  const app = Fastify();
  const savedLogs: unknown[] = [];

  decorateApp(app, 'repos', {
    auditLog: {
      save: jest.fn().mockImplementation((log: unknown) => { savedLogs.push(log); }),
    },
  });

  decorateApp(app, 'config', {});

  app.register(accessDeniedRoute);
  return { app, savedLogs };
}

function buildUnauthenticatedServer() {
  const { requireAuth } = jest.requireMock('../../../src/plugins/require-auth');
  (requireAuth as jest.Mock).mockImplementationOnce((_r: unknown, reply: { status: (n: number) => { send: (b: unknown) => void } }) => {
    reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  });
  return buildTestServer();
}

describe('POST /admin/access-denied', () => {
  test('authenticated request saves AuditLog and returns 204', async () => {
    const { app, savedLogs } = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/access-denied',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: '/dashboard/admin/settings' }),
    });
    expect(response.statusCode).toBe(204);
    expect(savedLogs).toHaveLength(1);
    const log = savedLogs[0] as { action: string; resourceType: string; resourceId: string };
    expect(log.action).toBe('UNAUTHORIZED_PAGE_ACCESS');
    expect(log.resourceType).toBe('PAGE');
    expect(log.resourceId).toBe('/dashboard/admin/settings');
  });

  test('unauthenticated request returns 401', async () => {
    const { app } = buildUnauthenticatedServer();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/access-denied',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: '/dashboard/admin/settings' }),
    });
    expect(response.statusCode).toBe(401);
  });

  test('missing resource field returns 400', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/access-denied',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.statusCode).toBe(400);
  });
});
