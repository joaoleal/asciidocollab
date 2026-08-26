import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { runGitCommand } from './run-git-command.js';

/**
 * Converts a megabyte ceiling into the byte count it represents, so every caller comparing a
 * measured size against `maxRepoSizeMB` uses the exact same conversion.
 *
 * @param maxRepoSizeMB - The configured maximum repository size, in megabytes.
 * @returns The equivalent byte ceiling.
 */
export function repoSizeCeilingBytes(maxRepoSizeMB: number): number {
  return maxRepoSizeMB * 1024 * 1024;
}

/**
 * Reports whether a measured byte total exceeds the configured megabyte ceiling. Pure — no
 * filesystem or `git` access — so it can be unit-tested directly against synthetic sizes. Shared by
 * both `RealGitCommandRunner.clone`'s post-clone size check and `materializeEntries`'s running-total
 * cap, so the two enforce exactly one limit.
 *
 * @param totalBytes - The measured size, in bytes.
 * @param maxRepoSizeMB - The configured maximum repository size, in megabytes.
 * @returns True if `totalBytes` exceeds the ceiling `maxRepoSizeMB` represents.
 */
export function repoSizeExceedsLimit(totalBytes: number, maxRepoSizeMB: number): boolean {
  return totalBytes > repoSizeCeilingBytes(maxRepoSizeMB);
}

/**
 * Sums the on-disk byte size of every file `git ls-files` reports as tracked in `workingDirectory`,
 * without reading any file's contents — used to check a freshly cloned working tree's total size
 * BEFORE `materializeEntries` reads every one of those same files' full bytes into memory.
 *
 * Measures the checked-out working tree itself (not `.git`'s internal object store), so a `git lfs
 * pull` that already ran for this clone has its smudged, real-sized files counted — an LFS object's
 * bytes never land in git's own object database, only in the working tree and `.git/lfs`.
 *
 * @param workingDirectory - The clone's working tree root.
 * @returns The summed byte size of every tracked, readable file.
 */
export async function measureWorkingTreeSizeBytes(workingDirectory: string): Promise<number> {
  const { stdout } = await runGitCommand(workingDirectory, { command: 'ls-files', flags: ['-z'] });
  const relativePaths = stdout.split('\0').filter((entry) => entry.length > 0);

  let totalBytes = 0;
  for (const relativePath of relativePaths) {
    const stats = await lstat(path.join(workingDirectory, relativePath)).catch(() => null);
    if (stats && stats.isFile()) totalBytes += stats.size;
  }
  return totalBytes;
}
