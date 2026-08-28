import Fastify from 'fastify';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { storageProbeRoute, STORAGE_PROBE_PREFIX } from '../../../src/routes/internal/storage-probe';
import { decorateApp } from '../../helpers/decorate-app';

const TOKEN = '550e8400-e29b-41d4-a716-446655440099';

async function buildTestServer(storagePath: string) {
  const app = Fastify();
  decorateApp(app, 'config', { storage: { path: storagePath } });
  await app.register(storageProbeRoute);
  await app.ready();
  return app;
}

describe('internal storage-probe route', () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await mkdtemp(path.join(tmpdir(), 'storage-probe-'));
  });

  afterEach(async () => {
    await rm(storagePath, { recursive: true, force: true });
  });

  it('reports shared:true when the sentinel exists under the API storage root', async () => {
    await writeFile(path.join(storagePath, `${STORAGE_PROBE_PREFIX}${TOKEN}`), 'x');
    const app = await buildTestServer(storagePath);

    const response = await app.inject({ method: 'GET', url: `/internal/collab/storage-probe?token=${TOKEN}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ shared: true });
    await app.close();
  });

  it('reports shared:false when the sentinel is absent (divergent storage)', async () => {
    const app = await buildTestServer(storagePath);

    const response = await app.inject({ method: 'GET', url: `/internal/collab/storage-probe?token=${TOKEN}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ shared: false });
    await app.close();
  });

  it('rejects a non-UUID token (path-traversal guard) with 400', async () => {
    const app = await buildTestServer(storagePath);

    const response = await app.inject({
      method: 'GET',
      url: `/internal/collab/storage-probe?token=${encodeURIComponent('../../../etc/passwd')}`,
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects the probe with 400 when the storage root cannot contain the sentinel path', async () => {
    const app = await buildTestServer(path.parse(storagePath).root);

    const response = await app.inject({ method: 'GET', url: `/internal/collab/storage-probe?token=${TOKEN}` });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid token' });
    await app.close();
  });
});
