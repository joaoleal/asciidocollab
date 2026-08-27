import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import {
  gitConflictsRoutes,
  toConflictListDto,
  toConflictStagesDto,
  validateConflictPath,
} from '../../../../src/routes/projects/git/conflicts';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

describe('toConflictListDto (pure helper)', () => {
  it('maps the sync-RPC conflict-list payload straight to the wire shape', () => {
    const dto = toConflictListDto({
      operationId: 'op-1',
      files: [
        { path: 'docs/a.adoc', isBinary: false, resolved: true },
        { path: 'assets/logo.png', isBinary: true, resolved: false },
      ],
    });
    expect(dto).toEqual({
      operationId: 'op-1',
      files: [
        { path: 'docs/a.adoc', isBinary: false, resolved: true },
        { path: 'assets/logo.png', isBinary: true, resolved: false },
      ],
    });
  });
});

describe('toConflictStagesDto (pure helper)', () => {
  it('maps the sync-RPC stages payload straight to the wire shape', () => {
    expect(toConflictStagesDto({ base: 'b', ours: 'o', theirs: 't', isBinary: false })).toEqual({
      base: 'b',
      ours: 'o',
      theirs: 't',
      isBinary: false,
    });
  });

  it('preserves a null base (add/add conflict)', () => {
    expect(toConflictStagesDto({ base: null, ours: 'o', theirs: 't', isBinary: false }).base).toBeNull();
  });
});

describe('validateConflictPath (pure helper)', () => {
  // Fastify's router already percent-decodes the `:path` route param before a handler ever sees
  // it, so this function receives the ALREADY-DECODED string — it must validate, not decode.

  it('accepts an already-decoded relative path unchanged', () => {
    expect(validateConflictPath('docs/a b.adoc')).toBe('docs/a b.adoc');
  });

  it('accepts a path containing a literal percent character (Fastify already decoded once; this function must not decode again)', () => {
    expect(validateConflictPath('50%_done.adoc')).toBe('50%_done.adoc');
  });

  it('rejects an empty path', () => {
    expect(validateConflictPath('')).toBeNull();
  });

  it('rejects an absolute path', () => {
    expect(validateConflictPath('/etc/passwd')).toBeNull();
  });

  it('rejects a path with a leading backslash', () => {
    expect(validateConflictPath(String.raw`\etc\passwd`)).toBeNull();
  });

  it('rejects a path containing a forward-slash traversal segment', () => {
    expect(validateConflictPath('../../etc/passwd')).toBeNull();
    expect(validateConflictPath('docs/../../../etc/passwd')).toBeNull();
  });

  it('rejects a path containing an interior backslash traversal segment', () => {
    expect(validateConflictPath(String.raw`foo\..\bar`)).toBeNull();
    expect(validateConflictPath(String.raw`..\..\x`)).toBeNull();
  });
});

interface HarnessOptions {
  /** The caller's role on `PROJECT_ID`, or null for "not a member". */
  role?: string | null;
  client?: {
    listConflicts?: jest.Mock;
    getConflictStages?: jest.Mock;
    resolveConflict?: jest.Mock;
  };
}

function buildHarness(options: HarnessOptions = {}) {
  const { role = 'editor', client = {} } = options;

  const listConflicts =
    client.listConflicts ??
    jest.fn(async () => ({ ok: true, data: { operationId: 'op-1', files: [{ path: 'docs/a.adoc', isBinary: false, resolved: false }] } }));
  const getConflictStages =
    client.getConflictStages ??
    jest.fn(async () => ({ ok: true, data: { base: 'b', ours: 'o', theirs: 't', isBinary: false } }));
  const resolveConflict = client.resolveConflict ?? jest.fn(async () => ({ ok: true, data: { resolved: true } }));

  const app = Fastify();
  app.setErrorHandler(errorHandler);

  const build = async (): Promise<FastifyInstance> => {
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 20, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: jest.fn() },
    } as never);
    app.decorate('stores', { gitWorkerClient: { listConflicts, getConflictStages, resolveConflict } } as never);
    await app.register(gitConflictsRoutes);
    await app.ready();
    return app;
  };

  return { build, listConflicts, getConflictStages, resolveConflict };
}

