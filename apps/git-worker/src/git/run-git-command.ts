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
 * Deliberately carries no raw stdout/stderr or argv — only a fixed, safe message plus the exit
 * code — so a caller may wrap it directly into a domain error without further scrubbing.
 */
export class GitProcessError extends Error {
  /**
   * @param message - A safe, human-readable description of the failure.
   * @param exitCode - The process's exit code, or null if it could not be determined (for
   *   example, the `git` binary itself could not be spawned).
   */
  constructor(
    message: string,
    readonly exitCode: number | null,
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

    const { stdout, stderr } = await execFile('git', arguments_, {
      cwd,
      env: environment,
      timeout: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return { stdout, stderr };
  } catch (error) {
    const exitCode = hasNumericExitCode(error) ? error.code : null;
    throw new GitProcessError(
      `git ${spec.command} failed${exitCode === null ? '' : ` (exit code ${exitCode})`}`,
      exitCode,
    );
  } finally {
    // Best-effort memory hygiene: drop every reference to the credential so it becomes eligible
    // for GC as soon as this call returns, and remove the ephemeral askpass helper so it never
    // outlives the single invocation it was created for.
    delete environment.GIT_WORKER_ASKPASS_USERNAME;
    delete environment.GIT_WORKER_ASKPASS_TOKEN;
    if (askpassDirectory) {
      await rm(askpassDirectory, { recursive: true, force: true });
    }
  }
}
