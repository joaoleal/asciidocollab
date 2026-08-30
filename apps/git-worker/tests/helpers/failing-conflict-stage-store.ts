import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GitCommandFailedError,
  type ConflictStageStore,
  type ConflictStages,
  type ConflictUndoSnapshot,
  type GitOperationId,
  type Result,
} from '@asciidocollab/domain';
import { FilesystemConflictStageStore } from '../../src/git/filesystem-conflict-stage-store.js';

/** The one store operation a {@link FailingConflictStageStore} refuses to perform. */
export type FailingStoreOperation = 'writeSnapshot' | 'writeStages' | 'readSnapshot';

/**
 * Test-only `ConflictStageStore` that behaves exactly like the real filesystem store except for the
 * single operation it is told to fail — the seam for exercising what `merge`/`checkout`/
 * `restoreToSnapshot` do when the off-working-tree store cannot record (or read back) an operation,
 * a failure no amount of real-git setup can provoke.
 */
export class FailingConflictStageStore implements ConflictStageStore {
  /** How many times the designated `failing` operation has been invoked so far. */
  private occurrences = 0;

  /**
   * @param delegate - The real store every non-failing call is forwarded to.
   * @param failing - The one operation this store refuses to perform.
   * @param failFromOccurrence - Which invocation of `failing` starts refusing (1-based). Defaults to
   *   1, so the very first call already fails — what a test that does not care about ordering wants.
   *   A higher value lets a test single out a LATER call of the same operation: `merge`/`checkout`
   *   call `writeSnapshot` twice (the pre-mutation base snapshot, then the upgrade naming the pinned
   *   `wipCommit`), and only the second one exercises the post-pin failure path.
   */
  constructor(
    private readonly delegate: FilesystemConflictStageStore,
    private readonly failing: FailingStoreOperation,
    private readonly failFromOccurrence = 1,
  ) {}

  /**
   * Builds a store whose `failing` operation fails, delegating everything else to a real store
   * rooted at a fresh temp directory (never inside a project working tree).
   *
   * @param failing - The operation to fail.
   * @param failFromOccurrence - Which invocation of `failing` starts refusing (see the constructor).
   * @returns The store.
   */
  static async create(
    failing: FailingStoreOperation,
    failFromOccurrence = 1,
  ): Promise<FailingConflictStageStore> {
    const root = await mkdtemp(path.join(tmpdir(), 'git-worker-test-failing-conflict-store-'));
    return new FailingConflictStageStore(new FilesystemConflictStageStore(root), failing, failFromOccurrence);
  }

  /**
   * Whether THIS call should be refused: only the designated `failing` operation is counted, and it
   * starts refusing once its invocation count reaches `failFromOccurrence`.
   *
   * @param operation - The operation being invoked.
   * @returns True when the call must fail instead of reaching the delegate.
   */
  private refuses(operation: FailingStoreOperation): boolean {
    if (this.failing !== operation) return false;
    this.occurrences += 1;
    return this.occurrences >= this.failFromOccurrence;
  }

  private unavailable(): { success: false; error: GitCommandFailedError } {
    return { success: false, error: new GitCommandFailedError('The conflict stage store is unavailable.') };
  }

  async writeSnapshot(
    operationId: GitOperationId,
    snapshot: ConflictUndoSnapshot,
  ): Promise<Result<void, GitCommandFailedError>> {
    if (this.refuses('writeSnapshot')) return this.unavailable();
    return this.delegate.writeSnapshot(operationId, snapshot);
  }

  async writeStages(
    operationId: GitOperationId,
    filePath: string,
    stages: ConflictStages,
  ): Promise<Result<void, GitCommandFailedError>> {
    if (this.refuses('writeStages')) return this.unavailable();
    return this.delegate.writeStages(operationId, filePath, stages);
  }

  async writeMerged(
    operationId: GitOperationId,
    filePath: string,
    content: Buffer,
  ): Promise<Result<void, GitCommandFailedError>> {
    return this.delegate.writeMerged(operationId, filePath, content);
  }

  async readStages(
    operationId: GitOperationId,
    filePath: string,
  ): Promise<Result<ConflictStages | null, GitCommandFailedError>> {
    return this.delegate.readStages(operationId, filePath);
  }

  async readMerged(
    operationId: GitOperationId,
    filePath: string,
  ): Promise<Result<Buffer | null, GitCommandFailedError>> {
    return this.delegate.readMerged(operationId, filePath);
  }

  async readSnapshot(
    operationId: GitOperationId,
  ): Promise<Result<ConflictUndoSnapshot | null, GitCommandFailedError>> {
    if (this.refuses('readSnapshot')) return this.unavailable();
    return this.delegate.readSnapshot(operationId);
  }

  async clear(operationId: GitOperationId): Promise<Result<void, GitCommandFailedError>> {
    return this.delegate.clear(operationId);
  }
}
