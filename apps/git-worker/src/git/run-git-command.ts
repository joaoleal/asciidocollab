import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCallback);

/** Generous ceiling on captured stdout/stderr — status/diff/log output can be large. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Default kill timeout for a single `git` invocation, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The global `-c` config this wrapper applies to every invocation, regardless of subcommand:
 * cross-host HTTP redirects are refused outright (closes redirect-based SSRF), the protocol
 * allowlist is closed by default and reopened only for the transports git-worker actually needs
 * (`file` for local/test remotes, `http`/`https` for real providers — `ext`, `git`, and `ssh` stay
 * blocked), any configured credential helper is cleared so the only credential source is the one
 * `runGitCommand` itself supplies, and paths are never quoted/escaped so this module's own porcelain
 * parsing sees raw bytes.
 */
const SECURE_GLOBAL_CONFIG: readonly string[] = [
  '-c', 'http.followRedirects=false',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=always',
  '-c', 'protocol.http.allow=always',
  '-c', 'protocol.https.allow=always',
  '-c', 'credential.helper=',
  '-c', 'core.quotePath=false',
];

/**
 * An out-of-band credential for a single `git` invocation.
 *
 * Never placed in argv, the remote URL, or `.git/config`: {@link runGitCommand} writes it to a
 * per-call, mode-0700 `GIT_ASKPASS` helper script (the script itself contains no secret — it only
 * reads one back out of the environment at run time) and hands it to the child process via
 * environment variables scoped to that single invocation, deleting both again once the command
 * finishes.
 */
export interface GitCredential {
  /** The username `git` should present when the remote challenges for Basic auth. */
  readonly username: string;
  /** The plaintext access token, used as the Basic-auth password. Held only for this call. */
  readonly token: string;
}

/**
 * The commit author/committer identity for a single `git commit` invocation.
 *
 * Passed the same out-of-band way as {@link GitCredential} (environment variables scoped to that
 * one child process, never argv) — not because a name/email is secret, but because it lets
 * `commit`'s caller avoid building a `--author="<name> <email>"` flag out of caller-supplied text.
 */
export interface GitCommitIdentity {
  /** Written as both `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME` for this invocation. */
  readonly name: string;
  /** Written as both `GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_EMAIL` for this invocation. */
  readonly email: string;
}

/** A single `git` invocation: a fixed subcommand plus its arguments and optional credential. */
export interface GitCommandSpec {
  /** The git subcommand to run (e.g. `'status'`, `'fetch'`). Never derived from user input. */
  readonly command: string;
  /**
   * Static, code-authored flags for the subcommand (e.g. `['--porcelain=v2', '--branch']`),
   * placed BEFORE `--end-of-options`. These must never be built from caller-supplied strings —
   * that is exactly what `positionals` is for.
   */
  readonly flags?: readonly string[];
  /**
   * Caller/user-influenced positional arguments (paths, refs, branch names, remote URLs, commit
   * messages). Always placed AFTER `--end-of-options`, so a value that happens to start with `-`
   * can never be parsed as a git option — the option-injection defense this wrapper exists to
   * provide.
   */
  readonly positionals?: readonly string[];
  /** An out-of-band credential to supply for this invocation only, or omit for none needed. */
  readonly credential?: GitCredential;
  /** The author/committer identity to record for this invocation only (only meaningful for `commit`). */
  readonly identity?: GitCommitIdentity;
  /** Overrides {@link DEFAULT_TIMEOUT_MS} for this invocation. */
  readonly timeoutMs?: number;
}

/** The captured output of a successful `git` invocation. */
export interface GitCommandResult {
  /** The process's standard output. */
  readonly stdout: string;
  /** The process's standard error. */
  readonly stderr: string;
}

