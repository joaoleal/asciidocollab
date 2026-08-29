import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitOperationId, ProjectId } from '@asciidocollab/domain';
import { RealGitCommandRunner } from '../../src/git/git-command-runner.js';
import { FilesystemConflictStageStore } from '../../src/git/filesystem-conflict-stage-store.js';
import { commitAll, createTemporaryStorageRootWithProject } from '../helpers/temporary-git-repo.js';

const execFile = promisify(execFileCallback);

/** A fixed operation id every merge/resolve call in this file is keyed by. */
const OPERATION_ID = GitOperationId.create('550e8400-e29b-41d4-a716-446655440300');

/**
 * Creates a `FilesystemConflictStageStore` rooted at a fresh temp directory — deliberately NOT
 * under the project's `storageRoot`/working tree, mirroring the composition root's invariant that
 * the store must live outside every working tree.
 */
async function createTemporaryConflictStageStore(): Promise<FilesystemConflictStageStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-worker-test-conflict-store-'));
  return new FilesystemConflictStageStore(root);
}

/** Reads the tip commit of the given ref (test setup helper). */
async function readReference(cwd: string, reference: string): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', reference], { cwd });
  return stdout.trim();
}

/** Reads the still-unmerged index entries (`git ls-files -u`) — empty once every conflict is resolved. */
async function readUnmergedIndex(cwd: string): Promise<string> {
  const { stdout } = await execFile('git', ['ls-files', '-u'], { cwd });
  return stdout.trim();
}

/**
 * Builds a project working tree carrying a modify/delete conflict: a base commit adds `base.adoc`;
 * `refs/remotes/origin/main` (the incoming "theirs" side) MODIFIES it; and local `main` (the "ours"
 * side) DELETES it. Merging the remote-tracking ref then leaves exactly one modify/delete conflict
 * — the `:2:` ("ours") index stage absent, `:1:`/`:3:` present — the shape this suite exists to
 * exercise. Setup uses plain `git`, never the code under test.
 */
async function setupModifyDeleteConflict(projectId: string): Promise<{ storageRoot: string; cwd: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);

  await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
  await commitAll(cwd, 'base');

  // "theirs": modify base.adoc on a throwaway branch, then point the remote-tracking ref at it.
  await execFile('git', ['checkout', '-q', '-b', 'incoming'], { cwd });
  await writeFile(path.join(cwd, 'base.adoc'), 'theirs modified\n');
  await commitAll(cwd, 'theirs modifies base.adoc');
  const theirsCommit = await readReference(cwd, 'HEAD');
  await execFile('git', ['update-ref', 'refs/remotes/origin/main', theirsCommit], { cwd });
  await execFile('git', ['checkout', '-q', 'main'], { cwd });
  await execFile('git', ['branch', '-q', '-D', 'incoming'], { cwd });

  // "ours": delete base.adoc on local main.
  await execFile('git', ['rm', '-q', 'base.adoc'], { cwd });
  await commitAll(cwd, 'ours deletes base.adoc');

  return { storageRoot, cwd };
}

/**
 * The mirror of {@link setupModifyDeleteConflict}: `refs/remotes/origin/main` ("theirs") DELETES
 * `base.adoc` while local `main` ("ours") MODIFIES it. Merging then leaves the `:3:` ("theirs")
 * stage absent, `:1:`/`:2:` present.
 */
async function setupDeleteModifyConflict(projectId: string): Promise<{ storageRoot: string; cwd: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);

  await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
  await commitAll(cwd, 'base');

  // "theirs": delete base.adoc on a throwaway branch, then point the remote-tracking ref at it.
  await execFile('git', ['checkout', '-q', '-b', 'incoming'], { cwd });
  await execFile('git', ['rm', '-q', 'base.adoc'], { cwd });
  await commitAll(cwd, 'theirs deletes base.adoc');
  const theirsCommit = await readReference(cwd, 'HEAD');
  await execFile('git', ['update-ref', 'refs/remotes/origin/main', theirsCommit], { cwd });
  await execFile('git', ['checkout', '-q', 'main'], { cwd });
  await execFile('git', ['branch', '-q', '-D', 'incoming'], { cwd });

  // "ours": modify base.adoc on local main.
  await writeFile(path.join(cwd, 'base.adoc'), 'ours modified\n');
  await commitAll(cwd, 'ours modifies base.adoc');

  return { storageRoot, cwd };
}

/**
 * Builds a project whose local `main` is an ancestor of `refs/remotes/origin/main` ("theirs"), which
 * is ahead by one commit adding `remote.adoc` — a clean, non-conflicting merge target. Setup uses
 * plain `git`, never the code under test.
 */
async function setupCleanlyMergeableRemote(projectId: string): Promise<{ storageRoot: string; cwd: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);

  await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
  await commitAll(cwd, 'base');

  await execFile('git', ['checkout', '-q', '-b', 'incoming'], { cwd });
  await writeFile(path.join(cwd, 'remote.adoc'), 'remote\n');
  await commitAll(cwd, 'theirs adds remote.adoc');
  const theirsCommit = await readReference(cwd, 'HEAD');
  await execFile('git', ['update-ref', 'refs/remotes/origin/main', theirsCommit], { cwd });
  await execFile('git', ['checkout', '-q', 'main'], { cwd });
  await execFile('git', ['branch', '-q', '-D', 'incoming'], { cwd });

  return { storageRoot, cwd };
}

