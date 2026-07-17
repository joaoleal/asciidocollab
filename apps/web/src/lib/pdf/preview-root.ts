/**
 * Pure decision helpers for the live PDF preview's render root. The preview normally renders the
 * configured main document, but when the open file is OUTSIDE that document's include tree it is
 * previewed on its own (as if it were its own main document) so the panel shows what is being edited.
 * The export/download always stays rooted at the main document — these helpers drive only the on-screen
 * preview. They are extracted from the editor layout so the branchy root selection is unit-testable in
 * isolation (the layout only wires them to its live state).
 */

import { isPathInAssembledTree } from './scroll-sync-map';

/**
 * Whether the open file is OUTSIDE the configured main document's include tree: a main document is
 * configured, the open file is not that document, and it is not reached through its includes. False when
 * no main document is configured (the open file is then its own document, so there is no tree to be
 * outside of), when the open file IS the main document, or when the main's own content is not yet loaded
 * (reachability cannot be assembled — so we keep rooting at the main rather than flip to standalone).
 *
 * @param mainPath - The configured main document's path, or undefined when none is set.
 * @param openPath - The open file's path, or undefined when unresolved.
 * @param readFile - Reads a project file's content by path, or null when unavailable.
 * @returns True when the open file is outside the main document's tree.
 */
export function isOpenFileOutsideMainTree(
  mainPath: string | undefined,
  openPath: string | undefined,
  readFile: (path: string) => string | null,
): boolean {
  if (mainPath === undefined || openPath === undefined) return false;
  if (openPath === mainPath) return false;
  // Assembling the main's include tree needs the main's OWN content. When it is not yet loaded — e.g.
  // right after the project main file changed to a file this client has not fetched — we cannot tell
  // whether the open file is included, and must NOT flip the preview to standalone: that would drop the
  // open file's inherited cross-document attribute scope (its `{attr}` refs would render unresolved).
  // Treat it as in-tree until the main's content is available; keeping the preview rooted at the main is
  // also what drives that content to load, so reachability can then be resolved for real (without this,
  // a standalone preview never references the new main, so its content never loads — a deadlock).
  if (readFile(mainPath) === null) return false;
  return !isPathInAssembledTree(mainPath, readFile, openPath);
}

/** The live preview's resolved render root: the snapshot main path and the file id it corresponds to. */
export interface PreviewRoot {
  /** The snapshot's main-file path (null renders the open file on its own). */
  readonly mainPath: string | null;
  /** The file id the render root maps to, for resolving the root's attribute scope. */
  readonly rootFileId: string | null;
}

/**
 * Resolve the live preview's render root. When the open file is outside the main tree, the preview roots
 * at the open file itself (main path null → the snapshot builder falls back to the open path); otherwise
 * it mirrors the export root (the configured main document, or the open file when none is set).
 *
 * @param input - Whether the open file is outside the main tree, plus the main/open roots to choose from.
 * @returns The resolved preview render root.
 */
export function resolvePreviewRoot(input: {
  readonly outsideMainTree: boolean;
  readonly mainPath: string | null;
  readonly mainRootFileId: string | null;
  readonly openFileId: string | null;
}): PreviewRoot {
  return input.outsideMainTree
    ? { mainPath: null, rootFileId: input.openFileId }
    : { mainPath: input.mainPath, rootFileId: input.mainRootFileId };
}
