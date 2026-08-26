import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitAmendRoutes } from '../../../../src/routes/projects/git/amend';
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
  /** What `amendCommit` resolves to; defaults to a happy result. */
  clientResult?: unknown;
  /** When set, `amendCommit` throws this instead of resolving. */
  clientError?: Error;
}

function buildHarness(options: HarnessOptions = {}) {
  const {
    role = 'editor',
    clientResult = {
      ok: true,
      data: { commit: { hash: 'def456', message: 'Amended message', authoredAt: '2026-08-24T12:00:00.000Z' } },
    },
    clientError,
  } = options;

  const amendCommit = jest.fn(async () => {
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
    app.decorate('stores', { gitWorkerClient: { amendCommit } } as never);
    await app.register(gitAmendRoutes);
    await app.ready();
    return app;
  };

  return { build, amendCommit, auditSave };
}

function amend(app: FastifyInstance, projectId: string, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: `/projects/${projectId}/git/amend`, payload });
}

describe('POST /projects/:projectId/git/amend', () => {
  it('returns 200 with the amended commit, stamping authorUserId from the actor', async () => {
    const { build, amendCommit } = buildHarness();
    const app = await build();

    const response = await amend(app, PROJECT_ID, { message: 'Amended message' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      commit: {
        hash: 'def456',
        message: 'Amended message',
        authorUserId: ACTOR_ID,
        authoredAt: '2026-08-24T12:00:00.000Z',
      },
    });
    expect(amendCommit).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      message: 'Amended message',
    });

    await app.close();
  });

  it('calls the worker without a message when the body omits it', async () => {
    const { build, amendCommit } = buildHarness();
    const app = await build();

    const response = await amend(app, PROJECT_ID, {});

    expect(response.statusCode).toBe(200);
    expect(amendCommit).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });

    await app.close();
  });

  it('answers 403 for a non-editor and never calls the worker client', async () => {
    const { build, amendCommit } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await amend(app, PROJECT_ID, {});

    expect(response.statusCode).toBe(403);
    expect(amendCommit).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps a CommitAlreadyPushedError refusal to 409 with the commit_already_pushed code', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'CommitAlreadyPushedError' } });
    const app = await build();

    const response = await amend(app, PROJECT_ID, {});

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('commit_already_pushed');

    await app.close();
  });

  it('maps EmptyCommitMessageError to 422', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'EmptyCommitMessageError' } });
    const app = await build();

    const response = await amend(app, PROJECT_ID, { message: '   ' });

    expect(response.statusCode).toBe(422);

    await app.close();
  });

  it('answers 502 when the worker is unreachable', async () => {
    const { build } = buildHarness({ clientError: new GitWorkerTransportError('boom') });
    const app = await build();

    const response = await amend(app, PROJECT_ID, {});

    expect(response.statusCode).toBe(502);

    await app.close();
  });

  it('answers 429 once the caller has spent the git rate limit', async () => {
    const { amendCommit, auditSave } = buildHarness();
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 1, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
      auditLog: { save: auditSave },
    } as never);
    app.decorate('stores', { gitWorkerClient: { amendCommit } } as never);
    await app.register(gitAmendRoutes);
    await app.ready();

    const first = await amend(app, PROJECT_ID, { message: 'Amended message' });
    const second = await amend(app, PROJECT_ID, { message: 'Amended message' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await app.close();
  });
});
