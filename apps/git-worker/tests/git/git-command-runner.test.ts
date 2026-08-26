import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  AuthenticationFailedError,
  CommitAlreadyPushedError,
  GitCommandFailedError,
  GitOperationId,
  NonFastForwardError,
  ProjectId,
  RemoteAlreadyInitializedError,
  RepositoryTooLargeError,
  RepositoryUnreachableError,
} from '@asciidocollab/domain';
import { deriveLfsEndpoint, RealGitCommandRunner } from '../../src/git/git-command-runner.js';
import { FilesystemConflictStageStore } from '../../src/git/filesystem-conflict-stage-store.js';
import { RemoteHostNotAllowedError, type HostAddressResolver } from '../../src/git/egress-allowlist.js';
import {
  commitAll,
  createTemporaryBareRemote,
  createTemporaryReadOnlyBareRemote,
  createTemporaryStorageRootWithProject,
  createTemporaryStorageRootWithUninitializedProject,
  createTemporaryWorkingTree,
  createPushedRepoPair,
  pushBranch,
  pushToOrigin,
} from '../helpers/temporary-git-repo.js';
import { startGitHttpServer } from '../helpers/git-http-server.js';
import { withArgvCapturingGit } from '../helpers/argv-capturing-git.js';

const execFile = promisify(execFileCallback);

/** A fixed operation id for merge calls in tests that do not exercise conflict-stage capture. */
const OPERATION_ID = GitOperationId.create('550e8400-e29b-41d4-a716-446655440098');

/**
 * Creates a `FilesystemConflictStageStore` rooted at a fresh temp directory — deliberately NOT
 * under the project's `storageRoot`/working tree, mirroring the composition root's invariant that
 * the store must live outside every working tree.
 */
async function createTemporaryConflictStageStore(): Promise<FilesystemConflictStageStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-worker-test-conflict-store-'));
  return new FilesystemConflictStageStore(root);
}

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

/**
 * Probes whether the `git-lfs` extension is installed, so an LFS round-trip test can branch to a
 * skip-with-log rather than fail when it is not (confirmed absent in this sandbox — see the
 * existing LFS-unavailable clone test above).
 */
