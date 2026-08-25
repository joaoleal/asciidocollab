import type { Logger } from 'pino';
import type { AuditLogRepository, GitOperation, GitOperationRepository } from '@asciidocollab/domain';
import {
  recordAuditSuccess,
  AUDIT_GIT_OPERATION_SUCCEEDED,
  AUDIT_GIT_OPERATION_FAILED,
  AUDIT_GIT_OPERATION_ABORTED,
} from '@asciidocollab/domain';
import type { GitOperationTransitionTarget } from '@asciidocollab/domain';
import { dispatchGitOperation, ENSURE_CLEAN_WORKING_TREE_FAILED_ERROR_CODE } from './dispatch/git-operation-dispatcher.js';
import type { GitOperationHandlerRegistry, GitOperationOutcome } from './dispatch/git-operation-dispatcher.js';

/** A terminal `GitOperationOutcome` — every variant except `awaitingConflict`, which is not terminal. */
type TerminalGitOperationOutcome = Exclude<GitOperationOutcome, { kind: 'awaitingConflict' }>;

/** Maps a terminal outcome to the `GitOperation` state the run loop transitions to. */
function terminalStateFor(outcome: TerminalGitOperationOutcome): GitOperationTransitionTarget {
  if (outcome.kind === 'succeeded') return 'SUCCEEDED';
  if (outcome.kind === 'failed') return 'FAILED';
  return 'ABORTED';
}

/** Maps a terminal outcome to the `AuditLog` action string recorded for it. */
function auditActionFor(outcome: TerminalGitOperationOutcome): string {
  if (outcome.kind === 'succeeded') return AUDIT_GIT_OPERATION_SUCCEEDED;
  if (outcome.kind === 'failed') return AUDIT_GIT_OPERATION_FAILED;
  return AUDIT_GIT_OPERATION_ABORTED;
}

/** Dependencies the git-worker run loop needs, injected so it can be tested with fakes. */
export interface GitWorkerLoopDeps {
  /** The durable work-list: claims, heartbeats, and terminal-state transitions. */
  gitOperationRepository: GitOperationRepository;
  /** Best-effort sink for the terminal-outcome audit entry. */
  auditLogRepository: AuditLogRepository;
  /** The kind → use-case dispatch registry (see `dispatch/git-operation-dispatcher.ts`). */
  handlers: GitOperationHandlerRegistry;
  /**
   * Restores the claimed operation's project working tree to a known-clean state before its
   * handler runs — the working-tree clean-start step (`ensureCleanWorkingTree`).
   *
   * @param operation - The claimed operation whose project working tree to clean.
   */
  ensureCleanWorkingTree: (operation: GitOperation) => Promise<void>;
  /** Structured logger for loop diagnostics (uncaught iteration errors, illegal transitions). */
  logger: Logger;
  /** Milliseconds slept between claim attempts when nothing was claimed — bounds the poll rate. */
  pollIntervalMs: number;
  /** Milliseconds between heartbeat refreshes while a claimed job's handler is running. */
  heartbeatIntervalMs: number;
  /** Passed through to `claimNextQueued` — how stale a RUNNING op's heartbeat may get before reclaim. */
  staleHeartbeatAfterMs: number;
}

/** The running git-worker poll loop: claim → dispatch → heartbeat → terminal state + audit. */
export interface GitWorkerLoop {
  /** Starts the loop. Idempotent: calling it again while already running is a no-op. */
  start(): void;
  /**
   * Stops the loop: wakes it from any idle sleep and waits for its current iteration (including
   * an in-flight claimed job) to finish before resolving. Idempotent.
   *
   * @returns Resolves once the loop has fully stopped.
   */
  stop(): Promise<void>;
}

/**
 * Builds the git-worker run loop: repeatedly `claimNextQueued`s the next unit of work — which
 * opportunistically reclaims a stale-heartbeat `RUNNING` op in the same call — dispatches it to
 * the handler registered for its `GitOperationKind`, refreshes its heartbeat on an interval while
 * the handler runs, and on completion sets the terminal state (or `AWAITING_CONFLICT`) and, for a
 * terminal outcome, records an `AuditLog` entry. Sleeps a bounded `pollIntervalMs` between claim
 * attempts that find nothing to do, so the loop never busy-spins.
 *
 * @param deps - The loop's collaborators; see {@link GitWorkerLoopDeps}.
 * @returns The loop, not yet started.
 */
export function createGitWorkerLoop(deps: GitWorkerLoopDeps): GitWorkerLoop {
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

  async function processClaimed(operation: GitOperation): Promise<void> {
    const heartbeatTimer = setInterval(() => {
      deps.gitOperationRepository.heartbeat(operation.id).catch((error: unknown) => {
        deps.logger.warn({ err: error, operationId: operation.id.value }, 'git-worker heartbeat refresh failed');
      });
    }, deps.heartbeatIntervalMs);

    let outcome: GitOperationOutcome;
    try {
      // Failing fast here (rather than letting ensureCleanWorkingTree's throw propagate
      // uncaught) keeps a working tree that can't be cleaned from getting stuck RUNNING for the
      // stale-heartbeat sweep to repeatedly, silently retry — see the error code's own docs.
      await deps.ensureCleanWorkingTree(operation);
      outcome = await dispatchGitOperation(operation, deps.handlers);
    } catch {
      outcome = { kind: 'failed', errorCode: ENSURE_CLEAN_WORKING_TREE_FAILED_ERROR_CODE };
    } finally {
      clearInterval(heartbeatTimer);
    }

    await applyOutcome(operation, outcome);
  }

  async function applyOutcome(operation: GitOperation, outcome: GitOperationOutcome): Promise<void> {
    if (outcome.kind === 'awaitingConflict') {
      const result = await deps.gitOperationRepository.transition(operation.id, 'AWAITING_CONFLICT');
      if (!result.success) {
        deps.logger.error(
          { err: result.error, operationId: operation.id.value },
          'git-worker: illegal transition to AWAITING_CONFLICT',
        );
      }
      return; // Not terminal — no AuditLog entry (see GitOperationOutcome's doc comment).
    }

    const toState = terminalStateFor(outcome);
    const result = await deps.gitOperationRepository.transition(
      operation.id,
      toState,
      outcome.kind === 'failed' ? { errorCode: outcome.errorCode } : undefined,
    );
    if (!result.success) {
      deps.logger.error(
        { err: result.error, operationId: operation.id.value },
        `git-worker: illegal transition to ${toState}`,
      );
      return;
    }

    await recordAuditSuccess(
      deps.auditLogRepository,
      {
        actorId: operation.triggeredByUserId,
        projectId: operation.projectId,
        action: auditActionFor(outcome),
        resourceType: 'GitOperation',
        resourceId: operation.id.value,
        metadata: {
          kind: operation.kind,
          ...(outcome.kind === 'failed' ? { errorCode: outcome.errorCode } : {}),
        },
      },
      deps.logger,
    );
  }

  /**
   * Claims and fully processes one unit of work, if any is available.
   *
   * @returns Whether an operation was claimed.
   */
  async function runOnce(): Promise<boolean> {
    const operation = await deps.gitOperationRepository.claimNextQueued(deps.staleHeartbeatAfterMs);
    if (!operation) return false;

    await processClaimed(operation);
    return true;
  }

  async function loop(): Promise<void> {
    while (running) {
      let claimed = false;
      try {
        claimed = await runOnce();
      } catch (error) {
        deps.logger.error({ err: error }, 'git-worker: run loop iteration failed');
      }

      if (!running) return;
      if (!claimed) {
        await sleep(deps.pollIntervalMs);
      }
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
