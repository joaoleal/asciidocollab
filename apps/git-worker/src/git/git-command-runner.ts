import { mkdtemp, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AuthenticationFailedError,
  GitCommandFailedError,
  NonFastForwardError,
  RepositoryUnreachableError,
  type ClonedFileEntry,
  type ClonedRepository,
  type GitBehindAhead,
  type GitCloneInput,
  type GitCommandRunner,
  type GitCommitInput,
  type GitCommitResult,
  type GitFetchInput,
  type GitFetchResult,
  type GitMergeConflictPath,
  type GitMergeFileChange,
  type GitMergeInput,
  type GitMergeOutcome,
  type GitPendingChange,
  type GitPendingChangeType,
  type GitPushError,
  type GitPushInput,
  type GitPushResult,
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
 * The commit message recorded when {@link RealGitCommandRunner.merge} snapshots the live local
 * edits into a commit before running the three-way merge.
 */
const FLUSH_COMMIT_MESSAGE = 'Flush live edits before pull';

/**
 * The fixed, non-personal identity attributed to the automated commits {@link RealGitCommandRunner.merge}
 * records (the pre-merge flush snapshot and any merge commit a non-fast-forward merge produces). A
 * merge carries no triggering author the way a user-initiated commit does, so a stable service
 * identity is used rather than any real person's name/email — flagged for review.
 */
const SERVICE_COMMIT_IDENTITY = { name: 'AsciiDoc Collab', email: 'noreply@asciidocollab.invalid' } as const;

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
 * Maps a failure from the single network step of {@link RealGitCommandRunner.fetch} to this port's
 * typed fetch error union — the same reachability/credential classification {@link toCloneFailure}
 * performs, with a generic `GitCommandFailedError` fallback. There is no non-fast-forward case: a
 * fetch only ever updates a remote-tracking ref, never a branch, so it can never be rejected the
 * way a push can.
 */
function toFetchFailure(
  error: unknown,
): RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError {
  if (error instanceof GitProcessError) {
    if (error.networkFailureKind === 'unreachable') return new RepositoryUnreachableError();
    if (error.networkFailureKind === 'authentication-failed') return new AuthenticationFailedError();
  }
  return new GitCommandFailedError('The repository could not be fetched.');
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
 * Maps a failure from {@link RealGitCommandRunner.push}'s `git push` invocation to this port's
 * typed push error union, using {@link GitProcessError.networkFailureKind} — a rejected
 * non-fast-forward push is distinguished from the remote being unreachable or rejecting the
 * credential, and anything unclassified falls back to a generic `GitCommandFailedError`.
 */
function toPushFailure(
  error: unknown,
): NonFastForwardError | RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError {
  if (error instanceof GitProcessError) {
    if (error.networkFailureKind === 'non-fast-forward') return new NonFastForwardError();
    if (error.networkFailureKind === 'unreachable') return new RepositoryUnreachableError();
    if (error.networkFailureKind === 'authentication-failed') return new AuthenticationFailedError();
  }
  return new GitCommandFailedError('The push could not be completed.');
}

/**
 * Reports whether `relativePath` resolves to a location inside `workingDirectory` once joined to
 * it — mirrors the symlink-escape check {@link materializeEntries} performs on a clone's tracked
 * files, applied here to a commit flush entry's caller-supplied path instead, and checked BEFORE
 * any byte of that entry is written (fail closed: an absolute path is rejected outright, and a
 * relative path that walks out via `..` is caught by resolving it and checking whether the result
 * still lives under `workingDirectory`).
 */
function staysInsideWorkingTree(workingDirectory: string, relativePath: string): boolean {
  if (path.isAbsolute(relativePath)) return false;
  const resolved = path.resolve(workingDirectory, relativePath);
  const relativeToRoot = path.relative(workingDirectory, resolved);
  return !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot);
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
 * Reports whether `workingDirectory`'s index holds any staged change (`git diff --cached --quiet`
 * exits 1 when it does, 0 when it does not), used by {@link RealGitCommandRunner.merge} to decide
 * whether the pre-merge flush actually produced anything worth committing. Any exit code other than
 * the expected 0/1 is a real failure and is rethrown, never silently read as "nothing staged".
 *
 * @param workingDirectory - The working tree whose index to inspect.
 * @returns True when there are staged changes, false when the index matches `HEAD`.
 */
async function hasStagedChanges(workingDirectory: string): Promise<boolean> {
  try {
    await runGitCommand(workingDirectory, { command: 'diff', flags: ['--cached', '--quiet'] });
    return false;
  } catch (error) {
    if (error instanceof GitProcessError && error.exitCode === 1) return true;
    throw error;
  }
}

/**
 * Reads the set of paths git reports as binary between the two sides of a merge in progress, by
 * scanning `git diff --numstat -z HEAD MERGE_HEAD` output for the rows git marks binary (both its
 * added and deleted counts rendered as a dash rather than a number). Used only to classify the
 * {@link GitMergeConflictPath.isBinary} flag on conflicted files.
 *
 * The comparison is deliberately the two-tree `HEAD` (ours) vs `MERGE_HEAD` (theirs) diff, NOT a
 * plain `git diff` of the conflicted working tree: during a conflict, `git diff`'s combined output
 * reports a binary file as `0\t0` rather than `-\t-`, so it cannot distinguish binary from text —
 * whereas an ordinary two-tree diff reliably emits `-\t-` for a binary blob. Both refs exist for
 * the whole conflicted state, before `git merge --abort` runs. Extra (non-conflicted) paths in the
 * result are harmless: the caller only looks up the paths it already knows are conflicted.
 *
 * The `-z` numstat stream is NUL-delimited: a normal file is one record `added\tdeleted\tpath`; a
 * rename is a record `added\tdeleted\t` (empty path field) immediately followed by two further
 * NUL-separated tokens (old path, then new path). Both shapes are handled so the scan never
 * misaligns on a renamed entry.
 *
 * @param workingDirectory - The working tree whose in-progress merge to inspect.
 * @returns Every path git reports as a binary change between the two merge sides.
 */
async function readBinaryDiffPaths(workingDirectory: string): Promise<Set<string>> {
  const { stdout } = await runGitCommand(workingDirectory, {
    command: 'diff',
    flags: ['--numstat', '-z'],
    positionals: ['HEAD', 'MERGE_HEAD'],
  });
  const tokens = stdout.split('\0');
  const binaryPaths = new Set<string>();

  let index = 0;
  while (index < tokens.length) {
    const record = tokens[index];
    if (record.length === 0) {
      index += 1;
      continue;
    }

    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      index += 1;
      continue;
    }

    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    const inlinePath = record.slice(secondTab + 1);
    const isBinary = added === '-' && deleted === '-';

    if (inlinePath.length > 0) {
      if (isBinary) binaryPaths.add(inlinePath);
      index += 1;
    } else {
      // Rename record: the two following tokens are the old and new paths.
      const newPath = tokens[index + 2];
      if (isBinary && newPath) binaryPaths.add(newPath);
      index += 3;
    }
  }
  return binaryPaths;
}

