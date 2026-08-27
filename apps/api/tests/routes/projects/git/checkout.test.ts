import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GitOperation, GitOperationId, DocumentId } from '@asciidocollab/domain';
import type { EnqueueGitOperationInput } from '@asciidocollab/domain';
import type { GitWorkerResult, GitWorkerStatusData } from '@asciidocollab/infrastructure';
import { GitWorkerTransportError } from '@asciidocollab/infrastructure';
import { gitCheckoutRoutes } from '../../../../src/routes/projects/git/checkout';
import { errorHandler } from '../../../../src/plugins/error-handler';

jest.mock('../../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _reply: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => ACTOR_ID),
}));

const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';

function cleanStatus(): GitWorkerStatusData {
  return {
    currentBranch: 'main',
    changes: [],
    syncStatus: 'UP_TO_DATE',
    defaultBranch: 'main',
    lastKnownRemoteHead: 'abc123',
    lastSyncAt: null,
  };
}

function dirtyStatus(): GitWorkerStatusData {
  return {
    ...cleanStatus(),
    changes: [{ path: 'a.adoc', changeType: 'modified', state: 'unstaged' }],
  };
}

interface HarnessOptions {
  /** The caller's role on `PROJECT_ID`, or null for "not a member". */
  role?: string | null;
  /** Document ids `findActiveDocumentIds` should report as open; empty by default. */
  activeDocumentIds?: DocumentId[];
  /** What `getStatus` resolves to; defaults to a clean tree. */
  statusResult?: GitWorkerResult<GitWorkerStatusData>;
  /** When set, `getStatus` throws this instead of resolving. */
  statusError?: Error;
}

function buildHarness(options: HarnessOptions = {}) {
  const {
    role = 'editor',
    activeDocumentIds = [],
    statusResult = { ok: true, data: cleanStatus() },
    statusError,
  } = options;
  const enqueuedOperations: EnqueueGitOperationInput[] = [];
  const auditSave = jest.fn();
  const findActiveDocumentIds = jest.fn(async () => activeDocumentIds);
  const getStatus = jest.fn(async () => {
    if (statusError) throw statusError;
    return statusResult;
  });

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
    app.decorate('stores', { gitWorkerClient: { getStatus } } as never);
    await app.register(gitCheckoutRoutes);
    await app.ready();
    return app;
  };

  return { build, enqueue, enqueuedOperations, auditSave, findActiveDocumentIds, getStatus };
}

function checkout(app: FastifyInstance, projectId: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/git/checkout`, payload: body });
}

describe('POST /projects/:projectId/git/checkout', () => {
  it('enqueues a BRANCH_SWITCH operation for an editor with a clean tree and no active sessions, answering 202', async () => {
    const { build, enqueuedOperations } = buildHarness();
    const app = await build();

    const response = await checkout(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.operationId).toEqual(expect.any(String));
    expect(body.projectId).toBe(PROJECT_ID);

    expect(enqueuedOperations).toHaveLength(1);
    expect(enqueuedOperations[0]).toMatchObject({
      projectId: expect.objectContaining({ value: PROJECT_ID }),
      kind: 'BRANCH_SWITCH',
      branch: 'feature/x',
      triggeredByUserId: expect.objectContaining({ value: ACTOR_ID }),
    });

    await app.close();
  });

  it('answers 409 uncommitted_changes when the tree is dirty and stashLocal is not set, without enqueuing', async () => {
    const { build, enqueue } = buildHarness({ statusResult: { ok: true, data: dirtyStatus() } });
    const app = await build();

    const response = await checkout(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'uncommitted_changes' } });
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('enqueues despite a dirty tree when stashLocal is true, and does not persist stashLocal onto the operation', async () => {
    const { build, enqueue, enqueuedOperations, getStatus } = buildHarness({
      statusResult: { ok: true, data: dirtyStatus() },
    });
    const app = await build();

    const response = await checkout(app, PROJECT_ID, { name: 'feature/x', stashLocal: true });

    expect(response.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // stashLocal:true skips the status gate entirely, so getStatus is never consulted.
    expect(getStatus).not.toHaveBeenCalled();
    expect(enqueuedOperations[0]).not.toHaveProperty('stashLocal');
    expect(Object.keys(enqueuedOperations[0]).toSorted()).toEqual(
      ['branch', 'kind', 'projectId', 'triggeredByUserId'].toSorted(),
    );

    await app.close();
  });

  it('answers 409 open_files_need_confirm when files are open and confirmation is not given', async () => {
    const { build, enqueue } = buildHarness({
      activeDocumentIds: [DocumentId.create(randomUUID())],
    });
    const app = await build();

    const response = await checkout(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'open_files_need_confirm' } });
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('enqueues when open sessions exist but the caller confirms', async () => {
    const { build, enqueue, enqueuedOperations } = buildHarness({
      activeDocumentIds: [DocumentId.create(randomUUID())],
    });
    const app = await build();

    const response = await checkout(app, PROJECT_ID, {
      name: 'feature/x',
      confirmAffectsOpenFiles: true,
    });

    expect(response.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueuedOperations[0]).toMatchObject({ kind: 'BRANCH_SWITCH', branch: 'feature/x' });

    await app.close();
  });

  it('checks uncommitted changes BEFORE the open-files gate', async () => {
    const { build, enqueue, findActiveDocumentIds } = buildHarness({
      statusResult: { ok: true, data: dirtyStatus() },
      activeDocumentIds: [DocumentId.create(randomUUID())],
    });
    const app = await build();

    const response = await checkout(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'uncommitted_changes' } });
    expect(findActiveDocumentIds).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 502 when the worker is unreachable while checking status', async () => {
    const { build, enqueue } = buildHarness({ statusError: new GitWorkerTransportError('boom') });
    const app = await build();

    const response = await checkout(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('git_worker_unavailable');
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('propagates a non-transport error from getStatus rather than swallowing it', async () => {
    const { build, enqueue } = buildHarness({ statusError: new Error('unexpected failure') });
    const app = await build();

    const response = await checkout(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('maps a domain refusal from getStatus via sendGitErrorResponse instead of enqueuing', async () => {
    const { build, enqueue } = buildHarness({
      statusResult: { ok: false, error: 'RepositoryNotConnectedError' },
    });
    const app = await build();

    const response = await checkout(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'repository_not_connected' } });
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-editor and never enqueues an operation', async () => {
    const { build, enqueue } = buildHarness({ role: 'viewer' });
    const app = await build();

    const response = await checkout(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'insufficient_role' } });
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 403 for a non-member and never enqueues an operation', async () => {
    const { build, enqueue } = buildHarness({ role: null });
    const app = await build();

    const response = await checkout(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 429 once the caller has spent the git rate limit', async () => {
    const { enqueue, auditSave, findActiveDocumentIds, getStatus } = buildHarness();
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
    app.decorate('stores', { gitWorkerClient: { getStatus } } as never);
    await app.register(gitCheckoutRoutes);
    await app.ready();

    const first = await checkout(app, PROJECT_ID, { name: 'feature/x' });
    const second = await checkout(app, PROJECT_ID, { name: 'feature/x' });

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
    app.decorate('stores', { gitWorkerClient: { getStatus: jest.fn() } } as never);
    await app.register(gitCheckoutRoutes);
    await app.ready();

    const response = await checkout(app, PROJECT_ID, { name: 'feature/x' });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
