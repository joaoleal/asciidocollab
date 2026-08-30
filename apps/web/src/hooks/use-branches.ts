'use client';

/**
 * Orchestrates the editor's branch switcher: loads the project's local branches and which one is
 * current, creates new branches, and starts/polls a branch switch to completion — mirroring
 * `usePull`'s own-operation polling exactly, with one added wrinkle: `checkoutBranch` has TWO
 * distinct synchronous refusals (`409 uncommitted_changes` and `409 open_files_need_confirm`,
 * checked in that order by the route) rather than pull's one, so the confirm state tracks which of
 * the two fired and the confirm dialog itself performs the flagged retry (see
 * `BranchSwitchDialog`), exactly like `PullConfirmForm` retries the pull.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeCheckoutFailure } from '@/components/git/branch-switch-dialog';
import {
  checkoutBranch,
  createBranch as createBranchRequest,
  getBranches,
  getGitOperation,
  isGitOperationTerminal,
  type BranchSwitchConfirmCode,
  type CheckoutBranchResult,
} from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import { describeDrift } from '@/lib/git/describe-drift';
import type { BranchDto } from '@asciidocollab/shared';

/** How often a queued branch-switch operation's status is re-read while it is queued or running. */
const POLL_INTERVAL_MS = 1500;

/** A branch switch's settled, non-success outcome to show the user. */
export interface BranchSwitchMessage {
  /** An `error` tone renders as a destructive alert; a `neutral` tone (paused on conflicts) does not. */
  tone: 'neutral' | 'error';
  /** The message text. */
  text: string;
}

/** State and actions for the editor layout's branch switcher. */
export interface UseBranches {
  /** The currently checked-out branch, or null while not yet loaded (or on a load failure). */
  current: string | null;
  /** Every local branch, in no particular order. Empty while not yet loaded (or on a load failure). */
  branches: BranchDto[];
  /** True while the branch list is loading. */
  loading: boolean;
  /**
   * A genuinely unexpected load failure. A project with no connected git repository (404) is NOT
   * an error — it simply resolves to an empty branch list — so this stays null in that case.
   */
  error: string | null;
  /** Reloads the branch list — for use after a switch or a creation changes it. */
  refetch: () => Promise<void>;
  /**
   * Creates a new branch from the current branch's tip, then refetches the list.
   *
   * @param name - The new branch's name.
   */
  createBranch: (name: string) => Promise<void>;
  /**
   * Starts switching to the given branch; opens the confirm dialog instead of erroring on either 409.
   *
   * @param name - The branch name to switch to.
   */
  switchBranch: (name: string) => void;
  /** True while a switch is starting or its operation is being polled. */
  switchPending: boolean;
  /** The outcome message from the most recent switch attempt that did not simply succeed, or null. */
  switchMessage: BranchSwitchMessage | null;
  /** Whether the switch confirm dialog should be shown. */
  confirmOpen: boolean;
  /** The branch the confirm dialog would switch to. Set together with `confirmOpen`/`confirmCode`. */
  confirmBranchName: string | null;
  /** Which of the two synchronous refusals opened the confirm dialog. */
  confirmCode: BranchSwitchConfirmCode | null;
  /** Closes the confirm dialog without switching. */
  closeConfirm: () => void;
  /**
   * Called by the confirm dialog once its flagged retry has successfully queued a switch.
   *
   * @param result - The queued switch operation's checkout result.
   */
  handleConfirmed: (result: CheckoutBranchResult) => void;
}

/** The two `ApiError.code`s that open the confirm dialog rather than surfacing as an error. */
const CONFIRMABLE_CODES: ReadonlySet<string> = new Set(['uncommitted_changes', 'open_files_need_confirm']);

/** Narrows an `ApiError.code` string to one of the two confirmable checkout-refusal codes. */
function isConfirmableCode(code: string): code is BranchSwitchConfirmCode {
  return CONFIRMABLE_CODES.has(code);
}

/** ApiError status codes that mean "this project has no connected git repository" — not a failure. */
const NOT_CONNECTED_STATUSES: ReadonlySet<number> = new Set([404]);

/**
 * @param projectId - The project whose branches are being managed.
 * @param onSucceeded - Called once a branch-switch operation reaches `SUCCEEDED`, in addition to
 * this hook's own list refetch — the caller refetches the same cross-cutting git read models a
 * pull does (tree status, git status, behind-ahead), since a branch switch changes the working
 * tree exactly like a pull does.
 * @param onPaused - Called once a switch operation halts in `AWAITING_CONFLICT` instead of
 * succeeding. That pause is the moment the project's sync status becomes `CONFLICTED`, so the caller
 * refetches the same read models from here — otherwise nothing would ever re-read them (this hook's
 * own poll has stopped, and `onSucceeded` never fires for a paused switch) and the conflict-
 * resolution entry point that status gates would stay hidden while the paused message claims
 * otherwise. Mirrors `usePull`'s callback of the same name.
 */
