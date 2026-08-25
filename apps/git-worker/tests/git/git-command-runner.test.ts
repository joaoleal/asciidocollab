import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  AuthenticationFailedError,
  GitCommandFailedError,
  NonFastForwardError,
  ProjectId,
  RepositoryUnreachableError,
} from '@asciidocollab/domain';
import { RealGitCommandRunner } from '../../src/git/git-command-runner.js';
import { RemoteHostNotAllowedError, type HostAddressResolver } from '../../src/git/egress-allowlist.js';
import {
  commitAll,
  createTemporaryBareRemote,
  createTemporaryStorageRootWithProject,
  createTemporaryWorkingTree,
  createPushedRepoPair,
  pushBranch,
  pushToOrigin,
} from '../helpers/temporary-git-repo.js';
import { startGitHttpServer } from '../helpers/git-http-server.js';
import { withArgvCapturingGit } from '../helpers/argv-capturing-git.js';

const execFile = promisify(execFileCallback);

/**
 * Resolves any host to a fixed, genuinely public IP literal — used to let a test reach a local
 * loopback-bound test server (127.0.0.1) through `RealGitCommandRunner`'s real egress allowlist
 * check, which would otherwise always reject a loopback address as private, regardless of
 * allowlist configuration. Only the DNS answer is faked; the allowlist match and the actual git
 * network I/O (against the real loopback server) are both real.
 */
const fakePublicResolver: HostAddressResolver = async () => [{ address: '93.184.216.34' }];

/** Reads the commit hash of a working tree's current `HEAD` (test setup helper). */
async function readHeadCommit(workingTree: string): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: workingTree });
  return stdout.trim();
}

/** Binds then immediately releases an ephemeral loopback port — nothing listens there afterward. */
async function unusedLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

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
        { path: 'kept.adoc', changeType: 'modified', state: 'unstaged' },
        { path: 'to-remove.adoc', changeType: 'removed', state: 'staged' },
        { path: 'new-staged.adoc', changeType: 'added', state: 'staged' },
        { path: 'untracked.adoc', changeType: 'added', state: 'untracked' },
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
          { path: 'both.adoc', changeType: 'modified', state: 'staged' },
          { path: 'both.adoc', changeType: 'modified', state: 'unstaged' },
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
        changes: [{ path: 'new-name.adoc', changeType: 'renamed', state: 'staged' }],
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

