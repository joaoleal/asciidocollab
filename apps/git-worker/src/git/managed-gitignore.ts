import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Internal path patterns the working tree must never track, regardless of any project-level
 * configuration: the Yjs collaborative-editing blob store (`.collab/`) and the suffix the
 * filesystem project file store uses for its atomic-write temp files (`*.tmp`). `.git/` itself
 * needs no entry — a `.gitignore` cannot (and does not need to) ignore the repository's own
 * metadata directory; every git operation already excludes it.
 */
export const MANAGED_GITIGNORE_ENTRIES: readonly string[] = ['.collab/', '*.tmp'];

const MANAGED_BEGIN = '# --- asciidocollab: managed rules (regenerated on every job, do not edit) ---';
const MANAGED_END = '# --- asciidocollab: end managed rules ---';
const USER_BEGIN = '# --- asciidocollab: project ignore patterns (maintainer-editable, owner-gated) ---';
const USER_END = '# --- asciidocollab: end project ignore patterns ---';

/**
 * Removes one delimited section (both marker lines and everything between them) from `content`,
 * if present. Used to strip a previous generation's managed/user block before rebuilding it, so
 * regeneration never duplicates or nests the markers.
 */
function stripSection(content: string, beginMarker: string, endMarker: string): string {
  const beginIndex = content.indexOf(beginMarker);
  if (beginIndex === -1) return content;
  const endIndex = content.indexOf(endMarker, beginIndex);
  if (endIndex === -1) return content;
  return content.slice(0, beginIndex) + content.slice(endIndex + endMarker.length);
}

/**
 * Builds the full contents of the working tree's managed `.gitignore`, merging three things:
 *
 * 1. The **managed section** — always exactly {@link MANAGED_GITIGNORE_ENTRIES}, rebuilt fresh
 *    every call. Never editable by a project member; any hand-edit inside its markers is
 *    discarded on the next regeneration.
 * 2. The **user section** — the project owner's current maintainer-editable patterns (as
 *    persisted on the project), rebuilt fresh from `userPatterns` every call.
 * 3. **Everything else** — any content in `existingContent` outside both marker blocks (for
 *    example a plain `.gitignore` that predates this mechanism, or lines a maintainer added
 *    outside the markers directly). Preserved byte-for-byte across regenerations.
 *
 * Calling this repeatedly — including with a prior call's own output as `existingContent` — is
 * idempotent for unchanged inputs and updates only the section whose input changed, which is what
 * makes regeneration safe to run before every job without clobbering unrelated content.
 *
 * @param existingContent - The working tree's current `.gitignore` contents, or null/empty if
 *   none exists yet.
 * @param userPatterns - The project's current maintainer-editable patterns (one per line), or
 *   null/empty when none are set.
 * @returns The full `.gitignore` contents to write.
 */
export function buildManagedGitignore(existingContent: string | null, userPatterns: string | null): string {
  const withoutManaged = stripSection(existingContent ?? '', MANAGED_BEGIN, MANAGED_END);
  const preserved = stripSection(withoutManaged, USER_BEGIN, USER_END).trim();

  const managedBlock = [MANAGED_BEGIN, ...MANAGED_GITIGNORE_ENTRIES, MANAGED_END].join('\n');

  const userLines = (userPatterns ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const userBlock = [USER_BEGIN, ...userLines, USER_END].join('\n');

  const sections = [managedBlock, userBlock];
  if (preserved.length > 0) sections.push(preserved);

  return sections.join('\n\n') + '\n';
}

/**
 * Writes (or refreshes) the managed `.gitignore` at the root of a project's working tree,
 * guaranteeing `.collab/` and the other internal entries are always ignored — so the worker can
 * never stage or commit them — while merging in the project's current maintainer-editable
 * patterns and preserving any other existing content (see {@link buildManagedGitignore}).
 *
 * @param cwd - The working tree to write into (see `resolveWorkingTreePath`).
 * @param userPatterns - The project's current maintainer-editable patterns, or null when none are
 *   set.
 */
export async function writeManagedGitignore(cwd: string, userPatterns: string | null): Promise<void> {
  const gitignorePath = path.join(cwd, '.gitignore');

  let existing: string | null = null;
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch (error: unknown) {
    if (!isEnoent(error)) throw error;
  }

  const content = buildManagedGitignore(existing, userPatterns);
  await writeFile(gitignorePath, content, 'utf8');
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && Reflect.get(error, 'code') === 'ENOENT';
}
