import Fastify from 'fastify';
import { connect } from 'node:net';
import { httpsRedirectPluginWrapped } from '../../src/plugins/https-redirect';
import { decorateApp } from '../helpers/decorate-app';

function buildApp(config: { httpsRedirect: boolean; trustProxy: boolean }) {
  const app = Fastify();
  decorateApp(app, 'config', { api: config });
  app.register(httpsRedirectPluginWrapped);
  app.get('/test', (_request, reply) => reply.status(200).send('ok'));
  return app;
}

describe('httpsRedirectPlugin', () => {
  it('does not redirect when httpsRedirect is disabled', async () => {
    const app = buildApp({ httpsRedirect: false, trustProxy: false });
    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
  });

  it('redirects http to https when trustProxy=false (uses request.protocol)', async () => {
    const app = buildApp({ httpsRedirect: true, trustProxy: false });
    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { host: 'example.com' },
    });
    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toContain('https://example.com/test');
  });

  it('redirects when trustProxy=true and X-Forwarded-Proto is http', async () => {
    const app = buildApp({ httpsRedirect: true, trustProxy: true });
    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { host: 'example.com', 'x-forwarded-proto': 'http' },
    });
    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toContain('https://example.com/test');
  });

  it('does not redirect when trustProxy=true and X-Forwarded-Proto is https', async () => {
    const app = buildApp({ httpsRedirect: true, trustProxy: true });
    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('falls back to request.protocol when X-Forwarded-Proto is absent (trustProxy=true)', async () => {
    const app = buildApp({ httpsRedirect: true, trustProxy: true });
    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { host: 'example.com' },
    });
    // No X-Forwarded-Proto → typeof undefined !== 'string' → uses request.protocol ('http') → redirect
    expect(response.statusCode).toBe(301);
  });

  it('still redirects a request that carries no Host header at all', async () => {
    // `inject` always synthesizes a Host header, so this one goes over a real loopback socket as
    // HTTP/1.0 — the only way a request reaches the hook with `headers.host` absent and the plugin
    // has to fall back to request.hostname.
    const app = buildApp({ httpsRedirect: true, trustProxy: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound TCP port');

    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = connect(address.port, '127.0.0.1', () => socket.write('GET /test HTTP/1.0\r\n\r\n'));
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
      });
      socket.on('end', () => resolve(buffer));
      socket.on('error', reject);
    });

    await app.close();
    expect(rawResponse).toMatch(/^HTTP\/1\.1 301/);
    expect(rawResponse).toMatch(/location: https:\/\/\/test/i);
  });
});
