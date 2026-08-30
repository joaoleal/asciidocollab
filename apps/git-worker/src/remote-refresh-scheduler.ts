import type {
  GitOperationRepository,
  GitRepository,
  GitRepositoryRepository,
} from '@asciidocollab/domain';
import type { UndoReferenceSweeper } from './undo-reference-sweeper.js';

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
  /**
   * Optional belt-and-braces sweeper of orphaned `refs/adc/undo/*` undo points. Unlike the `FETCH`
   * enqueue (every cycle), the sweep runs only every {@link UNDO_SWEEP_EVERY_CYCLES}th cycle — and
   * deliberately NOT on the very first (startup) pass: the inline prune `MergeConflictOps` runs on
   * every content op already keeps stragglers rare, so spawning a `for-each-ref` subprocess per
   * connected repo every cycle (or on worker startup, competing with every other startup task) is
   * wasted work. Omitted in tests exercising only the enqueue behavior; supplied by the composition
   * root in production. Its own failures are self-contained (see {@link UndoReferenceSweeper.sweep}), and it
   * never blocks or fails the enqueue.
   */
  undoRefSweeper?: UndoReferenceSweeper;
}

/**
 * How often the undo-ref sweep runs, measured in refresh cycles: once every N cycles, starting a few
 * cycles in rather than on the very first (startup) one — see `sweepCycle`'s initial value — NOT every
 * cycle like the `FETCH` refresh. The inline prune makes an orphaned undo
 * ref rare, so the belt-and-braces sweep only has to reclaim the occasional straggler a mid-op crash
 * left behind — running it a tenth as often keeps that backstop while dropping the per-repo
 * `for-each-ref` subprocess off the hot path. Tuned independently of `intervalMs`, so at the
 * production refresh interval the sweep still lands often enough to bound straggler lifetime.
 */
const UNDO_SWEEP_EVERY_CYCLES = 10;

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
  // Counts refresh cycles so the undo-ref sweep can run only every UNDO_SWEEP_EVERY_CYCLES-th one,
  // while the FETCH refresh keeps running every cycle. Starts at 1, not 0: the check below fires when
  // this counter is a multiple of UNDO_SWEEP_EVERY_CYCLES, and starting at 0 would fire on the very
  // FIRST sweep — a `for-each-ref` subprocess per connected repo on worker startup, competing with
  // every other startup task for no reason (the inline prune already keeps stragglers rare; there is
  // nothing urgent for the backstop to catch that early). Starting at 1 defers that first sweep to the
  // UNDO_SWEEP_EVERY_CYCLES-th pass instead, while leaving the steady-state cadence (every
  // UNDO_SWEEP_EVERY_CYCLES-th cycle thereafter) unchanged.
  let sweepCycle = 1;

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

    // Decide ONCE per cycle whether this pass also runs the undo-ref sweep — every
    // UNDO_SWEEP_EVERY_CYCLES-th cycle, starting a few cycles in rather than on the very first
    // (startup) pass (see `sweepCycle`'s initial value), not every cycle. The FETCH enqueue below is
    // unaffected and still runs every cycle. Computed here (before the workers fan out) so every repo
    // in one pass makes the same decision, then the counter advances for the next pass.
    const undoReferenceSweeper =
      deps.undoRefSweeper && sweepCycle % UNDO_SWEEP_EVERY_CYCLES === 0 ? deps.undoRefSweeper : undefined;
    sweepCycle += 1;

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
        // Belt-and-braces: on a sweep cycle, prune any orphaned undo ref this repo accumulated (a
        // crash between a content op's snapshot write and its inline prune). Runs BEFORE the enqueue
        // below on purpose: the enqueue creates a QUEUED FETCH, and the sweeper's own skip counts any
        // active operation — including that FETCH — so sweeping first is what lets a quiescent repo
        // actually be swept this pass, while a genuinely in-flight user op still trips the skip.
        // Self-contained and best-effort: its own failures are caught inside `sweep` and never
        // disturb the enqueue.
        if (undoReferenceSweeper) {
          await undoReferenceSweeper.sweep(repository);
        }
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