/**
 * Lists the files a merge in progress left unmerged (`git diff --name-only --diff-filter=U -z`) and
 * pairs each with its {@link GitMergeConflictPath.isBinary} flag. An empty result means the merge
 * failed for a reason other than a content conflict (its caller treats that as a genuine failure).
 *
 * @param workingDirectory - The working tree whose in-progress merge to inspect.
 * @returns One {@link GitMergeConflictPath} per unmerged file.
 */
async function readMergeConflicts(workingDirectory: string): Promise<GitMergeConflictPath[]> {
  const { stdout } = await runGitCommand(workingDirectory, {
    command: 'diff',
    flags: ['--name-only', '--diff-filter=U', '-z'],
  });
  const conflictedPaths = stdout.split('\0').filter((entry) => entry.length > 0);
  if (conflictedPaths.length === 0) return [];

  const binaryPaths = await readBinaryDiffPaths(workingDirectory);
  return conflictedPaths.map((conflictedPath) => ({
    path: conflictedPath,
    isBinary: binaryPaths.has(conflictedPath),
  }));
}

/**
 * Computes the file-level change-set a clean merge contributed, as the diff from `fromCommit` to
 * `toCommit` (`git diff --name-status -M -z <fromCommit> <toCommit>`) — with `fromCommit` being the
 * post-flush pre-merge `HEAD`, this is exactly the REMOTE's contribution, excluding the live local
 * edits the domain already holds. The added/modified/renamed bytes are read from the post-merge
 * working tree, which the domain's own `ProjectFileStore` cannot see.
 *
 * The `-z` name-status stream is NUL-delimited: each record is `status` then its path(s) as
 * separate tokens — `A`/`M`/`D` take one path, `R<score>` takes two (old, then new). `-M` enables
 * rename detection; copy detection is not requested, so no `C` record can appear. `core.quotePath`
 * is globally disabled, so every path token is already raw bytes needing no unescaping.
 *
 * @param workingDirectory - The post-merge working tree the changed bytes are read from.
 * @param fromCommit - The pre-merge `HEAD` (the local side already committed).
 * @param toCommit - The post-merge `HEAD`.
 * @returns One {@link GitMergeFileChange} per changed file.
 */
