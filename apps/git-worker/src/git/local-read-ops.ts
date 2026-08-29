import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AuthenticationFailedError,
  GitCommandFailedError,
  RepositoryUnreachableError,
  type GitBehindAhead,
  type GitBlameLine,
  type GitDiffInput,
  type GitDiffResult,
  type GitDiscardInput,
  type GitLogEntry,
  type GitMergeFileChange,
  type GitPreviewPullInput,
  type GitPreviewPullResult,
  type GitPreviewPushInput,
  type GitPreviewPushResult,
  type GitWorkingTreeStatus,
  type ProjectId,
  type Result,
} from '@asciidocollab/domain';
import { assertRemoteHostAllowed, type HostAddressResolver } from './egress-allowlist.js';
import { CREDENTIAL_USERNAME, staysInsideWorkingTree, toFetchFailure } from './git-command-helpers.js';
import { guessMimeType } from './guess-mime-type.js';
import {
  LOG_FORMAT,
  parseBlameOutput,
  parseLogOutput,
  parseNameOnlyOutput,
  parsePorcelainStatus,
} from './output-parsers.js';
import { runGitCommand, runGitCommandForBytes } from './run-git-command.js';
import { resolveWorkingTreePath } from './working-tree.js';

const execFile = promisify(execFileCallback);

/** Generous ceiling on {@link runNoIndexDiff}'s captured stdout — mirrors `run-git-command`'s own. */
const NO_INDEX_DIFF_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Narrows an unknown value to one carrying a numeric child-process exit `code`.
 *
 * @param value - The value to inspect.
 * @returns True when the value carries a numeric `code`.
 */
function hasNumericExitCode(value: unknown): value is { code: number } {
  if (typeof value !== 'object' || value === null || !('code' in value)) return false;
  return typeof value.code === 'number';
}

/**
 * Narrows an unknown value to one carrying the string `stdout` a failed `execFile` attaches to its rejection.
 *
 * @param value - The value to inspect.
 * @returns True when the value carries a string `stdout`.
 */
function hasStdoutText(value: unknown): value is { stdout: string } {
  if (typeof value !== 'object' || value === null || !('stdout' in value)) return false;
  return typeof value.stdout === 'string';
}

/**
 * Runs `git diff --no-index <left> <right>` directly via `execFile`, bypassing
 * {@link runGitCommand}'s throw-on-nonzero-exit contract: `--no-index` EXITS 1 when the two files
 * DIFFER — the normal "there is a diff" outcome, never a failure — and the unified diff text IS
 * that invocation's stdout, which `runGitCommand` discards on any nonzero exit. Only a spawn
 * failure, or an exit code of 2 or greater (a genuine `--no-index` failure — for example, a missing
 * input file), is treated as an error here; exit 0 (identical) and exit 1 (a diff) both resolve with
 * the captured stdout.
 *
 * `left`/`right` are always this adapter's own scratch temp-file paths (never a caller-supplied
 * string), so — unlike every other call site in this file — no `--end-of-options` positional guard
 * is required for them; it is still passed for defense in depth, at no cost.
 *
 * @param left - Absolute path to the base file (HEAD's blob content, or empty if absent at HEAD).
 * @param right - Absolute path to the file to compare it against (the live override text).
 * @returns The unified diff text (empty when the two files are identical).
 * @throws {Error} If `git` cannot be spawned, or exits with a code of 2 or greater.
 */
async function runNoIndexDiff(left: string, right: string): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['diff', '--no-index', '--end-of-options', left, right], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
      maxBuffer: NO_INDEX_DIFF_MAX_BUFFER_BYTES,
    });
    return stdout;
  } catch (error) {
    if (hasNumericExitCode(error) && error.code === 1 && hasStdoutText(error)) {
      return error.stdout;
    }
    throw error;
  }
}

/**
 * Local read-only git operations plus the pull preview: working-tree status, branch divergence,
 * history, diff, blame, the incoming/outgoing change previews, and the working-tree discard. Every
 * operation is a purely local read against the project's own working tree, except {@link LocalReadOps.previewPull},
 * which performs the same authenticated fetch a pull would before reading the incoming range — and
 * so gates on the egress allowlist exactly as the remote operations do.
 */