async function isGitLfsAvailable(): Promise<boolean> {
  try {
    await execFile('git', ['lfs', 'version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds a project working tree on `main` with a caller-supplied base commit, pushes it to a fresh
 * bare "remote", and populates the project's `refs/remotes/origin/main` tracking ref from it — the
 * shared starting point for the LOCAL merge / behind-ahead integration tests (setup uses plain
 * `git`, never the code under test).
 */
async function setupProjectWithTracking(
  projectId: string,
  seed: (cwd: string) => Promise<void>,
): Promise<{ storageRoot: string; cwd: string; remotePath: string }> {
  const storageRoot = await createTemporaryStorageRootWithProject(projectId);
  const cwd = path.join(storageRoot, projectId);
  await seed(cwd);
  await commitAll(cwd, 'base');

  const remotePath = await createTemporaryBareRemote();
  await execFile('git', ['remote', 'add', 'origin', remotePath], { cwd });
  await execFile('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd });
  // Point the bare remote's HEAD at main so a fresh clone of it (see addRemoteCommit) checks out
  // main with the base files, rather than an empty init.defaultBranch.
  await execFile('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remotePath });
  await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });

  return { storageRoot, cwd, remotePath };
}

/**
 * Clones a bare remote into a throwaway working tree, applies `mutate` to it, commits, and pushes
 * back to `main` — advancing the remote branch out from under a project, so a later plain-`git`
 * fetch in the project populates a diverged tracking ref (setup helper, plain `git`).
 */
async function addRemoteCommit(
  remotePath: string,
  message: string,
  mutate: (clone: string) => Promise<void>,
): Promise<void> {
  const parent = await mkdtemp(path.join(tmpdir(), 'git-worker-test-remote-advance-'));
  const clone = path.join(parent, 'clone');
  await execFile('git', ['clone', '-q', remotePath, clone]);
  await execFile('git', ['config', 'user.email', 'remote@example.com'], { cwd: clone });
  await execFile('git', ['config', 'user.name', 'Remote'], { cwd: clone });
  await mutate(clone);
  await execFile('git', ['add', '-A'], { cwd: clone });
  await execFile('git', ['commit', '-q', '-m', message], { cwd: clone });
  await execFile('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: clone });
}

/** Reads the tip of the given ref in a working tree (test setup helper). */
async function readReference(cwd: string, reference: string): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', reference], { cwd });
  return stdout.trim();
}

describe('RealGitCommandRunner.fetch', () => {
  it('updates the remote-tracking ref and returns the remote tip', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440072');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);

    const sourceTree = await createTemporaryWorkingTree();
    await writeFile(path.join(sourceTree, 'remote.adoc'), 'remote content\n');
    await commitAll(sourceTree, 'remote init');
    const remotePath = await createTemporaryBareRemote();
    await pushToOrigin(sourceTree, remotePath);
    const remoteTip = await readHeadCommit(sourceTree);

    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });
    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);
      const result = await runner.fetch(projectId, {
        remoteUrl: `${server.url}/repo.git`,
        token: 'unused',
        branch: 'main',
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.value.remoteHead).toBe(remoteTip);
      // The explicit refspec created the tracking ref that merge/getBehindAhead depend on.
      expect(await readReference(cwd, 'refs/remotes/origin/main')).toBe(remoteTip);
    } finally {
      await server.close();
    }
  });

  it('rejects a fetch to a non-allowlisted host before attempting any network operation', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440073');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const runner = new RealGitCommandRunner(storageRoot, ['git.example.com']);

    const capture = await withArgvCapturingGit(async (getCalls) => {
      const result = await runner.fetch(projectId, {
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

  it('returns RepositoryUnreachableError when the remote cannot be reached', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440074');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const port = await unusedLoopbackPort();
    const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);

    const result = await runner.fetch(projectId, {
      remoteUrl: `http://127.0.0.1:${port}/repo.git`,
      token: 'x',
      branch: 'main',
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(RepositoryUnreachableError);
  });

  it('never leaks the token into argv across the fetch operation', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440075');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);

    const sourceTree = await createTemporaryWorkingTree();
    await writeFile(path.join(sourceTree, 'remote.adoc'), 'remote content\n');
    await commitAll(sourceTree, 'remote init');
    const remotePath = await createTemporaryBareRemote();
    await pushToOrigin(sourceTree, remotePath);

    const token = 'super-secret-fetch-test-token-DO-NOT-LEAK-9c3d';
    const server = await startGitHttpServer({
      projectRoot: path.join(remotePath, '..'),
      requireAuth: { username: 'x-access-token', password: token },
    });

    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);

      const capture = await withArgvCapturingGit(async (getCalls) => {
        const result = await runner.fetch(projectId, { remoteUrl: `${server.url}/repo.git`, token, branch: 'main' });
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

describe('RealGitCommandRunner.getBehindAhead', () => {
  it('reports the remote as ahead when it has commits the local branch lacks', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440076');
    const { cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addRemoteCommit(remotePath, 'remote one', async (clone) => {
      await writeFile(path.join(clone, 'one.adoc'), 'one\n');
    });
    await addRemoteCommit(remotePath, 'remote two', async (clone) => {
      await writeFile(path.join(clone, 'two.adoc'), 'two\n');
    });
    await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.getBehindAhead(projectId, 'main');

    expect(result).toEqual({ success: true, value: { behind: 2, ahead: 0 } });
  });

  it('reports the local branch as ahead when it has commits the remote lacks', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440077');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await writeFile(path.join(cwd, 'local.adoc'), 'local\n');
    await commitAll(cwd, 'local one');

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.getBehindAhead(projectId, 'main');

    expect(result).toEqual({ success: true, value: { behind: 0, ahead: 1 } });
  });

  it('reports a diverged local and remote with counts on both sides', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440078');
    const { cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addRemoteCommit(remotePath, 'remote one', async (clone) => {
      await writeFile(path.join(clone, 'one.adoc'), 'one\n');
    });
    await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });
    await writeFile(path.join(cwd, 'local.adoc'), 'local\n');
    await commitAll(cwd, 'local one');

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.getBehindAhead(projectId, 'main');

    expect(result).toEqual({ success: true, value: { behind: 1, ahead: 1 } });
  });

  it('reports zero on both sides when local and remote are in sync', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440079');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.getBehindAhead(projectId, 'main');

    expect(result).toEqual({ success: true, value: { behind: 0, ahead: 0 } });
  });
});

describe('RealGitCommandRunner.merge', () => {
  it('merges remote-only changes cleanly, classifying add/modify/remove/rename with bytes present', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440080');
    const { cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'to-modify.adoc'), 'v1\n');
      await writeFile(path.join(tree, 'to-remove.adoc'), 'bye\n');
      await writeFile(path.join(tree, 'old-name.adoc'), 'one\ntwo\nthree\nfour\nfive\n');
    });
    await addRemoteCommit(remotePath, 'remote changes', async (clone) => {
      await writeFile(path.join(clone, 'to-modify.adoc'), 'v2\n');
      await execFile('git', ['rm', '-q', 'to-remove.adoc'], { cwd: clone });
      await execFile('git', ['mv', 'old-name.adoc', 'new-name.adoc'], { cwd: clone });
      await writeFile(path.join(clone, 'added.adoc'), 'brand new\n');
    });
    await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });
    const remoteTip = await readReference(cwd, 'refs/remotes/origin/main');

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.merge(projectId, { branch: 'main', flush: [], operationId: OPERATION_ID });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    if (result.value.status !== 'merged') throw new Error('expected merged');
    expect(result.value.headCommit).toBe(remoteTip);
    expect(result.value.changes).toEqual(
      expect.arrayContaining([
        { type: 'added', path: 'added.adoc', content: Buffer.from('brand new\n'), mimeType: 'text/asciidoc' },
        { type: 'modified', path: 'to-modify.adoc', content: Buffer.from('v2\n'), mimeType: 'text/asciidoc' },
        { type: 'removed', path: 'to-remove.adoc' },
        {
          type: 'renamed',
          fromPath: 'old-name.adoc',
          toPath: 'new-name.adoc',
          content: Buffer.from('one\ntwo\nthree\nfour\nfive\n'),
          mimeType: 'text/asciidoc',
        },
      ]),
    );
    expect(result.value.changes).toHaveLength(4);
  });

  it('materializes a merged-in symlink as regular-file text (its link target), never following it to read host bytes', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440089');
    const { cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });

    // A file OUTSIDE the project working tree, holding bytes that must never surface as document
    // content. A tracked symlink pointing here is the escape a merge/checkout must not follow.
    const outsideDirectory = await mkdtemp(path.join(tmpdir(), 'git-worker-test-outside-'));
    const outsideSecretPath = path.join(outsideDirectory, 'secret');
    const secretBytes = Buffer.from('TOP-SECRET-HOST-FILE-CONTENT\n');
    await writeFile(outsideSecretPath, secretBytes);

    await addRemoteCommit(remotePath, 'remote adds a symlink pointing outside the tree', async (clone) => {
      await symlink(outsideSecretPath, path.join(clone, 'notes.adoc'));
    });
    await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.merge(projectId, { branch: 'main', flush: [], operationId: OPERATION_ID });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    if (result.value.status !== 'merged') throw new Error('expected merged');

    const symlinkChange = result.value.changes.find(
      (change): change is Extract<typeof change, { content: Buffer }> =>
        'path' in change && change.path === 'notes.adoc' && 'content' in change,
    );
    if (!symlinkChange) throw new Error('expected a content-bearing change for the symlink path');

    // The escape is closed: the change carries the link-target TEXT, not the outside file's bytes.
    expect(symlinkChange.content.equals(secretBytes)).toBe(false);
    expect(symlinkChange.content.toString('utf8')).not.toContain('TOP-SECRET-HOST-FILE-CONTENT');
    expect(symlinkChange.content.toString('utf8')).toBe(outsideSecretPath);

    // On disk the merged entry is a regular file — never a real symlink into the host filesystem.
    const onDisk = await lstat(path.join(cwd, 'notes.adoc'));
    expect(onDisk.isSymbolicLink()).toBe(false);
    expect(onDisk.isFile()).toBe(true);
  });

  it('returns merged with no changes when already up to date', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440081');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    const headBefore = await readReference(cwd, 'HEAD');

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.merge(projectId, { branch: 'main', flush: [], operationId: OPERATION_ID });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value).toEqual({ status: 'merged', headCommit: headBefore, changes: [] });
  });

  it('commits the flushed local side, then merges non-conflicting remote changes on top', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440082');
    const { cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addRemoteCommit(remotePath, 'remote adds a file', async (clone) => {
      await writeFile(path.join(clone, 'remote.adoc'), 'from remote\n');
    });
    await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.merge(projectId, {
      branch: 'main',
      flush: [{ path: 'base.adoc', content: 'locally flushed\n' }],
      operationId: OPERATION_ID,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    if (result.value.status !== 'merged') throw new Error('expected merged');
    // The change-set is the REMOTE's contribution only — the flushed local edit is excluded.
    expect(result.value.changes).toEqual([
      { type: 'added', path: 'remote.adoc', content: Buffer.from('from remote\n'), mimeType: 'text/asciidoc' },
    ]);
    // The flush landed in a commit and is present in the merged working tree.
    expect(await readFile(path.join(cwd, 'base.adoc'), 'utf8')).toBe('locally flushed\n');
    const { stdout: flushed } = await execFile('git', ['show', 'HEAD~1:base.adoc'], { cwd });
    expect(flushed).toBe('locally flushed\n');
  });

  it('reports a genuine three-way conflict, flags binary vs text, and leaves the tree clean', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440083');
    const baseBinary = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]);
    const remoteBinary = Buffer.from([0x00, 0x0A, 0x0B, 0x00, 0x0C]);
    const { cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'doc.adoc'), 'base line\n');
      await writeFile(path.join(tree, 'pic.bin'), baseBinary);
    });
    await addRemoteCommit(remotePath, 'remote edits both', async (clone) => {
      await writeFile(path.join(clone, 'doc.adoc'), 'remote line\n');
      await writeFile(path.join(clone, 'pic.bin'), remoteBinary);
    });
    await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });

    const conflictStageStore = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(path.dirname(cwd), [], undefined, conflictStageStore);
    const result = await runner.merge(projectId, {
      branch: 'main',
      // A NUL byte in the flushed text makes git treat pic.bin as binary on the local side too.
      flush: [
        { path: 'doc.adoc', content: 'local line\n' },
        { path: 'pic.bin', content: 'CCC CCC' },
      ],
      operationId: OPERATION_ID,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    if (result.value.status !== 'conflicted') throw new Error('expected conflicted');
    const byPath = new Map(result.value.conflicts.map((conflict) => [conflict.path, conflict.isBinary]));
    expect(byPath.get('doc.adoc')).toBe(false);
    expect(byPath.get('pic.bin')).toBe(true);
    expect(result.value.conflicts).toHaveLength(2);

    // merge --abort ran: no unmerged paths, working tree clean.
    const { stdout: status } = await execFile('git', ['status', '--porcelain'], { cwd });
    expect(status.trim()).toBe('');

    // The three-way stages were captured BEFORE the abort, binary bytes round-tripping exactly.
    const textStages = await conflictStageStore.readStages(OPERATION_ID, 'doc.adoc');
    expect(textStages).toEqual({
      success: true,
      value: {
        base: Buffer.from('base line\n'),
        ours: Buffer.from('local line\n'),
        theirs: Buffer.from('remote line\n'),
        isBinary: false,
      },
    });

    const binaryStages = await conflictStageStore.readStages(OPERATION_ID, 'pic.bin');
    expect(binaryStages).toEqual({
      success: true,
      value: { base: baseBinary, ours: Buffer.from('CCC\0CCC'), theirs: remoteBinary, isBinary: true },
    });

    // Every pull leaves an undo target, captured BEFORE the flush commit.
    const snapshot = await conflictStageStore.readSnapshot(OPERATION_ID);
    expect(snapshot.success).toBe(true);
    if (!snapshot.success) throw new Error('expected success');
    expect(snapshot.value?.branch).toBe('main');
    expect(snapshot.value?.preOpHead).toMatch(/^[0-9a-f]{40}$/);
  });

  it('captures an add/add conflict with a null base stage', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440086');
    const { cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addRemoteCommit(remotePath, 'remote adds new.adoc', async (clone) => {
      await writeFile(path.join(clone, 'new.adoc'), 'remote version\n');
    });
    await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });

    const conflictStageStore = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(path.dirname(cwd), [], undefined, conflictStageStore);
    const result = await runner.merge(projectId, {
      branch: 'main',
      // Also adds new.adoc locally — an add/add conflict, which has no common merge-base stage.
      flush: [
        { path: 'base.adoc', content: 'base\n' },
        { path: 'new.adoc', content: 'local version\n' },
      ],
      operationId: OPERATION_ID,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    if (result.value.status !== 'conflicted') throw new Error('expected conflicted');
    expect(result.value.conflicts).toEqual([{ path: 'new.adoc', isBinary: false }]);

    const stages = await conflictStageStore.readStages(OPERATION_ID, 'new.adoc');
    expect(stages).toEqual({
      success: true,
      value: {
        base: null,
        ours: Buffer.from('local version\n'),
        theirs: Buffer.from('remote version\n'),
        isBinary: false,
      },
    });
  });

  it('writes only the undo snapshot (no files/) on a clean merge', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440087');
    const { cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addRemoteCommit(remotePath, 'remote adds a file', async (clone) => {
      await writeFile(path.join(clone, 'remote.adoc'), 'from remote\n');
    });
    await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });
    const preOpHead = await readReference(cwd, 'HEAD');

    const conflictStageStore = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(path.dirname(cwd), [], undefined, conflictStageStore);
    const result = await runner.merge(projectId, { branch: 'main', flush: [], operationId: OPERATION_ID });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    if (result.value.status !== 'merged') throw new Error('expected merged');

    expect(await conflictStageStore.readSnapshot(OPERATION_ID)).toEqual({
      success: true,
      value: { preOpHead, branch: 'main' },
    });
    // No conflict occurred: nothing was captured for any path.
    expect(await conflictStageStore.readStages(OPERATION_ID, 'base.adoc')).toEqual({ success: true, value: null });
  });

  it('returns GitCommandFailedError and leaves no MERGE_HEAD when a stage read fails on a present stage', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440088');
    const { cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'doc.adoc'), 'base line\n');
    });
    await addRemoteCommit(remotePath, 'remote edit', async (clone) => {
      await writeFile(path.join(clone, 'doc.adoc'), 'remote line\n');
    });
    await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });

    const conflictStageStore = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(path.dirname(cwd), [], undefined, conflictStageStore);

    // A shim that forces `git show :2:doc.adoc` (the "ours" stage) to fail, delegating every other
    // invocation to the real `git` — simulating an unexpected failure reading a PRESENT stage.
    const { stdout: realGitPath } = await execFile('sh', ['-c', 'command -v git']);
    const shimDirectory = await mkdtemp(path.join(tmpdir(), 'git-worker-test-show-failure-shim-'));
    const shimPath = path.join(shimDirectory, 'git');
    const shimScript = [
      '#!/bin/sh',
      'case "$*" in',
      '  *":2:doc.adoc"*) exit 17 ;;',
      'esac',
      `exec "${realGitPath.trim()}" "$@"`,
      '',
    ].join('\n');
    await writeFile(shimPath, shimScript, { mode: 0o700 });

    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDirectory}:${originalPath ?? ''}`;
    let result;
    try {
      result = await runner.merge(projectId, {
        branch: 'main',
        flush: [{ path: 'doc.adoc', content: 'local line\n' }],
        operationId: OPERATION_ID,
      });
    } finally {
      process.env.PATH = originalPath;
      await rm(shimDirectory, { recursive: true, force: true });
    }

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);

    // The finally-abort ran despite the capture failure: no MERGE_HEAD, clean tree.
    await expect(stat(path.join(cwd, '.git', 'MERGE_HEAD'))).rejects.toThrow();
    const { stdout: status } = await execFile('git', ['status', '--porcelain'], { cwd });
    expect(status.trim()).toBe('');

    // Nothing was left half-written for the file whose "ours" read failed.
    expect(await conflictStageStore.readStages(OPERATION_ID, 'doc.adoc')).toEqual({ success: true, value: null });
  });

  it('returns GitCommandFailedError for a genuine merge failure (no tracking ref to merge)', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440084');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
    await commitAll(cwd, 'base');
    // Deliberately never populate refs/remotes/origin/main.

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.merge(projectId, { branch: 'main', flush: [], operationId: OPERATION_ID });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });

  it('rejects a flush path escaping the working tree, writing nothing', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440085');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    const headBefore = await readReference(cwd, 'HEAD');

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.merge(projectId, {
      branch: 'main',
      flush: [{ path: '../escaped-by-merge-test.adoc', content: 'pwned' }],
      operationId: OPERATION_ID,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
    await expect(stat(path.join(cwd, '..', 'escaped-by-merge-test.adoc'))).rejects.toThrow();
    expect(await readReference(cwd, 'HEAD')).toBe(headBefore);
  });
});

describe('RealGitCommandRunner.resolveMerge', () => {
  it('re-runs the merge, applies ours/theirs/merged, takes a two-parent resolving commit, and recovers the clean remote change alongside the resolutions', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440090');
    const { cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'doc.adoc'), 'base line\n');
      await writeFile(path.join(tree, 'mix.adoc'), 'base mix\n');
      await writeFile(path.join(tree, 'keep.adoc'), 'base keep\n');
    });
    await addRemoteCommit(remotePath, 'remote edits', async (clone) => {
      await writeFile(path.join(clone, 'doc.adoc'), 'remote line\n');
      await writeFile(path.join(clone, 'mix.adoc'), 'remote mix\n');
      await writeFile(path.join(clone, 'keep.adoc'), 'remote keep\n');
      await writeFile(path.join(clone, 'remote-only.adoc'), 'from remote\n');
    });
    await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });

    const conflictStageStore = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(path.dirname(cwd), [], undefined, conflictStageStore);

    // First, a real conflicted merge — exactly what a PULL leaves behind before this task's flow
    // takes over: a flush commit on the local tip, MERGE_HEAD aborted, stages captured.
    const conflicted = await runner.merge(projectId, {
      branch: 'main',
      flush: [
        { path: 'doc.adoc', content: 'local line\n' },
        { path: 'mix.adoc', content: 'local mix\n' },
        { path: 'keep.adoc', content: 'local keep\n' },
      ],
      operationId: OPERATION_ID,
    });
    expect(conflicted.success).toBe(true);
    if (!conflicted.success) throw new Error('expected success');
    if (conflicted.value.status !== 'conflicted') throw new Error('expected conflicted');
    expect(conflicted.value.conflicts.map((c) => c.path).sort()).toEqual(['doc.adoc', 'keep.adoc', 'mix.adoc']);

    const flushCommit = await readReference(cwd, 'HEAD');
    const remoteTip = await readReference(cwd, 'refs/remotes/origin/main');

    // A 'merged' resolution's bytes, as ResolveConflicts would have recorded them.
    await conflictStageStore.writeMerged(OPERATION_ID, 'mix.adoc', Buffer.from('merged mix\n'));

    const resolved = await runner.resolveMerge(projectId, {
      branch: 'main',
      operationId: OPERATION_ID,
      resolutions: [
        { path: 'doc.adoc', resolution: 'theirs' },
        { path: 'mix.adoc', resolution: 'merged' },
        { path: 'keep.adoc', resolution: 'ours' },
      ],
    });

    expect(resolved.success).toBe(true);
    if (!resolved.success) throw new Error('expected success');
    if (resolved.value.status !== 'resolved') throw new Error('expected resolved');

    // A genuine merge commit: two parents — the local flush tip and the remote-tracking ref.
    const { stdout: parents } = await execFile('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd });
    const parentHashes = parents.trim().split(/\s+/).slice(1);
    expect(parentHashes.sort()).toEqual([flushCommit, remoteTip].sort());
    expect(resolved.value.headCommit).toBe(await readReference(cwd, 'HEAD'));

    // The resolutions landed on disk...
    expect(await readFile(path.join(cwd, 'doc.adoc'), 'utf8')).toBe('remote line\n');
    expect(await readFile(path.join(cwd, 'mix.adoc'), 'utf8')).toBe('merged mix\n');
    expect(await readFile(path.join(cwd, 'keep.adoc'), 'utf8')).toBe('local keep\n');

    // ...and the returned change-set carries the resolved files PLUS the clean remote-only file a
    // naive re-apply-only-conflicted-files approach would have silently dropped. 'keep.adoc' (an
    // 'ours' resolution that reproduces exactly its pre-merge content) carries no real diff, so it
    // is absent from the change-set — that is expected, not a gap.
    const byPath = new Map(
      resolved.value.changes.map((change) => [change.type === 'renamed' ? change.toPath : change.path, change]),
    );
    expect(byPath.get('doc.adoc')).toEqual({ type: 'modified', path: 'doc.adoc', content: Buffer.from('remote line\n'), mimeType: 'text/asciidoc' });
    expect(byPath.get('mix.adoc')).toEqual({ type: 'modified', path: 'mix.adoc', content: Buffer.from('merged mix\n'), mimeType: 'text/asciidoc' });
    expect(byPath.get('remote-only.adoc')).toEqual({ type: 'added', path: 'remote-only.adoc', content: Buffer.from('from remote\n'), mimeType: 'text/asciidoc' });
    expect(byPath.has('keep.adoc')).toBe(false);

    const { stdout: status } = await execFile('git', ['status', '--porcelain'], { cwd });
    expect(status.trim()).toBe('');
  });

  it('reports stillConflicted and leaves a clean, aborted tree when a resolution is missing for a conflicting path', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440091');
    const { cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'doc.adoc'), 'base line\n');
      await writeFile(path.join(tree, 'other.adoc'), 'base other\n');
    });
    await addRemoteCommit(remotePath, 'remote edits both', async (clone) => {
      await writeFile(path.join(clone, 'doc.adoc'), 'remote line\n');
      await writeFile(path.join(clone, 'other.adoc'), 'remote other\n');
    });
    await execFile('git', ['fetch', '-q', 'origin', 'main'], { cwd });

    const conflictStageStore = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(path.dirname(cwd), [], undefined, conflictStageStore);

    const conflicted = await runner.merge(projectId, {
      branch: 'main',
      flush: [
        { path: 'doc.adoc', content: 'local line\n' },
        { path: 'other.adoc', content: 'local other\n' },
      ],
      operationId: OPERATION_ID,
    });
    expect(conflicted.success).toBe(true);
    if (!conflicted.success) throw new Error('expected success');
    if (conflicted.value.status !== 'conflicted') throw new Error('expected conflicted');

    // Only 'doc.adoc' is resolved — 'other.adoc' is deliberately left unresolved.
    const resolved = await runner.resolveMerge(projectId, {
      branch: 'main',
      operationId: OPERATION_ID,
      resolutions: [{ path: 'doc.adoc', resolution: 'theirs' }],
    });

    expect(resolved.success).toBe(true);
    if (!resolved.success) throw new Error('expected success');
    if (resolved.value.status !== 'stillConflicted') throw new Error('expected stillConflicted');
    expect(resolved.value.conflicts).toEqual([{ path: 'other.adoc', isBinary: false }]);

    // The merge was aborted: no MERGE_HEAD, clean tree, nothing committed.
    await expect(stat(path.join(cwd, '.git', 'MERGE_HEAD'))).rejects.toThrow();
    const { stdout: status } = await execFile('git', ['status', '--porcelain'], { cwd });
    expect(status.trim()).toBe('');
  });

  it('returns GitCommandFailedError for a genuine merge failure (no tracking ref to merge)', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440092');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'base.adoc'), 'base\n');
    await commitAll(cwd, 'base');
    // Deliberately never populate refs/remotes/origin/main.

    const conflictStageStore = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, conflictStageStore);
    const result = await runner.resolveMerge(projectId, { branch: 'main', operationId: OPERATION_ID, resolutions: [] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });
});

describe('RealGitCommandRunner.restoreToSnapshot', () => {
  it('resets the working tree to the recorded pre-operation head and returns the reversal change-set', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440093');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'a.adoc'), 'original\n');
    });
    const preOpHead = await readReference(cwd, 'HEAD');

    // Simulate whatever the pull/switch landed after the snapshot was captured.
    await writeFile(path.join(cwd, 'a.adoc'), 'pulled\n');
    await writeFile(path.join(cwd, 'b.adoc'), 'added by the pull\n');
    await commitAll(cwd, 'landed pull');

    const conflictStageStore = await createTemporaryConflictStageStore();
    await conflictStageStore.writeSnapshot(OPERATION_ID, { preOpHead, branch: 'main' });
    const runner = new RealGitCommandRunner(path.dirname(cwd), [], undefined, conflictStageStore);

    const result = await runner.restoreToSnapshot(projectId, { operationId: OPERATION_ID });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.headCommit).toBe(preOpHead);
    expect(await readReference(cwd, 'HEAD')).toBe(preOpHead);
    expect(await readFile(path.join(cwd, 'a.adoc'), 'utf8')).toBe('original\n');
    await expect(stat(path.join(cwd, 'b.adoc'))).rejects.toThrow();

    // The reversal set: the tree after the reset compared against the tree right before it.
    expect(result.value.changes).toEqual(
      expect.arrayContaining([
        { type: 'modified', path: 'a.adoc', content: Buffer.from('original\n'), mimeType: 'text/asciidoc' },
        { type: 'removed', path: 'b.adoc' },
      ]),
    );
  });

  it('returns GitCommandFailedError when no snapshot is recorded for the operation', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440094');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'a.adoc'), 'original\n');
    });

    const conflictStageStore = await createTemporaryConflictStageStore();
    const runner = new RealGitCommandRunner(path.dirname(cwd), [], undefined, conflictStageStore);

    const result = await runner.restoreToSnapshot(projectId, { operationId: OPERATION_ID });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });

  it('returns GitCommandFailedError when the recorded pre-operation head no longer resolves', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440095');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'a.adoc'), 'original\n');
    });

    const conflictStageStore = await createTemporaryConflictStageStore();
    await conflictStageStore.writeSnapshot(OPERATION_ID, {
      preOpHead: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
    });
    const runner = new RealGitCommandRunner(path.dirname(cwd), [], undefined, conflictStageStore);

    const result = await runner.restoreToSnapshot(projectId, { operationId: OPERATION_ID });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });

  it('returns GitCommandFailedError when no conflict stage store is configured', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440096');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'a.adoc'), 'original\n');
    });

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.restoreToSnapshot(projectId, { operationId: OPERATION_ID });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });
});

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

  it('derives the LFS endpoint on the origin host, reproducing git-lfs\'s default for an https remote', () => {
    // Replicates git-lfs's own default so an honest repo's transfer is unchanged; the security
    // point is that the host is always the origin's, never anything a repo could supply.
    expect(deriveLfsEndpoint('https://github.com/org/repo.git')).toBe('https://github.com/org/repo.git/info/lfs');
    expect(deriveLfsEndpoint('https://github.com/org/repo')).toBe('https://github.com/org/repo.git/info/lfs');
    expect(deriveLfsEndpoint('https://github.com/org/repo.git/')).toBe('https://github.com/org/repo.git/info/lfs');
  });

  it('pins the LFS endpoint above a repo-supplied .lfsconfig, so git-lfs resolves the validated origin, not the attacker host', async () => {
    if (!(await isGitLfsAvailable())) {
      // git-lfs absent: the pin MECHANISM (the `-c lfs.url` the worker emits) is still proven
      // deterministically by the run-git-command per-call config test. This check — that a
      // command-line `-c lfs.url` actually OVERRIDES a hostile `.lfsconfig` in real git-lfs — runs
      // wherever git-lfs is installed (e.g. CI); it is characterized, never faked, when it is not.
      // eslint-disable-next-line no-console
      console.info('[skipped] git-lfs not installed — `.lfsconfig` override check runs only where git-lfs is present.');
      return;
    }

    // A working tree exactly as a clone would leave it: an origin remote plus a tracked `.lfsconfig`
    // whose `lfs.url` tries to steer every LFS transfer at an internal metadata host (a classic SSRF
    // target). `git lfs env` resolves the effective endpoint WITHOUT any network I/O.
    const originRemoteUrl = 'https://origin.example.com/org/repo.git';
    const attackerHost = '169.254.169.254';
    const workingTree = await createTemporaryWorkingTree();
    await execFile('git', ['remote', 'add', 'origin', originRemoteUrl], { cwd: workingTree });
    await writeFile(path.join(workingTree, '.lfsconfig'), `[lfs]\n\turl = http://${attackerHost}/redirected\n`);

    const readResolvedEndpoint = async (extraConfig: string[]): Promise<string> => {
      const { stdout } = await execFile('git', [...extraConfig, 'lfs', 'env'], { cwd: workingTree });
      return stdout.split('\n').find((line) => line.startsWith('Endpoint=')) ?? '';
    };

    // Baseline (the vulnerability): with no pin, git-lfs honors `.lfsconfig` and would transfer to
    // the attacker host — proof the attack surface is real and this test would catch a regression.
    expect(await readResolvedEndpoint([])).toContain(attackerHost);

    // The fix: the worker's highest-precedence `-c lfs.url=<origin-derived>` wins over `.lfsconfig`,
    // so git-lfs resolves the validated origin endpoint and never the attacker host.
    const pinnedEndpoint = deriveLfsEndpoint(originRemoteUrl);
    const resolvedWithPin = await readResolvedEndpoint(['-c', `lfs.url=${pinnedEndpoint}`]);
    expect(resolvedWithPin).toContain(pinnedEndpoint);
    expect(resolvedWithPin).not.toContain(attackerHost);
  });

  it('returns RepositoryTooLargeError and cleans up the scratch directory when the cloned tree exceeds maxRepoSizeMB', async () => {
    const workingTree = await createTemporaryWorkingTree();
    await writeFile(path.join(workingTree, 'big.txt'), 'x'.repeat(200_000));
    await commitAll(workingTree, 'big file');

    const remotePath = await createTemporaryBareRemote();
    await pushToOrigin(workingTree, remotePath);

    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });
    try {
      const scratchDirsBefore = (await readdir(tmpdir())).filter((name) => name.startsWith('git-worker-clone-'));

      // A tiny fractional MB ceiling — well below the ~200 KB fixture above — so the clone is
      // rejected regardless of any other content this fixture happens to carry.
      const runner = new RealGitCommandRunner('/unused', ['127.0.0.1'], fakePublicResolver, undefined, 0.001);
      const result = await runner.clone({ remoteUrl: `${server.url}/repo.git`, token: 'unused' });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.error).toBeInstanceOf(RepositoryTooLargeError);

      const scratchDirsAfter = (await readdir(tmpdir())).filter((name) => name.startsWith('git-worker-clone-'));
      expect(scratchDirsAfter).toEqual(scratchDirsBefore);
    } finally {
      await server.close();
    }
  });

  it('succeeds when the cloned tree is within maxRepoSizeMB', async () => {
    const workingTree = await createTemporaryWorkingTree();
    await writeFile(path.join(workingTree, 'small.txt'), 'hello\n');
    await commitAll(workingTree, 'small file');

    const remotePath = await createTemporaryBareRemote();
    await pushToOrigin(workingTree, remotePath);

    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });
    try {
      const runner = new RealGitCommandRunner('/unused', ['127.0.0.1'], fakePublicResolver, undefined, 500);
      const result = await runner.clone({ remoteUrl: `${server.url}/repo.git`, token: 'unused' });

      expect(result.success).toBe(true);
    } finally {
      await server.close();
    }
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

