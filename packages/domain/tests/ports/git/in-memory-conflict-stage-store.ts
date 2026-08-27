import { GitOperationId } from '../../../src/value-objects/ids/git-operation-id';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import {
  ConflictStageStore,
  ConflictStages,
  ConflictUndoSnapshot,
} from '../../../src/ports/git/conflict-stage-store';
import { Result } from '../../../src/types/result';

/** One recorded `writeStages` call, in call order — for asserting exactly what was captured. */
export interface RecordedWriteStages {
  readonly operationId: GitOperationId;
  readonly path: string;
  readonly stages: ConflictStages;
}

/** One recorded `writeMerged` call, in call order. */
export interface RecordedWriteMerged {
  readonly operationId: GitOperationId;
  readonly path: string;
  readonly content: Buffer;
}

/** One recorded `writeSnapshot` call, in call order. */
export interface RecordedWriteSnapshot {
  readonly operationId: GitOperationId;
  readonly snapshot: ConflictUndoSnapshot;
}

/**
 * In-memory `Map`-backed fake of `ConflictStageStore`, mirroring `InMemoryGitCommandRunner`'s
 * seed/record convention. A write both records the call (for assertions) and updates the readable
 * state a later `read*`/`clear` call observes — this port is a pure key/value store, so (unlike
 * the multi-command `GitCommandRunner` fake) there is a single source of truth to keep in sync.
 */
export class InMemoryConflictStageStore implements ConflictStageStore {
  private readonly snapshots = new Map<string, ConflictUndoSnapshot>();
  private readonly stages = new Map<string, ConflictStages>();
  private readonly merged = new Map<string, Buffer>();

  /** Every call made to `writeSnapshot`, in call order. */
  readonly recordedSnapshots: RecordedWriteSnapshot[] = [];
  /** Every call made to `writeStages`, in call order. */
  readonly recordedStages: RecordedWriteStages[] = [];
  /** Every call made to `writeMerged`, in call order. */
  readonly recordedMerged: RecordedWriteMerged[] = [];
  /** Every operation id `clear` was called with, in call order. */
  readonly clearedOperationIds: GitOperationId[] = [];

  private stagesKey(operationId: GitOperationId, path: string): string {
    return `${operationId.value}:${path}`;
  }

  /** Pre-seeds the snapshot `readSnapshot` returns for an operation, without recording a call. */
  seedSnapshot(operationId: GitOperationId, snapshot: ConflictUndoSnapshot): void {
    this.snapshots.set(operationId.value, snapshot);
  }

  /** Pre-seeds the stages `readStages` returns for one file, without recording a call. */
  seedStages(operationId: GitOperationId, path: string, stages: ConflictStages): void {
    this.stages.set(this.stagesKey(operationId, path), stages);
  }

  /** Pre-seeds the bytes `readMerged` returns for one file, without recording a call. */
  seedMerged(operationId: GitOperationId, path: string, content: Buffer): void {
    this.merged.set(this.stagesKey(operationId, path), content);
  }

  async writeSnapshot(
    operationId: GitOperationId,
    snapshot: ConflictUndoSnapshot,
  ): Promise<Result<void, GitCommandFailedError>> {
    this.recordedSnapshots.push({ operationId, snapshot });
    this.snapshots.set(operationId.value, snapshot);
    return { success: true, value: undefined };
  }

  async writeStages(
    operationId: GitOperationId,
    path: string,
    stages: ConflictStages,
  ): Promise<Result<void, GitCommandFailedError>> {
    this.recordedStages.push({ operationId, path, stages });
    this.stages.set(this.stagesKey(operationId, path), stages);
    return { success: true, value: undefined };
  }

  async writeMerged(
    operationId: GitOperationId,
    path: string,
    content: Buffer,
  ): Promise<Result<void, GitCommandFailedError>> {
    this.recordedMerged.push({ operationId, path, content });
    this.merged.set(this.stagesKey(operationId, path), content);
    return { success: true, value: undefined };
  }

  async readStages(
    operationId: GitOperationId,
    path: string,
  ): Promise<Result<ConflictStages | null, GitCommandFailedError>> {
    return { success: true, value: this.stages.get(this.stagesKey(operationId, path)) ?? null };
  }

  async readMerged(operationId: GitOperationId, path: string): Promise<Result<Buffer | null, GitCommandFailedError>> {
    return { success: true, value: this.merged.get(this.stagesKey(operationId, path)) ?? null };
  }

  async readSnapshot(operationId: GitOperationId): Promise<Result<ConflictUndoSnapshot | null, GitCommandFailedError>> {
    return { success: true, value: this.snapshots.get(operationId.value) ?? null };
  }

  async clear(operationId: GitOperationId): Promise<Result<void, GitCommandFailedError>> {
    this.clearedOperationIds.push(operationId);
    this.snapshots.delete(operationId.value);
    const prefix = `${operationId.value}:`;
    for (const key of this.stages.keys()) {
      if (key.startsWith(prefix)) this.stages.delete(key);
    }
    for (const key of this.merged.keys()) {
      if (key.startsWith(prefix)) this.merged.delete(key);
    }
    return { success: true, value: undefined };
  }
}
