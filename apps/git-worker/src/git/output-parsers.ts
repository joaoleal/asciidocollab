import {
  type GitBlameLine,
  type GitLogEntry,
  type GitPendingChange,
  type GitPendingChangeType,
  type GitWorkingTreeStatus,
} from '@asciidocollab/domain';

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
export const LOG_FORMAT = '%H%x00%ae%x00%aI%x00%s';

/**
 * Parses {@link LOG_FORMAT}'s `-z`-terminated stream into this port's domain type.
 *
 * @param stdout - The raw `-z`-terminated `git log --format=<LOG_FORMAT>` output.
 * @returns One {@link GitLogEntry} per commit, in the stream's (newest-first) order.
 */
export function parseLogOutput(stdout: string): GitLogEntry[] {
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
 * Parses `git diff --name-only -z`'s NUL-separated output into a plain path array, dropping the
 * empty trailing token `-z` leaves after the last entry — the same terminator convention
 * {@link parseLogOutput} handles for `git log -z`.
 *
 * @param stdout - The raw `-z`-terminated `git diff --name-only` output.
 * @returns Every changed path, in the stream's own order.
 */
export function parseNameOnlyOutput(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Matches one `git blame --line-porcelain` line-group header: `<hash> <origLine> <finalLine>
 * [<numLines>]`. The object name is 40 hex for a SHA-1 repository or 64 hex for a SHA-256 one
 * (`--object-format=sha256`); both are accepted. Only the hash and the final (not original) line
 * number are captured — the trailing `numLines` field (present only on a group's first line) is not
 * needed.
 */
const BLAME_HEADER_LINE = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/;

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
export function parseBlameOutput(stdout: string): GitBlameLine[] {
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
      // Emit one entry per content line without exception: a caller reconstructs the file by joining
      // these entries' `content` in array order, so dropping a line would shift every line below it
      // and misalign the blame gutter. The header (hash + final line number) always precedes a `\t`
      // line, so those are set; `--line-porcelain` also repeats author-mail/author-time on every
      // group, so in practice they are set too — the `??` fallbacks only guard a malformed stream, and
      // keep a present-but-odd line in place rather than silently deleting it.
      if (currentHash !== null && currentFinalLine !== null) {
        entries.push({
          lineNumber: currentFinalLine,
          hash: currentHash,
          authorEmail: currentAuthorEmail ?? '',
          authoredAt: currentAuthorTime === null ? new Date(0) : new Date(currentAuthorTime * 1000),
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
      const path = unmerged[3];
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
