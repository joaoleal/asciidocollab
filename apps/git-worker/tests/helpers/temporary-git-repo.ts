import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCallback);

/** Runs a plain `git` command for test setup — NOT the security-hardened wrapper under test. */
async function git(cwd: string, arguments_: string[]): Promise<void> {
  await execFile('git', arguments_, { cwd });
}

/**
 * Creates a temporary git working tree, initialized on branch `main` with a test author
 * configured. Test-only setup helper — uses plain `git`, not `runGitCommand`.
 *
 * @returns The absolute path to the new working tree.
 */
export async function createTemporaryWorkingTree(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'git-worker-test-tree-'));
  await git(directory, ['init', '-q', '-b', 'main', '.']);
  await git(directory, ['config', 'user.email', 'test@example.com']);
  await git(directory, ['config', 'user.name', 'Test']);
  return directory;
}

/**
 * Creates a fresh temporary `storageRoot` directory and initializes a git working tree at
 * `<storageRoot>/<projectId>/` — the exact layout `RealGitCommandRunner` resolves via
 * `resolveWorkingTreePath`.
 *
 * @param projectId - The project id whose working tree segment to create.
 * @returns The storage root directory (NOT the working tree itself).
 */
export async function createTemporaryStorageRootWithProject(projectId: string): Promise<string> {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'git-worker-test-storage-'));
  const workingTree = path.join(storageRoot, projectId);
  await mkdir(workingTree, { recursive: true });
  await git(workingTree, ['init', '-q', '-b', 'main', '.']);
  await git(workingTree, ['config', 'user.email', 'test@example.com']);
  await git(workingTree, ['config', 'user.name', 'Test']);
  return storageRoot;
}

/**
 * Creates a temporary bare git repository, suitable as a local "remote" for clone/fetch/push
 * tests.
 *
 * @returns The absolute path to the new bare repository.
 */
export async function createTemporaryBareRemote(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'git-worker-test-remote-'));
  const bareDirectory = path.join(parent, 'repo.git');
  await mkdir(bareDirectory, { recursive: true });
  await git(bareDirectory, ['init', '-q', '--bare']);
  await git(bareDirectory, ['config', 'http.receivepack', 'true']);
  return bareDirectory;
}

/**
 * Creates a temporary bare git repository exactly like {@link createTemporaryBareRemote}, except
 * it leaves `http.receivepack` at git's own default (`false`) — smart-HTTP push is refused, while
 * `ls-remote`/clone/fetch (which only need `upload-pack`) still work. Used to simulate a
 * read-only/rejecting remote for a forced push-failure test.
 *
 * @returns The absolute path to the new bare repository.
 */
export async function createTemporaryReadOnlyBareRemote(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'git-worker-test-remote-readonly-'));
  const bareDirectory = path.join(parent, 'repo.git');
  await mkdir(bareDirectory, { recursive: true });
  await git(bareDirectory, ['init', '-q', '--bare']);
  return bareDirectory;
}

/**
 * Creates a fresh temporary `storageRoot` directory with a project working-tree directory at
 * `<storageRoot>/<projectId>/` that is a PLAIN directory — never `git init`-ed — mirroring a
 * project that has never been git-managed. `seed` writes whatever project files should already be
 * there before a test's `initializeAndPublish` call runs.
 *
 * @param projectId - The project id whose working-tree segment to create.
 * @param seed - Writes the project's pre-existing files into the working tree.
 * @returns The storage root directory (NOT the working tree itself).
 */
export async function createTemporaryStorageRootWithUninitializedProject(
  projectId: string,
  seed: (workingTree: string) => Promise<void>,
): Promise<string> {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'git-worker-test-storage-nogit-'));
  const workingTree = path.join(storageRoot, projectId);
  await mkdir(workingTree, { recursive: true });
  await seed(workingTree);
  return storageRoot;
}

/**
 * Writes a file's content and creates a commit for it in one step (test setup helper).
 *
 * @param workingTree - The working tree to commit into.
 * @param message - The commit message.
 */
export async function commitAll(workingTree: string, message: string): Promise<void> {
  await git(workingTree, ['add', '-A']);
  await git(workingTree, ['commit', '-q', '-m', message]);
}

/**
 * Adds `origin` pointing at `remotePath` and pushes the current branch to it as `main`, then
 * points the bare remote's own `HEAD` at that branch.
 *
 * The fix-up matters: `git init --bare` sets a bare repository's `HEAD` symbolic ref to whatever
 * `init.defaultBranch` names (commonly `master`), regardless of what branch is later pushed into
 * it — unlike a real hosting provider, which always keeps `HEAD` pointed at the actual default
 * branch. Left uncorrected, cloning this fixture would report "remote HEAD refers to nonexistent
 * ref" and check out nothing at all.
 *
 * @param workingTree - The working tree to push from.
 * @param remotePath - The bare repository to push to.
 */
export async function pushToOrigin(workingTree: string, remotePath: string): Promise<void> {
  await git(workingTree, ['remote', 'add', 'origin', remotePath]);
  await git(workingTree, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  await git(remotePath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
}

/**
 * Pushes the working tree's current `HEAD` as an additional branch to an already-configured
 * `origin` remote (see {@link pushToOrigin} / {@link createPushedRepoPair}), without touching the
 * remote's `HEAD` — used to give a test fixture a second, non-default branch.
 *
 * @param workingTree - The working tree to push from (with `origin` already configured).
 * @param branch - The branch name to push and create on the remote.
 */
export async function pushBranch(workingTree: string, branch: string): Promise<void> {
  await git(workingTree, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
}

/**
 * Builds a working tree with one commit, pushed to a fresh bare remote — the common fixture
 * shared by the credential and redirect integration tests.
 *
 * @returns The working tree path and the bare remote's project-root directory (its parent, for
 *   `GIT_PROJECT_ROOT`) and repo name.
 */
export async function createPushedRepoPair(): Promise<{
  workingTree: string;
  remotePath: string;
  remoteProjectRoot: string;
}> {
  const workingTree = await createTemporaryWorkingTree();
  const remotePath = await createTemporaryBareRemote();

  await writeFile(path.join(workingTree, 'f.txt'), 'hello\n');
  await commitAll(workingTree, 'init');
  await pushToOrigin(workingTree, remotePath);

  return { workingTree, remotePath, remoteProjectRoot: path.join(remotePath, '..') };
}
