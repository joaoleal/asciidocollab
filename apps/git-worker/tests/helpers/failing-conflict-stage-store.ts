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
  constructor(
    private readonly delegate: FilesystemConflictStageStore,
    private readonly failing: FailingStoreOperation,
  ) {}

  /**
   * Builds a store whose `failing` operation fails, delegating everything else to a real store
   * rooted at a fresh temp directory (never inside a project working tree).
   *
   * @param failing - The operation to fail.
   * @returns The store.
   */
  static async create(failing: FailingStoreOperation): Promise<FailingConflictStageStore> {
    const root = await mkdtemp(path.join(tmpdir(), 'git-worker-test-failing-conflict-store-'));
    return new FailingConflictStageStore(new FilesystemConflictStageStore(root), failing);
  }

  private unavailable(): { success: false; error: GitCommandFailedError } {
    return { success: false, error: new GitCommandFailedError('The conflict stage store is unavailable.') };
  }

  async writeSnapshot(
    operationId: GitOperationId,
    snapshot: ConflictUndoSnapshot,
  ): Promise<Result<void, GitCommandFailedError>> {
    if (this.failing === 'writeSnapshot') return this.unavailable();
    return this.delegate.writeSnapshot(operationId, snapshot);
  }

  async writeStages(
    operationId: GitOperationId,
    filePath: string,
    stages: ConflictStages,
  ): Promise<Result<void, GitCommandFailedError>> {
    if (this.failing === 'writeStages') return this.unavailable();
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
    if (this.failing === 'readSnapshot') return this.unavailable();
    return this.delegate.readSnapshot(operationId);
  }

  async clear(operationId: GitOperationId): Promise<Result<void, GitCommandFailedError>> {
    return this.delegate.clear(operationId);
  }
}
