import { buildServer } from '../src/index';
import { setupTestEnvironment } from './helpers/test-environment';

/**
 * Regression cover for a production-only failure: `api.trustProxy` was read by
 * the https-redirect plugin but never passed to the Fastify factory, so behind a
 * TLS-terminating reverse proxy `request.protocol` stayed 'http'.
 *
 * That silently broke authentication — @fastify/session refuses to issue a
 * cookie marked `secure` unless `request.protocol === 'https'`, so login
 * answered 200 with no Set-Cookie and no user could ever sign in — and it
 * collapsed every per-IP rate limit into a single bucket keyed on the proxy.
 *
 * Both symptoms are invisible in development, where TLS is not terminated
 * upstream, which is why this asserts the forwarded headers are honoured rather
 * than merely that the config value is present.
 */
describe('trust proxy', () => {
  beforeAll(() => {
    setupTestEnvironment();
    // The test config leaves trustProxy off, matching development where nothing
    // terminates TLS upstream. Production enables it, and that is the case under
    // test here.
    process.env.ASCIIDOCOLLAB_API_TRUST_PROXY = 'true';
  });

  afterAll(() => {
    delete process.env.ASCIIDOCOLLAB_API_TRUST_PROXY;
  });

  test('X-Forwarded-Proto is honoured, so secure session cookies can be issued', async () => {
    const app = await buildServer();
    app.get('/__protocol', async (request) => ({ protocol: request.protocol }));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/__protocol',
      headers: { 'x-forwarded-proto': 'https' },
    });

    expect(response.json()).toEqual({ protocol: 'https' });
    await app.close();
  });

  test('X-Forwarded-For is honoured, so rate limits key on the real client', async () => {
    const app = await buildServer();
    app.get('/__ip', async (request) => ({ ip: request.ip }));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/__ip',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    expect(response.json()).toEqual({ ip: '203.0.113.7' });
    await app.close();
  });
});
