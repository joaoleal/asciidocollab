'use client';

/**
 * Polls whether the project currently has ANY whole-project git operation in flight — the
 * collaboration-facing "git activity" signal a member sees regardless of who triggered the
 * operation (another member, or the system). Derived entirely from the same `GitOperation` row the
 * progress-polling status read uses; this hook just reads it on an interval instead of once.
 *
 * Follows the same not-connected convention as {@link useGitStatus}: a project with no connected
 * git repository (404) resolves to `activeOperation: null`, not an error.
 */
import { useCallback, useEffect, useState } from 'react';
import { getActiveGitOperation } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { GitOperationStatusDto } from '@asciidocollab/shared';

/** How often the project's active operation is re-read while this hook is mounted. */
const POLL_INTERVAL_MS = 4000;

/** ApiError status codes that mean "this project has no connected git repository" — not a failure. */
const NOT_CONNECTED_STATUSES: ReadonlySet<number> = new Set([404]);

/** The project's currently active git operation, for the presence-style activity indicator. */
export interface UseGitActivity {
  /** The project's current active operation, or null when none is active (or not yet loaded). */
  activeOperation: GitOperationStatusDto | null;
  /**
   * A genuinely unexpected load failure. A project with no connected git repository (404) is NOT
   * an error — it simply resolves to `activeOperation: null` — so this stays null in that case.
   */
  error: string | null;
}

/** React hook polling the project's current whole-project git operation for the activity indicator. */
export function useGitActivity(projectId: string): UseGitActivity {
  const [activeOperation, setActiveOperation] = useState<GitOperationStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (active: () => boolean) => {
    try {
      const result = await getActiveGitOperation(projectId);
      if (!active()) return;
      setActiveOperation(result.operation);
      setError(null);
    } catch (error_) {
      if (!active()) return;
      if (error_ instanceof ApiError && NOT_CONNECTED_STATUSES.has(error_.status)) {
        // No connected git repository: not connected, not an error — no activity to show.
        setActiveOperation(null);
        setError(null);
      } else {
        setError('Failed to load git activity.');
      }
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void load(() => active);
    const timer = setInterval(() => void load(() => active), POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);

  return { activeOperation, error };
}
