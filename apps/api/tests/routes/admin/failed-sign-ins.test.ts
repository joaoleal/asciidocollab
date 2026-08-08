import Fastify from 'fastify';
import { failedSignInsRoute } from '../../../src/routes/admin/failed-sign-ins';
import { decorateApp } from '../../helpers/decorate-app';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

jest.mock('../../../src/plugins/require-admin', () => ({
  requireAdmin: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
}));

const mockAttempt = {
  id: { value: '550e8400-e29b-41d4-a716-4466554400aa' },
  identifier: 'user@example.com',
  ipAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  windowStart: new Date('2026-06-10T12:00:00.000Z'),
  attemptCount: 4,
  firstAttemptAt: new Date('2026-06-10T12:01:00.000Z'),
  lastAttemptAt: new Date('2026-06-10T12:09:00.000Z'),
};

function buildApp(isAdmin = true) {
  const app = Fastify();
  decorateApp(app, 'config', {
    failedSignIn: { rateLimitMax: 120, rateLimitWindow: 60_000 },
  });
  decorateApp(app, 'repos', {
    authAttemptTelemetry: {
      findWithFilters: jest.fn().mockResolvedValue({ items: [mockAttempt], total: 1, page: 1, limit: 50 }),
    },
    user: { findById: jest.fn().mockResolvedValue({ id: { value: '550e8400-e29b-41d4-a716-446655440001' }, isAdmin }) },
  });
  app.register(failedSignInsRoute);
  return app;
}

describe('GET /admin/failed-sign-ins', () => {
  it('returns a paged telemetry list for admins', async () => {
    const app = buildApp(true);
    const response = await app.inject({ method: 'GET', url: '/admin/failed-sign-ins?identifier=user@example.com' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      identifier: 'user@example.com',
      ipAddress: '203.0.113.7',
      attemptCount: 4,
    });
    expect(body.items[0].windowStart).toBe('2026-06-10T12:00:00.000Z');
  });

  it('returns 403 for non-admins', async () => {
    const app = buildApp(false);
    const response = await app.inject({ method: 'GET', url: '/admin/failed-sign-ins' });
    expect(response.statusCode).toBe(403);
  });
});
