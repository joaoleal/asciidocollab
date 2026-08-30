import { ProjectId, UserId } from '@asciidocollab/domain';
import { InMemoryGitOperationRepository } from './in-memory-git-operation-repository.js';

const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440200');
const user = UserId.create('550e8400-e29b-41d4-a716-446655440201');

/** Waits past a millisecond boundary so two `Date.now()` reads taken around it are guaranteed to differ. */
async function waitPastAMillisecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('InMemoryGitOperationRepository transition heartbeat parity', () => {
  // Mirrors PrismaGitOperationRepository#transition: a move into RUNNING (e.g. resuming from
  // AWAITING_CONFLICT once a conflict is resolved) must refresh heartbeatAt, because claimNextQueued
  // reclaims RUNNING operations whose heartbeat has gone stale — without the refresh, a second worker
  // could reclaim and double-execute an operation that spent minutes awaiting conflict resolution.
  it('refreshes heartbeatAt to the current time when a transition moves the operation into RUNNING', async () => {
    const repository = new InMemoryGitOperationRepository();
    await repository.enqueue({ projectId, kind: 'PULL', triggeredByUserId: user });
    const claimed = await repository.claimNextQueued(30_000);
    const awaitingConflict = await repository.transition(claimed!.id, 'AWAITING_CONFLICT');
    // Sanity: the non-RUNNING move above left heartbeatAt exactly as claimNextQueued set it.
    expect(awaitingConflict.success && awaitingConflict.value.heartbeatAt).toEqual(claimed?.heartbeatAt);

    await waitPastAMillisecond();
    const resumed = await repository.transition(claimed!.id, 'RUNNING');

    expect(resumed.success).toBe(true);
    expect(resumed.success && resumed.value.heartbeatAt?.getTime()).toBeGreaterThan(
      claimed!.heartbeatAt!.getTime(),
    );
  });

  it('leaves heartbeatAt unchanged when a transition moves the operation to a non-RUNNING state', async () => {
    const repository = new InMemoryGitOperationRepository();
    await repository.enqueue({ projectId, kind: 'PUSH', triggeredByUserId: user });
    const claimed = await repository.claimNextQueued(30_000);

    await waitPastAMillisecond();
    const result = await repository.transition(claimed!.id, 'SUCCEEDED');

    expect(result.success).toBe(true);
    expect(result.success && result.value.heartbeatAt).toEqual(claimed?.heartbeatAt);
  });
});

describe('InMemoryGitOperationRepository findMostRecentByKind(s)/findRecentByKinds newest-first tiebreak', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('breaks a same-createdAt tie by id descending, not insertion order (matching the Prisma adapter)', async () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const repository = new InMemoryGitOperationRepository();
    // The clock never advances between these two enqueues, so both operations share the exact same
    // createdAt — the tie must break by id descending (PrismaGitOperationRepository's `id desc`
    // secondary sort), never by insertion order, or this fake and the real adapter reading identical
    // rows could disagree on which one is "the most recent".
    const first = await repository.enqueue({ projectId, kind: 'PULL', triggeredByUserId: user });
    await repository.claimNextQueued(30_000);
    await repository.transition(first.id, 'SUCCEEDED'); // terminal, so the project can enqueue a second op
    const second = await repository.enqueue({ projectId, kind: 'BRANCH_SWITCH', triggeredByUserId: user });
    expect(first.createdAt).toEqual(second.createdAt); // sanity: genuinely tied

    const expectedWinner = first.id.value > second.id.value ? first : second;

    const mostRecent = await repository.findMostRecentByKinds(projectId, ['PULL', 'BRANCH_SWITCH']);
    expect(mostRecent?.id.value).toBe(expectedWinner.id.value);

    const recent = await repository.findRecentByKinds(projectId, ['PULL', 'BRANCH_SWITCH'], 10);
    expect(recent[0]?.id.value).toBe(expectedWinner.id.value);
  });
});
