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
 * Where a pending change currently stands in the working tree/index. `conflicted` names a
 * change left unresolved by a merge or rebase; no use case in this package produces it yet — it
 * exists now so a later merge/pull story can populate it without another type change.
 */
export type GitPendingChangeState = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

/**
 * A single working-tree change, awaiting commit, and where it currently stands
 * (`state`) — staged for the next commit, an unstaged edit to a tracked file, a brand-new
 * file never `git add`-ed, or left conflicted by an unresolved merge.
 */
export interface GitPendingChange {
  /** Project-relative path of the changed file. */
  readonly path: string;
  /** The kind of change. */
  readonly changeType: GitPendingChangeType;
  /** Where this change currently stands in the working tree/index. */
  readonly state: GitPendingChangeState;
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

/** Input for {@link GitCommandRunner.clone}. */
export interface GitCloneInput {
  /** The remote's URL, exactly as the caller supplied it. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Used only for this call, never persisted. */
  readonly token: string;
  /** The branch to check out, or the remote's default branch when omitted. */
  readonly branch?: string;
}

/**
 * One file a clone produced: its path (workspace-relative, POSIX separators, no leading slash —
 * e.g. `chapters/intro.adoc`) and its bytes, exactly as the remote's default (or requested) branch
 * has them. `.git/` and LFS plumbing (`.gitattributes`) are resolved by the runner — an LFS pointer
 * is smudged to the real object's bytes before this entry is produced, so a caller never has to
 * recognize or special-case a pointer file — but nothing here excludes internal platform paths
 * (e.g. `.collab/`); doing that is the caller's responsibility, the same way it decides everything
 * else about how the bytes become a project.
 */
export interface ClonedFileEntry {
  /** Workspace-relative path, POSIX separators, no leading slash. */
  readonly path: string;
  /** The file's bytes, already resolved past any LFS pointer. */
  readonly content: Buffer;
  /** Best-effort MIME type for the file, as the runner determined it. */
  readonly mimeType: string;
}

/** What a completed clone produced: every tracked file, and the remote state it was cloned at. */
export interface ClonedRepository {
  /** The remote's default branch (what its `HEAD` points to). */
  readonly defaultBranch: string;
  /** The commit hash of the branch that was cloned, as observed at clone time. */
  readonly headCommit: string;
  /** Every tracked file the clone produced. Directories are implicit in each entry's path. */
  readonly entries: readonly ClonedFileEntry[];
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

  /**
   * Clones a remote's branch (its default branch when none is given) into a scratch working tree
   * and returns every tracked file it contains. Used by `ImportRepository` to materialize a
   * brand-new project's file tree from an external remote — this call does not touch any
   * project's own working tree or storage; translating the returned entries into that project's
   * `FileNode`/`Document`/`Asset` rows and stored bytes is the caller's job.
   *
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to
   *   clone (defaults to the remote's default branch).
   * @returns The cloned repository's files and the branch/commit they were cloned at; a
   *   `RepositoryUnreachableError`/`AuthenticationFailedError` on the same terms as
   *   {@link checkRemoteAccess}, or a `GitCommandFailedError` for any other failure (for example,
   *   the remote exceeds a configured size limit).
   */
  clone(
    input: GitCloneInput,
  ): Promise<Result<ClonedRepository, RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError>>;
}
