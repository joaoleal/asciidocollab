import { mkdtemp, lstat, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AuthenticationFailedError,
  GitCommandFailedError,
  RepositoryUnreachableError,
  type ClonedFileEntry,
  type ClonedRepository,
  type GitCloneInput,
  type GitCommandRunner,
  type GitPendingChange,
  type GitPendingChangeType,
  type GitRemoteAccessCheck,
  type GitWorkingTreeStatus,
  type ProjectId,
  type Result,
} from '@asciidocollab/domain';
import { assertRemoteHostAllowed, type HostAddressResolver } from './egress-allowlist.js';
import { guessMimeType } from './guess-mime-type.js';
import { declaresLfsFilter } from './lfs-pointer.js';
import { GitProcessError, runGitCommand } from './run-git-command.js';
import { resolveWorkingTreePath } from './working-tree.js';

/**
 * The username presented alongside every access token this runner supplies over HTTP Basic auth.
 * A git hosting provider authenticating a personal/installation access token accepts (and mostly
 * ignores) any non-empty username in this slot — this fixed placeholder is never itself a secret.
 */
const CREDENTIAL_USERNAME = 'x-access-token';

/**
 * Maps a failure from the network-facing steps of {@link RealGitCommandRunner.clone} to this
 * port's typed clone error union, using {@link GitProcessError.networkFailureKind} when the
 * failure was classified as a reachability or credential problem, and a generic
 * `GitCommandFailedError` for everything else (a missing branch, an oversized remote once a size
 * limit is enforced, and so on).
 */
function toCloneFailure(
  error: unknown,
): RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError {
  if (error instanceof GitProcessError) {
    if (error.networkFailureKind === 'unreachable') return new RepositoryUnreachableError();
    if (error.networkFailureKind === 'authentication-failed') return new AuthenticationFailedError();
  }
  return new GitCommandFailedError('The repository could not be cloned.');
}

/**
 * Maps a failure from {@link RealGitCommandRunner.checkRemoteAccess}'s `ls-remote` probe to this
 * port's narrower error union (no `GitCommandFailedError` case exists here). A failure this
 * runner cannot positively classify as a rejected credential is treated as the remote being
 * unreachable — the conservative default, since an unclassified failure gives no evidence the
 * credential was ever actually evaluated.
 */
function toRemoteAccessFailure(error: unknown): RepositoryUnreachableError | AuthenticationFailedError {
  if (error instanceof GitProcessError && error.networkFailureKind === 'authentication-failed') {
    return new AuthenticationFailedError();
  }
  return new RepositoryUnreachableError();
}

/**
 * Reports whether a cloned working tree's `.gitattributes` (if any) declares a Large File Storage
 * filter, the signal {@link RealGitCommandRunner.clone} uses to decide whether it needs to invoke
 * `git lfs` at all — a repository that never uses LFS never requires the `git-lfs` extension to be
 * installed.
 */
async function workingTreeUsesLfs(workingDirectory: string): Promise<boolean> {
  const content = await readFile(path.join(workingDirectory, '.gitattributes'), 'utf8').catch(() => '');
  return declaresLfsFilter(content);
}

/**
 * Extracts `git rev-parse`'s answer from its stdout, discarding the literal `--end-of-options`
 * line it echoes back verbatim as an unrecognized argument.
 *
 * Unlike most subcommands, `rev-parse` does not consume `runGitCommand`'s always-appended
 * `--end-of-options` disambiguator as pure option-parsing punctuation — it treats it as just
 * another argument it cannot resolve as a revision, and (by design, since `rev-parse` is meant to
 * echo back whatever a caller hands it) prints it back on its own line, in whatever position it
 * held in argv relative to the actual revision. Filtering out that one known literal, rather than
 * relying on its position, is robust to either ordering.
 *
 * @param stdout - The raw stdout of a single-revision `git rev-parse` invocation.
 * @returns The resolved revision, or an empty string if nothing else was printed.
 */
function readRevParseAnswer(stdout: string): string {
  const answer = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== '--end-of-options');
  return answer ?? '';
}

/**
 * Reads every file `git ls-files` reports as tracked in `workingDirectory` (the clone's default,
 * or requested, branch) into this port's `ClonedFileEntry` shape. `.git/` is never among them —
 * `ls-files` only ever lists tracked blobs, never the repository's own metadata directory.
 *
 * A tracked path that is a symbolic link resolving outside `workingDirectory` is skipped outright:
 * `readFile` follows symlinks, so an untrusted clone containing one pointed at an arbitrary host
 * path (`/etc/passwd`, another project's storage, ...) must never be allowed to smuggle that
 * file's bytes into the imported project under an innocuous-looking name.
 *
 * @param workingDirectory - The clone's working tree root.
 * @returns Every safely-readable tracked file, as a `ClonedFileEntry`.
 */
