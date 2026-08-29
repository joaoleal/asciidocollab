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
   * @returns Success (a no-op) when no store is configured, or once recorded; a
   *   `GitCommandFailedError` when the store's write fails.
   */
  private async writeUndoSnapshot(
    operationId: GitOperationId,
    preOpHead: string,
    branch: string,
  ): Promise<Result<void, GitCommandFailedError>> {
    if (!this.conflictStageStore) return { success: true, value: undefined };

    const written = await this.conflictStageStore.writeSnapshot(operationId, { preOpHead, branch });
    if (!written.success) {
      return { success: false, error: new GitCommandFailedError('The pre-operation snapshot could not be recorded.') };
    }
    return { success: true, value: undefined };
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
   * 1. `preOpHead` (`rev-parse HEAD`, BEFORE the flush commit) is recorded as the operation's undo
   *    snapshot via {@link MergeConflictOps.writeUndoSnapshot} — on BOTH the clean and conflicted
   *    paths below, so every pull leaves an undo target.
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
      const snapshotWritten = await this.writeUndoSnapshot(input.operationId, preOpHead, input.branch);
      if (!snapshotWritten.success) return snapshotWritten;

      for (const entry of input.flush) {
        await writeFile(path.join(cwd, entry.path), entry.content, 'utf8');
        await runGitCommand(cwd, { command: 'add', positionals: [entry.path] });
      }

      if (await hasStagedChanges(cwd)) {
        await runGitCommand(cwd, {
          command: 'commit',
          flags: ['-m', FLUSH_COMMIT_MESSAGE],
          identity: SERVICE_COMMIT_IDENTITY,
        });
      }

      const preMergeHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preMergeHead = readRevParseAnswer(preMergeHeadResult.stdout);

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
        if (!captured.success) return captured;

        return { success: true, value: { status: 'conflicted', conflicts } };
      }

      const postMergeHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const postMergeHead = readRevParseAnswer(postMergeHeadResult.stdout);
      if (preMergeHead === postMergeHead) {
        return { success: true, value: { status: 'merged', headCommit: postMergeHead, changes: [] } };
      }

      const changes = await computeMergeChanges(cwd, preMergeHead, postMergeHead);
      return { success: true, value: { status: 'merged', headCommit: postMergeHead, changes } };
    } catch {
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
   *    committed on the source branch. It doubles as the operation's pre-operation undo snapshot
   *    ({@link MergeConflictOps.writeUndoSnapshot}), recorded on BOTH the clean and conflicted paths
   *    below, so every switch leaves an undo target.
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
   *    clean checkout of the target branch (`git reset --hard`) and the now-unneeded stash is dropped
   *    (both run in a `finally`, so a capture failure can never leave the stash undropped), leaving a
   *    defined, clean tree exactly as {@link MergeConflictOps.merge}'s `--abort` does. The live edits
   *    are not lost: they remain live in each collaborator's editor, which the later
   *    conflict-resolution flow reconciles against the reported paths. The `conflicted` outcome is
   *    returned — UNLESS the capture itself failed, in which case a `GitCommandFailedError` is
   *    returned instead, after the reset/drop have already restored a clean tree.
   * 7. On a clean switch, `git add -A` stages the re-applied edits (so a flushed edit to a file absent
   *    from the target branch is captured as an addition), and `changes` is the delta from
   *    `preSwitchHead` to the post-switch working tree ({@link computeMergeChanges} with no second
   *    commit) — the target branch's own content AND the re-applied live edits, per the port contract.
   *    An identical tree yields empty `changes`.
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

    try {
      const preSwitchHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preSwitchHead = readRevParseAnswer(preSwitchHeadResult.stdout);
      // preSwitchHead IS the pre-operation head (a switch never takes a flush commit on the source
      // branch — the flushed edits are carried across by a stash instead), so it doubles as the
      // undo snapshot's `preOpHead`, recorded on BOTH the clean and conflicted paths below.
      const snapshotWritten = await this.writeUndoSnapshot(input.operationId, preSwitchHead, input.branch);
      if (!snapshotWritten.success) return snapshotWritten;

      for (const entry of input.flush) {
        await writeFile(path.join(cwd, entry.path), entry.content, 'utf8');
        await runGitCommand(cwd, { command: 'add', positionals: [entry.path] });
      }

      const stashed = input.stashLocal && (await hasStagedChanges(cwd));
      if (stashed) {
        await runGitCommand(cwd, { command: 'stash', flags: ['push'] });
      }

      await runGitCommand(cwd, { command: 'checkout', positionals: [input.branch] });

      if (stashed) {
        try {
          await runGitCommand(cwd, { command: 'stash', flags: ['pop'] });
        } catch (error) {
          // A failed pop is a content conflict only if it left unmerged paths; otherwise it is a
          // genuine command failure. The stash commit (`stash@{0}`, kept by the failed pop) is the
          // "theirs" side for the binary classification, mirroring how a merge uses `MERGE_HEAD`.
          const conflicts = await readMergeConflicts(cwd, 'stash@{0}');
          if (conflicts.length === 0) {
            throw error;
          }

          // Capture every conflicting path's three-way stages BEFORE the reset/drop — both run in
          // a `finally` so a capture failure can never leave the stash undropped or the tree dirty.
          let captured: Result<void, GitCommandFailedError> = { success: true, value: undefined };
          try {
            captured = await this.captureConflictStages(cwd, input.operationId, conflicts);
          } finally {
            // Restore a clean checkout of the target branch and drop the shelved edits, exactly as
            // `merge --abort` leaves a clean tree. The edits are not lost: they stay live in each
            // collaborator's editor, which the later conflict-resolution flow reconciles.
            await runGitCommand(cwd, { command: 'reset', flags: ['--hard'] });
            await runGitCommand(cwd, { command: 'stash', flags: ['drop'] });
          }
          if (!captured.success) return captured;

          return { success: true, value: { status: 'conflicted', conflicts } };
        }
      }

      // Stage the re-applied edits so a flushed file absent from the target branch is captured as an
      // addition in the change-set (a plain commit-to-worktree diff omits still-untracked files).
      await runGitCommand(cwd, { command: 'add', flags: ['-A'] });

      const postSwitchHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const postSwitchHead = readRevParseAnswer(postSwitchHeadResult.stdout);

      const changes = await computeMergeChanges(cwd, preSwitchHead);
      return { success: true, value: { status: 'switched', headCommit: postSwitchHead, changes } };
    } catch {
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
   * the pre-reset `HEAD`; `git reset --hard <preOpHead>`; computes the reversal change-set as the
   * delta from the pre-reset `HEAD` to the now-reset working tree via the single-argument form of
   * {@link computeMergeChanges} (mirrors how {@link MergeConflictOps.checkout} computes its own
   * change-set) — the exact set the caller needs to revert docs/live editors.
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

      await runGitCommand(cwd, { command: 'reset', flags: ['--hard'], positionals: [snapshot.value.preOpHead] });

      const changes = await computeMergeChanges(cwd, preResetHead);
      return { success: true, value: { headCommit: snapshot.value.preOpHead, changes } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The working tree could not be restored.') };
    }
  }
}
