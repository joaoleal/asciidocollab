import Fastify from 'fastify';
import { collabAuthRoute } from '../../../src/routes/internal/collab-auth';
import { decorateApp } from '../../helpers/decorate-app';

const USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const FILE_NODE_ID = '550e8400-e29b-41d4-a716-446655440005';
const YJS_STATE_ID = '550e8400-e29b-41d4-a716-446655440003';
const DOC_ID = '550e8400-e29b-41d4-a716-446655440004';

const DOCUMENT_URL = `/internal/collab/auth/document?projectId=${PROJECT_ID}&yjsStateId=${YJS_STATE_ID}`;
const PRESENCE_URL = `/internal/collab/auth/presence?projectId=${PROJECT_ID}`;

const mockDocument = {
  id: { value: DOC_ID },
  fileNodeId: { value: FILE_NODE_ID },
};

function makeProjectId(value: string) {
  return { value, equals: (other: { value: string }) => other.value === value };
}

function buildTestServer(options: {
  authenticated?: boolean;
  memberRole?: string | null;
  fileNodeProjectId?: string;
} = {}) {
  const { authenticated = true, memberRole = 'editor', fileNodeProjectId = PROJECT_ID } = options;
  const app = Fastify();

  app.addHook('preHandler', async (request) => {
    (request as unknown as { session: { userId?: string } }).session = authenticated ? { userId: USER_ID } : {};
  });

  const member = memberRole === null ? null : { role: { value: memberRole } };
  const fileNode = { id: { value: FILE_NODE_ID }, projectId: makeProjectId(fileNodeProjectId) };

  decorateApp(app, 'repos', {
    document: { findByYjsStateId: jest.fn().mockResolvedValue(mockDocument) },
    fileNode: { findById: jest.fn().mockResolvedValue(fileNode) },
    projectMember: { findByCompositeKey: jest.fn().mockResolvedValue(member) },
  });

  app.register(collabAuthRoute);
  return app;
}

