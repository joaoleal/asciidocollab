import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GitCommandFailedError,
  type ConflictStageStore,
  type GitCheckoutInput,
  type GitCheckoutOutcome,
  type GitMergeConflictPath,
  type GitMergeFileChange,
  type GitMergeInput,
  type GitMergeOutcome,
  type GitOperationId,
  type GitResolveMergeInput,
  type GitResolveMergeOutcome,
  type GitRestoreOutcome,
  type GitRestoreToSnapshotInput,
  type ProjectId,
  type Result,
} from '@asciidocollab/domain';
import { BACKUP_REF_PREFIX, deleteBackupReferenceAndClearSnapshot, listBackupReferenceOperationIds } from './backup-references.js';
import { SERVICE_COMMIT_IDENTITY, readRevParseAnswer, staysInsideWorkingTree } from './git-command-helpers.js';
import { guessMimeType } from './guess-mime-type.js';
import { GitProcessError, runGitCommand, runGitCommandForBytes } from './run-git-command.js';
import { ensureCleanWorkingTree, resolveWorkingTreePath } from './working-tree.js';

/**
 * The commit message recorded when {@link MergeConflictOps.merge} snapshots the live local edits
 * into a commit before running the three-way merge.
 */
const FLUSH_COMMIT_MESSAGE = 'Flush live edits before pull';

/**
 * Reports whether `workingDirectory`'s index holds any staged change (`git diff --cached --quiet`
 * exits 1 when it does, 0 when it does not), used by {@link MergeConflictOps.merge} to decide
 * whether the pre-merge flush actually produced anything worth committing. Any exit code other than
 * the expected 0/1 is a real failure and is rethrown, never silently read as "nothing staged".
 *
 * @param workingDirectory - The working tree whose index to inspect.
 * @returns True when there are staged changes, false when the index matches `HEAD`.
 */
async function hasStagedChanges(workingDirectory: string): Promise<boolean> {
  try {
    await runGitCommand(workingDirectory, { command: 'diff', flags: ['--cached', '--quiet'] });
    return false;
  } catch (error) {
    if (error instanceof GitProcessError && error.exitCode === 1) return true;
    throw error;
  }
}

/**
 * Reads the set of paths git reports as binary between the two sides of a merge in progress, by
 * scanning `git diff --numstat -z HEAD MERGE_HEAD` output for the rows git marks binary (both its
 * added and deleted counts rendered as a dash rather than a number). Used only to classify the
 * {@link GitMergeConflictPath.isBinary} flag on conflicted files.
 *
 * The comparison is deliberately the two-tree `HEAD` (ours) vs `theirsReference` (theirs) diff, NOT a
 * plain `git diff` of the conflicted working tree: during a conflict, `git diff`'s combined output
 * reports a binary file as `0\t0` rather than `-\t-`, so it cannot distinguish binary from text —
 * whereas an ordinary two-tree diff reliably emits `-\t-` for a binary blob. Both refs exist for
 * the whole conflicted state, before the conflict is cleaned up. Extra (non-conflicted) paths in the
 * result are harmless: the caller only looks up the paths it already knows are conflicted.
 *
 * `theirsReference` is the incoming side of the conflict: `MERGE_HEAD` for a three-way merge conflict, or
 * the stash commit (`stash@{0}`) for a branch-switch conflict where re-applying the shelved live
 * edits onto the target branch did not apply cleanly. Both name the same kind of "theirs" tree.
 *
 * The `-z` numstat stream is NUL-delimited: a normal file is one record `added\tdeleted\tpath`; a
 * rename is a record `added\tdeleted\t` (empty path field) immediately followed by two further
 * NUL-separated tokens (old path, then new path). Both shapes are handled so the scan never
 * misaligns on a renamed entry.
 *
 * @param workingDirectory - The working tree whose in-progress conflict to inspect.
 * @param theirsReference - The incoming side to compare `HEAD` against (`MERGE_HEAD` by default).
 * @returns Every path git reports as a binary change between the two conflict sides.
 */
async function readBinaryDiffPaths(workingDirectory: string, theirsReference = 'MERGE_HEAD'): Promise<Set<string>> {
  const { stdout } = await runGitCommand(workingDirectory, {
    command: 'diff',
    flags: ['--numstat', '-z'],
    positionals: ['HEAD', theirsReference],
  });
  const tokens = stdout.split('\0');
  const binaryPaths = new Set<string>();

  let index = 0;
  while (index < tokens.length) {
    const record = tokens[index];
    if (record.length === 0) {
      index += 1;
      continue;
    }

    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      index += 1;
      continue;
    }

    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    const inlinePath = record.slice(secondTab + 1);
    const isBinary = added === '-' && deleted === '-';

    if (inlinePath.length > 0) {
      if (isBinary) binaryPaths.add(inlinePath);
      index += 1;
    } else {
      // Rename record: the two following tokens are the old and new paths.
      const newPath = tokens[index + 2];
      if (isBinary && newPath) binaryPaths.add(newPath);
      index += 3;
    }
  }
  return binaryPaths;
}

/**
 * Lists the files a conflict in progress left unmerged (`git diff --name-only --diff-filter=U -z`)
 * and pairs each with its {@link GitMergeConflictPath.isBinary} flag. An empty result means the
 * operation failed for a reason other than a content conflict (its caller treats that as a genuine
 * failure). Serves both a three-way merge conflict and a branch-switch stash-pop conflict — only the
 * `theirsReference` used for the binary classification differs (see {@link readBinaryDiffPaths}).
 *
 * @param workingDirectory - The working tree whose in-progress conflict to inspect.
 * @param theirsReference - The incoming side to classify binary paths against (`MERGE_HEAD` by default).
 * @returns One {@link GitMergeConflictPath} per unmerged file.
 */
async function readMergeConflicts(workingDirectory: string, theirsReference = 'MERGE_HEAD'): Promise<GitMergeConflictPath[]> {
  const { stdout } = await runGitCommand(workingDirectory, {
    command: 'diff',
    flags: ['--name-only', '--diff-filter=U', '-z'],
  });
  const conflictedPaths = stdout.split('\0').filter((entry) => entry.length > 0);
  if (conflictedPaths.length === 0) return [];

  const binaryPaths = await readBinaryDiffPaths(workingDirectory, theirsReference);
  return conflictedPaths.map((conflictedPath) => ({
    path: conflictedPath,
    isBinary: binaryPaths.has(conflictedPath),
  }));
}

/**
 * Reads one conflicting file's optional merge-base stage (`git show :1:<path>`), while the
 * unmerged index entries left by a conflicted merge/stash-pop still exist. A non-zero exit is
 * EXPECTED and not an error here: it means the file had no common ancestor (an add/add conflict),
 * which this returns as `null` rather than surfacing any failure. `filePath` is passed as a
 * positional AFTER `--end-of-options` ({@link runGitCommandForBytes}'s option-injection guard),
 * and the returned bytes are the object's raw content — safe for a binary file.
 *
 * @param workingDirectory - The working tree whose in-progress conflict to read from.
 * @param filePath - The conflicting file's workspace-relative path.
 * @returns The base stage's raw bytes, or null when the file had no merge base.
 */
async function readOptionalBaseStage(workingDirectory: string, filePath: string): Promise<Buffer | null> {
  try {
    return await runGitCommandForBytes(workingDirectory, { command: 'show', positionals: [`:1:${filePath}`] });
  } catch {
    return null;
  }
}

/**
 * Reads one conflicting file's "ours" (`:2:`) or "theirs" (`:3:`) index stage that
 * {@link readUnmergedStages} has already confirmed EXISTS. A read failure here is therefore a real
 * error (I/O, an unexpected git failure), never "that side deleted the file", so it propagates —
 * whether a side is genuinely absent (a modify/delete deletion) is decided by the ls-files stage
 * listing, NOT by swallowing this read's failure, which would misrecord a transient failure on a
 * real content conflict as a deletion. Same positional/option-injection posture as
 * {@link readOptionalBaseStage}.
 *
 * @param workingDirectory - The working tree whose in-progress conflict to read from.
 * @param stage - `2` for "ours", `3` for "theirs".
 * @param filePath - The conflicting file's workspace-relative path.
 * @returns The stage's raw bytes.
 * @throws {GitProcessError} If the underlying `git show` fails.
 */
async function readStageBytes(workingDirectory: string, stage: 2 | 3, filePath: string): Promise<Buffer> {
  return runGitCommandForBytes(workingDirectory, { command: 'show', positionals: [`:${stage}:${filePath}`] });
}

