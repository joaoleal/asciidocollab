'use client';

/**
 * Loads the project's connected repository's working-tree status (branch, sync state, last-sync
 * time) for the git connection status bar. This is a read-only display: a project with no
 * connected git repository must render the bar as nothing, with no error surfaced.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getGitStatus } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { GitStatusDto } from '@asciidocollab/shared';

/** ApiError status codes that mean "this project has no connected git repository" — not a failure. */
const NOT_CONNECTED_STATUSES: ReadonlySet<number> = new Set([404]);

/**
 * Delay before retrying after a transient (non-404) load failure, matching the sibling
 * `useBehindAhead` poll cadence. Keeps retrying at this fixed spacing until a load succeeds, so the
 * status bar recovers on its own without a page reload.
 */
const RETRY_INTERVAL_MS = 4000;

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
  // Monotonic id of the most recently STARTED load. A slower older request that resolves after a
  // newer one has already started must not be allowed to overwrite the newer result.
  const requestSeq = useRef(0);
  // The pending transient-failure retry timer, if any. Tracked so a new load (a manual refetch, a
  // projectId change, or unmount) can cancel a stale retry before it fires.
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once a load has settled at least once. `loading` is surfaced only for the very first load
  // — a transient-failure retry refresh must not re-flash the spinner on anything gated on it.
  const hasLoadedOnce = useRef(false);
  // Whether the component is still mounted. Used as the active-checker for `refetch` and any retry
  // it schedules, so those loads stop touching state after unmount just like the effect's own loads
  // (whose `active` closes over the effect's cleanup). Set false in a top-level effect cleanup.
  const mounted = useRef(true);

  const clearRetryTimer = useCallback(() => {
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  const load = useCallback(async (active: () => boolean) => {
    const seq = ++requestSeq.current;
    // True only while this call is both the latest-started load AND the component/effect is still
    // active — an older in-flight request that resolves after a newer one started is stale.
    const isCurrent = () => active() && seq === requestSeq.current;
    clearRetryTimer();
    // Only the initial load shows `loading`; a transient-failure retry refresh keeps the current
    // value on screen while it re-reads, so the status bar never blinks.
    if (!hasLoadedOnce.current) {
      setLoading(true);
    }
    try {
      const result = await getGitStatus(projectId);
      if (isCurrent()) {
        setStatus(result);
        setConnected(true);
        setError(null);
      }
    } catch (error_) {
      if (!isCurrent()) return;
      if (error_ instanceof ApiError && NOT_CONNECTED_STATUSES.has(error_.status)) {
        // No connected git repository: definitively not connected, not an error — the bar simply
        // renders nothing. No retry: a 404 will keep 404-ing. A stale transient error from a prior
        // cycle must not linger now that this resolved cleanly.
        setStatus(null);
        setConnected(false);
        setError(null);
      } else {
        // A transient failure (network hiccup, 5xx). Leave `status`/`connected` exactly as they
        // were — a previously-connected bar stays connected rather than flashing to "not
        // connected" — surface the error, and schedule a retry so this recovers on its own.
        setError('Failed to load git status.');
        retryTimer.current = setTimeout(() => {
          void load(active);
        }, RETRY_INTERVAL_MS);
      }
    } finally {
      if (isCurrent()) {
        hasLoadedOnce.current = true;
        setLoading(false);
      }
    }
  }, [projectId, clearRetryTimer]);

  useEffect(() => {
    // A fresh project (changed `projectId`, so `load` is new) loads from scratch, so its first
    // fetch shows the spinner again rather than inheriting a prior "loaded".
    hasLoadedOnce.current = false;
    let active = true;
    void load(() => active);
    return () => {
      active = false;
      clearRetryTimer();
    };
  }, [load, clearRetryTimer]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refetch = useCallback(() => load(() => mounted.current), [load]);

  return { status, connected, loading, error, refetch };
}
