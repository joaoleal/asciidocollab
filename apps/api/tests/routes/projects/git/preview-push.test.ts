import Fastify, { type FastifyInstance } from 'fastify';
import type { GitWorkerClient, GitWorkerResult, GitWorkerPreviewPushData } from '@asciidocollab/infrastructure';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitPreviewPushRoutes } from '../../../../src/routes/projects/git/preview-push';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

function previewPushData(overrides: Partial<GitWorkerPreviewPushData> = {}): GitWorkerPreviewPushData {
  return {
    outgoingCommits: [
      { hash: 'def456', message: 'Local change', authorUserId: ACTOR_ID, authoredAt: '2026-01-02T00:00:00.000Z' },
    ],
    changedPaths: ['chapters/outro.adoc'],
    ...overrides,
  };
}

function mockPreviewPush(result: GitWorkerResult<GitWorkerPreviewPushData>) {
  return jest.fn(async () => result);
}

describe('GET /projects/:projectId/git/preview/push', () => {
  function buildServer(options: { role?: string | null; client?: Partial<GitWorkerClient> }): FastifyInstance {
    const { role = 'editor', client = {} } = options;
    const instance = Fastify();
    instance.setErrorHandler(errorHandler);
    instance.decorate('repos', {
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: jest.fn() },
    } as never);
    instance.decorate('stores', {
      gitWorkerClient: {
        previewPush: mockPreviewPush({ ok: true, data: previewPushData() }),
        ...client,
      },
    } as never);
    return instance;
  }

  async function register(instance: FastifyInstance) {
    await instance.register(gitPreviewPushRoutes);
    return instance;
  }

  function previewPush(app: FastifyInstance, projectId: string, query = '') {
    return app.inject({ method: 'GET', url: `/projects/${projectId}/git/preview/push${query}` });
  }

  test('returns 200 with the mapped preview (no affectsOpenFiles field)', async () => {
    const instance = await register(buildServer({}));

    const response = await previewPush(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      outgoingCommits: [
        { hash: 'def456', message: 'Local change', authorUserId: ACTOR_ID, authoredAt: '2026-01-02T00:00:00.000Z' },
      ],
      changedPaths: ['chapters/outro.adoc'],
    });

    await instance.close();
  });

  test('passes the branch query param through to the worker call', async () => {
    const previewPushMock = mockPreviewPush({ ok: true, data: previewPushData() });
    const instance = await register(buildServer({ client: { previewPush: previewPushMock } }));

    await previewPush(instance, PROJECT_ID, '?branch=release');

    expect(previewPushMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID, branch: 'release' });

    await instance.close();
  });

  test('calls the worker with no branch when the query is empty', async () => {
    const previewPushMock = mockPreviewPush({ ok: true, data: previewPushData() });
    const instance = await register(buildServer({ client: { previewPush: previewPushMock } }));

    await previewPush(instance, PROJECT_ID);

    expect(previewPushMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });

    await instance.close();
  });

  test('gates BEFORE calling the worker: a non-editor gets 403 and the worker is never called', async () => {
    const previewPushMock = mockPreviewPush({ ok: true, data: previewPushData() });
    const instance = await register(buildServer({ role: 'viewer', client: { previewPush: previewPushMock } }));

    const response = await previewPush(instance, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(previewPushMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('gates BEFORE calling the worker: a non-member gets 403 and the worker is never called', async () => {
    const previewPushMock = mockPreviewPush({ ok: true, data: previewPushData() });
    const instance = await register(buildServer({ role: null, client: { previewPush: previewPushMock } }));

    const response = await previewPush(instance, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(previewPushMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('maps a domain refusal (ok:false) through the error helper — RepositoryNotConnectedError -> 404', async () => {
    const instance = await register(
      buildServer({ client: { previewPush: mockPreviewPush({ ok: false, error: 'RepositoryNotConnectedError' }) } }),
    );

    const response = await previewPush(instance, PROJECT_ID);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('repository_not_connected');

    await instance.close();
  });

  test('maps a thrown GitWorkerTransportError to 502 without leaking transport internals', async () => {
    const instance = await register(
      buildServer({
        client: {
          previewPush: jest.fn(async () => {
            throw new GitWorkerTransportError('git-worker request to /internal/git/preview-push failed: secret-squirrel');
          }),
        },
      }),
    );

    const response = await previewPush(instance, PROJECT_ID);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');
    expect(JSON.stringify(response.json())).not.toContain('secret-squirrel');

    await instance.close();
  });
});
