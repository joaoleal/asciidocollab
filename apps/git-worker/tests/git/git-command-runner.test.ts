import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { GitCommandFailedError, ProjectId } from '@asciidocollab/domain';
import { RealGitCommandRunner } from '../../src/git/git-command-runner.js';
import { RemoteHostNotAllowedError } from '../../src/git/egress-allowlist.js';
import { commitAll, createTemporaryStorageRootWithProject } from '../helpers/temporary-git-repo.js';

const execFile = promisify(execFileCallback);

/** Stages exactly the given files (test setup helper — not the code under test). */
async function stage(cwd: string, ...files: string[]): Promise<void> {
  await execFile('git', ['add', ...files], { cwd });
}

describe('RealGitCommandRunner.getStatus', () => {
  it('returns the current branch and no changes for a clean working tree', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440050');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'content\n');
    await commitAll(cwd, 'init');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.getStatus(projectId);

    expect(result).toEqual({ success: true, value: { currentBranch: 'main', changes: [] } });
  });

  it('reports staged and unstaged changes with the correct type for each', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440051');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);

    await writeFile(path.join(cwd, 'kept.adoc'), 'one\ntwo\nthree\n');
    await writeFile(path.join(cwd, 'to-remove.adoc'), 'bye\n');
    await commitAll(cwd, 'init');

    // Unstaged modification.
    await writeFile(path.join(cwd, 'kept.adoc'), 'one\ntwo\nthree\nfour\n');
    // Staged removal.
    await execFile('git', ['rm', '-q', 'to-remove.adoc'], { cwd });
    // Staged addition.
    await writeFile(path.join(cwd, 'new-staged.adoc'), 'brand new\n');
    await stage(cwd, 'new-staged.adoc');
    // Untracked file.
    await writeFile(path.join(cwd, 'untracked.adoc'), 'not tracked\n');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.getStatus(projectId);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.currentBranch).toBe('main');
    expect(result.value.changes).toEqual(
      expect.arrayContaining([
        { path: 'kept.adoc', changeType: 'modified', staged: false },
        { path: 'to-remove.adoc', changeType: 'removed', staged: true },
        { path: 'new-staged.adoc', changeType: 'added', staged: true },
        { path: 'untracked.adoc', changeType: 'added', staged: false },
      ]),
    );
    expect(result.value.changes).toHaveLength(4);
  });

  it('reports both the staged and unstaged sides of a file with changes in each', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440052');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);

    await writeFile(path.join(cwd, 'both.adoc'), 'v1\n');
    await commitAll(cwd, 'init');

    await writeFile(path.join(cwd, 'both.adoc'), 'v2-staged\n');
    await stage(cwd, 'both.adoc');
    await writeFile(path.join(cwd, 'both.adoc'), 'v3-unstaged\n');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.getStatus(projectId);

    expect(result).toEqual({
      success: true,
      value: {
        currentBranch: 'main',
        changes: expect.arrayContaining([
          { path: 'both.adoc', changeType: 'modified', staged: true },
          { path: 'both.adoc', changeType: 'modified', staged: false },
        ]),
      },
    });
  });

  it('reports a staged rename', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440053');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);

    await writeFile(path.join(cwd, 'old-name.adoc'), 'one\ntwo\nthree\nfour\nfive\n');
    await commitAll(cwd, 'init');
    await execFile('git', ['mv', 'old-name.adoc', 'new-name.adoc'], { cwd });

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.getStatus(projectId);

    expect(result).toEqual({
      success: true,
      value: {
        currentBranch: 'main',
        changes: [{ path: 'new-name.adoc', changeType: 'renamed', staged: true }],
      },
    });
  });

  it('reports the branch name for a detached HEAD as "(detached)"', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440054');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'content\n');
    await commitAll(cwd, 'init');
    await execFile('git', ['checkout', '-q', '--detach'], { cwd });

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.getStatus(projectId);

    expect(result).toEqual({ success: true, value: { currentBranch: '(detached)', changes: [] } });
  });

  it('returns a GitCommandFailedError without throwing when the working tree does not exist', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440055');
    const storageRoot = await mkdtemp(path.join(tmpdir(), 'git-worker-test-empty-storage-'));
    // Deliberately never create `<storageRoot>/<projectId>/` — an uninitialized project.

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.getStatus(projectId);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
    // Security constitution: no raw process output/stderr in the error surfaced to callers.
    expect(result.error.message).not.toMatch(/fatal:|ENOENT/i);
  });

  it('scopes each project to its own working tree under storageRoot', async () => {
    const projectA = ProjectId.create('550e8400-e29b-41d4-a716-446655440056');
    const projectB = ProjectId.create('550e8400-e29b-41d4-a716-446655440057');
    const storageRootA = await createTemporaryStorageRootWithProject(projectA.value);
    await writeFile(path.join(storageRootA, projectA.value, 'a.adoc'), 'content\n');
    await commitAll(path.join(storageRootA, projectA.value), 'init');

    // Project B lives under the SAME storage root but was never initialized.
    const runner = new RealGitCommandRunner(storageRootA);

    const resultA = await runner.getStatus(projectA);
    const resultB = await runner.getStatus(projectB);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(false);
  });
});

describe('RealGitCommandRunner.assertRemoteAllowed', () => {
  it('permits a remote whose host is on the configured egress allowlist', async () => {
    const storageRoot = await mkdtemp(path.join(tmpdir(), 'git-worker-test-egress-'));
    // A public IP literal, so this resolves via the real (default) resolver without any
    // network dependency or DNS lookup.
    const runner = new RealGitCommandRunner(storageRoot, ['93.184.216.34']);

    await expect(runner.assertRemoteAllowed('https://93.184.216.34/org/repo.git')).resolves.toBeUndefined();
  });

  it('rejects a remote whose host is not on the configured egress allowlist', async () => {
    const storageRoot = await mkdtemp(path.join(tmpdir(), 'git-worker-test-egress-'));
    const runner = new RealGitCommandRunner(storageRoot, ['git.example.com']);

    await expect(runner.assertRemoteAllowed('https://not-allowed.example.com/org/repo.git')).rejects.toBeInstanceOf(
      RemoteHostNotAllowedError,
    );
  });

  it('denies every remote when constructed without an explicit allowlist (deny-by-default)', async () => {
    const storageRoot = await mkdtemp(path.join(tmpdir(), 'git-worker-test-egress-'));
    const runner = new RealGitCommandRunner(storageRoot);

    await expect(runner.assertRemoteAllowed('https://github.com/org/repo.git')).rejects.toBeInstanceOf(
      RemoteHostNotAllowedError,
    );
  });
});
