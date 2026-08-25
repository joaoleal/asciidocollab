import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCallback);

/**
 * Test-only helper: temporarily prepends a `git` shim to `PATH` that records every invocation's
 * full argument list (real `argv`, as the OS actually received it) to a log file before delegating
 * to the real `git` binary — a black-box way to assert on exactly what `runGitCommand` handed the
 * process, without mocking `node:child_process`.
 *
 * @param run - Callback given a function that reads back every recorded invocation's arguments
 *   (one array per call, in call order) once the callback resolves.
 * @returns Whatever `run` resolves to.
 */
export async function withArgvCapturingGit<T>(run: (getCalls: () => Promise<string[][]>) => Promise<T>): Promise<T> {
  const { stdout: realGitPath } = await execFile('sh', ['-c', 'command -v git']);
  const shimDirectory = await mkdtemp(path.join(tmpdir(), 'git-worker-argv-shim-'));
  const logFile = path.join(shimDirectory, 'calls.log');
  const shimPath = path.join(shimDirectory, 'git');

  const shimScript = [
    '#!/bin/sh',
    String.raw`printf '%s\t' "$@" >> "${logFile}"`,
    String.raw`printf '\n' >> "${logFile}"`,
    `exec "${realGitPath.trim()}" "$@"`,
    '',
  ].join('\n');
  await writeFile(shimPath, shimScript, { mode: 0o700 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDirectory}:${originalPath ?? ''}`;

  try {
    return await run(async () => {
      const content = await readFile(logFile, 'utf8').catch(() => '');
      return content
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => line.split('\t').filter((argument) => argument.length > 0));
    });
  } finally {
    process.env.PATH = originalPath;
    await rm(shimDirectory, { recursive: true, force: true });
  }
}
