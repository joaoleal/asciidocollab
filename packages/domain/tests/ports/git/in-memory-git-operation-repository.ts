import { randomUUID } from 'crypto';
import { GitOperation } from '../../../src/entities/git-operation';
import { GitConflict } from '../../../src/entities/git-conflict';
import { GitOperationId } from '../../../src/value-objects/ids/git-operation-id';
import { GitConflictId } from '../../../src/value-objects/ids/git-conflict-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { Result } from '../../../src/types/result';
import { TERMINAL_GIT_OPERATION_STATES } from '../../../src/types/git-operation-state';
import {
  CreateGitConflictInput,
  EnqueueGitOperationInput,
  GIT_OPERATION_LEGAL_TRANSITIONS,
  GitOperationRepository,
  GitOperationTransitionInput,
  GitOperationTransitionTarget,
} from '../../../src/ports/git/git-operation-repository';
import { GitOperationInProgressError } from '../../../src/errors/git/git-operation-in-progress';
import { IllegalGitOperationTransitionError } from '../../../src/errors/git/illegal-git-operation-transition';

/** Produces the current time; injectable so tests can simulate stale heartbeats deterministically. */
export type Clock = () => Date;

/** In-memory implementation of GitOperationRepository for use in tests. */
export class InMemoryGitOperationRepository implements GitOperationRepository {
  private readonly operations = new Map<string, GitOperation>();
  private readonly insertionOrder = new Map<string, number>();
  private readonly conflicts = new Map<string, GitConflict>();
  private nextSequence = 0;

  /** @param clock - Time source for timestamps; defaults to the wall clock. */
  constructor(private readonly clock: Clock = () => new Date()) {}

  /** Enqueues a new operation in the QUEUED state, oldest-first for later FIFO claiming. */
  async enqueue(input: EnqueueGitOperationInput): Promise<GitOperation> {
    const operation = new GitOperation(
      GitOperationId.create(randomUUID()),
      input.projectId,
      input.kind,
      'QUEUED',
      input.triggeredByUserId,
      input.branch ?? null,
      0,
      null,
      null,
      null,
      null,
      this.clock(),
    );
    this.store(operation);
    return operation;
  }

  /**
   * Claims the oldest QUEUED operation, or — if none is queued — the oldest
   * RUNNING operation whose heartbeat has gone stale. Returns null when
   * neither exists.
   */
  async claimNextQueued(staleHeartbeatAfterMs: number): Promise<GitOperation | null> {
    const now = this.clock();

    const queued = this.oldestFirst((op) => op.state === 'QUEUED');
    if (queued) return this.claim(queued, now);

    const staleRunning = this.oldestFirst(
      (op) => op.state === 'RUNNING' && this.isStale(op, now, staleHeartbeatAfterMs),
    );
    if (staleRunning) return this.claim(staleRunning, now);

    return null;
  }

  /** Refreshes the heartbeat of a running operation. No-op if it does not exist. */
  async heartbeat(operationId: GitOperationId): Promise<void> {
    const operation = this.operations.get(operationId.value);
    if (!operation) return;

    this.store(
      new GitOperation(
        operation.id,
        operation.projectId,
        operation.kind,
        operation.state,
        operation.triggeredByUserId,
        operation.branch,
        operation.progress,
        this.clock(),
        operation.errorCode,
        operation.startedAt,
        operation.finishedAt,
        operation.createdAt,
      ),
    );
  }

  /**
   * Moves an operation to a new state, validating the move against
   * `GIT_OPERATION_LEGAL_TRANSITIONS` — the same table the Prisma adapter validates against, so
   * the two stay in sync.
   */
  async transition(
    operationId: GitOperationId,
    toState: GitOperationTransitionTarget,
    input: GitOperationTransitionInput = {},
  ): Promise<Result<GitOperation, IllegalGitOperationTransitionError>> {
    const operation = this.operations.get(operationId.value);
    const fromState = operation?.state ?? null;

    if (!operation || !(GIT_OPERATION_LEGAL_TRANSITIONS[operation.state] as readonly string[]).includes(toState)) {
      return { success: false, error: new IllegalGitOperationTransitionError(fromState, toState) };
    }

    const isTerminal = TERMINAL_GIT_OPERATION_STATES.includes(toState);
    const now = this.clock();
    const transitioned = new GitOperation(
      operation.id,
      operation.projectId,
      operation.kind,
      toState,
      operation.triggeredByUserId,
      operation.branch,
      isTerminal ? 100 : operation.progress,
      operation.heartbeatAt,
      toState === 'FAILED' ? (input.errorCode ?? null) : null,
      operation.startedAt,
      isTerminal ? now : operation.finishedAt,
      operation.createdAt,
    );
    this.store(transitioned);
    return { success: true, value: transitioned };
  }