/**
 * Raised when the underlying `git` process cannot be spawned or exits non-zero.
 *
 * Deliberately carries no raw stdout/stderr or argv in its `message` — only a fixed, safe message
 * plus the exit code — so a caller may wrap it directly into a domain error without further
 * scrubbing. The one exception is {@link networkFailureKind}: a coarse, pre-computed
 * classification (never the stderr text itself) that a network-operation caller may use to choose
 * between typed domain errors, for example unreachable versus rejected credential, without ever
 * touching raw process output.
 */
export class GitProcessError extends Error {
  /**
   * @param message - A safe, human-readable description of the failure.
   * @param exitCode - The process's exit code, or null if it could not be determined (for
   *   example, the `git` binary itself could not be spawned).
   * @param networkFailureKind - This failure's best-effort network classification, or undefined
   *   when it doesn't match a recognized reachability/credential pattern (see
   *   {@link classifyNetworkFailure}).
   */
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly networkFailureKind?: NetworkFailureKind,
  ) {
    super(message);
    this.name = 'GitProcessError';
  }
}

/** Narrows an unknown value to one carrying a numeric Node child-process exit `code`. */
function hasNumericExitCode(value: unknown): value is { code: number } {
  if (typeof value !== 'object' || value === null || !('code' in value)) return false;
  return typeof value.code === 'number';
}

/** Narrows an unknown value to one carrying the string `stderr` Node attaches to a failed `execFile`. */
function hasStderrText(value: unknown): value is { stderr: string } {
  if (typeof value !== 'object' || value === null || !('stderr' in value)) return false;
  return typeof value.stderr === 'string';
}

/**
 * A best-effort classification of why a network-facing `git` invocation failed, distinguishing a
 * remote that could not be reached at all from one that was reached but rejected the supplied
 * credential. Lets a caller performing a network operation (clone, a remote-access check, ...) map
 * a failure to the right typed domain error without ever handling — or being handed — the raw
 * process output itself.
 */
export type NetworkFailureKind = 'unreachable' | 'authentication-failed' | 'non-fast-forward';

/**
 * Stderr substrings (matched case-insensitively, against English text — see this file's `LC_ALL`
 * override) that reliably indicate the remote itself could not be reached: name resolution
 * failure, connection refusal/reset/timeout, or no viable route.
 */
const UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /could not resolve host/i,
  /failed to connect/i,
  /could not connect to server/i,
  /connection refused/i,
  /connection reset/i,
  /connection timed out/i,
  /operation timed out/i,
  /network is unreachable/i,
  /no route to host/i,
];

/**
 * Stderr substrings indicating the remote was reached but the credential was rejected: git's own
 * "Authentication failed" (the terminal message once every `GIT_ASKPASS` credential attempt has
 * been exhausted) and an HTTP 401/403 the transport surfaces verbatim.
 */
const AUTHENTICATION_FAILED_PATTERNS: readonly RegExp[] = [
  /authentication failed/i,
  /invalid username or (password|token)/i,
  /returned error: 40[13]\b/i,
];

/**
 * Stderr substrings indicating `push` refused a ref update because the remote already has commits
 * this branch does not — git's `! [rejected] ... (non-fast-forward)` / `(fetch first)` — as
 * opposed to the push never reaching the remote, or the remote rejecting the credential.
 */
const NON_FAST_FORWARD_PATTERNS: readonly RegExp[] = [/\[rejected\][^\n]*(non-fast-forward|fetch first)/i];

/**
 * Classifies a failed network `git` invocation's stderr into a {@link NetworkFailureKind}, or
 * undefined when the text matches neither known pattern (a failure unrelated to reachability or
 * credentials — a missing branch, a disk-full working tree, and so on).
 *
 * Exported for direct unit testing against synthetic stderr text — real `git` failures exercise
 * only a handful of these patterns without an actual flaky/unreachable network to provoke the rest.
 *
 * @param stderr - The failed invocation's raw stderr text.
 * @returns The matched failure kind, or undefined.
 */
