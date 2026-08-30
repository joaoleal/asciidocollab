import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitOperationId, ProjectId } from '@asciidocollab/domain';
import { RealGitCommandRunner } from '../../src/git/git-command-runner.js';
import { FilesystemConflictStageStore } from '../../src/git/filesystem-conflict-stage-store.js';
import { commitAll, createTemporaryStorageRootWithProject } from '../helpers/temporary-git-repo.js';

const execFile = promisify(execFileCallback);

/** Two distinct operation ids the sequential content ops in this file are keyed by. */
const FIRST_OPERATION_ID = GitOperationId.create('550e8400-e29b-41d4-a716-446655440401');
const SECOND_OPERATION_ID = GitOperationId.create('550e8400-e29b-41d4-a716-446655440402');

/** The backup ref namespace `MergeConflictOps` pins each op's moved work under. */
function backupReference(operationId: GitOperationId): string {
  return `refs/adc/undo/${operationId.value}`;
}

/** Creates a `FilesystemConflictStageStore` rooted OUTSIDE any working tree (the store's invariant). */
async function createTemporaryConflictStageStore(): Promise<FilesystemConflictStageStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-worker-test-conflict-store-'));
  return new FilesystemConflictStageStore(root);
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

/**
 * Builds a project whose local `main` is one commit behind `refs/remotes/origin/main` (which adds
 * `remote.adoc`) — a clean, non-conflicting merge target. Setup uses plain `git`, never the code
 * under test.
 */
async function setupCleanlyMergeableRemote(projectId: string): Promise<{ storageRoot: string; cwd: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);

  await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
  await commitAll(cwd, 'base');

  await execFile('git', ['checkout', '-q', '-b', 'incoming'], { cwd });
  await writeFile(path.join(cwd, 'remote.adoc'), 'remote\n');
  await commitAll(cwd, 'theirs adds remote.adoc');
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
  await execFile('git', ['update-ref', 'refs/remotes/origin/main', stdout.trim()], { cwd });
  await execFile('git', ['checkout', '-q', 'main'], { cwd });
  await execFile('git', ['branch', '-q', '-D', 'incoming'], { cwd });

  return { storageRoot, cwd };
}

/**
 * Builds a modify/modify conflict AND a flush: base commit adds `base.adoc`;
 * `refs/remotes/origin/main` ("theirs") and local `main` ("ours") modify it differently. A merge
 * that first flush-commits a live edit to `live.adoc` then conflicts on `base.adoc` — the shape that
 * both pins a backup ref (the flush commit) and leaves the op AWAITING_CONFLICT.
 */
async function setupModifyModifyConflict(projectId: string): Promise<{ storageRoot: string; cwd: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);

  await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
  await commitAll(cwd, 'base');

  await execFile('git', ['checkout', '-q', '-b', 'incoming'], { cwd });
  await writeFile(path.join(cwd, 'base.adoc'), 'theirs modified\n');
  await commitAll(cwd, 'theirs modifies base.adoc');
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
  await execFile('git', ['update-ref', 'refs/remotes/origin/main', stdout.trim()], { cwd });
  await execFile('git', ['checkout', '-q', 'main'], { cwd });
  await execFile('git', ['branch', '-q', '-D', 'incoming'], { cwd });

  await writeFile(path.join(cwd, 'base.adoc'), 'ours modified\n');
  await commitAll(cwd, 'ours modifies base.adoc');

  return { storageRoot, cwd };
}