async function materializeEntries(workingDirectory: string): Promise<ClonedFileEntry[]> {
  const { stdout } = await runGitCommand(workingDirectory, { command: 'ls-files', flags: ['-z'] });
  const relativePaths = stdout.split('\0').filter((entry) => entry.length > 0);

  const entries: ClonedFileEntry[] = [];
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(workingDirectory, relativePath);

    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      const target = await realpath(absolutePath).catch(() => null);
      const relativeToRoot = target ? path.relative(workingDirectory, target) : null;
      const escapesWorkingTree =
        relativeToRoot === null || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot);
      if (escapesWorkingTree) continue;
    }

    const content = await readFile(absolutePath);
    entries.push({ path: relativePath, content, mimeType: guessMimeType(relativePath) });
  }
  return entries;
}

/**
 * Real `GitCommandRunner` adapter: runs the actual `git` CLI, through {@link runGitCommand}'s
 * secure `execFile` wrapper, against each project's working tree at
 * `<storageRoot>/<projectId>/`, mapping raw git output to this port's domain-owned types.
 * Git-library types never cross this boundary — this class is the only place in git-worker that
 * shells out to `git` for the operations it implements.
 */
export class RealGitCommandRunner implements GitCommandRunner {
  /**
   * @param storageRoot - Root directory for per-project storage (see {@link resolveWorkingTreePath}).
   * @param allowedHosts - The configured git network egress allowlist (`git.egress.allowedHosts`).
   *   Defaults to empty (deny-by-default) so a caller that omits it can never reach a remote.
   *   Every method that reaches a remote (clone, fetch, push, ...) must call
   *   {@link RealGitCommandRunner.assertRemoteAllowed} with that remote's URL before running any
   *   network `git` command.
   * @param resolveHost - Overrides the DNS resolution `assertRemoteAllowed` validates a remote
   *   host's address against. Defaults to real DNS resolution; only ever overridden by tests, the
   *   same seam `assertRemoteHostAllowed` itself already exposes for the same reason.
   */
  constructor(
    private readonly storageRoot: string,
    private readonly allowedHosts: readonly string[] = [],
    private readonly resolveHost?: HostAddressResolver,
  ) {}

  /**
   * Gates a git network operation on the configured egress allowlist, resolving `remoteUrl`'s
   * host and rejecting before any `git` process is spawned when that host is not allowed, or
   * resolves to a private/link-local address (closing a DNS-rebinding path around an otherwise
   * allowlisted hostname).
   *
   * This validates the resolved address at check time only — it does not pin the connection
   * `git` itself makes moments later to that exact address (see `assertRemoteHostAllowed`'s own
   * documentation of this residual, accepted TOCTOU window). Every call site below invokes this
   * immediately before its first network `git` command, which minimizes — but, short of forcing
   * `git`'s own connection to the validated address, cannot close — that window.
   *
   * @param remoteUrl - The remote URL the caller is about to contact.
   * @returns Resolves if the remote is allowed to be contacted; otherwise rejects.
   * @throws {RemoteHostNotAllowedError} If the remote host is not allowlisted, or resolves to a
   *   private/link-local address.
   */
  async assertRemoteAllowed(remoteUrl: string): Promise<void> {
    await assertRemoteHostAllowed(remoteUrl, this.allowedHosts, this.resolveHost);
  }

  /**
   * Reads the working tree's current branch and its pending (uncommitted) changes via
   * `git status --porcelain=v2 --branch --find-renames`.
   *
   * @param projectId - The project whose working tree to inspect.
   * @returns The current branch and pending changes, or a `GitCommandFailedError` when the
   *   working tree cannot be read (for example, it has not been initialized yet).
   */
  async getStatus(projectId: ProjectId): Promise<Result<GitWorkingTreeStatus, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    let stdout: string;
    try {
      const result = await runGitCommand(cwd, {
        command: 'status',
        flags: ['--porcelain=v2', '--branch', '--find-renames'],
      });
      stdout = result.stdout;
    } catch {
      // runGitCommand's only failure mode is a GitProcessError (spawn failure or non-zero exit,
      // e.g. the working tree does not exist yet) — never surfaced with raw process output, per
      // the domain error's contract.
      return {
        success: false,
        error: new GitCommandFailedError('Could not read the project working tree status.'),
      };
    }

