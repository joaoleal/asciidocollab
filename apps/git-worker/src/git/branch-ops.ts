import {
  GitCommandFailedError,
  type GitBranchList,
  type GitCreateBranchInput,
  type GitCreatedBranch,
  type ProjectId,
  type Result,
} from '@asciidocollab/domain';
import { readRevParseAnswer } from './git-command-helpers.js';
import { runGitCommand } from './run-git-command.js';
import { resolveWorkingTreePath } from './working-tree.js';

/**
 * Local branch-management git operations: enumerating a project's local branches and creating a new
 * one from the current tip. Both touch no network — purely local reads/writes against the project's
 * own working tree.
 */
export class BranchOps {
  /**
   * @param storageRoot - Root directory for per-project storage (see {@link resolveWorkingTreePath}).
   */
  constructor(private readonly storageRoot: string) {}

  /**
   * Lists the project's local branches and which one is currently checked out. Touches no network.
   *
   * `git for-each-ref --format=%(refname:short) refs/heads` yields one local branch name per line;
   * `git rev-parse --abbrev-ref HEAD` names the checked-out branch. `refs/heads` is a fixed,
   * code-authored ref pattern, never caller input.
   *
   * @param projectId - The project whose working tree to list branches for.
   * @returns The current branch and every local branch name; a `GitCommandFailedError` (generic
   *   message) when the underlying git command fails.
   */
  async listBranches(projectId: ProjectId): Promise<Result<GitBranchList, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    try {
      const currentResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['--abbrev-ref', 'HEAD'] });
      const current = readRevParseAnswer(currentResult.stdout);

      const listResult = await runGitCommand(cwd, {
        command: 'for-each-ref',
        flags: ['--format=%(refname:short)', 'refs/heads'],
      });
      const branches = listResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      return { success: true, value: { current, branches } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The project branches could not be listed.') };
    }
  }

  /**
   * Creates a new local branch from the current branch tip WITHOUT switching to it (HEAD unchanged).
   * Touches no network.
   *
   * `git branch <name>` with `name` as a positional AFTER `--end-of-options` (the option-injection
   * guard `runGitCommand` applies to every positional), so a name beginning with `-` can never be
   * reparsed as a flag. The name is not validated here: a duplicate name, or one git rejects as an
   * invalid ref name, exits non-zero and becomes a generic `GitCommandFailedError`.
   *
   * @param projectId - The project whose working tree to create the branch in.
   * @param input - The new branch's name.
   * @returns The created branch on success; a `GitCommandFailedError` (generic message) when the
   *   underlying git command fails (a duplicate or invalid name).
   */
  async createBranch(
    projectId: ProjectId,
    input: GitCreateBranchInput,
  ): Promise<Result<GitCreatedBranch, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    try {
      await runGitCommand(cwd, { command: 'branch', positionals: [input.name] });
      return { success: true, value: { name: input.name } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The branch could not be created.') };
    }
  }
}
