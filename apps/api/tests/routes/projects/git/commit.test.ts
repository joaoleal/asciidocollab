import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitCommitRoutes } from '../../../../src/routes/projects/git/commit';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

interface HarnessOptions {
  /** The caller's role on `PROJECT_ID`, or null for "not a member". */
  role?: string | null;
  /** What `commitChanges` resolves to; defaults to a happy result. */
  clientResult?: unknown;
  /** When set, `commitChanges` throws this instead of resolving. */
  clientError?: Error;
}

function buildHarness(options: HarnessOptions = {}) {
  const {
    role = 'editor',
    clientResult = {
      ok: true,
      data: { commit: { hash: 'abc123', message: 'Fix typo', authoredAt: '2026-08-24T12:00:00.000Z' } },
    },
    clientError,
  } = options;

  const commitChanges = jest.fn(async () => {
    if (clientError) throw clientError;
    return clientResult;
  });
  const auditSave = jest.fn();

  const app = Fastify();
  app.setErrorHandler(errorHandler);

  const build = async (): Promise<FastifyInstance> => {
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 20, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: auditSave },
    } as never);
    app.decorate('stores', { gitWorkerClient: { commitChanges } } as never);
    await app.register(gitCommitRoutes);
    await app.ready();
    return app;
  };

  return { build, commitChanges, auditSave };
}

function commit(app: FastifyInstance, projectId: string, message: string) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/git/commit`, payload: { message } });
}

describe('POST /projects/:projectId/git/commit', () => {
  it('returns 200 with the commit, stamping authorUserId from the actor (no displayName resolution)', async () => {
    const { build, commitChanges } = buildHarness();
    const app = await build();

    const response = await commit(app, PROJECT_ID, 'Fix typo');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      commit: {
        hash: 'abc123',
        message: 'Fix typo',
        authorUserId: ACTOR_ID,
        authoredAt: '2026-08-24T12:00:00.000Z',
      },
    });
    expect(commitChanges).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      message: 'Fix typo',
    });

    await app.close();
  });

  it('answers 403 for a non-editor and never calls the worker client', async () => {
    const { build, commitChanges } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await commit(app, PROJECT_ID, 'Fix typo');

    expect(response.statusCode).toBe(403);
    expect(commitChanges).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps NothingStagedError to 409', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'NothingStagedError' } });
    const app = await build();

    const response = await commit(app, PROJECT_ID, 'Fix typo');

    expect(response.statusCode).toBe(409);

    await app.close();
  });

  it('maps EmptyCommitMessageError to 422, letting an empty message reach the worker (no schema minLength)', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'EmptyCommitMessageError' } });
    const app = await build();

    const response = await commit(app, PROJECT_ID, '');

    expect(response.statusCode).toBe(422);

    await app.close();
  });

  it('maps LiveContentFlushFailedError to 409 and surfaces the path in the body', async () => {
    const { build } = buildHarness({
      clientResult: { ok: false, error: 'LiveContentFlushFailedError', path: 'docs/broken.adoc' },
    });
    const app = await build();

    const response = await commit(app, PROJECT_ID, 'Fix typo');

    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.path).toBe('docs/broken.adoc');

    await app.close();
  });

  it('maps GitOperationInProgressError to 409', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'GitOperationInProgressError' } });
    const app = await build();

    const response = await commit(app, PROJECT_ID, 'Fix typo');

    expect(response.statusCode).toBe(409);

    await app.close();
  });

  it('answers 502 when the worker is unreachable', async () => {
    const { build } = buildHarness({ clientError: new GitWorkerTransportError('boom') });
    const app = await build();

    const response = await commit(app, PROJECT_ID, 'Fix typo');

    expect(response.statusCode).toBe(502);

    await app.close();
  });

  it('answers 429 once the caller has spent the git rate limit', async () => {
    const { commitChanges, auditSave } = buildHarness();
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 1, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
      auditLog: { save: auditSave },
    } as never);
    app.decorate('stores', { gitWorkerClient: { commitChanges } } as never);
    await app.register(gitCommitRoutes);
    await app.ready();

    const first = await commit(app, PROJECT_ID, 'Fix typo');
    const second = await commit(app, PROJECT_ID, 'Fix typo');

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await app.close();
  });

  it('answers 401 when the caller is not authenticated', async () => {
    const { requireAuth: realRequireAuth } = jest.requireActual<typeof import('../../../../src/plugins/require-auth')>(
      '../../../../src/plugins/require-auth',
    );
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 20, rateLimitWindow: 60_000 } } as never);
    app.addHook('preHandler', async (request) => {
      (request as unknown as { session: Record<string, unknown> }).session = {};
    });
    app.addHook('preHandler', realRequireAuth);
    app.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn() },
      auditLog: { save: jest.fn() },
    } as never);
    app.decorate('stores', { gitWorkerClient: { commitChanges: jest.fn() } } as never);
    await app.register(gitCommitRoutes);
    await app.ready();

    const response = await commit(app, PROJECT_ID, 'Fix typo');

    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('propagates a non-transport worker failure instead of reporting the worker unavailable', async () => {
    const { build } = buildHarness({ clientError: new Error('unexpected failure') });
    const app = await build();

    const response = await commit(app, PROJECT_ID, 'Fix typo');

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');

    await app.close();
  });
});
