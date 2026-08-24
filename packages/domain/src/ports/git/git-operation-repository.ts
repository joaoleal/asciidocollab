import { GitOperation } from '../../entities/git-operation';
import { GitConflict } from '../../entities/git-conflict';
import { GitOperationId } from '../../value-objects/ids/git-operation-id';
import { GitConflictId } from '../../value-objects/ids/git-conflict-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { UserId } from '../../value-objects/ids/user-id';
import { GitOperationKind } from '../../types/git-operation-kind';
import { GitOperationInProgressError } from '../../errors/git/git-operation-in-progress';
import { Result } from '../../types/result';

/** Input for enqueuing a new whole-project git operation. */
export interface EnqueueGitOperationInput {
  /** The project the operation acts on. */
  projectId: ProjectId;
  /** The kind of git action being performed. */
  kind: GitOperationKind;
  /** The user who triggered this operation. */
  triggeredByUserId: UserId;
  /** The branch this operation targets, when applicable. */
  branch?: string | null;
}

/** Input for recording a new conflicting file on an operation. */
export interface CreateGitConflictInput {
  /** The operation during which this conflict arose. */
  operationId: GitOperationId;
  /** Project-relative path of the conflicting file. */
  path: string;
  /** Whether the file is binary (no textual three-way diff is possible). */
  isBinary?: boolean;
}

/**
 * Persists and dispatches `GitOperation` work items, and their `GitConflict`
 * children. This port is the durable work-list a pool of workers pulls from
 * (`claimNextQueued`), the liveness tracker that lets a crashed worker's claim
 * be reclaimed (the stale-heartbeat sweep folded into that same call), and the
 * single-flight guard (`withGuard`) that short mutating operations use instead
 * of going through the full queue.
 *
 * The real adapter claims work with `SELECT … FOR UPDATE SKIP LOCKED` against a
 * partial-unique index on `(projectId) WHERE state IN (QUEUED, RUNNING,
 * AWAITING_CONFLICT)`; this port only expresses the contract, not that
 * mechanism.
 */
export interface GitOperationRepository {
  /**
   * Enqueues a new operation in the `QUEUED` state.
   *
   * @param input - The operation to enqueue.
   * @returns The persisted operation, with its assigned id and creation time.
   */
  enqueue(input: EnqueueGitOperationInput): Promise<GitOperation>;

  /**
   * Atomically claims the next unit of work for a worker: the oldest `QUEUED`
   * operation, or — if none is queued — the oldest `RUNNING` operation whose
   * heartbeat has gone stale (its worker is presumed crashed). A `RUNNING`
   * operation whose heartbeat is still fresh is left alone.
   *
   * @param staleHeartbeatAfterMs - How long a `RUNNING` operation may go
   *   without a heartbeat before it is considered abandoned and reclaimable.
   * @returns The claimed operation (now `RUNNING`, with a freshened
   *   heartbeat), or null when there is no work to claim.
   */
  claimNextQueued(staleHeartbeatAfterMs: number): Promise<GitOperation | null>;

  /**
   * Refreshes the heartbeat of a running operation, signalling that its
   * worker is still alive. A no-op if the operation does not exist.
   *
   * @param operationId - The operation whose heartbeat to refresh.
   * @returns A promise that resolves once the heartbeat has been refreshed.
   */
  heartbeat(operationId: GitOperationId): Promise<void>;

  /**
   * Runs `action` only if the project has no active operation (`QUEUED`,
   * `RUNNING`, or `AWAITING_CONFLICT`); otherwise fails without calling
   * `action`. This is the single-flight guard short mutating operations
   * (stage, commit, discard, amend) use so they respect the same
   * one-op-per-project rule as the queue, without needing a long-lived
   * `GitOperation` row of their own.
   *
   * @param projectId - The project to guard.
   * @param action - The action to run while holding the guard.
   * @returns `action`'s result on success, or `GitOperationInProgressError`
   *   when another operation is already active for the project.
   */
  withGuard<T>(projectId: ProjectId, action: () => Promise<T>): Promise<Result<T, GitOperationInProgressError>>;

  /**
   * Records a new conflicting file discovered during an operation.
   *
   * @param input - The conflict to record.
   * @returns The persisted, unresolved conflict.
   */
  createConflict(input: CreateGitConflictInput): Promise<GitConflict>;

  /**
   * Lists all conflicts recorded for an operation, resolved or not.
   *
   * @param operationId - The operation whose conflicts to list.
   * @returns The operation's conflicts, in the order they were recorded.
   */
  listConflicts(operationId: GitOperationId): Promise<GitConflict[]>;

  /**
   * Reads back a single conflict by id.
   *
   * @param conflictId - The conflict to read.
   * @returns The conflict, or null if none exists with that id.
   */
  getConflict(conflictId: GitConflictId): Promise<GitConflict | null>;

  /**
   * Removes every conflict recorded for an operation, for example once all of
   * an operation's conflicts have been resolved and landed.
   *
   * @param operationId - The operation whose conflicts to clear.
   * @returns A promise that resolves once the conflicts have been cleared.
   */
  clearConflicts(operationId: GitOperationId): Promise<void>;
}
