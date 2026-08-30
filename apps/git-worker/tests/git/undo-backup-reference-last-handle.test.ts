// Regresses the three DATA-LOSS defects around `refs/adc/undo/<operationId>` in `MergeConflictOps`.
// That ref is frequently the ONLY remaining handle on the user's moved uncommitted work: a conflicted
// switch drops the stash stack entry once the shelved edits are pinned, and a clean switch's
// successful `git stash pop` consumes it outright. `cleanupFailedOperationUndoPoint` DELETES the ref,
// and the worker runs `ensureCleanWorkingTree` (`reset --hard` + `clean -fdx`) before the next job, so
// a cleanup that fires while the ref is the last handle destroys the edits with nothing left to
// recover them from. Cleanup exists only to remove ORPHANED/half-recorded undo points; when in doubt
// the ref must LEAK (a later op's inline prune and the sweeper reclaim it) rather than be deleted.
//
// The three cases pinned down here:
//  1. conflicted switch, pin SUCCEEDS then `captureConflictStages` fails → the ref must survive;
//  2. clean switch whose post-pop tail throws (`git add -A`) → the ref must survive;
//  3. conflicted switch whose `wipCommit` snapshot write fails → the inline prune must NOT run, so
//     every OTHER op's undo point survives (the current op would otherwise be left with a ref and no
//     snapshot behind it — zero usable undo points for the project).
//
// Case 2 needs a failure injected into one specific git call in the clean-switch tail; as in
// `merge-conflict-undo-ordering.test.ts`, native ESM means `jest.mock()` cannot intercept the static
// import inside `merge-conflict-ops.ts`, so the mock is registered with `jest.unstable_mockModule` and
// the code under test is loaded via a dynamic `import()` afterwards. Cases 1 and 3 need no git mocking
// at all — the store seam (`FailingConflictStageStore`) is enough — so they use the statically
// imported class, which is never affected by case 2's registration.
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitOperationId, ProjectId } from '@asciidocollab/domain';
import * as RealRunGitCommand from '../../src/git/run-git-command.js';
import type { GitCommandResult, GitCommandSpec } from '../../src/git/run-git-command.js';
import { FilesystemConflictStageStore } from '../../src/git/filesystem-conflict-stage-store.js';
import { MergeConflictOps } from '../../src/git/merge-conflict-ops.js';
import { commitAll, createTemporaryStorageRootWithProject } from '../helpers/temporary-git-repo.js';
import { FailingConflictStageStore } from '../helpers/failing-conflict-stage-store.js';

const execFile = promisify(execFileCallback);

// See `merge-conflict-undo-ordering.test.ts` for why the mocked specifier is an absolute path to the
// `.ts` source rather than a relative `.js` one.
const RUN_GIT_COMMAND_MODULE = fileURLToPath(new URL('../../src/git/run-git-command.ts', import.meta.url));

/** The operation the switch under test is keyed by. */
const OPERATION_ID = GitOperationId.create('550e8400-e29b-41d4-a716-446655440601');
/** A prior operation whose complete undo point (ref + snapshot) must survive the failures below. */
const PRIOR_OPERATION_ID = GitOperationId.create('550e8400-e29b-41d4-a716-446655440602');

/** The backup ref namespace each content op pins its moved work under. */
function backupReference(operationId: GitOperationId): string {
  return `refs/adc/undo/${operationId.value}`;
}

/** Reads the tip commit of a ref, or null when it does not exist. */
async function readReferenceOrNull(cwd: string, reference: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--verify', '--quiet', reference], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Reads one file's content out of a commit, proving the moved work is still recoverable from git. */
async function readFileAtCommit(cwd: string, commit: string, filePath: string): Promise<string> {
  const { stdout } = await execFile('git', ['show', `${commit}:${filePath}`], { cwd });
  return stdout;
}

/** A fresh `FilesystemConflictStageStore` rooted OUTSIDE every project's working tree. */
async function createTemporaryConflictStageStore(): Promise<FilesystemConflictStageStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-worker-test-conflict-store-'));
  return new FilesystemConflictStageStore(root);
}

/**
 * Builds a project on `main` with `base.adoc`, plus a `feature` branch that rewrites that same file —
 * so flushing a third version of `base.adoc` across the switch makes the stash-pop CONFLICT (setup
 * uses plain `git`, never the code under test).
 */
async function setupCollidingSwitch(projectId: string): Promise<{ storageRoot: string; cwd: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);

  await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
  await commitAll(cwd, 'base');

  await execFile('git', ['checkout', '-q', '-b', 'feature'], { cwd });
  await writeFile(path.join(cwd, 'base.adoc'), 'feature version\n');
  await commitAll(cwd, 'feature rewrites base.adoc');
  await execFile('git', ['checkout', '-q', 'main'], { cwd });

  return { storageRoot, cwd };
}

