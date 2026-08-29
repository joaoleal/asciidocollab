import { cp, mkdir, mkdtemp, lstat, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AuthenticationFailedError,
  GitCommandFailedError,
  NonFastForwardError,
  RemoteAlreadyInitializedError,
  RepositoryTooLargeError,
  RepositoryUnreachableError,
  type ClonedFileEntry,
  type ClonedRepository,
  type GitCloneInput,
  type GitFetchInput,
  type GitFetchResult,
  type GitInitializeError,
  type GitInitializeInput,
  type GitInitializeOutcome,
  type GitPushError,
  type GitPushInput,
  type GitPushResult,
  type GitRemoteAccessCheck,
  type ProjectId,
  type Result,
} from '@asciidocollab/domain';
import { assertRemoteHostAllowed, type HostAddressResolver } from './egress-allowlist.js';
import {
  CREDENTIAL_USERNAME,
  SERVICE_COMMIT_IDENTITY,
  deriveLfsEndpoint,
  escapesWorkingRoot,
  readRevParseAnswer,
  toFetchFailure,
} from './git-command-helpers.js';
import { guessMimeType } from './guess-mime-type.js';
import { declaresLfsFilter } from './lfs-pointer.js';
import { writeManagedGitignore } from './managed-gitignore.js';
import { measureWorkingTreeSizeBytes, repoSizeExceedsLimit } from './repo-size.js';
import { GitProcessError, runGitCommand } from './run-git-command.js';
import { resolveWorkingTreePath } from './working-tree.js';

/**
 * The commit message recorded for {@link RealGitCommandRunner.initializeAndPublish}'s initial
 * commit — the first commit an existing, previously non-git project ever gets.
 */
const INITIAL_COMMIT_MESSAGE = 'Initial commit';

/** The branch {@link RealGitCommandRunner.initializeAndPublish} publishes under when `input.branch` is omitted. */
const DEFAULT_INITIALIZE_BRANCH = 'main';

/**
 * Maps a failure from the network-facing steps of {@link RemoteOps.clone} to this port's typed
 * clone error union, using {@link GitProcessError.networkFailureKind} when the failure was
 * classified as a reachability or credential problem, and a generic `GitCommandFailedError` for
 * everything else (a missing branch, an oversized remote once a size limit is enforced, and so on).
 *
 * @param error - The failure thrown by the underlying clone invocation.
 * @returns The typed error the port surfaces for the failure.
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
 * Maps a failure from {@link RemoteOps.checkRemoteAccess}'s `ls-remote` probe to this port's
 * narrower error union (no `GitCommandFailedError` case exists here). A failure this runner cannot
 * positively classify as a rejected credential is treated as the remote being unreachable — the
 * conservative default, since an unclassified failure gives no evidence the credential was ever
 * actually evaluated.
 *
 * @param error - The failure thrown by the underlying probe.
 * @returns The typed error the port surfaces for the failure.
 */
function toRemoteAccessFailure(error: unknown): RepositoryUnreachableError | AuthenticationFailedError {
  if (error instanceof GitProcessError && error.networkFailureKind === 'authentication-failed') {
    return new AuthenticationFailedError();
  }
  return new RepositoryUnreachableError();
}

/**
 * Maps a failure from {@link RemoteOps.push}'s `git push` invocation to this port's typed push
 * error union, using {@link GitProcessError.networkFailureKind} — a rejected non-fast-forward push
 * is distinguished from the remote being unreachable or rejecting the credential, and anything
 * unclassified falls back to a generic `GitCommandFailedError`.
 *
 * @param error - The failure thrown by the underlying push invocation.
 * @returns The typed error the port surfaces for the failure.
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
 * Maps a failure from {@link RemoteOps.initializeAndPublish}'s init→remote-add→commit→push
 * sequence to this port's typed initialize error union (excluding
 * {@link RemoteAlreadyInitializedError}, which is only ever returned by the earlier, separate
 * remote-empty check) — the same reachability/credential classification {@link toCloneFailure}
 * performs, with a generic `GitCommandFailedError` fallback for a local failure (for example, the
 * initial commit itself failing) or an unclassified network failure.
 *
 * @param error - The failure thrown by the underlying sequence.
 * @returns The typed error the port surfaces for the failure.
 */
function toInitializeFailure(
  error: unknown,
): RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError {
  if (error instanceof GitProcessError) {
    if (error.networkFailureKind === 'unreachable') return new RepositoryUnreachableError();
    if (error.networkFailureKind === 'authentication-failed') return new AuthenticationFailedError();
  }
  return new GitCommandFailedError('The project could not be initialized and published.');
}

