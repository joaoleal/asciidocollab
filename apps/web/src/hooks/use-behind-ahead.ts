'use client';

/**
 * Loads how far the project's connected repository's current branch stands from its remote
 * (ahead/behind commit counts) for the git connection status bar's "Pull available" affordance. This
 * is a read-only display: a project with no connected git repository must resolve to null counts,
 * with no error surfaced — the same not-connected convention as `useGitStatus`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBehindAhead } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { BehindAheadDto } from '@asciidocollab/shared';

/**
 * How often the counts are re-read while this hook is mounted. Matches `useGitActivity`'s cadence,
 * so the "Pull available" affordance surfaces on its own once the server's background remote fetch
 * has advanced the tracking ref — without a member first triggering a sync.
 */
const POLL_INTERVAL_MS = 4000;

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

/**
 * React hook returning the project's real ahead/behind commit counts for the status bar.
 *
 * @param projectId - The project whose counts to load.
 * @param enabled - Whether the project is git-connected. Defaults to `true`. When `false`, the hook
 *   does no polling at all (and resolves to null counts): a project with no connected repository
 *   would otherwise 404 on every poll forever. Callers pass their git-connected state here; when a
 *   project becomes connected later, flipping this to `true` starts the polling.
 */
export function useBehindAhead(projectId: string, enabled: boolean = true): UseBehindAhead {
  const [behindAhead, setBehindAhead] = useState<BehindAheadDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True once a load has settled at least once. `loading` is surfaced only for the very first load —
  // the every-4s background poll refreshes must not re-flash the spinner on anything gated on it.
  const hasLoadedOnce = useRef(false);
  // Monotonic id of the most recently STARTED load. A slower older request that resolves after a
  // newer one has already started must not be allowed to overwrite the newer result.
  const requestSeq = useRef(0);

  const load = useCallback(async (active: () => boolean) => {
    const seq = ++requestSeq.current;
    // True only while this call is both the latest-started load AND the component/effect is still
    // active — an older in-flight request that resolves after a newer one started is stale.
    const isCurrent = () => active() && seq === requestSeq.current;
    // Only the initial load shows `loading`; a background poll refresh keeps the current value on
    // screen while it re-reads, so the pull affordance never blinks.
    if (!hasLoadedOnce.current) {
      setLoading(true);
    }
    try {
      const result = await getBehindAhead(projectId);
      if (isCurrent()) {
        setBehindAhead(result);
        // A successful poll clears any error a prior failing cycle left visible.
        setError(null);
      }
    } catch (error_) {
      if (!isCurrent()) return;
      if (error_ instanceof ApiError && NOT_CONNECTED_STATUSES.has(error_.status)) {
        // No connected git repository: not connected, not an error — the bar simply shows nothing.
        setBehindAhead(null);
        setError(null);
      } else {
        // A transient failure (500/network hiccup). Intentionally leave the prior value untouched —
        // simply do NOT call the setter — so the Push/Pull affordance doesn't flicker away for a
        // cycle, and keep the last error visible (it isn't cleared-then-reset each poll) until a
        // poll succeeds. Only the initial load (no prior value yet) stays null.
        setError('Failed to load ahead/behind counts.');
      }
    } finally {
      if (isCurrent()) {
        hasLoadedOnce.current = true;
        setLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    // Gate polling on the project being git-connected. A not-connected project resolves to a clean
    // null state and starts NO interval, so it never fires the endless every-4s 404 a non-git
    // project used to. When it becomes connected later, `enabled` flips true and this effect re-runs
    // to begin polling.
    if (!enabled) {
      setBehindAhead(null);
      setError(null);
      setLoading(false);
      return;
    }
    // A fresh project (changed `projectId`, so `load` is new) or a just-connected one loads from
    // scratch, so its first fetch shows the spinner again rather than inheriting a prior "loaded".
    hasLoadedOnce.current = false;
    let active = true;
    void load(() => active);
    const timer = setInterval(() => void load(() => active), POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load, enabled]);

  const refetch = useCallback(() => load(() => true), [load]);

  return { behindAhead, loading, error, refetch };
}
