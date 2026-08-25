import { Prisma, type PrismaClient } from '@prisma/client';
import {
  GitOperation,
  GitConflict,
  GitOperationId,
  GitConflictId,
  ProjectId,
  UserId,
  ACTIVE_GIT_OPERATION_STATES,
  TERMINAL_GIT_OPERATION_STATES,
  GIT_OPERATION_LEGAL_TRANSITIONS,
  GitOperationInProgressError,
  IllegalGitOperationTransitionError,
} from '@asciidocollab/domain';
import type {
  GitOperationKind,
  GitOperationState,
  ConflictResolution,
  CreateGitConflictInput,
  EnqueueGitOperationInput,
  GitOperationRepository,
  GitOperationTransitionInput,
  GitOperationTransitionTarget,
  Result,
} from '@asciidocollab/domain';

/**
 * Options controlling how long a `withGuard` transaction may run before Prisma gives up waiting
 * for a pool connection (`maxWaitMs`) or aborts the transaction outright (`timeoutMs`). The
 * guarded `action` runs *inside* the transaction (see class docs), so `timeoutMs` must comfortably
 * cover the slowest short mutating op (stage/commit/discard/amend) it will ever wrap.
 */
export interface PrismaGitOperationRepositoryOptions {
  /** Max time to wait for a pooled connection before starting the guard transaction. Default 5000ms (Prisma's own default). */
  guardMaxWaitMs?: number;
  /** Max time the whole guarded transaction (check + touch + `action`) may run before Prisma aborts it. Default 30000ms. */
  guardTimeoutMs?: number;
}