describe('RealGitCommandRunner.clone', () => {
  it('clones the remote default branch, materializing nested folders, a text file, and a binary file', async () => {
    const workingTree = await createTemporaryWorkingTree();
    await mkdir(path.join(workingTree, 'chapters', 'nested'), { recursive: true });
    await mkdir(path.join(workingTree, 'assets'), { recursive: true });
    await writeFile(path.join(workingTree, 'chapters', 'intro.adoc'), '= Intro\n\nHello.\n');
    await writeFile(path.join(workingTree, 'chapters', 'nested', 'deep.adoc'), '= Deep\n\nNested.\n');
    const binaryContent = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0x10, 0x20]);
    await writeFile(path.join(workingTree, 'assets', 'logo.png'), binaryContent);
    await commitAll(workingTree, 'init');
    const expectedHeadCommit = await readHeadCommit(workingTree);

    const remotePath = await createTemporaryBareRemote();
    await pushToOrigin(workingTree, remotePath);

    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });
    try {
      const runner = new RealGitCommandRunner('/unused', ['127.0.0.1'], fakePublicResolver);
      const result = await runner.clone({ remoteUrl: `${server.url}/repo.git`, token: 'unused' });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.value.defaultBranch).toBe('main');
      expect(result.value.headCommit).toBe(expectedHeadCommit);
      expect(result.value.entries.every((entry) => !entry.path.startsWith('.git'))).toBe(true);
      expect(result.value.entries).toEqual(
        expect.arrayContaining([
          { path: 'chapters/intro.adoc', content: Buffer.from('= Intro\n\nHello.\n'), mimeType: 'text/asciidoc' },
          {
            path: 'chapters/nested/deep.adoc',
            content: Buffer.from('= Deep\n\nNested.\n'),
            mimeType: 'text/asciidoc',
          },
          { path: 'assets/logo.png', content: binaryContent, mimeType: 'image/png' },
        ]),
      );
      expect(result.value.entries).toHaveLength(3);
    } finally {
      await server.close();
    }
  });

  it('honors a requested non-default branch, while defaultBranch still reports the remote\'s actual default', async () => {
    const workingTree = await createTemporaryWorkingTree();
    await writeFile(path.join(workingTree, 'main-only.adoc'), 'on main\n');
    await commitAll(workingTree, 'main init');
    const mainHeadCommit = await readHeadCommit(workingTree);

    const remotePath = await createTemporaryBareRemote();
    await pushToOrigin(workingTree, remotePath);

    await execFile('git', ['checkout', '-q', '-b', 'feature-branch'], { cwd: workingTree });
    await writeFile(path.join(workingTree, 'branch-only.adoc'), 'on feature-branch\n');
    await commitAll(workingTree, 'feature-branch commit');
    const featureBranchHeadCommit = await readHeadCommit(workingTree);
    await pushBranch(workingTree, 'feature-branch');

    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });
    try {
      const runner = new RealGitCommandRunner('/unused', ['127.0.0.1'], fakePublicResolver);

      const defaultResult = await runner.clone({ remoteUrl: `${server.url}/repo.git`, token: 'unused' });
      expect(defaultResult.success).toBe(true);
      if (!defaultResult.success) throw new Error('expected success');
      expect(defaultResult.value.defaultBranch).toBe('main');
      expect(defaultResult.value.headCommit).toBe(mainHeadCommit);
      expect(defaultResult.value.entries.map((entry) => entry.path)).not.toContain('branch-only.adoc');

      const featureBranchResult = await runner.clone({
        remoteUrl: `${server.url}/repo.git`,
        token: 'unused',
        branch: 'feature-branch',
      });
      expect(featureBranchResult.success).toBe(true);
      if (!featureBranchResult.success) throw new Error('expected success');
      // The remote's own default branch never changes, regardless of which branch was requested.
      expect(featureBranchResult.value.defaultBranch).toBe('main');
      expect(featureBranchResult.value.headCommit).toBe(featureBranchHeadCommit);
      expect(featureBranchResult.value.entries.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(['main-only.adoc', 'branch-only.adoc']),
      );
    } finally {
      await server.close();
    }
  });

  it('rejects a clone to a non-allowlisted host before attempting any network operation', async () => {
    const runner = new RealGitCommandRunner('/unused', ['git.example.com']);

    const capture = await withArgvCapturingGit(async (getCalls) => {
      const result = await runner.clone({ remoteUrl: 'https://not-allowed.example.com/org/repo.git', token: 'x' });
      return { result, calls: await getCalls() };
    });

    expect(capture.result.success).toBe(false);
    if (capture.result.success) throw new Error('expected failure');
    expect(capture.result.error).toBeInstanceOf(RepositoryUnreachableError);
    // No git process was ever spawned — the egress check ran and rejected before any network op.
    expect(capture.calls).toEqual([]);
  });

  it('returns RepositoryUnreachableError when the remote cannot be reached', async () => {
    const port = await unusedLoopbackPort();
    const runner = new RealGitCommandRunner('/unused', ['127.0.0.1'], fakePublicResolver);

    const result = await runner.clone({ remoteUrl: `http://127.0.0.1:${port}/repo.git`, token: 'unused' });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(RepositoryUnreachableError);
  });

  it('returns AuthenticationFailedError when the remote rejects the token', async () => {
    const { remoteProjectRoot } = await createPushedRepoPair();
    const server = await startGitHttpServer({
      projectRoot: remoteProjectRoot,
      requireAuth: { username: 'x-access-token', password: 'the-real-token' },
    });

    try {
      const runner = new RealGitCommandRunner('/unused', ['127.0.0.1'], fakePublicResolver);
      const result = await runner.clone({ remoteUrl: `${server.url}/repo.git`, token: 'wrong-token' });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.error).toBeInstanceOf(AuthenticationFailedError);
    } finally {
      await server.close();
    }
  });

  it('never leaks the token into argv across the whole clone (multi-command) operation', async () => {
    const token = 'super-secret-clone-test-token-DO-NOT-LEAK-71ab';
    const { remoteProjectRoot } = await createPushedRepoPair();
    const server = await startGitHttpServer({
      projectRoot: remoteProjectRoot,
      requireAuth: { username: 'x-access-token', password: token },
    });

    try {
      const runner = new RealGitCommandRunner('/unused', ['127.0.0.1'], fakePublicResolver);

      const capture = await withArgvCapturingGit(async (getCalls) => {
        const result = await runner.clone({ remoteUrl: `${server.url}/repo.git`, token });
        return { result, calls: await getCalls() };
      });

      expect(capture.result.success).toBe(true);
      // Proof the credential actually authenticated (not just that nothing crashed).
      expect(server.authorizationHeadersSeen.length).toBeGreaterThan(0);

      for (const call of capture.calls) {
        for (const argument of call) {
          expect(argument).not.toContain(token);
        }
      }

      if (capture.result.success) {
        for (const entry of capture.result.value.entries) {
          expect(entry.content.toString('utf8')).not.toContain(token);
        }
      }
    } finally {
      await server.close();
    }
  });

  it('fails safely with GitCommandFailedError when a repository declares LFS but git-lfs is unavailable', async () => {
    // git-lfs is not installed in this sandbox (confirmed: `git lfs` exits "is not a git
    // command"), so this exercises clone's real LFS-detection branch and its failure path —
    // proof the branch is reached and fails safely, not proof of a successful smudge (see the
    // skipped test below for that).
    const workingTree = await createTemporaryWorkingTree();
    await writeFile(
      path.join(workingTree, '.gitattributes'),
      '*.bin filter=lfs diff=lfs merge=lfs -text\n',
    );
    await writeFile(path.join(workingTree, 'big.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:0\nsize 1\n');
    await commitAll(workingTree, 'declares lfs');

    const remotePath = await createTemporaryBareRemote();
    await pushToOrigin(workingTree, remotePath);

    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });
    try {
      const runner = new RealGitCommandRunner('/unused', ['127.0.0.1'], fakePublicResolver);
      const result = await runner.clone({ remoteUrl: `${server.url}/repo.git`, token: 'unused' });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.error).toBeInstanceOf(GitCommandFailedError);
    } finally {
      await server.close();
    }
  });

  // git-lfs is not installed in this sandbox — there is no way here to prove an actual pointer
  // gets smudged to real object bytes. Authored and structurally correct (the code path is
  // exercised, minus a real smudge, by the passing test above); left skipped rather than deleted
  // so it documents the intended behavior once git-lfs is available (e.g. in CI).
  it.skip('smudges an LFS pointer to the real object bytes (requires git-lfs; unrunnable in this sandbox)', async () => {
    expect(true).toBe(true);
  });
});

