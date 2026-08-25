// Requires a live Postgres via testcontainers (see helpers/prisma-test-container.ts), which this
// sandbox cannot run (Prisma's `db push` refuses to execute under an AI agent without explicit
// user consent — verified against the sibling prisma-git-credential-store.test.ts, which fails the
// same way here). Authored and believed correct against the real `GitOperation`/`GitConflict`/
// `GitRepository` tables; exercise it in an environment with a real database (this is exactly the
// FIFO/SKIP-LOCKED-concurrency/stale-reclaim/withGuard-concurrency coverage this suite needs). The
// runnable equivalent — mapping + control-flow, against a fake Prisma client — lives in
// prisma-git-operation.repository.unit.test.ts.
import {
  GitOperationRepository,
  GitOperationInProgressError,
  UserRepository,
  ProjectRepository,
  Project,
  User,
} from '@asciidocollab/domain';
import { PrismaClient } from '@prisma/client';
import { PrismaGitOperationRepository } from '../../../src/persistence/git/prisma-git-operation.repository';
import { PrismaGitRepositoryRepository } from '../../../src/persistence/project/prisma-git-repository.repository';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { PrismaProjectRepository } from '../../../src/persistence/project/prisma-project.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import { createTestUser, createTestProject, createTestGitRepository } from '../../helpers/test-data';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PrismaGitOperationRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: GitOperationRepository;
  let gitRepositoryRepo: PrismaGitRepositoryRepository;
  let userRepo: UserRepository;
  let projectRepo: ProjectRepository;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaGitOperationRepository(client);
    gitRepositoryRepo = new PrismaGitRepositoryRepository(client);
    userRepo = new PrismaUserRepository(client);
    projectRepo = new PrismaProjectRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.gitConflict.deleteMany();
    await client.gitOperation.deleteMany();
    await client.gitRepository.deleteMany();
    await client.project.deleteMany();
    await client.user.deleteMany();
  });

  async function setupProjectAndUser(): Promise<{ project: Project; owner: User }> {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await projectRepo.save(project);
    return { project, owner };
  }

  async function setupConnectedProject(): Promise<{ project: Project; owner: User }> {
    const { project, owner } = await setupProjectAndUser();
    await gitRepositoryRepo.save(createTestGitRepository(project.id, { currentBranch: 'main' }));
    return { project, owner };
  }

  describe('enqueue + claimNextQueued', () => {
    it('claims queued operations in first-in-first-out order', async () => {
      const { project: projectA, owner } = await setupProjectAndUser();
      const projectB = createTestProject();
      await projectRepo.save(projectB);

      const first = await repo.enqueue({ projectId: projectA.id, kind: 'COMMIT', triggeredByUserId: owner.id });
      const second = await repo.enqueue({ projectId: projectB.id, kind: 'PULL', triggeredByUserId: owner.id });

      const claimedFirst = await repo.claimNextQueued(30_000);
      const claimedSecond = await repo.claimNextQueued(30_000);

      expect(claimedFirst?.id.value).toBe(first.id.value);
      expect(claimedFirst?.state).toBe('RUNNING');
      expect(claimedFirst?.heartbeatAt).not.toBeNull();
      expect(claimedFirst?.startedAt).not.toBeNull();
      expect(claimedSecond?.id.value).toBe(second.id.value);
    });

    it('returns null when there is nothing to claim', async () => {
      expect(await repo.claimNextQueued(30_000)).toBeNull();
    });

    it('two concurrent claimers never receive the same queued operation (SKIP LOCKED)', async () => {
      const { project, owner } = await setupProjectAndUser();
      const enqueued = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          repo.enqueue({ projectId: project.id, kind: index % 2 === 0 ? 'PUSH' : 'PULL', triggeredByUserId: owner.id }),
        ),
      );

      const claimed = await Promise.all(Array.from({ length: 5 }, () => repo.claimNextQueued(30_000)));

      const claimedIds = claimed.map((op) => op?.id.value);
      expect(claimedIds.every((id) => id !== undefined)).toBe(true);
      // No two concurrent claimers ever grabbed the same row.
      expect(new Set(claimedIds).size).toBe(5);
      expect(new Set(claimedIds)).toEqual(new Set(enqueued.map((op) => op.id.value)));
      // A 6th claimer finds nothing left.
      expect(await repo.claimNextQueued(30_000)).toBeNull();
    });

    it('does not reclaim a RUNNING operation whose heartbeat is still fresh', async () => {
      const { project, owner } = await setupProjectAndUser();
      await repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id });
      await repo.claimNextQueued(30_000); // now RUNNING with a fresh heartbeat

      expect(await repo.claimNextQueued(30_000)).toBeNull();
    });

    it('reclaims a RUNNING operation once its heartbeat has gone stale, preserving startedAt', async () => {
      const { project, owner } = await setupProjectAndUser();
      const enqueued = await repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id });
      const firstClaim = await repo.claimNextQueued(30_000);

      // Simulate a crashed worker: back-date the heartbeat directly, since the test can't wait
      // out a real staleness window.
      await client.gitOperation.update({
        where: { id: enqueued.id.value },
        data: { heartbeatAt: new Date(Date.now() - 31_000) },
      });

      const reclaimed = await repo.claimNextQueued(30_000);

      expect(reclaimed?.id.value).toBe(enqueued.id.value);
      expect(reclaimed?.state).toBe('RUNNING');
      expect(reclaimed?.startedAt).toEqual(firstClaim?.startedAt);
      expect(reclaimed?.heartbeatAt).not.toBeNull();
      expect(reclaimed!.heartbeatAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
    });

    it('prefers a QUEUED operation over reclaiming a stale RUNNING one', async () => {
      const { project: projectA, owner } = await setupProjectAndUser();
      const projectB = createTestProject();
      await projectRepo.save(projectB);

      const running = await repo.enqueue({ projectId: projectA.id, kind: 'PUSH', triggeredByUserId: owner.id });
      await repo.claimNextQueued(30_000);
      await client.gitOperation.update({
        where: { id: running.id.value },
        data: { heartbeatAt: new Date(Date.now() - 31_000) },
      });
      const queued = await repo.enqueue({ projectId: projectB.id, kind: 'PULL', triggeredByUserId: owner.id });

      const claimed = await repo.claimNextQueued(30_000);
      expect(claimed?.id.value).toBe(queued.id.value);

      // With the QUEUED one now claimed, the next call reclaims the stale RUNNING one.
      const reclaimed = await repo.claimNextQueued(30_000);
      expect(reclaimed?.id.value).toBe(running.id.value);
    });
  });

  describe('heartbeat', () => {
    it('refreshes heartbeatAt on the underlying row', async () => {
      const { project, owner } = await setupProjectAndUser();
      const enqueued = await repo.enqueue({ projectId: project.id, kind: 'COMMIT', triggeredByUserId: owner.id });
      const claimed = await repo.claimNextQueued(30_000);
      const beforeRefresh = claimed!.heartbeatAt!.getTime();
      await wait(20);

      await repo.heartbeat(enqueued.id);

      const row = await client.gitOperation.findUniqueOrThrow({ where: { id: enqueued.id.value } });
      expect(row.heartbeatAt).not.toBeNull();
      expect(row.heartbeatAt!.getTime()).toBeGreaterThan(beforeRefresh);
    });

    it('is a no-op for an operation id that does not exist', async () => {
      const { project, owner } = await setupProjectAndUser();
      const enqueued = await repo.enqueue({ projectId: project.id, kind: 'COMMIT', triggeredByUserId: owner.id });
      await client.gitOperation.delete({ where: { id: enqueued.id.value } });

      await expect(repo.heartbeat(enqueued.id)).resolves.toBeUndefined();
    });
  });

  describe('transition', () => {
    it('moves a RUNNING operation to SUCCEEDED, setting progress to 100 and finishedAt', async () => {
      const { project, owner } = await setupProjectAndUser();
      const enqueued = await repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id });
      await repo.claimNextQueued(30_000);

      const result = await repo.transition(enqueued.id, 'SUCCEEDED');

      expect(result.success).toBe(true);
      expect(result.success && result.value.state).toBe('SUCCEEDED');
      expect(result.success && result.value.progress).toBe(100);
      expect(result.success && result.value.finishedAt).not.toBeNull();
      expect(result.success && result.value.errorCode).toBeNull();
    });

    it('moves a RUNNING operation to FAILED, recording the given errorCode', async () => {
      const { project, owner } = await setupProjectAndUser();
      const enqueued = await repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id });
      await repo.claimNextQueued(30_000);

      const result = await repo.transition(enqueued.id, 'FAILED', { errorCode: 'REPOSITORY_UNREACHABLE' });

      expect(result.success).toBe(true);
      expect(result.success && result.value.state).toBe('FAILED');
      expect(result.success && result.value.errorCode).toBe('REPOSITORY_UNREACHABLE');
    });

    it('moves a RUNNING operation to AWAITING_CONFLICT, then back to RUNNING on resolve', async () => {
      const { project, owner } = await setupProjectAndUser();
      const enqueued = await repo.enqueue({ projectId: project.id, kind: 'PULL', triggeredByUserId: owner.id });
      await repo.claimNextQueued(30_000);

      const toConflict = await repo.transition(enqueued.id, 'AWAITING_CONFLICT');
      expect(toConflict.success && toConflict.value.state).toBe('AWAITING_CONFLICT');
      expect(toConflict.success && toConflict.value.finishedAt).toBeNull();

      const resumed = await repo.transition(enqueued.id, 'RUNNING');
      expect(resumed.success && resumed.value.state).toBe('RUNNING');
    });

    it('rejects an illegal transition (still QUEUED), leaving the row unchanged', async () => {
      const { project, owner } = await setupProjectAndUser();
      const enqueued = await repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id });

      const result = await repo.transition(enqueued.id, 'SUCCEEDED');

      expect(result.success).toBe(false);
      const row = await client.gitOperation.findUniqueOrThrow({ where: { id: enqueued.id.value } });
      expect(row.state).toBe('QUEUED');
    });

    it('rejects a transition on an operation id that does not exist', async () => {
      const { project, owner } = await setupProjectAndUser();
      const enqueued = await repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id });
      await client.gitOperation.delete({ where: { id: enqueued.id.value } });

      const result = await repo.transition(enqueued.id, 'SUCCEEDED');

      expect(result.success).toBe(false);
      expect(!result.success && result.error.fromState).toBeNull();
    });
  });

  describe('withGuard', () => {
    it('runs the action and returns its value when the project has no active operation', async () => {
      const { project } = await setupConnectedProject();

      const result = await repo.withGuard(project.id, async () => 'done');

      expect(result).toEqual({ success: true, value: 'done' });
    });

    it('fails with GitOperationInProgressError, without calling the action, when a queued operation is already active', async () => {
      const { project, owner } = await setupConnectedProject();
      await repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id });
      const action = jest.fn(async () => 'should not run');

      const result = await repo.withGuard(project.id, action);

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toBeInstanceOf(GitOperationInProgressError);
      expect(action).not.toHaveBeenCalled();
    });

    it('does not let one project’s active operation block another project', async () => {
      const { project: projectA, owner } = await setupConnectedProject();
      const { project: projectB } = await setupConnectedProject();
      await repo.enqueue({ projectId: projectA.id, kind: 'PUSH', triggeredByUserId: owner.id });

      const result = await repo.withGuard(projectB.id, async () => 'unblocked');

      expect(result).toEqual({ success: true, value: 'unblocked' });
    });

    it('two concurrent withGuard calls on the same project: exactly one runs, the other is refused', async () => {
      const { project } = await setupConnectedProject();
      let running = 0;
      let sawOverlap = false;
      const action = async (label: string) => {
        running += 1;
        if (running > 1) sawOverlap = true;
        await wait(150); // widen the overlap window so a would-be race is unambiguous
        running -= 1;
        return label;
      };

      const [first, second] = await Promise.all([
        repo.withGuard(project.id, () => action('first')),
        repo.withGuard(project.id, () => action('second')),
      ]);

      const results = [first, second];
      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].success === false && failures[0].error).toBeInstanceOf(GitOperationInProgressError);
      // The guard actually serialized the two actions rather than merely racing to a lucky outcome.
      expect(sawOverlap).toBe(false);

      // The guard's self-touch is a true no-op: the row's data is unchanged.
      const row = await client.gitRepository.findUniqueOrThrow({ where: { projectId: project.id.value } });
      expect(row.currentBranch).toBe('main');
    });

    it('propagates the action’s own error rather than turning it into a Result', async () => {
      const { project } = await setupConnectedProject();
      const boom = new Error('stage failed');

      await expect(
        repo.withGuard(project.id, async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);
    });
  });

  describe('conflict CRUD', () => {
    it('round-trips a created conflict through list and get', async () => {
      const { project, owner } = await setupProjectAndUser();
      const operation = await repo.enqueue({ projectId: project.id, kind: 'PULL', triggeredByUserId: owner.id });

      const created = await repo.createConflict({ operationId: operation.id, path: 'docs/intro.adoc' });

      expect(created.resolved).toBe(false);
      expect(created.resolution).toBeNull();
      expect(created.isBinary).toBe(false);
      expect(await repo.getConflict(created.id)).toEqual(created);
      expect(await repo.listConflicts(operation.id)).toEqual([created]);
    });

    it('lists only the conflicts belonging to the requested operation', async () => {
      const { project: projectA, owner } = await setupProjectAndUser();
      const projectB = createTestProject();
      await projectRepo.save(projectB);
      const operationOne = await repo.enqueue({ projectId: projectA.id, kind: 'PULL', triggeredByUserId: owner.id });
      const operationTwo = await repo.enqueue({ projectId: projectB.id, kind: 'PULL', triggeredByUserId: owner.id });
      const conflictOne = await repo.createConflict({ operationId: operationOne.id, path: 'a.adoc' });
      await repo.createConflict({ operationId: operationTwo.id, path: 'b.adoc' });

      expect(await repo.listConflicts(operationOne.id)).toEqual([conflictOne]);
    });

    it('returns null for a conflict id that does not exist', async () => {
      const { project, owner } = await setupProjectAndUser();
      const operation = await repo.enqueue({ projectId: project.id, kind: 'PULL', triggeredByUserId: owner.id });
      const created = await repo.createConflict({ operationId: operation.id, path: 'gone.adoc' });

      await repo.clearConflicts(operation.id);

      expect(await repo.getConflict(created.id)).toBeNull();
    });

    it('clears every conflict recorded for an operation', async () => {
      const { project, owner } = await setupProjectAndUser();
      const operation = await repo.enqueue({ projectId: project.id, kind: 'PULL', triggeredByUserId: owner.id });
      await repo.createConflict({ operationId: operation.id, path: 'a.adoc' });
      await repo.createConflict({ operationId: operation.id, path: 'b.adoc', isBinary: true });

      await repo.clearConflicts(operation.id);

      expect(await repo.listConflicts(operation.id)).toEqual([]);
    });

    it('cascades away when the owning operation is deleted (onDelete: Cascade)', async () => {
      const { project, owner } = await setupProjectAndUser();
      const operation = await repo.enqueue({ projectId: project.id, kind: 'PULL', triggeredByUserId: owner.id });
      await repo.createConflict({ operationId: operation.id, path: 'a.adoc' });

      await client.gitOperation.delete({ where: { id: operation.id.value } });

      expect(await client.gitConflict.count({ where: { operationId: operation.id.value } })).toBe(0);
    });
  });
});
