import Fastify, { type FastifyInstance } from 'fastify';
import type { GitWorkerClient, GitWorkerResult, GitWorkerStatusData } from '@asciidocollab/infrastructure';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { bucketStatus, gitStatusRoutes } from '../../../../src/routes/projects/git/status';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

function statusData(overrides: Partial<GitWorkerStatusData> = {}): GitWorkerStatusData {
  return {
    currentBranch: 'main',
    changes: [],
    syncStatus: 'UP_TO_DATE',
    defaultBranch: 'main',
    lastKnownRemoteHead: 'abc123',
    lastSyncAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('bucketStatus (pure helper)', () => {
  test('maps branch/syncStatus/lastSyncAt straight through', () => {
    const dto = bucketStatus(statusData({ currentBranch: 'feature/x', syncStatus: 'DIVERGED', lastSyncAt: null }));
    expect(dto.branch).toBe('feature/x');
    expect(dto.syncStatus).toBe('DIVERGED');
    expect(dto.lastSyncAt).toBeNull();
  });

  test('emits a fixed 0/0 ahead/behind (no numeric count on the wire yet)', () => {
    const dto = bucketStatus(statusData());
    expect(dto.ahead).toBe(0);
    expect(dto.behind).toBe(0);
  });

  test('buckets a change of each of the 4 states into its matching array', () => {
    const dto = bucketStatus(
      statusData({
        changes: [
          { path: 'a.adoc', changeType: 'modified', state: 'staged' },
          { path: 'b.adoc', changeType: 'added', state: 'unstaged' },
          { path: 'c.adoc', changeType: 'added', state: 'untracked' },
          { path: 'd.adoc', changeType: 'modified', state: 'conflicted' },
        ],
      }),
    );
    expect(dto.staged).toEqual([{ path: 'a.adoc', changeType: 'modified' }]);
    expect(dto.unstaged).toEqual([{ path: 'b.adoc', changeType: 'added' }]);
    expect(dto.untracked).toEqual([{ path: 'c.adoc', changeType: 'added' }]);
    expect(dto.conflicted).toEqual([{ path: 'd.adoc', changeType: 'modified' }]);
  });

  test('drops no field beyond path/changeType per bucketed change', () => {
    const dto = bucketStatus(statusData({ changes: [{ path: 'a.adoc', changeType: 'modified', state: 'staged' }] }));
    expect(Object.keys(dto.staged[0]).sort()).toEqual(['changeType', 'path']);
  });
});

/** Builds a `getStatus` fake resolving (or, for a transport failure, rejecting) with a fixed result. */
function mockGetStatus(result: GitWorkerResult<GitWorkerStatusData>) {
  return jest.fn(async () => result);
}

describe('GET /projects/:projectId/git/status', () => {
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
        getStatus: mockGetStatus({ ok: true, data: statusData() }),
        ...client,
      },
    } as never);
    return instance;
  }

  async function register(instance: FastifyInstance) {
    await instance.register(gitStatusRoutes);
    return instance;
  }

  function getStatus(app: FastifyInstance, projectId: string) {
    return app.inject({ method: 'GET', url: `/projects/${projectId}/git/status` });
  }

  test('returns 200 with the bucketed status for a viewer-tier member', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: { getStatus: mockGetStatus({ ok: true, data: statusData({ currentBranch: 'main' }) }) },
      }),
    );

    const response = await getStatus(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      branch: 'main',
      syncStatus: 'UP_TO_DATE',
      ahead: 0,
      behind: 0,
      lastSyncAt: '2026-08-24T00:00:00.000Z',
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
    });

    await instance.close();
  });

  test('gates BEFORE calling the worker: a non-member gets 403 and the worker is never called', async () => {
    const getStatusMock = mockGetStatus({ ok: true, data: statusData() });
    const instance = await register(buildServer({ role: null, client: { getStatus: getStatusMock } }));

    const response = await getStatus(instance, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(getStatusMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('maps a domain refusal (ok:false) through the error helper — RepositoryNotConnectedError -> 404', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: { getStatus: mockGetStatus({ ok: false, error: 'RepositoryNotConnectedError' }) },
      }),
    );

    const response = await getStatus(instance, PROJECT_ID);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('repository_not_connected');

    await instance.close();
  });

  test('maps a thrown GitWorkerTransportError to 502 without leaking transport internals', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: {
          getStatus: jest.fn(async () => {
            throw new GitWorkerTransportError('git-worker request to /internal/git/status failed: secret-squirrel');
          }),
        },
      }),
    );

    const response = await getStatus(instance, PROJECT_ID);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');
    expect(JSON.stringify(response.json())).not.toContain('secret-squirrel');

    await instance.close();
  });
});
