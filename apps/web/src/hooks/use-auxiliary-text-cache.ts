'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocumentContent } from '@/lib/api/file-content';
import { fetchProjectFileTree } from '@/lib/api/file-tree';
import { buildFilePathIndex } from '@/lib/codemirror/file-path-index';
import {
  createAuxiliaryTextCache,
  type AuxiliaryFileEntry,
} from '@/lib/pdf/auxiliary-text-cache';

/** The auxiliary text files a project's renders need, plus the signal to rebuild when they change. */
export interface ProjectAuxiliaryTextCache {
  /**
   * The theme / bibliography contents fetched so far, keyed by project-relative path. Read
   * synchronously while building a render snapshot.
   *
   * @returns A path→content map; a fresh object each call.
   */
  getAuxiliaryFiles: () => Record<string, string>;
  /** Increments whenever the held contents change, so a snapshot memo rebuilds to include them. */
  auxiliaryVersion: number;
}

/**
 * Keep a project's render-only text files (the PDF theme, the `.bib`) current.
 *
 * These files sit outside the `include::` graph the symbol index walks, so nothing else fetches them
 * or notices when a collaborator edits one. Seeded from the file tree and driven by the UNFILTERED
 * `content-changed` stream, this hook is what makes an export actually carry the project's theme —
 * see `lib/pdf/auxiliary-text-cache` for the defect it closes.
 *
 * @param projectId - The project whose auxiliary files are cached; the cache resets when it changes.
 * @param contentChangedNonce - Bumped by the layout for EVERY `content-changed` frame, unfiltered.
 * @param changedFileNodeId - The file node the most recent frame named, so only it is refetched.
 * @returns The {@link ProjectAuxiliaryTextCache} accessors.
 */
export function useProjectAuxiliaryTextCache(
  projectId: string,
  contentChangedNonce: number,
  changedFileNodeId: string | null,
): ProjectAuxiliaryTextCache {
  const cache = useRef(createAuxiliaryTextCache((fileNodeId) => getDocumentContent(projectId, fileNodeId)));
  const [auxiliaryVersion, setAuxiliaryVersion] = useState(0);

  // A project switch invalidates everything held: paths are project-relative, and a stale theme from
  // the previous project would otherwise be discovered and applied to this one's renders.
  useEffect(() => {
    cache.current = createAuxiliaryTextCache((fileNodeId) => getDocumentContent(projectId, fileNodeId));
    setAuxiliaryVersion((version) => version + 1);
  }, [projectId]);

  // Re-read the tree and refill on every content-changed frame. The frames are unfiltered on purpose:
  // the symbol index filters its own by include-reachability, and a theme is never reachable, so a
  // collaborator's theme edit would be invisible to any filtered subscription.
  useEffect(() => {
    let active = true;
    const target = cache.current;
    if (changedFileNodeId !== null) target.invalidate(changedFileNodeId);

    void (async () => {
      let entries: AuxiliaryFileEntry[];
      try {
        const { pathById } = buildFilePathIndex(await fetchProjectFileTree(projectId));
        entries = [...pathById].map(([fileNodeId, path]) => ({ fileNodeId, path }));
      } catch {
        // The tree is unreadable (offline, permissions). Keep whatever is already held rather than
        // dropping the theme mid-session; the next frame retries.
        return;
      }
      const changed = await target.sync(entries);
      // Only signal a rebuild while this cache is still the active one — a late resolve after a
      // project switch must not make the new project re-render against the old project's files.
      if (active && changed && cache.current === target) {
        setAuxiliaryVersion((version) => version + 1);
      }
    })();

    return () => {
      active = false;
    };
  }, [projectId, contentChangedNonce, changedFileNodeId]);

  const getAuxiliaryFiles = useCallback(() => cache.current.getFiles(), []);

  return { getAuxiliaryFiles, auxiliaryVersion };
}
