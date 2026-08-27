import Fastify, { type FastifyInstance } from 'fastify';
import { GitOperation, GitOperationId, ProjectId, UserId } from '@asciidocollab/domain';
import { gitActiveOperationRoutes } from '../../../../src/routes/projects/git/active-operation';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_USER_ID = '550e8400-e29b-41d4-a716-446655440099';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440003';

/** Builds a domain GitOperation with sensible defaults, overridable per test. */
function buildOperation(overrides: {
  id?: string;
  state?: GitOperation['state'];
  progress?: number;
  errorCode?: string | null;
  kind?: GitOperation['kind'];
} = {}): GitOperation {
  return new GitOperation(
    GitOperationId.create(overrides.id ?? OPERATION_ID),
    ProjectId.create(PROJECT_ID),
    overrides.kind ?? 'PULL',
    overrides.state ?? 'RUNNING',
    UserId.create(OTHER_USER_ID),
    null,
    overrides.progress ?? 40,
    null,
    overrides.errorCode ?? null,
  );
}

function buildServer(options: {
  role?: string | null;
  activeOperation?: GitOperation | null;
}): { instance: FastifyInstance; findActiveOperation: jest.Mock; auditSave: jest.Mock } {
  const { role = 'viewer', activeOperation = null } = options;
  const auditSave = jest.fn();
  const findActiveOperation = jest.fn(async () => activeOperation);

  const instance = Fastify();
  instance.setErrorHandler(errorHandler);
  instance.decorate('repos', {
    gitOperation: { findActiveOperation },
    projectMember: {
      findByCompositeKey: jest.fn(async () => (role === null ? null : { role: { value: role } })),
    },
    auditLog: { save: auditSave },
  } as never);

  return { instance, findActiveOperation, auditSave };
}

function getActiveOperation(app: FastifyInstance, projectId: string) {
  return app.inject({ method: 'GET', url: `/api/projects/${projectId}/git/active-operation` });
}

describe('GET /projects/:projectId/git/active-operation', () => {
  test('returns the active operation, mapped to the status DTO, for a viewer-tier member', async () => {
    const operation = buildOperation({ kind: 'PULL', state: 'RUNNING', progress: 55 });
    const { instance } = buildServer({ role: 'viewer', activeOperation: operation });
    await instance.register(gitActiveOperationRoutes);

    const response = await getActiveOperation(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      operation: { id: OPERATION_ID, kind: 'PULL', state: 'RUNNING', progress: 55, errorCode: null, driftSummary: null },
    });

    await instance.close();
  });

  test('returns operation: null for a viewer-tier member when the project has no active operation', async () => {
    const { instance, findActiveOperation } = buildServer({ role: 'viewer', activeOperation: null });
    await instance.register(gitActiveOperationRoutes);

    const response = await getActiveOperation(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ operation: null });
    expect(findActiveOperation).toHaveBeenCalledWith(expect.objectContaining({ value: PROJECT_ID }));

    await instance.close();
  });

  test('surfaces an AWAITING_CONFLICT operation with its errorCode', async () => {
    const operation = buildOperation({ state: 'AWAITING_CONFLICT', progress: 70 });
    const { instance } = buildServer({ role: 'owner', activeOperation: operation });
    await instance.register(gitActiveOperationRoutes);

    const response = await getActiveOperation(instance, PROJECT_ID);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      operation: { id: OPERATION_ID, kind: 'PULL', state: 'AWAITING_CONFLICT', progress: 70, errorCode: null, driftSummary: null },
    });

    await instance.close();
  });

  test('gates BEFORE calling the repository: a non-member gets 403 and findActiveOperation is never called', async () => {
    const { instance, findActiveOperation } = buildServer({ role: null, activeOperation: buildOperation() });
    await instance.register(gitActiveOperationRoutes);

    const response = await getActiveOperation(instance, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_role');
    expect(findActiveOperation).not.toHaveBeenCalled();

    await instance.close();
  });
});