export class LocalReadOps {
  /**
   * @param storageRoot - Root directory for per-project storage (see {@link resolveWorkingTreePath}).
   * @param allowedHosts - The configured git network egress allowlist (`git.egress.allowedHosts`),
   *   enforced by {@link LocalReadOps.previewPull} before its fetch. Defaults to empty
   *   (deny-by-default) so a caller that omits it can never reach a remote.
   * @param resolveHost - Overrides the DNS resolution {@link LocalReadOps.previewPull} validates a
   *   remote host's address against. Defaults to real DNS resolution; only ever overridden by tests.
   */
  constructor(
    private readonly storageRoot: string,
    private readonly allowedHosts: readonly string[],
    private readonly resolveHost: HostAddressResolver | undefined,
  ) {}

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
   * Previews what a fetch-then-merge pull would bring in, without changing anything beyond the
   * remote-tracking ref a fetch itself already updates: runs the identical fetch a pull performs
   * (same explicit refspec, same out-of-band `GIT_ASKPASS` credential), then reads the commits and
   * touched paths between the local branch and that freshly-fetched ref via
   * `git log -z --format=<LOG_FORMAT> HEAD..refs/remotes/origin/<branch>` and
   * `git diff --name-only -z HEAD..refs/remotes/origin/<branch>`. Never merges, commits, or flushes
   * anything — a LIVE network read, not a mutation.
   *
   * @param projectId - The project whose incoming changes to preview.
   * @param input - The remote URL, the plaintext token to authenticate with, and the branch to preview.
   * @returns The incoming commits (newest first) and the paths they touch; a
   *   `RepositoryUnreachableError`/`AuthenticationFailedError` on the same terms as a fetch, or
   *   a `GitCommandFailedError` for any other failure.
   */
  async previewPull(
    projectId: ProjectId,
    input: GitPreviewPullInput,
  ): Promise<
    Result<GitPreviewPullResult, RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError>
  > {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    try {
      await assertRemoteHostAllowed(input.remoteUrl, this.allowedHosts, this.resolveHost);
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

    const range = `HEAD..refs/remotes/origin/${input.branch}`;
    try {
      const { stdout: logStdout } = await runGitCommand(cwd, {
        command: 'log',
        flags: ['-z', `--format=${LOG_FORMAT}`],
        positionals: [range],
      });
      const { stdout: diffStdout } = await runGitCommand(cwd, {
        command: 'diff',
        flags: ['--name-only', '-z'],
        positionals: [range],
      });
      return {
        success: true,
        value: { incoming: parseLogOutput(logStdout), changedPaths: parseNameOnlyOutput(diffStdout) },
      };
    } catch {
      return { success: false, error: new GitCommandFailedError('The incoming changes could not be previewed.') };
    }
  }

  /**
   * Previews what a push would send out, without changing anything: reads the commits and touched
   * paths between the already-fetched `refs/remotes/origin/<branch>` and the local branch via
   * `git log -z --format=<LOG_FORMAT> refs/remotes/origin/<branch>..HEAD` and
   * `git diff --name-only -z refs/remotes/origin/<branch>..HEAD`. Purely local — no network, no
   * credential; a caller wanting a fresh comparison against the remote should fetch first.
   *
   * When the branch has no remote-tracking ref yet (never fetched or pushed), this degrades
   * gracefully to an empty preview (`{outgoing: [], changedPaths: []}`) rather than failing — there
   * is nothing yet to compare against, which is not itself an error.
   *
   * @param projectId - The project whose outgoing changes to preview.
   * @param input - The branch to preview.
   * @returns The outgoing commits (newest first) and the paths they touch; a `GitCommandFailedError`
   *   when the underlying git command fails for a reason other than a missing remote-tracking ref.
   */
  async previewPush(
    projectId: ProjectId,
    input: GitPreviewPushInput,
  ): Promise<Result<GitPreviewPushResult, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);
    const remoteReference = `refs/remotes/origin/${input.branch}`;

