import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { GitWorkerClient, GitWorkerResult, GitWorkerBranchListData, GitWorkerCreatedBranchData } from '@asciidocollab/infrastructure';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { toBranchListDto, gitBranchesRoutes } from '../../../../src/routes/projects/git/branches';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

describe('toBranchListDto (pure helper)', () => {
  it('flags each branch isCurrent against the current branch', () => {
    const dto = toBranchListDto({ current: 'main', branches: ['main', 'feature/x'] });
    expect(dto).toEqual({
      current: 'main',
      branches: [
        { name: 'main', isCurrent: true },
        { name: 'feature/x', isCurrent: false },
      ],
    });
  });
});

function mockGetBranches(result: GitWorkerResult<GitWorkerBranchListData>) {
  return jest.fn(async () => result);
}

function mockCreateBranch(result: GitWorkerResult<GitWorkerCreatedBranchData>) {
  return jest.fn(async () => result);
}

describe('GET /projects/:projectId/git/branches', () => {
  async function buildServer(options: { role?: string | null; client?: Partial<GitWorkerClient> }): Promise<FastifyInstance> {
    const { role = 'viewer', client = {} } = options;
    const instance = Fastify();
    instance.setErrorHandler(errorHandler);
    await instance.register(rateLimit, { global: false });
    // gitBranchesRoutes also registers the POST route in the same call, which reads
    // `app.config.git...` at registration time, so this GET-only suite still needs it decorated.
    instance.decorate('config', { git: { rateLimitMax: 20, rateLimitWindow: 60_000 } } as never);
    instance.decorate('repos', {
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: jest.fn() },
    } as never);
    instance.decorate('stores', {
      gitWorkerClient: {
        getBranches: mockGetBranches({ ok: true, data: { current: 'main', branches: ['main'] } }),
        ...client,
      },
    } as never);
    return instance;
  }

  async function register(instancePromise: Promise<FastifyInstance>) {
    const instance = await instancePromise;
    await instance.register(gitBranchesRoutes);
    await instance.ready();
    return instance;
  }

  function getBranches(app: FastifyInstance, projectId: string) {
    return app.inject({ method: 'GET', url: `/api/projects/${projectId}/git/branches` });
  }

  it('returns 200 with the branch list for a viewer-tier member', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: {
          getBranches: mockGetBranches({ ok: true, data: { current: 'main', branches: ['main', 'develop'] } }),
        },
      }),
    );

    const response = await getBranches(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      current: 'main',
      branches: [
        { name: 'main', isCurrent: true },
        { name: 'develop', isCurrent: false },
      ],
    });

    await instance.close();
  });

  it('gates BEFORE calling the worker: a non-member gets 403 and the worker is never called', async () => {
    const getBranchesMock = mockGetBranches({ ok: true, data: { current: 'main', branches: ['main'] } });
    const instance = await register(buildServer({ role: null, client: { getBranches: getBranchesMock } }));

    const response = await getBranches(instance, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(getBranchesMock).not.toHaveBeenCalled();

    await instance.close();
  });

  it('maps a domain refusal (ok:false) through the error helper — RepositoryNotConnectedError -> 404', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: { getBranches: mockGetBranches({ ok: false, error: 'RepositoryNotConnectedError' }) },
      }),
    );

    const response = await getBranches(instance, PROJECT_ID);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('repository_not_connected');

    await instance.close();
  });

  it('maps a thrown GitWorkerTransportError to 502 without leaking transport internals', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: {
          getBranches: jest.fn(async () => {
            throw new GitWorkerTransportError('git-worker request to /internal/git/branches failed: secret-squirrel');
          }),
        },
      }),
    );

    const response = await getBranches(instance, PROJECT_ID);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');
    expect(JSON.stringify(response.json())).not.toContain('secret-squirrel');

    await instance.close();
  });
});

describe('POST /projects/:projectId/git/branches', () => {
  async function build(options: { role?: string | null; client?: Partial<GitWorkerClient> } = {}): Promise<FastifyInstance> {
    const { role = 'editor', client = {} } = options;
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 20, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: jest.fn() },
    } as never);
    app.decorate('stores', {
      gitWorkerClient: {
        createBranch: mockCreateBranch({ ok: true, data: { branch: { name: 'feature/x' } } }),
        ...client,
      },
    } as never);
    await app.register(gitBranchesRoutes);
    await app.ready();
    return app;
  }

  function createBranch(app: FastifyInstance, projectId: string, body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: `/api/projects/${projectId}/git/branches`, payload: body });
  }

  it('returns 200 with the created branch (isCurrent: false) for an editor', async () => {
    const app = await build({
      client: { createBranch: mockCreateBranch({ ok: true, data: { branch: { name: 'feature/x' } } }) },
    });

    const response = await createBranch(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branch: { name: 'feature/x', isCurrent: false } });

    await app.close();
  });

  it('answers 403 for a non-editor and never calls the worker client', async () => {
    const createBranchMock = mockCreateBranch({ ok: true, data: { branch: { name: 'feature/x' } } });
    const app = await build({ role: 'viewer', client: { createBranch: createBranchMock } });

    const response = await createBranch(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(403);
    expect(createBranchMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-member and never calls the worker client', async () => {
    const createBranchMock = mockCreateBranch({ ok: true, data: { branch: { name: 'feature/x' } } });
    const app = await build({ role: null, client: { createBranch: createBranchMock } });

    const response = await createBranch(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(403);
    expect(createBranchMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 400 when name is empty', async () => {
    const createBranchMock = mockCreateBranch({ ok: true, data: { branch: { name: 'feature/x' } } });
    const app = await build({ client: { createBranch: createBranchMock } });

    const response = await createBranch(app, PROJECT_ID, { name: '' });

    expect(response.statusCode).toBe(400);
    expect(createBranchMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps a domain refusal (ok:false) through the error helper — RepositoryNotConnectedError -> 404', async () => {
    const app = await build({
      client: { createBranch: mockCreateBranch({ ok: false, error: 'RepositoryNotConnectedError' }) },
    });

    const response = await createBranch(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('repository_not_connected');

    await app.close();
  });

  it('answers 502 when the worker is unreachable', async () => {
    const app = await build({
      client: {
        createBranch: jest.fn(async () => {
          throw new GitWorkerTransportError('boom');
        }),
      },
    });

    const response = await createBranch(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');

    await app.close();
  });

  it('answers 429 once the caller has spent the git rate limit', async () => {
    const createBranchMock = mockCreateBranch({ ok: true, data: { branch: { name: 'feature/x' } } });
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 1, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
      auditLog: { save: jest.fn() },
    } as never);
    app.decorate('stores', { gitWorkerClient: { createBranch: createBranchMock } } as never);
    await app.register(gitBranchesRoutes);
    await app.ready();

    const first = await createBranch(app, PROJECT_ID, { name: 'feature/x' });
    const second = await createBranch(app, PROJECT_ID, { name: 'feature/x' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await app.close();
  });
});
