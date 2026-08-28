import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitUndoPullRoutes } from '../../../../src/routes/projects/git/undo-pull';
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
  clientResult?: unknown;
  clientError?: Error;
}

function buildHarness(options: HarnessOptions = {}) {
  const { role = 'editor', clientResult = { ok: true, data: { operationId: 'op-1', headCommit: 'abc123' } }, clientError } = options;

  const undoPull = jest.fn(async () => {
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
    app.decorate('stores', { gitWorkerClient: { undoPull } } as never);
    await app.register(gitUndoPullRoutes);
    await app.ready();
    return app;
  };

  return { build, undoPull, auditSave };
}

function postUndo(app: FastifyInstance, projectId: string) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/git/undo-pull`, payload: {} });
}

describe('POST /projects/:projectId/git/undo-pull', () => {
  it('returns 202 {operationId} for an editor, surfacing exactly what the RPC returned', async () => {
    const { build, undoPull } = buildHarness({
      clientResult: { ok: true, data: { operationId: 'op-99', headCommit: 'cafef00d' } },
    });
    const app = await build();

    const response = await postUndo(app, PROJECT_ID);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ operationId: 'op-99' });
    expect(undoPull).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });

    await app.close();
  });

  it('answers 403 for a non-editor and never calls the worker client (denial path)', async () => {
    const { build, undoPull } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await postUndo(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(undoPull).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-member and never calls the worker client', async () => {
    const { build, undoPull } = buildHarness({ role: null });
    const app = await build();

    const response = await postUndo(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(undoPull).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps NothingToUndoError to 409 nothing_to_undo', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'NothingToUndoError' } });
    const app = await build();

    const response = await postUndo(app, PROJECT_ID);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('nothing_to_undo');

    await app.close();
  });

  it('answers 502 when the worker is unreachable', async () => {
    const { build } = buildHarness({ clientError: new GitWorkerTransportError('boom') });
    const app = await build();

    const response = await postUndo(app, PROJECT_ID);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');

    await app.close();
  });

  it('answers 429 once the caller has spent the git rate limit', async () => {
    const { undoPull, auditSave } = buildHarness();
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 1, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
      auditLog: { save: auditSave },
    } as never);
    app.decorate('stores', { gitWorkerClient: { undoPull } } as never);
    await app.register(gitUndoPullRoutes);
    await app.ready();

    const first = await postUndo(app, PROJECT_ID);
    const second = await postUndo(app, PROJECT_ID);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);

    await app.close();
  });

  it('propagates a non-transport worker failure instead of reporting the worker unavailable', async () => {
    const { build } = buildHarness({ clientError: new Error('unexpected failure') });
    const app = await build();

    const response = await postUndo(app, PROJECT_ID);

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');

    await app.close();
  });
});
