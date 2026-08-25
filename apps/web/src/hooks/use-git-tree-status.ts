'use client';

/**
 * Loads each file's git status (modified, staged, untracked, …) for the project's file tree, so the
 * tree can show a per-file badge. This is a read-only display enhancement, not core to the tree: a
 * project with no connected git repository must render its file tree exactly as before, with no
 * badges and no error surfaced.
 */
import { useCallback, useEffect, useState } from 'react';
import { getGitTreeStatus } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { FileGitStatus } from '@asciidocollab/shared';

/** ApiError status codes that mean "this project has no connected git repository" — not a failure. */
const NOT_CONNECTED_STATUSES: ReadonlySet<number> = new Set([404]);

/** The project's per-file git status map and the load state, for the file-tree badges. */
export interface UseGitTreeStatus {
  /** Git status per file, keyed by file node id. Empty when the project has no connected git repo. */
  statusByFileNodeId: Record<string, FileGitStatus>;
  /** True while the status map is loading. */
  loading: boolean;
  /**
   * A genuinely unexpected load failure. A project with no connected git repository (404) is NOT an
   * error — it simply resolves to an empty map — so this stays null in that case.
   */
  error: string | null;
  /** Reloads the status map — for use after a commit changes which files carry which status. */
  refetch: () => Promise<void>;
}

/** React hook returning the project's per-file git status map for the file-tree badges. */
export function useGitTreeStatus(projectId: string): UseGitTreeStatus {
  const [statusByFileNodeId, setStatusByFileNodeId] = useState<Record<string, FileGitStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (active: () => boolean) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getGitTreeStatus(projectId);
      if (active()) {
        setStatusByFileNodeId(result.statusByFileNodeId);
      }
    } catch (error_) {
      if (!active()) return;
      if (error_ instanceof ApiError && NOT_CONNECTED_STATUSES.has(error_.status)) {
        // No connected git repository: an empty map, not an error — badges simply don't appear.
        setStatusByFileNodeId({});
      } else {
        setStatusByFileNodeId({});
        setError('Failed to load git status.');
      }
    } finally {
      if (active()) {
        setLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  const refetch = useCallback(() => load(() => true), [load]);

  return { statusByFileNodeId, loading, error, refetch };
}
