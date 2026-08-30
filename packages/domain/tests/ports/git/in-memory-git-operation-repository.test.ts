import { randomUUID } from 'crypto';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { GitOperationId } from '../../../src/value-objects/ids/git-operation-id';
import { GitOperationInProgressError } from '../../../src/errors/git/git-operation-in-progress';
import { IllegalGitOperationTransitionError } from '../../../src/errors/git/illegal-git-operation-transition';
import { GitConflictNotFoundError } from '../../../src/errors/git/git-conflict-not-found';
import { InMemoryGitOperationRepository } from './in-memory-git-operation-repository';

/** A mutable clock so tests can advance time deterministically without sleeping. */
function fakeClock(startIso: string) {
  let now = new Date(startIso);
  return {
    clock: () => now,
    advanceMs(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('InMemoryGitOperationRepository', () => {
  const projectA = ProjectId.create('550e8400-e29b-41d4-a716-446655440020');
  const projectB = ProjectId.create('550e8400-e29b-41d4-a716-446655440021');
  const user = UserId.create('550e8400-e29b-41d4-a716-446655440022');

  describe('enqueue and claimNextQueued', () => {
    it('enqueues an operation in the QUEUED state', async () => {
      const repo = new InMemoryGitOperationRepository();

      const operation = await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });

      expect(operation.state).toBe('QUEUED');
      expect(operation.projectId).toBe(projectA);
      expect(operation.kind).toBe('PUSH');
      expect(operation.heartbeatAt).toBeNull();
    });

    it('claims queued operations in first-in-first-out order', async () => {
      const repo = new InMemoryGitOperationRepository();
      const first = await repo.enqueue({ projectId: projectA, kind: 'COMMIT', triggeredByUserId: user });
      const second = await repo.enqueue({ projectId: projectB, kind: 'PULL', triggeredByUserId: user });

      const claimedFirst = await repo.claimNextQueued(30_000);
      const claimedSecond = await repo.claimNextQueued(30_000);

      expect(claimedFirst?.id.value).toBe(first.id.value);
      expect(claimedSecond?.id.value).toBe(second.id.value);
    });

    it('transitions a claimed operation to RUNNING with a fresh heartbeat', async () => {
      const { clock } = fakeClock('2026-01-01T00:00:00.000Z');
      const repo = new InMemoryGitOperationRepository(clock);
      await repo.enqueue({ projectId: projectA, kind: 'COMMIT', triggeredByUserId: user });

      const claimed = await repo.claimNextQueued(30_000);

      expect(claimed?.state).toBe('RUNNING');
      expect(claimed?.heartbeatAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
      expect(claimed?.startedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    });

    it('returns null when there is nothing to claim', async () => {
      const repo = new InMemoryGitOperationRepository();

      expect(await repo.claimNextQueued(30_000)).toBeNull();
    });

    it('skips a RUNNING operation whose heartbeat is still fresh', async () => {
      const { clock, advanceMs } = fakeClock('2026-01-01T00:00:00.000Z');
      const repo = new InMemoryGitOperationRepository(clock);
      await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });
      await repo.claimNextQueued(30_000);

      advanceMs(10_000); // heartbeat is only 10s old; threshold is 30s

      expect(await repo.claimNextQueued(30_000)).toBeNull();
    });

    it('reclaims a RUNNING operation whose heartbeat has gone stale', async () => {
      const { clock, advanceMs } = fakeClock('2026-01-01T00:00:00.000Z');
      const repo = new InMemoryGitOperationRepository(clock);
      const enqueued = await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });
      const firstClaim = await repo.claimNextQueued(30_000);

      advanceMs(31_000); // heartbeat is now 31s old; threshold is 30s

      const reclaimed = await repo.claimNextQueued(30_000);

      expect(reclaimed?.id.value).toBe(enqueued.id.value);
      expect(reclaimed?.state).toBe('RUNNING');
      expect(reclaimed?.heartbeatAt).toEqual(new Date('2026-01-01T00:00:31.000Z'));
      // startedAt is preserved from the original claim, not reset on reclaim.
      expect(reclaimed?.startedAt).toEqual(firstClaim?.startedAt);
    });

    it('prefers a QUEUED operation over reclaiming a stale RUNNING one', async () => {
      const { clock, advanceMs } = fakeClock('2026-01-01T00:00:00.000Z');
      const repo = new InMemoryGitOperationRepository(clock);
      const running = await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });
      await repo.claimNextQueued(30_000);
      advanceMs(31_000);
      const queued = await repo.enqueue({ projectId: projectB, kind: 'PULL', triggeredByUserId: user });

      const claimed = await repo.claimNextQueued(30_000);

      expect(claimed?.id.value).toBe(queued.id.value);
      expect(running.id.value).not.toBe(queued.id.value);
    });
  });

  describe('heartbeat', () => {
    it('refreshes heartbeatAt to the current time', async () => {
      const { clock, advanceMs } = fakeClock('2026-01-01T00:00:00.000Z');
      const repo = new InMemoryGitOperationRepository(clock);
      const enqueued = await repo.enqueue({ projectId: projectA, kind: 'COMMIT', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);

      advanceMs(20_000);
      await repo.heartbeat(claimed!.id);

      // Heartbeat was refreshed at t=20s, so 25s later (t=45s) it's only 25s stale — under the 30s threshold.
      advanceMs(25_000);
      expect(await repo.claimNextQueued(30_000)).toBeNull();

      // Past 30s since the refresh, it becomes reclaimable again.
      advanceMs(10_000);
      const reclaimed = await repo.claimNextQueued(30_000);
      expect(reclaimed?.id.value).toBe(enqueued.id.value);
    });

    it('is a no-op for an operation id that does not exist', async () => {
      const repo = new InMemoryGitOperationRepository();
      const enqueued = await repo.enqueue({ projectId: projectA, kind: 'COMMIT', triggeredByUserId: user });
      const unknownId = enqueued.id;
      await repo.clearConflicts(unknownId); // sanity: unrelated id doesn't throw either

      await expect(repo.heartbeat(unknownId)).resolves.toBeUndefined();
    });
  });

  describe('withGuard', () => {
    it('runs the action and returns its value when the project has no active operation', async () => {
      const repo = new InMemoryGitOperationRepository();

      const result = await repo.withGuard(projectA, async () => 'done');

      expect(result).toEqual({ success: true, value: 'done' });
    });

    it('fails with GitOperationInProgressError without calling the action when an operation is active', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'COMMIT', triggeredByUserId: user });
      const action = jest.fn(async () => 'should not run');

      const result = await repo.withGuard(projectA, action);

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(GitOperationInProgressError);
      expect(action).not.toHaveBeenCalled();
    });

    it('does not let one project’s active operation block another project', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'COMMIT', triggeredByUserId: user });

      const result = await repo.withGuard(projectB, async () => 'unblocked');

      expect(result).toEqual({ success: true, value: 'unblocked' });
    });

    it('fails with GitOperationInProgressError without calling the action when the active operation is RUNNING', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);
      expect(claimed?.state).toBe('RUNNING'); // sanity: the op is genuinely RUNNING, not still QUEUED
      const action = jest.fn(async () => 'should not run');

      const result = await repo.withGuard(projectA, action);

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(GitOperationInProgressError);
      expect(action).not.toHaveBeenCalled();
    });

    it('fails with GitOperationInProgressError without calling the action when the active operation is AWAITING_CONFLICT', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);
      const transitioned = await repo.transition(claimed!.id, 'AWAITING_CONFLICT');
      expect(transitioned.success && transitioned.value.state).toBe('AWAITING_CONFLICT'); // sanity
      const action = jest.fn(async () => 'should not run');

      const result = await repo.withGuard(projectA, action);

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(GitOperationInProgressError);
      expect(action).not.toHaveBeenCalled();
    });

    it('runs the action when excludeOperationId matches the project’s only active (RUNNING) operation — a claimed operation does not conflict with itself', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'INITIALIZE', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);
      expect(claimed?.state).toBe('RUNNING'); // sanity

      const result = await repo.withGuard(projectA, async () => 'done', claimed!.id);

      expect(result).toEqual({ success: true, value: 'done' });
    });

    it('still fails with GitOperationInProgressError when excludeOperationId is set but a DIFFERENT operation is active', async () => {
      const repo = new InMemoryGitOperationRepository();
      const other = await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });
      const unrelatedId = GitOperationId.create(randomUUID());
      const action = jest.fn(async () => 'should not run');

      const result = await repo.withGuard(projectA, action, unrelatedId);

      expect(other.state).toBe('QUEUED'); // sanity: a real, distinct active operation
      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(GitOperationInProgressError);
      expect(action).not.toHaveBeenCalled();
    });
  });

  describe('findActiveOperation', () => {
    it('returns null when the project has no operations at all', async () => {
      const repo = new InMemoryGitOperationRepository();

      expect(await repo.findActiveOperation(projectA)).toBeNull();
    });

    it('finds a QUEUED operation as active', async () => {
      const repo = new InMemoryGitOperationRepository();
      const enqueued = await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });

      const active = await repo.findActiveOperation(projectA);

      expect(active?.id.value).toBe(enqueued.id.value);
      expect(active?.state).toBe('QUEUED');
    });

    it('finds a RUNNING operation as active', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'BRANCH_SWITCH', triggeredByUserId: user });
      await repo.claimNextQueued(30_000);

      const active = await repo.findActiveOperation(projectA);

      expect(active?.state).toBe('RUNNING');
      expect(active?.kind).toBe('BRANCH_SWITCH');
    });

    it('finds an AWAITING_CONFLICT operation as active', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);
      await repo.transition(claimed!.id, 'AWAITING_CONFLICT');

      const active = await repo.findActiveOperation(projectA);

      expect(active?.state).toBe('AWAITING_CONFLICT');
    });

    it('returns null once the project’s only operation has reached a terminal state', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);
      await repo.transition(claimed!.id, 'SUCCEEDED');

      expect(await repo.findActiveOperation(projectA)).toBeNull();
    });

    it('does not let one project’s active operation surface for another project', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });

      expect(await repo.findActiveOperation(projectB)).toBeNull();
    });
  });

  describe('findById', () => {
    it('returns null for an operation id that does not exist', async () => {
      const repo = new InMemoryGitOperationRepository();

      expect(await repo.findById(GitOperationId.create(randomUUID()))).toBeNull();
    });

    it('reads back an operation regardless of its current state, including a terminal one', async () => {
      const repo = new InMemoryGitOperationRepository();
      const enqueued = await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);
      const finished = await repo.transition(claimed!.id, 'FAILED', { errorCode: 'remote_rejected' });

      const found = await repo.findById(enqueued.id);

      expect(found?.id.value).toBe(enqueued.id.value);
      expect(found?.state).toBe('FAILED');
      expect(found?.errorCode).toBe('remote_rejected');
      expect(finished.success).toBe(true);
    });
  });

  describe('transition', () => {
    it('moves a RUNNING operation to SUCCEEDED, setting progress to 100 and finishedAt', async () => {
      const { clock } = fakeClock('2026-01-01T00:00:00.000Z');
      const repo = new InMemoryGitOperationRepository(clock);
      await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);

      const result = await repo.transition(claimed!.id, 'SUCCEEDED');

      expect(result.success).toBe(true);
      expect(result.success && result.value.state).toBe('SUCCEEDED');
      expect(result.success && result.value.progress).toBe(100);
      expect(result.success && result.value.finishedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
      expect(result.success && result.value.errorCode).toBeNull();
    });

    it('moves a RUNNING operation to FAILED, recording the given errorCode', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);

      const result = await repo.transition(claimed!.id, 'FAILED', { errorCode: 'REPOSITORY_UNREACHABLE' });

      expect(result.success).toBe(true);
      expect(result.success && result.value.state).toBe('FAILED');
      expect(result.success && result.value.progress).toBe(100);
      expect(result.success && result.value.errorCode).toBe('REPOSITORY_UNREACHABLE');
      expect(result.success && result.value.finishedAt).not.toBeNull();
    });

    it('moves a RUNNING operation to ABORTED', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);

      const result = await repo.transition(claimed!.id, 'ABORTED');

      expect(result.success).toBe(true);
      expect(result.success && result.value.state).toBe('ABORTED');
      expect(result.success && result.value.finishedAt).not.toBeNull();
    });

    it('moves a RUNNING operation to AWAITING_CONFLICT without setting finishedAt or progress', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);

      const result = await repo.transition(claimed!.id, 'AWAITING_CONFLICT');

      expect(result.success).toBe(true);
      expect(result.success && result.value.state).toBe('AWAITING_CONFLICT');
      expect(result.success && result.value.finishedAt).toBeNull();
      expect(result.success && result.value.progress).toBe(0);
    });

    it('moves an AWAITING_CONFLICT operation back to RUNNING on resolve', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);
      await repo.transition(claimed!.id, 'AWAITING_CONFLICT');

      const result = await repo.transition(claimed!.id, 'RUNNING');

      expect(result.success).toBe(true);
      expect(result.success && result.value.state).toBe('RUNNING');
      expect(result.success && result.value.finishedAt).toBeNull();
    });

    it('rejects an illegal transition, leaving the operation state unchanged', async () => {
      const repo = new InMemoryGitOperationRepository();
      const enqueued = await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });

      // Still QUEUED: SUCCEEDED is only legal from RUNNING.
      const result = await repo.transition(enqueued.id, 'SUCCEEDED');

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(IllegalGitOperationTransitionError);
      expect(!result.success && result.error.fromState).toBe('QUEUED');
      expect(!result.success && result.error.toState).toBe('SUCCEEDED');
    });

    it('rejects a transition out of an already-terminal state', async () => {
      const repo = new InMemoryGitOperationRepository();
      await repo.enqueue({ projectId: projectA, kind: 'PUSH', triggeredByUserId: user });
      const claimed = await repo.claimNextQueued(30_000);
      await repo.transition(claimed!.id, 'SUCCEEDED');

      const result = await repo.transition(claimed!.id, 'FAILED', { errorCode: 'X' });

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(IllegalGitOperationTransitionError);
    });

    it('rejects a transition on an operation id that does not exist', async () => {
      const repo = new InMemoryGitOperationRepository();
      const unknownId = GitOperationId.create(randomUUID());

      const result = await repo.transition(unknownId, 'SUCCEEDED');

      expect(result.success).toBe(false);
      expect(!result.success && result.error.fromState).toBeNull();
      expect(!result.success && result.error.toState).toBe('SUCCEEDED');
    });
  });

  describe('conflict CRUD', () => {
    it('round-trips a created conflict through list and get', async () => {
      const repo = new InMemoryGitOperationRepository();
      const operation = await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });

      const created = await repo.createConflict({ operationId: operation.id, path: 'docs/intro.adoc' });

      expect(created.resolved).toBe(false);
      expect(created.resolution).toBeNull();
      expect(await repo.getConflict(created.id)).toEqual(created);
      expect(await repo.listConflicts(operation.id)).toEqual([created]);
    });

    it('lists only the conflicts belonging to the requested operation', async () => {
      const repo = new InMemoryGitOperationRepository();
      const operationOne = await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      const operationTwo = await repo.enqueue({ projectId: projectB, kind: 'PULL', triggeredByUserId: user });
      const conflictOne = await repo.createConflict({ operationId: operationOne.id, path: 'a.adoc' });
      await repo.createConflict({ operationId: operationTwo.id, path: 'b.adoc' });

      expect(await repo.listConflicts(operationOne.id)).toEqual([conflictOne]);
    });

    it('returns null for a conflict id that does not exist', async () => {
      const repo = new InMemoryGitOperationRepository();
      const operation = await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      const created = await repo.createConflict({ operationId: operation.id, path: 'gone.adoc' });
      const missing = created.id;
      await repo.clearConflicts(operation.id);

      expect(await repo.getConflict(missing)).toBeNull();
    });

    it('clears every conflict recorded for an operation', async () => {
      const repo = new InMemoryGitOperationRepository();
      const operation = await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      await repo.createConflict({ operationId: operation.id, path: 'a.adoc' });
      await repo.createConflict({ operationId: operation.id, path: 'b.adoc', isBinary: true });

      await repo.clearConflicts(operation.id);

      expect(await repo.listConflicts(operation.id)).toEqual([]);
    });

    it('resolveConflict sets resolved and resolution on the matching conflict', async () => {
      const repo = new InMemoryGitOperationRepository();
      const operation = await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      const created = await repo.createConflict({ operationId: operation.id, path: 'docs/intro.adoc' });

      const result = await repo.resolveConflict(operation.id, 'docs/intro.adoc', 'theirs');

      expect(result.success).toBe(true);
      expect(result.success && result.value.resolved).toBe(true);
      expect(result.success && result.value.resolution).toBe('theirs');
      expect(result.success && result.value.id.value).toBe(created.id.value);
      const reread = await repo.getConflict(created.id);
      expect(reread?.resolved).toBe(true);
      expect(reread?.resolution).toBe('theirs');
    });

    it('resolveConflict is idempotent: re-resolving overwrites the prior choice', async () => {
      const repo = new InMemoryGitOperationRepository();
      const operation = await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      await repo.createConflict({ operationId: operation.id, path: 'docs/intro.adoc' });
      await repo.resolveConflict(operation.id, 'docs/intro.adoc', 'ours');

      const result = await repo.resolveConflict(operation.id, 'docs/intro.adoc', 'merged');

      expect(result.success).toBe(true);
      expect(result.success && result.value.resolution).toBe('merged');
    });

    it('resolveConflict fails with GitConflictNotFoundError for an unknown path', async () => {
      const repo = new InMemoryGitOperationRepository();
      const operation = await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      await repo.createConflict({ operationId: operation.id, path: 'docs/intro.adoc' });

      const result = await repo.resolveConflict(operation.id, 'docs/missing.adoc', 'ours');

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(GitConflictNotFoundError);
    });
  });

  describe('findMostRecentByKind(s)/findRecentByKinds newest-first tiebreak', () => {
    it('breaks a same-createdAt tie by id descending, not insertion order (matching the Prisma adapter)', async () => {
      const { clock } = fakeClock('2026-01-01T00:00:00.000Z');
      const repo = new InMemoryGitOperationRepository(clock);
      // The clock never advances between these two enqueues, so both operations share the exact same
      // createdAt — the tie must break by id descending (PrismaGitOperationRepository's `id desc`
      // secondary sort), never by insertion order, or a fake and the real adapter reading identical
      // rows could disagree on which one is "the most recent".
      const first = await repo.enqueue({ projectId: projectA, kind: 'PULL', triggeredByUserId: user });
      await repo.claimNextQueued(30_000);
      await repo.transition(first.id, 'SUCCEEDED'); // terminal, so the project can enqueue a second op
      const second = await repo.enqueue({ projectId: projectA, kind: 'BRANCH_SWITCH', triggeredByUserId: user });
      expect(first.createdAt).toEqual(second.createdAt); // sanity: genuinely tied

      const expectedWinner = first.id.value > second.id.value ? first : second;

      const mostRecent = await repo.findMostRecentByKinds(projectA, ['PULL', 'BRANCH_SWITCH']);
      expect(mostRecent?.id.value).toBe(expectedWinner.id.value);

      const recent = await repo.findRecentByKinds(projectA, ['PULL', 'BRANCH_SWITCH'], 10);
      expect(recent[0]?.id.value).toBe(expectedWinner.id.value);
    });
  });
});