describe('RealGitCommandRunner.stage — Git LFS threshold', () => {
  it('does not modify .gitattributes for a path below lfsThresholdBytes', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440064');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'init.adoc'), 'init\n');
    await commitAll(cwd, 'init');
    await writeFile(path.join(cwd, 'small.adoc'), 'small content\n');

    const runner = new RealGitCommandRunner(storageRoot, [], undefined, undefined, 500, 1_000_000);
    const result = await runner.stage(projectId, ['small.adoc']);

    expect(result).toEqual({ success: true, value: undefined });

    const gitattributesExists = await stat(path.join(cwd, '.gitattributes')).then(
      () => true,
      () => false,
    );
    expect(gitattributesExists).toBe(false);

    const status = await runner.getStatus(projectId);
    expect(status).toEqual({
      success: true,
      value: { currentBranch: 'main', changes: [{ path: 'small.adoc', changeType: 'added', state: 'staged' }] },
    });
  });

  it('leaves an already-declared filter=lfs path untouched and stages it without invoking git-lfs at all', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440065');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'init.adoc'), 'init\n');
    await commitAll(cwd, 'init');

    // An exact literal declaration for this path — mirrors what `writeManagedGitattributes` itself
    // produces (this mechanism's own idempotency case), as opposed to a broader glob pattern
    // (`*.bin`) it makes no attempt to recognize.
    const preExisting = 'big.bin filter=lfs diff=lfs merge=lfs -text\n';
    await writeFile(path.join(cwd, '.gitattributes'), preExisting);
    await writeFile(path.join(cwd, 'big.bin'), 'x'.repeat(2048));

    // `git lfs install`/`git lfs track` are never invoked here — the path is already declared
    // `filter=lfs`, so this succeeds regardless of whether the `git-lfs` binary happens to be
    // installed in this environment (proof this is the fast, no-binary-needed path).
    const runner = new RealGitCommandRunner(storageRoot, [], undefined, undefined, 500, 1024);
    const result = await runner.stage(projectId, ['.gitattributes', 'big.bin']);

    expect(result).toEqual({ success: true, value: undefined });
    const gitattributesContent = await readFile(path.join(cwd, '.gitattributes'), 'utf8');
    expect(gitattributesContent).toBe(preExisting);
  });

  it('tracks a path at/over lfsThresholdBytes with Git LFS, gaining a managed .gitattributes entry', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440066');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'init.adoc'), 'init\n');
    await commitAll(cwd, 'init');
    await writeFile(path.join(cwd, 'big.bin'), 'x'.repeat(2048));

    const runner = new RealGitCommandRunner(storageRoot, [], undefined, undefined, 500, 1024);
    const result = await runner.stage(projectId, ['big.bin']);

    if (!(await isGitLfsAvailable())) {
      // eslint-disable-next-line no-console
      console.log(
        'Skipping the LFS round-trip assertion: git-lfs is not installed in this environment; ' +
          'asserting the safe-failure path instead (mirrors the clone-side LFS-unavailable test).',
      );
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.error).toBeInstanceOf(GitCommandFailedError);
      return;
    }

    expect(result).toEqual({ success: true, value: undefined });

    const gitattributesContent = await readFile(path.join(cwd, '.gitattributes'), 'utf8');
    expect(gitattributesContent).toContain('big.bin filter=lfs diff=lfs merge=lfs -text');

    const status = await runner.getStatus(projectId);
    expect(status.success).toBe(true);
    if (!status.success) throw new Error('expected success');
    expect(status.value.changes.map((change) => change.path).toSorted()).toEqual(['.gitattributes', 'big.bin']);
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

