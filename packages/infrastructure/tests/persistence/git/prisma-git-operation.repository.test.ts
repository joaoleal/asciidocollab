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

  /**
   * Enqueues an operation of `kind` for `project` and drives it straight to SUCCEEDED so the
   * project's single active slot is free for the next one — the partial-unique index rejects a
   * second active operation otherwise. A short wait between calls keeps `createdAt` strictly
   * ordered so "most recent" is deterministic.
   */
  async function seedSucceeded(project: Project, owner: User, kind: 'PULL' | 'BRANCH_SWITCH' | 'PUSH') {
    const enqueued = await repo.enqueue({ projectId: project.id, kind, triggeredByUserId: owner.id });
    await repo.claimNextQueued(30_000);
    await repo.transition(enqueued.id, 'SUCCEEDED');
    await wait(5);
    return enqueued;
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
      const { owner } = await setupProjectAndUser();
      // One project per operation: the GitOperation_one_active_per_project partial-unique index caps a
      // project at a single active operation, so five simultaneously-queued ops must live on five
      // distinct projects. SKIP LOCKED concurrency is a property of the queue table, not of any one
      // project, so this exercises it exactly as well as five ops on one project would have.
      const projects = await Promise.all(
        Array.from({ length: 5 }, async () => {
          const project = createTestProject();
          await projectRepo.save(project);
          return project;
        }),
      );
      const enqueued = await Promise.all(
        projects.map((project, index) =>
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

  describe('one active operation per project (GitOperation_one_active_per_project partial-unique index)', () => {
    it('rejects enqueuing a second active operation for a project that already has one, mapping P2002 to GitOperationInProgressError', async () => {
      const { project, owner } = await setupProjectAndUser();
      await repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id });

      // The first enqueue leaves a QUEUED (active) row; the partial-unique index makes a second active
      // INSERT for the same project a Postgres unique violation (P2002), which the adapter maps to the
      // same GitOperationInProgressError withGuard reports — the raw Prisma error must not escape.
      await expect(
        repo.enqueue({ projectId: project.id, kind: 'PULL', triggeredByUserId: owner.id }),
      ).rejects.toBeInstanceOf(GitOperationInProgressError);
    });

    it('still rejects when the existing active operation is RUNNING or AWAITING_CONFLICT, not only QUEUED', async () => {
      const { project, owner } = await setupProjectAndUser();
      const enqueued = await repo.enqueue({ projectId: project.id, kind: 'PULL', triggeredByUserId: owner.id });
      await repo.claimNextQueued(30_000); // → RUNNING (still an active state under the index predicate)

      await expect(
        repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id }),
      ).rejects.toBeInstanceOf(GitOperationInProgressError);

      await repo.transition(enqueued.id, 'AWAITING_CONFLICT'); // still active under the index predicate
      await expect(
        repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id }),
      ).rejects.toBeInstanceOf(GitOperationInProgressError);
    });

    it('allows a new enqueue once the prior operation has reached a terminal state (SUCCEEDED does not block)', async () => {
      const { project, owner } = await setupProjectAndUser();
      const first = await repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id });
      await repo.claimNextQueued(30_000);
      const terminal = await repo.transition(first.id, 'SUCCEEDED');
      expect(terminal.success).toBe(true);

      // A terminal (SUCCEEDED) row is outside the index's partial predicate, so it no longer occupies
      // the project's single active slot — a fresh enqueue must succeed rather than conflict.
      const second = await repo.enqueue({ projectId: project.id, kind: 'PULL', triggeredByUserId: owner.id });
      expect(second.state).toBe('QUEUED');
      expect(second.id.value).not.toBe(first.id.value);
    });

    it('allows a new enqueue after a FAILED operation too', async () => {
      const { project, owner } = await setupProjectAndUser();
      const first = await repo.enqueue({ projectId: project.id, kind: 'PUSH', triggeredByUserId: owner.id });
      await repo.claimNextQueued(30_000);
      await repo.transition(first.id, 'FAILED', { errorCode: 'REPOSITORY_UNREACHABLE' });

      const second = await repo.enqueue({ projectId: project.id, kind: 'PULL', triggeredByUserId: owner.id });
      expect(second.state).toBe('QUEUED');
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

    it('regression: with excludeOperationId given (a worker-claimed operation running its own use case), does not self-conflict and runs action to completion', async () => {
      const { project, owner } = await setupConnectedProject();
      const enqueued = await repo.enqueue({ projectId: project.id, kind: 'INITIALIZE', triggeredByUserId: owner.id });
      const claimed = await repo.claimNextQueued(30_000);
      expect(claimed?.id.value).toBe(enqueued.id.value);
      expect(claimed?.state).toBe('RUNNING'); // sanity: genuinely active, not still QUEUED

      const result = await repo.withGuard(project.id, async () => 'done', claimed!.id);

      expect(result).toEqual({ success: true, value: 'done' });
    });

    it('regression: with excludeOperationId given, an action that itself writes the project’s GitRepository row does not deadlock against the guard (the async-INITIALIZE self-deadlock this fix closes)', async () => {
      // Before the fix, withGuard always ran `action` INSIDE a SERIALIZABLE transaction that had
      // already self-touched (locked) this same GitRepository row; an action writing that row via
      // the global client would then block on its own enclosing transaction's lock until the
      // transaction's timeout. Now, when excludeOperationId is given, `action` runs outside any
      // transaction, so this write is a normal, fast, uncontended UPDATE.
      const { project, owner } = await setupConnectedProject();
      await repo.enqueue({ projectId: project.id, kind: 'INITIALIZE', triggeredByUserId: owner.id });
      const claimed = await repo.claimNextQueued(30_000);
      const existing = await gitRepositoryRepo.findByProjectId(project.id);

      const result = await repo.withGuard(
        project.id,
        async () => {
          await gitRepositoryRepo.save(
            createTestGitRepository(project.id, {
              id: existing!.id,
              syncStatus: 'AHEAD',
              currentBranch: existing!.currentBranch,
            }),
          );
          return 'published';
        },
        claimed!.id,
      );

      expect(result).toEqual({ success: true, value: 'published' });
      const row = await client.gitRepository.findUniqueOrThrow({ where: { projectId: project.id.value } });
      expect(row.syncStatus).toBe('AHEAD');
    });

    it('regression: on the excludeOperationId (async) path, propagates the action’s own error unchanged rather than turning it into a Result', async () => {
      const { project, owner } = await setupConnectedProject();
      await repo.enqueue({ projectId: project.id, kind: 'INITIALIZE', triggeredByUserId: owner.id });
      const claimed = await repo.claimNextQueued(30_000);
      const boom = new Error('publish failed');

      await expect(
        repo.withGuard(
          project.id,
          async () => {
            throw boom;
          },
          claimed!.id,
        ),
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

  describe('findMostRecentByKinds', () => {
    it('returns the most recently created operation whose kind is in the set, across kinds', async () => {
      const { project, owner } = await setupProjectAndUser();
      await seedSucceeded(project, owner, 'PULL');
      const switchOp = await seedSucceeded(project, owner, 'BRANCH_SWITCH');

      const found = await repo.findMostRecentByKinds(project.id, ['PULL', 'BRANCH_SWITCH']);

      expect(found?.id.value).toBe(switchOp.id.value);
      expect(found?.kind).toBe('BRANCH_SWITCH');
    });

    it('respects creation ordering: an older in-set kind wins once the newer op is out of the set', async () => {
      const { project, owner } = await setupProjectAndUser();
      const pullOp = await seedSucceeded(project, owner, 'PULL');
      // A newer PUSH is created but is not in the queried set, so the older PULL is still the answer.
      await seedSucceeded(project, owner, 'PUSH');

      const found = await repo.findMostRecentByKinds(project.id, ['PULL', 'BRANCH_SWITCH']);

      expect(found?.id.value).toBe(pullOp.id.value);
      expect(found?.kind).toBe('PULL');
    });

    it('scopes to the project, ignoring an in-set operation belonging to another project', async () => {
      const { project: projectA, owner } = await setupProjectAndUser();
      const projectB = createTestProject();
      await projectRepo.save(projectB);
      await seedSucceeded(projectA, owner, 'PULL');
      const otherPull = await seedSucceeded(projectB, owner, 'PULL');

      const found = await repo.findMostRecentByKinds(projectB.id, ['PULL', 'BRANCH_SWITCH']);

      expect(found?.id.value).toBe(otherPull.id.value);
    });

    it('returns null when the project has no operation of any queried kind', async () => {
      const { project, owner } = await setupProjectAndUser();
      await seedSucceeded(project, owner, 'PUSH');

      expect(await repo.findMostRecentByKinds(project.id, ['PULL', 'BRANCH_SWITCH'])).toBeNull();
    });

    it('breaks a same-createdAt tie deterministically by id (stable secondary sort), not by row order', async () => {
      const { project, owner } = await setupProjectAndUser();
      // Two terminal PULLs sharing the EXACT same createdAt — the partial-unique index only guards
      // ACTIVE rows, so both SUCCEEDED rows coexist. `createdAt desc` alone would leave the winner to
      // whatever order Postgres returns; the `id desc` secondary sort pins it to the greater id every
      // run, which is what makes the undo keep-selection deterministic (and agree with the fakes).
      const sameInstant = new Date('2026-01-01T00:00:00.000Z');
      const lowerId = '00000000-0000-4000-8000-000000000001';
      const higherId = 'ffffffff-0000-4000-8000-000000000002';
      for (const id of [lowerId, higherId]) {
        await client.gitOperation.create({
          data: {
            id,
            projectId: project.id.value,
            kind: 'PULL',
            state: 'SUCCEEDED',
            triggeredByUserId: owner.id.value,
            createdAt: sameInstant,
          },
        });
      }

      const found = await repo.findMostRecentByKinds(project.id, ['PULL', 'BRANCH_SWITCH']);
      expect(found?.id.value).toBe(higherId);

      // The full listing is ordered by the same stable key, so a same-instant pair is always
      // [higher-id, lower-id] — never a nondeterministic pairing.
      const recent = await repo.findRecentByKinds(project.id, ['PULL', 'BRANCH_SWITCH'], 10);
      expect(recent.map((op) => op.id.value)).toEqual([higherId, lowerId]);
    });
  });
});