/**
 * Reads which unmerged index stages (`2` = "ours", `3` = "theirs") currently exist for one
 * conflicting path, by parsing `git ls-files -u -- <path>`: each output line is
 * `<mode> <sha> <stage>\t<path>`, so the whitespace-separated field before the tab (index 2) is the
 * stage number. A modify/delete conflict reports only one of the two, which is how
 * {@link MergeConflictOps.applyResolutionsOrAbort} learns the chosen side was the DELETED side (its
 * stage absent) and must accept the deletion rather than `git checkout` a stage that is not there.
 * `filePath` rides as a positional AFTER `--end-of-options` (the option-injection guard).
 *
 * @param workingDirectory - The working tree whose in-progress conflict to inspect.
 * @param filePath - The conflicting file's workspace-relative path.
 * @returns The set of unmerged stage numbers present for the path (`2` and/or `3`).
 */
async function readUnmergedStages(workingDirectory: string, filePath: string): Promise<Set<2 | 3>> {
  const { stdout } = await runGitCommand(workingDirectory, {
    command: 'ls-files',
    flags: ['-u'],
    positionals: [filePath],
  });
  const stages = new Set<2 | 3>();
  for (const line of stdout.split('\n')) {
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) continue;
    const fields = line.slice(0, tabIndex).trim().split(/\s+/);
    const stage = fields[2];
    if (stage === '2') stages.add(2);
    else if (stage === '3') stages.add(3);
  }
  return stages;
}

/**
 * Computes the file-level change-set landed against `fromCommit`, as `git diff --name-status -M -z
 * <fromCommit> [<toCommit>]`.
 *
 * A clean merge passes both commits (`fromCommit` = post-flush pre-merge `HEAD`, `toCommit` =
 * post-merge `HEAD`), so the result is exactly the REMOTE's contribution, excluding the live local
 * edits the domain already holds. A clean branch switch passes ONLY `fromCommit` (the pre-switch
 * `HEAD`), diffing it against the CURRENT working tree instead of a second commit, so the re-applied
 * live edits — which sit uncommitted in the working tree after the stash-pop — are INCLUDED in the
 * result alongside the target branch's own content. Either way, the added/modified/renamed bytes are
 * read from the working tree on disk, which the domain's own `ProjectFileStore` cannot see.
 *
 * The `-z` name-status stream is NUL-delimited: each record is `status` then its path(s) as
 * separate tokens — `A`/`M`/`D` take one path, `R<score>` takes two (old, then new). `-M` enables
 * rename detection; copy detection is not requested, so no `C` record can appear. `core.quotePath`
 * is globally disabled, so every path token is already raw bytes needing no unescaping.
 *
 * @param workingDirectory - The working tree the changed bytes are read from.
 * @param fromCommit - The base commit to diff from.
 * @param toCommit - The commit to diff to, or omitted to diff `fromCommit` against the working tree.
 * @returns One {@link GitMergeFileChange} per changed file.
 */
async function computeMergeChanges(
  workingDirectory: string,
  fromCommit: string,
  toCommit?: string,
): Promise<GitMergeFileChange[]> {
  const { stdout } = await runGitCommand(workingDirectory, {
    command: 'diff',
    flags: ['--name-status', '-M', '-z'],
    positionals: toCommit === undefined ? [fromCommit] : [fromCommit, toCommit],
  });
  const tokens = stdout.split('\0');
  const changes: GitMergeFileChange[] = [];

  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    if (status.length === 0) {
      index += 1;
      continue;
    }

    const code = status[0];
    switch (code) {
      // A `T` (type change, e.g. a path switching between a regular file and a symlink) records the
      // same thing the reconciler needs as an `M`: the path still exists and its content is now
      // whatever the merge wrote. Landing it as `modified` keeps the file model in step with the tree.
      case 'A':
      case 'M':
      case 'T': {
        const changedPath = tokens[index + 1];
        const content = await readFile(path.join(workingDirectory, changedPath));
        changes.push({
          type: code === 'A' ? 'added' : 'modified',
          path: changedPath,
          content,
          mimeType: guessMimeType(changedPath),
        });
        index += 2;
        break;
      }
      case 'D': {
        changes.push({ type: 'removed', path: tokens[index + 1] });
        index += 2;
        break;
      }
      case 'R': {
        const fromPath = tokens[index + 1];
        const toPath = tokens[index + 2];
        const content = await readFile(path.join(workingDirectory, toPath));
        changes.push({ type: 'renamed', fromPath, toPath, content, mimeType: guessMimeType(toPath) });
        index += 3;
        break;
      }
      default: {
        // A/M/D/R/T are the only statuses these flags can emit (copy detection is off; `-z` never
        // emits the octal-escape case core.quotePath would). Advance past status + one path
        // defensively rather than looping on anything unforeseen.
        index += 2;
      }
    }
  }
  return changes;
}

/**
 * Local merge/conflict git operations: the three-way pull merge, the branch switch that carries
 * live edits across, the resolution of a previously-aborted conflicted pull, and the restore of a
 * pre-operation undo snapshot. Touches no network — every operation runs against the project's own
 * working tree. When a conflict-stage store is configured, each pull/switch records a pre-operation
 * undo snapshot and captures every conflicted path's three-way stages before aborting.
 */
export class MergeConflictOps {
  /**
   * @param storageRoot - Root directory for per-project storage (see {@link resolveWorkingTreePath}).
   * @param conflictStageStore - Off-working-tree store {@link MergeConflictOps.merge}/
   *   {@link MergeConflictOps.checkout} write the pre-operation undo snapshot and captured three-way
   *   conflict stages to. Optional so a test exercising unrelated behavior need not construct one;
   *   the composition root always supplies a real one rooted OUTSIDE every project's working tree.
   *   When omitted, `merge`/`checkout` skip the snapshot/stage capture entirely (their
   *   conflicted/clean outcomes are unaffected).
   */
  constructor(
    private readonly storageRoot: string,
    private readonly conflictStageStore: ConflictStageStore | undefined,
  ) {}

  /**
   * Records the pre-operation undo snapshot, when a {@link MergeConflictOps.conflictStageStore} was
   * configured. Called by {@link MergeConflictOps.merge}/{@link MergeConflictOps.checkout} before
   * any working-tree mutation, on BOTH the clean and conflicted paths, so every pull/switch leaves
   * an undo target.
   *
   * @param operationId - The operation this snapshot belongs to.
   * @param preOpHead - The local `HEAD` captured before the flush commit / any working-tree change.
   * @param branch - The branch the operation is running on.
   * @param wipCommit - The commit pinning the operation's MOVED uncommitted/live edits (the backup
   *   ref `refs/adc/undo/<operationId>` points at it), or omitted when the operation moved nothing.
   *   Recorded on a SECOND call, once the moved work exists and has been pinned — the initial
   *   pre-mutation call (the irreversibility guard) has no `wipCommit` yet, and overwriting the
   *   snapshot with it later is exactly the port's documented overwrite behavior.
   * @param sourceBranch - The branch `HEAD` was on when a BRANCH_SWITCH began, so a later undo can
   *   return to it WITHOUT moving the target branch's ref. Set only by {@link MergeConflictOps.checkout}
   *   when it ran from a named branch; omitted by a pull (which stays on one branch) and by a switch
   *   from a detached `HEAD` (no branch to return to), so their undo keeps the in-place reset.
   * @returns Success (a no-op) when no store is configured, or once recorded; a
   *   `GitCommandFailedError` when the store's write fails.
   */
  private async writeUndoSnapshot(
    operationId: GitOperationId,
    preOpHead: string,
    branch: string,
    wipCommit?: string,
    sourceBranch?: string,
  ): Promise<Result<void, GitCommandFailedError>> {
    if (!this.conflictStageStore) return { success: true, value: undefined };

    const written = await this.conflictStageStore.writeSnapshot(operationId, {
      preOpHead,
      branch,
      ...(wipCommit === undefined ? {} : { wipCommit }),
      ...(sourceBranch === undefined ? {} : { sourceBranch }),
    });
    if (!written.success) {
      return { success: false, error: new GitCommandFailedError('The pre-operation snapshot could not be recorded.') };
    }
    return { success: true, value: undefined };
  }

  /**
   * Points the never-lose-work backup ref `refs/adc/undo/<operationId>` at `commit`, making the
   * commit reachable so `git gc`/`git clean` can never collect the moved edits it captures while the
   * project waits for the user to act. `commit` is a code-resolved SHA (never user input); the ref
   * name lives in the private `refs/adc/` namespace this feature owns. Returns a result rather than
   * throwing so every caller can choose its own failure posture — see {@link pinWorkInProgress} for
   * the stash-resolution variant and the ordering the conflicted-switch path depends on.
   *
   * @param cwd - The project's working tree.
   * @param operationId - The operation whose backup ref to write.
   * @param commit - The commit SHA to pin.
   * @returns Success once the ref is written; a `GitCommandFailedError` if `git update-ref` fails.
   */
  private async pinBackupRef(
    cwd: string,
    operationId: GitOperationId,
    commit: string,
  ): Promise<Result<void, GitCommandFailedError>> {
    try {
      await runGitCommand(cwd, {
        command: 'update-ref',
        positionals: [`${BACKUP_REF_PREFIX}${operationId.value}`, commit],
      });
      return { success: true, value: undefined };
    } catch {
      return { success: false, error: new GitCommandFailedError('The moved local edits could not be preserved.') };
    }
  }