export function useBranches(projectId: string, onSucceeded: () => void, onPaused?: () => void): UseBranches {
  const [current, setCurrent] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [switchPending, setSwitchPending] = useState(false);
  const [switchMessage, setSwitchMessage] = useState<BranchSwitchMessage | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmBranchName, setConfirmBranchName] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState<BranchSwitchConfirmCode | null>(null);

  // Guards the branch-list loader against an older `load`/`refetch` call's response resolving
  // after a newer one's — only the latest-started call is allowed to write state.
  const loadSeq = useRef(0);

  const load = useCallback(
    async (active: () => boolean) => {
      const seq = ++loadSeq.current;
      const isCurrent = () => active() && seq === loadSeq.current;
      setLoading(true);
      setError(null);
      try {
        const result = await getBranches(projectId);
        if (!isCurrent()) return;
        // Defensive against a malformed/mismatched response body: an unexpected shape resolves to
        // "nothing loaded" rather than crashing the switcher's render.
        setCurrent(typeof result.current === 'string' ? result.current : null);
        setBranches(Array.isArray(result.branches) ? result.branches : []);
      } catch (error_) {
        if (!isCurrent()) return;
        setCurrent(null);
        setBranches([]);
        if (error_ instanceof ApiError && NOT_CONNECTED_STATUSES.has(error_.status)) {
          // No connected git repository: an empty list, not an error — same not-connected
          // convention as `useBehindAhead`/`useGitTreeStatus`/`useGitStatus`.
        } else {
          setError('Failed to load branches.');
        }
      } finally {
        if (isCurrent()) setLoading(false);
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

  const createBranch = useCallback(
    async (name: string) => {
      await createBranchRequest(projectId, name);
      await refetch();
    },
    [projectId, refetch],
  );

  const switchBranch = useCallback(
    (name: string) => {
      setSwitchMessage(null);
      setSwitchPending(true);
      checkoutBranch(projectId, { name })
        .then((result) => {
          setOperationId(result.operationId);
        })
        .catch((caughtError: unknown) => {
          if (caughtError instanceof ApiError && isConfirmableCode(caughtError.code)) {
            setConfirmBranchName(name);
            setConfirmCode(caughtError.code);
            setConfirmOpen(true);
            setSwitchPending(false);
            return;
          }
          setSwitchPending(false);
          setSwitchMessage({ tone: 'error', text: describeCheckoutFailure(caughtError) });
        });
    },
    [projectId],
  );

  const handleConfirmed = useCallback((result: CheckoutBranchResult) => {
    setConfirmOpen(false);
    setConfirmBranchName(null);
    setConfirmCode(null);
    setSwitchMessage(null);
    setSwitchPending(true);
    setOperationId(result.operationId);
  }, []);

  const closeConfirm = useCallback(() => {
    setConfirmOpen(false);
    setConfirmBranchName(null);
    setConfirmCode(null);
  }, []);

  // Guards the switch-operation poll against an older tick's response resolving after a newer
  // tick's, which can happen when a poll takes longer than `POLL_INTERVAL_MS` to settle.
  const pollSeq = useRef(0);

  // Polls the queued switch operation, exactly like `usePull`, until it reaches a terminal state OR
  // `AWAITING_CONFLICT` — checked first here, same reason as the pull hook: `isGitOperationTerminal`
  // deliberately does not count it as terminal.
  useEffect(() => {
    if (!operationId) return;
    const currentOperationId: string = operationId;
    let active = true;

    async function tick() {
      const seq = ++pollSeq.current;
      const isCurrent = () => active && seq === pollSeq.current;
      try {
        const status = await getGitOperation(projectId, currentOperationId);
        if (!isCurrent()) return;
        if (status.state === 'AWAITING_CONFLICT') {
          setOperationId(null);
          setSwitchPending(false);
          setSwitchMessage({ tone: 'neutral', text: 'Branch switch paused — conflicts need resolving.' });
          onPaused?.();
          return;
        }
        if (isGitOperationTerminal(status.state)) {
          setOperationId(null);
          setSwitchPending(false);
          if (status.state === 'SUCCEEDED') {
            void refetch();
            onSucceeded();
            // A clean switch can still have dropped a change under tree drift; this is the user's
            // only window into that, since the detail lives only in the admin audit log.
            const driftMessage = describeDrift(
              status.driftSummary,
              'Branch switch applied',
              'switch to that branch again',
            );
            if (driftMessage) setSwitchMessage({ tone: 'neutral', text: driftMessage });
          } else {
            setSwitchMessage({
              tone: 'error',
              text: status.state === 'FAILED' ? 'The branch switch failed.' : 'The branch switch was aborted.',
            });
          }
        }
      } catch {
        // A transient poll failure doesn't end the switch — the next tick tries again.
      }
    }

    void tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [operationId, projectId, onSucceeded, onPaused, refetch]);

  return {
    current,
    branches,
    loading,
    error,
    refetch,
    createBranch,
    switchBranch,
    switchPending,
    switchMessage,
    confirmOpen,
    confirmBranchName,
    confirmCode,
    closeConfirm,
    handleConfirmed,
  };
}
