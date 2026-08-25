import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitCommandFailedError, GitOperationId, ProjectId } from '@asciidocollab/domain';
import { RealGitCommandRunner } from '../../src/git/git-command-runner.js';
import { FilesystemConflictStageStore } from '../../src/git/filesystem-conflict-stage-store.js';
import { commitAll, createTemporaryStorageRootWithProject } from '../helpers/temporary-git-repo.js';

const execFile = promisify(execFileCallback);

/** A fixed operation id every checkout call in this file is keyed by. */
const OPERATION_ID = GitOperationId.create('550e8400-e29b-41d4-a716-446655440099');

/**
 * Creates a `FilesystemConflictStageStore` rooted at a fresh temp directory — deliberately NOT
 * under the project's `storageRoot`/working tree, mirroring the composition root's invariant that
 * the store must live outside every working tree.
 */
async function createTemporaryConflictStageStore(): Promise<FilesystemConflictStageStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-worker-test-conflict-store-'));
  return new FilesystemConflictStageStore(root);
}

/** Reads the working tree's currently checked-out branch name (test setup helper). */
async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return stdout.trim();
}

/** Reads the tip commit of the given ref (test setup helper). */
async function readReference(cwd: string, reference: string): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', reference], { cwd });
  return stdout.trim();
}

/**
 * Creates a project working tree on `main` with a caller-supplied base commit — the shared starting
 * point for the LOCAL branch/checkout integration tests (setup uses plain `git`, not the code under
 * test).
 */
async function setupProjectOnMain(
  projectId: string,
  seed: (cwd: string) => Promise<void>,
): Promise<{ storageRoot: string; cwd: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);
  await seed(cwd);
  await commitAll(cwd, 'base');
  return { storageRoot, cwd };
}

/**
 * Branches off the current `main` tip into `branch`, applies `mutate` to the tree, commits it, then
 * returns to `main` — giving a fixture a second local branch whose content differs (setup helper,
 * plain `git`).
 */
async function addLocalBranch(cwd: string, branch: string, mutate: (cwd: string) => Promise<void>): Promise<void> {
  await execFile('git', ['checkout', '-q', '-b', branch], { cwd });
  await mutate(cwd);
  await commitAll(cwd, `${branch} commit`);
  await execFile('git', ['checkout', '-q', 'main'], { cwd });
}

describe('RealGitCommandRunner.createBranch', () => {
  it('creates a branch listBranches then shows, without switching, and rejects a duplicate name', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440090');
    const { storageRoot, cwd } = await setupProjectOnMain(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    const headBefore = await readReference(cwd, 'HEAD');

    const runner = new RealGitCommandRunner(storageRoot);
    const created = await runner.createBranch(projectId, { name: 'feature' });

    expect(created.success).toBe(true);
    if (!created.success) throw new Error('expected success');
    expect(created.value).toEqual({ name: 'feature' });

    // The ref was created but the working tree did not switch to it: HEAD and current branch unchanged.
    expect(await currentBranch(cwd)).toBe('main');
    expect(await readReference(cwd, 'HEAD')).toBe(headBefore);

    const list = await runner.listBranches(projectId);
    expect(list.success).toBe(true);
    if (!list.success) throw new Error('expected success');
    expect(list.value.current).toBe('main');
    expect([...list.value.branches].toSorted()).toEqual(['feature', 'main']);

    const duplicate = await runner.createBranch(projectId, { name: 'feature' });
    expect(duplicate.success).toBe(false);
    if (duplicate.success) throw new Error('expected failure');
    expect(duplicate.error).toBeInstanceOf(GitCommandFailedError);
  });
});

describe('RealGitCommandRunner.listBranches', () => {
  it('returns the checked-out branch and every local branch name', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440091');
    const { storageRoot, cwd } = await setupProjectOnMain(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addLocalBranch(cwd, 'develop', async (tree) => {
      await writeFile(path.join(tree, 'develop.adoc'), 'develop\n');
    });

    const runner = new RealGitCommandRunner(storageRoot);
    const list = await runner.listBranches(projectId);

    expect(list.success).toBe(true);
    if (!list.success) throw new Error('expected success');
    expect(list.value.current).toBe('main');
    expect([...list.value.branches].toSorted()).toEqual(['develop', 'main']);
  });
});

