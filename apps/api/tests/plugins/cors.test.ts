import Fastify, { type FastifyInstance } from 'fastify';
import { corsPluginWrapped } from '../../src/plugins/cors';
import { decorateApp } from '../helpers/decorate-app';

async function buildApp(api: { corsOrigins?: string }): Promise<FastifyInstance> {
  const app = Fastify();
  decorateApp(app, 'config', { api });
  await app.register(corsPluginWrapped);
  app.get('/thing', async (_request, reply) => reply.status(200).send({ ok: true }));
  await app.ready();
  return app;
}

describe('corsPlugin', () => {
  it('reflects a configured origin and trims the comma-separated list', async () => {
    const app = await buildApp({ corsOrigins: 'https://app.example.com, https://admin.example.com' });

    const response = await app.inject({
      method: 'GET',
      url: '/thing',
      headers: { origin: 'https://admin.example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://admin.example.com');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    await app.close();
  });

  it('rejects an origin that is not on the configured list', async () => {
    const app = await buildApp({ corsOrigins: 'https://app.example.com' });

    const response = await app.inject({
      method: 'GET',
      url: '/thing',
      headers: { origin: 'https://evil.example.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('allows no cross-origin request at all when no origins are configured', async () => {
    const app = await buildApp({});

    const response = await app.inject({
      method: 'GET',
      url: '/thing',
      headers: { origin: 'https://app.example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});
