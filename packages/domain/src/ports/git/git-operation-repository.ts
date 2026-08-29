import { GitOperation } from '../../entities/git-operation';
import { GitConflict } from '../../entities/git-conflict';
import { GitOperationId } from '../../value-objects/ids/git-operation-id';
import { GitConflictId } from '../../value-objects/ids/git-conflict-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { UserId } from '../../value-objects/ids/user-id';
import { GitOperationKind } from '../../types/git-operation-kind';
import { GitOperationState } from '../../types/git-operation-state';
import { GitDriftSummary } from '../../types/git-drift-summary';
import { ConflictResolution } from '../../types/conflict-resolution';
import { GitOperationInProgressError } from '../../errors/git/git-operation-in-progress';
import { IllegalGitOperationTransitionError } from '../../errors/git/illegal-git-operation-transition';
import { GitConflictNotFoundError } from '../../errors/git/git-conflict-not-found';
import { Result } from '../../types/result';

/**
 * A state {@link GitOperationRepository.transition} may move an operation *to*. `QUEUED` is
 * excluded: it is produced only by `enqueue`, and the initial `QUEUED → RUNNING` move is
 * `claimNextQueued`'s job, not this method's — `transition` only covers what happens to an
 * operation once a worker already holds it.
 */
export type GitOperationTransitionTarget = Exclude<GitOperationState, 'QUEUED'>;

/** Input for {@link GitOperationRepository.transition}. */
export interface GitOperationTransitionInput {
  /** Typed, safe error code to record. Required (and only meaningful) when `toState` is `FAILED`. */
  errorCode?: string;
  /**
   * Reconcile-drift summary to record. Meaningful only on a terminal `SUCCEEDED` move for a pull
   * whose reconcile hit drift; ignored otherwise. Surfaced to the triggering user.
   */
  driftSummary?: GitDriftSummary;
}

/**
 * The `GitOperation` state machine's legal transitions (data-model.md), as the edges reachable
 * through {@link GitOperationRepository.transition}: keyed by the operation's *current* state,
 * valued by the states it may legally move to from there. The single source of truth every
 * `GitOperationRepository` implementation (the in-memory fake and the Prisma adapter) validates
 * against, so the three stay in sync.
 *
 * `QUEUED` has no outgoing edges here (its only move, to `RUNNING`, is `claimNextQueued`'s), and no
 * state transitions out of a terminal one (`SUCCEEDED`/`FAILED`/`ABORTED`).
 */