/**
 * Builds a project on `main` with `base.adoc`, plus a `feature` branch that adds an UNRELATED file —
 * so a flushed `live.adoc` pops cleanly onto the target branch.
 */
async function setupCleanSwitch(projectId: string): Promise<{ storageRoot: string; cwd: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);

  await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
  await commitAll(cwd, 'base');

  await execFile('git', ['checkout', '-q', '-b', 'feature'], { cwd });
  await writeFile(path.join(cwd, 'feature.adoc'), 'feature only\n');
  await commitAll(cwd, 'feature adds feature.adoc');
  await execFile('git', ['checkout', '-q', 'main'], { cwd });

  return { storageRoot, cwd };
}

/**
 * Wraps the real `runGitCommand` so the `failOnOccurrence`-th call matching `matches` throws instead
 * of running for real; every other call delegates untouched. (Same helper shape as
 * `merge-conflict-undo-ordering.test.ts`.)
 */
function createFailOnNthMatchRunGitCommand(
  matches: (spec: GitCommandSpec) => boolean,
  failOnOccurrence: number,
): typeof RealRunGitCommand.runGitCommand {
  let occurrence = 0;
  return async (cwd: string, spec: GitCommandSpec): Promise<GitCommandResult> => {
    if (matches(spec)) {
      occurrence += 1;
      if (occurrence === failOnOccurrence) {
        throw new Error('injected post-pop tail failure');
      }
    }
    return RealRunGitCommand.runGitCommand(cwd, spec);
  };
}

describe('MergeConflictOps.checkout (a failed conflicted switch never deletes the last handle)', () => {
  it('keeps the backup ref pointing at the shelved edits when the stage capture fails AFTER the pin', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440610');
    const { storageRoot, cwd } = await setupCollidingSwitch(projectId.value);
    // Only `writeStages` fails, so the pre-mutation snapshot is recorded and the switch runs all the
    // way to a real stash-pop conflict — then the capture fails, exactly as a store I/O outage would.
    const store = await FailingConflictStageStore.create('writeStages');
    const mergeConflictOps = new MergeConflictOps(storageRoot, store);

    const result = await mergeConflictOps.checkout(projectId, {
      branch: 'feature',
      flush: [{ path: 'base.adoc', content: 'local version\n' }],
      stashLocal: true,
      operationId: OPERATION_ID,
    });

    // The op still FAILS — a conflict whose stages were not captured can never be resolved.
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected the conflicted switch to fail');
    expect(result.error.message).toBe('The conflict could not be recorded.');

    // ...but the user's moved edits are NOT lost. The pin succeeded, so the stash stack entry was
    // dropped and the backup ref is the SOLE handle on the shelved work: the failure cleanup must
    // have left it alone. The ref still resolves, and the commit it names still holds the carried
    // edit — recoverable from git with zero dependence on any editor.
    const pinned = await readReferenceOrNull(cwd, backupReference(OPERATION_ID));
    expect(pinned).toMatch(/^[0-9a-f]{40}$/);
    if (pinned === null) throw new Error('expected the backup ref to survive the failed capture');
    expect(await readFileAtCommit(cwd, pinned, 'base.adoc')).toBe('local version\n');

    // The stack entry really is gone, so the ref genuinely was the last handle (this is what makes
    // deleting it unrecoverable, and what the pre-fix cleanup did).
    const { stdout: stashList } = await execFile('git', ['stash', 'list'], { cwd });
    expect(stashList.trim()).toBe('');

    // The snapshot is deliberately leaked alongside the ref rather than cleared: retention (a later
    // op's inline prune, or the sweeper) reclaims the pair once it is genuinely redundant.
    const snapshot = await store.readSnapshot(OPERATION_ID);
    expect(snapshot.success).toBe(true);
    if (!snapshot.success || snapshot.value === null) {
      throw new Error('expected the leaked snapshot to survive alongside its backup ref');
    }
  });

  it('does not prune the other ops’ undo points when the wipCommit snapshot write fails', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440611');
    const { storageRoot, cwd } = await setupCollidingSwitch(projectId.value);

    // One store root, two views of it: `delegate` seeds the PRIOR op's undo point without consuming
    // the failing store's call count, while `store` is what the switch runs against. `writeSnapshot`
    // is refused from its SECOND call on — the pre-mutation base snapshot lands, and only the upgrade
    // naming the pinned `wipCommit` fails, which is the sequence the defect lives in.
    const storeRoot = await mkdtemp(path.join(tmpdir(), 'git-worker-test-conflict-store-'));
    const delegate = new FilesystemConflictStageStore(storeRoot);
    const store = new FailingConflictStageStore(delegate, 'writeSnapshot', 2);

    // A prior op holds the project's one complete undo point: a backup ref and its snapshot.
    const { stdout: priorCommitOutput } = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
    const priorCommit = priorCommitOutput.trim();
    await execFile('git', ['update-ref', backupReference(PRIOR_OPERATION_ID), priorCommit], { cwd });
    const priorSnapshot = { preOpHead: priorCommit, branch: 'main' };
    expect(await delegate.writeSnapshot(PRIOR_OPERATION_ID, priorSnapshot)).toEqual({
      success: true,
      value: undefined,
    });

    const mergeConflictOps = new MergeConflictOps(storageRoot, store);
    const result = await mergeConflictOps.checkout(projectId, {
      branch: 'feature',
      flush: [{ path: 'base.adoc', content: 'local version\n' }],
      stashLocal: true,
      operationId: OPERATION_ID,
    });

    // The conflict is still reported: the shelved edits were pinned, so the switch is correctly
    // AWAITING_CONFLICT even though the snapshot upgrade could not be written.
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected a conflicted outcome');
    expect(result.value.status).toBe('conflicted');

    // The prune must have been SKIPPED. This op's snapshot no longer matches its backup ref (the
    // upgrade failed), so it holds no coherent undo point of its own — pruning on the strength of it
    // would have left the project with a ref whose snapshot is missing, i.e. zero usable undo points.
    expect(await readReferenceOrNull(cwd, backupReference(PRIOR_OPERATION_ID))).toBe(priorCommit);
    expect(await delegate.readSnapshot(PRIOR_OPERATION_ID)).toEqual({ success: true, value: priorSnapshot });
  });
});

