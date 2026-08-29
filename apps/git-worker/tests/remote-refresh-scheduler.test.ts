import {
  GitProvider,
  GitRepository,
  GitRepositoryId,
  ProjectId,
  UserId,
  type GitSyncStatus,
} from '@asciidocollab/domain';
import { createRemoteRefreshScheduler } from '../src/remote-refresh-scheduler.js';
import { InMemoryGitRepositoryRepository } from './helpers/in-memory-git-repository-repository.js';
import { InMemoryGitOperationRepository } from './helpers/in-memory-git-operation-repository.js';

const USER = UserId.create('550e8400-e29b-41d4-a716-446655440101');

/** A distinct connected project fixture: a project id and its repository entity. */
interface Repo {
  readonly projectId: ProjectId;
  readonly repository: GitRepository;
}

let repoCounter = 0;

/** Mints a fresh connected repository fixture with a unique project id and remote URL. */
function makeRepo(connectedByUserId: UserId | null = USER, syncStatus: GitSyncStatus = 'UP_TO_DATE'): Repo {
  repoCounter += 1;
  const suffix = String(repoCounter).padStart(4, '0');
  const projectId = ProjectId.create(`550e8400-e29b-41d4-a716-44665540${suffix}`);
  const repository = new GitRepository(
    GitRepositoryId.create(`550e8400-e29b-41d4-a716-44665541${suffix}`),
    projectId,
    GitProvider.create('github'),
    `https://github.com/example/repo-${suffix}.git`,
    `cred-${suffix}`,
    'main',
    syncStatus,
    'main',
    null,
    null,
    new Date(),
    connectedByUserId,
  );
  return { projectId, repository };
}

/** Captures every structured log line the scheduler writes, for asserting content. */
class CapturingLogger {
  readonly lines: { level: 'warn' | 'error'; context: object; message: string }[] = [];

  warn(context: object, message: string): void {
    this.lines.push({ level: 'warn', context, message });
  }

  error(context: object, message: string): void {
    this.lines.push({ level: 'error', context, message });
  }
}

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

/** Builds a scheduler wired to real in-memory fakes. */
function buildScheduler(overrides: { enabled?: boolean; intervalMs?: number; maxConcurrency?: number } = {}) {
  const gitRepositoryRepository = new InMemoryGitRepositoryRepository();
  const gitOperationRepository = new InMemoryGitOperationRepository();
  const logger = new CapturingLogger();

  const scheduler = createRemoteRefreshScheduler({
    gitRepositoryRepository,
    gitOperationRepository,
    logger,
    intervalMs: overrides.intervalMs ?? 10,
    enabled: overrides.enabled ?? true,
    maxConcurrency: overrides.maxConcurrency ?? 8,
  });

  /** Registers a connected repo. */
  async function connect(repo: Repo): Promise<void> {
    await gitRepositoryRepository.save(repo.repository);
  }

  return { scheduler, gitRepositoryRepository, gitOperationRepository, logger, connect };
}

/** The kind of the project's currently-active operation, or null when it has none. */
async function activeKind(
  gitOperationRepository: InMemoryGitOperationRepository,
  projectId: ProjectId,
): Promise<string | null> {
  const active = await gitOperationRepository.findActiveOperation(projectId);
  return active?.kind ?? null;
}

