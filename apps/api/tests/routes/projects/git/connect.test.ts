import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitConnectRoutes } from '../../../../src/routes/projects/git/connect';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const TOKEN = 'ghp_supersecrettoken1234567890abcdef';

const VALID_BODY = {
  provider: 'github',
  remoteUrl: 'https://github.com/acme/handbook.git',
  token: TOKEN,
};

const CONNECTED_REPOSITORY = {
  id: '990e8400-e29b-41d4-a716-446655440020',
  projectId: PROJECT_ID,
  provider: 'github',
  remoteUrl: VALID_BODY.remoteUrl,
  currentBranch: 'main',
  defaultBranch: null,
  syncStatus: 'UP_TO_DATE',
  lastSyncAt: null,
  connectedByUserId: ACTOR_ID,
  createdAt: '2026-08-24T12:00:00.000Z',
};

interface HarnessOptions {
  /** The caller's role on `PROJECT_ID`, or null for "not a member". */
  role?: string | null;
  /** What `connect` resolves to; defaults to a happy result. */
  clientResult?: unknown;
  /** When set, `connect` throws this instead of resolving. */
  clientError?: Error;
}

function buildHarness(options: HarnessOptions = {}) {
  const {
    role = 'owner',
    clientResult = { ok: true, data: { repository: CONNECTED_REPOSITORY } },
    clientError,
  } = options;

  const connect = jest.fn(async (_input: unknown) => {
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
    app.decorate('stores', { gitWorkerClient: { connect } } as never);
    await app.register(gitConnectRoutes);
    await app.ready();
    return app;
  };

  return { build, connect, auditSave };
}

function connectRepository(app: FastifyInstance, projectId: string, payload: Record<string, unknown> = VALID_BODY) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/git/connect`, payload });
}

describe('POST /projects/:projectId/git/connect', () => {
  it('returns 201 with the connected repository as plain string ids, and never echoes the token', async () => {
    const { build, connect } = buildHarness();
    const app = await build();

    const response = await connectRepository(app, PROJECT_ID);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ repository: CONNECTED_REPOSITORY });
    expect(JSON.stringify(response.json())).not.toContain(TOKEN);
    expect(connect).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      provider: 'github',
      remoteUrl: VALID_BODY.remoteUrl,
      token: TOKEN,
    });

    await app.close();
  });

  it('passes a requested branch through, and omits it when not given', async () => {
    const { build, connect } = buildHarness();
    const app = await build();

    await connectRepository(app, PROJECT_ID, { ...VALID_BODY, branch: 'develop' });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ branch: 'develop' }));

    connect.mockClear();
    await connectRepository(app, PROJECT_ID);
    const calledWith = connect.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(calledWith, 'branch')).toBe(false);

    await app.close();
  });

  it('answers 403 for a non-owner (editor) and never calls the worker client', async () => {
    const { build, connect } = buildHarness({ role: 'editor' });
    const app = await build();

    const response = await connectRepository(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(connect).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-member and never calls the worker client', async () => {
    const { build, connect } = buildHarness({ role: null });
    const app = await build();

    const response = await connectRepository(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(connect).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps RepositoryUnreachableError to 422 repository_unreachable', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'RepositoryUnreachableError' } });
    const app = await build();

    const response = await connectRepository(app, PROJECT_ID);

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('repository_unreachable');

    await app.close();
  });

  it('maps AuthenticationFailedError to 401 authentication_failed', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'AuthenticationFailedError' } });
    const app = await build();

    const response = await connectRepository(app, PROJECT_ID);

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('authentication_failed');

    await app.close();
  });

  it('maps RepositoryAlreadyConnectedError to 409 already_connected', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'RepositoryAlreadyConnectedError' } });
    const app = await build();

    const response = await connectRepository(app, PROJECT_ID);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('already_connected');

    await app.close();
  });

  it('answers 502 when the worker is unreachable', async () => {
    const { build } = buildHarness({ clientError: new GitWorkerTransportError('boom') });
    const app = await build();

    const response = await connectRepository(app, PROJECT_ID);

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');

    await app.close();
  });

  it('answers 400 when the token is missing', async () => {
    const { build, connect } = buildHarness();
    const app = await build();

    const response = await connectRepository(app, PROJECT_ID, { provider: 'github', remoteUrl: VALID_BODY.remoteUrl });

    expect(response.statusCode).toBe(400);
    expect(connect).not.toHaveBeenCalled();

    await app.close();
  });

  it('never echoes the token in any response, including an error response', async () => {
    const { build } = buildHarness({ clientResult: { ok: false, error: 'RepositoryUnreachableError' } });
    const app = await build();

    const response = await connectRepository(app, PROJECT_ID);

    expect(JSON.stringify(response.json())).not.toContain(TOKEN);

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
    app.decorate('stores', { gitWorkerClient: { connect: jest.fn() } } as never);
    await app.register(gitConnectRoutes);
    await app.ready();

    const response = await connectRepository(app, PROJECT_ID);

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
