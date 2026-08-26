import Fastify, { type FastifyInstance } from 'fastify';
import type { GitWorkerClient, GitWorkerResult, GitWorkerHistoryData } from '@asciidocollab/infrastructure';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitHistoryRoutes } from '../../../../src/routes/projects/git/history';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

function historyData(overrides: Partial<GitWorkerHistoryData> = {}): GitWorkerHistoryData {
  return {
    commits: [
      { hash: 'abc123', message: 'Initial commit', authorUserId: ACTOR_ID, authoredAt: '2026-01-01T00:00:00.000Z' },
    ],
    ...overrides,
  };
}

/** Builds a `getHistory` fake resolving (or, for a transport failure, rejecting) with a fixed result. */
function mockGetHistory(result: GitWorkerResult<GitWorkerHistoryData>) {
  return jest.fn(async () => result);
}

describe('GET /projects/:projectId/git/history', () => {
  function buildServer(options: {
    role?: string | null;
    client?: Partial<GitWorkerClient>;
  }): FastifyInstance {
    const { role = 'viewer', client = {} } = options;
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
        getHistory: mockGetHistory({ ok: true, data: historyData() }),
        ...client,
      },
    } as never);
    return instance;
  }

  async function register(instance: FastifyInstance) {
    await instance.register(gitHistoryRoutes);
    return instance;
  }

  function getHistory(app: FastifyInstance, projectId: string, query = '') {
    return app.inject({ method: 'GET', url: `/projects/${projectId}/git/history${query}` });
  }

  test('returns 200 with the mapped commits for a viewer-tier member', async () => {
    const instance = await register(buildServer({ role: 'viewer' }));

    const response = await getHistory(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      commits: [
        { hash: 'abc123', message: 'Initial commit', authorUserId: ACTOR_ID, authoredAt: '2026-01-01T00:00:00.000Z' },
      ],
    });

    await instance.close();
  });

  test('omits authorUserId for an unmapped commit author', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: {
          getHistory: mockGetHistory({
            ok: true,
            data: historyData({ commits: [{ hash: 'e4f5a6b', message: 'Imported', authoredAt: '2026-01-02T00:00:00.000Z' }] }),
          }),
        },
      }),
    );

    const response = await getHistory(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json().commits[0].authorUserId).toBeUndefined();

    await instance.close();
  });

  test('passes path and limit query params through to the worker call', async () => {
    const getHistoryMock = mockGetHistory({ ok: true, data: historyData() });
    const instance = await register(buildServer({ role: 'viewer', client: { getHistory: getHistoryMock } }));

    await getHistory(instance, PROJECT_ID, '?path=chapters/intro.adoc&limit=5');

    expect(getHistoryMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      path: 'chapters/intro.adoc',
      limit: 5,
    });

    await instance.close();
  });

  test('calls the worker with neither path nor limit when the query is empty', async () => {
    const getHistoryMock = mockGetHistory({ ok: true, data: historyData() });
    const instance = await register(buildServer({ role: 'viewer', client: { getHistory: getHistoryMock } }));

    await getHistory(instance, PROJECT_ID);

    expect(getHistoryMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });

    await instance.close();
  });

  test('rejects a non-numeric limit with 400, without calling the worker', async () => {
    const getHistoryMock = mockGetHistory({ ok: true, data: historyData() });
    const instance = await register(buildServer({ role: 'viewer', client: { getHistory: getHistoryMock } }));

    const response = await getHistory(instance, PROJECT_ID, '?limit=abc');

    expect(response.statusCode).toBe(400);
    expect(getHistoryMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('rejects a negative limit with 400, without calling the worker', async () => {
    const getHistoryMock = mockGetHistory({ ok: true, data: historyData() });
    const instance = await register(buildServer({ role: 'viewer', client: { getHistory: getHistoryMock } }));

    const response = await getHistory(instance, PROJECT_ID, '?limit=-1');

    expect(response.statusCode).toBe(400);
    expect(getHistoryMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('gates BEFORE calling the worker: a non-member gets 403 and the worker is never called', async () => {
    const getHistoryMock = mockGetHistory({ ok: true, data: historyData() });
    const instance = await register(buildServer({ role: null, client: { getHistory: getHistoryMock } }));

    const response = await getHistory(instance, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(getHistoryMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('maps a domain refusal (ok:false) through the error helper — RepositoryNotConnectedError -> 404', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: { getHistory: mockGetHistory({ ok: false, error: 'RepositoryNotConnectedError' }) },
      }),
    );

    const response = await getHistory(instance, PROJECT_ID);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('repository_not_connected');

    await instance.close();
  });

  test('maps a thrown GitWorkerTransportError to 502 without leaking transport internals', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: {
          getHistory: jest.fn(async () => {
            throw new GitWorkerTransportError('git-worker request to /internal/git/history failed: secret-squirrel');
          }),
        },
      }),
    );

    const response = await getHistory(instance, PROJECT_ID);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');
    expect(JSON.stringify(response.json())).not.toContain('secret-squirrel');

    await instance.close();
  });
});