  /**
   * Enforces "exactly one retained undo point per project" at the git-ref level: called only ONCE
   * the current content op has ESTABLISHED its own durable undo point — on the clean-success path and
   * the conflict-detection path, AFTER this op's backup ref (its flush/stash commit, if any) is
   * pinned — never before the fallible merge/checkout. It then prunes every OTHER project undo point
   * — deleting each stale backup ref `refs/adc/undo/<opId>` and clearing that op's off-tree snapshot
   * — so undo points never accumulate unbounded. Deferring it past the fallible step is load-bearing:
   * a pull/switch that FAILS never reaches here, so a failed op can never delete the PRIOR op's undo
   * point without having established its own. Retention is enforced HERE, in the project's own repo
   * (`cwd`) where each op's backup ref lives, rather than by scanning the conflict-stage store (which
   * is keyed by operation under a shared root, NOT scoped per project).
   *
   * NEVER prunes when the current op recorded NO retained snapshot: with no
   * {@link MergeConflictOps.conflictStageStore} configured, {@link MergeConflictOps.writeUndoSnapshot}
   * is a no-op that still reports success, so the current op has a backup ref but no snapshot behind
   * it — deleting every OTHER ref then would leave the project with zero USABLE undo points (a later
   * `readSnapshot` returns null → `NothingToUndo`). This mirrors the sweeper's "keep everything when
   * no snapshot is confirmed" stance: with no store, prune NOTHING and let the belt-and-braces sweep
   * reconcile later. When a store IS configured, both callers only reach here AFTER a successful
   * `writeUndoSnapshot`, so the current op's snapshot is genuinely recorded and pruning the rest is safe.
   *
   * BEST-EFFORT by design, mirroring the swallow-on-failure posture the file uses for its other
   * convenience-ref writes: every failure — listing the refs, deleting one, or clearing its
   * snapshot — is swallowed so a prune can NEVER fail the pull/switch that triggered it. The current
   * op's own ref/snapshot (`keepOperationId`) is always guarded and left untouched, and only refs
   * under {@link BACKUP_REF_PREFIX} are ever touched.
   *
   * @param cwd - The project's working tree.
   * @param keepOperationId - The current op whose freshly-recorded undo point must be preserved.
   */
  private async pruneOtherBackupRefs(cwd: string, keepOperationId: GitOperationId): Promise<void> {
    // Only prune once the current op ACTUALLY recorded a retained snapshot. No store → the snapshot
    // write was a no-op, so this op's ref has nothing behind it; deleting the others would strip the
    // project of every usable undo point. Prune nothing and leave retention to the sweeper.
    if (!this.conflictStageStore) return;

    // One shared listing with the sweeper (see {@link listBackupReferenceOperationIds}); a listing failure
    // yields an empty list, so a prune failure can never fail the pull/switch.
    const operationIdValues = await listBackupReferenceOperationIds(cwd);
    for (const operationIdValue of operationIdValues) {
      // Never delete the current op's own undo point (the one just recorded). The shared listing
      // already drops any malformed (empty-suffix) ref name.
      if (operationIdValue === keepOperationId.value) continue;
      // Delete the ref and clear its snapshot as independent best-effort steps (see
      // {@link deleteBackupReferenceAndClearSnapshot}); no `onError`, so a single stale entry's failure
      // is silently swallowed here — a prune failure must never fail the pull/switch.
      await deleteBackupReferenceAndClearSnapshot(cwd, operationIdValue, this.conflictStageStore);
    }
  }

  /**
   * Best-effort cleanup for a pull/switch that FAILED after it began recording its own undo point:
   * deletes THIS op's backup ref `refs/adc/undo/<operationId>` and clears its conflict-stage
   * snapshot (via the shared {@link deleteBackupReferenceAndClearSnapshot} helper), so a failed op leaves
   * NO orphaned undo artifact for retention — the inline prune, the sweeper's keep-selection, or
   * undo Case B — to mistake for a live undo point. Called only from {@link MergeConflictOps.merge}/
   * {@link MergeConflictOps.checkout}'s failure paths; the succeeded/conflicted paths never reach it.
   *
   * Mirrors the swallow-on-failure posture the file uses for its other convenience-ref writes: never
   * throws, and never changes the failure the caller is already returning. A no-op snapshot clear
   * when no {@link MergeConflictOps.conflictStageStore} is configured (the helper skips the clear),
   * while the backup-ref delete still runs harmlessly.
   *
   * CALLER OBLIGATION — this is the whole feature's load-bearing rule. Deleting the backup ref is
   * only ever safe while the operation's moved/shelved work is reachable WITHOUT it. A caller must
   * therefore NOT call this once the ref has become the sole handle on that work — which for a
   * branch switch happens the moment the stash stack entry is gone, whether dropped after the
   * conflicted path pinned it or consumed by a successful `git stash pop`. In that state the ref is
   * the only thing keeping the user's uncommitted edits reachable and gc-ineligible, and the worker's
   * `ensureCleanWorkingTree` wipes the working-tree copy before the next job. When in doubt, LEAK:
   * a stale ref/snapshot costs one later prune or sweeper pass, whereas a deleted last handle costs
   * the user their edits outright. The `backupReferenceIsRedundant` flag in
   * {@link MergeConflictOps.checkout} tracks exactly this; {@link MergeConflictOps.merge} needs no
   * such flag, because a pull's moved work is a COMMIT on the branch and stays reachable from `HEAD`
   * regardless of the ref.
   *
   * @param cwd - The project's working tree the backup ref lives in.
   * @param operationId - The failed operation whose orphaned undo artifacts to remove.
   */
  private async cleanupFailedOperationUndoPoint(cwd: string, operationId: GitOperationId): Promise<void> {
    await deleteBackupReferenceAndClearSnapshot(cwd, operationId.value, this.conflictStageStore);
  }

  /**
   * Resolves the shelved edits still on top of the stash stack (`stash@{0}`) to their stash commit
   * SHA and pins that commit under the backup ref via {@link pinBackupRef} — the never-lose-work
   * artifact for a CONFLICTED branch switch, whose moved edits live in a stash rather than a flush
   * commit. Called AFTER the conflicted pop (which leaves `stash@{0}` in place) and BEFORE the stack
   * entry is dropped, so a pin failure can keep the entry rather than lose the work. The clean-switch
   * path cannot use this — its successful `git stash pop` already consumed `stash@{0}` — so it
   * resolves the SHA before popping and pins it with {@link pinBackupRef} directly.
   *
   * @param cwd - The project's working tree.
   * @param operationId - The operation whose backup ref to write.
   * @returns The pinned stash commit SHA on success; a `GitCommandFailedError` when `stash@{0}` is
   *   absent/unresolvable or the ref write fails.
   */
  private async pinWorkInProgress(
    cwd: string,
    operationId: GitOperationId,
  ): Promise<Result<string, GitCommandFailedError>> {
    try {
      const stashRevResult = await runGitCommand(cwd, { command: 'rev-parse', positionals: ['stash@{0}'] });
      const stashCommit = readRevParseAnswer(stashRevResult.stdout);
      if (stashCommit.length === 0) {
        return { success: false, error: new GitCommandFailedError('The moved local edits could not be preserved.') };
      }
      const pinned = await this.pinBackupRef(cwd, operationId, stashCommit);
      if (!pinned.success) return pinned;
      return { success: true, value: stashCommit };
    } catch {
      return { success: false, error: new GitCommandFailedError('The moved local edits could not be preserved.') };
    }
  }