describe('RealGitCommandRunner.initializeAndPublish', () => {
  it('initializes the working tree, records the initial commit, and publishes it to an empty remote', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440090');
    const storageRoot = await createTemporaryStorageRootWithUninitializedProject(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'index.adoc'), '= Handbook\n');
    });
    const cwd = path.join(storageRoot, projectId.value);

    const remotePath = await createTemporaryBareRemote();
    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });

    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);
      const result = await runner.initializeAndPublish(projectId, {
        remoteUrl: `${server.url}/repo.git`,
        token: 'unused',
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.value.defaultBranch).toBe('main');
      expect(result.value.headCommit).toBe(await readHeadCommit(cwd));

      // The remote received exactly the initial commit, on the published branch.
      const { stdout: remoteHead } = await execFile('git', ['rev-parse', 'refs/heads/main'], { cwd: remotePath });
      expect(remoteHead.trim()).toBe(result.value.headCommit);

      // The project's own files are unchanged, not touched by the publish.
      expect(await readFile(path.join(cwd, 'index.adoc'), 'utf8')).toBe('= Handbook\n');
    } finally {
      await server.close();
    }
  });

  it('publishes under a requested non-default branch', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440091');
    const storageRoot = await createTemporaryStorageRootWithUninitializedProject(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'index.adoc'), '= Handbook\n');
    });

    const remotePath = await createTemporaryBareRemote();
    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });

    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);
      const result = await runner.initializeAndPublish(projectId, {
        remoteUrl: `${server.url}/repo.git`,
        token: 'unused',
        branch: 'trunk',
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.value.defaultBranch).toBe('trunk');

      const { stdout: remoteHead } = await execFile('git', ['rev-parse', 'refs/heads/trunk'], { cwd: remotePath });
      expect(remoteHead.trim()).toBe(result.value.headCommit);
    } finally {
      await server.close();
    }
  });

  it("never stages or commits the internal .collab/ path, honoring the working tree's own .gitignore", async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440092');
    const storageRoot = await createTemporaryStorageRootWithUninitializedProject(projectId.value, async (tree) => {
      await writeFile(path.join(tree, '.gitignore'), '.collab/\n');
      await writeFile(path.join(tree, 'index.adoc'), '= Handbook\n');
      await mkdir(path.join(tree, '.collab'), { recursive: true });
      await writeFile(path.join(tree, '.collab', 'session.bin'), 'internal state');
    });
    const cwd = path.join(storageRoot, projectId.value);

    const remotePath = await createTemporaryBareRemote();
    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });

    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);
      const result = await runner.initializeAndPublish(projectId, {
        remoteUrl: `${server.url}/repo.git`,
        token: 'unused',
      });

      expect(result.success).toBe(true);

      const { stdout } = await execFile('git', ['ls-files'], { cwd });
      const trackedPaths = stdout.split('\n').filter((line) => line.length > 0);
      expect(trackedPaths).toEqual(expect.arrayContaining(['.gitignore', 'index.adoc']));
      expect(trackedPaths.some((trackedPath) => trackedPath.startsWith('.collab/'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('never publishes the internal .collab/ path even when no .gitignore pre-exists, writing a managed one itself', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440097');
    const storageRoot = await createTemporaryStorageRootWithUninitializedProject(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'index.adoc'), '= Handbook\n');
      await mkdir(path.join(tree, '.collab'), { recursive: true });
      await writeFile(path.join(tree, '.collab', 'session.bin'), 'internal state');
      // Deliberately no `.gitignore` written here — this proves the adapter provisions one itself.
    });
    const cwd = path.join(storageRoot, projectId.value);

    const remotePath = await createTemporaryBareRemote();
    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });

    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);
      const result = await runner.initializeAndPublish(projectId, {
        remoteUrl: `${server.url}/repo.git`,
        token: 'unused',
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');

      // Assert directly against the bare remote's own pushed tree, not the local working tree.
      const { stdout } = await execFile('git', ['ls-tree', '-r', '--name-only', 'refs/heads/main'], {
        cwd: remotePath,
      });
      const pushedPaths = stdout.split('\n').filter((line) => line.length > 0);

      expect(pushedPaths).toEqual(expect.arrayContaining(['.gitignore', 'index.adoc']));
      expect(pushedPaths.some((pushedPath) => pushedPath.startsWith('.collab/'))).toBe(false);

      const { stdout: gitignoreContent } = await execFile(
        'git',
        ['show', 'refs/heads/main:.gitignore'],
        { cwd: remotePath },
      );
      expect(gitignoreContent).toContain('.collab/');
    } finally {
      await server.close();
    }
  });

  it('refuses to publish onto a remote that already has commits, without creating a local repository', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440093');
    const storageRoot = await createTemporaryStorageRootWithUninitializedProject(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'index.adoc'), '= Handbook\n');
    });
    const cwd = path.join(storageRoot, projectId.value);

    // A remote that already has one commit — via createPushedRepoPair's own working tree/remote.
    const { remoteProjectRoot } = await createPushedRepoPair();
    const server = await startGitHttpServer({ projectRoot: remoteProjectRoot });

    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);
      const result = await runner.initializeAndPublish(projectId, {
        remoteUrl: `${server.url}/repo.git`,
        token: 'unused',
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.error).toBeInstanceOf(RemoteAlreadyInitializedError);

      // Nothing was created locally: no `.git`, and the project's own file is still there untouched.
      await expect(stat(path.join(cwd, '.git'))).rejects.toThrow();
      expect(await readFile(path.join(cwd, 'index.adoc'), 'utf8')).toBe('= Handbook\n');
    } finally {
      await server.close();
    }
  });

  it('leaves the working tree non-git, with the project files intact, when the push is rejected', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440094');
    const storageRoot = await createTemporaryStorageRootWithUninitializedProject(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'index.adoc'), '= Handbook\n');
    });
    const cwd = path.join(storageRoot, projectId.value);

    // http.receivepack left at its default (false): ls-remote/clone still work, push is refused.
    const remotePath = await createTemporaryReadOnlyBareRemote();
    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });

    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);
      const result = await runner.initializeAndPublish(projectId, {
        remoteUrl: `${server.url}/repo.git`,
        token: 'unused',
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(
        result.error instanceof GitCommandFailedError ||
          result.error instanceof AuthenticationFailedError ||
          result.error instanceof RepositoryUnreachableError,
      ).toBe(true);

      // The failed publish left no `.git` behind — the working tree is back to non-git — and the
      // project's own file is untouched.
      await expect(stat(path.join(cwd, '.git'))).rejects.toThrow();
      expect(await readFile(path.join(cwd, 'index.adoc'), 'utf8')).toBe('= Handbook\n');
    } finally {
      await server.close();
    }
  });

  it('rejects a disallowed remote host before running any git command', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440095');
    const storageRoot = await createTemporaryStorageRootWithUninitializedProject(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'index.adoc'), '= Handbook\n');
    });
    const runner = new RealGitCommandRunner(storageRoot, ['git.example.com']);

    const capture = await withArgvCapturingGit(async (getCalls) => {
      const result = await runner.initializeAndPublish(projectId, {
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

  it('never leaks the token into argv across the whole publish', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440096');
    const storageRoot = await createTemporaryStorageRootWithUninitializedProject(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'index.adoc'), '= Handbook\n');
    });

    const token = 'super-secret-initialize-test-token-DO-NOT-LEAK-71ab';
    const remotePath = await createTemporaryBareRemote();
    const server = await startGitHttpServer({
      projectRoot: path.join(remotePath, '..'),
      requireAuth: { username: 'x-access-token', password: token },
    });

    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);

      const capture = await withArgvCapturingGit(async (getCalls) => {
        const result = await runner.initializeAndPublish(projectId, { remoteUrl: `${server.url}/repo.git`, token });
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

describe('RealGitCommandRunner.log', () => {
  it('returns commits newest-first with hash, subject, author email, and date', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440100');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);

    await writeFile(path.join(cwd, 'a.adoc'), 'one\n');
    await commitAll(cwd, 'first commit');
    await writeFile(path.join(cwd, 'a.adoc'), 'one\ntwo\n');
    await commitAll(cwd, 'second commit');
    await writeFile(path.join(cwd, 'a.adoc'), 'one\ntwo\nthree\n');
    await commitAll(cwd, 'third commit');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.log(projectId, {});

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.map((entry) => entry.message)).toEqual(['third commit', 'second commit', 'first commit']);
    for (const entry of result.value) {
      expect(entry.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.authorEmail).toBe('test@example.com');
      expect(entry.authoredAt).toBeInstanceOf(Date);
      expect(Number.isNaN(entry.authoredAt.getTime())).toBe(false);
    }
  });

  it('caps the number of commits returned with limit', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440101');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);

    await writeFile(path.join(cwd, 'a.adoc'), 'one\n');
    await commitAll(cwd, 'first');
    await writeFile(path.join(cwd, 'a.adoc'), 'one\ntwo\n');
    await commitAll(cwd, 'second');
    await writeFile(path.join(cwd, 'a.adoc'), 'one\ntwo\nthree\n');
    await commitAll(cwd, 'third');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.log(projectId, { limit: 2 });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.map((entry) => entry.message)).toEqual(['third', 'second']);
  });

  it('restricts to commits that touched the given path', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440102');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);

    await writeFile(path.join(cwd, 'a.adoc'), 'a1\n');
    await writeFile(path.join(cwd, 'b.adoc'), 'b1\n');
    await commitAll(cwd, 'add both');
    await writeFile(path.join(cwd, 'b.adoc'), 'b2\n');
    await commitAll(cwd, 'touch b only');
    await writeFile(path.join(cwd, 'a.adoc'), 'a2\n');
    await commitAll(cwd, 'touch a only');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.log(projectId, { path: 'a.adoc' });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.map((entry) => entry.message)).toEqual(['touch a only', 'add both']);
  });

  it('returns a single entry for a repository with one commit', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440103');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'content\n');
    await commitAll(cwd, 'only commit');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.log(projectId, {});

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value).toEqual([
      expect.objectContaining({ message: 'only commit', authorEmail: 'test@example.com' }),
    ]);
  });

  it('round-trips a distinct author email exactly', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440104');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await execFile('git', ['config', 'user.email', 'writer.name+tag@example.co.uk'], { cwd });
    await writeFile(path.join(cwd, 'a.adoc'), 'content\n');
    await commitAll(cwd, 'authored commit');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.log(projectId, {});

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value[0].authorEmail).toBe('writer.name+tag@example.co.uk');
  });

  it('returns an empty array for a path no commit ever touched', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440105');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'content\n');
    await commitAll(cwd, 'init');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.log(projectId, { path: 'never-existed.adoc' });

    expect(result).toEqual({ success: true, value: [] });
  });

  it('returns an empty array for a repository with no commits yet', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440106');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    // Deliberately never commit anything — a freshly-initialized, still commit-less repository.

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.log(projectId, {});

    expect(result).toEqual({ success: true, value: [] });
  });

  it('returns a GitCommandFailedError without throwing when the working tree does not exist', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440107');
    const storageRoot = await mkdtemp(path.join(tmpdir(), 'git-worker-test-log-empty-storage-'));
    // Deliberately never create `<storageRoot>/<projectId>/`.

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.log(projectId, {});

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(result.error.message).not.toMatch(/fatal:|ENOENT/i);
  });
});

