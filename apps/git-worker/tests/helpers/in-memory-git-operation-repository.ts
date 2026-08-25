import { randomUUID } from 'crypto';
import {
  GitOperation,
  GitConflict,
  GitOperationId,
  GitConflictId,
  GitOperationInProgressError,
  IllegalGitOperationTransitionError,
  GIT_OPERATION_LEGAL_TRANSITIONS,
  TERMINAL_GIT_OPERATION_STATES,
} from '@asciidocollab/domain';
import type {
  CreateGitConflictInput,
  EnqueueGitOperationInput,
  GitOperationRepository,
  GitOperationTransitionInput,
  GitOperationTransitionTarget,
  ProjectId,
  Result,
} from '@asciidocollab/domain';

/**
 * A local, minimal in-memory `GitOperationRepository` fake for this app's run-loop tests.
 *
 * Not a re-export of `packages/domain/tests/ports/git/in-memory-git-operation-repository.ts`:
 * that file imports domain's value objects/entities from its own package's `src/` (nominally
 * typed via private/protected fields), which is a different module instance than the compiled
 * `@asciidocollab/domain` (`dist/`) this app itself imports — TypeScript treats the two as
 * incompatible types across that boundary. So this app keeps its own small fake, built only
 * against the public `@asciidocollab/domain` package, mirroring the domain fake's semantics
 * (FIFO claim, opportunistic stale-heartbeat reclaim, `transition` validated against the same
 * `GIT_OPERATION_LEGAL_TRANSITIONS` table) closely enough to exercise the run loop faithfully.
 */
export class InMemoryGitOperationRepository implements GitOperationRepository {
  private readonly operations = new Map<string, GitOperation>();
  private readonly insertionOrder = new Map<string, number>();
  private readonly conflicts = new Map<string, GitConflict>();
  private nextSequence = 0;

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
      new Date(),
    );
    this.store(operation);
    return operation;
  }

  async claimNextQueued(staleHeartbeatAfterMs: number): Promise<GitOperation | null> {
    const now = new Date();

    const queued = this.oldestFirst((op) => op.state === 'QUEUED');
    if (queued) return this.claim(queued, now);

    const staleRunning = this.oldestFirst(
      (op) => op.state === 'RUNNING' && this.isStale(op, now, staleHeartbeatAfterMs),
    );
    if (staleRunning) return this.claim(staleRunning, now);

    return null;
  }

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
        new Date(),
        operation.errorCode,
        operation.startedAt,
        operation.finishedAt,
        operation.createdAt,
      ),
    );
  }

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
    const now = new Date();
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

  async findById(operationId: GitOperationId): Promise<GitOperation | null> {
    return this.operations.get(operationId.value) ?? null;
  }

  async findActiveOperation(projectId: ProjectId): Promise<GitOperation | null> {
    return (
      [...this.operations.values()].find(
        (op) => op.projectId.value === projectId.value && op.isActive,
      ) ?? null
    );
  }

  async createConflict(input: CreateGitConflictInput): Promise<GitConflict> {
    const conflict = new GitConflict(
      GitConflictId.create(randomUUID()),
      input.operationId,
      input.path,
      input.isBinary ?? false,
      false,
      null,
      new Date(),
    );
    this.conflicts.set(conflict.id.value, conflict);
    return conflict;
  }

  async listConflicts(operationId: GitOperationId): Promise<GitConflict[]> {
    return [...this.conflicts.values()].filter((conflict) => conflict.operationId.value === operationId.value);
  }

  async getConflict(conflictId: GitConflictId): Promise<GitConflict | null> {
    return this.conflicts.get(conflictId.value) ?? null;
  }

  async clearConflicts(operationId: GitOperationId): Promise<void> {
    for (const [id, conflict] of this.conflicts) {
      if (conflict.operationId.value === operationId.value) this.conflicts.delete(id);
    }
  }

  private oldestFirst(predicate: (op: GitOperation) => boolean): GitOperation | undefined {
    return [...this.operations.values()]
      .filter(predicate)
      .toSorted((a, b) => this.sequenceOf(a) - this.sequenceOf(b))[0];
  }

  private isStale(operation: GitOperation, now: Date, staleHeartbeatAfterMs: number): boolean {
    if (operation.heartbeatAt === null) return true;
    return now.getTime() - operation.heartbeatAt.getTime() >= staleHeartbeatAfterMs;
  }

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
