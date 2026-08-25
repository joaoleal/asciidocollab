'use client';

/**
 * Loads how far the project's connected repository's current branch stands from its remote
 * (ahead/behind commit counts) for the git connection status bar's "Pull available" affordance. This
 * is a read-only display: a project with no connected git repository must resolve to null counts,
 * with no error surfaced — the same not-connected convention as `useGitStatus`.
 */
import { useCallback, useEffect, useState } from 'react';
import { getBehindAhead } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { BehindAheadDto } from '@asciidocollab/shared';

/** ApiError status codes that mean "this project has no connected git repository" — not a failure. */
const NOT_CONNECTED_STATUSES: ReadonlySet<number> = new Set([404]);

/** The project's ahead/behind counts and the load state, for the status bar's pull affordance. */
export interface UseBehindAhead {
  /** The connected repository's ahead/behind counts, or null when not connected (or not yet loaded). */
  behindAhead: BehindAheadDto | null;
  /** True while the counts are loading. */
  loading: boolean;
  /**
   * A genuinely unexpected load failure. A project with no connected git repository (404) is NOT
   * an error — it simply resolves to `behindAhead:null` — so this stays null in that case.
   */
  error: string | null;
  /** Reloads the counts — for use after a pull (or a commit/push) changes them. */
  refetch: () => Promise<void>;
}

/** React hook returning the project's real ahead/behind commit counts for the status bar. */
export function useBehindAhead(projectId: string): UseBehindAhead {
  const [behindAhead, setBehindAhead] = useState<BehindAheadDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (active: () => boolean) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getBehindAhead(projectId);
      if (active()) {
        setBehindAhead(result);
      }
    } catch (error_) {
      if (!active()) return;
      setBehindAhead(null);
      if (error_ instanceof ApiError && NOT_CONNECTED_STATUSES.has(error_.status)) {
        // No connected git repository: not connected, not an error — the bar simply shows nothing.
      } else {
        setError('Failed to load ahead/behind counts.');
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

  return { behindAhead, loading, error, refetch };
}
