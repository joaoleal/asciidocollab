import Fastify from 'fastify';
import { fileContentRoutes } from '../../src/routes/projects/file-content';
import { decorateApp } from '../helpers/decorate-app';

jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const FILE_NODE_ID = '550e8400-e29b-41d4-a716-446655440003';
const YJS_STATE_ID = '880e8400-e29b-41d4-a716-446655440006';
const DOCUMENT_ID = '990e8400-e29b-41d4-a716-446655440007';

function buildTestServer(
  options: { memberRole?: string | null; hasDocument?: boolean; fileNodeExists?: boolean } = {},
) {
  const { memberRole = 'editor', hasDocument = true, fileNodeExists = true } = options;
  const app = Fastify();
  decorateApp(app, 'repos', {
    projectMember: {
      findByCompositeKey: jest
        .fn()
        .mockResolvedValue(memberRole === null ? null : { role: { value: memberRole } }),
    },
    fileNode: {
      findById: jest
        .fn()
        .mockResolvedValue(fileNodeExists ? { projectId: { value: PROJECT_ID } } : null),
    },
    document: {
      findByFileNodeId: jest
        .fn()
        .mockResolvedValue(hasDocument ? { id: { value: DOCUMENT_ID }, yjsStateId: { value: YJS_STATE_ID } } : null),
    },
    collaborationSession: { isActive: jest.fn().mockResolvedValue(false) },
  });
  decorateApp(app, 'stores', {
    fileStore: { read: jest.fn(), write: jest.fn() },
  });
  decorateApp(app, 'config', { project: { fileContent: { rateLimitMax: 600, rateLimitWindow: 3_600_000 } } });
  app.register(fileContentRoutes);
  return app;
}

describe('GET /projects/:projectId/files/:fileNodeId/collab', () => {
  it('returns 200 { yjsStateId, role: "editor" } for an editor member', async () => {
    const app = buildTestServer({ memberRole: 'editor' });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/collab`,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ yjsStateId: YJS_STATE_ID, documentId: DOCUMENT_ID, role: 'editor' });
  });

  it('maps a viewer member to role "observer"', async () => {
    const app = buildTestServer({ memberRole: 'viewer' });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/collab`,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ yjsStateId: YJS_STATE_ID, documentId: DOCUMENT_ID, role: 'observer' });
  });

  it('returns 403 FORBIDDEN for a non-member and leaks no document details', async () => {
    const app = buildTestServer({ memberRole: null });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/collab`,
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN');
    // Must not disclose the room id (yjsStateId) or any document existence to non-members.
    expect(response.body).not.toContain(YJS_STATE_ID);
  });

  it('returns 404 NOT_FOUND for a binary asset with no Document', async () => {
    const app = buildTestServer({ hasDocument: false });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/collab`,
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });

  it('returns 404 NOT_FOUND for an unknown file node', async () => {
    const app = buildTestServer({ fileNodeExists: false });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/collab`,
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });

  it('logs the 403 denial with actor, resource, and reason', async () => {
    const warn = jest.fn();
    const recordingLogger = {
      level: 'info',
      fatal: jest.fn(), error: jest.fn(), warn, info: jest.fn(), debug: jest.fn(),
      trace: jest.fn(), silent: jest.fn(),
      child() { return recordingLogger; },
    };
    const app = Fastify({ loggerInstance: recordingLogger });
    decorateApp(app, 'repos', {
      projectMember: { findByCompositeKey: jest.fn().mockResolvedValue(null) },
      fileNode: { findById: jest.fn().mockResolvedValue({ projectId: { value: PROJECT_ID } }) },
      document: { findByFileNodeId: jest.fn() },
      collaborationSession: { isActive: jest.fn().mockResolvedValue(false) },
    });
    decorateApp(app, 'stores', { fileStore: { read: jest.fn(), write: jest.fn() } });
    decorateApp(app, 'config', { project: { fileContent: { rateLimitMax: 600, rateLimitWindow: 3_600_000 } } });
    app.register(fileContentRoutes);

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/collab`,
    });
    expect(response.statusCode).toBe(403);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ actor: USER_ID, resource: expect.stringContaining(FILE_NODE_ID), reason: expect.any(String) }),
      expect.any(String),
    );
  });

  it('returns 401 when unauthenticated (requireAuth preHandler enforced)', async () => {
    const { requireAuth: realRequireAuth } = jest.requireActual<typeof import('../../src/plugins/require-auth')>(
      '../../src/plugins/require-auth',
    );
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      (request as unknown as { session: Record<string, unknown> }).session = {};
    });
    app.addHook('preHandler', realRequireAuth);
    decorateApp(app, 'repos', {
      projectMember: { findByCompositeKey: jest.fn() },
      fileNode: { findById: jest.fn() },
      document: { findByFileNodeId: jest.fn() },
      collaborationSession: { isActive: jest.fn() },
    });
    decorateApp(app, 'stores', { fileStore: { read: jest.fn(), write: jest.fn() } });
    decorateApp(app, 'config', { project: { fileContent: { rateLimitMax: 600, rateLimitWindow: 3_600_000 } } });
    app.register(fileContentRoutes);

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}/collab`,
    });
    expect(response.statusCode).toBe(401);
  });
});