/** Row shape shared by `gitOperation` delegate reads and the raw `claimNextQueued` query — identical because no `@map` renames a column. */
type GitOperationRow = {
  id: string;
  projectId: string;
  kind: GitOperationKind;
  state: GitOperationState;
  branch: string | null;
  triggeredByUserId: string;
  progress: number;
  heartbeatAt: Date | null;
  errorCode: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

type GitConflictRow = {
  id: string;
  operationId: string;
  path: string;
  isBinary: boolean;
  resolved: boolean;
  resolution: string | null;
  createdAt: Date;
};

/**
 * Private sentinel thrown from inside the `withGuard` transaction callback to unwind out of it the
 * moment an already-active `GitOperation` is found, distinguishing "the guard refused" from a
 * `action`-thrown error (which must propagate to the caller unchanged, per the port contract and
 * the in-memory fake it mirrors). Never leaves this module.
 */
class GitOperationAlreadyActiveSignal extends Error {}

/**
 * Prisma-backed implementation of the `GitOperationRepository` port: the durable work-list
 * (`enqueue`/`claimNextQueued`), the liveness/heartbeat mechanism, the single-flight guard
 * (`withGuard`), and `GitConflict` CRUD.
 *
 * ## `claimNextQueued` — the one sanctioned raw-SQL exemption
 * Claims the next unit of work with a single, atomic `SELECT … FOR UPDATE SKIP LOCKED` (folded into
 * an `UPDATE … FROM` so the claim and the RUNNING transition happen in the same statement) —
 * Architecture Constitution 2.6.0's documented raw-SQL exemption, confined to this one method. All
 * values are bound parameters (`$queryRaw` tagged-template interpolation); nothing is ever
 * string-concatenated into the SQL text.
 *
 * ## `withGuard` — defensive concurrency without the (not yet existing) partial-unique index
 * `data-model.md` calls for a partial-UNIQUE index on `GitOperation(projectId) WHERE state IN
 * (QUEUED, RUNNING, AWAITING_CONFLICT)` to make single-flight a one-line `INSERT` conflict check.
 * Prisma 7.9's schema DSL cannot express a partial unique index, so that constraint does not exist
 * in the database today (see the comment on `GitOperation` in `packages/db/prisma/schema.prisma`,
 * and the captured index SQL this adapter ships in
 * `git-operation-active-op-unique-index.sql`, alongside this file, for the future migration).
 *
 * Without that index, `withGuard` cannot rely on a DB-level uniqueness violation, and — per
 * Architecture Constitution 2.6.0 — is not permitted to reach for raw SQL either (the raw-SQL
 * exemption is scoped to `claimNextQueued` alone). So this method instead:
 *
 * 1. Runs entirely inside one `SERIALIZABLE` Prisma interactive transaction, with `action` called
 *    directly inside that transaction — deliberately, so the guard covers the whole action, not
 *    just the instant of the check (a check-then-release-then-run design would let a second `withGuard` call
 *    slip in and run concurrently with the first's `action`, which is exactly the bug this exists to
 *    prevent).
 * 2. Checks for an existing active `GitOperation` (`QUEUED`/`RUNNING`/`AWAITING_CONFLICT`) for the
 *    project — the guard also respects a long-running queued/running op, not just other `withGuard`
 *    callers.
 * 3. "Touches" the project's `GitRepository` row — an `UPDATE … SET currentBranch = currentBranch`
 *    (its own current value; a true no-op to the data) purely to force a real, DB-enforced
 *    read-write dependency between two concurrent `withGuard` transactions on the *same* project.
 *    Postgres's well-documented "first updater wins" rule for `REPEATABLE READ`/`SERIALIZABLE` means
 *    a second concurrent transaction that tries to update the same row a first transaction already
 *    committed an update to fails with `could not serialize access due to concurrent update`
 *    (Prisma surfaces this as `PrismaClientKnownRequestError` code `P2034`) — which this method
 *    treats exactly like finding an active operation: refuse with `GitOperationInProgressError`
 *    without running `action` twice. This requires no schema change and no raw SQL; it is a plain,
 *    typed `update()` call.
 *
 * This mechanism assumes the project already has a `GitRepository` row, true for every currently
 * specified `withGuard` caller (stage/commit/discard/amend all require an already-connected repo —
 * see data-model.md §8's authorization matrix). If no such row exists, the touch step is skipped
 * (nothing to lock) and only the active-operation check applies — a narrower guarantee that does not
 * matter for any current caller, documented here rather than silently assumed.
 *
 * Once the partial-unique index lands (a future migration), `withGuard` could rely on it as a
 * backstop too, but the SERIALIZABLE-touch mechanism above remains correct and sufficient on its own.
 */
export class PrismaGitOperationRepository implements GitOperationRepository {
  private readonly guardMaxWaitMs: number;
  private readonly guardTimeoutMs: number;

  /**
   * @param prisma - The Prisma client used for database operations.
   * @param options - Tuning for the `withGuard` transaction's wait/timeout budget.
   */
  constructor(
    private readonly prisma: PrismaClient,
    options: PrismaGitOperationRepositoryOptions = {},
  ) {
    this.guardMaxWaitMs = options.guardMaxWaitMs ?? 5000;
    this.guardTimeoutMs = options.guardTimeoutMs ?? 30_000;
  }

  /** Enqueues a new operation in the QUEUED state (the schema column default). */
  async enqueue(input: EnqueueGitOperationInput): Promise<GitOperation> {
    const record = await this.prisma.gitOperation.create({
      data: {
        projectId: input.projectId.value,
        kind: input.kind,
        triggeredByUserId: input.triggeredByUserId.value,
        branch: input.branch ?? null,
      },
    });
    return toDomainGitOperation(record);
  }

  /**
   * Atomically claims the oldest QUEUED operation, or — if none is queued — the oldest RUNNING
   * operation whose heartbeat is stale, via one `SELECT … FOR UPDATE SKIP LOCKED` folded into the
   * claiming `UPDATE`. See the class docs for why this is the one place raw SQL is used.
   */
  async claimNextQueued(staleHeartbeatAfterMs: number): Promise<GitOperation | null> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - staleHeartbeatAfterMs);

    const rows = await this.prisma.$queryRaw<GitOperationRow[]>`
      WITH candidate AS (
        SELECT "id"
        FROM "GitOperation"
        WHERE "state" = 'QUEUED'::"GitOperationState"
           OR (
             "state" = 'RUNNING'::"GitOperationState"
             AND ("heartbeatAt" IS NULL OR "heartbeatAt" < ${staleBefore})
           )
        ORDER BY ("state" = 'QUEUED'::"GitOperationState") DESC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "GitOperation" AS g
      SET
        "state" = 'RUNNING'::"GitOperationState",
        "heartbeatAt" = ${now},
        "startedAt" = COALESCE(g."startedAt", ${now})
      FROM candidate
      WHERE g."id" = candidate."id"
      RETURNING
        g."id", g."projectId", g."kind", g."state", g."branch", g."triggeredByUserId",
        g."progress", g."heartbeatAt", g."errorCode", g."startedAt", g."finishedAt", g."createdAt";
    `;

    const [row] = rows;
    return row ? toDomainGitOperation(row) : null;
  }

  /** Refreshes the heartbeat of a running operation. `updateMany` makes this a no-op, not a throw, when the id is unknown. */
  async heartbeat(operationId: GitOperationId): Promise<void> {
    await this.prisma.gitOperation.updateMany({
      where: { id: operationId.value },
      data: { heartbeatAt: new Date() },
    });
  }

  /**
   * Moves an operation to a new state, validating the move with a single conditional `updateMany`
   * (`WHERE id = … AND state IN (<legal source states for toState>)`) — race-safe against a
   * concurrent transition attempt on the same row without needing a transaction, the same
   * `GIT_OPERATION_LEGAL_TRANSITIONS` table the in-memory fake validates against.
   */
  async transition(
    operationId: GitOperationId,
    toState: GitOperationTransitionTarget,
    input: GitOperationTransitionInput = {},
  ): Promise<Result<GitOperation, IllegalGitOperationTransitionError>> {
    const legalFromStates = legalSourceStatesFor(toState);
    const isTerminal = TERMINAL_GIT_OPERATION_STATES.includes(toState);
    const now = new Date();

    const updated = await this.prisma.gitOperation.updateMany({
      where: { id: operationId.value, state: { in: legalFromStates } },
      data: {
        state: toState,
        errorCode: toState === 'FAILED' ? (input.errorCode ?? null) : null,
        // Only set on a terminal move; a non-terminal move (e.g. into AWAITING_CONFLICT, or back
        // to RUNNING on resolve) never touches progress/finishedAt.
        ...(isTerminal ? { progress: 100, finishedAt: now } : {}),
      },
    });

    if (updated.count === 0) {
      const existing = await this.prisma.gitOperation.findUnique({
        where: { id: operationId.value },
        select: { state: true },
      });
      return { success: false, error: new IllegalGitOperationTransitionError(existing?.state ?? null, toState) };
    }

    const record = await this.prisma.gitOperation.findUniqueOrThrow({ where: { id: operationId.value } });
    return { success: true, value: toDomainGitOperation(record) };
  }

  /**
   * Runs `action` only if the project has no active operation. See the class docs for the full
   * concurrency design (SERIALIZABLE transaction + a self-touch of the project's `GitRepository`
   * row standing in for the not-yet-existing partial-unique index).
   */
  async withGuard<T>(
    projectId: ProjectId,
    action: () => Promise<T>,
  ): Promise<Result<T, GitOperationInProgressError>> {
    try {
      const value = await this.prisma.$transaction(
        async (tx) => {
          const active = await tx.gitOperation.findFirst({
            where: { projectId: projectId.value, state: { in: [...ACTIVE_GIT_OPERATION_STATES] } },
            select: { id: true },
          });
          if (active) {
            throw new GitOperationAlreadyActiveSignal();
          }

          const repository = await tx.gitRepository.findUnique({
            where: { projectId: projectId.value },
            select: { currentBranch: true },
          });
          if (repository) {
            // Self-touch: forces a real read-write dependency a concurrent withGuard transaction on
            // the same project will conflict with (see class docs). Not a data change.
            await tx.gitRepository.update({
              where: { projectId: projectId.value },
              data: { currentBranch: repository.currentBranch },
            });
          }

          return action();
        },
        { isolationLevel: 'Serializable', maxWait: this.guardMaxWaitMs, timeout: this.guardTimeoutMs },
      );
      return { success: true, value };
    } catch (error) {
      if (error instanceof GitOperationAlreadyActiveSignal || isSerializationFailure(error)) {
        return { success: false, error: new GitOperationInProgressError() };
      }
      throw error;
    }
  }

  /** Finds the project's current active (QUEUED/RUNNING/AWAITING_CONFLICT) operation, or null. */
  async findActiveOperation(projectId: ProjectId): Promise<GitOperation | null> {
    const record = await this.prisma.gitOperation.findFirst({
      where: { projectId: projectId.value, state: { in: [...ACTIVE_GIT_OPERATION_STATES] } },
    });
    return record ? toDomainGitOperation(record) : null;
  }

  /** Reads back a single operation by id, in whatever state it currently holds, or null if none exists. */
  async findById(operationId: GitOperationId): Promise<GitOperation | null> {
    const record = await this.prisma.gitOperation.findUnique({ where: { id: operationId.value } });
    return record ? toDomainGitOperation(record) : null;
  }

  /** Records a new, unresolved conflict for an operation. */
  async createConflict(input: CreateGitConflictInput): Promise<GitConflict> {
    const record = await this.prisma.gitConflict.create({
      data: {
        operationId: input.operationId.value,
        path: input.path,
        isBinary: input.isBinary ?? false,
      },
    });
    return toDomainGitConflict(record);
  }

  /** Lists every conflict recorded for an operation, oldest first. */
  async listConflicts(operationId: GitOperationId): Promise<GitConflict[]> {
    const records = await this.prisma.gitConflict.findMany({
      where: { operationId: operationId.value },
      orderBy: { createdAt: 'asc' },
    });
    return records.map(toDomainGitConflict);
  }

  /** Reads back a single conflict by id, or null if it does not exist. */
  async getConflict(conflictId: GitConflictId): Promise<GitConflict | null> {
    const record = await this.prisma.gitConflict.findUnique({ where: { id: conflictId.value } });
    return record ? toDomainGitConflict(record) : null;
  }

  /** Removes every conflict recorded for an operation. */
  async clearConflicts(operationId: GitOperationId): Promise<void> {
    await this.prisma.gitConflict.deleteMany({ where: { operationId: operationId.value } });
  }
}

