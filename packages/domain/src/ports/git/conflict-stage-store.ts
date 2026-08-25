import { GitOperationId } from '../../value-objects/ids/git-operation-id';
import { Result } from '../../types/result';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';

/**
 * The three merge-base stages of one conflicting file, as captured (by the git adapter, via
 * `git show :1:/:2:/:3:<path>`) BEFORE the conflicted merge/checkout is aborted.
 */
export interface ConflictStages {
  /** `git show :1:<path>` bytes, or null when the file had no merge base (an add/add conflict). */
  readonly base: Buffer | null;
  /** `git show :2:<path>` bytes — this branch's ("ours") side. */
  readonly ours: Buffer;
  /** `git show :3:<path>` bytes — the incoming ("theirs") side. */
  readonly theirs: Buffer;
  /** Whether the file is binary (no 3-way text view, and no `merged` resolution, for this file). */
  readonly isBinary: boolean;
}

/** The pre-operation snapshot a later undo restores a project to. */
export interface ConflictUndoSnapshot {
  /** The local `HEAD` captured before the pull/switch began — before even its flush commit. */
  readonly preOpHead: string;
  /** The branch the operation ran on. */
  readonly branch: string;
}

/**
 * Off-working-tree blob store for a conflicted (or freshly-pulled/switched) operation's captured
 * three-way stages, per-file merged resolutions, and pre-operation undo snapshot.
 *
 * Written by the git adapter at conflict-detection time (and, for the snapshot, on every clean
 * pull/switch too) and by a later conflict-resolution use case; read on demand for the merge view
 * and by a later complete/undo use case. Deliberately a separate port from `GitCommandRunner`: its
 * reads/writes are pure filesystem blob I/O with no `git` involvement on the read path — see the
 * design doc this task implements for the full rationale.
 *
 * The concrete filesystem adapter (`apps/git-worker`) MUST be rooted OUTSIDE every project's
 * working tree (a sibling of the per-project working-tree roots) — the per-job
 * `ensureCleanWorkingTree` step runs `git clean -fdx` inside the working tree and would otherwise
 * delete any untracked directory living inside it, destroying the very blobs this store exists to
 * preserve across the awaiting-conflict wait.
 */
export interface ConflictStageStore {
  /**
   * Records the pre-operation `HEAD`/branch so a later undo can restore it. Overwrites any prior
   * snapshot recorded for this operation.
   *
   * @param operationId - The pull/switch operation this snapshot belongs to.
   * @param snapshot - The pre-operation head commit and branch.
   * @returns Success once recorded; a `GitCommandFailedError` if the write fails.
   */
  writeSnapshot(
    operationId: GitOperationId,
    snapshot: ConflictUndoSnapshot,
  ): Promise<Result<void, GitCommandFailedError>>;

  /**
   * Materializes one conflicting file's captured three-way stages.
   *
   * @param operationId - The conflicted operation this file belongs to.
   * @param path - The conflicting file's workspace-relative path.
   * @param stages - The captured base/ours/theirs bytes and binary classification.
   * @returns Success once recorded; a `GitCommandFailedError` if the write fails.
   */
  writeStages(
    operationId: GitOperationId,
    path: string,
    stages: ConflictStages,
  ): Promise<Result<void, GitCommandFailedError>>;

  /**
   * Records the user-edited merged bytes for a `merged` resolution of one conflicting file.
   *
   * @param operationId - The conflicted operation this file belongs to.
   * @param path - The conflicting file's workspace-relative path.
   * @param content - The merged bytes to record.
   * @returns Success once recorded; a `GitCommandFailedError` if the write fails.
   */
  writeMerged(operationId: GitOperationId, path: string, content: Buffer): Promise<Result<void, GitCommandFailedError>>;

  /**
   * Reads back one file's captured stages, for the merge view.
   *
   * @param operationId - The conflicted operation this file belongs to.
   * @param path - The conflicting file's workspace-relative path.
   * @returns The captured stages; null when nothing was captured for that path; a
   *   `GitCommandFailedError` if the read fails.
   */
  readStages(
    operationId: GitOperationId,
    path: string,
  ): Promise<Result<ConflictStages | null, GitCommandFailedError>>;

  /**
   * Reads the merged bytes recorded for a `merged` resolution of one file.
   *
   * @param operationId - The conflicted operation this file belongs to.
   * @param path - The conflicting file's workspace-relative path.
   * @returns The recorded bytes; null when none were written; a `GitCommandFailedError` if the
   *   read fails.
   */
  readMerged(operationId: GitOperationId, path: string): Promise<Result<Buffer | null, GitCommandFailedError>>;

  /**
   * Reads the undo snapshot recorded for an operation.
   *
   * @param operationId - The pull/switch operation to read the snapshot for.
   * @returns The recorded snapshot; null when the operation has none (already undone, cleared, or
   *   swept); a `GitCommandFailedError` if the read fails.
   */
  readSnapshot(operationId: GitOperationId): Promise<Result<ConflictUndoSnapshot | null, GitCommandFailedError>>;

  /**
   * Removes everything recorded for an operation — its snapshot and every captured/merged file.
   * Called once a conflicted operation completes or is undone.
   *
   * @param operationId - The operation whose recorded state to remove.
   * @returns Success once removed (or if there was nothing to remove); a `GitCommandFailedError`
   *   if the removal fails.
   */
  clear(operationId: GitOperationId): Promise<Result<void, GitCommandFailedError>>;
}