  /** Runs `action` only when the project has no active operation; otherwise reports it is busy. */
  async withGuard<T>(
    projectId: ProjectId,
    action: () => Promise<T>,
  ): Promise<Result<T, GitOperationInProgressError>> {
    const busy = [...this.operations.values()].some(
      (op) => op.projectId.value === projectId.value && op.isActive,
    );
    if (busy) {
      return { success: false, error: new GitOperationInProgressError() };
    }
    const value = await action();
    return { success: true, value };
  }

  /** Finds the project's current active (QUEUED/RUNNING/AWAITING_CONFLICT) operation, or null. */
  async findActiveOperation(projectId: ProjectId): Promise<GitOperation | null> {
    return (
      [...this.operations.values()].find(
        (op) => op.projectId.value === projectId.value && op.isActive,
      ) ?? null
    );
  }

  /** Reads back a single operation by id, in whatever state it currently holds, or null. */
  async findById(operationId: GitOperationId): Promise<GitOperation | null> {
    return this.operations.get(operationId.value) ?? null;
  }

  /** Records a new, unresolved conflict for an operation. */
  async createConflict(input: CreateGitConflictInput): Promise<GitConflict> {
    const conflict = new GitConflict(
      GitConflictId.create(randomUUID()),
      input.operationId,
      input.path,
      input.isBinary ?? false,
      false,
      null,
      this.clock(),
    );
    this.conflicts.set(conflict.id.value, conflict);
    return conflict;
  }

  /** Lists every conflict recorded for an operation, in recording order. */
  async listConflicts(operationId: GitOperationId): Promise<GitConflict[]> {
    return [...this.conflicts.values()].filter((conflict) => conflict.operationId.value === operationId.value);
  }

  /** Reads back a single conflict by id, or null if it does not exist. */
  async getConflict(conflictId: GitConflictId): Promise<GitConflict | null> {
    return this.conflicts.get(conflictId.value) ?? null;
  }

  /** Removes every conflict recorded for an operation. */
  async clearConflicts(operationId: GitOperationId): Promise<void> {
    for (const [id, conflict] of this.conflicts) {
      if (conflict.operationId.value === operationId.value) this.conflicts.delete(id);
    }
  }

  /** Finds the oldest (by enqueue order) stored operation matching `predicate`, or undefined. */
  private oldestFirst(predicate: (op: GitOperation) => boolean): GitOperation | undefined {
    return [...this.operations.values()]
      .filter(predicate)
      .toSorted((a, b) => this.sequenceOf(a) - this.sequenceOf(b))[0];
  }

  /** A RUNNING operation is stale once its heartbeat is missing or older than the threshold. */
  private isStale(operation: GitOperation, now: Date, staleHeartbeatAfterMs: number): boolean {
    if (operation.heartbeatAt === null) return true;
    return now.getTime() - operation.heartbeatAt.getTime() >= staleHeartbeatAfterMs;
  }

  /** Marks an operation RUNNING with a fresh heartbeat, preserving its original start time. */
  private claim(operation: GitOperation, now: Date): GitOperation {
    const claimed = new GitOperation(
      operation.id,
      operation.projectId,
      operation.kind,
      'RUNNING',
      operation.triggeredByUserId,
      operation.branch,
      operation.progress,
      now,
      operation.errorCode,
      operation.startedAt ?? now,
      operation.finishedAt,
      operation.createdAt,
    );
    this.store(claimed);
    return claimed;
  }

  private store(operation: GitOperation): void {
    if (!this.insertionOrder.has(operation.id.value)) {
      this.insertionOrder.set(operation.id.value, this.nextSequence++);
    }
    this.operations.set(operation.id.value, operation);
  }

  private sequenceOf(operation: GitOperation): number {
    return this.insertionOrder.get(operation.id.value) ?? Number.MAX_SAFE_INTEGER;
  }
}
