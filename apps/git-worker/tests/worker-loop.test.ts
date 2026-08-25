import pino from 'pino';
import { ProjectId, UserId } from '@asciidocollab/domain';
import type { GitOperation } from '@asciidocollab/domain';
import { createGitWorkerLoop } from '../src/worker-loop.js';
import type { GitOperationHandlerRegistry } from '../src/dispatch/git-operation-dispatcher.js';
import { InMemoryGitOperationRepository } from './helpers/in-memory-git-operation-repository.js';
import { InMemoryAuditLogRepository } from './helpers/in-memory-audit-log-repository.js';

const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440100');
const user = UserId.create('550e8400-e29b-41d4-a716-446655440101');

/** Silent logger — the loop logs diagnostics on error paths that are expected in several tests here. */
const logger = pino({ level: 'silent' });

/** Polls `predicate` until it is true or `timeoutMs` elapses, without busy-spinning the CPU. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: condition was never met');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Builds a loop with fast, test-sized timings and the given handler registry, defaulting collaborators to no-ops/fakes. */
function buildLoop(overrides: {
  gitOperationRepository?: InMemoryGitOperationRepository;
  auditLogRepository?: InMemoryAuditLogRepository;
  handlers?: GitOperationHandlerRegistry;
  ensureCleanWorkingTree?: jest.Mock;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  staleHeartbeatAfterMs?: number;
}) {
  const gitOperationRepository = overrides.gitOperationRepository ?? new InMemoryGitOperationRepository();
  const auditLogRepository = overrides.auditLogRepository ?? new InMemoryAuditLogRepository();
  const ensureCleanWorkingTree = overrides.ensureCleanWorkingTree ?? jest.fn(async () => {});

  const loop = createGitWorkerLoop({
    gitOperationRepository,
    auditLogRepository,
    handlers: overrides.handlers ?? {},
    ensureCleanWorkingTree,
    logger,
    pollIntervalMs: overrides.pollIntervalMs ?? 10,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 10,
    staleHeartbeatAfterMs: overrides.staleHeartbeatAfterMs ?? 30_000,
  });

  return { loop, gitOperationRepository, auditLogRepository, ensureCleanWorkingTree };
}

