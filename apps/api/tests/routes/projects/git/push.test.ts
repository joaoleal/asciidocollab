import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitOperation, GitOperationId } from '@asciidocollab/domain';
import type { EnqueueGitOperationInput } from '@asciidocollab/domain';
import { gitPushRoutes } from '../../../../src/routes/projects/git/push';
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
}

function buildHarness(options: HarnessOptions = {}) {
  const { role = 'editor' } = options;
  const enqueuedOperations: EnqueueGitOperationInput[] = [];
  const auditSave = jest.fn();

  const enqueue = jest.fn(async (input: EnqueueGitOperationInput) => {
    enqueuedOperations.push(input);
    return new GitOperation(
      GitOperationId.create(randomUUID()),
      input.projectId,
      input.kind,
      'QUEUED',
      input.triggeredByUserId,
      input.branch ?? null,
    );
  });

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
      gitOperation: { enqueue },
    } as never);
    await app.register(gitPushRoutes);
    await app.ready();
    return app;
  };

  return { build, enqueue, enqueuedOperations, auditSave };
}

function push(app: FastifyInstance, projectId: string) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/git/push`, payload: {} });
}

describe('POST /projects/:projectId/git/push', () => {
  it('enqueues a PUSH operation for an editor and answers 202 with operationId and projectId', async () => {
    const { build, enqueuedOperations } = buildHarness();
    const app = await build();

    const response = await push(app, PROJECT_ID);

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.operationId).toEqual(expect.any(String));
    expect(body.projectId).toBe(PROJECT_ID);

    expect(enqueuedOperations).toHaveLength(1);
    expect(enqueuedOperations[0]).toMatchObject({
      projectId: expect.objectContaining({ value: PROJECT_ID }),
      kind: 'PUSH',
      triggeredByUserId: expect.objectContaining({ value: ACTOR_ID }),
      branch: null,
    });

    await app.close();
  });

  it('answers 403 for a non-editor and never enqueues an operation', async () => {
    const { build, enqueue } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await push(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-member and never enqueues an operation', async () => {
    const { build, enqueue } = buildHarness({ role: null });
    const app = await build();

    const response = await push(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 429 once the caller has spent the git rate limit', async () => {
    const { enqueue, auditSave } = buildHarness();
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 1, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
      auditLog: { save: auditSave },
      gitOperation: { enqueue },
    } as never);
    await app.register(gitPushRoutes);
    await app.ready();

    const first = await push(app, PROJECT_ID);
    const second = await push(app, PROJECT_ID);

    expect(first.statusCode).toBe(202);
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
      gitOperation: { enqueue: jest.fn() },
    } as never);
    await app.register(gitPushRoutes);
    await app.ready();

    const response = await push(app, PROJECT_ID);

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