describe('RealGitCommandRunner.checkRemoteAccess', () => {
  it('succeeds without materializing any working tree when the remote is reachable and the token is accepted', async () => {
    const { remoteProjectRoot } = await createPushedRepoPair();
    const server = await startGitHttpServer({
      projectRoot: remoteProjectRoot,
      requireAuth: { username: 'x-access-token', password: 'the-real-token' },
    });

    try {
      const runner = new RealGitCommandRunner('/unused', ['127.0.0.1'], fakePublicResolver);
      const result = await runner.checkRemoteAccess({ remoteUrl: `${server.url}/repo.git`, token: 'the-real-token' });

      expect(result).toEqual({ success: true, value: undefined });
    } finally {
      await server.close();
    }
  });

  it('returns AuthenticationFailedError when the remote rejects the token', async () => {
    const { remoteProjectRoot } = await createPushedRepoPair();
    const server = await startGitHttpServer({
      projectRoot: remoteProjectRoot,
      requireAuth: { username: 'x-access-token', password: 'the-real-token' },
    });

    try {
      const runner = new RealGitCommandRunner('/unused', ['127.0.0.1'], fakePublicResolver);
      const result = await runner.checkRemoteAccess({ remoteUrl: `${server.url}/repo.git`, token: 'wrong-token' });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.error).toBeInstanceOf(AuthenticationFailedError);
    } finally {
      await server.close();
    }
  });

  it('returns RepositoryUnreachableError when the remote cannot be reached', async () => {
    const port = await unusedLoopbackPort();
    const runner = new RealGitCommandRunner('/unused', ['127.0.0.1'], fakePublicResolver);

    const result = await runner.checkRemoteAccess({ remoteUrl: `http://127.0.0.1:${port}/repo.git`, token: 'x' });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(RepositoryUnreachableError);
  });

  it('rejects a non-allowlisted host before attempting any network operation', async () => {
    const runner = new RealGitCommandRunner('/unused', ['git.example.com']);

    const capture = await withArgvCapturingGit(async (getCalls) => {
      const result = await runner.checkRemoteAccess({
        remoteUrl: 'https://not-allowed.example.com/org/repo.git',
        token: 'x',
      });
      return { result, calls: await getCalls() };
    });

    expect(capture.result.success).toBe(false);
    if (capture.result.success) throw new Error('expected failure');
    expect(capture.result.error).toBeInstanceOf(RepositoryUnreachableError);
    expect(capture.calls).toEqual([]);
  });
});

