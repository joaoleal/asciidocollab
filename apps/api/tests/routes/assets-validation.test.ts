import { readFileSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { assetsRoutes } from '../../src/routes/projects/assets';
import { decorateApp } from '../helpers/decorate-app';

jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

async function buildAssetsTestServer() {
  const app = Fastify();
  decorateApp(app, 'repos', {
    projectMember: { findByCompositeKey: jest.fn().mockResolvedValue({ role: { value: 'editor' } }) },
    fileNode: { findById: jest.fn().mockResolvedValue(null) },
    asset: { findById: jest.fn().mockResolvedValue(null), save: jest.fn() },
    systemSetting: { get: jest.fn().mockResolvedValue(null) },
    auditLog: { save: jest.fn() },
  });
  decorateApp(app, 'stores', { fileStore: {} });
  decorateApp(app, 'config', { storage: { maxUploadSizeBytes: 20_971_520 } });
  decorateApp(app, 'fileTreeEventBus', { emit: jest.fn() });
  await app.register(assetsRoutes);
  await app.ready();
  return app;
}

describe('assets route — runtime validation', () => {
  it('returns 400 when parentId query param is missing', async () => {
    const app = await buildAssetsTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/projects/770e8400-e29b-41d4-a716-446655440003/assets',
      headers: { 'content-type': 'multipart/form-data; boundary=boundary' },
      payload: [
        '--boundary',
        'Content-Disposition: form-data; name="file"; filename="test.png"',
        'Content-Type: image/png',
        '',
        'hello',
        '--boundary--',
      ].join('\r\n'),
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('route validates parentId presence before passing to FileNodeId.create', () => {
    const source = readFileSync(
      path.join(__dirname, '../../src/routes/projects/assets.ts'),
      'utf8',
    );
    const hasGuard =
      source.includes("if (!request.query.parentId)") ||
      source.includes('if (!parentId)') ||
      source.includes('parentId == null') ||
      source.includes('parentId === undefined') ||
      source.includes("required: ['parentId']") ||
      source.includes('required: ["parentId"]');
    expect(hasGuard).toBe(true);
  });
});
