import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AuthenticationFailedError,
  CommitAlreadyPushedError,
  GitCommandFailedError,
  NonFastForwardError,
  RemoteAlreadyInitializedError,
  RepositoryUnreachableError,
  type ClonedFileEntry,
  type ClonedRepository,
  type ConflictStageStore,
  type GitAmendError,
  type GitAmendInput,
  type GitBehindAhead,
  type GitBlameLine,
  type GitBranchList,
  type GitCheckoutInput,
  type GitCheckoutOutcome,
  type GitCloneInput,
  type GitCommandRunner,
  type GitCommitInput,
  type GitCommitResult,
  type GitCreateBranchInput,
  type GitCreatedBranch,
  type GitDiffInput,
  type GitDiffResult,
  type GitDiscardInput,
  type GitFetchInput,
  type GitFetchResult,
  type GitInitializeError,
  type GitInitializeInput,
  type GitInitializeOutcome,
  type GitLogEntry,
  type GitMergeConflictPath,
  type GitMergeFileChange,
  type GitMergeInput,
  type GitMergeOutcome,
  type GitOperationId,
  type GitPendingChange,
  type GitPendingChangeType,
  type GitPushError,
  type GitPushInput,
  type GitPushResult,
  type GitRemoteAccessCheck,
  type GitResolveMergeInput,
  type GitResolveMergeOutcome,
  type GitRestoreOutcome,
  type GitRestoreToSnapshotInput,
  type GitWorkingTreeStatus,
  type ProjectId,
  type Result,
} from '@asciidocollab/domain';
import { assertRemoteHostAllowed, type HostAddressResolver } from './egress-allowlist.js';
import { guessMimeType } from './guess-mime-type.js';
import { declaresLfsFilter } from './lfs-pointer.js';
import { writeManagedGitignore } from './managed-gitignore.js';
import { GitProcessError, runGitCommand, runGitCommandForBytes } from './run-git-command.js';
import { ensureCleanWorkingTree, resolveWorkingTreePath } from './working-tree.js';

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
 * The commit message recorded for {@link RealGitCommandRunner.initializeAndPublish}'s initial
 * commit — the first commit an existing, previously non-git project ever gets.
 */
const INITIAL_COMMIT_MESSAGE = 'Initial commit';

/** The branch {@link RealGitCommandRunner.initializeAndPublish} publishes under when `input.branch` is omitted. */
const DEFAULT_INITIALIZE_BRANCH = 'main';

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
 * Maps a failure from {@link RealGitCommandRunner.initializeAndPublish}'s init→remote-add→
 * commit→push sequence to this port's typed initialize error union (excluding
 * {@link RemoteAlreadyInitializedError}, which is only ever returned by the earlier, separate
 * remote-empty check) — the same reachability/credential classification {@link toCloneFailure}
 * performs, with a generic `GitCommandFailedError` fallback for a local failure (for example, the
 * initial commit itself failing) or an unclassified network failure.
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
 * The comparison is deliberately the two-tree `HEAD` (ours) vs `theirsReference` (theirs) diff, NOT a
 * plain `git diff` of the conflicted working tree: during a conflict, `git diff`'s combined output
 * reports a binary file as `0\t0` rather than `-\t-`, so it cannot distinguish binary from text —
 * whereas an ordinary two-tree diff reliably emits `-\t-` for a binary blob. Both refs exist for
 * the whole conflicted state, before the conflict is cleaned up. Extra (non-conflicted) paths in the
 * result are harmless: the caller only looks up the paths it already knows are conflicted.
 *
 * `theirsReference` is the incoming side of the conflict: `MERGE_HEAD` for a three-way merge conflict, or
 * the stash commit (`stash@{0}`) for a branch-switch conflict where re-applying the shelved live
 * edits onto the target branch did not apply cleanly. Both name the same kind of "theirs" tree.
 *
 * The `-z` numstat stream is NUL-delimited: a normal file is one record `added\tdeleted\tpath`; a
 * rename is a record `added\tdeleted\t` (empty path field) immediately followed by two further
 * NUL-separated tokens (old path, then new path). Both shapes are handled so the scan never
 * misaligns on a renamed entry.
 *
 * @param workingDirectory - The working tree whose in-progress conflict to inspect.
 * @param theirsReference - The incoming side to compare `HEAD` against (`MERGE_HEAD` by default).
 * @returns Every path git reports as a binary change between the two conflict sides.
 */