describe('MergeConflictOps retention (one undo point per project)', () => {
  it('prunes the previous op’s backup ref and snapshot when a second content op records its undo point', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440410');
    const { storageRoot, cwd } = await setupCleanlyMergeableRemote(projectId.value);
    const store = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, store);

    // First content op: a pull carrying a live edit. It flush-commits and pins its moved work under
    // its own backup ref, and records an undo snapshot.
    const first = await runner.merge(projectId, {
      branch: 'main',
      flush: [{ path: 'live.adoc', content: 'live one\n' }],
      operationId: FIRST_OPERATION_ID,
    });
    expect(first.success).toBe(true);
    expect(await readReferenceOrNull(cwd, backupReference(FIRST_OPERATION_ID))).toMatch(/^[0-9a-f]{40}$/);

    // Second content op in the SAME project repo. Its initial snapshot write triggers the inline
    // prune of every OTHER undo point — the first op's.
    const second = await runner.merge(projectId, {
      branch: 'main',
      flush: [{ path: 'live.adoc', content: 'live two\n' }],
      operationId: SECOND_OPERATION_ID,
    });
    expect(second.success).toBe(true);

    // The FIRST op's backup ref and its store snapshot are both gone...
    expect(await readReferenceOrNull(cwd, backupReference(FIRST_OPERATION_ID))).toBeNull();
    expect(await store.readSnapshot(FIRST_OPERATION_ID)).toEqual({ success: true, value: null });

    // ...while the SECOND op's undo point is retained (ref present, snapshot recorded).
    expect(await readReferenceOrNull(cwd, backupReference(SECOND_OPERATION_ID))).toMatch(/^[0-9a-f]{40}$/);
    const retained = await store.readSnapshot(SECOND_OPERATION_ID);
    expect(retained.success).toBe(true);
    if (!retained.success || retained.value === null) throw new Error('expected the second op’s snapshot to be retained');
  });

  it('retains a conflicted merge’s backup ref and snapshot across resolveMerge (a completed resolution stays undoable)', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440411');
    const { storageRoot, cwd } = await setupModifyModifyConflict(projectId.value);
    const store = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, store);

    // A conflicted pull that also flushed a live edit: the flush commit is pinned under the backup
    // ref, and the op is left AWAITING_CONFLICT with a recorded snapshot.
    const merged = await runner.merge(projectId, {
      branch: 'main',
      flush: [{ path: 'live.adoc', content: 'live edit\n' }],
      operationId: FIRST_OPERATION_ID,
    });
    expect(merged.success).toBe(true);
    if (!merged.success || merged.value.status !== 'conflicted') throw new Error('expected a conflicted merge');
    expect(await readReferenceOrNull(cwd, backupReference(FIRST_OPERATION_ID))).toMatch(/^[0-9a-f]{40}$/);

    // Completing the resolution must NOT remove the undo point — resolveMerge never touches it.
    const resolved = await runner.resolveMerge(projectId, {
      branch: 'main',
      operationId: FIRST_OPERATION_ID,
      resolutions: [{ path: 'base.adoc', resolution: 'theirs' }],
    });
    expect(resolved.success).toBe(true);
    if (!resolved.success) throw new Error('expected resolveMerge to succeed');
    expect(resolved.value.status).toBe('resolved');

    // The backup ref and the snapshot both survive the completion, so the op stays undoable.
    expect(await readReferenceOrNull(cwd, backupReference(FIRST_OPERATION_ID))).toMatch(/^[0-9a-f]{40}$/);
    const snapshot = await store.readSnapshot(FIRST_OPERATION_ID);
    expect(snapshot.success).toBe(true);
    if (!snapshot.success || snapshot.value === null) throw new Error('expected the snapshot to be retained after completion');
  });

  it('leaves a prior clean pull’s undo point intact when a later branch switch FAILS, and the failed switch orphans nothing', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440412');
    const { storageRoot, cwd } = await setupCleanlyMergeableRemote(projectId.value);
    const store = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, store);

    // A clean pull carrying a live edit establishes the project's one undo point: it flush-commits,
    // pins its moved work under a backup ref, and records a snapshot.
    const pull = await runner.merge(projectId, {
      branch: 'main',
      flush: [{ path: 'live.adoc', content: 'live one\n' }],
      operationId: FIRST_OPERATION_ID,
    });
    expect(pull.success).toBe(true);
    expect(await readReferenceOrNull(cwd, backupReference(FIRST_OPERATION_ID))).toMatch(/^[0-9a-f]{40}$/);

    // A branch switch to a nonexistent branch FAILS. Its prune must NOT run (the prune is deferred
    // until an op establishes its own undo point), so the pull's undo point cannot be deleted by a
    // switch that never established one of its own.
    const failedSwitch = await runner.checkout(projectId, {
      branch: 'does-not-exist',
      flush: [],
      stashLocal: false,
      operationId: SECOND_OPERATION_ID,
    });
    expect(failedSwitch.success).toBe(false);

    // The prior pull's undo point SURVIVES — its backup ref and snapshot are both intact.
    expect(await readReferenceOrNull(cwd, backupReference(FIRST_OPERATION_ID))).toMatch(/^[0-9a-f]{40}$/);
    const retained = await store.readSnapshot(FIRST_OPERATION_ID);
    expect(retained.success).toBe(true);
    if (!retained.success || retained.value === null) throw new Error('expected the pull’s snapshot to survive the failed switch');

    // The failed switch orphaned nothing: it cleared its own snapshot and left no backup ref.
    expect(await readReferenceOrNull(cwd, backupReference(SECOND_OPERATION_ID))).toBeNull();
    expect(await store.readSnapshot(SECOND_OPERATION_ID)).toEqual({ success: true, value: null });
  });

  it('a failed merge clears its own orphaned snapshot and backup ref (no orphan left)', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440413');
    const { storageRoot, cwd } = await setupCleanlyMergeableRemote(projectId.value);
    const store = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, store);

    // A merge whose remote-tracking ref does not exist: it records its snapshot, flush-commits and
    // pins a backup ref, then the merge command fails with NO unmerged path — a genuine FAILURE, not
    // an AWAITING_CONFLICT conflict.
    const failed = await runner.merge(projectId, {
      branch: 'no-such-remote-branch',
      flush: [{ path: 'live.adoc', content: 'live edit\n' }],
      operationId: FIRST_OPERATION_ID,
    });
    expect(failed.success).toBe(false);

    // The failed op orphaned nothing: its backup ref is gone and its snapshot is cleared.
    expect(await readReferenceOrNull(cwd, backupReference(FIRST_OPERATION_ID))).toBeNull();
    expect(await store.readSnapshot(FIRST_OPERATION_ID)).toEqual({ success: true, value: null });
  });
});