export const GIT_OPERATION_LEGAL_TRANSITIONS: Readonly<Record<GitOperationState, readonly GitOperationTransitionTarget[]>> = {
  QUEUED: [],
  RUNNING: ['SUCCEEDED', 'FAILED', 'ABORTED', 'AWAITING_CONFLICT'],
  AWAITING_CONFLICT: ['RUNNING'],
  SUCCEEDED: [],
  FAILED: [],
  ABORTED: [],
};

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
   * Moves an operation to a new state, validating the move against
   * {@link GIT_OPERATION_LEGAL_TRANSITIONS}. Sets `finishedAt` and `progress = 100` when `toState`
   * is terminal (`SUCCEEDED`/`FAILED`/`ABORTED`); records `errorCode` only when `toState` is
   * `FAILED` (cleared to null for every other target).
   *
   * @param operationId - The operation to transition.
   * @param toState - The state to move it to.
   * @param input - `errorCode`, required (and only meaningful) when `toState` is `FAILED`.
   * @returns The updated operation, or an `IllegalGitOperationTransitionError` when the move is
   *   not a legal edge from the operation's current state, or the operation does not exist.
   */
  transition(
    operationId: GitOperationId,
    toState: GitOperationTransitionTarget,
    input?: GitOperationTransitionInput,
  ): Promise<Result<GitOperation, IllegalGitOperationTransitionError>>;

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
   * @param excludeOperationId - The id of the operation currently running `action`, when there is
   *   one. A queued operation (e.g. `INITIALIZE`) is claimed into `RUNNING` before its use case
   *   ever calls `withGuard`, so the plain active-operation check would find that very row and
   *   report the operation as conflicting with itself. Passing the operation's own id here excludes
   *   it from the check so it only fails on a genuinely different active operation. Omitted by every
   *   synchronous caller (stage/commit/discard/amend/disconnect/undo-pull/connect), which never
   *   holds a claimed operation row of its own.
   * @returns `action`'s result on success, or `GitOperationInProgressError`
   *   when another operation is already active for the project.
   */
  withGuard<T>(
    projectId: ProjectId,
    action: () => Promise<T>,
    excludeOperationId?: GitOperationId,
  ): Promise<Result<T, GitOperationInProgressError>>;

  /**
   * Finds the project's current active operation — the one in `QUEUED`, `RUNNING`, or
   * `AWAITING_CONFLICT` state, if any (at most one can exist per project). Used by the write-lock
   * check on file-tree mutations and new collaboration/edit sessions to detect whether a
   * content-changing operation is in progress, without running (or blocking on) `withGuard`'s
   * conditional-insert path.
   *
   * @param projectId - The project to check.
   * @returns The active operation, or null when the project has none.
   */
  findActiveOperation(projectId: ProjectId): Promise<GitOperation | null>;

  /**
   * Reads back a single operation by id, in whatever state it currently holds — active or
   * terminal. Used by the progress-polling status read, which needs to see a finished operation's
   * final `state`/`progress`/`errorCode` too, not just the currently-active one.
   *
   * @param operationId - The operation to read.
   * @returns The operation, or null if none exists with that id.
   */
  findById(operationId: GitOperationId): Promise<GitOperation | null>;

  /**
   * Reads back the most recently created operation of the given kind for a project, in whatever
   * state it currently holds. Used to locate an already-terminal operation (for example a
   * `SUCCEEDED` `PULL` with no active row left) that a later action still needs to reference — an
   * undo of a clean pull is the first caller.
   *
   * @param projectId - The project to search.
   * @param kind - The operation kind to match.
   * @returns The most recently created matching operation, or null when none exists.
   */
  findMostRecentByKind(projectId: ProjectId, kind: GitOperationKind): Promise<GitOperation | null>;

  /**
   * Reads back the most recently created operation whose kind is one of `kinds` for a project, in
   * whatever state it currently holds — the set-valued sibling of {@link findMostRecentByKind}, with
   * identical ordering (most-recently-created wins). Used to locate an already-terminal operation
   * across a family of related kinds that a later action still needs to reference — undoing the most
   * recent cleanly-succeeded content operation (a pull OR a branch switch) is the first caller.
   *
   * @param projectId - The project to search.
   * @param kinds - The operation kinds to match; an operation qualifies if its kind is any of them.
   * @returns The most recently created operation whose kind is in `kinds`, or null when none exists.
   */
  findMostRecentByKinds(
    projectId: ProjectId,
    kinds: readonly GitOperationKind[],
  ): Promise<GitOperation | null>;

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

  /**
   * Records a per-file resolution decision: sets `resolved = true` and `resolution` on the
   * conflict recorded for `(operationId, path)`. Idempotent — re-resolving the same path
   * overwrites its prior choice. The merged bytes, when `resolution === 'merged'`, live in the
   * `ConflictStageStore`, not here.
   *
   * @param operationId - The operation the conflict belongs to.
   * @param path - The conflicting file's path.
   * @param resolution - The chosen resolution.
   * @returns The updated conflict, or a `GitConflictNotFoundError` when no conflict is recorded
   *   for that `(operationId, path)`.
   */
  resolveConflict(
    operationId: GitOperationId,
    path: string,
    resolution: ConflictResolution,
  ): Promise<Result<GitConflict, GitConflictNotFoundError>>;
}
