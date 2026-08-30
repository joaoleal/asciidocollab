import {
  GitProvider,
  GitRepository,
  GitRepositoryId,
  ProjectId,
  UserId,
  type GitSyncStatus,
} from '@asciidocollab/domain';
import { createRemoteRefreshScheduler } from '../src/remote-refresh-scheduler.js';
import type { UndoReferenceSweeper } from '../src/undo-reference-sweeper.js';
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

/**
 * A stand-in {@link UndoReferenceSweeper} that records the repos it is asked to sweep. It mirrors the real
 * sweeper's own active-operation skip (consulting the same operation repository) so a repo is only
 * counted as actually SWEPT when it is quiescent at call time. That lets a test prove both that the
 * scheduler invokes the sweeper per repo AND that the invocation lands while the repo is still
 * quiescent — i.e. BEFORE this pass's own FETCH is enqueued — which is exactly what the ordering fix
 * restores; a genuinely active user op still trips the skip.
 */
class RecordingSweeper implements UndoReferenceSweeper {
  /** Every repo the scheduler asked to sweep, whether or not it was quiescent. */
  readonly seen: string[] = [];
  /** Only the repos that were quiescent at sweep time — the ones the real sweeper would actually reclaim. */
  readonly swept: string[] = [];

  constructor(private readonly gitOperationRepository: InMemoryGitOperationRepository) {}

  async sweep(repository: GitRepository): Promise<void> {
    this.seen.push(repository.projectId.value);
    const active = await this.gitOperationRepository.findActiveOperation(repository.projectId);
    if (active !== null) return;
    this.swept.push(repository.projectId.value);
  }
}

/**
 * Installs a drain on `gitOperationRepository.enqueue`: immediately after a `FETCH` the scheduler
 * enqueues is recorded, claims and completes it — UNLESS `sweeper` already swept that project THIS
 * pass, in which case that pass's `FETCH` is left standing for the caller to observe. Mimics a live
 * git-worker run loop, which this harness (the scheduler alone) has none of: without draining, the
 * very first `FETCH` the scheduler ever enqueues for a repo would sit `QUEUED` forever, and that repo
 * would never again look quiescent to a sweep landing on a LATER cycle — masking the very behavior
 * (the sweep now runs a few cycles in, not on the startup pass — see `remote-refresh-scheduler.ts`'s
 * `sweepCycle`) these tests exist to prove. Runs entirely within the SAME `enqueue` call the scheduler
 * itself awaits, not a separate timer, so there is no race against the sweeper's own check.
 *
 * Only ever targets the `FETCH` this call itself just created: `claimNextQueued` is a repository-wide
 * FIFO claim, so if another project has an OLDER `QUEUED` operation of its own, that call would claim
 * it instead — a mismatch this guards against by checking the claimed id before completing anything.
 * Callers with a second, deliberately-busy project must keep that project's operation off `QUEUED`
 * (e.g. claim it to `RUNNING` up front) so it can never be the one this drain's claim picks up.
 */
function drainFetchesUntilSwept(gitOperationRepository: InMemoryGitOperationRepository, sweeper: RecordingSweeper): void {
  const originalEnqueue = gitOperationRepository.enqueue.bind(gitOperationRepository);
  gitOperationRepository.enqueue = async (input) => {
    const operation = await originalEnqueue(input);
    if (operation.kind === 'FETCH' && !sweeper.swept.includes(input.projectId.value)) {
      const claimed = await gitOperationRepository.claimNextQueued(60_000);
      if (claimed?.id.value === operation.id.value) {
        await gitOperationRepository.transition(claimed.id, 'SUCCEEDED');
      }
    }
    return operation;
  };
}