async function readBinaryDiffPaths(workingDirectory: string, theirsReference = 'MERGE_HEAD'): Promise<Set<string>> {
  const { stdout } = await runGitCommand(workingDirectory, {
    command: 'diff',
    flags: ['--numstat', '-z'],
    positionals: ['HEAD', theirsReference],
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
 * Lists the files a conflict in progress left unmerged (`git diff --name-only --diff-filter=U -z`)
 * and pairs each with its {@link GitMergeConflictPath.isBinary} flag. An empty result means the
 * operation failed for a reason other than a content conflict (its caller treats that as a genuine
 * failure). Serves both a three-way merge conflict and a branch-switch stash-pop conflict — only the
 * `theirsReference` used for the binary classification differs (see {@link readBinaryDiffPaths}).
 *
 * @param workingDirectory - The working tree whose in-progress conflict to inspect.
 * @param theirsReference - The incoming side to classify binary paths against (`MERGE_HEAD` by default).
 * @returns One {@link GitMergeConflictPath} per unmerged file.
 */
async function readMergeConflicts(workingDirectory: string, theirsReference = 'MERGE_HEAD'): Promise<GitMergeConflictPath[]> {
  const { stdout } = await runGitCommand(workingDirectory, {
    command: 'diff',
    flags: ['--name-only', '--diff-filter=U', '-z'],
  });
  const conflictedPaths = stdout.split('\0').filter((entry) => entry.length > 0);
  if (conflictedPaths.length === 0) return [];

  const binaryPaths = await readBinaryDiffPaths(workingDirectory, theirsReference);
  return conflictedPaths.map((conflictedPath) => ({
    path: conflictedPath,
    isBinary: binaryPaths.has(conflictedPath),
  }));
}

/**
 * Reads one conflicting file's optional merge-base stage (`git show :1:<path>`), while the
 * unmerged index entries left by a conflicted merge/stash-pop still exist. A non-zero exit is
 * EXPECTED and not an error here: it means the file had no common ancestor (an add/add conflict),
 * which this returns as `null` rather than surfacing any failure. `filePath` is passed as a
 * positional AFTER `--end-of-options` ({@link runGitCommandForBytes}'s option-injection guard),
 * and the returned bytes are the object's raw content — safe for a binary file.
 *
 * @param workingDirectory - The working tree whose in-progress conflict to read from.
 * @param filePath - The conflicting file's workspace-relative path.
 * @returns The base stage's raw bytes, or null when the file had no merge base.
 */
async function readOptionalBaseStage(workingDirectory: string, filePath: string): Promise<Buffer | null> {
  try {
    return await runGitCommandForBytes(workingDirectory, { command: 'show', positionals: [`:1:${filePath}`] });
  } catch {
    return null;
  }
}

/**
 * Reads one conflicting file's "ours" (`:2:`) or "theirs" (`:3:`) index stage — both stages a
 * genuine content conflict always populates, unlike the optional base stage above. A failure here
 * is a real error (I/O, an unexpected git failure) and is left to propagate, never silently turned
 * into `null`. Same positional/option-injection posture as {@link readOptionalBaseStage}.
 *
 * @param workingDirectory - The working tree whose in-progress conflict to read from.
 * @param stage - `2` for "ours", `3` for "theirs".
 * @param filePath - The conflicting file's workspace-relative path.
 * @returns The stage's raw bytes.
 * @throws {GitProcessError} If the underlying `git show` fails.
 */
async function readRequiredStage(workingDirectory: string, stage: 2 | 3, filePath: string): Promise<Buffer> {
  return runGitCommandForBytes(workingDirectory, { command: 'show', positionals: [`:${stage}:${filePath}`] });
}

/**
 * Computes the file-level change-set landed against `fromCommit`, as `git diff --name-status -M -z
 * <fromCommit> [<toCommit>]`.
 *
 * A clean merge passes both commits (`fromCommit` = post-flush pre-merge `HEAD`, `toCommit` =
 * post-merge `HEAD`), so the result is exactly the REMOTE's contribution, excluding the live local
 * edits the domain already holds. A clean branch switch passes ONLY `fromCommit` (the pre-switch
 * `HEAD`), diffing it against the CURRENT working tree instead of a second commit, so the re-applied
 * live edits — which sit uncommitted in the working tree after the stash-pop — are INCLUDED in the
 * result alongside the target branch's own content. Either way, the added/modified/renamed bytes are
 * read from the working tree on disk, which the domain's own `ProjectFileStore` cannot see.
 *
 * The `-z` name-status stream is NUL-delimited: each record is `status` then its path(s) as
 * separate tokens — `A`/`M`/`D` take one path, `R<score>` takes two (old, then new). `-M` enables
 * rename detection; copy detection is not requested, so no `C` record can appear. `core.quotePath`
 * is globally disabled, so every path token is already raw bytes needing no unescaping.
 *
 * @param workingDirectory - The working tree the changed bytes are read from.
 * @param fromCommit - The base commit to diff from.
 * @param toCommit - The commit to diff to, or omitted to diff `fromCommit` against the working tree.
 * @returns One {@link GitMergeFileChange} per changed file.
 */
async function computeMergeChanges(
  workingDirectory: string,
  fromCommit: string,
  toCommit?: string,
): Promise<GitMergeFileChange[]> {
  const { stdout } = await runGitCommand(workingDirectory, {
    command: 'diff',
    flags: ['--name-status', '-M', '-z'],
    positionals: toCommit === undefined ? [fromCommit] : [fromCommit, toCommit],
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

const execFile = promisify(execFileCallback);

/** Generous ceiling on {@link runNoIndexDiff}'s captured stdout — mirrors `run-git-command`'s own. */
const NO_INDEX_DIFF_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Narrows an unknown value to one carrying a numeric child-process exit `code`. */
function hasNumericExitCode(value: unknown): value is { code: number } {
  if (typeof value !== 'object' || value === null || !('code' in value)) return false;
  return typeof value.code === 'number';
}

/** Narrows an unknown value to one carrying the string `stdout` a failed `execFile` attaches to its rejection. */
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
 * The `git log` machine-readable format {@link RealGitCommandRunner.log} runs: four `%x00`-NUL
 * SEPARATED fields per commit (hash, author email, strict ISO author date, subject) — no trailing
 * separator of its own. Combined with the `-z` flag, which makes `git log` terminate each whole
 * commit RECORD with a single NUL instead of its usual trailing newline, the stream is
 * unambiguously `<hash>\0<email>\0<date>\0<subject>\0<hash>\0...`: exactly `4 * <commit count>`
 * NUL-separated tokens, plus one trailing empty token from the final record's NUL. A trailing
 * `%x00` added to the format ITSELF would double up with `-z`'s own terminator (two NULs between
 * records), which is why the format ends at `%s`, not `%s%x00`.
 */
const LOG_FORMAT = '%H%x00%ae%x00%aI%x00%s';

/**
 * Parses {@link LOG_FORMAT}'s `-z`-terminated stream into this port's domain type.
 *
 * @param stdout - The raw `-z`-terminated `git log --format=<LOG_FORMAT>` output.
 * @returns One {@link GitLogEntry} per commit, in the stream's (newest-first) order.
 */
function parseLogOutput(stdout: string): GitLogEntry[] {
  const fields = stdout.split('\0');
  const entries: GitLogEntry[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const hash = fields[index];
    if (hash.length === 0) continue;
    entries.push({
      hash,
      authorEmail: fields[index + 1],
      authoredAt: new Date(fields[index + 2]),
      message: fields[index + 3],
    });
  }
  return entries;
}

/**
 * Matches one `git blame --line-porcelain` line-group header: `<40-hex-hash> <origLine>
 * <finalLine> [<numLines>]`. Only the hash and the final (not original) line number are captured —
 * the trailing `numLines` field (present only on a group's first line) is not needed.
 */
const BLAME_HEADER_LINE = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

/** Prefix of the `--line-porcelain` header line carrying the commit's author email. */
const AUTHOR_MAIL_PREFIX = 'author-mail ';
/** Prefix of the `--line-porcelain` header line carrying the commit's author time (unix seconds). */
const AUTHOR_TIME_PREFIX = 'author-time ';

/**
 * Parses `git blame --line-porcelain` output into this port's domain type. `--line-porcelain`
 * repeats every header field (including `author-mail`/`author-time`) on EVERY line's group, unlike
 * plain `--porcelain`, which omits repeated headers for a commit already seen — so each group is
 * self-contained and no state needs to persist across a TAB-prefixed content line into the next
 * group.
 *
 * @param stdout - The raw `git blame --line-porcelain` output.
 * @returns One {@link GitBlameLine} per line, in file order (the stream's own order).
 */
function parseBlameOutput(stdout: string): GitBlameLine[] {
  const entries: GitBlameLine[] = [];

  let currentHash: string | null = null;
  let currentFinalLine: number | null = null;
  let currentAuthorEmail: string | null = null;
  let currentAuthorTime: number | null = null;

  for (const line of stdout.split('\n')) {
    const header = BLAME_HEADER_LINE.exec(line);
    if (header) {
      currentHash = header[1];
      currentFinalLine = Number.parseInt(header[2], 10);
      continue;
    }

    if (line.startsWith(AUTHOR_MAIL_PREFIX)) {
      currentAuthorEmail = line.slice(AUTHOR_MAIL_PREFIX.length).replaceAll(/^<|>$/g, '');
      continue;
    }

    if (line.startsWith(AUTHOR_TIME_PREFIX)) {
      currentAuthorTime = Number.parseInt(line.slice(AUTHOR_TIME_PREFIX.length), 10);
      continue;
    }

    if (line.startsWith('\t')) {
      if (currentHash !== null && currentFinalLine !== null && currentAuthorEmail !== null && currentAuthorTime !== null) {
        entries.push({
          lineNumber: currentFinalLine,
          hash: currentHash,
          authorEmail: currentAuthorEmail,
          authoredAt: new Date(currentAuthorTime * 1000),
          content: line.slice(1),
        });
      }
      continue;
    }
    // Every other header line (author, committer, committer-mail, committer-time, committer-tz,
    // author-tz, summary, filename, boundary, previous) carries nothing this port's
    // `GitBlameLine` needs.
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
   * @param conflictStageStore - Off-working-tree store {@link merge}/{@link checkout} write the
   *   pre-operation undo snapshot and captured three-way conflict stages to. Optional so a test
   *   exercising unrelated behavior need not construct one; the composition root always supplies a
   *   real one rooted OUTSIDE every project's working tree. When omitted, `merge`/`checkout` skip
   *   the snapshot/stage capture entirely (their conflicted/clean outcomes are unaffected).
   */
  constructor(
    private readonly storageRoot: string,
    private readonly allowedHosts: readonly string[] = [],
    private readonly resolveHost?: HostAddressResolver,
    private readonly conflictStageStore?: ConflictStageStore,
  ) {}

  /**
   * Records the pre-operation undo snapshot, when a {@link conflictStageStore} was configured.
   * Called by {@link merge}/{@link checkout} before any working-tree mutation, on BOTH the clean
   * and conflicted paths, so every pull/switch leaves an undo target.
   *
   * @param operationId - The operation this snapshot belongs to.
   * @param preOpHead - The local `HEAD` captured before the flush commit / any working-tree change.
   * @param branch - The branch the operation is running on.
   * @returns Success (a no-op) when no store is configured, or once recorded; a
   *   `GitCommandFailedError` when the store's write fails.
   */
  private async writeUndoSnapshot(
    operationId: GitOperationId,
    preOpHead: string,
    branch: string,
  ): Promise<Result<void, GitCommandFailedError>> {
    if (!this.conflictStageStore) return { success: true, value: undefined };

    const written = await this.conflictStageStore.writeSnapshot(operationId, { preOpHead, branch });
    if (!written.success) {
      return { success: false, error: new GitCommandFailedError('The pre-operation snapshot could not be recorded.') };
    }
    return { success: true, value: undefined };
  }

  /**
   * Captures every conflicting path's three-way stages (base/ours/theirs) into
   * {@link conflictStageStore}, when one is configured — called by {@link merge}/{@link checkout}
   * AFTER the conflict is detected but BEFORE the caller aborts it, while the unmerged index
   * entries `git show :1:/:2:/:3:<path>` reads from still exist.
   *
   * Never throws: every failure (a required `:2:`/`:3:` stage read, or the store's own write) is
   * caught and turned into a `GitCommandFailedError` result, so the caller can always run its
   * abort in a `finally` around this call and still learn whether the capture succeeded.
   *
   * @param workingDirectory - The working tree whose in-progress conflict to capture.
   * @param operationId - The conflicted operation these stages belong to.
   * @param conflicts - Every path left in conflict, with its binary classification.
   * @returns Success (a no-op) when no store is configured, or once every path is captured; a
   *   `GitCommandFailedError` on the first read or write failure.
   */
  private async captureConflictStages(
    workingDirectory: string,
    operationId: GitOperationId,
    conflicts: readonly GitMergeConflictPath[],
  ): Promise<Result<void, GitCommandFailedError>> {
    if (!this.conflictStageStore) return { success: true, value: undefined };

    try {
      for (const conflict of conflicts) {
        const base = await readOptionalBaseStage(workingDirectory, conflict.path);
        const ours = await readRequiredStage(workingDirectory, 2, conflict.path);
        const theirs = await readRequiredStage(workingDirectory, 3, conflict.path);

        const written = await this.conflictStageStore.writeStages(operationId, conflict.path, {
          base,
          ours,
          theirs,
          isBinary: conflict.isBinary,
        });
        if (!written.success) {
          return { success: false, error: new GitCommandFailedError('The conflict could not be recorded.') };
        }
      }
      return { success: true, value: undefined };
    } catch {
      return { success: false, error: new GitCommandFailedError('The conflict could not be recorded.') };
    }
  }

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
   * Amends the most-recent commit — folding the currently-staged changes (with any live text
   * supplied via `input.flush`) into it and, when `input.message` is given, replacing its message.
   * Touches no network — a purely LOCAL operation.
   *
   * Ordering (all in the project's own working tree):
   * 1. **Pushed-detection FIRST, before any mutation.** The current branch is read
   *    (`git rev-parse --abbrev-ref HEAD`), then `git merge-base --is-ancestor HEAD
   *    refs/remotes/origin/<branch>` is run: a CLEAN exit (0) means `HEAD` is already an ancestor of
   *    (or equal to) the remote tip — the most-recent commit is already published — and this returns
   *    {@link CommitAlreadyPushedError} making NO change at all (no flush write, no `git add`, no
   *    amend). Any throw from that check — exit 1 (`HEAD` is ahead, genuinely unpushed) OR the
   *    ancestor check erroring outright because `refs/remotes/origin/<branch>` does not exist (the
   *    branch was never pushed) — is treated identically as "not (yet) pushed": proceed. Only a
   *    successful (exit-0) ancestor check refuses; every other outcome proceeds, so a project that
   *    has never been connected to a remote (no tracking ref at all) is never wrongly refused.
   * 2. Every `input.flush` entry's path is validated with {@link staysInsideWorkingTree} BEFORE any
   *    write — an unsafe path fails the whole amend closed, with no partial write. (This guard runs
   *    before step 1's network-free but still meaningfully ordered check, so an unsafe path is
   *    rejected without ever inspecting push state.)
   * 3. Each flush entry is written then `git add`-ed, exactly as {@link commit} does — write the
   *    live content, then re-stage it, so the amend captures current collaborative text rather than
   *    stale staged bytes.
   * 4. `git commit --amend` runs under `identity: input.author` (never a `--author` flag): with
   *    `input.message` (`-m <message>`, taking its value from the very next argv element, shell-safe)
   *    when a replacement message was supplied, or `--no-edit` (keeping the existing message) when it
   *    was not.
   * 5. `rev-parse HEAD` reads the amended commit's new hash; `git log -1 --format=%aI HEAD` reads its
   *    authored date (falling back to `new Date()`, mirroring {@link commit}, if that secondary read
   *    fails — the amend itself already succeeded). The result's `message` is `input.message` when
   *    supplied, or, when it was not, the amended commit's now-kept subject
   *    (`git log -1 --format=%s HEAD`), so a message-less amend still reports the message it landed
   *    with rather than `undefined`.
   *
   * @param projectId - The project whose most-recent commit to amend.
   * @param input - The optional replacement message, the author, and the live-content flush list.
   * @returns The amended commit on success; a {@link CommitAlreadyPushedError} (making no change)
   *   when the current commit is already present on the remote-tracking branch, or a
   *   `GitCommandFailedError` when a flush path is unsafe or the underlying git command fails.
   */
  async amendCommit(projectId: ProjectId, input: GitAmendInput): Promise<Result<GitCommitResult, GitAmendError>> {
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
      const branchOutput = await runGitCommand(cwd, { command: 'rev-parse', flags: ['--abbrev-ref', 'HEAD'] });
      const branch = readRevParseAnswer(branchOutput.stdout);

      // A clean (exit-0) ancestor check is the ONLY refusal signal — any throw (exit 1, meaning HEAD
      // is ahead and genuinely unpushed, OR the remote-tracking ref not existing at all) means
      // "proceed", never "refuse".
      const alreadyPushed = await runGitCommand(cwd, {
        command: 'merge-base',
        flags: ['--is-ancestor'],
        positionals: ['HEAD', `refs/remotes/origin/${branch}`],
      })
        .then(() => true)
        .catch(() => false);

      if (alreadyPushed) {
        return { success: false, error: new CommitAlreadyPushedError() };
      }

      for (const entry of input.flush) {
        await writeFile(path.join(cwd, entry.path), entry.content, 'utf8');
        await runGitCommand(cwd, { command: 'add', positionals: [entry.path] });
      }

      // `--reset-author` is required for the amended commit's AUTHOR (not just its committer) to
      // pick up `identity`: `git commit --amend` otherwise keeps the ORIGINAL commit's author
      // unconditionally, ignoring `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` entirely unless this flag (or
      // an explicit `--author`) is given — confirmed against real `git`, not merely inferred.
      await runGitCommand(cwd, {
        command: 'commit',
        flags:
          input.message === undefined
            ? ['--amend', '--reset-author', '--no-edit']
            : ['--amend', '--reset-author', '-m', input.message],
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
        // Falls back to the `new Date()` set above — the amend itself already succeeded.
      }

      let message = input.message;
      if (message === undefined) {
        const subjectOutput = await runGitCommand(cwd, { command: 'log', flags: ['-1', '--format=%s', 'HEAD'] });
        message = subjectOutput.stdout.trim();
      }

      return { success: true, value: { hash, message, authoredAt } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The commit could not be amended.') };
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
   * Initializes git on an existing, previously non-git project's real working tree and publishes
   * it to a fresh, empty remote. This is the atomic init → remote-add → initial-commit → push
   * sequence this port's JSDoc documents.
   *
   * Ordering (all against `resolveWorkingTreePath(this.storageRoot, projectId)` — the project's
   * OWN working tree, never a scratch directory: its files already exist, having never been
   * git-managed before this call):
   * 1. {@link assertRemoteAllowed} Gates the whole call before any network attempt.
   * 2. `git ls-remote <input.remoteUrl>`, authenticated out-of-band exactly like {@link clone},
   *    checks whether the remote already has any ref/commit. Any output at all means the remote is
   *    non-empty: this returns {@link RemoteAlreadyInitializedError} immediately, WITHOUT running
   *    `git init` or touching the working tree in any way — a non-empty remote is never overwritten.
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
   *    exactly like {@link push}.
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
   *   {@link checkRemoteAccess}, or a {@link GitCommandFailedError} for any other failure.
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
   * 1. `preOpHead` (`rev-parse HEAD`, BEFORE the flush commit) is recorded as the operation's undo
   *    snapshot via {@link writeUndoSnapshot} — on BOTH the clean and conflicted paths below, so
   *    every pull leaves an undo target.
   * 2. Every `input.flush` entry's path is validated with {@link staysInsideWorkingTree} BEFORE any
   *    write — an unsafe path fails the whole merge closed, with no partial write.
   * 3. Each flush entry is written then `git add`-ed, exactly as {@link commit} does, forming the
   *    live local side of the merge.
   * 4. That local side is committed — but only when {@link hasStagedChanges} confirms something is
   *    staged — under {@link SERVICE_COMMIT_IDENTITY} (a merge carries no author) with
   *    {@link FLUSH_COMMIT_MESSAGE}, so the merge is a clean commit-vs-commit three-way.
   * 5. `preMergeHead` is captured AFTER that commit, so the computed change-set is the REMOTE's
   *    contribution only, excluding the live local edits the domain already holds.
   * 6. `git merge --no-edit refs/remotes/origin/<branch>` runs. A non-zero exit is EXPECTED when the
   *    merge conflicts and is NOT immediately an error: unmerged paths are inspected
   *    ({@link readMergeConflicts}) — if there are none the exit was a genuine failure
   *    (`GitCommandFailedError`); if there are, each conflicting path's three-way stages are
   *    captured via {@link captureConflictStages} BEFORE `git merge --abort` runs (in a `finally`,
   *    so a capture failure can never leave `MERGE_HEAD` behind) and the `conflicted` outcome is
   *    returned — UNLESS the capture itself failed, in which case a `GitCommandFailedError` is
   *    returned instead, after the abort has already restored a clean tree.
   * 7. On a clean merge, the change-set is computed from `preMergeHead` to the post-merge `HEAD`
   *    ({@link computeMergeChanges}); an unchanged `HEAD` (already up to date) yields empty changes.
   *
   * @param projectId - The project whose working tree to merge into.
   * @param input - The branch to merge into, the live-content flush list, and the operation id the
   *   undo snapshot and any captured conflict stages are keyed by.
   * @returns A {@link GitMergeOutcome} — `merged` (with the remote's change-set) or `conflicted`
   *   (with the files left in conflict); a `GitCommandFailedError` only when a git command itself
   *   fails, a flush path is unsafe, or the stage-store capture fails. A conflict is an expected
   *   outcome, never an error.
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
      const preOpHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preOpHead = readRevParseAnswer(preOpHeadResult.stdout);
      const snapshotWritten = await this.writeUndoSnapshot(input.operationId, preOpHead, input.branch);
      if (!snapshotWritten.success) return snapshotWritten;

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

        // Capture every conflicting path's three-way stages BEFORE the abort — the abort runs in
        // a `finally` so a capture failure can never leave `MERGE_HEAD` behind.
        let captured: Result<void, GitCommandFailedError> = { success: true, value: undefined };
        try {
          captured = await this.captureConflictStages(cwd, input.operationId, conflicts);
        } finally {
          await runGitCommand(cwd, { command: 'merge', flags: ['--abort'] });
        }
        if (!captured.success) return captured;

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

  /**
   * Switches the project's working tree to another local branch, carrying in-progress live edits
   * across the switch. Touches no network — a purely LOCAL operation, like {@link merge}: no egress,
   * no credential. Follows the port's `checkout` adapter contract exactly, atomically:
   *
   * 1. Every `input.flush` entry's path is validated with {@link staysInsideWorkingTree} BEFORE any
   *    write — an unsafe path fails the whole switch closed, with no partial write.
   * 2. `preSwitchHead` (the source branch tip) is captured. It is NOT a flush commit: unlike
   *    {@link merge}, the flushed edits are carried across by a stash, never committed on the source
   *    branch. It doubles as the operation's pre-operation undo snapshot ({@link writeUndoSnapshot}),
   *    recorded on BOTH the clean and conflicted paths below, so every switch leaves an undo target.
   * 3. Each flush entry is written then `git add`-ed, exactly as {@link commit}/{@link merge} do,
   *    materializing the live edits as staged working-tree state on the source branch.
   * 4. When `input.stashLocal` is true AND that flush actually staged something
   *    ({@link hasStagedChanges}), `git stash push` shelves it so the switch can carry it across; a
   *    clean tree shelves nothing, and the later pop is skipped.
   * 5. `git checkout <input.branch>` switches to the target branch (the branch is a positional after
   *    `--end-of-options`). A failure here — for example an unknown target branch — throws and
   *    becomes a generic `GitCommandFailedError`.
   * 6. When step 4 stashed, `git stash pop` re-applies the shelved edits. A non-zero exit is EXPECTED
   *    when the edits collide with the target branch and is NOT immediately an error: unmerged paths
   *    are inspected ({@link readMergeConflicts}, classifying binary against the stash commit) — if
   *    there are none the exit was a genuine failure; if there are, every conflicting path's
   *    three-way stages are captured via {@link captureConflictStages} — the unmerged index entries
   *    still exist at this point — BEFORE the working tree is restored to a clean checkout of the
   *    target branch (`git reset --hard`) and the now-unneeded stash is dropped (both run in a
   *    `finally`, so a capture failure can never leave the stash undropped), leaving a defined,
   *    clean tree exactly as {@link merge}'s `--abort` does. The live edits are not lost — they
   *    remain live in each collaborator's editor, which the later conflict-resolution flow
   *    reconciles against the reported paths. The `conflicted` outcome is returned — UNLESS the
   *    capture itself failed, in which case a `GitCommandFailedError` is returned instead, after the
   *    reset/drop have already restored a clean tree.
   * 7. On a clean switch, `git add -A` stages the re-applied edits (so a flushed edit to a file absent
   *    from the target branch is captured as an addition), and `changes` is the delta from
   *    `preSwitchHead` to the post-switch working tree ({@link computeMergeChanges} with no second
   *    commit) — the target branch's own content AND the re-applied live edits, per the port contract.
   *    An identical tree yields empty `changes`.
   *
   * @param projectId - The project whose working tree to switch.
   * @param input - The target branch, the live-content flush list, whether to carry local edits,
   *   and the operation id the undo snapshot and any captured conflict stages are keyed by.
   * @returns A {@link GitCheckoutOutcome} — `switched` with the resulting changes (empty when the
   *   tree is unchanged) or `conflicted` with the files the stash-pop left in conflict; a conflict is
   *   an expected outcome, never an error. Returns a `GitCommandFailedError` (generic message) only
   *   when the underlying git command itself fails, a flush path is unsafe, or the stage-store
   *   capture fails.
   */
  async checkout(
    projectId: ProjectId,
    input: GitCheckoutInput,
  ): Promise<Result<GitCheckoutOutcome, GitCommandFailedError>> {
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
      const preSwitchHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preSwitchHead = readRevParseAnswer(preSwitchHeadResult.stdout);
      // preSwitchHead IS the pre-operation head (a switch never takes a flush commit on the source
      // branch — the flushed edits are carried across by a stash instead), so it doubles as the
      // undo snapshot's `preOpHead`, recorded on BOTH the clean and conflicted paths below.
      const snapshotWritten = await this.writeUndoSnapshot(input.operationId, preSwitchHead, input.branch);
      if (!snapshotWritten.success) return snapshotWritten;

      for (const entry of input.flush) {
        await writeFile(path.join(cwd, entry.path), entry.content, 'utf8');
        await runGitCommand(cwd, { command: 'add', positionals: [entry.path] });
      }

      const stashed = input.stashLocal && (await hasStagedChanges(cwd));
      if (stashed) {
        await runGitCommand(cwd, { command: 'stash', flags: ['push'] });
      }

      await runGitCommand(cwd, { command: 'checkout', positionals: [input.branch] });

      if (stashed) {
        try {
          await runGitCommand(cwd, { command: 'stash', flags: ['pop'] });
        } catch (error) {
          // A failed pop is a content conflict only if it left unmerged paths; otherwise it is a
          // genuine command failure. The stash commit (`stash@{0}`, kept by the failed pop) is the
          // "theirs" side for the binary classification, mirroring how a merge uses `MERGE_HEAD`.
          const conflicts = await readMergeConflicts(cwd, 'stash@{0}');
          if (conflicts.length === 0) {
            throw error;
          }

          // Capture every conflicting path's three-way stages BEFORE the reset/drop — both run in
          // a `finally` so a capture failure can never leave the stash undropped or the tree dirty.
          let captured: Result<void, GitCommandFailedError> = { success: true, value: undefined };
          try {
            captured = await this.captureConflictStages(cwd, input.operationId, conflicts);
          } finally {
            // Restore a clean checkout of the target branch and drop the shelved edits, exactly as
            // `merge --abort` leaves a clean tree. The edits are not lost: they stay live in each
            // collaborator's editor, which the later conflict-resolution flow reconciles.
            await runGitCommand(cwd, { command: 'reset', flags: ['--hard'] });
            await runGitCommand(cwd, { command: 'stash', flags: ['drop'] });
          }
          if (!captured.success) return captured;

          return { success: true, value: { status: 'conflicted', conflicts } };
        }
      }

      // Stage the re-applied edits so a flushed file absent from the target branch is captured as an
      // addition in the change-set (a plain commit-to-worktree diff omits still-untracked files).
      await runGitCommand(cwd, { command: 'add', flags: ['-A'] });

      const postSwitchHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const postSwitchHead = readRevParseAnswer(postSwitchHeadResult.stdout);

      const changes = await computeMergeChanges(cwd, preSwitchHead);
      return { success: true, value: { status: 'switched', headCommit: postSwitchHead, changes } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The branch switch could not be completed.') };
    }
  }

  /**
   * Completes a previously-aborted conflicted `PULL` by RE-RUNNING `git merge --no-edit
   * refs/remotes/origin/<branch>` (recreating `MERGE_HEAD`), dropping each `input.resolutions`
   * entry onto its conflicted path, and taking a genuine resolving merge commit. Re-running the
   * merge (rather than committing only the files that were in conflict) also recovers whatever the
   * remote changed in files that were NOT conflicted, which the original abort discarded. Touches
   * no network.
   *
   * Ordering: `ensureCleanWorkingTree` (belt-and-braces — the tree should already be clean, per
   * `AWAITING_CONFLICT`'s own invariant) → capture `preHead` → re-run the merge (a non-zero exit
   * with no unmerged paths is a genuine failure, e.g. The tracking ref no longer exists; a CLEAN
   * merge here — the remote resolved itself since detection — is also fine, nothing to apply) → for
   * each resolution, `ours`/`theirs` via `git checkout --ours/--theirs -- <path>` + `git add`, or
   * `merged` via the bytes {@link ConflictStageStore.readMerged} recorded, written then `git add`-ed
   * → verify no unmerged path remains (`git diff --name-only --diff-filter=U`); if one does, abort
   * and return `stillConflicted` with the still-unmerged paths (classified exactly as
   * {@link merge} classifies its own) → `git commit --no-edit` (reusing the merge's own prepared
   * message) under {@link SERVICE_COMMIT_IDENTITY} → compute the change-set from `preHead` to the
   * new `HEAD` via {@link computeMergeChanges}.
   *
   * Any throw while applying resolutions (or reading the still-unmerged set) runs `git merge
   * --abort` before propagating, so a partial failure never leaves `MERGE_HEAD` or a half-resolved
   * index behind — the awaiting operation stays untouched and retryable.
   *
   * @param projectId - The project whose working tree to complete the merge in.
   * @param input - The branch, the operation id (keys the conflict-stage-store reads for a
   *   `merged` resolution), and every conflicting file's chosen resolution.
   * @returns A {@link GitResolveMergeOutcome}; a `GitCommandFailedError` (generic message) when the
   *   underlying git command fails, no conflict-stage store is configured for a `merged`
   *   resolution, or its recorded bytes are missing.
   */
  async resolveMerge(
    projectId: ProjectId,
    input: GitResolveMergeInput,
  ): Promise<Result<GitResolveMergeOutcome, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    try {
      await ensureCleanWorkingTree(cwd);

      const preHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preHead = readRevParseAnswer(preHeadResult.stdout);

      const remoteReference = `refs/remotes/origin/${input.branch}`;
      let reproducedConflict = false;
      try {
        await runGitCommand(cwd, {
          command: 'merge',
          flags: ['--no-edit'],
          positionals: [remoteReference],
          identity: SERVICE_COMMIT_IDENTITY,
        });
      } catch (error) {
        const conflicts = await readMergeConflicts(cwd);
        if (conflicts.length === 0) {
          // No unmerged paths → a genuine command failure (e.g. the tracking ref no longer
          // exists), not a reproduction of the original conflict.
          throw error;
        }
        reproducedConflict = true;
      }

      if (reproducedConflict) {
        const stillConflicted = await this.applyResolutionsOrAbort(cwd, input);
        if (stillConflicted) {
          return { success: true, value: stillConflicted };
        }

        await runGitCommand(cwd, { command: 'commit', flags: ['--no-edit'], identity: SERVICE_COMMIT_IDENTITY });
      }

      const headCommitResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const headCommit = readRevParseAnswer(headCommitResult.stdout);
      const changes = await computeMergeChanges(cwd, preHead, headCommit);
      return { success: true, value: { status: 'resolved', headCommit, changes } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The merge could not be completed.') };
    }
  }

  /**
   * Applies every resolution onto the just-reproduced conflicted merge, then verifies no unmerged
   * path remains. Returns the `stillConflicted` outcome (after aborting) when one does; returns
   * null — meaning the caller should proceed straight to `git commit` — when every path is clean.
   *
   * Any throw while applying a resolution (or checking the remaining unmerged set) runs `git merge
   * --abort` before rethrowing, so {@link resolveMerge}'s own `catch` always finds a clean tree.
   */
  private async applyResolutionsOrAbort(
    cwd: string,
    input: GitResolveMergeInput,
  ): Promise<GitResolveMergeOutcome | null> {
    try {
      for (const resolution of input.resolutions) {
        if (resolution.resolution === 'merged') {
          if (!this.conflictStageStore) {
            throw new Error('No conflict stage store is configured to read the merged content from.');
          }
          const merged = await this.conflictStageStore.readMerged(input.operationId, resolution.path);
          if (!merged.success || merged.value === null) {
            throw new Error(`No merged content was recorded for '${resolution.path}'.`);
          }
          await writeFile(path.join(cwd, resolution.path), merged.value);
          await runGitCommand(cwd, { command: 'add', positionals: [resolution.path] });
        } else {
          await runGitCommand(cwd, {
            command: 'checkout',
            flags: [`--${resolution.resolution}`],
            positionals: [resolution.path],
          });
          await runGitCommand(cwd, { command: 'add', positionals: [resolution.path] });
        }
      }

      const remaining = await readMergeConflicts(cwd);
      if (remaining.length > 0) {
        await runGitCommand(cwd, { command: 'merge', flags: ['--abort'] });
        return { status: 'stillConflicted', conflicts: remaining };
      }
      return null;
    } catch (error) {
      await runGitCommand(cwd, { command: 'merge', flags: ['--abort'] }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Restores the working tree to an operation's pre-operation undo snapshot, undoing a pull or
   * switch — whether it left the project `AWAITING_CONFLICT` or already landed cleanly. Touches no
   * network.
   *
   * Reads the snapshot from the configured conflict-stage store by `input.operationId`; captures
   * the pre-reset `HEAD`; `git reset --hard <preOpHead>`; computes the reversal change-set as the
   * delta from the pre-reset `HEAD` to the now-reset working tree via the single-argument form of
   * {@link computeMergeChanges} (mirrors how {@link checkout} computes its own change-set) — the
   * exact set the caller needs to revert docs/live editors.
   *
   * @param projectId - The project whose working tree to restore.
   * @param input - The operation whose snapshot to restore to.
   * @returns A {@link GitRestoreOutcome}; a `GitCommandFailedError` (generic message) when no
   *   conflict-stage store is configured, no snapshot is recorded for the operation, its recorded
   *   commit is no longer resolvable, or the underlying git command fails.
   */
  async restoreToSnapshot(
    projectId: ProjectId,
    input: GitRestoreToSnapshotInput,
  ): Promise<Result<GitRestoreOutcome, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);

    if (!this.conflictStageStore) {
      return { success: false, error: new GitCommandFailedError('No conflict stage store is configured.') };
    }

    try {
      const snapshot = await this.conflictStageStore.readSnapshot(input.operationId);
      if (!snapshot.success) return snapshot;
      if (snapshot.value === null) {
        return {
          success: false,
          error: new GitCommandFailedError('No pre-operation snapshot is recorded for this operation.'),
        };
      }

      const preResetHeadResult = await runGitCommand(cwd, { command: 'rev-parse', flags: ['HEAD'] });
      const preResetHead = readRevParseAnswer(preResetHeadResult.stdout);

      await runGitCommand(cwd, { command: 'reset', flags: ['--hard'], positionals: [snapshot.value.preOpHead] });

      const changes = await computeMergeChanges(cwd, preResetHead);
      return { success: true, value: { headCommit: snapshot.value.preOpHead, changes } };
    } catch {
      return { success: false, error: new GitCommandFailedError('The working tree could not be restored.') };
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
   *   live text is authoritative instead): {@link diffLiveContentOverride} diffs HEAD's blob of that
   *   one path against the supplied live text directly, never reading the stale on-disk copy.
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
