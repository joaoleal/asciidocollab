import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/** One scripted response: the invocations it claims, and what the fake `git` answers them with. */
export interface ScriptedGitBehavior {
  /**
   * Substring of the space-joined argument list that selects this behavior (for example
   * `'diff --cached --quiet'`). Must not contain a single quote. The FIRST matching behavior wins;
   * an invocation matching none is delegated to the real `git`.
   */
  readonly match: string;
  /** Exact bytes the fake writes to stdout. Defaults to nothing. */
  readonly stdout?: string;
  /** Exact bytes the fake writes to stderr — the text failure classification reads. Defaults to nothing. */
  readonly stderr?: string;
  /** Exit code the fake exits with. Defaults to 0. */
  readonly exitCode?: number;
}

/**
 * Test-only helper: temporarily prepends a `git` shim to `PATH` that answers the invocations
 * matching `behaviors` with scripted output/exit codes and delegates every other invocation to the
 * real `git` binary — the same PATH-shim technique `withArgvCapturingGit` uses, extended from
 * observing calls to answering them.
 *
 * It exists for the failure shapes a real repository cannot be coaxed into producing on demand: a
 * plumbing command exiting with an unexpected code, a remote that goes away mid-sequence, or
 * machine-readable output that is malformed. Everything under test — argument construction, the
 * `execFile` wrapper, stderr classification, and output parsing — remains the real implementation.
 *
 * @param behaviors - The scripted responses, in priority order.
 * @param run - Callback executed while the shim is on `PATH`.
 * @returns Whatever `run` resolves to.
 */
export async function withScriptedGit<T>(behaviors: readonly ScriptedGitBehavior[], run: () => Promise<T>): Promise<T> {
  const { stdout: realGitPath } = await execFile('sh', ['-c', 'command -v git']);
  const shimDirectory = await mkdtemp(path.join(tmpdir(), 'git-worker-scripted-git-'));
  const shimPath = path.join(shimDirectory, 'git');

  const caseArms: string[] = [];
  for (const [index, behavior] of behaviors.entries()) {
    if (behavior.match.includes("'")) throw new Error('A scripted git match cannot contain a single quote.');
    const stdoutFile = path.join(shimDirectory, `${index}.out`);
    const stderrFile = path.join(shimDirectory, `${index}.err`);
    await writeFile(stdoutFile, behavior.stdout ?? '');
    await writeFile(stderrFile, behavior.stderr ?? '');
    caseArms.push(
      `  *'${behavior.match}'*)`,
      `    cat "${stdoutFile}"`,
      `    cat "${stderrFile}" >&2`,
      `    exit ${behavior.exitCode ?? 0}`,
      '    ;;',
    );
  }

  const shimScript = ['#!/bin/sh', 'case " $* " in', ...caseArms, 'esac', `exec "${realGitPath.trim()}" "$@"`, ''].join(
    '\n',
  );
  await writeFile(shimPath, shimScript, { mode: 0o700 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDirectory}:${originalPath ?? ''}`;

  try {
    return await run();
  } finally {
    process.env.PATH = originalPath;
    await rm(shimDirectory, { recursive: true, force: true });
  }
}
