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
 * Adds `origin` pointing at `remotePath` and pushes the current branch to it.
 *
 * @param workingTree - The working tree to push from.
 * @param remotePath - The bare repository to push to.
 */
async function pushToOrigin(workingTree: string, remotePath: string): Promise<void> {
  await git(workingTree, ['remote', 'add', 'origin', remotePath]);
  await git(workingTree, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
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