    const status = parsePorcelainStatus(stdout);
    if (!status) {
      return {
        success: false,
        error: new GitCommandFailedError('Could not read the project working tree status.'),
      };
    }
    return { success: true, value: status };
  }

  /**
   * Verifies a remote can be reached and that `check.token` authenticates against it, without
   * cloning or otherwise materializing any working tree — a cheap `git ls-remote` probe run in a
   * throwaway scratch directory, gated on {@link assertRemoteAllowed} exactly as {@link clone} is.
   *
   * @param check - The remote URL and the plaintext token to check it with.
   * @returns Success once the remote is reachable and the token was accepted; a
   *   `RepositoryUnreachableError`/`AuthenticationFailedError` otherwise.
   */
  async checkRemoteAccess(
    check: GitRemoteAccessCheck,
  ): Promise<Result<void, RepositoryUnreachableError | AuthenticationFailedError>> {
    try {
      await this.assertRemoteAllowed(check.remoteUrl);
    } catch {
      return { success: false, error: new RepositoryUnreachableError() };
    }

    const scratchDirectory = await mkdtemp(path.join(tmpdir(), 'git-worker-remote-check-'));
    try {
      await runGitCommand(scratchDirectory, {
        command: 'ls-remote',
        positionals: [check.remoteUrl],
        credential: { username: CREDENTIAL_USERNAME, token: check.token },
      });
      return { success: true, value: undefined };
    } catch (error) {
      return { success: false, error: toRemoteAccessFailure(error) };
    } finally {
      await rm(scratchDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Clones a remote's branch (its default when `input.branch` is omitted) into a temporary
   * scratch working tree — never a project's own storage, which does not exist yet at import
   * time — and returns every tracked file it contains, then removes the scratch tree regardless
   * of outcome.
   *
   * Order of operations: {@link assertRemoteAllowed} gates the whole call before any network
   * attempt; a plain `clone` fetches every branch and checks out the remote's default; the default
   * branch's name is read off that checkout before anything might switch away from it (so the
   * returned `defaultBranch` always names the remote's actual default, never whatever branch ends
   * up checked out); a requested non-default branch is then checked out over it; an LFS pull runs
   * only if the working tree's `.gitattributes` actually declares one (see
   * {@link workingTreeUsesLfs}), so a repository that never uses LFS never requires the
   * `git-lfs` extension; and finally `headCommit` and the tracked file set are read off whatever
   * ended up checked out.
   *
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to
   *   clone (defaults to the remote's default branch).
   * @returns The cloned repository's files and the branch/commit they were cloned at; a
   *   `RepositoryUnreachableError`/`AuthenticationFailedError` on the same terms as
   *   {@link checkRemoteAccess}, or a `GitCommandFailedError` for any other failure.
   */
  async clone(
    input: GitCloneInput,
  ): Promise<Result<ClonedRepository, RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError>> {
    try {
      await this.assertRemoteAllowed(input.remoteUrl);
    } catch {
      return { success: false, error: new RepositoryUnreachableError() };
    }

    const scratchParent = await mkdtemp(path.join(tmpdir(), 'git-worker-clone-'));
    const workingDirectory = path.join(scratchParent, 'clone');

    try {
      try {
        await runGitCommand(scratchParent, {
          command: 'clone',
          flags: ['--quiet'],
          positionals: [input.remoteUrl, workingDirectory],
          credential: { username: CREDENTIAL_USERNAME, token: input.token },
        });
      } catch (error) {
        return { success: false, error: toCloneFailure(error) };
      }

      const defaultBranchOutput = await runGitCommand(workingDirectory, {
        command: 'rev-parse',
        flags: ['--abbrev-ref', 'HEAD'],
      });
      const defaultBranch = readRevParseAnswer(defaultBranchOutput.stdout);

      if (input.branch && input.branch !== defaultBranch) {
        try {
          await runGitCommand(workingDirectory, { command: 'checkout', positionals: [input.branch] });
        } catch {
          return {
            success: false,
            error: new GitCommandFailedError('The requested branch could not be checked out.'),
          };
        }
      }

      if (await workingTreeUsesLfs(workingDirectory)) {
        try {
          await runGitCommand(workingDirectory, { command: 'lfs', flags: ['install', '--local'] });
          await runGitCommand(workingDirectory, {
            command: 'lfs',
            flags: ['pull'],
            credential: { username: CREDENTIAL_USERNAME, token: input.token },
          });
        } catch {
          return {
            success: false,
            error: new GitCommandFailedError('Large file storage objects for this repository could not be retrieved.'),
          };
        }
      }

      const headCommitOutput = await runGitCommand(workingDirectory, { command: 'rev-parse', flags: ['HEAD'] });
      const headCommit = readRevParseAnswer(headCommitOutput.stdout);

      const entries = await materializeEntries(workingDirectory);

      return { success: true, value: { defaultBranch, headCommit, entries } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The repository could not be cloned.') };
    } finally {
      await rm(scratchParent, { recursive: true, force: true });
    }
  }
}

/**
 * Maps a porcelain v2 change-code character to this port's change type.
 *
 * `git status` (unlike `git diff`/`git log`) has no copy-detection option at all, so the `C`
 * (copied) code can never appear in its output — this mapping intentionally has no case for it;
 * an unrecognized code falls through to null exactly like `C` would.
 *
 * @param code - A single porcelain v2 XY status character.
 * @returns The mapped change type, or null when the character means "no change" on that side
 *   (`.`) or is an unmerged/conflict marker (`U`) — conflict presentation is a separate,
 *   story-specific concern (`packages/shared`'s `ConflictDto`), not this foundational status read.
 */
function mapChangeCode(code: string): GitPendingChangeType | null {
  switch (code) {
    case 'M':
    case 'T': {
      return 'modified';
    }
    case 'A': {
      return 'added';
    }
    case 'D': {
      return 'removed';
    }
    case 'R': {
      return 'renamed';
    }
    default: {
      return null;
    }
  }
}

/** Appends up to two `GitPendingChange` entries — one staged, one unstaged — for one path's XY code pair. */
function pushChanges(changes: GitPendingChange[], path: string, indexCode: string, worktreeCode: string): void {
  const staged = mapChangeCode(indexCode);
  if (staged) changes.push({ path, changeType: staged, staged: true });

  const unstaged = mapChangeCode(worktreeCode);
  if (unstaged) changes.push({ path, changeType: unstaged, staged: false });
}

const ORDINARY_ENTRY = /^1 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
const RENAME_ENTRY = /^2 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
const BRANCH_HEAD_PREFIX = '# branch.head ';

/**
 * Parses `git status --porcelain=v2 --branch --find-renames` output into this port's domain type.
 *
 * Exported (despite being an implementation detail of {@link RealGitCommandRunner.getStatus}) so
 * its edge cases — a missing `# branch.head` header, an ignored (`!`) or unmerged (`u`) line, an
 * unrecognized status code — can be unit-tested directly against synthetic porcelain text, since
 * real `git status` output can never exercise them (see this file's tests).
 *
 * @param stdout - The raw porcelain v2 output.
 * @returns The parsed status, or null when the mandatory `# branch.head` header is missing —
 *   should not happen for a valid working tree, and is treated by the caller as an unreadable
 *   status.
 */
export function parsePorcelainStatus(stdout: string): GitWorkingTreeStatus | null {
  let currentBranch: string | null = null;
  const changes: GitPendingChange[] = [];

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;

    if (line.startsWith(BRANCH_HEAD_PREFIX)) {
      currentBranch = line.slice(BRANCH_HEAD_PREFIX.length);
      continue;
    }
    if (line.startsWith('# ')) continue; // other branch.* headers (oid, upstream, ab) — unused here

    if (line.startsWith('? ')) {
      changes.push({ path: line.slice(2), changeType: 'added', staged: false });
      continue;
    }
    if (line.startsWith('! ')) continue; // ignored files — never requested (no --ignored flag)

    const ordinary = ORDINARY_ENTRY.exec(line);
    if (ordinary) {
      const [, indexCode, worktreeCode, path] = ordinary;
      pushChanges(changes, path, indexCode, worktreeCode);
      continue;
    }

    const rename = RENAME_ENTRY.exec(line);
    if (rename) {
      const [, indexCode, worktreeCode, pair] = rename;
      const [path] = pair.split('\t');
      pushChanges(changes, path, indexCode, worktreeCode);
      continue;
    }

    // 'u' (unmerged/conflict) lines are intentionally unhandled here — see mapChangeCode's note.
  }

  if (currentBranch === null) return null;
  return { currentBranch, changes };
}
