import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CommitAlreadyPushedError,
  GitCommandFailedError,
  type GitAmendError,
  type GitAmendInput,
  type GitCommitInput,
  type GitCommitResult,
  type ProjectId,
  type Result,
} from '@asciidocollab/domain';
import { readRevParseAnswer, staysInsideWorkingTree } from './git-command-helpers.js';
import { shouldTrackWithLfs } from './lfs-pointer.js';
import { buildManagedGitattributes, isPathAlreadyLfsTracked, writeManagedGitattributes } from './managed-gitattributes.js';
import { runGitCommand } from './run-git-command.js';
import { resolveWorkingTreePath } from './working-tree.js';

/**
 * Index-facing git operations: staging, unstaging, committing, and amending. `stage` routes any
 * file at or over the configured LFS threshold through Git LFS before it can land inline in pack
 * history; `commit`/`amendCommit` first flush live collaborative content into the working tree so
 * the recorded commit captures current text rather than stale staged bytes.
 */
export class StagingOps {
  /**
   * @param storageRoot - Root directory for per-project storage (see {@link resolveWorkingTreePath}).
   * @param lfsThresholdBytes - File size, in bytes, at or above which {@link StagingOps.stage}
   *   tracks a path with Git LFS before staging it (`git.lfsThresholdBytes`).
   */
  constructor(
    private readonly storageRoot: string,
    private readonly lfsThresholdBytes: number,
  ) {}

  /**
   * Stages the given files for the next commit (`git add <paths>`), first routing any path at or
   * over {@link StagingOps.lfsThresholdBytes} through Git LFS (see
   * {@link StagingOps.trackLargeFilesWithLfs}) rather than letting it land inline in pack history.
   *
   * The paths are passed as plain positionals, with no extra leading `--` separator: unlike `git
   * reset`, a real `git add` invoked after `--end-of-options` (which already disables all option
   * parsing) treats a subsequent bare `--` as a literal, nonexistent pathspec rather than as a
   * separator, and fails outright — confirmed against real `git` here, not merely inferred.
   *
   * @param projectId - The project whose working tree to stage files in.
   * @param paths - Workspace-relative POSIX paths of the files to stage.
   * @returns Success once staged; a `GitCommandFailedError` when the underlying git command fails
   *   (including a `git-lfs` invocation this required but could not run).
   */
  async stage(projectId: ProjectId, paths: readonly string[]): Promise<Result<void, GitCommandFailedError>> {
    const cwd = resolveWorkingTreePath(this.storageRoot, projectId);
    try {
      const gitattributesTouched = await this.trackLargeFilesWithLfs(cwd, paths);
      const pathsToAdd =
        gitattributesTouched && !paths.includes('.gitattributes') ? [...paths, '.gitattributes'] : [...paths];
      await runGitCommand(cwd, { command: 'add', positionals: pathsToAdd });
      return { success: true, value: undefined };
    } catch {
      return { success: false, error: new GitCommandFailedError('The files could not be staged.') };
    }
  }

  /**
   * Ensures every path in `paths` that is at or over {@link StagingOps.lfsThresholdBytes} — and not
   * already declared `filter=lfs` for that exact path — is tracked with Git LFS before
   * {@link StagingOps.stage} runs `git add`: writes the managed `.gitattributes` entry for it
   * ({@link writeManagedGitattributes}), installs the local `git lfs` filter once per call, and
   * runs `git lfs track <path>`. A path that does not exist (staging a deletion) or is not a regular
   * file is left untouched — there is nothing to size-check or track.
   *
   * Scoped to `stage` only: `unstage` and the commit flush-write path never call this — live
   * documents are text/AsciiDoc, and the binary/asset case always arrives via a stage.
   *
   * @param cwd - The project's working tree.
   * @param paths - The workspace-relative paths about to be staged.
   * @returns True if `.gitattributes` was written to (so the caller also stages it).
   */
  private async trackLargeFilesWithLfs(cwd: string, paths: readonly string[]): Promise<boolean> {
    let gitattributesTouched = false;
    let lfsInstalled = false;

    // `.gitattributes` changes only when this loop writes it (via `writeManagedGitattributes`)
    // below, so read it from disk exactly once here and keep the current contents in memory. Every
    // later iteration consults `gitattributesContent` instead of re-reading the file this loop just
    // wrote, removing an O(N) redundant read on the hot stage path.
    let gitattributesContent = await readFile(path.join(cwd, '.gitattributes'), 'utf8').catch(() => '');

    for (const relativePath of paths) {
      const stats = await stat(path.join(cwd, relativePath)).catch(() => null);
      if (!stats || !stats.isFile()) continue;

      const alreadyTracked = isPathAlreadyLfsTracked(gitattributesContent, relativePath);

      if (!shouldTrackWithLfs(stats.size, this.lfsThresholdBytes, alreadyTracked)) continue;

      await writeManagedGitattributes(cwd, [relativePath]);
      // Mirror in memory exactly what `writeManagedGitattributes` just persisted — it derives the
      // written bytes from the same contents tracked here — so the next iteration's
      // `isPathAlreadyLfsTracked` observes this pattern without a fresh disk read.
      gitattributesContent = buildManagedGitattributes(gitattributesContent, [relativePath]);
      gitattributesTouched = true;

      if (!lfsInstalled) {
        await runGitCommand(cwd, { command: 'lfs', flags: ['install', '--local'] });
        lfsInstalled = true;
      }
      // `git lfs track` is run by the separate `git-lfs` binary (a Go/Cobra CLI), not `git` itself
      // — unlike every other call in this file, it does NOT understand `git`'s own
      // `--end-of-options` disambiguator (it exits nonzero: "unknown flag: --end-of-options").
      // Cobra DOES understand the conventional `--` terminator, so this overrides
      // `optionsTerminator` to keep the same injection-safe guarantee (a path starting with `-` can
      // never be reparsed as a flag) without relying on a `git`-specific convention the external
      // binary never promised to honor.
      await runGitCommand(cwd, {
        command: 'lfs',
        flags: ['track'],
        positionals: [relativePath],
        optionsTerminator: '--',
      });
    }

    return gitattributesTouched;
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
   * 3. Each flush entry is written then `git add`-ed, exactly as {@link StagingOps.commit} does:
   *    write the live content, then re-stage it, so the amend captures current collaborative text
   *    rather than stale staged bytes.
   * 4. `git commit --amend` runs under `identity: input.author` (never a `--author` flag): with
   *    `input.message` (`-m <message>`, taking its value from the very next argv element, shell-safe)
   *    when a replacement message was supplied, or `--no-edit` (keeping the existing message) when it
   *    was not.
   * 5. `rev-parse HEAD` reads the amended commit's new hash; `git log -1 --format=%aI HEAD` reads its
   *    authored date (falling back to `new Date()`, mirroring {@link StagingOps.commit}, if that
   *    secondary read fails — the amend itself already succeeded). The result's `message` is
   *    `input.message` when supplied, or, when it was not, the amended commit's now-kept subject
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
}
