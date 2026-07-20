/**
 * @file A cache for the project text files the render pipeline needs but the include graph can never
 * reach — the PDF theme and the bibliography source.
 *
 * The symbol index's content cache is populated by walking `include::` from the main file. That is
 * the right reachability rule for the editor, and the wrong one for rendering: a theme is referenced
 * by the `:pdf-theme:` ATTRIBUTE, and a `.bib` by `:bibtex-file:`, so neither is ever an include
 * target. Two consequences followed, and both were live defects:
 *
 *  1. On a fresh page load the theme's content was absent from the cache. Theme DISCOVERY filters
 *     paths derived from that same map, so the theme's path was invisible regardless of its content
 *     and the export silently rendered unthemed.
 *  2. A collaborator's theme edits never invalidated anything, because the `content-changed` handler
 *     filters frames by reachability — and a theme is never reachable.
 *
 * So this cache is seeded from the FILE TREE rather than from include reachability, and is driven by
 * the UNFILTERED `content-changed` stream. It is deliberately React-free and injects its fetch, so
 * the whole of it is unit-testable; the layout owns the wiring.
 */

import { isThemeFilePath } from '@asciidocollab/shared';

/** The bibliography-source extension, the other text file no `include::` ever reaches. */
const BIBTEX_EXTENSION = '.bib';

/** A candidate auxiliary file, as the project's file tree describes it. */
export interface AuxiliaryFileEntry {
  /** The file's project-relative path — the key the render snapshot needs it under. */
  readonly path: string;
  /** The file node id content is fetched by. Stable across a rename, unlike the path. */
  readonly fileNodeId: string;
}

/** Fetch one file's text by node id. Rejecting (or resolving null) means "unavailable, skip it". */
export type FetchAuxiliaryText = (fileNodeId: string) => Promise<string | null>;

/** The auxiliary text files a project's renders need, kept current outside the include graph. */
export interface AuxiliaryTextCache {
  /**
   * The auxiliary files fetched so far, keyed by project-relative path, ready to merge into a render
   * snapshot. Read synchronously while building one.
   *
   * @returns A path→content map; a fresh object each call.
   */
  getFiles: () => Record<string, string>;
  /**
   * Reconcile against the project's current file tree: fetch the auxiliary files not held yet, and
   * forget those that have left the tree. Non-auxiliary entries are ignored.
   *
   * @param entries - Every file in the project tree.
   * @returns Whether the held contents changed, so a caller can rebuild only when it must.
   */
  sync: (entries: readonly AuxiliaryFileEntry[]) => Promise<boolean>;
  /**
   * Forget a file's cached content so the next {@link sync} refetches it. Called for every
   * `content-changed` frame — including files this cache does not hold, which is why it reports
   * whether anything was actually dropped.
   *
   * @param fileNodeId - The file node whose content changed.
   * @returns Whether a cached entry was dropped.
   */
  invalidate: (fileNodeId: string) => boolean;
}

/**
 * Whether a project file is one the render pipeline needs but `include::` resolution never reaches.
 *
 * @param path - A project-relative file path.
 * @returns `true` for a PDF theme or a bibliography source.
 */
export function isAuxiliaryTextPath(path: string): boolean {
  return isThemeFilePath(path) || path.toLowerCase().endsWith(BIBTEX_EXTENSION);
}

/**
 * Create the auxiliary text cache for one project.
 *
 * @param fetchContent - Fetches a file's text by node id.
 * @returns The {@link AuxiliaryTextCache} accessors.
 */