function getConflicts(app: FastifyInstance, projectId: string) {
  return app.inject({ method: 'GET', url: `/api/projects/${projectId}/git/conflicts` });
}

function getConflictStagesAt(app: FastifyInstance, projectId: string, encodedPath: string) {
  return app.inject({ method: 'GET', url: `/api/projects/${projectId}/git/conflicts/${encodedPath}` });
}

function postResolve(app: FastifyInstance, projectId: string, encodedPath: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/git/conflicts/${encodedPath}`, payload: body });
}

describe('GET /projects/:projectId/git/conflicts', () => {
  it('returns 200 with the conflict list for a viewer-tier member', async () => {
    const { build, listConflicts } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await getConflicts(app, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      operationId: 'op-1',
      files: [{ path: 'docs/a.adoc', isBinary: false, resolved: false }],
    });
    expect(listConflicts).toHaveBeenCalledWith({ projectId: PROJECT_ID, actorId: ACTOR_ID });

    await app.close();
  });

  it('answers 403 for a non-member and never calls the worker client', async () => {
    const { build, listConflicts } = buildHarness({ role: null });
    const app = await build();

    const response = await getConflicts(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(listConflicts).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps NoConflictInProgressError to 404', async () => {
    const { build } = buildHarness({
      role: 'viewer',
      client: { listConflicts: jest.fn(async () => ({ ok: false, error: 'NoConflictInProgressError' })) },
    });
    const app = await build();

    const response = await getConflicts(app, PROJECT_ID);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('no_conflict_in_progress');

    await app.close();
  });

  it('answers 502 when the worker is unreachable', async () => {
    const { build } = buildHarness({
      role: 'viewer',
      client: {
        listConflicts: jest.fn(async () => {
          throw new GitWorkerTransportError('boom');
        }),
      },
    });
    const app = await build();

    const response = await getConflicts(app, PROJECT_ID);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');

    await app.close();
  });
});

describe('GET /projects/:projectId/git/conflicts/:path', () => {
  it('returns 200 with the decoded path forwarded to the worker', async () => {
    const { build, getConflictStages } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await getConflictStagesAt(app, PROJECT_ID, encodeURIComponent('docs/a b.adoc'));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ base: 'b', ours: 'o', theirs: 't', isBinary: false });
    expect(getConflictStages).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      path: 'docs/a b.adoc',
    });

    await app.close();
  });

  it('accepts a filename containing a literal percent character instead of double-decoding it (regression)', async () => {
    const { build, getConflictStages } = buildHarness({ role: 'viewer' });
    const app = await build();

    // The client sends the literal '%' in "50%_done.adoc" percent-encoded as '%25', so Fastify's
    // own single decode delivers "50%_done.adoc" to the handler. The previous implementation
    // decoded a SECOND time and threw on the bare '%', wrongly answering 400 for this valid path.
    const response = await getConflictStagesAt(app, PROJECT_ID, '50%25_done.adoc');

    expect(response.statusCode).toBe(200);
    expect(getConflictStages).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      path: '50%_done.adoc',
    });

    await app.close();
  });

  it('answers 400 for a traversal path and never calls the worker client', async () => {
    const { build, getConflictStages } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await getConflictStagesAt(app, PROJECT_ID, encodeURIComponent('../../etc/passwd'));

    expect(response.statusCode).toBe(400);
    expect(getConflictStages).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-member and never calls the worker client', async () => {
    const { build, getConflictStages } = buildHarness({ role: null });
    const app = await build();

    const response = await getConflictStagesAt(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'));

    expect(response.statusCode).toBe(403);
    expect(getConflictStages).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps GitConflictNotFoundError to 422', async () => {
    const { build } = buildHarness({
      role: 'viewer',
      client: { getConflictStages: jest.fn(async () => ({ ok: false, error: 'GitConflictNotFoundError' })) },
    });
    const app = await build();

    const response = await getConflictStagesAt(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'));

    expect(response.statusCode).toBe(422);

    await app.close();
  });

  it('answers 502 when the worker is unreachable', async () => {
    const { build } = buildHarness({
      role: 'viewer',
      client: {
        getConflictStages: jest.fn(async () => {
          throw new GitWorkerTransportError('boom');
        }),
      },
    });
    const app = await build();

    const response = await getConflictStagesAt(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'));

    expect(response.statusCode).toBe(502);

    await app.close();
  });
});

describe('POST /projects/:projectId/git/conflicts/:path', () => {
  it('returns 200 {resolved:true} for an editor choosing ours', async () => {
    const { build, resolveConflict } = buildHarness({ role: 'editor' });
    const app = await build();

    const response = await postResolve(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'), { resolution: 'ours' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ resolved: true });
    expect(resolveConflict).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      path: 'docs/a.adoc',
      resolution: 'ours',
    });

    await app.close();
  });

  it('forwards mergedContent when resolution is merged', async () => {
    const { build, resolveConflict } = buildHarness({ role: 'editor' });
    const app = await build();

    const response = await postResolve(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'), {
      resolution: 'merged',
      mergedContent: 'the merged text',
    });

    expect(response.statusCode).toBe(200);
    expect(resolveConflict).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      path: 'docs/a.adoc',
      resolution: 'merged',
      mergedContent: 'the merged text',
    });

    await app.close();
  });

  it('answers 403 for a viewer and never calls the worker client (denial path, editor-only route)', async () => {
    const { build, resolveConflict } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await postResolve(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'), { resolution: 'ours' });

    expect(response.statusCode).toBe(403);
    expect(resolveConflict).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-member and never calls the worker client', async () => {
    const { build, resolveConflict } = buildHarness({ role: null });
    const app = await build();

    const response = await postResolve(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'), { resolution: 'ours' });

    expect(response.statusCode).toBe(403);
    expect(resolveConflict).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 422 for an unrecognised resolution and never calls the worker client', async () => {
    const { build, resolveConflict } = buildHarness({ role: 'editor' });
    const app = await build();

    const response = await postResolve(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'), { resolution: 'bogus' });

    expect(response.statusCode).toBe(422);
    expect(resolveConflict).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 400 for a traversal path and never calls the worker client', async () => {
    const { build, resolveConflict } = buildHarness({ role: 'editor' });
    const app = await build();

    const response = await postResolve(app, PROJECT_ID, encodeURIComponent('../../etc/passwd'), { resolution: 'ours' });

    expect(response.statusCode).toBe(400);
    expect(resolveConflict).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps InvalidResolutionError (e.g. merged without content) to 422', async () => {
    const { build } = buildHarness({
      role: 'editor',
      client: { resolveConflict: jest.fn(async () => ({ ok: false, error: 'InvalidResolutionError' })) },
    });
    const app = await build();

    const response = await postResolve(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'), { resolution: 'merged' });

    expect(response.statusCode).toBe(422);

    await app.close();
  });

  it('answers 502 when the worker is unreachable', async () => {
    const { build } = buildHarness({
      role: 'editor',
      client: {
        resolveConflict: jest.fn(async () => {
          throw new GitWorkerTransportError('boom');
        }),
      },
    });
    const app = await build();

    const response = await postResolve(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'), { resolution: 'ours' });

    expect(response.statusCode).toBe(502);

    await app.close();
  });

  it('answers 429 once the caller has spent the git rate limit', async () => {
    const resolveConflict = jest.fn(async () => ({ ok: true, data: { resolved: true } }));
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 1, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
      auditLog: { save: jest.fn() },
    } as never);
    app.decorate('stores', {
      gitWorkerClient: { listConflicts: jest.fn(), getConflictStages: jest.fn(), resolveConflict },
    } as never);
    await app.register(gitConflictsRoutes);
    await app.ready();

    const first = await postResolve(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'), { resolution: 'ours' });
    const second = await postResolve(app, PROJECT_ID, encodeURIComponent('docs/a.adoc'), { resolution: 'ours' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await app.close();
  });
});
