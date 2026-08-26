import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitUnstageRoutes } from '../../../../src/routes/projects/git/unstage';
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
  /** What `unstageChanges` resolves to; defaults to a happy result. */
  clientResult?: unknown;
  /** When set, `unstageChanges` throws this instead of resolving. */
  clientError?: Error;
}

function buildHarness(options: HarnessOptions = {}) {
  const { role = 'editor', clientResult = { ok: true, data: { staged: [] } }, clientError } = options;

  const unstageChanges = jest.fn(async () => {
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
    app.decorate('stores', { gitWorkerClient: { unstageChanges } } as never);
    await app.register(gitUnstageRoutes);
    await app.ready();
    return app;
  };

  return { build, unstageChanges, auditSave };
}

function unstage(app: FastifyInstance, projectId: string, paths: string[]) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/git/unstage`, payload: { paths } });
}

describe('POST /projects/:projectId/git/unstage', () => {
  it('returns 200 with the remaining staged paths for an editor', async () => {
    const { build, unstageChanges } = buildHarness({
      clientResult: { ok: true, data: { staged: ['b.adoc'] } },
    });
    const app = await build();

    const response = await unstage(app, PROJECT_ID, ['a.adoc']);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ staged: ['b.adoc'] });
    expect(unstageChanges).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      paths: ['a.adoc'],
    });

    await app.close();
  });

  it('answers 403 for a non-editor and never calls the worker client', async () => {
    const { build, unstageChanges } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await unstage(app, PROJECT_ID, ['a.adoc']);

    expect(response.statusCode).toBe(403);
    expect(unstageChanges).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps a GitOperationInProgressError domain refusal to 409', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'GitOperationInProgressError' } });
    const app = await build();

    const response = await unstage(app, PROJECT_ID, ['a.adoc']);

    expect(response.statusCode).toBe(409);

    await app.close();
  });

  it('answers 502 when the worker is unreachable', async () => {
    const { build } = buildHarness({ clientError: new GitWorkerTransportError('boom') });
    const app = await build();

    const response = await unstage(app, PROJECT_ID, ['a.adoc']);

    expect(response.statusCode).toBe(502);

    await app.close();
  });

  it('answers 429 once the caller has spent the git rate limit', async () => {
    const { unstageChanges, auditSave } = buildHarness();
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 1, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
      auditLog: { save: auditSave },
    } as never);
    app.decorate('stores', { gitWorkerClient: { unstageChanges } } as never);
    await app.register(gitUnstageRoutes);
    await app.ready();

    const first = await unstage(app, PROJECT_ID, ['a.adoc']);
    const second = await unstage(app, PROJECT_ID, ['a.adoc']);

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
    app.decorate('stores', { gitWorkerClient: { unstageChanges: jest.fn() } } as never);
    await app.register(gitUnstageRoutes);
    await app.ready();

    const response = await unstage(app, PROJECT_ID, ['a.adoc']);

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
