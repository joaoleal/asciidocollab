import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  ProjectId,
  UserId,
  GitOperationId,
  GitConflictId,
  GitOperationInProgressError,
  IllegalGitOperationTransitionError,
} from '@asciidocollab/domain';
import { PrismaGitOperationRepository } from '../../../src/persistence/git/prisma-git-operation.repository';

type OperationRow = {
  id: string;
  projectId: string;
  kind: string;
  state: string;
  branch: string | null;
  triggeredByUserId: string;
  progress: number;
  heartbeatAt: Date | null;
  errorCode: string | null;
  driftSummary: Prisma.JsonValue | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

type ConflictRow = {
  id: string;
  operationId: string;
  path: string;
  isBinary: boolean;
  resolved: boolean;
  resolution: string | null;
  createdAt: Date;
};

type RepositoryRow = { projectId: string; currentBranch: string };

/** Explicit shape for the fake client so `$transaction`'s closure over `client` doesn't force TS to infer its type from its own initializer (a circularity TS rejects). */
type FakeGitPrismaClient = {
  gitOperation: {
    create: jest.Mock;
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  gitConflict: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; deleteMany: jest.Mock };
  gitRepository: { findUnique: jest.Mock; update: jest.Mock };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
};

/**
 * Minimal in-memory stand-in for the `gitOperation`/`gitConflict`/`gitRepository` Prisma delegates,
 * plus `$transaction`/`$queryRaw`. No DB/testcontainer needed — this is what lets the control-flow
 * and mapping tests below run in this sandbox. It deliberately does NOT model real Postgres
 * concurrency/isolation (a single JS thread can't); the true concurrency behavior (SKIP LOCKED
 * claim races, SERIALIZABLE write-conflict detection under real load) is covered by the
 * testcontainer-based integration suite (prisma-git-operation.repository.test.ts), which this
 * sandbox cannot run — see that file's header comment.
 */
function fakePrismaClient() {
  const operations = new Map<string, OperationRow>();
  const conflicts = new Map<string, ConflictRow>();
  const repositories = new Map<string, RepositoryRow>();
  let transactionOptions: unknown;

  const client: FakeGitPrismaClient = {
    gitOperation: {
      create: jest.fn(
        async ({
          data,
        }: {
          data: { projectId: string; kind: string; triggeredByUserId: string; branch: string | null };
        }) => {
          const row: OperationRow = {
            id: randomUUID(),
            projectId: data.projectId,
            kind: data.kind,
            state: 'QUEUED',
            branch: data.branch ?? null,
            triggeredByUserId: data.triggeredByUserId,
            progress: 0,
            heartbeatAt: null,
            errorCode: null,
            driftSummary: null,
            startedAt: null,
            finishedAt: null,
            createdAt: new Date(),
          };
          operations.set(row.id, row);
          return row;
        },
      ),
      findFirst: jest.fn(
        async ({
          where,
          select,
        }: {
          where: { projectId: string; state: { in: string[] }; id?: { not: string } };
          select?: { id: true };
        }) => {
          for (const row of operations.values()) {
            if (
              row.projectId === where.projectId &&
              where.state.in.includes(row.state) &&
              (!where.id || row.id !== where.id.not)
            ) {
              // withGuard's active-op check passes `select: { id: true }`; findActiveOperation
              // passes no select and needs the full row back to map into a domain `GitOperation`.
              return select ? { id: row.id } : row;
            }
          }
          return null;
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; state?: { in: string[] } };
          data: Partial<OperationRow>;
        }) => {
          const row = operations.get(where.id);
          if (!row) return { count: 0 };
          if (where.state && !where.state.in.includes(row.state)) return { count: 0 };
          Object.assign(row, data);
          // Prisma writes SQL NULL for a `Json?` column via the `Prisma.DbNull` sentinel, not JS null;
          // normalize it here so the stored row mirrors what a real read would return.
          if ((data as { driftSummary?: unknown }).driftSummary === Prisma.DbNull) row.driftSummary = null;
          return { count: 1 };
        },
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => operations.get(where.id) ?? null),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = operations.get(where.id);
        if (!row) throw new Error('gitOperation row not found in fake');
        return row;
      }),
    },
    gitConflict: {
      create: jest.fn(
        async ({ data }: { data: { operationId: string; path: string; isBinary: boolean } }) => {
          const row: ConflictRow = {
            id: randomUUID(),
            operationId: data.operationId,
            path: data.path,
            isBinary: data.isBinary,
            resolved: false,
            resolution: null,
            createdAt: new Date(),
          };
          conflicts.set(row.id, row);
          return row;
        },
      ),
      findMany: jest.fn(
        async ({
          where,
          orderBy,
        }: {
          where: { operationId: string };
          orderBy?: { createdAt: 'asc' | 'desc' };
        }) => {
          const rows = [...conflicts.values()]
            .filter((c) => c.operationId === where.operationId)
            .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          return orderBy?.createdAt === 'desc' ? rows.toReversed() : rows;
        },
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => conflicts.get(where.id) ?? null),
      deleteMany: jest.fn(async ({ where }: { where: { operationId: string } }) => {
        let count = 0;
        for (const [id, row] of conflicts) {
          if (row.operationId === where.operationId) {
            conflicts.delete(id);
            count += 1;
          }
        }
        return { count };
      }),
    },
    gitRepository: {
      findUnique: jest.fn(async ({ where }: { where: { projectId: string } }) => repositories.get(where.projectId) ?? null),
      update: jest.fn(async ({ where, data }: { where: { projectId: string }; data: Partial<RepositoryRow> }) => {
        const row = repositories.get(where.projectId);
        if (!row) throw new Error('gitRepository row not found in fake');
        Object.assign(row, data);
        return row;
      }),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      transactionOptions = options;
      return callback(client);
    }),
  };

  return {
    client: client as unknown as PrismaClient,
    operations,
    conflicts,
    repositories,
    getTransactionOptions: () => transactionOptions,
  };
}

