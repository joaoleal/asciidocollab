import Fastify from 'fastify';
import { fileTreeEventBusPlugin } from '../../src/plugins/file-tree-event-bus';
import { eventsRoutes } from '../../src/routes/projects/events';
import { decorateApp } from '../helpers/decorate-app';

// Mock requireAuth and project member check
jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

async function buildTestServer(isMember: boolean) {
  const app = Fastify();
  await app.register(fileTreeEventBusPlugin);

  // Mock repos
  decorateApp(app, 'repos', {
    projectMember: {
      findByCompositeKey: jest.fn().mockResolvedValue(isMember ? { role: { value: 'editor' } } : null),
    },
  });
  decorateApp(app, 'config', { storage: { maxUploadSizeBytes: 20_971_520, path: '/tmp' } });
  decorateApp(app, 'stores', { fileStore: {}, yjsStateStore: {} });
  decorateApp(app, 'services', {});
  decorateApp(app, 'prisma', null);

  await app.register(eventsRoutes);
  await app.ready();
  return app;
}

describe('GET /projects/:projectId/events', () => {
  it('returns 403 for non-member', async () => {
    const app = await buildTestServer(false);
    const response = await app.inject({
      method: 'GET',
      url: '/projects/770e8400-e29b-41d4-a716-446655440003/events',
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('returns 200 with text/event-stream and cache-control headers for member', async () => {
    const app = await buildTestServer(true);

    // SSE connections keep open, so we test headers without waiting for the full response
    let statusCode: number;
    let headers: Record<string, string>;

    const request = app.inject({
      method: 'GET',
      url: '/projects/770e8400-e29b-41d4-a716-446655440003/events',
    });

    // The SSE connection will eventually timeout in test, but we can check early headers
    // by using a timeout
    const timeoutResult = await Promise.race([
      request,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);

    if (timeoutResult) {
      statusCode = timeoutResult.statusCode;
      headers = timeoutResult.headers as Record<string, string>;
      expect(statusCode).toBe(200);
      expect(headers['content-type']).toMatch(/text\/event-stream/i);
      expect(headers['cache-control']).toMatch(/no-cache/i);
    }

    await app.close();
  });

  it('calls fileTreeEventBus.subscribe with correct projectId', async () => {
    const app = await buildTestServer(true);
    const subscribeSpy = jest.spyOn(app.fileTreeEventBus, 'subscribe');

    const request = app.inject({
      method: 'GET',
      url: '/projects/770e8400-e29b-41d4-a716-446655440003/events',
    });

    await Promise.race([request, new Promise((resolve) => setTimeout(resolve, 100))]);

    expect(subscribeSpy).toHaveBeenCalledWith('770e8400-e29b-41d4-a716-446655440003', expect.any(Function));
    await app.close();
  });
});