  /**
   * Captures every conflicting path's three-way stages (base/ours/theirs) into
   * {@link MergeConflictOps.conflictStageStore}, when one is configured — called by
   * {@link MergeConflictOps.merge}/{@link MergeConflictOps.checkout} AFTER the conflict is detected
   * but BEFORE the caller aborts it, while the unmerged index entries
   * `git show :1:/:2:/:3:<path>` reads from still exist.
   *
   * Each side's `:2:`/`:3:` stage is read optionally: a modify/delete (or rename/delete) conflict
   * has only ONE of them, and the absent side is captured as `null` (meaning "that side deleted the
   * file") rather than hard-failing the whole operation. Never throws: every failure (a stage read,
   * or the store's own write) is caught and turned into a `GitCommandFailedError` result, so the
   * caller can always run its abort in a `finally` around this call and still learn whether the
   * capture succeeded.
   *
   * @param workingDirectory - The working tree whose in-progress conflict to capture.
   * @param operationId - The conflicted operation these stages belong to.
   * @param conflicts - Every path left in conflict, with its binary classification.
   * @returns Success (a no-op) when no store is configured, or once every path is captured; a
   *   `GitCommandFailedError` on the first read or write failure.
   */
  private async captureConflictStages(
    workingDirectory: string,
    operationId: GitOperationId,
    conflicts: readonly GitMergeConflictPath[],
  ): Promise<Result<void, GitCommandFailedError>> {
    if (!this.conflictStageStore) return { success: true, value: undefined };

    try {
      for (const conflict of conflicts) {
        // `git ls-files -u` authoritatively lists which stages exist for the path, so a genuinely
        // absent stage (that side deleted the file) is distinguished from a stage that exists but
        // fails to read. A present stage is read with a propagating read whose failure surfaces via
        // the catch below; only a truly absent stage becomes null. Swallowing every read failure as
        // null would misrecord a transient failure on a real content conflict as a deletion, and the
        // later resolution would drop the file the user meant to keep.
        const unmergedStages = await readUnmergedStages(workingDirectory, conflict.path);
        const base = await readOptionalBaseStage(workingDirectory, conflict.path);
        const ours = unmergedStages.has(2) ? await readStageBytes(workingDirectory, 2, conflict.path) : null;
        const theirs = unmergedStages.has(3) ? await readStageBytes(workingDirectory, 3, conflict.path) : null;

        const written = await this.conflictStageStore.writeStages(operationId, conflict.path, {
          base,
          ours,
          theirs,
          isBinary: conflict.isBinary,
        });
        if (!written.success) {
          return { success: false, error: new GitCommandFailedError('The conflict could not be recorded.') };
        }
      }
      return { success: true, value: undefined };
    } catch {
      return { success: false, error: new GitCommandFailedError('The conflict could not be recorded.') };
    }
  }

  /**
   * Runs a local three-way merge of the already-fetched `refs/remotes/origin/<branch>` into
   * `input.branch`. Touches no network.
   *
   * Ordering (all in the project's own working tree):
   * 1. `preOpHead` (`rev-parse HEAD`, BEFORE the flush commit) becomes the operation's undo point,
   *    recorded pin-then-snapshot to keep "a snapshot exists ⟺ its backup ref exists": the backup ref
   *    is pinned at `preOpHead` FIRST, then {@link MergeConflictOps.writeUndoSnapshot} records the
   *    snapshot — on BOTH the clean and conflicted paths below, so every pull leaves an undo target.
   *    A failed base pin records no undo point at all (never a snapshot without a ref) and leaves the
   *    merge itself untouched; a store write failure after the pin rolls the ref back and fails closed.
   * 2. Every `input.flush` entry's path is validated with {@link staysInsideWorkingTree} BEFORE any
   *    write — an unsafe path fails the whole merge closed, with no partial write.
   * 3. Each flush entry is written then `git add`-ed, forming the live local side of the merge.
   * 4. That local side is committed — but only when {@link hasStagedChanges} confirms something is
   *    staged — under {@link SERVICE_COMMIT_IDENTITY} (a merge carries no author) with
   *    {@link FLUSH_COMMIT_MESSAGE}, so the merge is a clean commit-vs-commit three-way.
   * 5. `preMergeHead` is captured AFTER that commit, so the computed change-set is the REMOTE's
   *    contribution only, excluding the live local edits the domain already holds.
   * 6. `git merge --no-edit refs/remotes/origin/<branch>` runs. A non-zero exit is EXPECTED when the
   *    merge conflicts and is NOT immediately an error: unmerged paths are inspected
   *    ({@link readMergeConflicts}) — if there are none the exit was a genuine failure
   *    (`GitCommandFailedError`); if there are, each conflicting path's three-way stages are
   *    captured via {@link MergeConflictOps.captureConflictStages} BEFORE `git merge --abort` runs
   *    (in a `finally`, so a capture failure can never leave `MERGE_HEAD` behind) and the
   *    `conflicted` outcome is returned — UNLESS the capture itself failed, in which case a
   *    `GitCommandFailedError` is returned instead, after the abort has already restored a clean
   *    tree.
   * 7. On a clean merge, the change-set is computed from `preMergeHead` to the post-merge `HEAD`
   *    ({@link computeMergeChanges}); an unchanged `HEAD` (already up to date) yields empty changes.
   *
   * @param projectId - The project whose working tree to merge into.
   * @param input - The branch to merge into, the live-content flush list, and the operation id the
   *   undo snapshot and any captured conflict stages are keyed by.
   * @returns A {@link GitMergeOutcome} — `merged` (with the remote's change-set) or `conflicted`
   *   (with the files left in conflict); a `GitCommandFailedError` only when a git command itself
   *   fails, a flush path is unsafe, or the stage-store capture fails. A conflict is an expected
   *   outcome, never an error.
   */
  async merge(projectId: ProjectId, input: GitMergeInput): Promise<Result<GitMergeOutcome, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    for (const entry of input.flush) {
      if (!staysInsideWorkingTree(cwd, entry.path)) {
        return {
          success: false,
          error: new GitCommandFailedError('A flush entry path escapes the project working tree.'),
        };
      }
    }