/** Every `GitOperationState` from which `GIT_OPERATION_LEGAL_TRANSITIONS` allows a legal move to `toState`. */
function legalSourceStatesFor(toState: GitOperationTransitionTarget): GitOperationState[] {
  return (Object.entries(GIT_OPERATION_LEGAL_TRANSITIONS) as [GitOperationState, GitOperationTransitionTarget[]][])
    .filter(([, targets]) => targets.includes(toState))
    .map(([fromState]) => fromState);
}

/** True when `error` is Postgres's "could not serialize access due to concurrent update" surfaced by Prisma as P2034. */
function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

function toDomainGitOperation(record: GitOperationRow): GitOperation {
  return new GitOperation(
    GitOperationId.create(record.id),
    ProjectId.create(record.projectId),
    record.kind,
    record.state,
    UserId.create(record.triggeredByUserId),
    record.branch,
    record.progress,
    record.heartbeatAt,
    record.errorCode,
    record.startedAt,
    record.finishedAt,
    record.createdAt,
  );
}

function toDomainGitConflict(record: GitConflictRow): GitConflict {
  return new GitConflict(
    GitConflictId.create(record.id),
    GitOperationId.create(record.operationId),
    record.path,
    record.isBinary,
    record.resolved,
    toConflictResolution(record.resolution),
    record.createdAt,
  );
}

/**
 * `GitConflict.resolution` is a plain `String?` column (data-model.md notes it as `'ours' |
 * 'theirs' | 'merged'` by convention, not a DB enum), so Prisma's generated type is `string | null`.
 * This validates it into the domain's `ConflictResolution` union rather than asserting it — an
 * unrecognized value (there should never be one; nothing outside `ResolveConflicts`, not part of
 * this task, ever writes this column) reads back as unresolved rather than propagating a bad cast.
 */
function toConflictResolution(value: string | null): ConflictResolution | null {
  return value === 'ours' || value === 'theirs' || value === 'merged' ? value : null;
}
