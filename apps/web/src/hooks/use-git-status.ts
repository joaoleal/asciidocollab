'use client';

/**
 * Loads the project's connected repository's working-tree status (branch, sync state, last-sync
 * time) for the git connection status bar. This is a read-only display: a project with no
 * connected git repository must render the bar as nothing, with no error surfaced.
 */
import { useCallback, useEffect, useState } from 'react';
import { getGitStatus } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { GitStatusDto } from '@asciidocollab/shared';

/** ApiError status codes that mean "this project has no connected git repository" — not a failure. */
const NOT_CONNECTED_STATUSES: ReadonlySet<number> = new Set([404]);

/** The project's git status and the load state, for the connection status bar. */
export interface UseGitStatus {
  /** The connected repository's status, or null when not connected (or not yet loaded). */
  status: GitStatusDto | null;
  /** True once the status has loaded and the project has a connected git repository. */
  connected: boolean;
  /** True while the status is loading. */
  loading: boolean;
  /**
   * A genuinely unexpected load failure. A project with no connected git repository (404) is NOT
   * an error — it simply resolves to `connected:false` — so this stays null in that case.
   */
  error: string | null;
  /** Reloads the status — for use after a commit changes branch/sync state. */
  refetch: () => Promise<void>;
}

/** React hook returning the project's connected git repository status for the status bar. */
export function useGitStatus(projectId: string): UseGitStatus {
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (active: () => boolean) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getGitStatus(projectId);
      if (active()) {
        setStatus(result);
        setConnected(true);
      }
    } catch (error_) {
      if (!active()) return;
      setStatus(null);
      setConnected(false);
      if (error_ instanceof ApiError && NOT_CONNECTED_STATUSES.has(error_.status)) {
        // No connected git repository: not connected, not an error — the bar simply renders nothing.
      } else {
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

  return { status, connected, loading, error, refetch };
}
