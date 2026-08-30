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
  GitConflictNotFoundError,
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
  GitDriftSummary,
  GitDriftAnomaly,
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
  driftSummary: Prisma.JsonValue | null;
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
 * ## `withGuard` — a hybrid guard: index-backed for async queued ops, SERIALIZABLE-touch for everyone else
 * `data-model.md` calls for a partial-UNIQUE index on `GitOperation(projectId) WHERE state IN
 * (QUEUED, RUNNING, AWAITING_CONFLICT)` to make single-flight a one-line `INSERT` conflict check.
 * That index now exists (`GitOperation_one_active_per_project`, added by the
 * `20260828120000_git_operation_active_op_unique_index` migration; see the comment on `GitOperation`
 * in `packages/db/prisma/schema.prisma` and the captured statement this adapter also ships at
 * `git-operation-active-op-unique-index.sql`, alongside this file). `withGuard` uses it for exactly
 * one of its two call shapes:
 *
 * **`excludeOperationId` given (every async, queue-claimed caller — currently only
 * `InitializeRepositoryUseCase`).** The caller already holds the project's one-and-only active
 * `GitOperation` row (claimed into `RUNNING` by `claimNextQueued` before `withGuard` is ever
 * called), and the partial-unique index guarantees no *other* active row can exist for the project
 * alongside it. Single-flight is therefore already established at the DB level before `withGuard`
 * runs at all — so this path skips the SERIALIZABLE transaction and the `GitRepository` self-touch
 * entirely and simply runs `action` outside of any transaction, returning
 * `{ success: true, value: await action() }` (or letting `action`'s own throw propagate, exactly as
 * the transactional path does). This is deliberate, not just an optimization: the prior version ran
 * `action` *inside* the guard transaction even here, and `InitializeRepositoryUseCase`'s `action`
 * both takes ~1-2s for the initial git publish over the network AND writes the very `GitRepository`
 * row the transaction had just locked with its self-touch — a lock the action's own write then
 * waited on for the rest of the transaction's 30s timeout, deadlocking itself. Running outside a
 * transaction removes both the lock and the long-held connection.
 *
 * **`excludeOperationId` omitted (every synchronous caller — stage/commit/discard/amend/connect/
 * disconnect/undo-pull).** None of these callers hold a `GitOperation` row of their own — the index
 * has nothing to key single-flight off before they exist — so this path is unchanged from before the
 * index existed:
 *
 * 1. Runs entirely inside one `SERIALIZABLE` Prisma interactive transaction, with `action` called
 *    directly inside that transaction — deliberately, so the guard covers the whole action, not
 *    just the instant of the check (a check-then-release-then-run design would let a second `withGuard` call
 *    slip in and run concurrently with the first's `action`, which is exactly the bug this exists to
 *    prevent). Every current synchronous caller's `action` is a short, local mutation — never a
 *    slow network call — so holding the transaction open around it is safe.
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
 *    typed `update()` call. The index also backstops this path: a stray `gitOperation.create` that
 *    bypasses `withGuard` altogether (a bug, not a supported path) would still fail at the DB with a
 *    unique-violation rather than silently creating a second active operation.
 *
 * This mechanism assumes the project already has a `GitRepository` row, true for every synchronous
 * `withGuard` caller (stage/commit/discard/amend all require an already-connected repo — see
 * data-model.md §8's authorization matrix). If no such row exists, the touch step is skipped
 * (nothing to lock) and only the active-operation check applies — a narrower guarantee that does not
 * matter for any current caller, documented here rather than silently assumed.
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

  /**
   * Enqueues a new operation in the QUEUED state (the schema column default). A concurrent enqueue
   * for a project that already has an active operation violates the `GitOperation_one_active_per_project`
   * partial-unique index and surfaces from Prisma as a P2002 unique-constraint violation; this maps
   * that specific violation to the same `GitOperationInProgressError` `withGuard` reports for an
   * in-progress operation, rather than letting the raw Prisma error escape.
   */
  async enqueue(input: EnqueueGitOperationInput): Promise<GitOperation> {
    try {
      const record = await this.prisma.gitOperation.create({
        data: {
          projectId: input.projectId.value,
          kind: input.kind,
          triggeredByUserId: input.triggeredByUserId.value,
          branch: input.branch ?? null,
        },
      });
      return toDomainGitOperation(record);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new GitOperationInProgressError();
      }
      throw error;
    }
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
        g."progress", g."heartbeatAt", g."errorCode", g."driftSummary", g."startedAt", g."finishedAt", g."createdAt";
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
        // Resuming into RUNNING (e.g. AWAITING_CONFLICT → RUNNING when a conflict is resolved) must
        // refresh liveness: the operation was last beaten while first claimed and, after minutes in
        // AWAITING_CONFLICT, that heartbeat is stale — `claimNextQueued` reclaims stale RUNNING rows,
        // so without this a second worker could re-claim and double-execute the operation.
        ...(toState === 'RUNNING' ? { heartbeatAt: now } : {}),
        errorCode: toState === 'FAILED' ? (input.errorCode ?? null) : null,
        // Recorded only on a terminal SUCCEEDED move carrying a summary (a pull whose reconcile hit
        // drift); every other move clears it back to null so a row's summary reflects its final run.
        driftSummary:
          toState === 'SUCCEEDED' && input.driftSummary
            ? serializeDriftSummary(input.driftSummary)
            : Prisma.DbNull,
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
   * hybrid concurrency design: an async, queue-claimed caller (`excludeOperationId` given) already
   * holds the project's one active `GitOperation` row, so the partial-unique index alone guarantees
   * single-flight and `action` runs outside any transaction; every other (synchronous) caller keeps
   * the SERIALIZABLE transaction with a self-touch of the project's `GitRepository` row.
   */
  async withGuard<T>(
    projectId: ProjectId,
    action: () => Promise<T>,
    excludeOperationId?: GitOperationId,
  ): Promise<Result<T, GitOperationInProgressError>> {
    if (excludeOperationId) {
      // The caller already holds this project's one-and-only active operation row (claimed into
      // RUNNING by claimNextQueued before withGuard is ever called), and the
      // GitOperation_one_active_per_project partial-unique index guarantees no other active row can
      // exist alongside it — single-flight is already established at the DB level. Running `action`
      // outside a transaction here (rather than inside a SERIALIZABLE self-touch, as the synchronous
      // path below does) is what avoids the self-deadlock a long-running action that also writes the
      // project's GitRepository row would otherwise hit against its own guard's lock.
      return { success: true, value: await action() };
    }

    try {
      const value = await this.prisma.$transaction(
        async (tx) => {
          const active = await tx.gitOperation.findFirst({
            where: {
              projectId: projectId.value,
              state: { in: [...ACTIVE_GIT_OPERATION_STATES] },
            },
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

  /** Reads back the most recently created operation of `kind` for a project, or null. */
  async findMostRecentByKind(projectId: ProjectId, kind: GitOperationKind): Promise<GitOperation | null> {
    const record = await this.prisma.gitOperation.findFirst({
      where: { projectId: projectId.value, kind },
      orderBy: RECENT_FIRST_ORDER,
    });
    return record ? toDomainGitOperation(record) : null;
  }

  /** Reads back the most recently created operation whose kind is any of `kinds` for a project, or null. */
  async findMostRecentByKinds(
    projectId: ProjectId,
    kinds: readonly GitOperationKind[],
  ): Promise<GitOperation | null> {
    const record = await this.prisma.gitOperation.findFirst({
      where: { projectId: projectId.value, kind: { in: [...kinds] } },
      orderBy: RECENT_FIRST_ORDER,
    });
    return record ? toDomainGitOperation(record) : null;
  }

  /** Reads back a project's most-recent operations whose kind is any of `kinds`, newest first, capped at `limit`. */
  async findRecentByKinds(
    projectId: ProjectId,
    kinds: readonly GitOperationKind[],
    limit: number,
  ): Promise<GitOperation[]> {
    const records = await this.prisma.gitOperation.findMany({
      where: { projectId: projectId.value, kind: { in: [...kinds] } },
      orderBy: RECENT_FIRST_ORDER,
      take: limit,
    });
    return records.map(toDomainGitOperation);
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

  /**
   * Sets `resolved = true` and `resolution` on the conflict recorded for `(operationId, path)`
   * using the existing `resolved`/`resolution` columns — no schema change. There is no unique
   * constraint on `(operationId, path)`, so this uses a conditional `updateMany` (race-safe
   * against a concurrent resolve of the same path — the second call still finds and updates the
   * now-resolved row, satisfying this method's documented idempotence) followed by a read-back.
   */
  async resolveConflict(
    operationId: GitOperationId,
    path: string,
    resolution: ConflictResolution,
  ): Promise<Result<GitConflict, GitConflictNotFoundError>> {
    const updated = await this.prisma.gitConflict.updateMany({
      where: { operationId: operationId.value, path },
      data: { resolved: true, resolution },
    });
    if (updated.count === 0) {
      return { success: false, error: new GitConflictNotFoundError(path) };
    }

    const record = await this.prisma.gitConflict.findFirstOrThrow({
      where: { operationId: operationId.value, path },
    });
    return { success: true, value: toDomainGitConflict(record) };
  }
}

/** Every `GitOperationState`, active and terminal — the full domain of `GIT_OPERATION_LEGAL_TRANSITIONS`'s keys. */
const ALL_GIT_OPERATION_STATES: readonly GitOperationState[] = [
  ...ACTIVE_GIT_OPERATION_STATES,
  ...TERMINAL_GIT_OPERATION_STATES,
];

/**
 * The newest-first ordering every "most recent" read (`findMostRecentByKind`/`findMostRecentByKinds`/
 * `findRecentByKinds`) uses. `createdAt desc` alone leaves same-millisecond ties resolved by whatever
 * order Postgres happens to return, which makes the undo keep-selection (whichever op the sweeper /
 * undo picks as "the most recent") NONDETERMINISTIC across otherwise-identical rows. `id desc` is a
 * STABLE secondary sort that fixes one winner per tie, so production keep-selection is deterministic
 * and matches the in-memory fakes' own deterministic newest-first contract (they break a same-time
 * tie by `id` descending too, NOT by insertion order — the same `createdAt desc, id desc` contract
 * both sides now implement). `id` is the row's UUID primary key — always present, always unique.
 */
const RECENT_FIRST_ORDER: Prisma.GitOperationOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];

/** Every `GitOperationState` from which `GIT_OPERATION_LEGAL_TRANSITIONS` allows a legal move to `toState`. */
function legalSourceStatesFor(toState: GitOperationTransitionTarget): GitOperationState[] {
  return ALL_GIT_OPERATION_STATES.filter((fromState) => GIT_OPERATION_LEGAL_TRANSITIONS[fromState].includes(toState));
}

/** True when `error` is Postgres's "could not serialize access due to concurrent update" surfaced by Prisma as P2034. */
function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

/** True when `error` is a Postgres unique-constraint violation surfaced by Prisma as P2002 — what a concurrent `enqueue` racing the `GitOperation_one_active_per_project` partial-unique index fails with. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * The on-disk envelope for a persisted drift summary. The `version` discriminator is the single
 * lever for evolving this JSON shape: {@link parseDriftSummary} accepts only versions it understands
 * and falls back to `null` for anything else, so an old row written under a prior shape degrades to
 * "no summary" rather than crashing a read. Bump the version and teach the parser a new branch to
 * change the shape; no data migration of the `Json?` column is required.
 */
const DRIFT_SUMMARY_VERSION = 1;

/** Stamps a domain {@link GitDriftSummary} into the versioned JSON envelope stored on the row. */
function serializeDriftSummary(summary: GitDriftSummary): Prisma.InputJsonValue {
  return {
    version: DRIFT_SUMMARY_VERSION,
    total: summary.total,
    droppedCount: summary.droppedCount,
    anomalies: summary.anomalies.map((anomaly) => ({
      path: anomaly.path,
      kind: anomaly.kind,
      applied: anomaly.applied,
    })),
  };
}

/**
 * Tolerantly parses the stored JSON back into a {@link GitDriftSummary}. Returns `null` for a null
 * column, an unrecognized `version`, or any structural mismatch — never throws — so a shape change
 * (or a hand-edited row) can only ever hide the summary, not break the operation read.
 */
function parseDriftSummary(value: Prisma.JsonValue | null): GitDriftSummary | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const total = value.total;
  const droppedCount = value.droppedCount;
  if (value.version !== DRIFT_SUMMARY_VERSION) return null;
  if (typeof total !== 'number' || typeof droppedCount !== 'number') return null;
  const rawAnomalies = value.anomalies;
  if (!Array.isArray(rawAnomalies)) return null;

  const anomalies: GitDriftAnomaly[] = [];
  for (const entry of rawAnomalies) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const path = entry.path;
    const kind = entry.kind;
    const applied = entry.applied;
    if (typeof path !== 'string' || typeof kind !== 'string' || typeof applied !== 'boolean') return null;
    anomalies.push({ path, kind, applied });
  }

  return { total, droppedCount, anomalies };
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
    parseDriftSummary(record.driftSummary),
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