    const hasRemoteTrackingReference = await runGitCommand(cwd, {
      command: 'rev-parse',
      flags: ['--verify', '-q'],
      positionals: [remoteReference],
    })
      .then(() => true)
      .catch(() => false);
    if (!hasRemoteTrackingReference) {
      return { success: true, value: { outgoing: [], changedPaths: [] } };
    }

    const range = `${remoteReference}..HEAD`;
    try {
      const { stdout: logStdout } = await runGitCommand(cwd, {
        command: 'log',
        flags: ['-z', `--format=${LOG_FORMAT}`],
        positionals: [range],
      });
      const { stdout: diffStdout } = await runGitCommand(cwd, {
        command: 'diff',
        flags: ['--name-only', '-z'],
        positionals: [range],
      });
      return {
        success: true,
        value: { outgoing: parseLogOutput(logStdout), changedPaths: parseNameOnlyOutput(diffStdout) },
      };
    } catch {
      return { success: false, error: new GitCommandFailedError('The outgoing changes could not be previewed.') };
    }
  }

  /**
   * Reads a project's commit history via `git log -z --format=<LOG_FORMAT> [--max-count=<limit>]
   * [-- <path>]`, newest first (git's own default order). Touches no network — a purely local read.
   *
   * `git log` itself FAILS (rather than printing empty output) on a repository with no commits
   * yet ("does not have any commits yet"), so a thrown failure is first checked against two local
   * probes before it is treated as a real error: `git rev-parse --is-inside-work-tree` confirms the
   * working tree is a valid git repository at all (false here means the working tree does not exist
   * or was never initialized — a genuine failure), and, only once that holds, `git rev-parse
   * --verify -q HEAD` confirms whether any commit exists yet (false here is the empty-history case,
   * `{ success: true, value: [] }`, NOT an error). A path that no commit ever touched needs none of
   * this: `git log` itself exits 0 with empty output, which {@link parseLogOutput} already turns
   * into an empty array.
   *
   * @param projectId - The project whose history to read.
   * @param options - `path` restricts to a single project-relative file's history; `limit` caps the
   *   number of commits returned.
   * @returns Every matching commit, newest first; a `GitCommandFailedError` (generic message) when
   *   the underlying git command fails for a reason other than an as-yet-commit-less repository.
   */
  async log(
    projectId: ProjectId,
    options: { readonly path?: string; readonly limit?: number },
  ): Promise<Result<GitLogEntry[], GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    const flags = ['-z', `--format=${LOG_FORMAT}`];
    if (options.limit !== undefined) flags.push(`--max-count=${options.limit}`);

    try {
      const { stdout } = await runGitCommand(cwd, {
        command: 'log',
        flags,
        positionals: options.path ? ['--', options.path] : [],
      });
      return { success: true, value: parseLogOutput(stdout) };
    } catch {
      const isValidRepository = await runGitCommand(cwd, {
        command: 'rev-parse',
        flags: ['--is-inside-work-tree'],
      })
        .then(() => true)
        .catch(() => false);
      if (!isValidRepository) {
        return { success: false, error: new GitCommandFailedError('The project history could not be read.') };
      }

      const hasAnyCommit = await runGitCommand(cwd, { command: 'rev-parse', flags: ['--verify', '-q', 'HEAD'] })
        .then(() => true)
        .catch(() => false);
      if (!hasAnyCommit) {
        return { success: true, value: [] };
      }

      return { success: false, error: new GitCommandFailedError('The project history could not be read.') };
    }
  }

  /**
   * Produces a unified diff. Touches no network — a purely local read.
   *
   * - **Commit-vs-commit** (`input.from` and `input.to` both set): `git diff <from> <to> [-- <path>]`.
   * - **Uncommitted, no live override**: `git diff HEAD [-- <path>]`.
   * - **Uncommitted with `input.currentContent`** (the working-tree copy is stale — an open editor's
   *   live text is authoritative instead): {@link LocalReadOps.diffLiveContentOverride} diffs HEAD's
   *   blob of that one path against the supplied live text directly, never reading the stale on-disk
   *   copy.
   *
   * `from`/`to`/`path` are always POSITIONALS after `--end-of-options` (never interpolated into a
   * flag).
   *
   * @param projectId - The project whose working tree (and/or history) to diff.
   * @param input - What to diff — two commits, or the uncommitted working changes, optionally
   *   scoped to one file, optionally overriding that file's content with live text.
   * @returns The unified diff text (empty when there is no difference); a `GitCommandFailedError`
   *   (generic message) when the underlying git command fails.
   */
  async diff(projectId: ProjectId, input: GitDiffInput): Promise<Result<GitDiffResult, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    try {
      if (input.currentContent) {
        return await this.diffLiveContentOverride(cwd, input.currentContent);
      }

      if (input.from !== undefined && input.to !== undefined) {
        const positionals = input.path ? [input.from, input.to, '--', input.path] : [input.from, input.to];
        const { stdout } = await runGitCommand(cwd, { command: 'diff', positionals });
        return { success: true, value: { unified: stdout } };
      }

      const positionals = input.path ? ['HEAD', '--', input.path] : ['HEAD'];
      const { stdout } = await runGitCommand(cwd, { command: 'diff', positionals });
      return { success: true, value: { unified: stdout } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The diff could not be produced.') };
    }
  }

  /**
   * Diffs HEAD's blob of `currentContent.path` against the supplied live text — the live-editor
   * override an open editor's stale working-tree copy must never leak into: HEAD's blob is written
   * to one scratch temp file, the live text to a second, and `git diff --no-index` compares the two
   * (see {@link runNoIndexDiff} for why that call bypasses `runGitCommand`). `git show
   * HEAD:<path>` failing (the path did not exist at HEAD yet) is tolerated — the base is treated as
   * empty, so a brand-new file's live content still diffs cleanly against nothing.
   *
   * Both scratch files live under `tmpdir()` (never inside the working tree) and are always removed
   * in a `finally`, regardless of outcome.
   *
   * @param cwd - The project's working tree (read only for HEAD's blob; never written to).
   * @param currentContent - The live override: the project-relative path and its current live text.
   * @returns The unified diff between HEAD's blob and the live text; a `GitCommandFailedError`
   *   (generic message) on any other failure.
   */
  private async diffLiveContentOverride(
    cwd: string,
    currentContent: { readonly path: string; readonly content: string },
  ): Promise<Result<GitDiffResult, GitCommandFailedError>> {
    const scratchDirectory = await mkdtemp(path.join(tmpdir(), 'git-worker-diff-live-'));
    try {
      const headBytes = await runGitCommandForBytes(cwd, {
        command: 'show',
        positionals: [`HEAD:${currentContent.path}`],
      }).catch(() => Buffer.alloc(0));

      const baseName = path.basename(currentContent.path) || 'file';
      const headTemporary = path.join(scratchDirectory, `head-${baseName}`);
      const liveTemporary = path.join(scratchDirectory, `live-${baseName}`);
      await writeFile(headTemporary, headBytes);
      await writeFile(liveTemporary, currentContent.content, 'utf8');

      const unified = await runNoIndexDiff(headTemporary, liveTemporary);
      return { success: true, value: { unified } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The diff could not be produced.') };
    } finally {
      await rm(scratchDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Reads per-line authorship for a single project-relative file via `git blame --line-porcelain
   * [<ref>] -- <path>`, parsed by {@link parseBlameOutput}. Touches no network — a purely local read.
   *
   * `ref` (when set) and `path` are always POSITIONALS after `--end-of-options`.
   *
   * @param projectId - The project whose file to blame.
   * @param input - The project-relative file path, and the optional commit to blame it as of.
   * @returns Every line's authorship, in file order; a `GitCommandFailedError` (generic message)
   *   when the underlying git command fails (for example, the path does not exist at the given
   *   ref).
   */
  async blame(
    projectId: ProjectId,
    input: { readonly path: string; readonly ref?: string },
  ): Promise<Result<GitBlameLine[], GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    try {
      const { stdout } = await runGitCommand(cwd, {
        command: 'blame',
        flags: ['--line-porcelain'],
        positionals: input.ref ? [input.ref, '--', input.path] : ['--', input.path],
      });
      return { success: true, value: parseBlameOutput(stdout) };
    } catch {
      return { success: false, error: new GitCommandFailedError('The file could not be blamed.') };
    }
  }

  /**
   * Restores the given files in the working tree — dropping their uncommitted changes back to
   * `HEAD`, or, with `input.fromCommit`, to their content at that commit — and returns the resulting
   * change-set. Touches no network — a purely local operation.
   *
   * Every requested path is validated with {@link staysInsideWorkingTree} BEFORE anything else runs
   * — an unsafe path fails the whole discard closed, with nothing touched.
   *
   * The restore target is `input.fromCommit` when given, `HEAD` otherwise. Rather than classifying
   * paths as "tracked"/"untracked" (which a staged-but-never-committed file would answer
   * ambiguously — tracked in the index, yet absent from `HEAD`), each requested path is checked
   * directly against the TARGET ref with `git cat-file -e <target>:<path>`: a path that exists there
   * is restored; one that does not (a newly-added untracked file when discarding to `HEAD`, or any
   * path absent at `fromCommit`) is instead unstaged (`git reset -- <path>`, a no-op for an already-
   * untracked path) and deleted from disk, so "restoring" a path to a state where it never existed
   * actually removes it. Every existing path is restored in ONE `git checkout <target> -- <paths>`
   * invocation, so git applies them atomically; the deletions run after, one path at a time (each on
   * its own already-known-absent-at-target path, so there is nothing left for git to fail atomically
   * on).
   *
   * The change-set is built directly from each requested path's POST-restore on-disk state — never by
   * diffing commits: a path that now has bytes on disk is a `modified` entry carrying them (and their
   * guessed MIME type); a path that is now absent is a `removed` entry.
   *
   * @param projectId - The project whose working tree to restore.
   * @param input - The paths to restore, and, optionally, the commit to restore them from.
   * @returns The resulting change-set on success; a `GitCommandFailedError` when a path is unsafe or
   *   the underlying git command fails.
   */
  async discardChanges(
    projectId: ProjectId,
    input: GitDiscardInput,
  ): Promise<Result<GitMergeFileChange[], GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    for (const requestedPath of input.paths) {
      if (!staysInsideWorkingTree(cwd, requestedPath)) {
        return { success: false, error: new GitCommandFailedError('A path escapes the project working tree.') };
      }
    }

    const targetReference = input.fromCommit ?? 'HEAD';

    try {
      const toRestore: string[] = [];
      const toRemove: string[] = [];
      for (const requestedPath of input.paths) {
        const existsAtTarget = await runGitCommand(cwd, {
          command: 'cat-file',
          flags: ['-e'],
          positionals: [`${targetReference}:${requestedPath}`],
        })
          .then(() => true)
          .catch(() => false);
        (existsAtTarget ? toRestore : toRemove).push(requestedPath);
      }

      if (toRestore.length > 0) {
        await runGitCommand(cwd, { command: 'checkout', positionals: [targetReference, '--', ...toRestore] });
      }
      for (const removedPath of toRemove) {
        await runGitCommand(cwd, { command: 'reset', positionals: ['--', removedPath] });
        await rm(path.join(cwd, removedPath), { force: true });
      }

      const changes: GitMergeFileChange[] = [];
      for (const requestedPath of input.paths) {
        try {
          const content = await readFile(path.join(cwd, requestedPath));
          changes.push({ type: 'modified', path: requestedPath, content, mimeType: guessMimeType(requestedPath) });
        } catch {
          changes.push({ type: 'removed', path: requestedPath });
        }
      }
      return { success: true, value: changes };
    } catch {
      return { success: false, error: new GitCommandFailedError('The changes could not be discarded.') };
    }
  }
}