    try {
      const preOpHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preOpHead = readRevParseAnswer(preOpHeadResult.stdout);

      // Establish this op's undo point BEFORE any working-tree mutation, in an order that keeps the
      // invariant "a snapshot exists for an op ⟺ its backup ref exists": PIN the backup ref at
      // `preOpHead` FIRST, and write the snapshot ONLY once that pin succeeded. Ref-driven retention
      // (the inline prune and the sweeper) is listing-driven, so a snapshot with NO backup ref would
      // never be listed and would leak forever in the shared conflict-stage root. Best-effort by
      // design: `preOpHead` is already reachable from HEAD, so a failed pin loses nothing — it simply
      // means this pull records no undo point (`undoPointEstablished` stays false, the snapshot is
      // skipped, and the prune below is skipped too), never that the merge tears down.
      let undoPointEstablished = false;
      const basePinned = await this.pinBackupRef(cwd, input.operationId, preOpHead);
      if (basePinned.success) {
        const snapshotWritten = await this.writeUndoSnapshot(input.operationId, preOpHead, input.branch);
        if (!snapshotWritten.success) {
          // The snapshot write failed after the base ref was pinned: delete that ref so neither half
          // of the invariant is left behind, then fail the merge exactly as before (a store write
          // failure is a genuine failure, not a best-effort miss).
          await this.cleanupFailedOperationUndoPoint(cwd, input.operationId);
          return snapshotWritten;
        }
        undoPointEstablished = true;
      }

      for (const entry of input.flush) {
        await writeFile(path.join(cwd, entry.path), entry.content, 'utf8');
        await runGitCommand(cwd, { command: 'add', positionals: [entry.path] });
      }

      const flushed = await hasStagedChanges(cwd);
      if (flushed) {
        await runGitCommand(cwd, {
          command: 'commit',
          flags: ['-m', FLUSH_COMMIT_MESSAGE],
          identity: SERVICE_COMMIT_IDENTITY,
        });
      }

      const preMergeHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preMergeHead = readRevParseAnswer(preMergeHeadResult.stdout);

      // When live edits were flushed, the flush commit (`preMergeHead`, the post-flush pre-merge
      // HEAD) is pull's moved work. MOVE the backup ref from the base (`preOpHead`) onto it and
      // upgrade the snapshot's `wipCommit` to match, so it is ref-pinned exactly like a switch's
      // shelved edits — gc-safe and recoverable with zero editor dependence. Only when this op already
      // established its base undo point above, so there is genuinely a snapshot to upgrade and the
      // invariant is preserved. Best-effort by design: the flush commit is already reachable from HEAD
      // here, so a failed move leaves the base pin at `preOpHead` as a still-valid undo point and never
      // tears down the merge; a no-flush pull needs nothing more, since the base pin already covers it.
      if (flushed && undoPointEstablished) {
        const pinned = await this.pinBackupRef(cwd, input.operationId, preMergeHead);
        if (pinned.success) {
          // `undoPointEstablished` means "this op has BOTH a backup ref AND a snapshot that matches
          // it" — the precondition the prune below depends on — so it must track this write's
          // outcome rather than stay blindly true. The ref has just MOVED onto the flush commit; if
          // the snapshot naming it cannot be written, ref and snapshot describe different commits
          // and this op no longer holds a coherent undo point, so the prune is skipped and every
          // OTHER op's undo point survives. Best-effort otherwise: the flush commit is reachable
          // from `HEAD` here, so a failed write loses nothing and never tears the merge down.
          const upgraded = await this.writeUndoSnapshot(input.operationId, preOpHead, input.branch, preMergeHead);
          undoPointEstablished = upgraded.success;
        }
      }

      const remoteReference = `refs/remotes/origin/${input.branch}`;
      try {
        // A non-fast-forward merge records a merge commit, which needs a committer identity — the
        // same service identity the flush commit uses, since a merge carries no author.
        await runGitCommand(cwd, {
          command: 'merge',
          flags: ['--no-edit'],
          positionals: [remoteReference],
          identity: SERVICE_COMMIT_IDENTITY,
        });
      } catch (error) {
        const conflicts = await readMergeConflicts(cwd);
        if (conflicts.length === 0) {
          // No unmerged paths → this was a genuine command failure (e.g. the ref does not exist),
          // not a content conflict.
          throw error;
        }

        // Capture every conflicting path's three-way stages BEFORE the abort — the abort runs in
        // a `finally` so a capture failure can never leave `MERGE_HEAD` behind.
        let captured: Result<void, GitCommandFailedError> = { success: true, value: undefined };
        try {
          captured = await this.captureConflictStages(cwd, input.operationId, conflicts);
        } finally {
          await runGitCommand(cwd, { command: 'merge', flags: ['--abort'] });
        }
        if (!captured.success) {
          // The capture failed after the abort restored a clean tree: this op is a FAILURE, so clear
          // its own orphaned snapshot/backup ref rather than leaving a half-recorded undo point behind.
          await this.cleanupFailedOperationUndoPoint(cwd, input.operationId);
          return captured;
        }

        // Only now has this op established its durable undo point (its flush commit, if any, was
        // pinned above and its conflict stages are captured): prune every OTHER project undo point.
        // Deferred to here — never before the fallible merge — so a merge that FAILS leaves the prior
        // op's undo point intact. Guarded on `undoPointEstablished` because a failed base pin leaves
        // this op with NO undo point to keep, and pruning the others then would strip the project bare.
        // Best-effort; never fails the (correctly conflicted) operation.
        if (undoPointEstablished) await this.pruneOtherBackupRefs(cwd, input.operationId);

        return { success: true, value: { status: 'conflicted', conflicts } };
      }

      const postMergeHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const postMergeHead = readRevParseAnswer(postMergeHeadResult.stdout);
      const changes =
        preMergeHead === postMergeHead ? [] : await computeMergeChanges(cwd, preMergeHead, postMergeHead);

      // The merge landed cleanly and every fallible step above (the rev-parse, the change-set
      // computation) has already succeeded: only NOW has this op established its durable undo point
      // (its flush commit, if any, was pinned above). Prune every OTHER project undo point as the
      // LAST effectful step before returning — deferred past every step that can still throw, so a
      // merge whose post-merge tail FAILS never reaches this line and leaves the prior op's undo
      // point intact. Guarded on `undoPointEstablished` (a failed base pin leaves this op no undo
      // point to keep). Best-effort; never fails the merge (see {@link pruneOtherBackupRefs}).
      if (undoPointEstablished) await this.pruneOtherBackupRefs(cwd, input.operationId);

      return { success: true, value: { status: 'merged', headCommit: postMergeHead, changes } };
    } catch {
      // A genuine failure (never a conflict, which returns above): best-effort clear THIS op's own
      // orphaned undo artifacts — its conflict-stage snapshot and its backup ref — so a failed merge
      // leaves nothing for retention to mistake for a live undo point. The prune above never ran on
      // this path, so the PRIOR op's undo point is untouched.
      //
      // Deleting the ref is unconditionally safe HERE, unlike in {@link MergeConflictOps.checkout}:
      // a pull's moved work is the flush COMMIT, which this method took on the branch itself, so it
      // stays reachable from `HEAD` (or as an ancestor of the merge commit) with or without the
      // backup ref. A switch's moved work is uncommitted and lives in a stash, which is why that
      // method has to decide case by case — see {@link cleanupFailedOperationUndoPoint}'s caller
      // obligation.
      await this.cleanupFailedOperationUndoPoint(cwd, input.operationId);
      return { success: false, error: new GitCommandFailedError('The merge could not be completed.') };
    }
  }

  /**
   * Switches the project's working tree to another local branch, carrying in-progress live edits
   * across the switch. Touches no network — a purely LOCAL operation, like {@link MergeConflictOps.merge}:
   * no egress, no credential. Follows the port's `checkout` adapter contract exactly, atomically:
   *
   * 1. Every `input.flush` entry's path is validated with {@link staysInsideWorkingTree} BEFORE any
   *    write — an unsafe path fails the whole switch closed, with no partial write.
   * 2. `preSwitchHead` (the source branch tip) is captured. It is NOT a flush commit: unlike
   *    {@link MergeConflictOps.merge}, the flushed edits are carried across by a stash, never
   *    committed on the source branch. It doubles as the operation's pre-operation undo point,
   *    recorded pin-then-snapshot exactly as {@link MergeConflictOps.merge} does (backup ref pinned at
   *    `preSwitchHead` FIRST, then {@link MergeConflictOps.writeUndoSnapshot}) so "a snapshot exists ⟺
   *    its backup ref exists" holds — on BOTH the clean and conflicted paths below, so every switch
   *    leaves an undo target. A failed base pin records no undo point (never a ref-less snapshot); the
   *    conflicted path below re-establishes one when it pins the shelved edits.
   * 3. Each flush entry is written then `git add`-ed, exactly as {@link MergeConflictOps.merge} does,
   *    materializing the live edits as staged working-tree state on the source branch.
   * 4. When `input.stashLocal` is true AND that flush actually staged something
   *    ({@link hasStagedChanges}), `git stash push` shelves it so the switch can carry it across; a
   *    clean tree shelves nothing, and the later pop is skipped.
   * 5. `git checkout <input.branch>` switches to the target branch (the branch is a positional after
   *    `--end-of-options`). A failure here — for example an unknown target branch — throws and
   *    becomes a generic `GitCommandFailedError`.
   * 6. When step 4 stashed, `git stash pop` re-applies the shelved edits. A non-zero exit is EXPECTED
   *    when the edits collide with the target branch and is NOT immediately an error: unmerged paths
   *    are inspected ({@link readMergeConflicts}, classifying binary against the stash commit) — if
   *    there are none the exit was a genuine failure; if there are, every conflicting path's
   *    three-way stages are captured via {@link MergeConflictOps.captureConflictStages} — the
   *    unmerged index entries still exist at this point — BEFORE the working tree is restored to a
   *    clean checkout of the target branch (`git reset --hard`), leaving a defined, clean tree exactly
   *    as {@link MergeConflictOps.merge}'s `--abort` does. The shelved edits are NOT lost: before the
   *    stash stack entry is dropped they are pinned to a durable backup ref
   *    (`refs/adc/undo/<operationId>`, via {@link MergeConflictOps.pinWorkInProgress}) so they survive
   *    `git gc`/`git clean` and never depend on any editor still holding them — the drop runs ONLY
   *    once that pin succeeds. If the pin fails the stack entry is deliberately kept (nothing is
   *    dropped) and the operation fails, so the work is always recoverable. The `conflicted` outcome
   *    is returned — UNLESS the capture (or the pin) itself failed, in which case a
   *    `GitCommandFailedError` is returned instead, after the reset has restored a clean tree.
   * 7. On a clean switch, `git add -A` stages the re-applied edits (so a flushed edit to a file absent
   *    from the target branch is captured as an addition), and `changes` is the delta from
   *    `preSwitchHead` to the post-switch working tree ({@link computeMergeChanges} with no second
   *    commit) — the target branch's own content AND the re-applied live edits, per the port contract.
   *    An identical tree yields empty `changes`.
   *
   * Failure cleanup is CONDITIONAL, and deliberately so. Every failure path here can hand this op's
   * own half-recorded undo point to {@link MergeConflictOps.cleanupFailedOperationUndoPoint}, which
   * DELETES the backup ref — but only while `backupReferenceIsRedundant` still holds, i.e. while the
   * shelved edits are reachable without that ref. Once the stash stack entry is gone (dropped in step
   * 6 after the pin, or consumed by step 6's successful pop) the ref is the SOLE handle on the user's
   * uncommitted work — the worker's `ensureCleanWorkingTree` removes the working-tree copy before the
   * next job — so the cleanup is skipped and the ref is LEAKED for a later op's inline prune or the
   * sweeper to reclaim. Leaking is cheap; deleting a last handle is unrecoverable.
   *
   * @param projectId - The project whose working tree to switch.
   * @param input - The target branch, the live-content flush list, whether to carry local edits,
   *   and the operation id the undo snapshot and any captured conflict stages are keyed by.
   * @returns A {@link GitCheckoutOutcome} — `switched` with the resulting changes (empty when the
   *   tree is unchanged) or `conflicted` with the files the stash-pop left in conflict; a conflict is
   *   an expected outcome, never an error. Returns a `GitCommandFailedError` (generic message) only
   *   when the underlying git command itself fails, a flush path is unsafe, or the stage-store
   *   capture fails.
   */
  async checkout(
    projectId: ProjectId,
    input: GitCheckoutInput,
  ): Promise<Result<GitCheckoutOutcome, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    for (const entry of input.flush) {
      if (!staysInsideWorkingTree(cwd, entry.path)) {
        return {
          success: false,
          error: new GitCommandFailedError('A flush entry path escapes the project working tree.'),
        };
      }
    }

    // Whether `refs/adc/undo/<operationId>` is still merely a CONVENIENCE — i.e. whether this op's
    // moved work is reachable without it — and therefore whether a failure path below may hand the
    // ref to {@link cleanupFailedOperationUndoPoint}, which DELETES it. It starts redundant: the base
    // pin only names `preSwitchHead`, which the source branch already holds. It stops being redundant
    // the moment this switch's shelved edits lose their independent handle — when the conflicted path
    // drops the stash stack entry after pinning it, or when a successful `git stash pop` consumes
    // that entry — because from then on the ref is the ONLY thing keeping the user's uncommitted work
    // reachable and gc-ineligible, while the worker's `ensureCleanWorkingTree` (`reset --hard` +
    // `clean -fdx`) wipes the working-tree copy before the next job. Declared OUTSIDE the `try` so
    // the outer `catch` — the exact line the historic data-loss bug lived on — can read it and make
    // the safe/unsafe split explicit rather than inferred: when it is false, LEAK the ref and let a
    // later op's inline prune or the belt-and-braces sweeper reclaim it once it is genuinely
    // redundant.
    let backupReferenceIsRedundant = true;

    try {
      const preSwitchHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preSwitchHead = readRevParseAnswer(preSwitchHeadResult.stdout);
      // The branch `HEAD` is on BEFORE the checkout — the source branch to return to when this switch
      // is later undone. `git checkout <input.branch>` below moves `HEAD` to the target branch, so
      // recording it now is the only chance to know where to go back to; a switch's conflict leaves
      // `HEAD` sitting on the target, and a plain `reset --hard <preSwitchHead>` there would move the
      // TARGET branch's ref onto the source tip (corrupting it and orphaning the target's own
      // commits). A detached `HEAD` reports the literal `HEAD` from `--abbrev-ref`, so none is
      // recorded; the undo then falls back to the in-place reset. That fallback is safe ONLY because a
      // switch never runs from a detached HEAD here (the working tree is always on the domain's
      // current branch) — a genuinely detached source would reintroduce the target-ref corruption
      // above, so this invariant, not the reset itself, is what makes the fallback correct.
      const sourceBranchResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['--abbrev-ref', 'HEAD'] });
      const sourceBranchName = readRevParseAnswer(sourceBranchResult.stdout);
      const sourceBranch = sourceBranchName.length > 0 && sourceBranchName !== 'HEAD' ? sourceBranchName : undefined;
      // preSwitchHead IS the pre-operation head (a switch never takes a flush commit on the source
      // branch — the flushed edits are carried across by a stash instead), so it doubles as the
      // undo snapshot's `preOpHead`, recorded on BOTH the clean and conflicted paths below.
      //
      // Establish this switch's undo point in the same pin-then-snapshot order `merge` uses, so the
      // "a snapshot exists for an op ⟺ its backup ref exists" invariant holds: PIN the backup ref at
      // `preSwitchHead` FIRST, and write the snapshot ONLY once that pin succeeded — a snapshot with no
      // backup ref would never be listed by ref-driven retention and would leak forever. Best-effort:
      // `preSwitchHead` is already reachable, so a failed pin means this switch records no undo point
      // (`undoPointEstablished` stays false, the snapshot and the prune below are skipped) but never
      // tears the switch down. The conflicted path re-pins the shelved edits and re-writes the snapshot
      // below, re-establishing the undo point even if this base pin failed.
      let undoPointEstablished = false;
      const basePinned = await this.pinBackupRef(cwd, input.operationId, preSwitchHead);
      if (basePinned.success) {
        const snapshotWritten = await this.writeUndoSnapshot(
          input.operationId,
          preSwitchHead,
          input.branch,
          undefined,
          sourceBranch,
        );
        if (!snapshotWritten.success) {
          // The snapshot write failed after the base ref was pinned: delete that ref so neither half
          // of the invariant is left behind, then fail the switch exactly as before. Nothing has been
          // flushed, stashed or checked out yet, so the ref names nothing but `preSwitchHead` and
          // deleting it cannot lose work (`backupReferenceIsRedundant` is necessarily still true).
          await this.cleanupFailedOperationUndoPoint(cwd, input.operationId);
          return snapshotWritten;
        }
        undoPointEstablished = true;
      }

      for (const entry of input.flush) {
        await writeFile(path.join(cwd, entry.path), entry.content, 'utf8');
        await runGitCommand(cwd, { command: 'add', positionals: [entry.path] });
      }

      const stashed = input.stashLocal && (await hasStagedChanges(cwd));
      if (stashed) {
        await runGitCommand(cwd, { command: 'stash', flags: ['push'] });
      }

      await runGitCommand(cwd, { command: 'checkout', positionals: [input.branch] });

      // The stash commit capturing the shelved edits, resolved while `stash@{0}` still exists —
      // BEFORE the pop below either consumes it (clean) or leaves it in place (conflicted). It is the
      // branch switch's never-lose-work artifact, pinned under the backup ref on whichever path runs.
      let stashCommit: string | undefined;
      if (stashed) {
        const stashRevResult = await runGitCommand(cwd, { command: 'rev-parse', positionals: ['stash@{0}'] });
        stashCommit = readRevParseAnswer(stashRevResult.stdout);
        try {
          await runGitCommand(cwd, { command: 'stash', flags: ['pop'] });
          // The pop SUCCEEDED, so it consumed `stash@{0}`: the shelved edits now exist only as
          // uncommitted working-tree content plus the (still dangling) `stashCommit`. From this line
          // on, the backup ref — moved onto `stashCommit` below — is the sole durable handle on that
          // work, so no failure path may delete it. This is the tail whose historic loss was total:
          // any throw below reached the outer `catch`, which deleted the ref, and the worker's
          // `ensureCleanWorkingTree` then wiped the popped edits from the tree as well.
          backupReferenceIsRedundant = false;
        } catch (error) {
          // A failed pop is a content conflict only if it left unmerged paths; otherwise it is a
          // genuine command failure. The stash commit (`stash@{0}`, kept by the failed pop) is the
          // "theirs" side for the binary classification, mirroring how a merge uses `MERGE_HEAD`.
          const conflicts = await readMergeConflicts(cwd, 'stash@{0}');
          if (conflicts.length === 0) {
            throw error;
          }

          // Capture every conflicting path's three-way stages BEFORE the reset/pin/drop — all run in
          // a `finally` so a capture failure can never leave the tree dirty or the stash mishandled.
          let captured: Result<void, GitCommandFailedError> = { success: true, value: undefined };
          // The pin's outcome is read AFTER the `finally`: it decides both the drop (below) and
          // whether this operation can safely report a conflict at all.
          let wipPin: Result<string, GitCommandFailedError> = {
            success: false,
            error: new GitCommandFailedError('The moved local edits could not be preserved.'),
          };
          try {
            captured = await this.captureConflictStages(cwd, input.operationId, conflicts);
          } finally {
            // Restore a clean checkout of the target branch (`reset --hard` leaves the same defined,
            // clean tree `merge --abort` does). It does NOT touch the stash stack, so `stash@{0}`
            // still resolves for the pin below.
            await runGitCommand(cwd, { command: 'reset', flags: ['--hard'] });

            // Never `stash drop` the shelved edits outright — that is the historic data-loss site.
            // Instead PIN them first (resolve `stash@{0}` and point the backup ref at it), and drop
            // the stack entry ONLY once the object is ref-pinned. Ordering is load-bearing: pin
            // succeeds → drop the now-redundant stack entry; pin fails → keep the stack entry so the
            // moved work is never lost, and let the operation fail below through the same failure
            // path a capture failure uses. The edits survive with zero editor dependence either way.
            wipPin = await this.pinWorkInProgress(cwd, input.operationId);
            if (wipPin.success) {
              // From here the backup ref is LOAD-BEARING: the stack entry it made redundant is about
              // to go, leaving the ref as the sole handle on the shelved edits. Marked BEFORE the
              // drop, so even a drop that throws out of this `finally` reaches the outer `catch` with
              // the ref already protected.
              backupReferenceIsRedundant = false;
              await runGitCommand(cwd, { command: 'stash', flags: ['drop'] });
            }
          }
          if (!captured.success) {
            // The capture failed after the reset restored a clean tree: this op is a FAILURE, so clear
            // its own orphaned snapshot/backup ref rather than leaving a half-recorded undo point
            // behind — but ONLY while doing so cannot lose work. When the pin above succeeded, the
            // stash stack entry was dropped and `refs/adc/undo/<operationId>` is the ONLY remaining
            // handle on the user's moved edits: deleting it here would make them unreachable and
            // gc-eligible, which is precisely the loss this feature exists to prevent. So leave BOTH
            // the ref and the snapshot naming its `wipCommit` in place and let retention reclaim them
            // later; a leaked undo point is cheap, a destroyed one is not.
            if (backupReferenceIsRedundant) await this.cleanupFailedOperationUndoPoint(cwd, input.operationId);
            return captured;
          }
          if (!wipPin.success) {
            // The shelved edits could not be pinned (the stack entry was kept, so the work survives
            // independently of any ref — `backupReferenceIsRedundant` is necessarily still true here),
            // but this op is a FAILURE: clear its own orphaned snapshot/backup ref. Guarded by the
            // same flag as every other cleanup site so the rule is enforced in one place.
            if (backupReferenceIsRedundant) await this.cleanupFailedOperationUndoPoint(cwd, input.operationId);
            return wipPin;
          }

          // Record the pinned commit as the snapshot's `wipCommit` so a later undo/recovery has the
          // handle, carrying the `sourceBranch` through so the undo returns to it. Best-effort: the
          // edits are already ref-pinned above, so a snapshot re-write failure never loses them and
          // must not fail the (correctly conflicted) operation. This pin+snapshot re-establishes the
          // undo point (with the invariant intact) even if the base pin above had failed.
          //
          // `undoPointEstablished` tracks THIS write's outcome rather than being set blindly:
          // the flag means "this op has BOTH a backup ref AND a snapshot that matches it", and the
          // prune below acts on it. The ref now points at the pinned `wipCommit`; if the snapshot
          // naming it could not be written, this op has no coherent undo point, and pruning every
          // OTHER op's would leave the project with a ref whose snapshot is missing — zero usable
          // undo points, the exact case {@link pruneOtherBackupRefs} documents itself as guarding
          // against. Skipping the prune only leaks the other ops' undo points for retention to
          // reclaim later.
          const wipSnapshotWritten = await this.writeUndoSnapshot(
            input.operationId,
            preSwitchHead,
            input.branch,
            wipPin.value,
            sourceBranch,
          );
          undoPointEstablished = wipSnapshotWritten.success;

          // Only now has this switch established its durable undo point (its shelved edits pinned
          // under the backup ref): prune every OTHER project undo point. Deferred to here — never
          // before the fallible checkout/pop — so a switch that FAILS leaves the prior op's undo
          // point intact. Best-effort; never fails the (correctly conflicted) operation.
          if (undoPointEstablished) await this.pruneOtherBackupRefs(cwd, input.operationId);

          return { success: true, value: { status: 'conflicted', conflicts } };
        }
      }

      // A clean pop re-applied the shelved edits into the target working tree (they are also returned
      // in the change-set below, so the domain persists them). When something WAS shelved, the stash
      // commit (`stashCommit`) is the switch's moved work: MOVE the backup ref from the base
      // (`preSwitchHead`) onto it and upgrade the snapshot's `wipCommit`, so the moved work is durably
      // recoverable from git independent of any editor — symmetric with the pull and conflicted-switch
      // paths, and closing the quiet clean-switch loss. Only when this op already established its base
      // undo point above (so there is a snapshot to upgrade and the invariant holds). Best-effort: the
      // edits are already applied and reported, so a failed move leaves the base pin at `preSwitchHead`
      // as a still-valid undo point and never fails a clean switch; a switch that shelved nothing needs
      // no more than that base pin, which already covers `preSwitchHead`.
      if (stashCommit !== undefined && undoPointEstablished) {
        const pinned = await this.pinBackupRef(cwd, input.operationId, stashCommit);
        if (pinned.success) {
          // Same rule as the pull's flush-commit upgrade: `undoPointEstablished` means "a backup ref
          // AND a snapshot that matches it", so it tracks this write's outcome instead of staying
          // blindly true. The ref has just moved onto `stashCommit`; a failed snapshot write leaves
          // ref and snapshot describing different commits, so the prune below is skipped rather than
          // deleting every OTHER op's undo point on the strength of an incoherent one.
          const upgraded = await this.writeUndoSnapshot(
            input.operationId,
            preSwitchHead,
            input.branch,
            stashCommit,
            sourceBranch,
          );
          undoPointEstablished = upgraded.success;
        }
      }

      // Stage the re-applied edits so a flushed file absent from the target branch is captured as an
      // addition in the change-set (a plain commit-to-worktree diff omits still-untracked files).
      await runGitCommand(cwd, { command: 'add', flags: ['-A'] });

      const postSwitchHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const postSwitchHead = readRevParseAnswer(postSwitchHeadResult.stdout);

      const changes = await computeMergeChanges(cwd, preSwitchHead);

      // The switch landed cleanly and every fallible step above (staging the re-applied edits, the
      // rev-parse, the change-set computation) has already succeeded: only NOW has this op
      // established its durable undo point (its shelved edits, if any, pinned above). Prune every
      // OTHER project undo point as the LAST effectful step before returning — deferred past every
      // step that can still throw, so a switch whose post-checkout tail FAILS never reaches this line
      // and leaves the prior op's undo point intact. Guarded on `undoPointEstablished` (a failed base
      // pin leaves this op no undo point to keep). Best-effort; never fails the switch (see
      // {@link pruneOtherBackupRefs}).
      if (undoPointEstablished) await this.pruneOtherBackupRefs(cwd, input.operationId);

      return { success: true, value: { status: 'switched', headCommit: postSwitchHead, changes } };
    } catch {
      // A genuine failure (never a conflict, which returns above): best-effort clear THIS op's own
      // orphaned undo artifacts — its conflict-stage snapshot and its backup ref — so a failed switch
      // leaves nothing for retention to mistake for a live undo point. The prune above never ran on
      // this path, so the PRIOR op's undo point is untouched.
      //
      // The cleanup is CONDITIONAL, and this is the line the historic data-loss bug lived on:
      // - Safe (`backupReferenceIsRedundant`): the failure happened early — before anything was
      //   stashed, or while the stash stack entry still holds the shelved edits (a failed checkout, a
      //   failed pop, a conflicted pop whose pin failed). The ref names nothing the repo does not
      //   already hold, so removing the half-recorded undo point loses nothing.
      // - Unsafe: the stash stack entry is gone — consumed by a successful pop, or dropped after the
      //   conflicted path pinned it — so the ref is the ONLY handle on the user's uncommitted work,
      //   and the worker runs `ensureCleanWorkingTree` before the next job, wiping the working-tree
      //   copy. Deleting the ref here would destroy the work outright, so LEAK it (and its snapshot)
      //   instead and let a later op's inline prune or the sweeper reclaim it.
      if (backupReferenceIsRedundant) await this.cleanupFailedOperationUndoPoint(cwd, input.operationId);
      return { success: false, error: new GitCommandFailedError('The branch switch could not be completed.') };
    }
  }

  /**
   * Completes a previously-aborted conflicted `PULL` by RE-RUNNING `git merge --no-edit
   * refs/remotes/origin/<branch>` (recreating `MERGE_HEAD`), dropping each `input.resolutions`
   * entry onto its conflicted path, and taking a genuine resolving merge commit. Re-running the
   * merge (rather than committing only the files that were in conflict) also recovers whatever the
   * remote changed in files that were NOT conflicted, which the original abort discarded. Touches
   * no network.
   *
   * Ordering: `ensureCleanWorkingTree` (belt-and-braces — the tree should already be clean, per
   * `AWAITING_CONFLICT`'s own invariant) → capture `preHead` → re-run the merge (a non-zero exit
   * with no unmerged paths is a genuine failure, e.g. The tracking ref no longer exists; a CLEAN
   * merge here — the remote resolved itself since detection — is also fine, nothing to apply) → for
   * each resolution, `ours`/`theirs` via `git checkout --ours/--theirs` + `git add` (or, when the
   * chosen side DELETED the file in a modify/delete conflict — its stage absent — `git rm` to accept
   * that deletion), or `merged` via the bytes {@link ConflictStageStore.readMerged} recorded, written then `git add`-ed
   * → verify no unmerged path remains (`git diff --name-only --diff-filter=U`); if one does, abort
   * and return `stillConflicted` with the still-unmerged paths (classified exactly as
   * {@link MergeConflictOps.merge} classifies its own) → `git commit --no-edit` (reusing the merge's
   * own prepared message) under {@link SERVICE_COMMIT_IDENTITY} → compute the change-set from
   * `preHead` to the new `HEAD` via {@link computeMergeChanges}.
   *
   * Any throw while applying resolutions (or reading the still-unmerged set) runs `git merge
   * --abort` before propagating, so a partial failure never leaves `MERGE_HEAD` or a half-resolved
   * index behind — the awaiting operation stays untouched and retryable.
   *
   * @param projectId - The project whose working tree to complete the merge in.
   * @param input - The branch, the operation id (keys the conflict-stage-store reads for a
   *   `merged` resolution), and every conflicting file's chosen resolution.
   * @returns A {@link GitResolveMergeOutcome}; a `GitCommandFailedError` (generic message) when the
   *   underlying git command fails, no conflict-stage store is configured for a `merged`
   *   resolution, or its recorded bytes are missing.
   */
  async resolveMerge(
    projectId: ProjectId,
    input: GitResolveMergeInput,
  ): Promise<Result<GitResolveMergeOutcome, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    try {
      await ensureCleanWorkingTree(cwd);

      const preHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preHead = readRevParseAnswer(preHeadResult.stdout);

      const remoteReference = `refs/remotes/origin/${input.branch}`;
      let reproducedConflict = false;
      try {
        await runGitCommand(cwd, {
          command: 'merge',
          flags: ['--no-edit'],
          positionals: [remoteReference],
          identity: SERVICE_COMMIT_IDENTITY,
        });
      } catch (error) {
        const conflicts = await readMergeConflicts(cwd);
        if (conflicts.length === 0) {
          // No unmerged paths → a genuine command failure (e.g. the tracking ref no longer
          // exists), not a reproduction of the original conflict.
          throw error;
        }
        reproducedConflict = true;
      }

      if (reproducedConflict) {
        const stillConflicted = await this.applyResolutionsOrAbort(cwd, input);
        if (stillConflicted) {
          return { success: true, value: stillConflicted };
        }

        await runGitCommand(cwd, { command: 'commit', flags: ['--no-edit'], identity: SERVICE_COMMIT_IDENTITY });
      }

      const headCommitResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const headCommit = readRevParseAnswer(headCommitResult.stdout);
      const changes = await computeMergeChanges(cwd, preHead, headCommit);
      return { success: true, value: { status: 'resolved', headCommit, changes } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The merge could not be completed.') };
    }
  }

  /**
   * Applies every resolution onto the just-reproduced conflicted merge, then verifies no unmerged
   * path remains. Returns the `stillConflicted` outcome (after aborting) when one does; returns
   * null — meaning the caller should proceed straight to `git commit` — when every path is clean.
   *
   * Any throw while applying a resolution (or checking the remaining unmerged set) runs `git merge
   * --abort` before rethrowing, so {@link MergeConflictOps.resolveMerge}'s own `catch` always finds
   * a clean tree.
   *
   * @param cwd - The project's working tree.
   * @param input - The branch, operation id, and every conflicting file's chosen resolution.
   * @returns The `stillConflicted` outcome when a path remains unmerged; null when every path is
   *   clean and the caller should commit.
   */
  private async applyResolutionsOrAbort(
    cwd: string,
    input: GitResolveMergeInput,
  ): Promise<GitResolveMergeOutcome | null> {
    try {
      for (const resolution of input.resolutions) {
        // Guard the caller-supplied path before any write, exactly as the sibling write methods
        // (commit/amend/merge/checkout/discardChanges) do: the `merged` branch writes bytes to
        // `cwd/<path>` directly, so a `..` segment must never reach the filesystem. A throw here runs
        // the method's `git merge --abort` and surfaces as resolveMerge's generic failure.
        if (!staysInsideWorkingTree(cwd, resolution.path)) {
          throw new Error('A resolution path escapes the project working tree.');
        }
        if (resolution.resolution === 'merged') {
          if (!this.conflictStageStore) {
            throw new Error('No conflict stage store is configured to read the merged content from.');
          }
          const merged = await this.conflictStageStore.readMerged(input.operationId, resolution.path);
          if (!merged.success || merged.value === null) {
            throw new Error(`No merged content was recorded for '${resolution.path}'.`);
          }
          await writeFile(path.join(cwd, resolution.path), merged.value);
          await runGitCommand(cwd, { command: 'add', positionals: [resolution.path] });
        } else {
          // The chosen side may be the one that DELETED the file (a modify/delete conflict), whose
          // stage is absent from the reproduced index — `git checkout --ours/--theirs` would fail
          // outright. Read which unmerged stages exist for the path and, when the chosen side's is
          // absent, honor the resolution as "accept the deletion" via `git rm` instead of a
          // checkout+add of a stage that is not there.
          const unmergedStages = await readUnmergedStages(cwd, resolution.path);
          const chosenStage = resolution.resolution === 'ours' ? 2 : 3;
          if (unmergedStages.has(chosenStage)) {
            await runGitCommand(cwd, {
              command: 'checkout',
              flags: [`--${resolution.resolution}`],
              positionals: [resolution.path],
            });
            await runGitCommand(cwd, { command: 'add', positionals: [resolution.path] });
          } else {
            await runGitCommand(cwd, { command: 'rm', positionals: [resolution.path] });
          }
        }
      }

      const remaining = await readMergeConflicts(cwd);
      if (remaining.length > 0) {
        await runGitCommand(cwd, { command: 'merge', flags: ['--abort'] });
        return { status: 'stillConflicted', conflicts: remaining };
      }
      return null;
    } catch (error) {
      await runGitCommand(cwd, { command: 'merge', flags: ['--abort'] }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Restores the working tree to an operation's pre-operation undo snapshot, undoing a pull or
   * switch — whether it left the project `AWAITING_CONFLICT` or already landed cleanly. Touches no
   * network.
   *
   * Reads the snapshot from the configured conflict-stage store by `input.operationId`; captures
   * the pre-reset `HEAD` and the branch it is on; reverts; computes the reversal change-set as the
   * delta from the pre-reset `HEAD` to the now-reverted working tree via the single-argument form of
   * {@link computeMergeChanges} (mirrors how {@link MergeConflictOps.checkout} computes its own
   * change-set) — the exact set the caller needs to revert docs/live editors.
   *
   * The revert is KIND-AWARE, because a branch switch leaves `HEAD` on the TARGET branch (its
   * checkout succeeded; only the stash-pop conflicted), whereas a pull stays on one branch:
   * - When the snapshot carries a `sourceBranch` that differs from the branch `HEAD` is currently
   *   on (a switch being undone), `git checkout --force <sourceBranch>` returns `HEAD` — and the
   *   working-tree content — to the source branch WITHOUT moving any other branch's ref. A plain
   *   `reset --hard <preOpHead>` here would instead move the TARGET branch's ref onto the source
   *   tip, corrupting it and orphaning the target's own commits (data loss). The shelved/live edits
   *   the force-checkout discards were already durably pinned under `refs/adc/undo/<operationId>`
   *   when the switch ran, so nothing is lost.
   * - Otherwise (a pull, or a same-branch case) `git reset --hard <preOpHead>` restores the tree in
   *   place, exactly as before.
   *
   * The returned `branch` is the branch `HEAD` ends on, so the caller can set the repository link's
   * `currentBranch` back to it — restoring the source branch for an undone switch, and the
   * already-current branch (a no-op) for a pull.
   *
   * @param projectId - The project whose working tree to restore.
   * @param input - The operation whose snapshot to restore to.
   * @returns A {@link GitRestoreOutcome}; a `GitCommandFailedError` (generic message) when no
   *   conflict-stage store is configured, no snapshot is recorded for the operation, its recorded
   *   commit is no longer resolvable, or the underlying git command fails.
   */
  async restoreToSnapshot(
    projectId: ProjectId,
    input: GitRestoreToSnapshotInput,
  ): Promise<Result<GitRestoreOutcome, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    if (!this.conflictStageStore) {
      return { success: false, error: new GitCommandFailedError('No conflict stage store is configured.') };
    }

    try {
      const snapshot = await this.conflictStageStore.readSnapshot(input.operationId);
      if (!snapshot.success) return snapshot;
      if (snapshot.value === null) {
        return {
          success: false,
          error: new GitCommandFailedError('No pre-operation snapshot is recorded for this operation.'),
        };
      }

      const preResetHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preResetHead = readRevParseAnswer(preResetHeadResult.stdout);
      const currentBranchResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['--abbrev-ref', 'HEAD'] });
      const currentBranchName = readRevParseAnswer(currentBranchResult.stdout);

      const { sourceBranch, preOpHead } = snapshot.value;
      const revertsSwitch = sourceBranch !== undefined && sourceBranch !== currentBranchName;
      // Revert-switch returns to the source branch and its content without touching the target
      // branch's ref; otherwise reset the current branch to its pre-op head. The moved edits either
      // path discards are already pinned under the backup ref, so nothing is lost.
      await (revertsSwitch
        ? runGitCommand(cwd, { command: 'checkout', flags: ['--force'], positionals: [sourceBranch] })
        : runGitCommand(cwd, { command: 'reset', flags: ['--hard'], positionals: [preOpHead] }));

      const restoredBranch = revertsSwitch ? sourceBranch : currentBranchName;
      const changes = await computeMergeChanges(cwd, preResetHead);
      return { success: true, value: { headCommit: preOpHead, branch: restoredBranch, changes } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The working tree could not be restored.') };
    }
  }
}
