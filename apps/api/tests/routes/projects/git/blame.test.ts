import Fastify, { type FastifyInstance } from 'fastify';
import type { GitWorkerClient, GitWorkerResult, GitWorkerBlameData } from '@asciidocollab/infrastructure';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitBlameRoutes } from '../../../../src/routes/projects/git/blame';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

function blameData(overrides: Partial<GitWorkerBlameData> = {}): GitWorkerBlameData {
  return {
    lines: [
      { lineNumber: 1, hash: 'abc123', message: 'Initial commit', authorUserId: ACTOR_ID, authoredAt: '2026-01-01T00:00:00.000Z', content: '= Title' },
    ],
    ...overrides,
  };
}

/** Builds a `getBlame` fake resolving (or, for a transport failure, rejecting) with a fixed result. */
function mockGetBlame(result: GitWorkerResult<GitWorkerBlameData>) {
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
      getBlame: mockGetBlame({ ok: true, data: blameData() }),
      ...client,
    },
  } as never);
  return instance;
}

async function register(instance: FastifyInstance) {
  await instance.register(gitBlameRoutes);
  return instance;
}

function getBlame(app: FastifyInstance, projectId: string, query = '') {
  return app.inject({ method: 'GET', url: `/api/projects/${projectId}/git/blame${query}` });
}

describe('GET /projects/:projectId/git/blame', () => {
  test('returns 200 with the mapped BlameDto for a viewer-tier member', async () => {
    const instance = await register(buildServer({ role: 'viewer' }));

    const response = await getBlame(instance, PROJECT_ID, '?path=chapters/intro.adoc');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      lines: [
        { lineNumber: 1, hash: 'abc123', message: 'Initial commit', authorUserId: ACTOR_ID, authoredAt: '2026-01-01T00:00:00.000Z', content: '= Title' },
      ],
    });

    await instance.close();
  });

  test('omits authorUserId for an unmapped line author', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: {
          getBlame: mockGetBlame({
            ok: true,
            data: blameData({
              lines: [{ lineNumber: 1, hash: 'e4f5a6b', message: 'Add text', authoredAt: '2026-01-02T00:00:00.000Z', content: 'text' }],
            }),
          }),
        },
      }),
    );

    const response = await getBlame(instance, PROJECT_ID, '?path=chapters/intro.adoc');

    expect(response.statusCode).toBe(200);
    expect(response.json().lines[0].authorUserId).toBeUndefined();

    await instance.close();
  });

  test('passes path and ref query params through to the worker call', async () => {
    const getBlameMock = mockGetBlame({ ok: true, data: blameData() });
    const instance = await register(buildServer({ role: 'viewer', client: { getBlame: getBlameMock } }));

    await getBlame(instance, PROJECT_ID, '?path=chapters/intro.adoc&ref=abc123');

    expect(getBlameMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      path: 'chapters/intro.adoc',
      ref: 'abc123',
    });

    await instance.close();
  });

  test('rejects a missing path with 400, without calling the worker', async () => {
    const getBlameMock = mockGetBlame({ ok: true, data: blameData() });
    const instance = await register(buildServer({ role: 'viewer', client: { getBlame: getBlameMock } }));

    const response = await getBlame(instance, PROJECT_ID);

    expect(response.statusCode).toBe(400);
    expect(getBlameMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('gates BEFORE calling the worker: a non-member gets 403 and the worker is never called', async () => {
    const getBlameMock = mockGetBlame({ ok: true, data: blameData() });
    const instance = await register(buildServer({ role: null, client: { getBlame: getBlameMock } }));

    const response = await getBlame(instance, PROJECT_ID, '?path=chapters/intro.adoc');

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(getBlameMock).not.toHaveBeenCalled();

    await instance.close();
  });

  test('maps a domain refusal (ok:false) through the error helper — RepositoryNotConnectedError -> 404', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: { getBlame: mockGetBlame({ ok: false, error: 'RepositoryNotConnectedError' }) },
      }),
    );

    const response = await getBlame(instance, PROJECT_ID, '?path=chapters/intro.adoc');

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('repository_not_connected');

    await instance.close();
  });

  test('maps a thrown GitWorkerTransportError to 502 without leaking transport internals', async () => {
    const instance = await register(
      buildServer({
        role: 'viewer',
        client: {
          getBlame: jest.fn(async () => {
            throw new GitWorkerTransportError('git-worker request to /internal/git/blame failed: secret-squirrel');
          }),
        },
      }),
    );

    const response = await getBlame(instance, PROJECT_ID, '?path=chapters/intro.adoc');

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');
    expect(JSON.stringify(response.json())).not.toContain('secret-squirrel');

    await instance.close();
  });
});