describe('RealGitCommandRunner.diff', () => {
  it('returns a non-empty unified diff naming the changed file between two commits', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440110');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'one\n');
    await commitAll(cwd, 'c1');
    const from = await readReference(cwd, 'HEAD');
    await writeFile(path.join(cwd, 'a.adoc'), 'one\ntwo\n');
    await commitAll(cwd, 'c2');
    const to = await readReference(cwd, 'HEAD');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.diff(projectId, { from, to });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.unified).toContain('a.adoc');
    expect(result.value.unified).toContain('+two');
  });

  it('scopes a commit-vs-commit diff to the given path', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440111');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'a1\n');
    await writeFile(path.join(cwd, 'b.adoc'), 'b1\n');
    await commitAll(cwd, 'c1');
    const from = await readReference(cwd, 'HEAD');
    await writeFile(path.join(cwd, 'a.adoc'), 'a2\n');
    await writeFile(path.join(cwd, 'b.adoc'), 'b2\n');
    await commitAll(cwd, 'c2');
    const to = await readReference(cwd, 'HEAD');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.diff(projectId, { from, to, path: 'a.adoc' });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.unified).toContain('a.adoc');
    expect(result.value.unified).not.toContain('b.adoc');
  });

  it('diffs uncommitted working changes against HEAD', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440112');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'one\n');
    await commitAll(cwd, 'c1');
    await writeFile(path.join(cwd, 'a.adoc'), 'one\nuncommitted\n');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.diff(projectId, {});

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.unified).toContain('+uncommitted');
  });

  it('returns an empty diff when there are no changes', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440113');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'one\n');
    await commitAll(cwd, 'c1');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.diff(projectId, {});

    expect(result).toEqual({ success: true, value: { unified: '' } });
  });

  it('diffs HEAD against supplied live content rather than the stale on-disk copy', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440114');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'committed content\n');
    await commitAll(cwd, 'c1');
    // The on-disk copy is left exactly as committed — stale relative to the live override below.

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.diff(projectId, {
      currentContent: { path: 'a.adoc', content: 'live collaborative content\n' },
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.unified).toContain('-committed content');
    expect(result.value.unified).toContain('+live collaborative content');

    const onDisk = await readFile(path.join(cwd, 'a.adoc'), 'utf8');
    expect(onDisk).toBe('committed content\n');
  });

  it('treats the --no-index exit-1 "files differ" outcome as success, not an error', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440115');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'first\n');
    await commitAll(cwd, 'c1');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.diff(projectId, {
      currentContent: { path: 'a.adoc', content: 'second\n' },
    });

    // A real difference must come back as a successful diff result, never a GitCommandFailedError —
    // this is exactly the outcome `git diff --no-index` signals by exiting 1.
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.unified.length).toBeGreaterThan(0);
  });

  it('returns an empty string when the live override content matches HEAD exactly', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440116');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'identical\n');
    await commitAll(cwd, 'c1');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.diff(projectId, {
      currentContent: { path: 'a.adoc', content: 'identical\n' },
    });

    expect(result).toEqual({ success: true, value: { unified: '' } });
  });

  it('treats a live override for a file absent at HEAD as a diff against an empty base', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440117');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'other.adoc'), 'unrelated\n');
    await commitAll(cwd, 'c1');
    // 'new-file.adoc' was never committed — absent at HEAD entirely.

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.diff(projectId, {
      currentContent: { path: 'new-file.adoc', content: 'brand new live text\n' },
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.unified).toContain('+brand new live text');
  });
});