describe('RealGitCommandRunner.checkout', () => {
  it('writes only the undo snapshot (no files/) on a clean switch', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440089');
    const { storageRoot, cwd } = await setupProjectOnMain(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addLocalBranch(cwd, 'feature', async (tree) => {
      await writeFile(path.join(tree, 'feature.adoc'), 'feature only\n');
    });
    const preSwitchHead = await readReference(cwd, 'HEAD');

    const conflictStageStore = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, conflictStageStore);
    const result = await runner.checkout(projectId, { branch: 'feature', flush: [], stashLocal: true, operationId: OPERATION_ID });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    if (result.value.status !== 'switched') throw new Error('expected switched');

    expect(await conflictStageStore.readSnapshot(OPERATION_ID)).toEqual({
      success: true,
      value: { preOpHead: preSwitchHead, branch: 'feature' },
    });
    expect(await conflictStageStore.readStages(OPERATION_ID, 'base.adoc')).toEqual({ success: true, value: null });
  });

  it('switches cleanly on an empty flush, landing the target branch delta', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440092');
    const { storageRoot, cwd } = await setupProjectOnMain(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addLocalBranch(cwd, 'feature', async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base v2\n');
      await writeFile(path.join(tree, 'feature.adoc'), 'feature only\n');
    });
    const featureTip = await readReference(cwd, 'feature');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.checkout(projectId, { branch: 'feature', flush: [], stashLocal: true, operationId: OPERATION_ID });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    if (result.value.status !== 'switched') throw new Error('expected switched');
    expect(result.value.headCommit).toBe(featureTip);
    expect(await currentBranch(cwd)).toBe('feature');
    expect(result.value.changes).toEqual(
      expect.arrayContaining([
        { type: 'modified', path: 'base.adoc', content: Buffer.from('base v2\n'), mimeType: 'text/asciidoc' },
        { type: 'added', path: 'feature.adoc', content: Buffer.from('feature only\n'), mimeType: 'text/asciidoc' },
      ]),
    );
    expect(result.value.changes).toHaveLength(2);
  });

  it('carries live edits across the switch and includes them in the change-set', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440093');
    const { storageRoot, cwd } = await setupProjectOnMain(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addLocalBranch(cwd, 'feature', async (tree) => {
      await writeFile(path.join(tree, 'feature.adoc'), 'feature only\n');
    });

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.checkout(projectId, {
      branch: 'feature',
      flush: [{ path: 'live.adoc', content: 'live edit\n' }],
      stashLocal: true,
      operationId: OPERATION_ID,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    if (result.value.status !== 'switched') throw new Error('expected switched');
    expect(await currentBranch(cwd)).toBe('feature');
    // The target branch's own file loaded, and the carried live edit re-applied onto it.
    expect(await readFile(path.join(cwd, 'live.adoc'), 'utf8')).toBe('live edit\n');
    expect(await readFile(path.join(cwd, 'feature.adoc'), 'utf8')).toBe('feature only\n');
    expect(result.value.changes).toEqual(
      expect.arrayContaining([
        { type: 'added', path: 'feature.adoc', content: Buffer.from('feature only\n'), mimeType: 'text/asciidoc' },
        { type: 'added', path: 'live.adoc', content: Buffer.from('live edit\n'), mimeType: 'text/asciidoc' },
      ]),
    );
    expect(result.value.changes).toHaveLength(2);
  });

  it('reports a conflict when a carried edit collides with the target, leaving a clean tree', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440094');
    const { storageRoot, cwd } = await setupProjectOnMain(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addLocalBranch(cwd, 'feature', async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'feature version\n');
    });
    const preSwitchHead = await readReference(cwd, 'HEAD');

    const conflictStageStore = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, conflictStageStore);
    const result = await runner.checkout(projectId, {
      branch: 'feature',
      flush: [{ path: 'base.adoc', content: 'local version\n' }],
      stashLocal: true,
      operationId: OPERATION_ID,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    if (result.value.status !== 'conflicted') throw new Error('expected conflicted');
    expect(result.value.conflicts).toEqual([{ path: 'base.adoc', isBinary: false }]);

    // The switch landed on the target branch and the tree is clean (the shelved edit was dropped;
    // the live editors still hold it for the later conflict-resolution flow).
    expect(await currentBranch(cwd)).toBe('feature');
    const { stdout: status } = await execFile('git', ['status', '--porcelain'], { cwd });
    expect(status.trim()).toBe('');
    expect(await readFile(path.join(cwd, 'base.adoc'), 'utf8')).toBe('feature version\n');

    // The three-way stages were captured BEFORE the reset/drop. A stash-pop conflict is modeled by
    // git as a merge of the stash INTO the already-checked-out target branch, so "ours" is the
    // target branch's content and "theirs" is the stashed (carried) local edit.
    expect(await conflictStageStore.readStages(OPERATION_ID, 'base.adoc')).toEqual({
      success: true,
      value: {
        base: Buffer.from('base\n'),
        ours: Buffer.from('feature version\n'),
        theirs: Buffer.from('local version\n'),
        isBinary: false,
      },
    });

    // Every switch leaves an undo target, captured before any flush/stash/checkout ran.
    expect(await conflictStageStore.readSnapshot(OPERATION_ID)).toEqual({
      success: true,
      value: { preOpHead: preSwitchHead, branch: 'feature' },
    });
  });

  it('rejects a flush path escaping the working tree, writing nothing and never switching', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440095');
    const { storageRoot, cwd } = await setupProjectOnMain(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addLocalBranch(cwd, 'feature', async (tree) => {
      await writeFile(path.join(tree, 'feature.adoc'), 'feature only\n');
    });

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.checkout(projectId, {
      branch: 'feature',
      flush: [{ path: '../escaped-by-checkout-test.adoc', content: 'pwned' }],
      stashLocal: true,
      operationId: OPERATION_ID,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
    await expect(stat(path.join(cwd, '..', 'escaped-by-checkout-test.adoc'))).rejects.toThrow();
    expect(await currentBranch(cwd)).toBe('main');
  });

  it('returns GitCommandFailedError for a non-existent target branch', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440096');
    const { storageRoot, cwd } = await setupProjectOnMain(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.checkout(projectId, { branch: 'no-such-branch', flush: [], stashLocal: true, operationId: OPERATION_ID });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(await currentBranch(cwd)).toBe('main');
  });
});
