'use client';

/**
 * Orchestrates the editor's conflict-resolution panel: loads the project's currently conflicting
 * files (404 → not in conflict, not an error — same not-connected convention as `useBehindAhead`),
 * resolves one file at a time and refetches the list, and completes or undoes the paused pull —
 * mirroring `usePull`'s own-operation polling exactly, since `completePull`/`undoPull` return an
 * `{operationId}` for correlation even though the underlying work runs synchronously server-side.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { describeDrift } from '@/lib/git/describe-drift';
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

/** Options gating when the conflict list is actually fetched. */
export interface UseConflictsOptions {
  /**
   * Whether to actually fetch. Defaults to `true`. The editor layout mounts this hook
   * unconditionally, long before any pull has paused, so the panel passes its own `open` state here:
   * the list then loads when the panel is SHOWN — and reloads on every re-open — rather than once at
   * mount, when a healthy repository's `getConflicts` 404s and settles the list to empty for good.
   * Same convention (and same reason) as `useGitHistory`'s `enabled`.
   */
  enabled?: boolean;
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
 * @param onResolvedAndCleared - Called once `complete()` or `undo()` reaches a terminal state (a
 * completion's `SUCCEEDED`, or an undo's ABORTED/SUCCEEDED, both a success here) — the caller
 * refetches the same cross-cutting git read models a pull does (tree status, git status,
 * behind-ahead), since either action changes the working tree exactly like a pull does.
 * @param options - Optional {@link UseConflictsOptions}; `enabled` gates the list load on the
 * panel's own open state.
 */
export function useConflicts(
  projectId: string,
  onResolvedAndCleared: () => void,
  options?: UseConflictsOptions,
): UseConflicts {
  const [operationId, setOperationId] = useState<string | null>(null);
  const [files, setFiles] = useState<ConflictSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [completing, setCompleting] = useState(false);
  const [message, setMessage] = useState<ConflictsMessage | null>(null);
  const [pollOperationId, setPollOperationId] = useState<string | null>(null);
  // Which of `complete()`/`undo()` queued the operation currently being polled — the poll effect
  // below is shared by both (same shape, same terminal states), but the two settle DIFFERENTLY: an
  // `undo()` abandons the paused pull (undo-pull Case A), so its op reaches a terminal ABORTED that
  // is nonetheless a SUCCESSFUL undo — cleared quietly, with no message — whereas a `complete()`
  // resolves the conflict and reads its own `driftSummary`, surfacing a retry message on a drift-
  // carrying success and an error on a terminal FAILED/ABORTED. Reset to null wherever the poll
  // settles (AWAITING_CONFLICT or a terminal state), alongside clearing `pollOperationId`, so a stale
  // value from THIS operation can never route a LATER one down the wrong path.
  const [pendingAction, setPendingAction] = useState<'complete' | 'undo' | null>(null);

  const enabled = options?.enabled ?? true;

  // Guards the conflict-list loader against an older `load`/`refetch` call's response resolving
  // after a newer one's — only the latest-started call is allowed to write state.
  const loadSeq = useRef(0);

  const load = useCallback(
    async (active: () => boolean) => {
      const seq = ++loadSeq.current;
      const isCurrent = () => active() && seq === loadSeq.current;
      // Nothing is showing the list yet: don't fetch, and don't leave the panel stuck in `loading`
      // for the whole time it stays closed — same shape as `useGitHistory`'s disabled load.
      if (!enabled) {
        if (isCurrent()) setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await getConflicts(projectId);
        if (!isCurrent()) return;
        // Defensive against a malformed/mismatched response body (e.g. in a test harness whose fetch
        // stub answers every endpoint the same way): an unexpected shape resolves to "nothing loaded"
        // rather than crashing the panel's render — same convention as `useBranches`.
        setOperationId(typeof result.operationId === 'string' ? result.operationId : null);
        setFiles(Array.isArray(result.files) ? result.files : []);
      } catch (error_) {
        if (!isCurrent()) return;
        setOperationId(null);
        setFiles([]);
        if (error_ instanceof ApiError && NOT_CONNECTED_STATUSES.has(error_.status)) {
          // No conflicts awaiting resolution: not an error — the panel simply has nothing to show.
        } else {
          setError('Failed to load conflicts.');
        }
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [projectId, enabled],
  );

  // Re-runs whenever `enabled` flips, so opening the panel loads the CURRENT conflict list — the
  // mount-time load of a then-healthy repository is never the one the panel ends up showing.
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
    setPendingAction('complete');
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
    setPendingAction('undo');
    undoPull(projectId)
      .then((result) => {
        setPollOperationId(result.operationId);
      })
      .catch((caughtError: unknown) => {
        setCompleting(false);
        setMessage({ tone: 'error', text: describeCompleteFailure(caughtError) });
      });
  }, [projectId]);

  // Guards the complete/undo operation poll against an older tick's response resolving after a
  // newer tick's, which can happen when a poll takes longer than `POLL_INTERVAL_MS` to settle.
  const pollSeq = useRef(0);

  // Polls the queued complete/undo operation, exactly like `usePull`, until it reaches a terminal
  // state OR `AWAITING_CONFLICT` — checked first here, same reason as the pull hook:
  // `isGitOperationTerminal` deliberately does not count it as terminal.
  useEffect(() => {
    if (!pollOperationId) return;
    const currentOperationId: string = pollOperationId;
    let active = true;

    async function tick() {
      const seq = ++pollSeq.current;
      const isCurrent = () => active && seq === pollSeq.current;
      try {
        const status = await getGitOperation(projectId, currentOperationId);
        if (!isCurrent()) return;
        if (status.state === 'AWAITING_CONFLICT') {
          setPollOperationId(null);
          // The poll has settled: clear which action queued it so a STALE value can never describe a
          // later complete()/undo() with the wrong wording (see the terminal branch below for why).
          setPendingAction(null);
          setCompleting(false);
          setMessage({ tone: 'neutral', text: 'Paused again — conflicts need resolving.' });
          return;
        }
        if (isGitOperationTerminal(status.state)) {
          setPollOperationId(null);
          setCompleting(false);
          if (pendingAction === 'undo') {
            // A conflict-panel undo goes through undo-pull Case A: the awaiting op is ABANDONED, so it
            // settles into a terminal ABORTED (or SUCCEEDED) — either is a SUCCESSFUL user-initiated
            // undo, never an error. Refresh the read models and clear the panel exactly as a
            // completion does, and surface NO message: the undo route reverts synchronously and the
            // terminal op carries none of the undo's OWN drift to report (only the abandoned pull's),
            // so there is nothing honest to show.
            void refetch();
            onResolvedAndCleared();
          } else if (status.state === 'SUCCEEDED') {
            void refetch();
            onResolvedAndCleared();
            // A completion (complete()) resolved the conflict by applying a merge and took a real
            // commit, so its own `driftSummary` IS the completion's reconcile drift — a drop that can
            // genuinely be re-applied once the obstruction clears, so its message names the
            // obstruction and the retry.
            const driftMessage = describeDrift(status.driftSummary, 'Conflicts resolved', 'try the operation again');
            if (driftMessage) setMessage({ tone: 'neutral', text: driftMessage });
          } else {
            // A completion that terminally FAILED/ABORTED never resolved anything — surface the failure.
            setMessage({
              tone: 'error',
              text: status.state === 'FAILED' ? 'The operation failed.' : 'The operation was aborted.',
            });
          }
          // The poll has settled (terminal): clear which action queued it, once the branch above has
          // already read it, so a STALE value can never route a LATER complete()/undo() call down this
          // one's path — `pendingAction` is otherwise never reset by complete()/undo() itself.
          setPendingAction(null);
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
  }, [pollOperationId, projectId, onResolvedAndCleared, refetch, pendingAction]);

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
