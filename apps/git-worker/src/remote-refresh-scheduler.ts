import type {
  GitOperationRepository,
  GitRepository,
  GitRepositoryRepository,
} from '@asciidocollab/domain';

/**
 * The minimal structured-logging surface the scheduler writes to — a structural subset of pino's
 * `Logger` (so the composition root passes its real pino logger straight through), narrowed here so
 * tests can substitute a plain capture. Diagnostics carry a project id and a safe error name only.
 */
export interface RemoteRefreshLogger {
  /**
   * Records an expected, per-repository condition (a repo with no connecting user on record).
   *
   * @param object - Structured context (a project id and a safe error name only).
   * @param message - The human-readable log message.
   */
  warn(object: object, message: string): void;
  /**
   * Records an unexpected per-repository failure that was caught so the sweep could continue.
   *
   * @param object - Structured context (a project id and the caught error).
   * @param message - The human-readable log message.
   */
  error(object: object, message: string): void;
}

/** Everything {@link createRemoteRefreshScheduler} needs to periodically enqueue remote refreshes. */
export interface RemoteRefreshSchedulerDeps {
  /** Lists every connected repository — the set each sweep iterates over. */
  gitRepositoryRepository: GitRepositoryRepository;
  /**
   * Consulted per repo for an in-flight operation (single-flight) and used to enqueue the `FETCH`
   * operation the run loop then serializes against every other git operation for that project.
   */
  gitOperationRepository: GitOperationRepository;
  /** Structured sink for per-repo diagnostics. */
  logger: RemoteRefreshLogger;
  /** Milliseconds slept between sweeps of the connected repositories. */
  intervalMs: number;
  /** Whether sweeps actually run. When false, the scheduler still starts/stops cleanly but performs no work. */
  enabled: boolean;
  /**
   * Maximum number of repositories processed concurrently within one sweep. Bounds per-sweep
   * enqueue work so a large connected-repository table cannot make a sweep run continuously. Must be >= 1.
   */
  maxConcurrency: number;
}

/** A periodic background remote-refresh scheduler. Its lifecycle mirrors the git-worker run loop's. */
export interface RemoteRefreshScheduler {
  /** Starts the scheduler. Idempotent: calling it again while already running is a no-op. */
  start(): void;
  /**
   * Stops the scheduler: wakes it from any idle sleep and waits for the current sweep to finish
   * before resolving. Idempotent. No timer is left pending afterwards.
   *
   * @returns Resolves once the scheduler has fully stopped.
   */
  stop(): Promise<void>;
}

/**
 * Builds a background scheduler that, on a timer, ENQUEUES a `FETCH` `GitOperation` for every
 * connected repository so a "behind by N — pull available" prompt surfaces on its own, without a
 * member first triggering a sync.
 *
 * ## Serialization mechanism (the reason this only enqueues)
 * The refresh's `git fetch` must never run concurrently with a user's pull/push/branch-switch on the
 * same working tree — two processes contending on `.git/*.lock` can crash the USER-facing operation.
 * Rather than invent a second lock, the scheduler routes the refresh through the ordinary operation
 * queue: it enqueues a `FETCH` (see `dispatch/fetch-handler.ts`), and the run loop's
 * `claimNextQueued` single-flight then serializes that `FETCH` against every other git operation for
 * the project — the exact same per-project serialization every user op already relies on. The
 * scheduler is purely an enqueuer; the fetch itself, and its credential decryption, happen in the
 * `FETCH` dispatch handler when the run loop claims the operation.
 *
 * Per repository — each in its own `try/catch` so one repo's failure never aborts the rest of the
 * sweep:
 *   1. Skips the repo when it already has an active `GitOperation` (QUEUED/RUNNING/AWAITING_CONFLICT).
 *      This is both the single-flight guard (never compete with an in-flight pull/push/switch) and
 *      what stops a second `FETCH` stacking behind an already-queued one.
 *   2. Enqueues a `FETCH` attributed to the user who connected the repository. A repo with no
 *      connecting user on record (a legacy row) is skipped with a project-id-only warn.
 *
 * ## FOLLOW-UP (multi-worker; not built here)
 * `findAllConnected()` returns every connected repository, so this sweep enqueues a `FETCH` for a
 * repo whose working tree no worker has materialized yet; whichever worker claims it fails that one
 * `FETCH` (its clean-start/fetch step throws) and moves on. This is an inherent multi-worker concern
 * — cheaply filtering to "repos this worker can service" is not possible at enqueue time, since any
 * worker may claim any queued operation. A fuller scheme (spreading repositories across successive
 * sweeps, and/or scoping refreshes to repositories with active viewers) is intentionally left out of
 * scope; this scheduler still enqueues for every connected repository each cycle.
 *
 * Between sweeps it sleeps `intervalMs` on a wakeable timer, so {@link RemoteRefreshScheduler.stop}
 * returns promptly and leaves no timer pending.
 *
 * @param deps - The scheduler's collaborators; see {@link RemoteRefreshSchedulerDeps}.
 * @returns The scheduler, not yet started.
 */
export function createRemoteRefreshScheduler(deps: RemoteRefreshSchedulerDeps): RemoteRefreshScheduler {
  let running = false;
  let iteration: Promise<void> = Promise.resolve();
  let wake: (() => void) | null = null;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }

  async function enqueueRefresh(repository: GitRepository): Promise<void> {
    // Single-flight: an in-flight pull/push/switch (or an already-queued FETCH) owns the project's
    // one operation slot — don't compete with it or stack a second FETCH behind it.
    const active = await deps.gitOperationRepository.findActiveOperation(repository.projectId);
    if (active !== null) return;

    const triggeredByUserId = repository.connectedByUserId;
    if (triggeredByUserId === null) {
      deps.logger.warn(
        { projectId: repository.projectId.value },
        'remote-refresh: no connecting user on record, skipping enqueue',
      );
      return;
    }

    // Enqueue the FETCH; the run loop claims and serializes it. A rare race (a user op enqueued
    // between the check above and here) surfaces as an enqueue throw, caught by the sweep worker.
    await deps.gitOperationRepository.enqueue({
      projectId: repository.projectId,
      kind: 'FETCH',
      triggeredByUserId,
    });
  }

  async function sweep(): Promise<void> {
    const repositories = await deps.gitRepositoryRepository.findAllConnected();

    // Bounded worker pool: at most `maxConcurrency` `enqueueRefresh` calls are ever in flight at
    // once. Each worker pulls the next repository off a shared cursor until the list is exhausted.
    // `index = nextIndex++` is a single event-loop step (no `await` between read and increment), so
    // every repository is handed to exactly one worker.
    const workerCount = Math.max(1, Math.min(deps.maxConcurrency, repositories.length));
    let nextIndex = 0;

    async function worker(): Promise<void> {
      while (running) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= repositories.length) return;
        const repository = repositories[index];
        try {
          await enqueueRefresh(repository);
        } catch (error) {
          // Swallow so one repo's unexpected failure never stops the sweep.
          deps.logger.error(
            { projectId: repository.projectId.value, err: error },
            'remote-refresh: unexpected failure enqueuing a repository refresh',
          );
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  async function loop(): Promise<void> {
    while (running) {
      if (deps.enabled) {
        try {
          await sweep();
        } catch (error) {
          deps.logger.error({ err: error }, 'remote-refresh: sweep failed');
        }
      }

      if (!running) return;
      await sleep(deps.intervalMs);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      iteration = loop();
    },
    async stop() {
      running = false;
      wake?.();
      await iteration;
    },
  };
}