describe('PrismaGitOperationRepository', () => {
  const projA = ProjectId.create('550e8400-e29b-41d4-a716-446655440030');
  const projB = ProjectId.create('550e8400-e29b-41d4-a716-446655440031');
  const user = UserId.create('550e8400-e29b-41d4-a716-446655440032');

  describe('enqueue', () => {
    it('enqueues an operation in QUEUED state with the given fields', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);

      const op = await repo.enqueue({ projectId: projA, kind: 'PUSH', triggeredByUserId: user, branch: 'main' });

      expect(op.state).toBe('QUEUED');
      expect(op.projectId.value).toBe(projA.value);
      expect(op.kind).toBe('PUSH');
      expect(op.triggeredByUserId.value).toBe(user.value);
      expect(op.branch).toBe('main');
      expect(op.progress).toBe(0);
      expect(op.heartbeatAt).toBeNull();
    });

    it('defaults branch to null when omitted', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);

      const op = await repo.enqueue({ projectId: projA, kind: 'COMMIT', triggeredByUserId: user });

      expect(op.branch).toBeNull();
    });

    it('regression: maps a P2002 unique-constraint violation (a concurrent enqueue racing GitOperation_one_active_per_project) to GitOperationInProgressError', async () => {
      const { client } = fakePrismaClient();
      (client.gitOperation.create as unknown as jest.Mock).mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`projectId`)', {
          code: 'P2002',
          clientVersion: '7.9.1',
        }),
      );
      const repo = new PrismaGitOperationRepository(client);

      await expect(repo.enqueue({ projectId: projA, kind: 'PUSH', triggeredByUserId: user })).rejects.toBeInstanceOf(
        GitOperationInProgressError,
      );
    });

    it('re-throws an unrelated Prisma error from enqueue rather than treating it as an in-progress conflict', async () => {
      const { client } = fakePrismaClient();
      const unrelated = new Prisma.PrismaClientKnownRequestError('connection reset', {
        code: 'P1017',
        clientVersion: '7.9.1',
      });
      (client.gitOperation.create as unknown as jest.Mock).mockRejectedValueOnce(unrelated);
      const repo = new PrismaGitOperationRepository(client);

      await expect(repo.enqueue({ projectId: projA, kind: 'PUSH', triggeredByUserId: user })).rejects.toBe(
        unrelated,
      );
    });
  });

  describe('claimNextQueued', () => {
    it('returns null when there is nothing to claim', async () => {
      const { client } = fakePrismaClient();
      (client.$queryRaw as unknown as jest.Mock).mockResolvedValueOnce([]);
      const repo = new PrismaGitOperationRepository(client);

      expect(await repo.claimNextQueued(30_000)).toBeNull();
    });

    it('maps the claimed row back to a GitOperation entity', async () => {
      const { client } = fakePrismaClient();
      const row: OperationRow = {
        id: randomUUID(),
        projectId: projA.value,
        kind: 'PUSH',
        state: 'RUNNING',
        branch: 'main',
        triggeredByUserId: user.value,
        progress: 0,
        heartbeatAt: new Date('2026-01-01T00:00:05.000Z'),
        errorCode: null,
        driftSummary: null,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        finishedAt: null,
        createdAt: new Date('2025-12-31T00:00:00.000Z'),
      };
      (client.$queryRaw as unknown as jest.Mock).mockResolvedValueOnce([row]);
      const repo = new PrismaGitOperationRepository(client);

      const claimed = await repo.claimNextQueued(30_000);

      expect(claimed?.id.value).toBe(row.id);
      expect(claimed?.projectId.value).toBe(projA.value);
      expect(claimed?.kind).toBe('PUSH');
      expect(claimed?.state).toBe('RUNNING');
      expect(claimed?.branch).toBe('main');
      expect(claimed?.triggeredByUserId.value).toBe(user.value);
      expect(claimed?.heartbeatAt).toEqual(row.heartbeatAt);
      expect(claimed?.startedAt).toEqual(row.startedAt);
      expect(claimed?.createdAt).toEqual(row.createdAt);
    });

    it('issues one FOR UPDATE SKIP LOCKED claim with parameterized (never string-interpolated) values', async () => {
      const { client } = fakePrismaClient();
      (client.$queryRaw as unknown as jest.Mock).mockResolvedValueOnce([]);
      const repo = new PrismaGitOperationRepository(client);

      const before = Date.now();
      await repo.claimNextQueued(45_000);
      const after = Date.now();

      expect(client.$queryRaw).toHaveBeenCalledTimes(1);
      const call = (client.$queryRaw as unknown as jest.Mock).mock.calls[0] as [
        readonly string[],
        Date,
        Date,
        Date,
      ];
      const [strings, staleBefore, nowA, nowB] = call;
      const sql = [...strings].join('');

      // The claim + reclaim + RUNNING transition happen in one atomic statement.
      expect(sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(sql).toContain('QUEUED');
      expect(sql).toContain('RUNNING');
      // Values are bound parameters, never spliced into the SQL text.
      expect(sql).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

      expect(nowA).toEqual(nowB); // the same "now" is bound twice (heartbeatAt + COALESCE(startedAt, now))
      expect(nowA.getTime()).toBeGreaterThanOrEqual(before);
      expect(nowA.getTime()).toBeLessThanOrEqual(after);
      expect(staleBefore.getTime()).toBe(nowA.getTime() - 45_000);
    });
  });

  describe('heartbeat', () => {
    it('refreshes heartbeatAt for an existing operation', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'COMMIT', triggeredByUserId: user });

      await repo.heartbeat(enqueued.id);

      expect(operations.get(enqueued.id.value)?.heartbeatAt).toBeInstanceOf(Date);
    });

    it('is a no-op for an operation id that does not exist', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);

      await expect(repo.heartbeat(GitOperationId.create(randomUUID()))).resolves.toBeUndefined();
    });
  });

  describe('transition', () => {
    it('moves a RUNNING operation to SUCCEEDED, setting progress to 100 and finishedAt', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'PUSH', triggeredByUserId: user });
      operations.get(enqueued.id.value)!.state = 'RUNNING';

      const result = await repo.transition(enqueued.id, 'SUCCEEDED');

      expect(result.success).toBe(true);
      expect(result.success && result.value.state).toBe('SUCCEEDED');
      expect(result.success && result.value.progress).toBe(100);
      expect(result.success && result.value.finishedAt).toBeInstanceOf(Date);
      expect(result.success && result.value.errorCode).toBeNull();
    });

    it('persists and reads back a driftSummary on a SUCCEEDED transition, versioned in the column', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });
      operations.get(enqueued.id.value)!.state = 'RUNNING';
      const driftSummary = {
        total: 2,
        droppedCount: 1,
        anomalies: [
          { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false },
          { path: 'ghost.adoc', kind: 'modified_missing_node', applied: true },
        ],
      };

      const result = await repo.transition(enqueued.id, 'SUCCEEDED', { driftSummary });

      expect(result.success && result.value.driftSummary).toEqual(driftSummary);
      // Stored envelope carries the version discriminator the tolerant reader keys on.
      expect(operations.get(enqueued.id.value)!.driftSummary).toMatchObject({ version: 1, total: 2, droppedCount: 1 });
      // Re-reading the row yields the same parsed summary.
      const read = await repo.findById(enqueued.id);
      expect(read?.driftSummary).toEqual(driftSummary);
    });

    it('clears any driftSummary on a non-SUCCEEDED transition', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });
      operations.get(enqueued.id.value)!.state = 'RUNNING';

      const result = await repo.transition(enqueued.id, 'FAILED', { errorCode: 'X' });

      expect(result.success && result.value.driftSummary).toBeNull();
      expect(operations.get(enqueued.id.value)!.driftSummary).toBeNull();
    });

    it('tolerantly reads a driftSummary blob of an unknown version as null (no throw)', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });
      // Simulate a row written under a future/foreign shape.
      operations.get(enqueued.id.value)!.driftSummary = { version: 99, whatever: true };

      const read = await repo.findById(enqueued.id);

      expect(read).not.toBeNull();
      expect(read?.driftSummary).toBeNull();
    });

    it('refreshes heartbeatAt when resuming into RUNNING, so a stale row is not immediately reclaimable', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });
      const row = operations.get(enqueued.id.value)!;
      row.state = 'AWAITING_CONFLICT';
      // A long-stale heartbeat from when the op was first claimed, well past any sweep threshold.
      row.heartbeatAt = new Date('2000-01-01T00:00:00.000Z');

      const before = Date.now();
      const result = await repo.transition(enqueued.id, 'RUNNING');

      expect(result.success && result.value.state).toBe('RUNNING');
      const refreshed = operations.get(enqueued.id.value)!.heartbeatAt;
      expect(refreshed).not.toBeNull();
      expect(refreshed!.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('does not touch heartbeatAt on a non-RUNNING transition', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });
      const row = operations.get(enqueued.id.value)!;
      row.state = 'RUNNING';
      const stamped = new Date('2020-05-05T00:00:00.000Z');
      row.heartbeatAt = stamped;

      await repo.transition(enqueued.id, 'AWAITING_CONFLICT');

      expect(operations.get(enqueued.id.value)!.heartbeatAt).toEqual(stamped);
    });

    it('moves a RUNNING operation to FAILED, recording the given errorCode', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'PUSH', triggeredByUserId: user });
      operations.get(enqueued.id.value)!.state = 'RUNNING';

      const result = await repo.transition(enqueued.id, 'FAILED', { errorCode: 'REPOSITORY_UNREACHABLE' });

      expect(result.success).toBe(true);
      expect(result.success && result.value.state).toBe('FAILED');
      expect(result.success && result.value.progress).toBe(100);
      expect(result.success && result.value.errorCode).toBe('REPOSITORY_UNREACHABLE');
    });

    it('moves a RUNNING operation to AWAITING_CONFLICT without touching progress or finishedAt', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });
      operations.get(enqueued.id.value)!.state = 'RUNNING';
      operations.get(enqueued.id.value)!.progress = 40;

      const result = await repo.transition(enqueued.id, 'AWAITING_CONFLICT');

      expect(result.success).toBe(true);
      expect(result.success && result.value.state).toBe('AWAITING_CONFLICT');
      expect(result.success && result.value.progress).toBe(40);
      expect(result.success && result.value.finishedAt).toBeNull();
    });

    it('moves an AWAITING_CONFLICT operation back to RUNNING on resolve', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });
      operations.get(enqueued.id.value)!.state = 'AWAITING_CONFLICT';

      const result = await repo.transition(enqueued.id, 'RUNNING');

      expect(result.success).toBe(true);
      expect(result.success && result.value.state).toBe('RUNNING');
    });

    it('rejects an illegal transition (still QUEUED), leaving the row unchanged', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'PUSH', triggeredByUserId: user });

      const result = await repo.transition(enqueued.id, 'SUCCEEDED');

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(IllegalGitOperationTransitionError);
      expect(!result.success && result.error.fromState).toBe('QUEUED');
      expect(operations.get(enqueued.id.value)?.state).toBe('QUEUED');
    });

    it('rejects a transition on an operation id that does not exist', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);

      const result = await repo.transition(GitOperationId.create(randomUUID()), 'SUCCEEDED');

      expect(result.success).toBe(false);
      expect(!result.success && result.error.fromState).toBeNull();
    });
  });

  describe('withGuard', () => {
    it('runs action and returns its value when the project has no active operation and no GitRepository row', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);

      const result = await repo.withGuard(projA, async () => 'done');

      expect(result).toEqual({ success: true, value: 'done' });
      expect(client.gitRepository.update).not.toHaveBeenCalled();
    });

    it('touches the GitRepository row to its own current value (the SERIALIZABLE guard) before running action', async () => {
      const { client, repositories } = fakePrismaClient();
      repositories.set(projA.value, { projectId: projA.value, currentBranch: 'main' });
      const repo = new PrismaGitOperationRepository(client);

      const result = await repo.withGuard(projA, async () => 'done');

      expect(result).toEqual({ success: true, value: 'done' });
      expect(client.gitRepository.update).toHaveBeenCalledWith({
        where: { projectId: projA.value },
        data: { currentBranch: 'main' },
      });
    });

    it('fails with GitOperationInProgressError without calling action when an active operation already exists', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      await repo.enqueue({ projectId: projA, kind: 'PUSH', triggeredByUserId: user });
      const action = jest.fn(async () => 'should not run');

      const result = await repo.withGuard(projA, action);

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(GitOperationInProgressError);
      expect(action).not.toHaveBeenCalled();
    });

    it('does not let one project’s active operation block another project', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      await repo.enqueue({ projectId: projA, kind: 'PUSH', triggeredByUserId: user });

      const result = await repo.withGuard(projB, async () => 'unblocked');

      expect(result).toEqual({ success: true, value: 'unblocked' });
    });

    it('fails with GitOperationInProgressError, without calling action, when the DB reports a concurrent-update conflict (P2034) on the guard touch', async () => {
      const { client, repositories } = fakePrismaClient();
      repositories.set(projA.value, { projectId: projA.value, currentBranch: 'main' });
      (client.gitRepository.update as unknown as jest.Mock).mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('could not serialize access due to concurrent update', {
          code: 'P2034',
          clientVersion: '7.9.1',
        }),
      );
      const repo = new PrismaGitOperationRepository(client);
      const action = jest.fn(async () => 'should not run');

      const result = await repo.withGuard(projA, action);

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(GitOperationInProgressError);
      expect(action).not.toHaveBeenCalled();
    });

    it('propagates the action’s own error rather than swallowing it into a Result', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const boom = new Error('action failed');

      await expect(
        repo.withGuard(projA, async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);
    });

    it('re-throws an unrelated Prisma error rather than treating it as the guard being busy', async () => {
      const { client, repositories } = fakePrismaClient();
      repositories.set(projA.value, { projectId: projA.value, currentBranch: 'main' });
      const unrelated = new Prisma.PrismaClientKnownRequestError('connection reset', {
        code: 'P1017',
        clientVersion: '7.9.1',
      });
      (client.gitRepository.update as unknown as jest.Mock).mockRejectedValueOnce(unrelated);
      const repo = new PrismaGitOperationRepository(client);

      await expect(repo.withGuard(projA, async () => 'x')).rejects.toBe(unrelated);
    });

    it('runs the guard transaction at SERIALIZABLE isolation with the default wait/timeout budget', async () => {
      const { client, getTransactionOptions } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);

      await repo.withGuard(projA, async () => 'done');

      expect(getTransactionOptions()).toEqual({ isolationLevel: 'Serializable', maxWait: 5000, timeout: 30_000 });
    });

    it('honors a configured wait/timeout budget', async () => {
      const { client, getTransactionOptions } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client, { guardMaxWaitMs: 1234, guardTimeoutMs: 5678 });

      await repo.withGuard(projA, async () => 'done');

      expect(getTransactionOptions()).toEqual({ isolationLevel: 'Serializable', maxWait: 1234, timeout: 5678 });
    });

    it('omits the id exclusion from the active-op check when excludeOperationId is not given (every synchronous caller)', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);

      await repo.withGuard(projA, async () => 'done');

      const [{ where }] = (client.gitOperation.findFirst as unknown as jest.Mock).mock.calls[0] as [
        { where: { projectId: string; state: { in: string[] }; id?: { not: string } } },
      ];
      expect(where.id).toBeUndefined();
    });

    it('regression: with excludeOperationId given (the async queued path), runs action outside any transaction and returns its value — no self-touch, no active-op re-check', async () => {
      const { client, operations, repositories } = fakePrismaClient();
      repositories.set(projA.value, { projectId: projA.value, currentBranch: 'main' });
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'INITIALIZE', triggeredByUserId: user });
      // The worker claims the operation into RUNNING before this use case's own `withGuard` call
      // ever runs (see claimNextQueued); simulate that directly, as the other tests above do.
      operations.get(enqueued.id.value)!.state = 'RUNNING';
      const action = jest.fn(async () => 'done');

      const result = await repo.withGuard(projA, action, enqueued.id);

      expect(result).toEqual({ success: true, value: 'done' });
      expect(action).toHaveBeenCalledTimes(1);
      // The index-backed single-flight guarantee means this path never opens the SERIALIZABLE
      // transaction, never re-checks for an active operation, and never self-touches the
      // GitRepository row — the exact mechanics that previously caused the async INITIALIZE
      // self-deadlock (a self-touch lock the action's own GitRepository write then waited on).
      expect(client.$transaction).not.toHaveBeenCalled();
      expect(client.gitOperation.findFirst).not.toHaveBeenCalled();
      expect(client.gitRepository.update).not.toHaveBeenCalled();
    });

    it('regression: on the excludeOperationId (async) path, propagates the action’s own error unchanged rather than swallowing it into a Result', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const boom = new Error('publish failed');

      await expect(
        repo.withGuard(
          projA,
          async () => {
            throw boom;
          },
          GitOperationId.create(randomUUID()),
        ),
      ).rejects.toBe(boom);
    });

    it('regression: without excludeOperationId, still performs the SERIALIZABLE check + self-touch guard (existing synchronous-caller behavior preserved)', async () => {
      const { client, repositories, getTransactionOptions } = fakePrismaClient();
      repositories.set(projA.value, { projectId: projA.value, currentBranch: 'main' });
      const repo = new PrismaGitOperationRepository(client);
      const action = jest.fn(async () => 'done');

      const result = await repo.withGuard(projA, action);

      expect(result).toEqual({ success: true, value: 'done' });
      expect(client.$transaction).toHaveBeenCalledTimes(1);
      expect(getTransactionOptions()).toEqual({ isolationLevel: 'Serializable', maxWait: 5000, timeout: 30_000 });
      expect(client.gitOperation.findFirst).toHaveBeenCalledTimes(1);
      expect(client.gitRepository.update).toHaveBeenCalledWith({
        where: { projectId: projA.value },
        data: { currentBranch: 'main' },
      });
    });
  });

  describe('findActiveOperation', () => {
    it('returns null when the project has no operations at all', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);

      expect(await repo.findActiveOperation(projA)).toBeNull();
    });

    it('finds a QUEUED operation as active, mapped to a full domain GitOperation', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const enqueued = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });

      const active = await repo.findActiveOperation(projA);

      expect(active?.id.value).toBe(enqueued.id.value);
      expect(active?.kind).toBe('PULL');
      expect(active?.state).toBe('QUEUED');
      expect(active?.projectId.value).toBe(projA.value);
    });

    it('finds a RUNNING operation as active', async () => {
      // Set the row directly rather than via claimNextQueued, which relies on the raw-SQL
      // FOR-UPDATE-SKIP-LOCKED path this fake does not model (see fakePrismaClient's header comment).
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const id = randomUUID();
      operations.set(id, {
        id,
        projectId: projA.value,
        kind: 'BRANCH_SWITCH',
        state: 'RUNNING',
        branch: null,
        triggeredByUserId: user.value,
        progress: 0,
        heartbeatAt: new Date(),
        errorCode: null,
        driftSummary: null,
        startedAt: new Date(),
        finishedAt: null,
        createdAt: new Date(),
      });

      const active = await repo.findActiveOperation(projA);

      expect(active?.state).toBe('RUNNING');
      expect(active?.kind).toBe('BRANCH_SWITCH');
    });

    it('returns null once the project’s only operation has reached a terminal state', async () => {
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const id = randomUUID();
      operations.set(id, {
        id,
        projectId: projA.value,
        kind: 'PULL',
        state: 'SUCCEEDED',
        branch: null,
        triggeredByUserId: user.value,
        progress: 100,
        heartbeatAt: null,
        errorCode: null,
        driftSummary: null,
        startedAt: new Date(),
        finishedAt: new Date(),
        createdAt: new Date(),
      });

      expect(await repo.findActiveOperation(projA)).toBeNull();
    });

    it('does not let one project’s active operation surface for another project', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });

      expect(await repo.findActiveOperation(projB)).toBeNull();
    });
  });

  describe('findById', () => {
    it('returns null for an operation id that does not exist', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);

      expect(await repo.findById(GitOperationId.create(randomUUID()))).toBeNull();
    });

    it('reads back an operation regardless of its current state, including a terminal one', async () => {
      // Row inserted directly as RUNNING (rather than via enqueue+claimNextQueued, which relies on
      // the raw-SQL FOR-UPDATE-SKIP-LOCKED path this fake does not model) so `transition` has a
      // legal RUNNING -> FAILED edge to take.
      const { client, operations } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const id = randomUUID();
      operations.set(id, {
        id,
        projectId: projA.value,
        kind: 'PUSH',
        state: 'RUNNING',
        branch: null,
        triggeredByUserId: user.value,
        progress: 40,
        heartbeatAt: new Date(),
        errorCode: null,
        driftSummary: null,
        startedAt: new Date(),
        finishedAt: null,
        createdAt: new Date(),
      });
      const operationId = GitOperationId.create(id);
      await repo.transition(operationId, 'FAILED', { errorCode: 'remote_rejected' });

      const found = await repo.findById(operationId);

      expect(found?.id.value).toBe(id);
      expect(found?.state).toBe('FAILED');
      expect(found?.errorCode).toBe('remote_rejected');
    });
  });

  describe('conflict CRUD', () => {
    it('round-trips a created conflict through list and get', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const operation = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });

      const created = await repo.createConflict({ operationId: operation.id, path: 'docs/intro.adoc' });

      expect(created.resolved).toBe(false);
      expect(created.resolution).toBeNull();
      expect(created.isBinary).toBe(false);
      expect(await repo.getConflict(created.id)).toEqual(created);
      expect(await repo.listConflicts(operation.id)).toEqual([created]);
    });

    it('persists isBinary when set', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const operation = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });

      const created = await repo.createConflict({ operationId: operation.id, path: 'image.png', isBinary: true });

      expect(created.isBinary).toBe(true);
    });

    it('lists only the conflicts belonging to the requested operation', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const operationOne = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });
      const operationTwo = await repo.enqueue({ projectId: projB, kind: 'PULL', triggeredByUserId: user });
      const conflictOne = await repo.createConflict({ operationId: operationOne.id, path: 'a.adoc' });
      await repo.createConflict({ operationId: operationTwo.id, path: 'b.adoc' });

      expect(await repo.listConflicts(operationOne.id)).toEqual([conflictOne]);
    });

    it('returns null for a conflict id that does not exist', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);

      expect(await repo.getConflict(GitConflictId.create(randomUUID()))).toBeNull();
    });

    it('clears every conflict recorded for an operation, leaving other operations’ conflicts untouched', async () => {
      const { client } = fakePrismaClient();
      const repo = new PrismaGitOperationRepository(client);
      const operationOne = await repo.enqueue({ projectId: projA, kind: 'PULL', triggeredByUserId: user });
      const operationTwo = await repo.enqueue({ projectId: projB, kind: 'PULL', triggeredByUserId: user });
      await repo.createConflict({ operationId: operationOne.id, path: 'a.adoc' });
      await repo.createConflict({ operationId: operationOne.id, path: 'b.adoc', isBinary: true });
      const untouched = await repo.createConflict({ operationId: operationTwo.id, path: 'c.adoc' });

      await repo.clearConflicts(operationOne.id);

      expect(await repo.listConflicts(operationOne.id)).toEqual([]);
      expect(await repo.listConflicts(operationTwo.id)).toEqual([untouched]);
    });
  });
});