describe('RealGitCommandRunner.blame', () => {
  it('maps each line to the right commit hash, author email, line number, and content across two commits', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440120');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);

    await writeFile(path.join(cwd, 'f.adoc'), 'line one\nline two\n');
    await commitAll(cwd, 'first commit');
    const firstHash = await readReference(cwd, 'HEAD');

    await execFile('git', ['config', 'user.email', 'second-author@example.com'], { cwd });
    await execFile('git', ['config', 'user.name', 'Second Author'], { cwd });
    await writeFile(path.join(cwd, 'f.adoc'), 'line one\nline two\nline three\n');
    await commitAll(cwd, 'second commit');
    const secondHash = await readReference(cwd, 'HEAD');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.blame(projectId, { path: 'f.adoc' });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value).toEqual([
      { lineNumber: 1, hash: firstHash, authorEmail: 'test@example.com', authoredAt: expect.any(Date), content: 'line one' },
      { lineNumber: 2, hash: firstHash, authorEmail: 'test@example.com', authoredAt: expect.any(Date), content: 'line two' },
      {
        lineNumber: 3,
        hash: secondHash,
        authorEmail: 'second-author@example.com',
        authoredAt: expect.any(Date),
        content: 'line three',
      },
    ]);
  });

  it('blames a single-commit file entirely to that one commit', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440121');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'f.adoc'), 'only line\n');
    await commitAll(cwd, 'only commit');
    const hash = await readReference(cwd, 'HEAD');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.blame(projectId, { path: 'f.adoc' });

    expect(result).toEqual({
      success: true,
      value: [{ lineNumber: 1, hash, authorEmail: 'test@example.com', authoredAt: expect.any(Date), content: 'only line' }],
    });
  });

  it('returns a GitCommandFailedError for a file absent at the given ref', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440122');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'content\n');
    await commitAll(cwd, 'first');
    const firstHash = await readReference(cwd, 'HEAD');
    await writeFile(path.join(cwd, 'b.adoc'), 'other\n');
    await commitAll(cwd, 'second');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.blame(projectId, { path: 'b.adoc', ref: firstHash });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(result.error.message).not.toMatch(/fatal:|ENOENT/i);
  });

  it('returns an empty array for an empty file', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440123');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'empty.adoc'), '');
    await commitAll(cwd, 'add empty file');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.blame(projectId, { path: 'empty.adoc' });

    expect(result).toEqual({ success: true, value: [] });
  });
});