describe('GET /internal/collab/auth/document', () => {
  test('editor → 200 { role: "editor", userId }', async () => {
    const app = buildTestServer({ memberRole: 'editor' });
    const response = await app.inject({ method: 'GET', url: DOCUMENT_URL });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ role: 'editor', userId: USER_ID });
  });

  test('findByCompositeKey is called with (projectId, userId) — args not swapped', async () => {
    const app = buildTestServer({ memberRole: 'editor' });
    await app.inject({ method: 'GET', url: DOCUMENT_URL });
    const mock = (app as unknown as { repos: { projectMember: { findByCompositeKey: jest.Mock } } })
      .repos.projectMember.findByCompositeKey;
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ value: PROJECT_ID }),
      expect.objectContaining({ value: USER_ID }),
    );
  });

  test('owner → 200 { role: "editor" }', async () => {
    const app = buildTestServer({ memberRole: 'owner' });
    const response = await app.inject({ method: 'GET', url: DOCUMENT_URL });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ role: 'editor', userId: USER_ID });
  });

  test('viewer → 200 { role: "observer" }', async () => {
    const app = buildTestServer({ memberRole: 'viewer' });
    const response = await app.inject({ method: 'GET', url: DOCUMENT_URL });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ role: 'observer', userId: USER_ID });
  });

  test('unauthenticated → 401', async () => {
    const app = buildTestServer({ authenticated: false });
    const response = await app.inject({ method: 'GET', url: DOCUMENT_URL });
    expect(response.statusCode).toBe(401);
  });

  test('non-member → 403', async () => {
    const app = buildTestServer({ memberRole: null });
    const response = await app.inject({ method: 'GET', url: DOCUMENT_URL });
    expect(response.statusCode).toBe(403);
  });

  // §Audit: authorization denials are logged with actor, resource, reason (never the cookie).
  test('a 403 denial is logged with actor, resource, and reason', async () => {
    const warn = jest.fn();
    const recordingLogger = {
      level: 'info', fatal: jest.fn(), error: jest.fn(), warn, info: jest.fn(), debug: jest.fn(),
      trace: jest.fn(), silent: jest.fn(), child() { return recordingLogger; },
    };
    const app = Fastify({ loggerInstance: recordingLogger });
    app.addHook('preHandler', async (request) => {
      (request as unknown as { session: { userId: string } }).session = { userId: USER_ID };
    });
    decorateApp(app, 'repos', {
      document: { findByYjsStateId: jest.fn().mockResolvedValue(null) },
      fileNode: { findById: jest.fn().mockResolvedValue(null) },
      projectMember: { findByCompositeKey: jest.fn().mockResolvedValue(null) },
    });
    app.register(collabAuthRoute);

    await app.inject({ method: 'GET', url: DOCUMENT_URL });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ actor: USER_ID, resource: `document:${PROJECT_ID}/${YJS_STATE_ID}`, reason: expect.any(String) }),
      expect.any(String),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Cookie');
  });

  test('malformed projectId/yjsStateId (not UUIDs) → 400', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: `/internal/collab/auth/document?projectId=nope&yjsStateId=nope` });
    expect(response.statusCode).toBe(400);
  });

  test('missing yjsStateId → 400', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: `/internal/collab/auth/document?projectId=${PROJECT_ID}` });
    expect(response.statusCode).toBe(400);
  });

  test('unknown yjsStateId (document not found) → 403', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      (request as unknown as { session: { userId: string } }).session = { userId: USER_ID };
    });
    decorateApp(app, 'repos', {
      document: { findByYjsStateId: jest.fn().mockResolvedValue(null) },
      fileNode: { findById: jest.fn().mockResolvedValue(null) },
      projectMember: { findByCompositeKey: jest.fn().mockResolvedValue(null) },
    });
    app.register(collabAuthRoute);
    const response = await app.inject({ method: 'GET', url: DOCUMENT_URL });
    expect(response.statusCode).toBe(403);
  });

  test('cross-project bypass attempt → 403 (document belongs to a different project)', async () => {
    const OTHER_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440099';
    const app = buildTestServer({ fileNodeProjectId: OTHER_PROJECT_ID, memberRole: 'editor' });
    const response = await app.inject({ method: 'GET', url: DOCUMENT_URL });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /internal/collab/auth/presence', () => {
  test('project member → 200 { userId } (no role)', async () => {
    const app = buildTestServer({ memberRole: 'viewer' });
    const response = await app.inject({ method: 'GET', url: PRESENCE_URL });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ userId: USER_ID });
  });

  test('does not perform a document lookup', async () => {
    const app = buildTestServer({ memberRole: 'editor' });
    await app.inject({ method: 'GET', url: PRESENCE_URL });
    const documentMock = (app as unknown as { repos: { document: { findByYjsStateId: jest.Mock } } })
      .repos.document.findByYjsStateId;
    expect(documentMock).not.toHaveBeenCalled();
  });

  test('non-member → 403', async () => {
    const app = buildTestServer({ memberRole: null });
    const response = await app.inject({ method: 'GET', url: PRESENCE_URL });
    expect(response.statusCode).toBe(403);
  });

  test('unauthenticated → 401', async () => {
    const app = buildTestServer({ authenticated: false });
    const response = await app.inject({ method: 'GET', url: PRESENCE_URL });
    expect(response.statusCode).toBe(401);
  });

  test('malformed projectId (not a UUID) → 400', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: `/internal/collab/auth/presence?projectId=nope` });
    expect(response.statusCode).toBe(400);
  });

  test('missing projectId → 400', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: `/internal/collab/auth/presence` });
    expect(response.statusCode).toBe(400);
  });

  // §Audit: presence denials are logged with actor, resource (presence:<projectId>), reason.
  test('a 403 denial is logged with actor, resource, and reason', async () => {
    const warn = jest.fn();
    const recordingLogger = {
      level: 'info', fatal: jest.fn(), error: jest.fn(), warn, info: jest.fn(), debug: jest.fn(),
      trace: jest.fn(), silent: jest.fn(), child() { return recordingLogger; },
    };
    const app = Fastify({ loggerInstance: recordingLogger });
    app.addHook('preHandler', async (request) => {
      (request as unknown as { session: { userId: string } }).session = { userId: USER_ID };
    });
    decorateApp(app, 'repos', {
      document: { findByYjsStateId: jest.fn() },
      fileNode: { findById: jest.fn() },
      projectMember: { findByCompositeKey: jest.fn().mockResolvedValue(null) },
    });
    app.register(collabAuthRoute);

    await app.inject({ method: 'GET', url: PRESENCE_URL });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ actor: USER_ID, resource: `presence:${PROJECT_ID}`, reason: expect.any(String) }),
      expect.any(String),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Cookie');
  });
});
