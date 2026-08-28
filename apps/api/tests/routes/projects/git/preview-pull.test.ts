import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { GitWorkerClient, GitWorkerResult, GitWorkerPreviewPullData } from '@asciidocollab/infrastructure';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitPreviewPullRoutes } from '../../../../src/routes/projects/git/preview-pull';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

function previewPullData(overrides: Partial<GitWorkerPreviewPullData> = {}): GitWorkerPreviewPullData {
  return {
    incomingCommits: [
      { hash: 'abc123', message: 'Remote change', authorUserId: ACTOR_ID, authoredAt: '2026-01-01T00:00:00.000Z' },
    ],
    changedPaths: ['chapters/intro.adoc'],
    ...overrides,
  };
}

function mockPreviewPull(result: GitWorkerResult<GitWorkerPreviewPullData>) {
  return jest.fn(async () => result);
}

function buildServer(options: {
  role?: string | null;
  client?: Partial<GitWorkerClient>;
  activeDocumentIds?: unknown[];
}): FastifyInstance {
  const { role = 'editor', client = {}, activeDocumentIds = [] } = options;
  const instance = Fastify();
  instance.setErrorHandler(errorHandler);
  instance.decorate('config', { git: { rateLimitMax: 20, rateLimitWindow: 60_000 } } as never);
  instance.decorate('repos', {
    projectMember: {
      findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
    },
    auditLog: { save: jest.fn() },
    collaborationSession: { findActiveDocumentIds: jest.fn(async () => activeDocumentIds) },
  } as never);
  instance.decorate('stores', {
    gitWorkerClient: {
      previewPull: mockPreviewPull({ ok: true, data: previewPullData() }),
      ...client,
    },
  } as never);
  return instance;
}

async function register(instance: FastifyInstance) {
  await instance.register(rateLimit, { global: false });
  await instance.register(gitPreviewPullRoutes);
  await instance.ready();
  return instance;
}

function previewPull(app: FastifyInstance, projectId: string, query = '') {
  return app.inject({ method: 'GET', url: `/api/projects/${projectId}/git/preview/pull${query}` });
}

describe('GET /projects/:projectId/git/preview/pull', () => {
  test('returns 200 with the mapped preview and affectsOpenFiles:false when nothing is open', async () => {
    const instance = await register(buildServer({}));

    const response = await previewPull(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      incomingCommits: [
        { hash: 'abc123', message: 'Remote change', authorUserId: ACTOR_ID, authoredAt: '2026-01-01T00:00:00.000Z' },
      ],
      changedPaths: ['chapters/intro.adoc'],
      affectsOpenFiles: false,
    });

    await instance.close();
  });

  test('reports affectsOpenFiles:true when a document has an active live session', async () => {
    const instance = await register(buildServer({ activeDocumentIds: ['doc-1'] }));

    const response = await previewPull(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json().affectsOpenFiles).toBe(true);

    await instance.close();
  });

  test('passes the branch query param through to the worker call', async () => {
    const previewPullMock = mockPreviewPull({ ok: true, data: previewPullData() });
    const instance = await register(buildServer({ client: { previewPull: previewPullMock } }));

    await previewPull(instance, PROJECT_ID, '?branch=release');

    expect(previewPullMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID, branch: 'release' });

    await instance.close();
  });

  test('calls the worker with no branch when the query is empty', async () => {
    const previewPullMock = mockPreviewPull({ ok: true, data: previewPullData() });
    const instance = await register(buildServer({ client: { previewPull: previewPullMock } }));

    await previewPull(instance, PROJECT_ID);

    expect(previewPullMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });

    await instance.close();
  });

  test('gates BEFORE calling the worker: a non-editor gets 403 and the worker is never called', async () => {
    const previewPullMock = mockPreviewPull({ ok: true, data: previewPullData() });
    const instance = await register(buildServer({ role: 'viewer', client: { previewPull: previewPullMock } }));

    const response = await previewPull(instance, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(previewPullMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('gates BEFORE calling the worker: a non-member gets 403 and the worker is never called', async () => {
    const previewPullMock = mockPreviewPull({ ok: true, data: previewPullData() });
    const instance = await register(buildServer({ role: null, client: { previewPull: previewPullMock } }));

    const response = await previewPull(instance, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(previewPullMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('maps a domain refusal (ok:false) through the error helper — RepositoryUnreachableError -> 422', async () => {
    const instance = await register(
      buildServer({ client: { previewPull: mockPreviewPull({ ok: false, error: 'RepositoryUnreachableError' }) } }),
    );

    const response = await previewPull(instance, PROJECT_ID);

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('repository_unreachable');

    await instance.close();
  });

  test('maps a thrown GitWorkerTransportError to 502 without leaking transport internals', async () => {
    const instance = await register(
      buildServer({
        client: {
          previewPull: jest.fn(async () => {
            throw new GitWorkerTransportError('git-worker request to /internal/git/preview-pull failed: secret-squirrel');
          }),
        },
      }),
    );

    const response = await previewPull(instance, PROJECT_ID);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');
    expect(JSON.stringify(response.json())).not.toContain('secret-squirrel');

    await instance.close();
  });

  test('answers 429 once the caller has spent the git rate limit', async () => {
    const instance = Fastify();
    instance.setErrorHandler(errorHandler);
    await instance.register(rateLimit, { global: false });
    instance.decorate('config', { git: { rateLimitMax: 1, rateLimitWindow: 60_000 } } as never);
    instance.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
      auditLog: { save: jest.fn() },
      collaborationSession: { findActiveDocumentIds: jest.fn(async () => []) },
    } as never);
    instance.decorate('stores', {
      gitWorkerClient: { previewPull: mockPreviewPull({ ok: true, data: previewPullData() }) },
    } as never);
    await instance.register(gitPreviewPullRoutes);
    await instance.ready();

    const first = await previewPull(instance, PROJECT_ID);
    const second = await previewPull(instance, PROJECT_ID);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await instance.close();
  });

  test('omits authorUserId entirely for an incoming commit authored outside the workspace', async () => {
    const instance = await register(
      buildServer({
        client: {
          previewPull: mockPreviewPull({
            ok: true,
            data: previewPullData({
              incomingCommits: [
                { hash: 'ff0011', message: 'External change', authoredAt: '2026-01-03T00:00:00.000Z' },
              ],
            }),
          }),
        },
      }),
    );

    const response = await previewPull(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json().incomingCommits[0]).toEqual({
      hash: 'ff0011',
      message: 'External change',
      authoredAt: '2026-01-03T00:00:00.000Z',
    });

    await instance.close();
  });

  test('propagates a non-transport worker failure instead of reporting the worker unavailable', async () => {
    const instance = await register(
      buildServer({
        client: {
          previewPull: jest.fn(async () => {
            throw new Error('unexpected failure');
          }),
        },
      }),
    );

    const response = await previewPull(instance, PROJECT_ID);

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');

    await instance.close();
  });
});