export function createAuxiliaryTextCache(fetchContent: FetchAuxiliaryText): AuxiliaryTextCache {
  /** Fetched content by file node id. Keyed by id, not path, so a rename is not a cache miss. */
  const contentById = new Map<string, string>();
  /** The project-relative path each held file currently sits at. */
  const pathById = new Map<string, string>();
  /** In-flight fetches, so concurrent syncs of the same file share one request. */
  const inFlight = new Map<string, Promise<string | null>>();
  /** Files held but known to be out of date, so the next sync refetches them. */
  const stale = new Set<string>();
  /**
   * How many times each file has been invalidated.
   *
   * A fetch records the count it started at and discards its result if the count has moved on. That
   * is what makes an edit DURING a fetch safe: the reply in flight describes the version before the
   * edit, and without this it would be written to the cache as though it were current — and never
   * corrected, because the file would then look present and fresh to every later sync.
   */
  const invalidations = new Map<string, number>();

  const invalidationsOf = (fileNodeId: string): number => invalidations.get(fileNodeId) ?? 0;

  function fetchOnce(fileNodeId: string): Promise<string | null> {
    const existing = inFlight.get(fileNodeId);
    if (existing !== undefined) return existing;
    const startedAt = invalidationsOf(fileNodeId);
    // An unavailable auxiliary file must not fail the render: the document still has to export, just
    // without its theme. Swallow to null here and let the caller's discovery fall back.
    const pending: Promise<string | null> = fetchContent(fileNodeId)
      .catch(() => null)
      .then((content) => (invalidationsOf(fileNodeId) === startedAt ? content : null))
      .finally(() => {
        // Only if it is still OURS: `invalidate` drops the entry to force a fresh request, and a
        // late resolve must not remove the newer one that replaced it.
        if (inFlight.get(fileNodeId) === pending) inFlight.delete(fileNodeId);
      });
    inFlight.set(fileNodeId, pending);
    return pending;
  }

  return {
    getFiles(): Record<string, string> {
      const files: Record<string, string> = {};
      for (const [fileNodeId, content] of contentById) {
        const path = pathById.get(fileNodeId);
        if (path !== undefined) files[path] = content;
      }
      return files;
    },

    async sync(entries: readonly AuxiliaryFileEntry[]): Promise<boolean> {
      const auxiliary = entries.filter((entry) => isAuxiliaryTextPath(entry.path));
      const present = new Set(auxiliary.map((entry) => entry.fileNodeId));

      let changed = false;
      // Deleting the current entry mid-iteration is well-defined for a Map, so no copy is needed.
      for (const fileNodeId of contentById.keys()) {
        if (present.has(fileNodeId)) continue;
        contentById.delete(fileNodeId);
        pathById.delete(fileNodeId);
        // Nothing is held for it any more, so it cannot be "held but out of date".
        stale.delete(fileNodeId);
        changed = true;
      }

      for (const entry of auxiliary) {
        if (pathById.get(entry.fileNodeId) !== entry.path) {
          pathById.set(entry.fileNodeId, entry.path);
          // A file already held that merely moved still changes the snapshot: its content now has to
          // appear under the new path, and discovery keys off the path.
          if (contentById.has(entry.fileNodeId)) changed = true;
        }
      }

      const fetched = await Promise.all(
        auxiliary
          .filter((entry) => !contentById.has(entry.fileNodeId) || stale.has(entry.fileNodeId))
          .map(async (entry) => ({ entry, content: await fetchOnce(entry.fileNodeId) })),
      );
      for (const { entry, content } of fetched) {
        // A null is a failed or superseded fetch. The previously held copy is KEPT and left marked
        // stale, so the next sync tries again — dropping it would swap a slightly old theme for no
        // theme at all, which renders the document unstyled rather than nearly right.
        if (content === null) continue;
        contentById.set(entry.fileNodeId, content);
        stale.delete(entry.fileNodeId);
        changed = true;
      }

      return changed;
    },

    invalidate(fileNodeId: string): boolean {
      // Counted BEFORE anything else, so a fetch already in flight sees the change and throws its
      // (now previous-version) reply away instead of installing it as current.
      invalidations.set(fileNodeId, invalidationsOf(fileNodeId) + 1);
      // Dropped so the next sync issues a fresh request rather than joining the superseded one.
      inFlight.delete(fileNodeId);
      if (!contentById.has(fileNodeId)) return false;
      // The held copy is MARKED, not deleted. Deleting it opens a window — between this call and the
      // refetch landing — in which the file is simply absent, and an export started in that window
      // renders with no theme at all. One version behind for a moment is the lesser wrong.
      stale.add(fileNodeId);
      return true;
    },
  };
}
