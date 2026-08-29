import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectId } from '@asciidocollab/domain';
import { RealGitCommandRunner } from '../../src/git/git-command-runner.js';
import { type HostAddressResolver } from '../../src/git/egress-allowlist.js';
import { createPushedRepoPair, commitAll, pushBranch } from '../helpers/temporary-git-repo.js';
import { startGitHttpServer, type GitHttpServer } from '../helpers/git-http-server.js';

const execFile = promisify(execFileCallback);

/** The out-of-band credential the served remote demands (its username is git-worker's fixed one). */
const USERNAME = 'x-access-token';
const TOKEN = 'super-secret-clone-token-DO-NOT-LEAK-7f3e';

/** The loopback host the test git-HTTP server binds to; allowlisted so the egress gate admits it. */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * A {@link HostAddressResolver} that answers every lookup with a fixed public IP literal, so the
 * egress gate admits the loopback-bound test server (whose real `127.0.0.1` address the gate would
 * otherwise reject as private). Git itself still connects to the URL's real loopback address — the
 * documented, accepted check-time-versus-connect-time window.
 */
const resolveToPublicAddress: HostAddressResolver = async () => [{ address: '93.184.216.34' }];

/** Reads the tip commit a ref resolves to in the working tree (test assertion helper, plain `git`). */
async function readReference(cwd: string, reference: string): Promise<string> {
  const result = await execFile('git', ['rev-parse', reference], { cwd });
  return result.stdout.trim();
}

describe('RealGitCommandRunner.clone (real git, real served remote) — working-tree adoption', () => {
  let server: GitHttpServer;

  afterEach(async () => {
    await server.close();
  });

  it('adopts the validated scratch clone as the project\'s own working tree, .git and all', async () => {
    const { workingTree, remoteProjectRoot } = await createPushedRepoPair();
    // A second commit so headCommit/entries reflect real content, not just the fixture's one file.
    await writeFile(path.join(workingTree, 'second.txt'), 'second\n');
    await commitAll(workingTree, 'second commit');
    await pushBranch(workingTree, 'main');
    const headCommit = await readReference(workingTree, 'HEAD');

    server = await startGitHttpServer({
      projectRoot: remoteProjectRoot,
      requireAuth: { username: USERNAME, password: TOKEN },
    });

    // Storage root exists, but the project's own working-tree directory under it does NOT — clone
    // must create it (mirroring an import onto a project that has no working tree yet).
    const storageRoot = await mkdtemp(path.join(tmpdir(), 'git-worker-test-clone-storage-'));
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440088');
    const projectWorkingTree = path.join(storageRoot, projectId.value);

    const runner = new RealGitCommandRunner(storageRoot, [LOOPBACK_HOST], resolveToPublicAddress);
    const result = await runner.clone({
      projectId,
      remoteUrl: `${server.url}/repo.git`,
      token: TOKEN,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.headCommit).toBe(headCommit);

    // The adoption itself: the project's real working-tree path now holds a full repository — a
    // `.git` directory (not just the bare file contents materializeEntries() already returned) —
    // checked out at the cloned HEAD, so every later git operation on this project runs for real.
    const insideWorkTreeOutput = await execFile('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectWorkingTree,
    });
    expect(insideWorkTreeOutput.stdout.trim()).toBe('true');

    const adoptedHead = await readReference(projectWorkingTree, 'HEAD');
    expect(adoptedHead).toBe(headCommit);

    // A plain `git clone` already creates refs/remotes/origin/<branch> — adoption must preserve it
    // (unlike initializeAndPublish, which has to manufacture the equivalent ref by hand).
    const trackingReference = await readReference(projectWorkingTree, 'refs/remotes/origin/main');
    expect(trackingReference).toBe(headCommit);

    // The working files themselves were copied over, not just tracked by git metadata.
    const secondFileContent = await readFile(path.join(projectWorkingTree, 'second.txt'), 'utf8');
    expect(secondFileContent).toBe('second\n');

    // And the returned entries match what actually landed on disk.
    const entryPaths = result.value.entries.map((entry) => entry.path).toSorted();
    expect(entryPaths).toEqual(['f.txt', 'second.txt']);
  });

  it('clears a stale abandoned-import working tree before adopting a fresh clone into its place', async () => {
    const { workingTree, remoteProjectRoot } = await createPushedRepoPair();
    const headCommit = await readReference(workingTree, 'HEAD');

    server = await startGitHttpServer({
      projectRoot: remoteProjectRoot,
      requireAuth: { username: USERNAME, password: TOKEN },
    });

    const storageRoot = await mkdtemp(path.join(tmpdir(), 'git-worker-test-clone-storage-'));
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440099');
    const projectWorkingTree = path.join(storageRoot, projectId.value);

    // Simulate a stale tree left behind by a prior abandoned import: a directory with unrelated
    // content, no relation to what is about to be cloned.
    await mkdir(projectWorkingTree, { recursive: true });
    await writeFile(path.join(projectWorkingTree, 'stale-leftover.txt'), 'stale\n');

    const runner = new RealGitCommandRunner(storageRoot, [LOOPBACK_HOST], resolveToPublicAddress);
    const result = await runner.clone({
      projectId,
      remoteUrl: `${server.url}/repo.git`,
      token: TOKEN,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.headCommit).toBe(headCommit);

    // The stale file must be gone — the adopted tree is exactly the fresh clone, not a merge of the
    // two.
    await expect(readFile(path.join(projectWorkingTree, 'stale-leftover.txt'), 'utf8')).rejects.toThrow();
    const adoptedFile = await readFile(path.join(projectWorkingTree, 'f.txt'), 'utf8');
    expect(adoptedFile).toBe('hello\n');
  });
});
