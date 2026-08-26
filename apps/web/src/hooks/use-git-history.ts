'use client';

/**
 * Loads the project's connected repository's commit history for the history panel. This is a
 * read-only display: a project with no connected git repository must resolve to an empty,
 * not-connected result, with no error surfaced.
 */
import { useCallback, useEffect, useState } from 'react';
import { getHistory } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { CommitDto } from '@asciidocollab/shared';

/** ApiError status codes that mean "this project has no connected git repository" — not a failure. */
const NOT_CONNECTED_STATUSES: ReadonlySet<number> = new Set([404]);

/** Options narrowing the loaded history to one file's commits and/or a maximum count. */
export interface UseGitHistoryOptions {
  /** Project-relative path to scope the history to a single file's commits. */
  path?: string;
  /** Maximum number of commits to load. */
  limit?: number;
  /**
   * Whether to actually fetch. Defaults to `true`. A caller that only shows history inside a
   * closed panel/dialog can pass `false` (for example, the panel's own `open` prop) so mounting
   * it never fires a request until it is actually shown.
   */
  enabled?: boolean;
}

/** The project's commit history and the load state, for the history panel. */
export interface UseGitHistory {
  /** The loaded commits, most recent first. Empty when not yet loaded or not connected. */
  commits: CommitDto[];
  /** True once the history has loaded and the project has a connected git repository. */
  connected: boolean;
  /** True while the history is loading. */
  loading: boolean;
  /**
   * A genuinely unexpected load failure. A project with no connected git repository (404) is NOT
   * an error — it simply resolves to `connected:false` and empty `commits` — so this stays null
   * in that case.
   */
  error: string | null;
  /** Reloads the history — for use after a commit/discard/amend changes it. */
  refetch: () => Promise<void>;
}

/** React hook returning the project's connected repository's commit history for the history panel. */
export function useGitHistory(projectId: string, options?: UseGitHistoryOptions): UseGitHistory {
  const [commits, setCommits] = useState<CommitDto[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const path = options?.path;
  const limit = options?.limit;
  const enabled = options?.enabled ?? true;

  const load = useCallback(async (active: () => boolean) => {
    if (!enabled) {
      if (active()) setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getHistory(projectId, { path, limit });
      if (active()) {
        setCommits(result.commits);
        setConnected(true);
      }
    } catch (error_) {
      if (!active()) return;
      setCommits([]);
      setConnected(false);
      if (error_ instanceof ApiError && NOT_CONNECTED_STATUSES.has(error_.status)) {
        // No connected git repository: not connected, not an error — the panel simply shows nothing.
      } else {
        setError('Failed to load git history.');
      }
    } finally {
      if (active()) {
        setLoading(false);
      }
    }
  }, [projectId, path, limit, enabled]);

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  const refetch = useCallback(() => load(() => true), [load]);

  return { commits, connected, loading, error, refetch };
}
