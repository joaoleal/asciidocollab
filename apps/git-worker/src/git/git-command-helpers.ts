import path from 'node:path';
import {
  AuthenticationFailedError,
  GitCommandFailedError,
  RepositoryUnreachableError,
} from '@asciidocollab/domain';
import { GitProcessError } from './run-git-command.js';

/**
 * The username presented alongside every access token the runner supplies over HTTP Basic auth.
 * A git hosting provider authenticating a personal/installation access token accepts (and mostly
 * ignores) any non-empty username in this slot — this fixed placeholder is never itself a secret.
 */
export const CREDENTIAL_USERNAME = 'x-access-token';

/**
 * The fixed, non-personal identity attributed to the automated commits the runner records (a
 * pre-merge flush snapshot and any merge commit a non-fast-forward merge produces). A merge carries
 * no triggering author the way a user-initiated commit does, so a stable service identity is used
 * rather than any real person's name/email — flagged for review.
 */
export const SERVICE_COMMIT_IDENTITY = { name: 'AsciiDoc Collab', email: 'noreply@asciidocollab.invalid' } as const;

/**
 * Maps a failure from a single network fetch step to the fetch/preview error union — the same
 * reachability/credential classification the clone mapper performs, with a generic
 * `GitCommandFailedError` fallback. There is no non-fast-forward case: a fetch only ever updates a
 * remote-tracking ref, never a branch, so it can never be rejected the way a push can.
 *
 * @param error - The failure thrown by the underlying fetch invocation.
 * @returns The typed error the port surfaces for the failure.
 */
export function toFetchFailure(
  error: unknown,
): RepositoryUnreachableError | AuthenticationFailedError | GitCommandFailedError {
  if (error instanceof GitProcessError) {
    if (error.networkFailureKind === 'unreachable') return new RepositoryUnreachableError();
    if (error.networkFailureKind === 'authentication-failed') return new AuthenticationFailedError();
  }
  return new GitCommandFailedError('The repository could not be fetched.');
}

/**
 * Reports whether `relativePath` resolves to a location inside `workingDirectory` once joined to
 * it — mirrors the symlink-escape check a clone performs on its tracked files, applied here to a
 * commit flush entry's caller-supplied path instead, and checked BEFORE any byte of that entry is
 * written (fail closed: an absolute path is rejected outright, and a relative path that walks out
 * via `..` is caught by resolving it and checking whether the result still lives under
 * `workingDirectory`).
 *
 * @param workingDirectory - The working tree root the path must stay inside.
 * @param relativePath - The caller-supplied path to validate.
 * @returns True when the path stays inside the working tree, false when it escapes.
 */
export function staysInsideWorkingTree(workingDirectory: string, relativePath: string): boolean {
  if (path.isAbsolute(relativePath)) return false;
  const resolved = path.resolve(workingDirectory, relativePath);
  const relativeToRoot = path.relative(workingDirectory, resolved);
  return !escapesWorkingRoot(relativeToRoot);
}

/**
 * Whether a path already made relative to the working root walks OUT of it. A leading `..` must be a
 * whole path SEGMENT (`..` itself, or `../…`): a bare `startsWith('..')` also rejects an innocent
 * root-level filename that merely begins with two dots (e.g. `..config.adoc`), which resolves safely
 * inside the tree. An absolute result escapes too.
 *
 * @param relativeToRoot - A path already made relative to the working root.
 * @returns True when the relative path walks out of the working root.
 */
export function escapesWorkingRoot(relativeToRoot: string): boolean {
  return relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot);
}

/**
 * Derives the Large File Storage transfer endpoint from the ALREADY egress-validated origin remote
 * URL, replicating `git-lfs`'s own default for an https/http remote: the repository URL (given a
 * `.git` suffix if it lacks one) plus `/info/lfs`. Pinning this value with a highest-precedence
 * command-line `-c lfs.url=<endpoint>` on every networked `git lfs` call is what stops a cloned
 * repo's attacker-controlled `.lfsconfig` (or an `lfs.url` smuggled into `.git/config`) from
 * redirecting the transfer — and the out-of-band credential — to an internal or otherwise
 * disallowed host. Because it reproduces git-lfs's default endpoint, an honest repository's LFS
 * transfer is unchanged; only a repo trying to override the endpoint is neutralized.
 *
 * @param remoteUrl - The origin remote URL, already checked against the egress allowlist.
 * @returns The LFS endpoint URL to pin, always on the same host as `remoteUrl`.
 */
export function deriveLfsEndpoint(remoteUrl: string): string {
  let trailingSlashesEnd = remoteUrl.length;
  while (trailingSlashesEnd > 0 && remoteUrl[trailingSlashesEnd - 1] === '/') trailingSlashesEnd -= 1;
  const withoutTrailingSlashes = remoteUrl.slice(0, trailingSlashesEnd);
  const base = withoutTrailingSlashes.endsWith('.git')
    ? withoutTrailingSlashes
    : `${withoutTrailingSlashes}.git`;
  return `${base}/info/lfs`;
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
export function readRevParseAnswer(stdout: string): string {
  const answer = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== '--end-of-options');
  return answer ?? '';
}
