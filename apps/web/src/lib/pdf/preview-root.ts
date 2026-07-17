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
 * outside of) or when the open file IS the main document.
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