describe('MergeConflictOps.checkout (a failing post-pop tail never deletes the last handle)', () => {
  // Each test registers its own `run-git-command.js` mock and loads a fresh `MergeConflictOps` via a
  // dynamic import — `resetModules` clears jest's ESM registry so the mock actually takes effect.
  beforeEach(() => {
    jest.resetModules();
  });

  it('keeps the backup ref pointing at the popped edits when `git add -A` fails after the pop', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440612');
    const { storageRoot, cwd } = await setupCleanSwitch(projectId.value);
    const store = await createTemporaryConflictStageStore();

    // Fail the `git add -A` that stages the re-applied edits — the first step of the tail that runs
    // AFTER the successful `git stash pop` has already consumed the stash stack entry. The flush's own
    // `git add <path>` carries positionals rather than `-A`, so this matcher hits only the tail call.
    jest.unstable_mockModule(RUN_GIT_COMMAND_MODULE, () => ({
      ...RealRunGitCommand,
      runGitCommand: createFailOnNthMatchRunGitCommand(
        (spec) => spec.command === 'add' && (spec.flags ?? []).includes('-A'),
        1,
      ),
    }));
    const { MergeConflictOps: MergeConflictOpsUnderTest } = await import('../../src/git/merge-conflict-ops.js');
    const mergeConflictOps = new MergeConflictOpsUnderTest(storageRoot, store);

    const result = await mergeConflictOps.checkout(projectId, {
      branch: 'feature',
      flush: [{ path: 'live.adoc', content: 'live edit\n' }],
      stashLocal: true,
      operationId: OPERATION_ID,
    });

    expect(result.success).toBe(false);

    // The pop consumed the stash stack entry, so the backup ref is the ONLY handle on the carried
    // edits — and the worker wipes the working tree (`ensureCleanWorkingTree`) before its next job.
    // The outer `catch`'s cleanup must therefore have left the ref alone: it still resolves, and the
    // commit it names still holds the carried edit.
    const { stdout: stashList } = await execFile('git', ['stash', 'list'], { cwd });
    expect(stashList.trim()).toBe('');
    const pinned = await readReferenceOrNull(cwd, backupReference(OPERATION_ID));
    expect(pinned).toMatch(/^[0-9a-f]{40}$/);
    if (pinned === null) throw new Error('expected the backup ref to survive the failed tail');
    expect(await readFileAtCommit(cwd, pinned, 'live.adoc')).toBe('live edit\n');

    // Its snapshot is leaked with it (naming that same commit as the `wipCommit` handle), so a
    // recovery has both halves of the undo point rather than a ref with nothing behind it.
    const snapshot = await store.readSnapshot(OPERATION_ID);
    expect(snapshot.success).toBe(true);
    if (!snapshot.success || snapshot.value === null) {
      throw new Error('expected the leaked snapshot to survive alongside its backup ref');
    }
    expect(snapshot.value.wipCommit).toBe(pinned);
  });
});
