import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { declaresLfsFilter } from './lfs-pointer.js';

const MANAGED_BEGIN = '# --- asciidocollab: managed lfs patterns (regenerated on every job, do not edit) ---';
const MANAGED_END = '# --- asciidocollab: end managed lfs patterns ---';

/** The exact attribute suffix appended to every managed LFS pattern line. */
const LFS_ATTRIBUTES = 'filter=lfs diff=lfs merge=lfs -text';

/**
 * Removes one delimited section (both marker lines and everything between them) from `content`, if
 * present — mirrors `managed-gitignore.ts`'s own `stripSection`.
 */
function stripSection(content: string, beginMarker: string, endMarker: string): string {
  const beginIndex = content.indexOf(beginMarker);
  if (beginIndex === -1) return content;
  const endIndex = content.indexOf(endMarker, beginIndex);
  if (endIndex === -1) return content;
  return content.slice(0, beginIndex) + content.slice(endIndex + endMarker.length);
}

/**
 * Reads the path patterns already declared inside a previous managed block, so regenerating it
 * never forgets a pattern tracked by an earlier call — unlike the managed `.gitignore`'s fixed,
 * always-rebuilt-from-a-constant entry list, the set of LFS-tracked patterns grows over a project's
 * lifetime as different large files are staged.
 */
function extractManagedPatterns(content: string): string[] {
  const beginIndex = content.indexOf(MANAGED_BEGIN);
  if (beginIndex === -1) return [];
  const endIndex = content.indexOf(MANAGED_END, beginIndex);
  if (endIndex === -1) return [];

  return content
    .slice(beginIndex + MANAGED_BEGIN.length, endIndex)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(' ')[0])
    .filter((pattern) => pattern.length > 0);
}

/**
 * Builds the full contents of the working tree's managed `.gitattributes`, merging:
 *
 * 1. The **managed section** — every pattern this mechanism has ever tracked (every pattern already
 *    present in a prior managed block, plus any new ones passed in `patterns`), each rendered as
 *    `<pattern> filter=lfs diff=lfs merge=lfs -text`. A pattern already present is never duplicated.
 * 2. **Everything else** — any content in `existingContent` outside the managed block (a
 *    maintainer-authored `.gitattributes` that predates this mechanism, or lines added directly
 *    outside the markers). Preserved byte-for-byte across regenerations.
 *
 * Calling this repeatedly — including with a prior call's own output as `existingContent` and an
 * empty `patterns` list — is idempotent: the managed block is rebuilt from the same merged pattern
 * set and comes out identical.
 *
 * @param existingContent - The working tree's current `.gitattributes` contents, or null/empty if
 *   none exists yet.
 * @param patterns - The path patterns to ensure are LFS-tracked (in addition to any already tracked
 *   by a prior managed block).
 * @returns The full `.gitattributes` contents to write.
 */
export function buildManagedGitattributes(existingContent: string | null, patterns: readonly string[]): string {
  const content = existingContent ?? '';
  const existingPatterns = extractManagedPatterns(content);
  const preserved = stripSection(content, MANAGED_BEGIN, MANAGED_END).trim();

  const mergedPatterns = [...existingPatterns];
  for (const pattern of patterns) {
    if (!mergedPatterns.includes(pattern)) mergedPatterns.push(pattern);
  }

  const managedBlock = [
    MANAGED_BEGIN,
    ...mergedPatterns.map((pattern) => `${pattern} ${LFS_ATTRIBUTES}`),
    MANAGED_END,
  ].join('\n');

  const sections = [managedBlock];
  if (preserved.length > 0) sections.push(preserved);

  return sections.join('\n\n') + '\n';
}

/**
 * Writes (or refreshes) the managed `.gitattributes` at the root of a project's working tree,
 * ensuring every pattern in `patterns` (plus every pattern a prior call already tracked) is declared
 * `filter=lfs diff=lfs merge=lfs -text`, while preserving any other existing content (see
 * {@link buildManagedGitattributes}). Pure filesystem I/O — never invokes `git` or `git-lfs` itself.
 *
 * @param cwd - The working tree to write into.
 * @param patterns - The path patterns to ensure are LFS-tracked.
 */
export async function writeManagedGitattributes(cwd: string, patterns: readonly string[]): Promise<void> {
  const gitattributesPath = path.join(cwd, '.gitattributes');

  let existing: string | null = null;
  try {
    existing = await readFile(gitattributesPath, 'utf8');
  } catch (error: unknown) {
    if (!isEnoent(error)) throw error;
  }

  const content = buildManagedGitattributes(existing, patterns);
  await writeFile(gitattributesPath, content, 'utf8');
}

/**
 * Reports whether `.gitattributes` content already declares `relativePath` itself `filter=lfs` — as
 * opposed to {@link declaresLfsFilter}, which only reports whether ANY path is declared, this checks
 * the one path a caller is about to stage, so a large file whose specific pattern is not yet tracked
 * is not skipped just because some other pattern already uses LFS.
 *
 * @param gitattributesContent - The working tree's current `.gitattributes` contents, or an empty
 *   string when it has none.
 * @param relativePath - The exact workspace-relative path to check.
 * @returns True if a line for exactly this path already declares `filter=lfs`.
 */
export function isPathAlreadyLfsTracked(gitattributesContent: string, relativePath: string): boolean {
  return gitattributesContent
    .split('\n')
    .some((line) => line.trim().startsWith(`${relativePath} `) && declaresLfsFilter(line));
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && Reflect.get(error, 'code') === 'ENOENT';
}