async function computeMergeChanges(
  workingDirectory: string,
  fromCommit: string,
  toCommit: string,
): Promise<GitMergeFileChange[]> {
  const { stdout } = await runGitCommand(workingDirectory, {
    command: 'diff',
    flags: ['--name-status', '-M', '-z'],
    positionals: [fromCommit, toCommit],
  });
  const tokens = stdout.split('\0');
  const changes: GitMergeFileChange[] = [];

  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    if (status.length === 0) {
      index += 1;
      continue;
    }

    const code = status[0];
    switch (code) {
      case 'A':
      case 'M': {
        const changedPath = tokens[index + 1];
        const content = await readFile(path.join(workingDirectory, changedPath));
        changes.push({
          type: code === 'A' ? 'added' : 'modified',
          path: changedPath,
          content,
          mimeType: guessMimeType(changedPath),
        });
        index += 2;
        break;
      }
      case 'D': {
        changes.push({ type: 'removed', path: tokens[index + 1] });
        index += 2;
        break;
      }
      case 'R': {
        const fromPath = tokens[index + 1];
        const toPath = tokens[index + 2];
        const content = await readFile(path.join(workingDirectory, toPath));
        changes.push({ type: 'renamed', fromPath, toPath, content, mimeType: guessMimeType(toPath) });
        index += 3;
        break;
      }
      default: {
        // No other status can appear (copy detection is off; `-z` never emits the octal-escape case
        // core.quotePath would). Advance past status + one path defensively rather than looping.
        index += 2;
      }
    }
  }
  return changes;
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

  /**
   * Stages the given files for the next commit (`git add <paths>`).
   *
   * The paths are passed as plain positionals, with no extra leading `--` separator: unlike `git
   * reset`, a real `git add` invoked after `--end-of-options` (which already disables all option
   * parsing) treats a subsequent bare `--` as a literal, nonexistent pathspec rather than as a
   * separator, and fails outright — confirmed against real `git` here, not merely inferred.
   *
   * @param projectId - The project whose working tree to stage files in.
   * @param paths - Workspace-relative POSIX paths of the files to stage.
   * @returns Success once staged; a `GitCommandFailedError` when the underlying git command fails.
   */
  async stage(projectId: ProjectId, paths: readonly string[]): Promise<Result<void, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);
    try {
      await runGitCommand(cwd, { command: 'add', positionals: [...paths] });
      return { success: true, value: undefined };
    } catch {
      return { success: false, error: new GitCommandFailedError('The files could not be staged.') };
    }
  }

  /**
   * Unstages the given files, leaving their working-tree contents untouched (`git reset -- <paths>`).
   *
   * @param projectId - The project whose working tree to unstage files in.
   * @param paths - Workspace-relative POSIX paths of the files to unstage.
   * @returns Success once unstaged; a `GitCommandFailedError` when the underlying git command fails
   *   (for example, unstaging in a repository with no `HEAD` commit yet).
   */
  async unstage(projectId: ProjectId, paths: readonly string[]): Promise<Result<void, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);
    try {
      await runGitCommand(cwd, { command: 'reset', positionals: ['--', ...paths] });
      return { success: true, value: undefined };
    } catch {
      return { success: false, error: new GitCommandFailedError('The files could not be unstaged.') };
    }
  }

  /**
   * Records a commit of the currently staged index, first overwriting and re-staging every
   * `input.flush` entry so the commit captures live collaborative content rather than stale staged
   * bytes (see the port's JSDoc for the full write→add→commit contract).
   *
   * Every flush entry's path is validated with {@link staysInsideWorkingTree} BEFORE any entry is
   * written — an absolute path, or one that escapes the working tree via `..`, fails the whole
   * commit closed, with no partial write.
   *
   * @param projectId - The project whose staged index to commit.
   * @param input - The message, author, and live-content flush list.
   * @returns The new commit on success; a `GitCommandFailedError` when a flush path is unsafe, or
   *   when the underlying write/add/commit git command fails.
   */
  async commit(projectId: ProjectId, input: GitCommitInput): Promise<Result<GitCommitResult, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    for (const entry of input.flush) {
      if (!staysInsideWorkingTree(cwd, entry.path)) {
        return {
          success: false,
          error: new GitCommandFailedError('A flush entry path escapes the project working tree.'),
        };
      }
    }

    try {
      for (const entry of input.flush) {
        await writeFile(path.join(cwd, entry.path), entry.content, 'utf8');
        // No leading `--` here either — see `stage`'s docs for why a bare `git add` rejects one.
        await runGitCommand(cwd, { command: 'add', positionals: [entry.path] });
      }

      // `-m` takes its value from the very next argv element regardless of what it contains (no
      // shell is ever involved), so this is safe even though `input.message` is caller-supplied —
      // unlike a bare positional, it can never be misread as a new option. The author/committer
      // identity rides out-of-band via `identity` (mirrors `credential`), never as a `--author`
      // flag built from caller text.
      await runGitCommand(cwd, {
        command: 'commit',
        flags: ['-m', input.message],
        identity: { name: input.author.name, email: input.author.email },
      });

      const hashOutput = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const hash = readRevParseAnswer(hashOutput.stdout);

      let authoredAt = new Date();
      try {
        const dateOutput = await runGitCommand(cwd, { command: 'log', flags: ['-1', '--format=%aI', 'HEAD'] });
        const parsed = new Date(dateOutput.stdout.trim());
        if (!Number.isNaN(parsed.getTime())) authoredAt = parsed;
      } catch {
        // Falls back to the `new Date()` set above — the commit itself already succeeded.
      }

      return { success: true, value: { hash, message: input.message, authoredAt } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The commit could not be recorded.') };
    }
  }

  /**
   * Pushes the project's current branch to its remote, authenticating out-of-band with
   * `input.token` exactly as {@link clone} does — the token rides `GIT_ASKPASS`, never argv.
   *
   * @param projectId - The project whose working tree to push from.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to push.
   * @returns The remote branch's new tip commit on success; a {@link NonFastForwardError} when the
   *   remote has commits this branch does not, a {@link RepositoryUnreachableError}/
   *   {@link AuthenticationFailedError} on the same terms as {@link checkRemoteAccess}, or a
   *   {@link GitCommandFailedError} for any other failure.
   */
  async push(projectId: ProjectId, input: GitPushInput): Promise<Result<GitPushResult, GitPushError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    try {
      await this.assertRemoteAllowed(input.remoteUrl);
    } catch {
      return { success: false, error: new RepositoryUnreachableError() };
    }

    try {
      await runGitCommand(cwd, {
        command: 'push',
        positionals: [input.remoteUrl, input.branch],
        credential: { username: CREDENTIAL_USERNAME, token: input.token },
      });
    } catch (error) {
      return { success: false, error: toPushFailure(error) };
    }

    const headCommitOutput = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
    return { success: true, value: { headCommit: readRevParseAnswer(headCommitOutput.stdout) } };
  }

  /**
   * Fetches `input.branch` from the remote into the project's remote-tracking ref, authenticating
   * out-of-band with `input.token` exactly as {@link clone}/{@link push} do — the token rides
   * `GIT_ASKPASS`, never argv. Gated on {@link assertRemoteAllowed} before any network spawn.
   *
   * An explicit refspec (`+refs/heads/<branch>:refs/remotes/origin/<branch>`) is used rather than a
   * bare `git fetch <url> <branch>`, so `refs/remotes/origin/<branch>` is always created/advanced —
   * the tracking ref that {@link getBehindAhead} and {@link merge} then read locally. The leading
   * `+` allows a non-fast-forward remote history to still update the tracking ref.
   *
   * @param projectId - The project whose working tree's remote-tracking ref to update.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to fetch.
   * @returns The remote-tracking ref's new tip on success; a `RepositoryUnreachableError`/
   *   `AuthenticationFailedError` on the same terms as {@link clone}, or a `GitCommandFailedError`
   *   for any other failure.
   */
  async fetch(
    projectId: ProjectId,
    input: GitFetchInput,
  ): Promise<Result<GitFetchResult, RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    try {
      await this.assertRemoteAllowed(input.remoteUrl);
    } catch {
      return { success: false, error: new RepositoryUnreachableError() };
    }

    try {
      await runGitCommand(cwd, {
        command: 'fetch',
        positionals: [input.remoteUrl, `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`],
        credential: { username: CREDENTIAL_USERNAME, token: input.token },
      });
    } catch (error) {
      return { success: false, error: toFetchFailure(error) };
    }

    const remoteHeadOutput = await runGitCommand(cwd, {
      command: 'rev-parse',
      positionals: [`refs/remotes/origin/${input.branch}`],
    });
    return { success: true, value: { remoteHead: readRevParseAnswer(remoteHeadOutput.stdout) } };
  }

  /**
   * Compares a local branch against its already-fetched remote-tracking ref with a single
   * `git rev-list --count --left-right <branch>...refs/remotes/origin/<branch>` — a purely local
   * comparison, no network. The `<local>...<remote>` order makes the left count the commits the
   * local branch has that the remote lacks (`ahead`) and the right count the reverse (`behind`).
   * The explicit `refs/remotes/origin/<branch>` ref is used rather than `@{u}`, so no configured
   * upstream is required.
   *
   * @param projectId - The project whose working tree to compare.
   * @param branch - The local branch to compare against its remote-tracking ref.
   * @returns The `{ behind, ahead }` counts; a `GitCommandFailedError` when the underlying command
   *   fails (for example, the branch has no remote-tracking ref yet) or its output is unparseable.
   */
  async getBehindAhead(projectId: ProjectId, branch: string): Promise<Result<GitBehindAhead, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    try {
      const { stdout } = await runGitCommand(cwd, {
        command: 'rev-list',
        flags: ['--count', '--left-right'],
        positionals: [`${branch}...refs/remotes/origin/${branch}`],
      });
      const [leftText, rightText] = stdout.trim().split(/\s+/);
      const ahead = Number.parseInt(leftText, 10);
      const behind = Number.parseInt(rightText, 10);
      if (Number.isNaN(ahead) || Number.isNaN(behind)) {
        return {
          success: false,
          error: new GitCommandFailedError('The branch divergence from its remote could not be determined.'),
        };
      }
      return { success: true, value: { behind, ahead } };
    } catch {
      return {
        success: false,
        error: new GitCommandFailedError('The branch divergence from its remote could not be determined.'),
      };
    }
  }

  /**
   * Runs a local three-way merge of the already-fetched `refs/remotes/origin/<branch>` into
   * `input.branch`. Touches no network.
   *
   * Ordering (all in the project's own working tree):
   * 1. Every `input.flush` entry's path is validated with {@link staysInsideWorkingTree} BEFORE any
   *    write — an unsafe path fails the whole merge closed, with no partial write.
   * 2. Each flush entry is written then `git add`-ed, exactly as {@link commit} does, forming the
   *    live local side of the merge.
   * 3. That local side is committed — but only when {@link hasStagedChanges} confirms something is
   *    staged — under {@link SERVICE_COMMIT_IDENTITY} (a merge carries no author) with
   *    {@link FLUSH_COMMIT_MESSAGE}, so the merge is a clean commit-vs-commit three-way.
   * 4. `preMergeHead` is captured AFTER that commit, so the computed change-set is the REMOTE's
   *    contribution only, excluding the live local edits the domain already holds.
   * 5. `git merge --no-edit refs/remotes/origin/<branch>` runs. A non-zero exit is EXPECTED when the
   *    merge conflicts and is NOT immediately an error: unmerged paths are inspected
   *    ({@link readMergeConflicts}) — if there are none the exit was a genuine failure
   *    (`GitCommandFailedError`); if there are, `git merge --abort` restores a clean tree (the
   *    domain records conflicts in its own store, never on disk) and the `conflicted` outcome is
   *    returned.
   * 6. On a clean merge, the change-set is computed from `preMergeHead` to the post-merge `HEAD`
   *    ({@link computeMergeChanges}); an unchanged `HEAD` (already up to date) yields empty changes.
   *
   * @param projectId - The project whose working tree to merge into.
   * @param input - The branch to merge into and the live-content flush list.
   * @returns A {@link GitMergeOutcome} — `merged` (with the remote's change-set) or `conflicted`
   *   (with the files left in conflict); a `GitCommandFailedError` only when a git command itself
   *   fails or a flush path is unsafe. A conflict is an expected outcome, never an error.
   */
  async merge(projectId: ProjectId, input: GitMergeInput): Promise<Result<GitMergeOutcome, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    for (const entry of input.flush) {
      if (!staysInsideWorkingTree(cwd, entry.path)) {
        return {
          success: false,
          error: new GitCommandFailedError('A flush entry path escapes the project working tree.'),
        };
      }
    }

    try {
      for (const entry of input.flush) {
        await writeFile(path.join(cwd, entry.path), entry.content, 'utf8');
        await runGitCommand(cwd, { command: 'add', positionals: [entry.path] });
      }

      if (await hasStagedChanges(cwd)) {
        await runGitCommand(cwd, {
          command: 'commit',
          flags: ['-m', FLUSH_COMMIT_MESSAGE],
          identity: SERVICE_COMMIT_IDENTITY,
        });
      }

      const preMergeHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preMergeHead = readRevParseAnswer(preMergeHeadResult.stdout);

      const remoteReference = `refs/remotes/origin/${input.branch}`;
      try {
        // A non-fast-forward merge records a merge commit, which needs a committer identity — the
        // same service identity the flush commit uses, since a merge carries no author.
        await runGitCommand(cwd, {
          command: 'merge',
          flags: ['--no-edit'],
          positionals: [remoteReference],
          identity: SERVICE_COMMIT_IDENTITY,
        });
      } catch (error) {
        const conflicts = await readMergeConflicts(cwd);
        if (conflicts.length === 0) {
          // No unmerged paths → this was a genuine command failure (e.g. the ref does not exist),
          // not a content conflict.
          throw error;
        }
        await runGitCommand(cwd, { command: 'merge', flags: ['--abort'] });
        return { success: true, value: { status: 'conflicted', conflicts } };
      }

      const postMergeHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const postMergeHead = readRevParseAnswer(postMergeHeadResult.stdout);
      if (preMergeHead === postMergeHead) {
        return { success: true, value: { status: 'merged', headCommit: postMergeHead, changes: [] } };
      }

      const changes = await computeMergeChanges(cwd, preMergeHead, postMergeHead);
      return { success: true, value: { status: 'merged', headCommit: postMergeHead, changes } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The merge could not be completed.') };
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
 * @returns The mapped change type, or null when the character means "no change" on that side (`.`).
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
  if (staged) changes.push({ path, changeType: staged, state: 'staged' });

  const unstaged = mapChangeCode(worktreeCode);
  if (unstaged) changes.push({ path, changeType: unstaged, state: 'unstaged' });
}

const ORDINARY_ENTRY = /^1 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
const RENAME_ENTRY = /^2 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
/**
 * Matches a porcelain v2 unmerged (conflict) record: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2>
 * <h3> <path>` — the `sub`, four mode, and three object-hash fields between the XY code and the
 * path are captured only to be skipped; only the path is used.
 */
const UNMERGED_ENTRY = /^u (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
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
      changes.push({ path: line.slice(2), changeType: 'added', state: 'untracked' });
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

    const unmerged = UNMERGED_ENTRY.exec(line);
    if (unmerged) {
      const [, , , path] = unmerged;
      // The domain type has no dedicated "conflict" changeType; 'modified' is the closest fit and
      // covers the common case (both sides edited the same file) — `state: 'conflicted'` is what
      // actually signals the conflict to callers.
      changes.push({ path, changeType: 'modified', state: 'conflicted' });
      continue;
    }
  }

  if (currentBranch === null) return null;
  return { currentBranch, changes };
}
