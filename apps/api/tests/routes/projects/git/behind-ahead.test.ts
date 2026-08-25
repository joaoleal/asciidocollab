import Fastify, { type FastifyInstance } from 'fastify';
import type { GitWorkerClient, GitWorkerResult, GitWorkerBehindAheadData } from '@asciidocollab/infrastructure';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitBehindAheadRoutes } from '../../../../src/routes/projects/git/behind-ahead';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

function behindAheadData(overrides: Partial<GitWorkerBehindAheadData> = {}): GitWorkerBehindAheadData {
  return { behind: 0, ahead: 0, ...overrides };
}

/** Builds a `getBehindAhead` fake resolving (or, for a transport failure, rejecting) with a fixed result. */
function mockGetBehindAhead(result: GitWorkerResult<GitWorkerBehindAheadData>) {
  return jest.fn(async () => result);
}

describe('GET /projects/:projectId/git/behind-ahead', () => {
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
        getBehindAhead: mockGetBehindAhead({ ok: true, data: behindAheadData() }),
        ...client,
      },
    } as never);
    return instance;
  }

  async function register(instance: FastifyInstance) {
    await instance.register(gitBehindAheadRoutes);
    return instance;
  }

  function getBehindAhead(app: FastifyInstance, projectId: string) {
    return app.inject({ method: 'GET', url: `/projects/${projectId}/git/behind-ahead` });
  }

  test('returns 200 with the behind/ahead counts for a viewer-tier member', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: { getBehindAhead: mockGetBehindAhead({ ok: true, data: behindAheadData({ behind: 2, ahead: 5 }) }) },
      }),
    );

    const response = await getBehindAhead(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ behind: 2, ahead: 5 });

    await instance.close();
  });

  test('gates BEFORE calling the worker: a non-member gets 403 and the worker is never called', async () => {
    const getBehindAheadMock = mockGetBehindAhead({ ok: true, data: behindAheadData() });
    const instance = await register(buildServer({ role: null, client: { getBehindAhead: getBehindAheadMock } }));

    const response = await getBehindAhead(instance, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(getBehindAheadMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('maps a domain refusal (ok:false) through the error helper — RepositoryNotConnectedError -> 404', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: { getBehindAhead: mockGetBehindAhead({ ok: false, error: 'RepositoryNotConnectedError' }) },
      }),
    );

    const response = await getBehindAhead(instance, PROJECT_ID);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('repository_not_connected');

    await instance.close();
  });

  test('maps a domain refusal (ok:false) through the error helper — GitCommandFailedError -> 500', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: { getBehindAhead: mockGetBehindAhead({ ok: false, error: 'GitCommandFailedError' }) },
      }),
    );

    const response = await getBehindAhead(instance, PROJECT_ID);

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('git_command_failed');

    await instance.close();
  });

  test('maps a thrown GitWorkerTransportError to 502 without leaking transport internals', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: {
          getBehindAhead: jest.fn(async () => {
            throw new GitWorkerTransportError('git-worker request to /internal/git/behind-ahead failed: secret-squirrel');
          }),
        },
      }),
    );

    const response = await getBehindAhead(instance, PROJECT_ID);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');
    expect(JSON.stringify(response.json())).not.toContain('secret-squirrel');

    await instance.close();
  });
});
