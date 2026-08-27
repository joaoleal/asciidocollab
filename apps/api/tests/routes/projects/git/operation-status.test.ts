import Fastify, { type FastifyInstance } from 'fastify';
import { GitOperation, GitOperationId, ProjectId, UserId } from '@asciidocollab/domain';
import { gitOperationStatusRoutes } from '../../../../src/routes/projects/git/operation-status';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_USER_ID = '550e8400-e29b-41d4-a716-446655440099';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const OTHER_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440098';
const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440003';
const UNKNOWN_OPERATION_ID = '550e8400-e29b-41d4-a716-446655440004';

/** Builds a domain GitOperation with sensible defaults, overridable per test. */
function buildOperation(overrides: {
  id?: string;
  projectId?: string;
  triggeredByUserId?: string;
  state?: GitOperation['state'];
  progress?: number;
  errorCode?: string | null;
  kind?: GitOperation['kind'];
} = {}): GitOperation {
  return new GitOperation(
    GitOperationId.create(overrides.id ?? OPERATION_ID),
    ProjectId.create(overrides.projectId ?? PROJECT_ID),
    overrides.kind ?? 'PULL',
    overrides.state ?? 'RUNNING',
    UserId.create(overrides.triggeredByUserId ?? OTHER_USER_ID),
    null,
    overrides.progress ?? 40,
    null,
    overrides.errorCode ?? null,
  );
}

interface ServerOptions {
  /** The operation `findById` returns, or null to simulate an unknown id. */
  operation: GitOperation | null;
  /** The caller's role on `PROJECT_ID`, or null for "not a member". */
  role?: string | null;
}

function buildServer(options: ServerOptions): { app: Promise<FastifyInstance>; auditSave: jest.Mock } {
  const { operation, role = null } = options;
  const auditSave = jest.fn();

  const app = (async (): Promise<FastifyInstance> => {
    const instance = Fastify();
    instance.setErrorHandler(errorHandler);
    instance.decorate('repos', {
      gitOperation: {
        findById: jest.fn(async (id: GitOperationId) =>
          operation && id.value === operation.id.value ? operation : null,
        ),
      },
      projectMember: {
        findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
      },
      auditLog: { save: auditSave },
    } as never);
    await instance.register(gitOperationStatusRoutes);
    return instance;
  })();

  return { app, auditSave };
}

function getStatus(app: FastifyInstance, projectId: string, opId: string) {
  return app.inject({ method: 'GET', url: `/api/projects/${projectId}/git/operations/${opId}` });
}

describe('GET /projects/:projectId/git/operations/:opId', () => {
  it('returns the state/progress/errorCode for a project member (viewer-tier is enough)', async () => {
    const operation = buildOperation({ state: 'RUNNING', progress: 65, triggeredByUserId: OTHER_USER_ID });
    const { app } = buildServer({ operation, role: 'viewer' });
    const instance = await app;

    const response = await getStatus(instance, PROJECT_ID, OPERATION_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: OPERATION_ID,
      kind: 'PULL',
      state: 'RUNNING',
      progress: 65,
      errorCode: null,
      driftSummary: null,
    });

    await instance.close();
  });

  it('also returns the status for the triggerer even when they are not a project member (the invisible-import case)', async () => {
    const operation = buildOperation({
      kind: 'IMPORT',
      state: 'RUNNING',
      progress: 20,
      triggeredByUserId: ACTOR_ID,
    });
    // role: null — the caller holds no membership at all, since the project the import targets
    // is still invisible; the worker only grants membership once the import succeeds.
    const { app } = buildServer({ operation, role: null });
    const instance = await app;

    const response = await getStatus(instance, PROJECT_ID, OPERATION_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: OPERATION_ID, kind: 'IMPORT', state: 'RUNNING', progress: 20 });

    await instance.close();
  });

  it('surfaces the errorCode of a FAILED operation', async () => {
    const operation = buildOperation({
      state: 'FAILED',
      progress: 100,
      errorCode: 'remote_rejected',
      triggeredByUserId: OTHER_USER_ID,
    });
    const { app } = buildServer({ operation, role: 'owner' });
    const instance = await app;

    const response = await getStatus(instance, PROJECT_ID, OPERATION_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'FAILED', errorCode: 'remote_rejected', progress: 100 });

    await instance.close();
  });

  it('refuses a caller who is neither a project member nor the triggerer, without revealing the operation exists', async () => {
    const operation = buildOperation({ triggeredByUserId: OTHER_USER_ID });
    const { app } = buildServer({ operation, role: null });
    const instance = await app;

    const response = await getStatus(instance, PROJECT_ID, OPERATION_ID);
    const unknownResponse = await getStatus(instance, PROJECT_ID, UNKNOWN_OPERATION_ID);

    expect(response.statusCode).toBe(404);
    expect(unknownResponse.statusCode).toBe(404);
    // Same shape for "exists but you may not see it" and "does not exist" — no distinguishing leak.
    expect(response.json()).toEqual(unknownResponse.json());
    expect(JSON.stringify(response.json())).not.toContain(OPERATION_ID);

    await instance.close();
  });

  it('answers 404 for an operation whose projectId does not match the URL projectId', async () => {
    const operation = buildOperation({ projectId: OTHER_PROJECT_ID, triggeredByUserId: ACTOR_ID });
    const { app } = buildServer({ operation, role: 'owner' });
    const instance = await app;

    const response = await getStatus(instance, PROJECT_ID, OPERATION_ID);

    expect(response.statusCode).toBe(404);

    await instance.close();
  });

  it('answers 404 for an unknown operation id', async () => {
    const { app } = buildServer({ operation: null, role: 'owner' });
    const instance = await app;

    const response = await getStatus(instance, PROJECT_ID, UNKNOWN_OPERATION_ID);

    expect(response.statusCode).toBe(404);

    await instance.close();
  });

  it('answers 401 when the caller is not authenticated', async () => {
    const { requireAuth: realRequireAuth } = jest.requireActual<typeof import('../../../../src/plugins/require-auth')>(
      '../../../../src/plugins/require-auth',
    );
    const instance = Fastify();
    instance.setErrorHandler(errorHandler);
    instance.addHook('preHandler', async (request) => {
      (request as unknown as { session: Record<string, unknown> }).session = {};
    });
    instance.addHook('preHandler', realRequireAuth);
    instance.decorate('repos', {
      gitOperation: { findById: jest.fn() },
      projectMember: { findByCompositeKey: jest.fn() },
      auditLog: { save: jest.fn() },
    } as never);
    await instance.register(gitOperationStatusRoutes);

    const response = await getStatus(instance, PROJECT_ID, OPERATION_ID);

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');

    await instance.close();
  });
});
