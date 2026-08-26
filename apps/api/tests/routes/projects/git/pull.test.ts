import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitOperation, GitOperationId, DocumentId } from '@asciidocollab/domain';
import type { EnqueueGitOperationInput } from '@asciidocollab/domain';
import { gitPullRoutes } from '../../../../src/routes/projects/git/pull';
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
  /** Document ids `findActiveDocumentIds` should report as open; empty by default. */
  activeDocumentIds?: DocumentId[];
}

function buildHarness(options: HarnessOptions = {}) {
  const { role = 'editor', activeDocumentIds = [] } = options;
  const enqueuedOperations: EnqueueGitOperationInput[] = [];
  const auditSave = jest.fn();
  const findActiveDocumentIds = jest.fn(async () => activeDocumentIds);

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
      collaborationSession: { findActiveDocumentIds },
    } as never);
    await app.register(gitPullRoutes);
    await app.ready();
    return app;
  };

  return { build, enqueue, enqueuedOperations, auditSave, findActiveDocumentIds };
}

function pull(app: FastifyInstance, projectId: string, body: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/git/pull`, payload: body });
}

describe('POST /projects/:projectId/git/pull', () => {
  it('enqueues a PULL operation for an editor with no active sessions and answers 202', async () => {
    const { build, enqueuedOperations } = buildHarness();
    const app = await build();

    const response = await pull(app, PROJECT_ID);

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.operationId).toEqual(expect.any(String));
    expect(body.projectId).toBe(PROJECT_ID);

    expect(enqueuedOperations).toHaveLength(1);
    expect(enqueuedOperations[0]).toMatchObject({
      projectId: expect.objectContaining({ value: PROJECT_ID }),
      kind: 'PULL',
      triggeredByUserId: expect.objectContaining({ value: ACTOR_ID }),
      branch: null,
    });

    await app.close();
  });

  it('answers 409 when files are open in live editing sessions and confirmation is not given', async () => {
    const { build, enqueue } = buildHarness({
      activeDocumentIds: [DocumentId.create(randomUUID())],
    });
    const app = await build();

    const response = await pull(app, PROJECT_ID);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'open_files_need_confirm' },
    });
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('enqueues a PULL operation when open sessions exist but the caller confirms', async () => {
    const { build, enqueue, enqueuedOperations } = buildHarness({
      activeDocumentIds: [DocumentId.create(randomUUID())],
    });
    const app = await build();

    const response = await pull(app, PROJECT_ID, { confirmAffectsOpenFiles: true });

    expect(response.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueuedOperations[0]).toMatchObject({ kind: 'PULL' });

    await app.close();
  });

  it('answers 403 for a non-editor and never enqueues an operation', async () => {
    const { build, enqueue } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await pull(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'insufficient_role' } });
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-member and never enqueues an operation', async () => {
    const { build, enqueue } = buildHarness({ role: null });
    const app = await build();

    const response = await pull(app, PROJECT_ID);

    expect(response.statusCode).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 429 once the caller has spent the git rate limit', async () => {
    const { enqueue, auditSave, findActiveDocumentIds } = buildHarness();
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(rateLimit, { global: false });
    app.decorate('config', { git: { rateLimitMax: 1, rateLimitWindow: 60_000 } } as never);
    app.decorate('repos', {
      projectMember: { findByCompositeKey: jest.fn(async () => ({ role: { value: 'editor' } })) },
      auditLog: { save: auditSave },
      gitOperation: { enqueue },
      collaborationSession: { findActiveDocumentIds },
    } as never);
    await app.register(gitPullRoutes);
    await app.ready();

    const first = await pull(app, PROJECT_ID);
    const second = await pull(app, PROJECT_ID);

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
      collaborationSession: { findActiveDocumentIds: jest.fn() },
    } as never);
    await app.register(gitPullRoutes);
    await app.ready();

    const response = await pull(app, PROJECT_ID);

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