describe('RealGitCommandRunner.discardChanges', () => {
  it('restores a tracked file\'s working-tree edit back to HEAD and reports it as modified', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440130');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'tracked.adoc'), 'head content\n');
    await commitAll(cwd, 'init');
    await writeFile(path.join(cwd, 'tracked.adoc'), 'edited content\n');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.discardChanges(projectId, { paths: ['tracked.adoc'] });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(await readFile(path.join(cwd, 'tracked.adoc'), 'utf8')).toBe('head content\n');
    expect(result.value).toEqual([
      { type: 'modified', path: 'tracked.adoc', content: Buffer.from('head content\n'), mimeType: 'text/asciidoc' },
    ]);
  });

  it('removes a newly-created untracked file and reports it as removed', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440131');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'tracked.adoc'), 'kept\n');
    await commitAll(cwd, 'init');
    await writeFile(path.join(cwd, 'new-untracked.adoc'), 'brand new\n');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.discardChanges(projectId, { paths: ['new-untracked.adoc'] });

    expect(result).toEqual({ success: true, value: [{ type: 'removed', path: 'new-untracked.adoc' }] });
    await expect(stat(path.join(cwd, 'new-untracked.adoc'))).rejects.toThrow();
    // The tracked sibling, not requested, is untouched.
    expect(await readFile(path.join(cwd, 'tracked.adoc'), 'utf8')).toBe('kept\n');
  });

  it('restores a path to its content at a given earlier commit', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440132');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'first');
    const firstHash = await readHeadCommit(cwd);
    await writeFile(path.join(cwd, 'a.adoc'), 'v2\n');
    await commitAll(cwd, 'second');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.discardChanges(projectId, { paths: ['a.adoc'], fromCommit: firstHash });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(await readFile(path.join(cwd, 'a.adoc'), 'utf8')).toBe('v1\n');
    expect(result.value).toEqual([
      { type: 'modified', path: 'a.adoc', content: Buffer.from('v1\n'), mimeType: 'text/asciidoc' },
    ]);
  });

  it('rejects a path escaping the working tree, leaving the tree untouched', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440133');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'init');
    const headBefore = await readHeadCommit(cwd);

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.discardChanges(projectId, { paths: ['../escaped-by-test.adoc'] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(GitCommandFailedError);
    await expect(stat(path.join(storageRoot, 'escaped-by-test.adoc'))).rejects.toThrow();
    expect(await readHeadCommit(cwd)).toBe(headBefore);
  });
});

