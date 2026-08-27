import Fastify, { type FastifyInstance } from 'fastify';
import type { GitWorkerClient, GitWorkerResult, GitWorkerDiffData } from '@asciidocollab/infrastructure';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitDiffRoutes } from '../../../../src/routes/projects/git/diff';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

function diffData(overrides: Partial<GitWorkerDiffData> = {}): GitWorkerDiffData {
  return { unified: '--- a/doc.adoc\n+++ b/doc.adoc\n', ...overrides };
}

/** Builds a `getDiff` fake resolving (or, for a transport failure, rejecting) with a fixed result. */
function mockGetDiff(result: GitWorkerResult<GitWorkerDiffData>) {
  return jest.fn(async () => result);
}

function buildServer(options: { role?: string | null; client?: Partial<GitWorkerClient> }): FastifyInstance {
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
      getDiff: mockGetDiff({ ok: true, data: diffData() }),
      ...client,
    },
  } as never);
  return instance;
}

async function register(instance: FastifyInstance) {
  await instance.register(gitDiffRoutes);
  return instance;
}

function getDiff(app: FastifyInstance, projectId: string, query = '') {
  return app.inject({ method: 'GET', url: `/api/projects/${projectId}/git/diff${query}` });
}

describe('GET /projects/:projectId/git/diff', () => {
  test('returns 200 with the mapped DiffDto for a viewer-tier member', async () => {
    const instance = await register(buildServer({ role: 'viewer' }));

    const response = await getDiff(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ unified: '--- a/doc.adoc\n+++ b/doc.adoc\n' });

    await instance.close();
  });

  test('passes path/from/to query params through to the worker call', async () => {
    const getDiffMock = mockGetDiff({ ok: true, data: diffData() });
    const instance = await register(buildServer({ role: 'viewer', client: { getDiff: getDiffMock } }));

    await getDiff(instance, PROJECT_ID, '?path=chapters/intro.adoc&from=abc123&to=def456');

    expect(getDiffMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      path: 'chapters/intro.adoc',
      from: 'abc123',
      to: 'def456',
    });

    await instance.close();
  });

  test('calls the worker with no path/from/to when the query is empty (uncommitted whole-tree diff)', async () => {
    const getDiffMock = mockGetDiff({ ok: true, data: diffData() });
    const instance = await register(buildServer({ role: 'viewer', client: { getDiff: getDiffMock } }));

    await getDiff(instance, PROJECT_ID);

    expect(getDiffMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });

    await instance.close();
  });

  test('gates BEFORE calling the worker: a non-member gets 403 and the worker is never called', async () => {
    const getDiffMock = mockGetDiff({ ok: true, data: diffData() });
    const instance = await register(buildServer({ role: null, client: { getDiff: getDiffMock } }));

    const response = await getDiff(instance, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(getDiffMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('maps a domain refusal (ok:false) through the error helper — RepositoryNotConnectedError -> 404', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: { getDiff: mockGetDiff({ ok: false, error: 'RepositoryNotConnectedError' }) },
      }),
    );

    const response = await getDiff(instance, PROJECT_ID);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('repository_not_connected');

    await instance.close();
  });

  test('maps a thrown GitWorkerTransportError to 502 without leaking transport internals', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: {
          getDiff: jest.fn(async () => {
            throw new GitWorkerTransportError('git-worker request to /internal/git/diff failed: secret-squirrel');
          }),
        },
      }),
    );

    const response = await getDiff(instance, PROJECT_ID);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');
    expect(JSON.stringify(response.json())).not.toContain('secret-squirrel');

    await instance.close();
  });
});
