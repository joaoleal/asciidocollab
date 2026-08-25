import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectId } from '@asciidocollab/domain';
import { runGitCommand } from './run-git-command.js';

/**
 * Resolves a project's git working tree directory: `<storageRoot>/<projectId>/`.
 *
 * @param storageRoot - The configured root directory for per-project storage.
 * @param projectId - The project whose working tree path to resolve.
 * @returns The absolute (or storageRoot-relative) path to the project's working tree.
 */
export function resolveWorkingTreePath(storageRoot: string, projectId: ProjectId): string {
  return path.join(storageRoot, projectId.value);
}

/**
 * Restores a project's working tree to a known-clean state before a job runs: discards any
 * uncommitted staged/unstaged changes (`reset --hard`, a no-op on a repository with no commits
 * yet) and removes untracked and ignored files (`clean -fdx`) — the per-job clean-start guarantee
 * (Security Constitution, Git Sandbox Security) that keeps one job from ever observing another
 * job's leftover state.
 *
 * `.collab/` — the Yjs collaborative-editing blob store — is excluded from the clean step. It
 * lives inside the working tree as an internal sibling of the tracked project files, not project
 * content, and is never tracked by git, so a plain `clean -fdx` would otherwise delete it (as an
 * untracked, and once the managed `.gitignore` is in place, also ignored, path) on every job.
 *
 * A working tree that is not a git repository yet — `<cwd>/.git` does not exist, whether because
 * `cwd` itself does not exist or because it is a plain, never-git-managed directory — has nothing
 * to reset or clean: this is a no-op in that case, rather than running `git reset`/`git clean`
 * against a non-repository, which would otherwise throw. This is what lets the caller run this
 * unconditionally before every job, including one whose own handler is what first turns `cwd` into
 * a git repository.
 *
 * @param cwd - The working tree to clean.
 * @throws {GitProcessError} If either `git` invocation fails.
 */
export async function ensureCleanWorkingTree(cwd: string): Promise<void> {
  const isGitRepository = await stat(path.join(cwd, '.git'))
    .then(() => true)
    .catch(() => false);
  if (!isGitRepository) return;

  await runGitCommand(cwd, { command: 'reset', flags: ['--hard'] });
  await runGitCommand(cwd, { command: 'clean', flags: ['-fdx', '-e', '/.collab/'] });
}
