import Fastify from 'fastify';
import { tmpdir } from 'node:os';
import { createInternalServer, type InternalServerDeps } from '../src/internal-server';
import { decorateApp } from './helpers/decorate-app';

const PROBE_TOKEN = '550e8400-e29b-41d4-a716-446655440099';

/**
 * A throwaway Fastify instance used purely as a typed carrier: `decorateApp` installs the few
 * collaborators the internal server reaches, and reading them back off the instance yields the fully
 * declared container types `createInternalServer` asks for.
 */
function buildDeps(internalTls: { cert: string; key: string; clientCa: string }): InternalServerDeps {
  const carrier = Fastify();
  decorateApp(carrier, 'config', {
    storage: { path: tmpdir() },
    collab: { internalTls },
    auth: {
      session: {
        secret: 'test-secret-32-chars-minimum-for-hs256',
        secure: false,
        maxAge: 300_000,
        cookie: { httpOnly: true, sameSite: 'strict', saveUninitialized: false, rolling: true },
      },
    },
  });
  decorateApp(carrier, 'prisma', null);
  decorateApp(carrier, 'repos', {
    document: { findById: jest.fn(async () => null) },
    projectMember: { findByCompositeKey: jest.fn(async () => null) },
  });
  decorateApp(carrier, 'services', {});
  decorateApp(carrier, 'fileTreeEventBus', { emit: jest.fn(), subscribe: jest.fn() });

  return {
    prisma: carrier.prisma,
    repos: carrier.repos,
    services: carrier.services,
    config: carrier.config,
    fileTreeEventBus: carrier.fileTreeEventBus,
  };
}

describe('createInternalServer', () => {
  it('serves the collaboration trust-boundary routes over plain loopback HTTP when no TLS material is configured', async () => {
    const app = await createInternalServer(buildDeps({ cert: '', key: '', clientCa: '' }));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: `/internal/collab/storage-probe?token=${PROBE_TOKEN}`,
    });

    expect(response.statusCode).toBe(200);
    expect(app.hasDecorator('fileTreeEventBus')).toBe(true);
    expect(app.hasDecorator('repos')).toBe(true);
    await app.close();
  });

  it('leaves TLS off when only part of the certificate material is configured', async () => {
    const app = await createInternalServer(buildDeps({ cert: '/tls/server.crt', key: '/tls/server.key', clientCa: '' }));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: `/internal/collab/storage-probe?token=${PROBE_TOKEN}`,
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('requires client certificates when cert, key and client CA are all configured', async () => {
    const fakeApp = { decorate: jest.fn(), register: jest.fn() };
    const fastifyMock = jest.fn(() => fakeApp);
    const readFileSync = jest.fn((file: string) => Buffer.from(`pem:${file}`));

    // A real TLS server would need genuine PEM material on disk; what matters here is the option set
    // the server is constructed with, so the factory and the file reads are stubbed instead.
    let create: typeof createInternalServer | undefined;
    jest.isolateModules(() => {
      jest.doMock('fastify', () => ({ __esModule: true, default: fastifyMock }));
      jest.doMock('node:fs', () => ({ ...jest.requireActual('node:fs'), readFileSync }));
      create = require('../src/internal-server').createInternalServer;
    });
    if (!create) throw new Error('the isolated internal-server module never loaded');

    await create(buildDeps({ cert: '/tls/server.crt', key: '/tls/server.key', clientCa: '/tls/ca.crt' }));

    jest.dontMock('fastify');
    jest.dontMock('node:fs');

    expect(fastifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        https: expect.objectContaining({
          requestCert: true,
          rejectUnauthorized: true,
          ca: Buffer.from('pem:/tls/ca.crt'),
          cert: Buffer.from('pem:/tls/server.crt'),
          key: Buffer.from('pem:/tls/server.key'),
        }),
      }),
    );
    expect(fakeApp.register).toHaveBeenCalledTimes(4);
  });
});