/** Builds a scheduler wired to real in-memory fakes. */
function buildScheduler(
  overrides: {
    enabled?: boolean;
    intervalMs?: number;
    maxConcurrency?: number;
    makeUndoReferenceSweeper?: (gitOperationRepository: InMemoryGitOperationRepository) => UndoReferenceSweeper;
  } = {},
) {
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
    undoRefSweeper: overrides.makeUndoReferenceSweeper?.(gitOperationRepository),
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

  it('invokes the undo-ref sweeper for a connected repository, before this pass enqueues its FETCH', async () => {
    let sweeper!: RecordingSweeper;
    const harness = buildScheduler({ makeUndoReferenceSweeper: (ops) => (sweeper = new RecordingSweeper(ops)) });
    const repo = makeRepo();
    await harness.connect(repo);
    // The sweep no longer runs on the very first (startup) pass — see remote-refresh-scheduler.ts's
    // sweepCycle — so several ordinary FETCH-enqueuing passes happen first. Drain each one (as a real
    // run loop would) so the repo is still quiescent once the sweep-eligible pass lands.
    drainFetchesUntilSwept(harness.gitOperationRepository, sweeper);

    harness.scheduler.start();
    try {
      // The repo is counted as SWEPT only if it was quiescent when the sweeper ran — which holds only
      // because the sweep runs BEFORE this pass's own FETCH enqueue. Under the old ordering the FETCH
      // would already be active and the sweep would (wrongly) skip, so this would never become true.
      await waitUntil(() => sweeper.swept.includes(repo.projectId.value));
    } finally {
      await harness.scheduler.stop();
    }

    expect(sweeper.seen).toContain(repo.projectId.value);
    expect(sweeper.swept).toContain(repo.projectId.value);
    // And the FETCH the pass creates is still enqueued for that repo — sweeping first did not skip it.
    expect(await activeKind(harness.gitOperationRepository, repo.projectId)).toBe('FETCH');
  });

  it('runs the undo-ref sweep only periodically, not on every refresh cycle', async () => {
    let sweeper!: RecordingSweeper;
    // A short interval so many cycles elapse quickly. An orphan repo (no connecting user) never gets
    // an active FETCH enqueued, so it is offered to the sweeper on every SWEEP cycle and warns on
    // every cycle — letting us compare "cycles that ran" (warn lines) against "cycles that swept"
    // (sweeper.seen) without a stray FETCH masking later sweep offers.
    const harness = buildScheduler({
      intervalMs: 2,
      makeUndoReferenceSweeper: (ops) => (sweeper = new RecordingSweeper(ops)),
    });
    const orphan = makeRepo(null);
    await harness.connect(orphan);

    harness.scheduler.start();
    try {
      // Wait until well over one sweep period of cycles have run (each cycle logs one "no connecting
      // user" warn for the orphan).
      await waitUntil(
        () => harness.logger.lines.filter((line) => line.message.includes('no connecting user')).length >= 12,
      );
    } finally {
      await harness.scheduler.stop();
    }

    const cyclesRun = harness.logger.lines.filter((line) => line.message.includes('no connecting user')).length;
    // The sweep IS invoked (belt-and-braces still runs)...
    expect(sweeper.seen.length).toBeGreaterThanOrEqual(1);
    // ...but strictly fewer times than the number of cycles — proving it is gated, not per-cycle.
    expect(sweeper.seen.length).toBeLessThan(cyclesRun);
  });

  it('does not sweep a repository that already has an active user operation', async () => {
    let sweeper!: RecordingSweeper;
    const harness = buildScheduler({ makeUndoReferenceSweeper: (ops) => (sweeper = new RecordingSweeper(ops)) });
    const busy = makeRepo();
    const idle = makeRepo();
    await harness.connect(busy);
    await harness.connect(idle);
    // A user PULL owns the busy repo's single-flight slot before any sweep runs. Claimed straight to
    // RUNNING (rather than left QUEUED) so it can never be the operation drainFetchesUntilSwept's own
    // claimNextQueued call picks up below — that call is a repository-wide FIFO claim, and busy's PULL
    // would otherwise be its oldest QUEUED candidate. RUNNING is still "active" either way, so this is
    // exactly as good a stand-in for "a user pull/push/switch in flight" as QUEUED was.
    await harness.gitOperationRepository.enqueue({ projectId: busy.projectId, kind: 'PULL', triggeredByUserId: USER });
    await harness.gitOperationRepository.claimNextQueued(60_000);
    // The sweep no longer runs on the very first (startup) pass — see remote-refresh-scheduler.ts's
    // sweepCycle — so several ordinary FETCH-enqueuing passes happen for idle first. Drain each one
    // (as a real run loop would) so idle is still quiescent once the sweep-eligible pass lands.
    drainFetchesUntilSwept(harness.gitOperationRepository, sweeper);

    harness.scheduler.start();
    try {
      await waitUntil(() => sweeper.swept.includes(idle.projectId.value));
      // Give the busy repo ample room to (wrongly) be swept before asserting it never was.
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      await harness.scheduler.stop();
    }

    // The busy repo was offered to the sweeper but skipped (its active PULL trips the sweeper's own
    // skip); the idle repo was actually swept.
    expect(sweeper.seen).toContain(busy.projectId.value);
    expect(sweeper.swept).not.toContain(busy.projectId.value);
    expect(sweeper.swept).toContain(idle.projectId.value);
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
