'use client';

/**
 * Orchestrates starting a push from the editor and polling it to completion, for the project editor
 * layout: `start()` attempts the push immediately and, once the server has queued it, polls the
 * operation on the same interval/shape as {@link usePull}'s polling loop. Simpler than the pull
 * hook in two ways: there is no open-files confirm dialog to fall back to (push never touches open
 * files — it only sends already-committed history), and there is no `AWAITING_CONFLICT` branch to
 * special-case (a push never pauses for conflict resolution the way a pull does).
 */
import { useCallback, useEffect, useState } from 'react';
import { getGitOperation, isGitOperationTerminal, startPush } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';

/** How often the push operation's status is re-read while it is queued or running. */
const POLL_INTERVAL_MS = 1500;

/** A push's settled, non-success outcome to show the user. Always an error — a push has no neutral outcome. */
export interface PushMessage {
  /** Shaped like the pull hook's outcome message even though a push only ever produces `'error'`. */
  tone: 'error';
  /** The message text. */
  text: string;
}

/** Said when the server offered no usable explanation of its own for a refused start. */
const GENERIC_START_FAILURE = 'The push could not be started.';

/**
 * Turns a refusal to even QUEUE a push (the initial `POST` itself failed) into the sentence shown
 * to the user. Chosen by the machine-readable code rather than the prose, so a reworded server
 * message never silently changes which advice is shown.
 */
function describeStartFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_START_FAILURE;
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need editor access to push.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    default: {
      return GENERIC_START_FAILURE;
    }
  }
}

/**
 * Human wording for a queued push that finished in `FAILED`, keyed by its typed error code. The
 * first three keys are `GitErrorCode` members (`@asciidocollab/shared`), lower_snake by
 * convention; `PUSH_CREDENTIAL_NOT_FOUND` and `PUSH_REPOSITORY_NOT_FOUND` are the git worker's own
 * upper-snake constants (see `apps/git-worker/src/dispatch/push-handler.ts`) for pre-conditions the
 * handler checks before ever attempting the push, so they carry no `GitErrorCode` of their own —
 * the operation's `errorCode` is passed through to the client unchanged either way (see the
 * operation-status route), so both casings can appear on the wire.
 */
const OPERATION_FAILURE_MESSAGES: Record<string, string> = {
  non_fast_forward: 'The remote has commits this branch does not have — pull first, then push again.',
  repository_unreachable: 'The repository could not be reached. Try again shortly.',
  authentication_failed: 'The stored credential was rejected. Rotate it and try again.',
  PUSH_CREDENTIAL_NOT_FOUND: 'No stored credential was found for this repository. Connect one and try again.',
  PUSH_REPOSITORY_NOT_FOUND: "This project's repository could not be found on the remote.",
};

/** Said for a `FAILED` push operation whose error code carries no specific wording of its own. */
const GENERIC_OPERATION_FAILURE = 'The push failed.';

function describeOperationFailure(errorCode: string | null): string {
  if (errorCode && errorCode in OPERATION_FAILURE_MESSAGES) {
    return OPERATION_FAILURE_MESSAGES[errorCode];
  }
  return GENERIC_OPERATION_FAILURE;
}

/** State and actions for the editor layout's push affordance. */
export interface UsePush {
  /** True while a push is starting or its operation is being polled. */
  pending: boolean;
  /** The outcome message from the most recent push attempt that did not simply succeed, or null. */
  message: PushMessage | null;
  /** Starts a push. */
  start: () => void;
  /**
   * Dismisses the current outcome message without starting a new push — for a caller who has just
   * removed the condition a lingering message was warning about (a pull landed the commits a
   * `non_fast_forward` refusal was waiting on, say), rather than the message sitting stale until the
   * next push attempt overwrites it.
   */
  clear: () => void;
}

/**
 * @param projectId - The project a push applies to.
 * @param onSucceeded - Called once a push operation reaches `SUCCEEDED` — the caller refetches git
 * status/behind-ahead from here rather than this hook reaching into those directly.
 */
export function usePush(projectId: string, onSucceeded: () => void): UsePush {
  const [pending, setPending] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [message, setMessage] = useState<PushMessage | null>(null);

  const start = useCallback(() => {
    // Guard against a double/stale invocation: while a push is already starting or being polled,
    // a second `start()` must not fire another `startPush` POST and queue a duplicate push.
    if (pending) return;
    setMessage(null);
    setPending(true);
    startPush(projectId)
      .then((result) => {
        setOperationId(result.operationId);
      })
      .catch((caughtError: unknown) => {
        setPending(false);
        setMessage({ tone: 'error', text: describeStartFailure(caughtError) });
      });
  }, [projectId, pending]);

  const clear = useCallback(() => setMessage(null), []);

  // Polls the queued operation, exactly like the pull hook, until it reaches a terminal state.
  useEffect(() => {
    if (!operationId) return;
    const currentOperationId: string = operationId;
    let active = true;

    async function tick() {
      try {
        const status = await getGitOperation(projectId, currentOperationId);
        if (!active) return;
        if (isGitOperationTerminal(status.state)) {
          setOperationId(null);
          setPending(false);
          if (status.state === 'SUCCEEDED') {
            onSucceeded();
          } else if (status.state === 'FAILED') {
            setMessage({ tone: 'error', text: describeOperationFailure(status.errorCode) });
          } else {
            setMessage({ tone: 'error', text: 'The push was aborted.' });
          }
        }
      } catch {
        // A transient poll failure doesn't end the push — the next tick tries again.
      }
    }

    void tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [operationId, projectId, onSucceeded]);

  return { pending, message, start, clear };
}
