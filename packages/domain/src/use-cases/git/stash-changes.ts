import { ProjectId } from '../../value-objects/ids/project-id';
import { GitCommandRunner, GitStashOutcome, GitStashRestoreOutcome } from '../../ports/git/git-command-runner';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { Result } from '../../types/result';

/**
 * Shelves and restores a project's uncommitted working-tree changes.
 *
 * A standalone domain service, not a role-gated use case — it has no route and no independent
 * authorization surface. It exists so a branch-switch operation can safely preserve uncommitted
 * work across a checkout: shelve before switching, restore afterward. The composing operation owns
 * the authorization gate; this service only wraps the two underlying port calls and hands back
 * their typed outcomes so the caller can decide what to do next (was there anything to shelve? did
 * the restore leave conflicts to resolve?).
 */
export class StashChanges {
  /**
   * @param commandRunner - Runs the actual shelve/restore commands against the project's working tree.
   * @param logger - Optional sink for best-effort diagnostics.
   */
  constructor(
    private readonly commandRunner: GitCommandRunner,
    private readonly logger?: Logger,
  ) {}

  /**
   * Shelves the project's uncommitted working-tree changes.
   *
   * @param projectId - The project whose working tree to shelve changes from.
   * @returns `{stashed: true}` when there were changes and they were shelved; `{stashed: false}` when
   *   the working tree was already clean. The `GitCommandFailedError` the underlying command fails
   *   with, on failure.
   */
  async shelve(projectId: ProjectId): Promise<Result<GitStashOutcome, DomainError>> {
    return this.commandRunner.stashChanges(projectId);
  }

  /**
   * Restores previously-shelved changes onto the working tree.
   *
   * A restore that leaves conflict markers is a SUCCESSFUL result (`{hadConflicts: true}`), not an
   * error — the caller inspects it to decide whether the user must resolve conflicts before
   * continuing.
   *
   * @param projectId - The project whose working tree to restore shelved changes onto.
   * @returns `{hadConflicts: false}` when the restore was clean; `{hadConflicts: true}` when it left
   *   conflicts to resolve. The `GitCommandFailedError` the underlying command fails with, on failure.
   */
  async restore(projectId: ProjectId): Promise<Result<GitStashRestoreOutcome, DomainError>> {
    return this.commandRunner.restoreStash(projectId);
  }
}