/**
 * Reports whether a cloned working tree's `.gitattributes` (if any) declares a Large File Storage
 * filter, the signal {@link RemoteOps.clone} uses to decide whether it needs to invoke `git lfs` at
 * all — a repository that never uses LFS never requires the `git-lfs` extension to be installed.
 *
 * @param workingDirectory - The clone's working tree root.
 * @returns True when the working tree's `.gitattributes` declares an LFS filter.
 */
async function workingTreeUsesLfs(workingDirectory: string): Promise<boolean> {
  const content = await readFile(path.join(workingDirectory, '.gitattributes'), 'utf8').catch(() => '');
  return declaresLfsFilter(content);
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
 * A running total of every materialized file's size is checked against `maxRepoSizeMB` on every
 * iteration — defense-in-depth against unbounded memory growth: {@link RemoteOps.clone} already
 * rejects an oversized working tree before this ever runs, but this second, cheaper-to-miss check
 * means a race, or any future caller that skips that pre-check, still cannot read an unbounded
 * number of bytes into memory before failing. The same {@link repoSizeExceedsLimit} comparison
 * enforces both checks, so there is exactly one limit.
 *
 * @param workingDirectory - The clone's working tree root.
 * @param maxRepoSizeMB - The configured maximum repository size, in megabytes.
 * @returns Every safely-readable tracked file, as a `ClonedFileEntry`.
 * @throws {RepositoryTooLargeError} If the running total of materialized bytes exceeds `maxRepoSizeMB`.
 */
async function materializeEntries(workingDirectory: string, maxRepoSizeMB: number): Promise<ClonedFileEntry[]> {
  const { stdout } = await runGitCommand(workingDirectory, { command: 'ls-files', flags: ['-z'] });
  const relativePaths = stdout.split('\0').filter((entry) => entry.length > 0);

  const entries: ClonedFileEntry[] = [];
  let totalBytes = 0;
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(workingDirectory, relativePath);

    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      const target = await realpath(absolutePath).catch(() => null);
      const relativeToRoot = target ? path.relative(workingDirectory, target) : null;
      const escapesWorkingTree = relativeToRoot === null || escapesWorkingRoot(relativeToRoot);
      if (escapesWorkingTree) continue;
    }

    // `readFile` follows a symlink, so the bytes it reads are the TARGET's, not the link's. Count the
    // followed (`stat`) size for a symlink so the running total reflects what is actually read into
    // memory; `lstat`'s own size (the link path's length) would undercount against the repo-size cap.
    let readableBytes = stats.size;
    if (stats.isSymbolicLink()) {
      const targetStats = await stat(absolutePath);
      readableBytes = targetStats.size;
    }
    totalBytes += readableBytes;
    if (repoSizeExceedsLimit(totalBytes, maxRepoSizeMB)) {
      throw new RepositoryTooLargeError();
    }

    const content = await readFile(absolutePath);
    entries.push({ path: relativePath, content, mimeType: guessMimeType(relativePath) });
  }
  return entries;
}

/**
 * Network-facing git operations: the clone/fetch/push/initialize/access-check operations that reach
 * a remote. Every method that contacts a remote gates on {@link RemoteOps.assertRemoteAllowed}
 * first, and authenticates out-of-band via `GIT_ASKPASS` — the token never rides argv, the remote
 * URL, `.git/config`, or any log/error.
 */