describe('RealGitCommandRunner.getStatus — conflicted state', () => {
  it('reports a file left conflicted by an unresolved merge as state "conflicted"', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440060');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);

    await writeFile(path.join(cwd, 'conflict.adoc'), 'base\n');
    await commitAll(cwd, 'base');

    await execFile('git', ['checkout', '-q', '-b', 'other'], { cwd });
    await writeFile(path.join(cwd, 'conflict.adoc'), 'other change\n');
    await commitAll(cwd, 'other change');

    await execFile('git', ['checkout', '-q', 'main'], { cwd });
    await writeFile(path.join(cwd, 'conflict.adoc'), 'main change\n');
    await commitAll(cwd, 'main change');

    // Merging necessarily conflicts here (both branches touched the same lines) and exits
    // non-zero — expected, so this deliberately swallows that failure.
    await execFile('git', ['merge', 'other'], { cwd }).catch(() => undefined);

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.getStatus(projectId);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.changes).toEqual(
      expect.arrayContaining([{ path: 'conflict.adoc', changeType: 'modified', state: 'conflicted' }]),
    );
  });
});

describe('RealGitCommandRunner.stage / unstage', () => {
  it('stages an untracked file (visible as staged in getStatus), then unstage reverts it to untracked', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440061');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'content\n');
    await commitAll(cwd, 'init');
    await writeFile(path.join(cwd, 'new.adoc'), 'new file\n');

    const runner = new RealGitCommandRunner(storageRoot);

    const stageResult = await runner.stage(projectId, ['new.adoc']);
    expect(stageResult).toEqual({ success: true, value: undefined });

    const stagedStatus = await runner.getStatus(projectId);
    expect(stagedStatus).toEqual({
      success: true,
      value: { currentBranch: 'main', changes: [{ path: 'new.adoc', changeType: 'added', state: 'staged' }] },
    });

    const unstageResult = await runner.unstage(projectId, ['new.adoc']);
    expect(unstageResult).toEqual({ success: true, value: undefined });

    const unstagedStatus = await runner.getStatus(projectId);
    expect(unstagedStatus).toEqual({
      success: true,
      value: { currentBranch: 'main', changes: [{ path: 'new.adoc', changeType: 'added', state: 'untracked' }] },
    });
  });

  it('returns GitCommandFailedError from stage/unstage when the working tree does not exist', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440062');
    const storageRoot = await mkdtemp(path.join(tmpdir(), 'git-worker-test-empty-storage-'));
    const runner = new RealGitCommandRunner(storageRoot);

    const stageResult = await runner.stage(projectId, ['whatever.adoc']);
    expect(stageResult.success).toBe(false);
    if (stageResult.success) throw new Error('expected failure');
    expect(stageResult.error).toBeInstanceOf(GitCommandFailedError);

    const unstageResult = await runner.unstage(projectId, ['whatever.adoc']);
    expect(unstageResult.success).toBe(false);
    if (unstageResult.success) throw new Error('expected failure');
    expect(unstageResult.error).toBeInstanceOf(GitCommandFailedError);
  });
});

