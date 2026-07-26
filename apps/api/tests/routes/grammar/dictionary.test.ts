import Fastify, { type FastifyInstance } from 'fastify';
import { dictionaryRoutes } from '../../../src/routes/grammar/dictionary';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const TERM_ID = '550e8400-e29b-41d4-a716-446655440003';

interface ServerOptions {
  role?: string | null;
  terms?: { id: string; term: string; createdByUserId: string; createdAt: Date }[];
  existingTerm?: { id: string; term: string; createdByUserId: string; createdAt: Date } | null;
  removed?: boolean;
}

async function buildServer(options: ServerOptions = {}) {
  const { role = 'editor', terms = [], existingTerm = null, removed = true } = options;
  const add = jest.fn(async (term: unknown) => term);
  const removeById = jest.fn(async () => removed);
  const auditSave = jest.fn();
  const instance = await (async (): Promise<FastifyInstance> => {
    const instance = Fastify();
    instance.decorate('repos', {
      projectDictionary: {
        listByProject: jest.fn(async () =>
          terms.map((t) => ({
            id: { value: t.id },
            projectId: { value: PROJECT_ID },
            term: t.term,
            createdByUserId: { value: t.createdByUserId },
            createdAt: t.createdAt,
          })),
        ),
        findByTerm: jest.fn(async () =>
          existingTerm
            ? {
                id: { value: existingTerm.id },
                projectId: { value: PROJECT_ID },
                term: existingTerm.term,
                createdByUserId: { value: existingTerm.createdByUserId },
                createdAt: existingTerm.createdAt,
              }
            : null,
        ),
        add,
        removeById,
      },
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: auditSave },
    } as never);
    await instance.register(dictionaryRoutes);
    return instance;
  })();
  return { app: instance, add, removeById };
}

describe('GET /projects/:projectId/dictionary', () => {
  it('returns the project terms for a member', async () => {
    const { app } = await buildServer({
      role: 'viewer',
      terms: [{ id: TERM_ID, term: 'Kubernetes', createdByUserId: 'u', createdAt: new Date() }],
    });
    const response = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/dictionary` });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.terms).toEqual([expect.objectContaining({ id: TERM_ID, term: 'Kubernetes' })]);
  });

  it('denies a non-member with 403', async () => {
    const { app } = await buildServer({ role: null });
    const response = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/dictionary` });
    expect(response.statusCode).toBe(403);
  });
});

describe('POST /projects/:projectId/dictionary', () => {
  it('adds a term for an editor and returns 201', async () => {
    const { app, add } = await buildServer({ role: 'editor' });
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/dictionary`,
      payload: { term: 'Kubernetes' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ term: 'Kubernetes' });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid term with 400 and never persists', async () => {
    const { app, add } = await buildServer({ role: 'editor' });
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/dictionary`,
      payload: { term: 'two words' },
    });
    expect(response.statusCode).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it('denies a viewer with 403', async () => {
    const { app, add } = await buildServer({ role: 'viewer' });
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/dictionary`,
      payload: { term: 'Kubernetes' },
    });
    expect(response.statusCode).toBe(403);
    expect(add).not.toHaveBeenCalled();
  });

  it('is idempotent on a case-insensitive duplicate (returns the existing term, no add)', async () => {
    const existing = { id: TERM_ID, term: 'API', createdByUserId: 'u', createdAt: new Date() };
    const { app, add } = await buildServer({ role: 'editor', existingTerm: existing });
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/dictionary`,
      payload: { term: 'api' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ id: TERM_ID, term: 'API' });
    expect(add).not.toHaveBeenCalled();
  });
});

describe('DELETE /projects/:projectId/dictionary/:termId', () => {
  it('removes a term for an editor and returns 204', async () => {
    const { app } = await buildServer({ role: 'editor', removed: true });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT_ID}/dictionary/${TERM_ID}`,
    });
    expect(response.statusCode).toBe(204);
  });

  it('returns 404 when the term does not exist', async () => {
    const { app } = await buildServer({ role: 'editor', removed: false });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT_ID}/dictionary/${TERM_ID}`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('denies a viewer with 403', async () => {
    const { app, removeById } = await buildServer({ role: 'viewer' });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT_ID}/dictionary/${TERM_ID}`,
    });
    expect(response.statusCode).toBe(403);
    expect(removeById).not.toHaveBeenCalled();
  });
});
