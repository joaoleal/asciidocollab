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