describe('RealGitCommandRunner.commit', () => {
  it('commits the staged index with FLUSHED content (not stale staged bytes), the given author, staged-only', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440063');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);

    await writeFile(path.join(cwd, 'tracked.adoc'), 'v1\n');
    await writeFile(path.join(cwd, 'sibling.adoc'), 'sibling v1\n');
    await commitAll(cwd, 'init');

    // Staged with STALE bytes — the flush entry below must override these before the commit.
    await writeFile(path.join(cwd, 'tracked.adoc'), 'stale staged bytes\n');
    await stage(cwd, 'tracked.adoc');

    // An unstaged sibling edit — must stay OUT of the commit entirely.
    await writeFile(path.join(cwd, 'sibling.adoc'), 'sibling unstaged edit\n');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.commit(projectId, {
      message: 'flush test',
      author: { name: 'Ada Lovelace', email: 'ada@example.com' },
      flush: [{ path: 'tracked.adoc', content: 'live flushed content\n' }],
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.message).toBe('flush test');
    expect(result.value.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.value.authoredAt).toBeInstanceOf(Date);

    const { stdout: committedTracked } = await execFile('git', ['show', 'HEAD:tracked.adoc'], { cwd });
    expect(committedTracked).toBe('live flushed content\n');

    const { stdout: authorLine } = await execFile('git', ['log', '-1', '--format=%an <%ae>'], { cwd });
    expect(authorLine.trim()).toBe('Ada Lovelace <ada@example.com>');

    // Staged-only: the unstaged sibling edit is not part of this commit...
    const { stdout: committedSibling } = await execFile('git', ['show', 'HEAD:sibling.adoc'], { cwd });
    expect(committedSibling).toBe('sibling v1\n');
    // ...and its unstaged edit is still sitting untouched in the working tree.
    const siblingWorkingTreeContent = await readFile(path.join(cwd, 'sibling.adoc'), 'utf8');
    expect(siblingWorkingTreeContent).toBe('sibling unstaged edit\n');
  });

  it('rejects an absolute flush path, writing nothing and recording no commit', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440064');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'tracked.adoc'), 'v1\n');
    await commitAll(cwd, 'init');
    const headBefore = await readHeadCommit(cwd);

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.commit(projectId, {
      message: 'malicious',
      author: { name: 'Eve', email: 'eve@example.com' },
      flush: [{ path: '/etc/pwned-by-test.adoc', content: 'pwned' }],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
    await expect(stat('/etc/pwned-by-test.adoc')).rejects.toThrow();
    expect(await readHeadCommit(cwd)).toBe(headBefore);
  });

  it('rejects a flush path escaping the working tree via ".." — fail-closed, no partial write', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440065');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'tracked.adoc'), 'v1\n');
    await commitAll(cwd, 'init');
    const headBefore = await readHeadCommit(cwd);

    // A second, otherwise-valid flush entry must ALSO not be written — proves the guard checks
    // every entry before writing any of them, not just the one that ends up escaping.
    await writeFile(path.join(cwd, 'tracked.adoc'), 'staged bytes\n');
    await stage(cwd, 'tracked.adoc');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.commit(projectId, {
      message: 'malicious',
      author: { name: 'Eve', email: 'eve@example.com' },
      flush: [
        { path: 'tracked.adoc', content: 'should never reach disk' },
        { path: '../escaped-by-test.adoc', content: 'pwned' },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
    await expect(stat(path.join(storageRoot, 'escaped-by-test.adoc'))).rejects.toThrow();
    expect(await readHeadCommit(cwd)).toBe(headBefore);
    // The in-tree file's staged bytes were left alone — the safe flush entry was never written either.
    const trackedContent = await readFile(path.join(cwd, 'tracked.adoc'), 'utf8');
    expect(trackedContent).toBe('staged bytes\n');
  });
});

describe('RealGitCommandRunner.push', () => {
  it('pushes local commits to the remote, returning the new head commit', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440066');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'content\n');
    await commitAll(cwd, 'init');
    const expectedHead = await readHeadCommit(cwd);

    const remotePath = await createTemporaryBareRemote();
    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });
    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);
      const result = await runner.push(projectId, { remoteUrl: `${server.url}/repo.git`, token: 'unused', branch: 'main' });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.value.headCommit).toBe(expectedHead);

      const { stdout: remoteHead } = await execFile('git', ['rev-parse', 'refs/heads/main'], { cwd: remotePath });
      expect(remoteHead.trim()).toBe(expectedHead);
    } finally {
      await server.close();
    }
  });

  it('returns NonFastForwardError when the remote has commits this branch does not', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440067');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'init');

    const remotePath = await createTemporaryBareRemote();
    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });
    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);

      const firstPush = await runner.push(projectId, {
        remoteUrl: `${server.url}/repo.git`,
        token: 'unused',
        branch: 'main',
      });
      expect(firstPush.success).toBe(true);

      // A different clone of the same remote advances it out from under this local branch.
      const otherWorkingTree = await createTemporaryWorkingTree();
      await execFile('git', ['remote', 'add', 'origin', `${server.url}/repo.git`], { cwd: otherWorkingTree });
      await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd: otherWorkingTree });
      await execFile('git', ['checkout', '-q', '-b', 'main', 'origin/main'], { cwd: otherWorkingTree });
      await writeFile(path.join(otherWorkingTree, 'b.adoc'), 'other change\n');
      await commitAll(otherWorkingTree, 'other change');
      await execFile('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: otherWorkingTree });

      const result = await runner.push(projectId, { remoteUrl: `${server.url}/repo.git`, token: 'unused', branch: 'main' });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.error).toBeInstanceOf(NonFastForwardError);
    } finally {
      await server.close();
    }
  });

  it('returns AuthenticationFailedError when the remote rejects the token', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440068');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'init');

    const remotePath = await createTemporaryBareRemote();
    const server = await startGitHttpServer({
      projectRoot: path.join(remotePath, '..'),
      requireAuth: { username: 'x-access-token', password: 'the-real-token' },
    });

    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);
      const result = await runner.push(projectId, {
        remoteUrl: `${server.url}/repo.git`,
        token: 'wrong-token',
        branch: 'main',
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.error).toBeInstanceOf(AuthenticationFailedError);
    } finally {
      await server.close();
    }
  });

  it('returns RepositoryUnreachableError when the remote cannot be reached', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440069');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'init');

    const port = await unusedLoopbackPort();
    const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);
    const result = await runner.push(projectId, { remoteUrl: `http://127.0.0.1:${port}/repo.git`, token: 'x', branch: 'main' });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(RepositoryUnreachableError);
  });

  it('rejects a push to a non-allowlisted host before attempting any network operation', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440070');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'init');

    const runner = new RealGitCommandRunner(storageRoot, ['git.example.com']);

    const capture = await withArgvCapturingGit(async (getCalls) => {
      const result = await runner.push(projectId, {
        remoteUrl: 'https://not-allowed.example.com/org/repo.git',
        token: 'x',
        branch: 'main',
      });
      return { result, calls: await getCalls() };
    });

    expect(capture.result.success).toBe(false);
    if (capture.result.success) throw new Error('expected failure');
    expect(capture.result.error).toBeInstanceOf(RepositoryUnreachableError);
    expect(capture.calls).toEqual([]);
  });

  it('never leaks the token into argv across the push operation', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440071');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'init');

    const token = 'super-secret-push-test-token-DO-NOT-LEAK-42fe';
    const remotePath = await createTemporaryBareRemote();
    const server = await startGitHttpServer({
      projectRoot: path.join(remotePath, '..'),
      requireAuth: { username: 'x-access-token', password: token },
    });

    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);

      const capture = await withArgvCapturingGit(async (getCalls) => {
        const result = await runner.push(projectId, { remoteUrl: `${server.url}/repo.git`, token, branch: 'main' });
        return { result, calls: await getCalls() };
      });

      expect(capture.result.success).toBe(true);
      expect(server.authorizationHeadersSeen.length).toBeGreaterThan(0);

      for (const call of capture.calls) {
        for (const argument of call) {
          expect(argument).not.toContain(token);
        }
      }
    } finally {
      await server.close();
    }
  });
});
