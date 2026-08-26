import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitDiscardRoutes, normalizeDiscardBody } from '../../../../src/routes/projects/git/discard';
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
  /** What `discardChanges` resolves to; defaults to a happy result. */
  clientResult?: unknown;
  /** When set, `discardChanges` throws this instead of resolving. */
  clientError?: Error;
}

function buildHarness(options: HarnessOptions = {}) {
  const {
    role = 'editor',
    clientResult = { ok: true, data: { restoredPaths: ['docs/a.adoc'] } },
    clientError,
  } = options;

  const discardChanges = jest.fn(async () => {
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
    app.decorate('stores', { gitWorkerClient: { discardChanges } } as never);
    await app.register(gitDiscardRoutes);
    await app.ready();
    return app;
  };

  return { build, discardChanges, auditSave };
}

function discard(app: FastifyInstance, projectId: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/projects/${projectId}/git/discard`, payload });
}

describe('normalizeDiscardBody', () => {
  it('normalizes a non-empty paths array to {paths, fromCommit: undefined}', () => {
    expect(normalizeDiscardBody({ paths: ['a.adoc', 'b.adoc'] })).toEqual({
      paths: ['a.adoc', 'b.adoc'],
      fromCommit: undefined,
    });
  });

  it('normalizes a path+commit pair to {paths: [path], fromCommit: commit}', () => {
    expect(normalizeDiscardBody({ path: 'a.adoc', commit: 'abc123' })).toEqual({
      paths: ['a.adoc'],
      fromCommit: 'abc123',
    });
  });

  it('rejects a body with neither shape', () => {
    expect(normalizeDiscardBody({})).toBeNull();
  });

  it('rejects a body with both shapes present', () => {
    expect(normalizeDiscardBody({ paths: ['a.adoc'], path: 'a.adoc', commit: 'abc123' })).toBeNull();
  });

  it('rejects an empty paths array', () => {
    expect(normalizeDiscardBody({ paths: [] })).toBeNull();
  });

  it('rejects a non-array paths and a non-string entry', () => {
    expect(normalizeDiscardBody({ paths: 'a.adoc' })).toBeNull();
    expect(normalizeDiscardBody({ paths: [1] })).toBeNull();
  });

  it('rejects an empty path or commit', () => {
    expect(normalizeDiscardBody({ path: '', commit: 'abc123' })).toBeNull();
    expect(normalizeDiscardBody({ path: 'a.adoc', commit: '' })).toBeNull();
  });

  it('rejects a path without a commit and a commit without a path', () => {
    expect(normalizeDiscardBody({ path: 'a.adoc' })).toBeNull();
    expect(normalizeDiscardBody({ commit: 'abc123' })).toBeNull();
  });
});

describe('POST /projects/:projectId/git/discard', () => {
  it('discards a plain set of paths, normalizing to {paths, fromCommit: undefined}', async () => {
    const { build, discardChanges } = buildHarness();
    const app = await build();

    const response = await discard(app, PROJECT_ID, { paths: ['docs/a.adoc', 'docs/b.adoc'] });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(discardChanges).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      paths: ['docs/a.adoc', 'docs/b.adoc'],
      fromCommit: undefined,
    });

    await app.close();
  });

  it('restores a single file from a commit, normalizing {path, commit} to {paths: [path], fromCommit: commit}', async () => {
    const { build, discardChanges } = buildHarness();
    const app = await build();

    const response = await discard(app, PROJECT_ID, { path: 'docs/a.adoc', commit: 'abc123' });

    expect(response.statusCode).toBe(200);
    expect(discardChanges).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      paths: ['docs/a.adoc'],
      fromCommit: 'abc123',
    });

    await app.close();
  });

  it('rejects a body matching neither shape with 400, without calling the worker', async () => {
    const { build, discardChanges } = buildHarness();
    const app = await build();

    const neither = await discard(app, PROJECT_ID, {});
    expect(neither.statusCode).toBe(400);

    const both = await discard(app, PROJECT_ID, { paths: ['a.adoc'], path: 'a.adoc', commit: 'abc123' });
    expect(both.statusCode).toBe(400);

    const emptyPaths = await discard(app, PROJECT_ID, { paths: [] });
    expect(emptyPaths.statusCode).toBe(400);

    expect(discardChanges).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-editor and never calls the worker client', async () => {
    const { build, discardChanges } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await discard(app, PROJECT_ID, { paths: ['docs/a.adoc'] });

    expect(response.statusCode).toBe(403);
    expect(discardChanges).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps RepositoryNotConnectedError to 404', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'RepositoryNotConnectedError' } });
    const app = await build();

    const response = await discard(app, PROJECT_ID, { paths: ['docs/a.adoc'] });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('answers 502 when the worker is unreachable', async () => {
    const { build } = buildHarness({ clientError: new GitWorkerTransportError('boom') });
    const app = await build();

    const response = await discard(app, PROJECT_ID, { paths: ['docs/a.adoc'] });

    expect(response.statusCode).toBe(502);

    await app.close();
  });

  it('answers 429 once the caller has spent the git rate limit', async () => {
    const { discardChanges, auditSave } = buildHarness();
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 1, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
      auditLog: { save: auditSave },
    } as never);
    app.decorate('stores', { gitWorkerClient: { discardChanges } } as never);
    await app.register(gitDiscardRoutes);
    await app.ready();

    const first = await discard(app, PROJECT_ID, { paths: ['docs/a.adoc'] });
    const second = await discard(app, PROJECT_ID, { paths: ['docs/a.adoc'] });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await app.close();
  });
});