export class RemoteOps {
  /**
   * @param storageRoot - Root directory for per-project storage (see {@link resolveWorkingTreePath}).
   * @param allowedHosts - The configured git network egress allowlist (`git.egress.allowedHosts`).
   *   Defaults to empty (deny-by-default) so a caller that omits it can never reach a remote.
   * @param resolveHost - Overrides the DNS resolution {@link RemoteOps.assertRemoteAllowed}
   *   validates a remote host's address against. Defaults to real DNS resolution; only ever
   *   overridden by tests, the same seam `assertRemoteHostAllowed` itself already exposes.
   * @param maxRepoSizeMB - Maximum repository size, in megabytes, {@link RemoteOps.clone} enforces
   *   against the cloned working tree (`git.maxRepoSizeMB`).
   */
  constructor(
    private readonly storageRoot: string,
    private readonly allowedHosts: readonly string[],
    private readonly resolveHost: HostAddressResolver | undefined,
    private readonly maxRepoSizeMB: number,
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
   * Verifies a remote can be reached and that `check.token` authenticates against it, without
   * cloning or otherwise materializing any working tree — a cheap `git ls-remote` probe run in a
   * throwaway scratch directory, gated on {@link RemoteOps.assertRemoteAllowed} exactly as
   * {@link RemoteOps.clone} is.
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
   * Order of operations: {@link RemoteOps.assertRemoteAllowed} gates the whole call before any
   * network attempt; a plain `clone` fetches every branch and checks out the remote's default; the
   * default branch's name is read off that checkout before anything might switch away from it (so
   * the returned `defaultBranch` always names the remote's actual default, never whatever branch
   * ends up checked out); a requested non-default branch is then checked out over it; an LFS pull
   * runs only if the working tree's `.gitattributes` actually declares one (see
   * {@link workingTreeUsesLfs}), so a repository that never uses LFS never requires the `git-lfs`
   * extension — and that LFS transfer's endpoint is pinned to the validated origin (see
   * {@link deriveLfsEndpoint}) so a repo-supplied `.lfsconfig` cannot redirect it off-host; and
   * finally `headCommit` and the tracked file set are read off whatever ended up checked out.
   *
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to
   *   clone (defaults to the remote's default branch).
   * @returns The cloned repository's files and the branch/commit they were cloned at; a
   *   `RepositoryUnreachableError`/`AuthenticationFailedError` on the same terms as
   *   {@link RemoteOps.checkRemoteAccess}, a `RepositoryTooLargeError` when the cloned working tree
   *   exceeds `maxRepoSizeMB`, or a `GitCommandFailedError` for any other failure.
   */
  async clone(
    input: GitCloneInput,
  ): Promise<
    Result<
      ClonedRepository,
      RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError | RepositoryTooLargeError
    >
  > {
    try {
      await this.assertRemoteAllowed(input.remoteUrl);
    } catch {
      return { success: false, error: new RepositoryUnreachableError() };
    }

    // Clone into an isolated scratch directory first: every size/LFS/symlink check runs against it
    // BEFORE it is ever adopted as the project's working tree (below), so an oversized, unreachable,
    // or otherwise rejected clone leaves no working tree behind — and the scratch tree is always
    // removed in the `finally`, whether or not it was adopted.
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
            // Pin the transfer endpoint to the already-egress-validated origin, at git's
            // highest-precedence command-line config level, so a cloned repo's attacker-controlled
            // `.lfsconfig` (or an `lfs.url` in `.git/config`) can never redirect this transfer — and
            // the credential below — to an internal or otherwise disallowed host.
            config: [`lfs.url=${deriveLfsEndpoint(input.remoteUrl)}`],
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

      // Measured BEFORE materializeEntries reads a single byte of tracked-file content into
      // memory — a clone that already exceeds the ceiling fails here, rather than after paying the
      // cost (and OOM risk) of reading every file first. Measures the checked-out working tree
      // (post `git lfs pull`), so a smudged LFS object's real size is counted, not just what git's
      // own object store holds.
      const totalSizeBytes = await measureWorkingTreeSizeBytes(workingDirectory);
      if (repoSizeExceedsLimit(totalSizeBytes, this.maxRepoSizeMB)) {
        return { success: false, error: new RepositoryTooLargeError() };
      }

      const entries = await materializeEntries(workingDirectory, this.maxRepoSizeMB);

      // Every check has passed: adopt the clone — `.git`, origin remote, remote-tracking refs, and
      // the checked-out HEAD — as the project's own working tree, so every later git operation
      // (status, commit, push, pull, branch) runs against a real repository at the cloned HEAD.
      // INITIALIZE builds its tree in place; an import must clone first, so it copies the validated
      // tree into place here. A plain `git clone` already created `refs/remotes/origin/<branch>`,
      // so the behind-ahead read is correct immediately, with none of the manual `update-ref`
      // INITIALIZE needs after its push. A recursive copy (not a rename) so the scratch and the
      // project working tree need not share a filesystem; a stale tree from an abandoned prior
      // import is cleared first so the copy always lands on empty ground.
      const workingTreePath = resolveWorkingTreePath(this.storageRoot, input.projectId);
      await rm(workingTreePath, { recursive: true, force: true });
      await mkdir(path.dirname(workingTreePath), { recursive: true });
      await cp(workingDirectory, workingTreePath, { recursive: true });

      return { success: true, value: { defaultBranch, headCommit, entries } };
    } catch (error) {
      if (error instanceof RepositoryTooLargeError) return { success: false, error };
      return { success: false, error: new GitCommandFailedError('The repository could not be cloned.') };
    } finally {
      await rm(scratchParent, { recursive: true, force: true });
    }
  }

  /**
   * Pushes the project's current branch to its remote, authenticating out-of-band with
   * `input.token` exactly as {@link RemoteOps.clone} does — the token rides `GIT_ASKPASS`, never
   * argv.
   *
   * @param projectId - The project whose working tree to push from.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to push.
   * @returns The remote branch's new tip commit on success; a {@link NonFastForwardError} when the
   *   remote has commits this branch does not, a {@link RepositoryUnreachableError}/
   *   {@link AuthenticationFailedError} on the same terms as {@link RemoteOps.checkRemoteAccess}, or
   *   a {@link GitCommandFailedError} for any other failure.
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

    // A successful push uploads the commit but does not advance any local remote-tracking ref, so
    // the behind-ahead read (which compares against refs/remotes/origin/<branch>) would keep
    // reporting the branch as ahead until the periodic background fetch runs. Advance it now — after
    // a successful push, origin/<branch> is exactly HEAD — so the ahead/behind count (and the "up to
    // date" state) is correct immediately, with no extra network round-trip. This is kept OUTSIDE
    // the network-push try, and its own failure is deliberately swallowed: the push itself already
    // succeeded, so a failure to advance a purely local convenience ref must never be surfaced as a
    // push failure — the next background fetch will reconcile the ref regardless.
    try {
      await runGitCommand(cwd, {
        command: 'update-ref',
        positionals: [`refs/remotes/origin/${input.branch}`, 'HEAD'],
      });
    } catch {
      // Intentionally ignored — see the note above; the push is already durably successful.
    }

    const headCommitOutput = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
    return { success: true, value: { headCommit: readRevParseAnswer(headCommitOutput.stdout) } };
  }

  /**
   * Initializes git on an existing, previously non-git project's real working tree and publishes
   * it to a fresh, empty remote. This is the atomic init → remote-add → initial-commit → push
   * sequence this port's JSDoc documents.
   *
   * Ordering (all against `resolveWorkingTreePath(this.storageRoot, projectId)` — the project's
   * OWN working tree, never a scratch directory: its files already exist, having never been
   * git-managed before this call):
   * 1. {@link RemoteOps.assertRemoteAllowed} Gates the whole call before any network attempt.
   * 2. `git ls-remote <input.remoteUrl>`, authenticated out-of-band exactly like
   *    {@link RemoteOps.clone}, checks whether the remote already has any ref/commit. Any output at
   *    all means the remote is non-empty: this returns {@link RemoteAlreadyInitializedError}
   *    immediately, WITHOUT running `git init` or touching the working tree in any way — a non-empty
   *    remote is never overwritten.
   * 3. `git init -b <branch>` (`input.branch`, defaulting to `'main'`) creates the local repository
   *    with the published branch already checked out, so the branch this call returns as
   *    `defaultBranch` is exactly the one `git init` created — no separate rename/symbolic-ref step
   *    is needed.
   * 4. `git remote add origin <input.remoteUrl>` wires the remote — the URL as a positional after
   *    `--end-of-options`, with NO credential in this step (mirrors the port's documented contract).
   * 5. {@link writeManagedGitignore} Writes the working tree's managed `.gitignore` (with no project
   *    user patterns — see the method body's inline note) so internal platform paths such as
   *    `.collab/` are excluded BEFORE anything is staged: this call is the only thing that
   *    provisions that file, since nothing else runs before it on a previously non-git project.
   * 6. `git add -A` stages every file currently in the working tree. `git add -A` never stages an
   *    ignored path, so the `.gitignore` just written is what keeps `.collab/` and `*.tmp` out of
   *    the initial commit, with no additional pathspec exclusion needed here.
   * 7. `git commit` records the initial commit under {@link SERVICE_COMMIT_IDENTITY} (the port's
   *    input carries no per-user author — this is a platform bootstrap action, not an edit
   *    attributable to one collaborator).
   * 8. `git push` publishes that commit to `origin`/`input.branch`, authenticated out-of-band
   *    exactly like {@link RemoteOps.push}.
   *
   * All-or-nothing: any failure from step 3 onward removes the working tree's `.git` directory
   * (never its actual files) before returning, so a failed publish leaves the project exactly as
   * non-git as it was before this call, ready for a clean retry. A failure in step 2 needs no such
   * cleanup — nothing was created yet.
   *
   * @param projectId - The project whose working tree to initialize and publish.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to
   *   publish under (defaults to `'main'`).
   * @returns The initial commit's hash and the branch it was published under; a
   *   {@link RemoteAlreadyInitializedError} when the remote already has commits, a
   *   {@link RepositoryUnreachableError}/{@link AuthenticationFailedError} on the same terms as
   *   {@link RemoteOps.checkRemoteAccess}, or a {@link GitCommandFailedError} for any other failure.
   */
  async initializeAndPublish(
    projectId: ProjectId,
    input: GitInitializeInput,
  ): Promise<Result<GitInitializeOutcome, GitInitializeError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    try {
      await this.assertRemoteAllowed(input.remoteUrl);
    } catch {
      return { success: false, error: new RepositoryUnreachableError() };
    }

    try {
      const { stdout } = await runGitCommand(cwd, {
        command: 'ls-remote',
        positionals: [input.remoteUrl],
        credential: { username: CREDENTIAL_USERNAME, token: input.token },
      });
      if (stdout.trim().length > 0) {
        return { success: false, error: new RemoteAlreadyInitializedError() };
      }
    } catch (error) {
      return { success: false, error: toRemoteAccessFailure(error) };
    }

    const branch = input.branch ?? DEFAULT_INITIALIZE_BRANCH;

    try {
      await runGitCommand(cwd, { command: 'init', flags: ['-b', branch] });
      await runGitCommand(cwd, {
        command: 'remote',
        flags: ['add', 'origin'],
        positionals: [input.remoteUrl],
      });
      // `userPatterns` is `null`: this port's input carries no project-level ignore patterns, and
      // the security-critical job here is excluding the internal `.collab/`/`*.tmp` entries before
      // the very first `git add -A` ever runs on this tree — the maintainer-editable user patterns
      // are a separate concern a future write-on-every-job step will merge in.
      await writeManagedGitignore(cwd, null);
      await runGitCommand(cwd, { command: 'add', flags: ['-A'] });
      await runGitCommand(cwd, {
        command: 'commit',
        flags: ['-m', INITIAL_COMMIT_MESSAGE],
        identity: SERVICE_COMMIT_IDENTITY,
      });
      await runGitCommand(cwd, {
        command: 'push',
        positionals: [input.remoteUrl, branch],
        credential: { username: CREDENTIAL_USERNAME, token: input.token },
      });

      // A successful `git push <url> <branch>` uploads the commit but does not create a
      // remote-tracking ref, so the behind-ahead read (which compares against
      // refs/remotes/origin/<branch>) has nothing to resolve until the periodic background
      // fetch first runs. Create it now — right after publish, origin/<branch> is exactly
      // HEAD — so the ahead/behind count (and the Push affordance keyed on it) is correct
      // from the moment the repository is connected, with no extra network round-trip. This
      // is kept OUTSIDE the try block that maps a failure to a `.git` teardown below, and its
      // own failure is deliberately swallowed: the push itself already succeeded, so a
      // failure to create a purely local convenience ref must never brick an already-published
      // repository — the next background fetch will reconcile the ref regardless.
      try {
        await runGitCommand(cwd, {
          command: 'update-ref',
          positionals: [`refs/remotes/origin/${branch}`, 'HEAD'],
        });
      } catch {
        // Intentionally ignored — see the note above; the push is already durably successful.
      }

      const headCommitOutput = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      return {
        success: true,
        value: { headCommit: readRevParseAnswer(headCommitOutput.stdout), defaultBranch: branch },
      };
    } catch (error) {
      await rm(path.join(cwd, '.git'), { recursive: true, force: true });
      return { success: false, error: toInitializeFailure(error) };
    }
  }

  /**
   * Fetches `input.branch` from the remote into the project's remote-tracking ref, authenticating
   * out-of-band with `input.token` exactly as {@link RemoteOps.clone}/{@link RemoteOps.push} do —
   * the token rides `GIT_ASKPASS`, never argv. Gated on {@link RemoteOps.assertRemoteAllowed}
   * before any network spawn.
   *
   * An explicit refspec (`+refs/heads/<branch>:refs/remotes/origin/<branch>`) is used rather than a
   * bare `git fetch <url> <branch>`, so `refs/remotes/origin/<branch>` is always created/advanced —
   * the tracking ref that the behind-ahead and merge reads then read locally. The leading `+`
   * allows a non-fast-forward remote history to still update the tracking ref.
   *
   * @param projectId - The project whose working tree's remote-tracking ref to update.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to fetch.
   * @returns The remote-tracking ref's new tip on success; a `RepositoryUnreachableError`/
   *   `AuthenticationFailedError` on the same terms as {@link RemoteOps.clone}, or a
   *   `GitCommandFailedError` for any other failure.
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
}