describe('remote-refresh scheduler', () => {
  it('enqueues a FETCH operation, attributed to the connecting user, for every connected repository', async () => {
    const harness = buildScheduler();
    const a = makeRepo();
    const b = makeRepo();
    await harness.connect(a);
    await harness.connect(b);

    harness.scheduler.start();
    try {
      await waitUntil(
        async () =>
          (await activeKind(harness.gitOperationRepository, a.projectId)) === 'FETCH'
          && (await activeKind(harness.gitOperationRepository, b.projectId)) === 'FETCH',
      );
    } finally {
      await harness.scheduler.stop();
    }

    const enqueued = await harness.gitOperationRepository.findActiveOperation(a.projectId);
    expect(enqueued?.kind).toBe('FETCH');
    expect(enqueued?.state).toBe('QUEUED');
    expect(enqueued?.triggeredByUserId.value).toBe(USER.value);
  });

  it('never enqueues a FETCH for a DISCONNECTED placeholder row (a not-yet-published initialize)', async () => {
    const harness = buildScheduler();
    const connected = makeRepo();
    const placeholder = makeRepo(USER, 'DISCONNECTED');
    await harness.connect(connected);
    await harness.connect(placeholder);

    harness.scheduler.start();
    try {
      await waitUntil(async () => (await activeKind(harness.gitOperationRepository, connected.projectId)) === 'FETCH');
      // Give the sweep ample room to (wrongly) enqueue against the placeholder before asserting it never did.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await harness.scheduler.stop();
    }

    expect(await activeKind(harness.gitOperationRepository, connected.projectId)).toBe('FETCH');
    expect(await activeKind(harness.gitOperationRepository, placeholder.projectId)).toBeNull();
  });

  it('never enqueues a FETCH for a NEEDS_REAUTH repository (its credential was rejected until rotated)', async () => {
    const harness = buildScheduler();
    const connected = makeRepo();
    const rejected = makeRepo(USER, 'NEEDS_REAUTH');
    await harness.connect(connected);
    await harness.connect(rejected);

    harness.scheduler.start();
    try {
      await waitUntil(async () => (await activeKind(harness.gitOperationRepository, connected.projectId)) === 'FETCH');
      // Give the sweep ample room to (wrongly) enqueue against the rejected repo before asserting it never did.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await harness.scheduler.stop();
    }

    expect(await activeKind(harness.gitOperationRepository, connected.projectId)).toBe('FETCH');
    expect(await activeKind(harness.gitOperationRepository, rejected.projectId)).toBeNull();
  });

  it('never enqueues a competing FETCH for a repository that already has an active operation (single-flight)', async () => {
    const harness = buildScheduler();
    const busy = makeRepo();
    const idle = makeRepo();
    await harness.connect(busy);
    await harness.connect(idle);
    // An in-flight (QUEUED) operation makes findActiveOperation non-null for the busy project — the
    // exact condition a user pull/push/switch would create.
    await harness.gitOperationRepository.enqueue({ projectId: busy.projectId, kind: 'PULL', triggeredByUserId: USER });

    harness.scheduler.start();
    try {
      await waitUntil(async () => (await activeKind(harness.gitOperationRepository, idle.projectId)) === 'FETCH');
      // Give the sweep ample room to (wrongly) enqueue against the busy repo before asserting it never did.
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      await harness.scheduler.stop();
    }

    // The busy repo's only operation is still the user's PULL — no background FETCH was ever stacked.
    expect(await activeKind(harness.gitOperationRepository, busy.projectId)).toBe('PULL');
    expect(await harness.gitOperationRepository.findMostRecentByKind(busy.projectId, 'FETCH')).toBeNull();
  });

  it('does not stack a second FETCH while the first is still queued', async () => {
    const harness = buildScheduler({ intervalMs: 5 });
    const repo = makeRepo();
    await harness.connect(repo);

    harness.scheduler.start();
    try {
      await waitUntil(async () => (await activeKind(harness.gitOperationRepository, repo.projectId)) === 'FETCH');
      // Several more sweep cycles must not enqueue another FETCH: the queued one is already active.
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      await harness.scheduler.stop();
    }

    const first = await harness.gitOperationRepository.findMostRecentByKind(repo.projectId, 'FETCH');
    const active = await harness.gitOperationRepository.findActiveOperation(repo.projectId);
    // The single active FETCH is the same row the first sweep enqueued.
    expect(active?.id.value).toBe(first?.id.value);
  });

  it('skips a repository with no connecting user on record, logging its project id only', async () => {
    const harness = buildScheduler();
    const orphan = makeRepo(null);
    await harness.connect(orphan);

    harness.scheduler.start();
    try {
      await waitUntil(() => harness.logger.lines.some((line) => line.message.includes('no connecting user')));
    } finally {
      await harness.scheduler.stop();
    }

    expect(await harness.gitOperationRepository.findMostRecentByKind(orphan.projectId, 'FETCH')).toBeNull();
    const line = harness.logger.lines.find((entry) => entry.message.includes('no connecting user'));
    expect(line?.context).toEqual({ projectId: orphan.projectId.value });
  });

  it('tolerates a per-repository failure and still enqueues the others', async () => {
    const harness = buildScheduler();
    const failing = makeRepo();
    const healthy = makeRepo();
    await harness.connect(failing);
    await harness.connect(healthy);
    // Make the failing repo's enqueue throw, isolated per-repo so the sweep continues to the healthy one.
    const originalEnqueue = harness.gitOperationRepository.enqueue.bind(harness.gitOperationRepository);
    harness.gitOperationRepository.enqueue = async (input) => {
      if (input.projectId.value === failing.projectId.value) throw new Error('enqueue blew up');
      return originalEnqueue(input);
    };

    harness.scheduler.start();
    try {
      await waitUntil(async () => (await activeKind(harness.gitOperationRepository, healthy.projectId)) === 'FETCH');
    } finally {
      await harness.scheduler.stop();
    }

    expect(harness.logger.lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('swallows the race backstop when a user op is enqueued between the single-flight check and the sweep\'s own enqueue', async () => {
    const harness = buildScheduler();
    const repo = makeRepo();
    await harness.connect(repo);

    // Simulate the race documented on enqueueRefresh: findActiveOperation observes no active
    // operation for this sweep, but a user op lands (via the real one-active-per-project invariant)
    // before this sweep's own enqueue() call is made — so that enqueue() call itself now hits the
    // repository's GitOperationInProgressError, which the sweep must catch and swallow.
    const originalFindActive = harness.gitOperationRepository.findActiveOperation.bind(
      harness.gitOperationRepository,
    );
    let raceWindowOpen = true;
    harness.gitOperationRepository.findActiveOperation = async (projectId) => {
      if (raceWindowOpen && projectId.value === repo.projectId.value) {
        raceWindowOpen = false;
        return null;
      }
      return originalFindActive(projectId);
    };
    await harness.gitOperationRepository.enqueue({ projectId: repo.projectId, kind: 'PULL', triggeredByUserId: USER });

    harness.scheduler.start();
    try {
      await waitUntil(() => harness.logger.lines.some((line) => line.level === 'error'));
    } finally {
      await harness.scheduler.stop();
    }

    // The sweep's own FETCH enqueue was rejected by the real invariant and swallowed — the user's
    // PULL remains the project's sole active operation, and no FETCH was ever recorded.
    expect(await activeKind(harness.gitOperationRepository, repo.projectId)).toBe('PULL');
    expect(await harness.gitOperationRepository.findMostRecentByKind(repo.projectId, 'FETCH')).toBeNull();
  });

  it('does nothing when disabled, but still starts and stops cleanly', async () => {
    const harness = buildScheduler({ enabled: false });
    const repo = makeRepo();
    await harness.connect(repo);

    harness.scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await harness.scheduler.stop();

    expect(await harness.gitOperationRepository.findActiveOperation(repo.projectId)).toBeNull();
    expect(harness.logger.lines).toEqual([]);
  });

  it('stops cleanly: no further enqueues happen after stop() resolves', async () => {
    const harness = buildScheduler({ intervalMs: 5 });
    const first = makeRepo();
    await harness.connect(first);

    harness.scheduler.start();
    await waitUntil(async () => (await activeKind(harness.gitOperationRepository, first.projectId)) === 'FETCH');
    await harness.scheduler.stop();

    // A repo connected after stop must never get a FETCH — the loop is fully torn down.
    const late = makeRepo();
    await harness.connect(late);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(await harness.gitOperationRepository.findMostRecentByKind(late.projectId, 'FETCH')).toBeNull();
  });
});
