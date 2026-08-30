import { GitOperationId, type ConflictStageStore } from '@asciidocollab/domain';
import { runGitCommand } from './run-git-command.js';

/**
 * The private ref namespace under which each content op pins its never-lose-work backup commit, one
 * ref per operation (`refs/adc/undo/<operationId>`). The single source of truth for everything that
 * writes, lists, or prunes those refs: `MergeConflictOps` (which pins one per pull/switch and
 * inline-prunes the rest) and the belt-and-braces `UndoReferenceSweeper` (which reclaims stragglers
 * a crash left behind). Both keep the same "exactly one retained undo point per project" invariant.
 */
export const BACKUP_REF_PREFIX = 'refs/adc/undo/';

/** Which of the two independent best-effort steps a {@link deleteBackupReferenceAndClearSnapshot} failure came from. */
export type BackupReferenceCleanupStage = 'delete-ref' | 'clear-snapshot';

/**
 * Lists the operation id of every backup ref present in `cwd` — the single listing both the inline
 * prune ({@link MergeConflictOps.pruneOtherBackupRefs}) and the belt-and-braces
 * `UndoReferenceSweeper` share, so the `for-each-ref` scan and its parsing live here in the
 * namespace's single source of truth rather than being duplicated. Reads `refs/adc/undo/*` via `git
 * for-each-ref --format=%(refname)`, keeps only names under {@link BACKUP_REF_PREFIX}, and returns
 * each ref's suffix (the operation id). A malformed empty suffix is filtered out.
 *
 * A failure (the working tree is not materialized on this worker, or is not a git repo) yields an
 * empty list — nothing to prune or sweep — so every caller can treat "no refs" and "could not list"
 * identically, which is the correct best-effort posture for both.
 *
 * @param cwd - The project's working tree whose backup refs to list.
 * @returns Each backup ref's operation id value; empty when there are none or the listing failed.
 */
export async function listBackupReferenceOperationIds(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await runGitCommand(cwd, {
      command: 'for-each-ref',
      flags: ['--format=%(refname)'],
      positionals: [BACKUP_REF_PREFIX],
    });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith(BACKUP_REF_PREFIX))
      .map((referenceName) => referenceName.slice(BACKUP_REF_PREFIX.length))
      .filter((operationIdValue) => operationIdValue.length > 0);
  } catch {
    return [];
  }
}

/**
 * Removes one stale undo point: deletes its backup ref (`refs/adc/undo/<operationIdValue>`) and
 * clears its off-tree snapshot, as two INDEPENDENT best-effort steps. Each runs in its own `try`,
 * so if the ref is already gone the `update-ref -d` throw never skips the snapshot clear (which
 * would otherwise leak the snapshot in the shared conflict-stage root), and a clear failure never
 * blocks the ref delete. Neither failure propagates — the shared retention behavior every caller
 * relies on is swallow-and-continue, so a single stale entry's failure can never fail the pull /
 * switch (or the sweep) that triggered the cleanup.
 *
 * @param cwd - The project's working tree the backup ref lives in.
 * @param operationIdValue - The ref suffix, which IS an operation id; a suffix that does not parse
 *   as one leaves nothing to clear (the ref delete still runs).
 * @param conflictStageStore - The store whose snapshot to clear, or undefined to skip the clear.
 * @param onError - Called with each caught failure and which step it came from, so a caller can log
 *   it (the sweeper) or swallow it (the inline prune); the step stays best-effort either way.
 */
export async function deleteBackupReferenceAndClearSnapshot(
  cwd: string,
  operationIdValue: string,
  conflictStageStore: ConflictStageStore | undefined,
  onError?: (error: unknown, stage: BackupReferenceCleanupStage) => void,
): Promise<void> {
  try {
    await runGitCommand(cwd, {
      command: 'update-ref',
      flags: ['-d'],
      positionals: [`${BACKUP_REF_PREFIX}${operationIdValue}`],
    });
  } catch (error) {
    onError?.(error, 'delete-ref');
  }

  if (!conflictStageStore) return;

  // The ref suffix IS an operation id; construct the value object to clear its snapshot. A suffix
  // that somehow does not parse as one leaves nothing to clear.
  let operationId: GitOperationId | null;
  try {
    operationId = GitOperationId.create(operationIdValue);
  } catch {
    operationId = null;
  }
  if (operationId) {
    await conflictStageStore.clear(operationId).catch((error: unknown) => {
      onError?.(error, 'clear-snapshot');
    });
  }
}