export function classifyNetworkFailure(stderr: string): NetworkFailureKind | undefined {
  if (UNREACHABLE_PATTERNS.some((pattern) => pattern.test(stderr))) return 'unreachable';
  if (AUTHENTICATION_FAILED_PATTERNS.some((pattern) => pattern.test(stderr))) return 'authentication-failed';
  if (NON_FAST_FORWARD_PATTERNS.some((pattern) => pattern.test(stderr))) return 'non-fast-forward';
  return undefined;
}

const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  'case "$1" in',
  '  Username*) printf \'%s\' "$GIT_WORKER_ASKPASS_USERNAME" ;;',
  '  *) printf \'%s\' "$GIT_WORKER_ASKPASS_TOKEN" ;;',
  'esac',
  '',
].join('\n');

/**
 * Runs a single `git` subcommand against `cwd` via `child_process.execFile` — array arguments,
 * never a shell string — applying the secure defaults every git-worker verb shares (see
 * {@link SECURE_GLOBAL_CONFIG} and {@link GitCommandSpec.positionals}).
 *
 * @param cwd - The working tree (or bare repository) to run the command against.
 * @param spec - The subcommand, its static flags, caller-supplied positionals, and an optional
 *   out-of-band credential.
 * @returns The command's captured stdout/stderr.
 * @throws {GitProcessError} If `git` cannot be spawned or exits non-zero.
 */
export async function runGitCommand(cwd: string, spec: GitCommandSpec): Promise<GitCommandResult> {
  const arguments_ = [
    ...SECURE_GLOBAL_CONFIG,
    spec.command,
    ...(spec.flags ?? []),
    '--end-of-options',
    ...(spec.positionals ?? []),
  ];

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // Forces git's own diagnostic text to stable English, regardless of the host's locale — the
    // only thing {@link classifyNetworkFailure} reads to tell an unreachable remote apart from a
    // rejected credential. Does not affect any machine-readable output this wrapper parses
    // elsewhere (porcelain/plumbing formats are locale-independent already).
    LC_ALL: 'C',
  };

  let askpassDirectory: string | undefined;

  try {
    if (spec.credential) {
      askpassDirectory = await mkdtemp(path.join(tmpdir(), 'git-worker-askpass-'));
      const askpassPath = path.join(askpassDirectory, 'askpass.sh');
      await writeFile(askpassPath, ASKPASS_SCRIPT, { mode: 0o700 });
      environment.GIT_ASKPASS = askpassPath;
      environment.GIT_WORKER_ASKPASS_USERNAME = spec.credential.username;
      environment.GIT_WORKER_ASKPASS_TOKEN = spec.credential.token;
    }

    if (spec.identity) {
      environment.GIT_AUTHOR_NAME = spec.identity.name;
      environment.GIT_AUTHOR_EMAIL = spec.identity.email;
      environment.GIT_COMMITTER_NAME = spec.identity.name;
      environment.GIT_COMMITTER_EMAIL = spec.identity.email;
    }

    const { stdout, stderr } = await execFile('git', arguments_, {
      cwd,
      env: environment,
      timeout: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return { stdout, stderr };
  } catch (error) {
    const exitCode = hasNumericExitCode(error) ? error.code : null;
    const stderrText = hasStderrText(error) ? error.stderr : '';
    throw new GitProcessError(
      `git ${spec.command} failed${exitCode === null ? '' : ` (exit code ${exitCode})`}`,
      exitCode,
      classifyNetworkFailure(stderrText),
    );
  } finally {
    // Best-effort memory hygiene: drop every reference to the credential so it becomes eligible
    // for GC as soon as this call returns, and remove the ephemeral askpass helper so it never
    // outlives the single invocation it was created for.
    delete environment.GIT_WORKER_ASKPASS_USERNAME;
    delete environment.GIT_WORKER_ASKPASS_TOKEN;
    delete environment.GIT_AUTHOR_NAME;
    delete environment.GIT_AUTHOR_EMAIL;
    delete environment.GIT_COMMITTER_NAME;
    delete environment.GIT_COMMITTER_EMAIL;
    if (askpassDirectory) {
      await rm(askpassDirectory, { recursive: true, force: true });
    }
  }
}
