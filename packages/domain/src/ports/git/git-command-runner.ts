import { ProjectId } from '../../value-objects/ids/project-id';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../errors/git/authentication-failed';
import { Result } from '../../types/result';

/**
 * The kind of working-tree change a pending change represents. `renamed` is the
 * canonical label for a move as well as a rename — there is no separate `moved` value.
 */
export type GitPendingChangeType = 'added' | 'modified' | 'removed' | 'renamed' | 'copied';

/**
 * A single working-tree change, staged or not, awaiting commit. Shaped to match
 * `packages/shared`'s `PendingChangeDto` exactly, so the infrastructure adapter that
 * implements this port can hand one to the API boundary unchanged.
 */
export interface GitPendingChange {
  /** Project-relative path of the changed file. */
  readonly path: string;
  /** The kind of change. */
  readonly changeType: GitPendingChangeType;
  /** Whether this change is currently staged for the next commit. */
  readonly staged: boolean;
}

/** A project's working tree: its current branch and its uncommitted changes. */
export interface GitWorkingTreeStatus {
  /** The currently checked-out branch. */
  readonly currentBranch: string;
  /** Every pending (uncommitted) change, staged or not. */
  readonly changes: readonly GitPendingChange[];
}

/** Input for {@link GitCommandRunner.checkRemoteAccess}. */
export interface GitRemoteAccessCheck {
  /** The remote's URL, exactly as the caller supplied it. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Used only for this check, never persisted. */
  readonly token: string;
}

/**
 * Port for running scoped git actions against a project's sandboxed working tree.
 *
 * The real adapter (`apps/git-worker`) runs the actual `git` CLI via `execFile` inside a
 * sandboxed container; this interface is the hard boundary that keeps every git-library
 * type (e.g. `simple-git`) out of the domain. Every method returns either a domain-owned
 * type shaped to match its `packages/shared` DTO counterpart, or a `Result`-wrapped typed
 * error — never a raw git-library value.
 *
 * This is a foundational, deliberately minimal port: only the read-only status query
 * needed to unblock the earliest git use cases is defined here. Story tasks extend this
 * interface with the mutating and history/diff operations it will eventually cover
 * (clone, stage, commit, push, fetch, merge, branch, checkout, stash, log, diff, ...) as
 * each is built — add new methods here alongside a corresponding in-memory fake method.
 */
export interface GitCommandRunner {
  /**
   * Reads the working tree's current branch and its pending (uncommitted) changes.
   *
   * @param projectId - The project whose working tree to inspect.
   * @returns The current branch and pending changes, or a `GitCommandFailedError` when
   *   the working tree cannot be read (for example, it has not been initialized yet).
   */
  getStatus(projectId: ProjectId): Promise<Result<GitWorkingTreeStatus, GitCommandFailedError>>;

  /**
   * Verifies that a remote can be reached and that the given token authenticates against it,
   * without cloning or otherwise materializing a working tree. This is the connectivity/auth check
   * `ConnectRepository` (and other remote-connecting use cases) runs before a credential is ever
   * stored, so a bad remote URL or a rejected token is never persisted.
   *
   * @param check - The remote URL and the plaintext token to check it with.
   * @returns Success once the remote is reachable and the token was accepted; a
   *   `RepositoryUnreachableError` when the remote itself could not be reached, or an
   *   `AuthenticationFailedError` when it was reached but rejected the token.
   */
  checkRemoteAccess(
    check: GitRemoteAccessCheck,
  ): Promise<Result<void, RepositoryUnreachableError | AuthenticationFailedError>>;
}