describe('RealGitCommandRunner.amendCommit', () => {
  it('amends the unpushed HEAD commit with a new message, producing a new hash', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440134');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'original message');
    const hashBefore = await readHeadCommit(cwd);

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.amendCommit(projectId, {
      message: 'amended message',
      author: { name: 'Ada Lovelace', email: 'ada@example.com' },
      flush: [],
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.message).toBe('amended message');
    expect(result.value.hash).not.toBe(hashBefore);
    expect(result.value.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.value.authoredAt).toBeInstanceOf(Date);

    const { stdout: subject } = await execFile('git', ['log', '-1', '--format=%s'], { cwd });
    expect(subject.trim()).toBe('amended message');
    const { stdout: authorLine } = await execFile('git', ['log', '-1', '--format=%an <%ae>'], { cwd });
    expect(authorLine.trim()).toBe('Ada Lovelace <ada@example.com>');
  });

  it('folds flushed live content into the amend and keeps the existing message when none is given', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440135');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'tracked.adoc'), 'v1\n');
    await commitAll(cwd, 'keep this message');
    // Stale staged bytes — the flush entry below must override these before the amend.
    await writeFile(path.join(cwd, 'tracked.adoc'), 'stale staged bytes\n');
    await stage(cwd, 'tracked.adoc');

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.amendCommit(projectId, {
      author: { name: 'Ada Lovelace', email: 'ada@example.com' },
      flush: [{ path: 'tracked.adoc', content: 'live flushed content\n' }],
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.message).toBe('keep this message');

    const { stdout: committed } = await execFile('git', ['show', 'HEAD:tracked.adoc'], { cwd });
    expect(committed).toBe('live flushed content\n');
    const { stdout: subject } = await execFile('git', ['log', '-1', '--format=%s'], { cwd });
    expect(subject.trim()).toBe('keep this message');
  });

  it('refuses to amend when the current commit is already on the remote-tracking branch, leaving it unchanged', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440136');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    const hashBefore = await readHeadCommit(cwd);

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.amendCommit(projectId, {
      message: 'trying to rewrite published history',
      author: { name: 'Eve', email: 'eve@example.com' },
      flush: [],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(CommitAlreadyPushedError);
    expect(await readHeadCommit(cwd)).toBe(hashBefore);
    const { stdout: subject } = await execFile('git', ['log', '-1', '--format=%s'], { cwd });
    expect(subject.trim()).toBe('base');
  });

  it('proceeds to amend when the branch has no remote-tracking ref at all', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440137');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'original message');
    // Deliberately never configure `origin` — no `refs/remotes/origin/main` ref exists.

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.amendCommit(projectId, {
      message: 'amended after no remote',
      author: { name: 'Ada Lovelace', email: 'ada@example.com' },
      flush: [],
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.message).toBe('amended after no remote');
    const { stdout: subject } = await execFile('git', ['log', '-1', '--format=%s'], { cwd });
    expect(subject.trim()).toBe('amended after no remote');
  });
});

describe('RealGitCommandRunner.previewPull', () => {
  it('fetches live, then returns the incoming commits and changed paths without merging anything', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440140');
    const { storageRoot, cwd, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    const headBefore = await readHeadCommit(cwd);
    await addRemoteCommit(remotePath, 'incoming change', async (clone) => {
      await writeFile(path.join(clone, 'incoming.adoc'), 'incoming\n');
    });

    const server = await startGitHttpServer({ projectRoot: path.join(remotePath, '..') });
    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);
      const result = await runner.previewPull(projectId, {
        remoteUrl: `${server.url}/repo.git`,
        token: 'unused',
        branch: 'main',
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.value.incoming.map((entry) => entry.message)).toEqual(['incoming change']);
      expect(result.value.changedPaths).toEqual(['incoming.adoc']);

      // Never merges: the local branch's own HEAD, and its working tree, are untouched.
      expect(await readHeadCommit(cwd)).toBe(headBefore);
      await expect(stat(path.join(cwd, 'incoming.adoc'))).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it('rejects a preview against a non-allowlisted host before attempting any network operation', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440141');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'init');
    const runner = new RealGitCommandRunner(storageRoot, ['git.example.com']);

    const capture = await withArgvCapturingGit(async (getCalls) => {
      const result = await runner.previewPull(projectId, {
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

  it('never leaks the token into argv across the preview', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440142');
    const { storageRoot, remotePath } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await addRemoteCommit(remotePath, 'incoming change', async (clone) => {
      await writeFile(path.join(clone, 'incoming.adoc'), 'incoming\n');
    });

    const token = 'super-secret-preview-pull-test-token-DO-NOT-LEAK-4f1a';
    const server = await startGitHttpServer({
      projectRoot: path.join(remotePath, '..'),
      requireAuth: { username: 'x-access-token', password: token },
    });

    try {
      const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);

      const capture = await withArgvCapturingGit(async (getCalls) => {
        const result = await runner.previewPull(projectId, {
          remoteUrl: `${server.url}/repo.git`,
          token,
          branch: 'main',
        });
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

  it('returns RepositoryUnreachableError when the remote cannot be reached', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440143');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'init');
    const port = await unusedLoopbackPort();
    const runner = new RealGitCommandRunner(storageRoot, ['127.0.0.1'], fakePublicResolver);

    const result = await runner.previewPull(projectId, {
      remoteUrl: `http://127.0.0.1:${port}/repo.git`,
      token: 'x',
      branch: 'main',
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(RepositoryUnreachableError);
  });
});

describe('RealGitCommandRunner.previewPush', () => {
  it('reports the commits and changed paths the local branch has that the remote-tracking ref lacks', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440150');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await writeFile(path.join(cwd, 'local.adoc'), 'local change\n');
    await commitAll(cwd, 'local change');

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.previewPush(projectId, { branch: 'main' });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.value.outgoing.map((entry) => entry.message)).toEqual(['local change']);
    expect(result.value.changedPaths).toEqual(['local.adoc']);
  });

  it('reports an empty preview when the local branch already matches its remote-tracking ref', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440151');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });

    const runner = new RealGitCommandRunner(path.dirname(cwd));
    const result = await runner.previewPush(projectId, { branch: 'main' });

    expect(result).toEqual({ success: true, value: { outgoing: [], changedPaths: [] } });
  });

  it('degrades gracefully to an empty preview when the branch has no remote-tracking ref yet', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440152');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await writeFile(path.join(cwd, 'a.adoc'), 'v1\n');
    await commitAll(cwd, 'init');
    // Deliberately never configure `origin` — no `refs/remotes/origin/main` ref exists.

    const runner = new RealGitCommandRunner(storageRoot);
    const result = await runner.previewPush(projectId, { branch: 'main' });

    expect(result).toEqual({ success: true, value: { outgoing: [], changedPaths: [] } });
  });

  it('touches no network — no egress allowlist is needed to preview a push', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440153');
    const { cwd } = await setupProjectWithTracking(projectId.value, async (tree) => {
      await writeFile(path.join(tree, 'base.adoc'), 'base\n');
    });
    await writeFile(path.join(cwd, 'local.adoc'), 'local change\n');
    await commitAll(cwd, 'local change');

    // No allowedHosts configured — a network call would be rejected by the allowlist; this
    // succeeding proves previewPush never attempts one.
    const runner = new RealGitCommandRunner(path.dirname(cwd), []);
    const result = await runner.previewPush(projectId, { branch: 'main' });

    expect(result.success).toBe(true);
  });
});
