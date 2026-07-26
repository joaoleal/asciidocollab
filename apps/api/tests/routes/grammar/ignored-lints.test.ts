import Fastify, { type FastifyInstance } from 'fastify';
import { ignoredLintsRoutes } from '../../../src/routes/grammar/ignored-lints';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const DOCUMENT_ID = '550e8400-e29b-41d4-a716-446655440002';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440009';

interface ServerOptions {
  role?: string | null;
  documentExists?: boolean;
  stored?: string | null;
}

async function buildServer(options: ServerOptions = {}) {
  const { role = 'editor', documentExists = true, stored = null } = options;
  const upsert = jest.fn();
  const instance = await (async (): Promise<FastifyInstance> => {
    const app = Fastify();
    app.decorate('repos', {
      ignoredLint: {
        findByUserAndDocument: jest.fn(async () =>
          stored === null ? null : { ignoredLintsJson: stored },
        ),
        upsert,
      },
      fileNode: {
        findById: jest.fn(async () => (documentExists ? { projectId: { value: PROJECT_ID } } : null)),
      },
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
    } as never);
    await app.register(ignoredLintsRoutes);
    return app;
  })();
  return { app: instance, upsert };
}

describe('GET /documents/:documentId/ignored-lints', () => {
  it('returns an empty string when the caller has ignored nothing', async () => {
    const { app } = await buildServer({ stored: null });
    const response = await app.inject({ method: 'GET', url: `/api/documents/${DOCUMENT_ID}/ignored-lints` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { ignoredLintsJson: '' } });
  });

  it('returns the caller’s stored blob', async () => {
    const { app } = await buildServer({ stored: '["hash-a"]' });
    const response = await app.inject({ method: 'GET', url: `/api/documents/${DOCUMENT_ID}/ignored-lints` });
    expect(response.json()).toEqual({ data: { ignoredLintsJson: '["hash-a"]' } });
  });

  it('denies a non-member with 403', async () => {
    const { app } = await buildServer({ role: null });
    const response = await app.inject({ method: 'GET', url: `/api/documents/${DOCUMENT_ID}/ignored-lints` });
    expect(response.statusCode).toBe(403);
  });

  it('denies access to an unknown document with 403', async () => {
    const { app } = await buildServer({ documentExists: false });
    const response = await app.inject({ method: 'GET', url: `/api/documents/${DOCUMENT_ID}/ignored-lints` });
    expect(response.statusCode).toBe(403);
  });
});

describe('PUT /documents/:documentId/ignored-lints', () => {
  it('replaces the caller’s blob and echoes it', async () => {
    const { app, upsert } = await buildServer({ role: 'viewer' });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/documents/${DOCUMENT_ID}/ignored-lints`,
      payload: { ignoredLintsJson: '["hash-b"]' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { ignoredLintsJson: '["hash-b"]' } });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-object body with 400', async () => {
    const { app, upsert } = await buildServer();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/documents/${DOCUMENT_ID}/ignored-lints`,
      payload: { wrong: true },
    });
    expect(response.statusCode).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('denies a non-member with 403', async () => {
    const { app, upsert } = await buildServer({ role: null });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/documents/${DOCUMENT_ID}/ignored-lints`,
      payload: { ignoredLintsJson: '["x"]' },
    });
    expect(response.statusCode).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });
});