describe('RealGitCommandRunner.merge (never-lose-work backup ref)', () => {
  it('pins the pull’s flush commit under refs/adc/undo/<operationId> as the snapshot wipCommit', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440310');
    const { storageRoot, cwd } = await setupCleanlyMergeableRemote(projectId.value);
    const store = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, store);

    // A pull carrying a live edit flush-commits it before merging; that flush commit is the pull's
    // moved work and must be ref-pinned like a branch switch's shelved edits.
    const result = await runner.merge(projectId, {
      branch: 'main',
      flush: [{ path: 'live.adoc', content: 'live edit\n' }],
      operationId: OPERATION_ID,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the merge to succeed');
    expect(result.value.status).toBe('merged');

    // The backup ref resolves to a commit whose `live.adoc` holds the flushed edit — recoverable
    // from git with zero editor dependence — and it is reachable from the post-merge HEAD.
    const backupRef = `refs/adc/undo/${OPERATION_ID.value}`;
    const wipCommit = await readReference(cwd, backupRef);
    expect(wipCommit).toMatch(/^[0-9a-f]{40}$/);
    const { stdout: preserved } = await execFile('git', ['show', `${wipCommit}:live.adoc`], { cwd });
    expect(preserved).toBe('live edit\n');
    await expect(execFile('git', ['merge-base', '--is-ancestor', wipCommit, 'HEAD'], { cwd })).resolves.toBeDefined();

    // The snapshot records that same commit as its `wipCommit` handle, alongside the pre-op head.
    const snapshot = await store.readSnapshot(OPERATION_ID);
    expect(snapshot.success).toBe(true);
    if (!snapshot.success || snapshot.value === null) throw new Error('expected a recorded snapshot');
    expect(snapshot.value.wipCommit).toBe(wipCommit);
  });
});

describe('RealGitCommandRunner.merge (modify/delete conflict capture)', () => {
  it('captures a modify/delete conflict with the deleted "ours" side as null, without hard-failing', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440301');
    const { storageRoot } = await setupModifyDeleteConflict(projectId.value);
    const store = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, store);

    const result = await runner.merge(projectId, { branch: 'main', flush: [], operationId: OPERATION_ID });

    // The absent "ours" index stage must NOT turn the whole merge into a hard `GitCommandFailedError`
    // — the conflict has to SURFACE so the awaiting-conflict resolution flow can be reached.
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the merge to succeed with a conflicted outcome');
    if (result.value.status !== 'conflicted') throw new Error('expected a conflicted outcome');
    expect(result.value.conflicts).toEqual([{ path: 'base.adoc', isBinary: false }]);

    // The captured stages record the deletion as a null "ours", distinct from the present base/theirs.
    expect(await store.readStages(OPERATION_ID, 'base.adoc')).toEqual({
      success: true,
      value: { base: Buffer.from('base\n'), ours: null, theirs: Buffer.from('theirs modified\n'), isBinary: false },
    });
  });

  it('captures a modify/delete conflict with the deleted "theirs" side as null, without hard-failing', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440304');
    const { storageRoot } = await setupDeleteModifyConflict(projectId.value);
    const store = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, store);

    const result = await runner.merge(projectId, { branch: 'main', flush: [], operationId: OPERATION_ID });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the merge to succeed with a conflicted outcome');
    if (result.value.status !== 'conflicted') throw new Error('expected a conflicted outcome');
    expect(result.value.conflicts).toEqual([{ path: 'base.adoc', isBinary: false }]);

    // The mirror of the "ours"-deleted case: the "theirs" side is null, base/ours present.
    expect(await store.readStages(OPERATION_ID, 'base.adoc')).toEqual({
      success: true,
      value: { base: Buffer.from('base\n'), ours: Buffer.from('ours modified\n'), theirs: null, isBinary: false },
    });
  });
});

describe('RealGitCommandRunner.resolveMerge (modify/delete conflict resolution)', () => {
  it('accepts the deletion — resolving "ours" via git rm — leaving no unmerged path and no file', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440302');
    const { storageRoot, cwd } = await setupModifyDeleteConflict(projectId.value);
    const store = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, store);

    const result = await runner.resolveMerge(projectId, {
      branch: 'main',
      operationId: OPERATION_ID,
      resolutions: [{ path: 'base.adoc', resolution: 'ours' }],
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected resolveMerge to succeed');
    expect(result.value.status).toBe('resolved');
    // The chosen side deleted the file, so accepting it removes base.adoc from the working tree...
    await expect(stat(path.join(cwd, 'base.adoc'))).rejects.toThrow();
    // ...and leaves a fully-merged index (no unmerged path remains).
    expect(await readUnmergedIndex(cwd)).toBe('');
  });

  it('keeps the modified side — resolving "theirs" via checkout — restoring the file content', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440303');
    const { storageRoot, cwd } = await setupModifyDeleteConflict(projectId.value);
    const store = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, store);

    const result = await runner.resolveMerge(projectId, {
      branch: 'main',
      operationId: OPERATION_ID,
      resolutions: [{ path: 'base.adoc', resolution: 'theirs' }],
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected resolveMerge to succeed');
    expect(result.value.status).toBe('resolved');
    // Keeping the modified "theirs" side restores base.adoc with that side's content...
    expect(await readFile(path.join(cwd, 'base.adoc'), 'utf8')).toBe('theirs modified\n');
    // ...and leaves a fully-merged index (no unmerged path remains).
    expect(await readUnmergedIndex(cwd)).toBe('');
  });
});
