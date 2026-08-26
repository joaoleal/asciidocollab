'use client';

/**
 * Orchestrates starting a pull from the editor and polling it to completion, for the project editor
 * layout: `start()` attempts the pull immediately; a `409 open_files_need_confirm` refusal opens the
 * confirm dialog instead of surfacing an error, and any other refusal becomes an error message.
 * `openPreview()` opens that same dialog up front, before any pull is attempted, so the status bar's
 * normal pull entry can show the dry-run preview first too — same dialog either way, since it fetches
 * its own preview and "Pull anyway" always performs the actual pull.
 * Success queues the operation for polling, on the same interval/shape as the import dialog's
 * polling loop, with one added stop condition: `AWAITING_CONFLICT` halts polling just like a
 * terminal state (see {@link isGitOperationTerminal}, which does not include it) and surfaces as a
 * neutral "paused" outcome rather than an error, since resolving conflicts is a separate flow.
 */
import { useCallback, useEffect, useState } from 'react';
import { describePullFailure } from '@/components/git/pull-dialog';
import { getGitOperation, isGitOperationTerminal, startPull, type StartPullResult } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';

/** How often the pull operation's status is re-read while it is queued or running. */
const POLL_INTERVAL_MS = 1500;

/** A pull's settled, non-success outcome to show the user. */
export interface PullMessage {
  /** An `error` tone renders as a destructive alert; a `neutral` tone (paused on conflicts) does not. */
  tone: 'neutral' | 'error';
  /** The message text. */
  text: string;
}

/** State and actions for the editor layout's pull affordance. */
export interface UsePull {
  /** Whether the open-files confirm dialog should be shown. */
  confirmOpen: boolean;
  /** Closes the confirm dialog without pulling. */
  closeConfirm: () => void;
  /**
   * Called by the confirm dialog once "Pull anyway" has successfully queued a confirmed pull.
   *
   * @param result - The queued pull operation.
   */
  handleConfirmed: (result: StartPullResult) => void;
  /** True while a pull is starting, awaiting confirmation, or its operation is being polled. */
  pending: boolean;
  /** The outcome message from the most recent pull attempt that did not simply succeed, or null. */
  message: PullMessage | null;
  /** Starts a pull; opens the confirm dialog instead of erroring when open files block it. */
  start: () => void;
  /**
   * Opens the same confirm dialog `start()` falls back to on refusal, but up front — before any pull
   * is attempted — so the normal pull entry can show the dry-run preview before doing anything.
   */
  openPreview: () => void;
}

/**
 * @param projectId - The project a pull applies to.
 * @param onSucceeded - Called once a pull operation reaches `SUCCEEDED` — the caller refetches git
 * status/behind-ahead (and tree-status, if it tracks one) from here rather than this hook reaching
 * into those directly.
 */
export function usePull(projectId: string, onSucceeded: () => void): UsePull {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [message, setMessage] = useState<PullMessage | null>(null);

  const start = useCallback(() => {
    setMessage(null);
    setPending(true);
    startPull(projectId)
      .then((result) => {
        setOperationId(result.operationId);
      })
      .catch((caughtError: unknown) => {
        if (caughtError instanceof ApiError && caughtError.code === 'open_files_need_confirm') {
          setConfirmOpen(true);
          setPending(false);
          return;
        }
        setPending(false);
        setMessage({ tone: 'error', text: describePullFailure(caughtError) });
      });
  }, [projectId]);

  const handleConfirmed = useCallback((result: StartPullResult) => {
    setConfirmOpen(false);
    setMessage(null);
    setPending(true);
    setOperationId(result.operationId);
  }, []);

  const closeConfirm = useCallback(() => setConfirmOpen(false), []);

  const openPreview = useCallback(() => {
    setMessage(null);
    setConfirmOpen(true);
  }, []);

  // Polls the queued operation, exactly like the import dialog, until it reaches a terminal state OR
  // `AWAITING_CONFLICT` — which `isGitOperationTerminal` deliberately does not count as terminal, so
  // it is checked first here to stop polling rather than spin on it forever.
  useEffect(() => {
    if (!operationId) return;
    const currentOperationId: string = operationId;
    let active = true;

    async function tick() {
      try {
        const status = await getGitOperation(projectId, currentOperationId);
        if (!active) return;
        if (status.state === 'AWAITING_CONFLICT') {
          setOperationId(null);
          setPending(false);
          setMessage({ tone: 'neutral', text: 'Pull paused — conflicts need resolving.' });
          return;
        }
        if (isGitOperationTerminal(status.state)) {
          setOperationId(null);
          setPending(false);
          if (status.state === 'SUCCEEDED') {
            onSucceeded();
          } else {
            setMessage({
              tone: 'error',
              text: status.state === 'FAILED' ? 'The pull failed.' : 'The pull was aborted.',
            });
          }
        }
      } catch {
        // A transient poll failure doesn't end the pull — the next tick tries again.
      }
    }

    void tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [operationId, projectId, onSucceeded]);

  return { confirmOpen, closeConfirm, handleConfirmed, pending, message, start, openPreview };
}
