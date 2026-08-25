import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { gitIgnorePatternsRoutes } from '../../../src/routes/projects/git-ignore-patterns';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

interface ServerOptions {
  role?: string | null;
  stored?: string | null;
  found?: boolean;
}

function buildServer(options: ServerOptions = {}): {
  app: Promise<FastifyInstance>;
  save: jest.Mock;
  auditSave: jest.Mock;
} {
  const { role = 'owner', stored = null, found = true } = options;
  const save = jest.fn();
  const auditSave = jest.fn();
  const app = (async (): Promise<FastifyInstance> => {
    const instance = Fastify();
    await instance.register(rateLimit, { global: false });
    instance.decorate('config', {
      project: { gitIgnorePatterns: { rateLimitMax: 120, rateLimitWindow: 60_000 } },
    } as never);
    instance.decorate('repos', {
      project: {
        findById: jest.fn(async () =>
          found
            ? {
                id: { value: PROJECT_ID },
                gitIgnorePatterns: stored,
                setGitIgnorePatterns: jest.fn(function (this: { gitIgnorePatterns: string | null }, value: string | null) {
                  this.gitIgnorePatterns = value;
                }),
              }
            : null,
        ),
        save,
      },
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: auditSave },
    } as never);
    await instance.register(gitIgnorePatternsRoutes);
    return instance;
  })();
  return { app, save, auditSave };
}

describe('GET /projects/:projectId/git-ignore-patterns', () => {
  it('returns the stored patterns for the owner', async () => {
    const { app } = buildServer({ role: 'owner', stored: 'build/\n*.log' });
    const instance = await app;
    const response = await instance.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { gitIgnorePatterns: 'build/\n*.log' } });
    await instance.close();
  });

  it('returns null patterns when none are set', async () => {
    const { app } = buildServer({ role: 'owner', stored: null });
    const instance = await app;
    const response = await instance.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { gitIgnorePatterns: null } });
    await instance.close();
  });

  it('rejects an editor with 403', async () => {
    const { app } = buildServer({ role: 'editor' });
    const instance = await app;
    const response = await instance.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
    });
    expect(response.statusCode).toBe(403);
    await instance.close();
  });

  it('rejects a viewer with 403', async () => {
    const { app } = buildServer({ role: 'viewer' });
    const instance = await app;
    const response = await instance.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
    });
    expect(response.statusCode).toBe(403);
    await instance.close();
  });

  it('rejects a non-member with 403', async () => {
    const { app } = buildServer({ role: null });
    const instance = await app;
    const response = await instance.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
    });
    expect(response.statusCode).toBe(403);
    await instance.close();
  });

  it('returns 404 for a non-existent project', async () => {
    const { app } = buildServer({ role: 'owner', found: false });
    const instance = await app;
    const response = await instance.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
    });
    expect(response.statusCode).toBe(404);
    await instance.close();
  });
});

describe('PUT /projects/:projectId/git-ignore-patterns', () => {
  it('saves the patterns for the owner and echoes them back', async () => {
    const { app, save } = buildServer({ role: 'owner' });
    const instance = await app;
    const response = await instance.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
      payload: { gitIgnorePatterns: 'build/\ndist/' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { gitIgnorePatterns: 'build/\ndist/' } });
    expect(save).toHaveBeenCalledTimes(1);
    await instance.close();
  });

  it('clears the patterns when null is sent', async () => {
    const { app, save } = buildServer({ role: 'owner', stored: 'build/' });
    const instance = await app;
    const response = await instance.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
      payload: { gitIgnorePatterns: null },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { gitIgnorePatterns: null } });
    expect(save).toHaveBeenCalledTimes(1);
    await instance.close();
  });

  it('rejects an editor (non-owner) with 403 and does not save', async () => {
    const { app, save } = buildServer({ role: 'editor' });
    const instance = await app;
    const response = await instance.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
      payload: { gitIgnorePatterns: 'build/' },
    });
    expect(response.statusCode).toBe(403);
    expect(save).not.toHaveBeenCalled();
    await instance.close();
  });

  it('rejects a viewer (non-owner) with 403 and does not save', async () => {
    const { app, save } = buildServer({ role: 'viewer' });
    const instance = await app;
    const response = await instance.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
      payload: { gitIgnorePatterns: 'build/' },
    });
    expect(response.statusCode).toBe(403);
    expect(save).not.toHaveBeenCalled();
    await instance.close();
  });

  it('rejects a non-member with 403 and does not save', async () => {
    const { app, save } = buildServer({ role: null });
    const instance = await app;
    const response = await instance.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
      payload: { gitIgnorePatterns: 'build/' },
    });
    expect(response.statusCode).toBe(403);
    expect(save).not.toHaveBeenCalled();
    await instance.close();
  });

  it('returns 404 for a non-existent project and does not save', async () => {
    const { app, save } = buildServer({ role: 'owner', found: false });
    const instance = await app;
    const response = await instance.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
      payload: { gitIgnorePatterns: 'build/' },
    });
    expect(response.statusCode).toBe(404);
    expect(save).not.toHaveBeenCalled();
    await instance.close();
  });

  it('rejects a non-string, non-null body value with 400', async () => {
    const { app, save } = buildServer({ role: 'owner' });
    const instance = await app;
    const response = await instance.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT_ID}/git-ignore-patterns`,
      payload: { gitIgnorePatterns: { nested: 'not a string' } },
    });
    expect(response.statusCode).toBe(400);
    expect(save).not.toHaveBeenCalled();
    await instance.close();
  });
});
