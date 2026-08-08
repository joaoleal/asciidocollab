import Fastify, { type FastifyInstance } from 'fastify';
import { loginRoute } from '../../../src/routes/auth/login';
import { decorateApp } from '../../helpers/decorate-app';

const USER_ID = '550e8400-e29b-41d4-a716-446655440010';

/** Flush pending microtasks/immediates so fire-and-forget telemetry settles. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

interface Mocks {
  verify: jest.Mock;
  findByEmail: jest.Mock;
  record: jest.Mock;
  save: jest.Mock;
}

function buildApp(mocks: Partial<Mocks> = {}): { app: FastifyInstance; m: Mocks } {
  const m: Mocks = {
    verify: mocks.verify ?? jest.fn().mockResolvedValue(true),
    findByEmail: mocks.findByEmail ?? jest.fn().mockResolvedValue({
      id: { value: USER_ID },
      passwordHash: 'hash',
      emailVerified: true,
      isAdmin: false,
    }),
    record: mocks.record ?? jest.fn().mockResolvedValue(undefined),
    save: mocks.save ?? jest.fn().mockResolvedValue(undefined),
  };

  const app = Fastify();
  app.addHook('onRequest', (request, _reply, done) => {
    (request as unknown as { session: Record<string, unknown> }).session = {};
    done();
  });
  decorateApp(app, 'config', {
    auth: { login: { rateLimitMax: 100, rateLimitWindow: 60_000 } },
    failedSignIn: { coalesceWindowMinutes: 60 },
  });
  decorateApp(app, 'repos', {
    user: { findByEmail: m.findByEmail },
    authAttemptTelemetry: { record: m.record },
    auditLog: { save: m.save },
  });
  decorateApp(app, 'services', { passwordHasher: { verify: m.verify } });
  app.register(loginRoute);
  return { app, m };
}

const VALID_BODY = { email: 'user@example.com', password: 'secret-password' };

describe('POST /auth/login', () => {
  it('authenticates and records auth.signed_in best-effort (with origin)', async () => {
    const { app, m } = buildApp();
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: VALID_BODY });
    await flush();

    expect(response.statusCode).toBe(200);
    expect(m.record).not.toHaveBeenCalled();
    expect(m.save).toHaveBeenCalledTimes(1);
    const saved = m.save.mock.calls[0][0];
    expect(saved.action).toBe('auth.signed_in');
    expect(saved.userId.value).toBe(USER_ID);
    expect(saved.metadata.origin).toBeDefined();
  });

  it('returns 401 and records a failed sign-in (no password stored) on wrong password', async () => {
    const { app, m } = buildApp({ verify: jest.fn().mockResolvedValue(false) });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: VALID_BODY });
    await flush();

    expect(response.statusCode).toBe(401);
    expect(m.save).not.toHaveBeenCalled();
    expect(m.record).toHaveBeenCalledTimes(1);
    const argument = m.record.mock.calls[0][0];
    expect(argument.identifier).toBe('user@example.com');
    expect(JSON.stringify(argument)).not.toContain('secret-password');
  });

  it('records an identical-shape failure for a non-existent account (neutrality)', async () => {
    const { app, m } = buildApp({ findByEmail: jest.fn().mockResolvedValue(null) });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: VALID_BODY });
    await flush();

    expect(response.statusCode).toBe(401);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record.mock.calls[0][0].identifier).toBe('user@example.com');
  });

  it('still returns 401 when telemetry recording fails (best-effort)', async () => {
    const { app, m } = buildApp({
      verify: jest.fn().mockResolvedValue(false),
      record: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: VALID_BODY });
    await flush();

    expect(response.statusCode).toBe(401);
    expect(m.record).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed email at the schema boundary (never reaches telemetry)', async () => {
    const { app, m } = buildApp();
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'not-an-email', password: 'x' } });
    await flush();

    expect(response.statusCode).toBe(400);
    expect(m.record).not.toHaveBeenCalled();
  });
});
