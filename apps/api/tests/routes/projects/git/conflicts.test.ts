import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import {
  gitConflictsRoutes,
  toConflictListDto,
  toConflictStagesDto,
  decodeConflictPath,
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

describe('decodeConflictPath (pure helper)', () => {
  it('decodes a percent-encoded relative path', () => {
    expect(decodeConflictPath(encodeURIComponent('docs/a b.adoc'))).toBe('docs/a b.adoc');
  });

  it('rejects an empty path', () => {
    expect(decodeConflictPath('')).toBeNull();
  });

  it('rejects an absolute path', () => {
    expect(decodeConflictPath(encodeURIComponent('/etc/passwd'))).toBeNull();
  });

  it('rejects a path containing a traversal segment', () => {
    expect(decodeConflictPath(encodeURIComponent('../../etc/passwd'))).toBeNull();
    expect(decodeConflictPath(encodeURIComponent('docs/../../../etc/passwd'))).toBeNull();
  });

  it('rejects a malformed percent-encoding', () => {
    expect(decodeConflictPath('%')).toBeNull();
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
  return app.inject({ method: 'GET', url: `/projects/${projectId}/git/conflicts` });
}

function getConflictStagesAt(app: FastifyInstance, projectId: string, encodedPath: string) {
  return app.inject({ method: 'GET', url: `/projects/${projectId}/git/conflicts/${encodedPath}` });
}

function postResolve(app: FastifyInstance, projectId: string, encodedPath: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/projects/${projectId}/git/conflicts/${encodedPath}`, payload: body });
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
});