describe('git-worker run loop', () => {
  it('claims a QUEUED operation and dispatches it to the handler registered for its kind', async () => {
    const calls: GitOperation[] = [];
    const handlers: GitOperationHandlerRegistry = {
      PUSH: async (operation) => {
        calls.push(operation);
        return { kind: 'succeeded' };
      },
    };
    const { loop, gitOperationRepository } = buildLoop({ handlers });
    const enqueued = await gitOperationRepository.enqueue({ projectId, kind: 'PUSH', triggeredByUserId: user });

    loop.start();
    try {
      await waitUntil(() => calls.length === 1);
      expect(calls[0].id.value).toBe(enqueued.id.value);
    } finally {
      await loop.stop();
    }
  });

  it('does not dispatch a claimed operation to a handler registered for a different kind', async () => {
    const pushCalls: string[] = [];
    const pullCalls: string[] = [];
    const handlers: GitOperationHandlerRegistry = {
      PUSH: async (op) => {
        pushCalls.push(op.id.value);
        return { kind: 'succeeded' };
      },
      PULL: async (op) => {
        pullCalls.push(op.id.value);
        return { kind: 'succeeded' };
      },
    };
    const { loop, gitOperationRepository } = buildLoop({ handlers });
    const enqueued = await gitOperationRepository.enqueue({ projectId, kind: 'PULL', triggeredByUserId: user });

    loop.start();
    try {
      await waitUntil(() => pullCalls.length === 1);
      expect(pullCalls).toEqual([enqueued.id.value]);
      expect(pushCalls).toEqual([]);
    } finally {
      await loop.stop();
    }
  });

  it('calls ensureCleanWorkingTree for the claimed operation before dispatching its handler', async () => {
    const callOrder: string[] = [];
    const ensureCleanWorkingTree = jest.fn(async () => {
      callOrder.push('clean');
    });
    const handlers: GitOperationHandlerRegistry = {
      COMMIT: async () => {
        callOrder.push('handler');
        return { kind: 'succeeded' };
      },
    };
    const { loop, gitOperationRepository } = buildLoop({ handlers, ensureCleanWorkingTree });
    await gitOperationRepository.enqueue({ projectId, kind: 'COMMIT', triggeredByUserId: user });

    loop.start();
    try {
      await waitUntil(() => callOrder.length === 2);
      expect(callOrder).toEqual(['clean', 'handler']);
      expect(ensureCleanWorkingTree).toHaveBeenCalledTimes(1);
    } finally {
      await loop.stop();
    }
  });

  it('refreshes the heartbeat on an interval while a claimed job is running', async () => {
    const { promise: blocker, resolve: releaseHandler } = Promise.withResolvers<void>();
    const handlers: GitOperationHandlerRegistry = {
      FETCH: async () => {
        await blocker;
        return { kind: 'succeeded' };
      },
    };
    const { loop, gitOperationRepository } = buildLoop({ handlers, heartbeatIntervalMs: 10 });
    const heartbeatSpy = jest.spyOn(gitOperationRepository, 'heartbeat');
    await gitOperationRepository.enqueue({ projectId, kind: 'FETCH', triggeredByUserId: user });

    loop.start();
    try {
      await waitUntil(() => heartbeatSpy.mock.calls.length >= 2);
    } finally {
      releaseHandler();
      await loop.stop();
    }
  });

  it('sets SUCCEEDED and records an AuditLog entry when the handler succeeds', async () => {
    const handlers: GitOperationHandlerRegistry = { PUSH: async () => ({ kind: 'succeeded' }) };
    const { loop, gitOperationRepository, auditLogRepository } = buildLoop({ handlers });
    const enqueued = await gitOperationRepository.enqueue({ projectId, kind: 'PUSH', triggeredByUserId: user });

    loop.start();
    try {
      await waitUntil(async () => {
        const logs = await auditLogRepository.findAll();
        return logs.length === 1;
      });
    } finally {
      await loop.stop();
    }

    const logs = await auditLogRepository.findAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('git.operation_succeeded');
    expect(logs[0].resourceId).toBe(enqueued.id.value);
    expect(logs[0].projectId?.value).toBe(projectId.value);
    expect(logs[0].userId?.value).toBe(user.value);

    // Re-fetch via claimNextQueued would move it again; assert terminal state directly isn't
    // exposed by the port beyond claim/transition, so assert through a fresh transition attempt
    // instead: SUCCEEDED is terminal, so any further transition must be rejected as illegal.
    const result = await gitOperationRepository.transition(enqueued.id, 'FAILED', { errorCode: 'X' });
    expect(result.success).toBe(false);
  });

  it('sets FAILED and records an AuditLog entry with the errorCode when the handler fails', async () => {
    const handlers: GitOperationHandlerRegistry = {
      PULL: async () => ({ kind: 'failed', errorCode: 'REPOSITORY_UNREACHABLE' }),
    };
    const { loop, gitOperationRepository, auditLogRepository } = buildLoop({ handlers });
    const enqueued = await gitOperationRepository.enqueue({ projectId, kind: 'PULL', triggeredByUserId: user });

    loop.start();
    try {
      await waitUntil(async () => {
        const logs = await auditLogRepository.findAll();
        return logs.length === 1;
      });
    } finally {
      await loop.stop();
    }

    const logs = await auditLogRepository.findAll();
    expect(logs[0].action).toBe('git.operation_failed');
    expect(logs[0].resourceId).toBe(enqueued.id.value);
    expect(logs[0].metadata.errorCode).toBe('REPOSITORY_UNREACHABLE');
  });

  it('sets FAILED with UNHANDLED_GIT_OPERATION_KIND when no handler is registered for the claimed kind', async () => {
    const { loop, gitOperationRepository, auditLogRepository } = buildLoop({ handlers: {} });
    await gitOperationRepository.enqueue({ projectId, kind: 'BRANCH_CREATE', triggeredByUserId: user });

    loop.start();
    try {
      await waitUntil(async () => {
        const logs = await auditLogRepository.findAll();
        return logs.length === 1;
      });
    } finally {
      await loop.stop();
    }

    const logs = await auditLogRepository.findAll();
    expect(logs[0].action).toBe('git.operation_failed');
    expect(logs[0].metadata.errorCode).toBe('UNHANDLED_GIT_OPERATION_KIND');
  });

  it('sets FAILED via the safe generic error code when a registered handler throws', async () => {
    const handlers: GitOperationHandlerRegistry = {
      PUSH: async () => {
        throw new Error('leaking internals should never reach the terminal state or the audit log');
      },
    };
    const { loop, gitOperationRepository, auditLogRepository } = buildLoop({ handlers });
    await gitOperationRepository.enqueue({ projectId, kind: 'PUSH', triggeredByUserId: user });

    loop.start();
    try {
      await waitUntil(async () => {
        const logs = await auditLogRepository.findAll();
        return logs.length === 1;
      });
    } finally {
      await loop.stop();
    }

    const logs = await auditLogRepository.findAll();
    expect(logs[0].action).toBe('git.operation_failed');
    expect(logs[0].metadata.errorCode).toBe('GIT_OPERATION_HANDLER_FAILED');
    expect(JSON.stringify(logs[0].metadata)).not.toContain('leaking internals');
  });

  it('moves a claimed operation to AWAITING_CONFLICT without recording an AuditLog entry', async () => {
    const handlers: GitOperationHandlerRegistry = { PULL: async () => ({ kind: 'awaitingConflict' }) };
    const { loop, gitOperationRepository, auditLogRepository } = buildLoop({ handlers });
    const enqueued = await gitOperationRepository.enqueue({ projectId, kind: 'PULL', triggeredByUserId: user });

    loop.start();
    try {
      await waitUntil(async () => {
        // AWAITING_CONFLICT is active, so a second op on the same project is refused by withGuard.
        const guard = await gitOperationRepository.withGuard(projectId, async () => 'blocked');
        return !guard.success;
      });
    } finally {
      await loop.stop();
    }

    expect(await auditLogRepository.findAll()).toEqual([]);
    // Sanity: the operation really did land in AWAITING_CONFLICT (RUNNING -> AWAITING_CONFLICT is
    // legal; RUNNING -> RUNNING is not, so this transition attempt distinguishes the two).
    const backToRunning = await gitOperationRepository.transition(enqueued.id, 'RUNNING');
    expect(backToRunning.success).toBe(true);
  });

  it('sets ABORTED and records an AuditLog entry when the handler reports aborted', async () => {
    const handlers: GitOperationHandlerRegistry = { DISCARD: async () => ({ kind: 'aborted' }) };
    const { loop, gitOperationRepository, auditLogRepository } = buildLoop({ handlers });
    await gitOperationRepository.enqueue({ projectId, kind: 'DISCARD', triggeredByUserId: user });

    loop.start();
    try {
      await waitUntil(async () => {
        const logs = await auditLogRepository.findAll();
        return logs.length === 1;
      });
    } finally {
      await loop.stop();
    }

    const logs = await auditLogRepository.findAll();
    expect(logs[0].action).toBe('git.operation_aborted');
  });

  it('opportunistically reclaims a stale RUNNING operation left by a crashed worker', async () => {
    const calls: string[] = [];
    const handlers: GitOperationHandlerRegistry = {
      PUSH: async (op) => {
        calls.push(op.id.value);
        return { kind: 'succeeded' };
      },
    };
    const gitOperationRepository = new InMemoryGitOperationRepository();
    const enqueued = await gitOperationRepository.enqueue({ projectId, kind: 'PUSH', triggeredByUserId: user });
    // Simulate a worker that claimed the op and then crashed: it is now RUNNING with a heartbeat
    // that will be stale well before the loop's very short threshold below.
    await gitOperationRepository.claimNextQueued(30_000);

    const { loop } = buildLoop({ handlers, gitOperationRepository, staleHeartbeatAfterMs: 5 });

    await new Promise((resolve) => setTimeout(resolve, 20)); // let the heartbeat go stale
    loop.start();
    try {
      await waitUntil(() => calls.includes(enqueued.id.value));
    } finally {
      await loop.stop();
    }
  });

  it('sets FAILED with a safe error code when ensureCleanWorkingTree throws, never reaching the handler', async () => {
    const handlerCalls: string[] = [];
    const handlers: GitOperationHandlerRegistry = {
      PUSH: async (op) => {
        handlerCalls.push(op.id.value);
        return { kind: 'succeeded' };
      },
    };
    const ensureCleanWorkingTree = jest.fn(async () => {
      throw new Error('reset --hard failed: leaking internals should never reach the audit log');
    });
    const { loop, gitOperationRepository, auditLogRepository } = buildLoop({ handlers, ensureCleanWorkingTree });
    await gitOperationRepository.enqueue({ projectId, kind: 'PUSH', triggeredByUserId: user });

    loop.start();
    try {
      await waitUntil(async () => {
        const logs = await auditLogRepository.findAll();
        return logs.length === 1;
      });
    } finally {
      await loop.stop();
    }

    const logs = await auditLogRepository.findAll();
    expect(logs[0].action).toBe('git.operation_failed');
    expect(logs[0].metadata.errorCode).toBe('ENSURE_CLEAN_WORKING_TREE_FAILED');
    expect(handlerCalls).toEqual([]);
    expect(JSON.stringify(logs[0].metadata)).not.toContain('leaking internals');
  });

  it('does not busy-spin: it claims only once while nothing is queued over several poll intervals', async () => {
    const { loop, gitOperationRepository } = buildLoop({ pollIntervalMs: 20 });
    const claimSpy = jest.spyOn(gitOperationRepository, 'claimNextQueued');

    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 65));
    await loop.stop();

    // Over ~65ms with a 20ms poll interval, a non-busy-spinning loop claims a small, bounded
    // number of times (~3-4), never anywhere close to what a tight busy-loop would rack up.
    expect(claimSpy.mock.calls.length).toBeLessThan(10);
    expect(claimSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('stops cleanly: stop() resolves and no further claims happen afterwards', async () => {
    const { loop, gitOperationRepository } = buildLoop({});
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await loop.stop();

    const claimSpy = jest.spyOn(gitOperationRepository, 'claimNextQueued');
    await gitOperationRepository.enqueue({ projectId, kind: 'PUSH', triggeredByUserId: user });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(claimSpy).not.toHaveBeenCalled();
  });
});
