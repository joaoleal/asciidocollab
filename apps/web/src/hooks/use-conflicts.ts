'use client';

/**
 * Orchestrates the editor's conflict-resolution panel: loads the project's currently conflicting
 * files (404 → not in conflict, not an error — same not-connected convention as `useBehindAhead`),
 * resolves one file at a time and refetches the list, and completes or undoes the paused pull —
 * mirroring `usePull`'s own-operation polling exactly, since `completePull`/`undoPull` return an
 * `{operationId}` for correlation even though the underlying work runs synchronously server-side.
 */
import { useCallback, useEffect, useState } from 'react';
import { describeCompleteFailure } from '@/components/git/conflict-panel';
import {
  completePull,
  getConflicts,
  getGitOperation,
  isGitOperationTerminal,
  resolveConflict,
  undoPull,
} from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { ConflictResolution, ConflictSummaryDto } from '@asciidocollab/shared';

/** How often a queued complete/undo operation's status is re-read while it is queued or running. */
const POLL_INTERVAL_MS = 1500;

/** ApiError status codes that mean "this project has no conflicts awaiting resolution" — not a failure. */
const NOT_CONNECTED_STATUSES: ReadonlySet<number> = new Set([404]);

/** A complete/undo attempt's settled, non-success outcome to show the user. */
export interface ConflictsMessage {
  /** An `error` tone renders as a destructive alert; a `neutral` tone (paused on conflicts) does not. */
  tone: 'neutral' | 'error';
  /** The message text. */
  text: string;
}

/** State and actions for the editor layout's conflict-resolution panel. */
export interface UseConflicts {
  /** Identifier of the awaiting operation the current conflicts belong to, or null when none. */
  operationId: string | null;
  /** Every currently conflicting file, from the list. Empty while not yet loaded (or on a load failure). */
  files: ConflictSummaryDto[];
  /** True while the conflict list is loading. */
  loading: boolean;
  /**
   * A genuinely unexpected load failure. A project with no conflicts awaiting resolution (404) is
   * NOT an error — it simply resolves to an empty file list — so this stays null in that case.
   */
  error: string | null;
  /** Whether every conflicting file has been resolved (false when there are no files at all). */
  allResolved: boolean;
  /**
   * Resolves one conflicting file, then refetches the list so `allResolved` reflects the change.
   *
   * @param path - The conflicting file's project-relative path.
   * @param resolution - How to resolve it.
   * @param mergedContent - The final merged text; only meaningful (and only sent) for `'merged'`.
   */
  resolve: (path: string, resolution: ConflictResolution, mergedContent?: string) => Promise<void>;
  /** Completes the paused pull, once every file is resolved; polls the queued operation to terminal. */
  complete: () => void;
  /** Abandons the paused pull, reverting the working tree; polls the queued operation to terminal. */
  undo: () => void;
  /** True while a complete/undo is starting or its operation is being polled. */
  completing: boolean;
  /** The outcome message from the most recent complete/undo attempt that did not simply succeed, or null. */
  message: ConflictsMessage | null;
  /** Reloads the conflict list — for use after an external change, such as a fresh pull pausing again. */
  refetch: () => Promise<void>;
}

/**
 * @param projectId - The project whose conflicts are being resolved.
 * @param onResolvedAndCleared - Called once `complete()` or `undo()` reaches `SUCCEEDED` — the caller
 * refetches the same cross-cutting git read models a pull does (tree status, git status,
 * behind-ahead), since either action changes the working tree exactly like a pull does.
 */
export function useConflicts(projectId: string, onResolvedAndCleared: () => void): UseConflicts {
  const [operationId, setOperationId] = useState<string | null>(null);
  const [files, setFiles] = useState<ConflictSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [completing, setCompleting] = useState(false);
  const [message, setMessage] = useState<ConflictsMessage | null>(null);
  const [pollOperationId, setPollOperationId] = useState<string | null>(null);

  const load = useCallback(
    async (active: () => boolean) => {
      setLoading(true);
      setError(null);
      try {
        const result = await getConflicts(projectId);
        if (!active()) return;
        // Defensive against a malformed/mismatched response body (e.g. in a test harness whose fetch
        // stub answers every endpoint the same way): an unexpected shape resolves to "nothing loaded"
        // rather than crashing the panel's render — same convention as `useBranches`.
        setOperationId(typeof result.operationId === 'string' ? result.operationId : null);
        setFiles(Array.isArray(result.files) ? result.files : []);
      } catch (error_) {
        if (!active()) return;
        setOperationId(null);
        setFiles([]);
        if (error_ instanceof ApiError && NOT_CONNECTED_STATUSES.has(error_.status)) {
          // No conflicts awaiting resolution: not an error — the panel simply has nothing to show.
        } else {
          setError('Failed to load conflicts.');
        }
      } finally {
        if (active()) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  const refetch = useCallback(() => load(() => true), [load]);

  const resolve = useCallback(
    async (path: string, resolution: ConflictResolution, mergedContent?: string) => {
      await resolveConflict(projectId, path, { resolution, mergedContent });
      await refetch();
    },
    [projectId, refetch],
  );

  const allResolved = files.length > 0 && files.every((file) => file.resolved);

  const complete = useCallback(() => {
    setMessage(null);
    setCompleting(true);
    completePull(projectId)
      .then((result) => {
        setPollOperationId(result.operationId);
      })
      .catch((caughtError: unknown) => {
        setCompleting(false);
        setMessage({ tone: 'error', text: describeCompleteFailure(caughtError) });
      });
  }, [projectId]);

  const undo = useCallback(() => {
    setMessage(null);
    setCompleting(true);
    undoPull(projectId)
      .then((result) => {
        setPollOperationId(result.operationId);
      })
      .catch((caughtError: unknown) => {
        setCompleting(false);
        setMessage({ tone: 'error', text: describeCompleteFailure(caughtError) });
      });
  }, [projectId]);

  // Polls the queued complete/undo operation, exactly like `usePull`, until it reaches a terminal
  // state OR `AWAITING_CONFLICT` — checked first here, same reason as the pull hook:
  // `isGitOperationTerminal` deliberately does not count it as terminal.
  useEffect(() => {
    if (!pollOperationId) return;
    const currentOperationId: string = pollOperationId;
    let active = true;

    async function tick() {
      try {
        const status = await getGitOperation(projectId, currentOperationId);
        if (!active) return;
        if (status.state === 'AWAITING_CONFLICT') {
          setPollOperationId(null);
          setCompleting(false);
          setMessage({ tone: 'neutral', text: 'Paused again — conflicts need resolving.' });
          return;
        }
        if (isGitOperationTerminal(status.state)) {
          setPollOperationId(null);
          setCompleting(false);
          if (status.state === 'SUCCEEDED') {
            void refetch();
            onResolvedAndCleared();
          } else {
            setMessage({
              tone: 'error',
              text: status.state === 'FAILED' ? 'The operation failed.' : 'The operation was aborted.',
            });
          }
        }
      } catch {
        // A transient poll failure doesn't end the operation — the next tick tries again.
      }
    }

    void tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pollOperationId, projectId, onResolvedAndCleared, refetch]);

  return {
    operationId,
    files,
    loading,
    error,
    allResolved,
    resolve,
    complete,
    undo,
    completing,
    message,
    refetch,
  };
}
