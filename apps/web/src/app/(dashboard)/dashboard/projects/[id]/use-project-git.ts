'use client';
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useGitTreeStatus } from '@/hooks/use-git-tree-status';
import { useGitStatus } from '@/hooks/use-git-status';
import { useBehindAhead } from '@/hooks/use-behind-ahead';
import { useGitActivity } from '@/hooks/use-git-activity';
import { usePull } from '@/hooks/use-pull';
import { usePush } from '@/hooks/use-push';
import { useBranches } from '@/hooks/use-branches';
import { useConflicts } from '@/hooks/use-conflicts';
import { undoPull, type StartPullResult } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';

interface UseProjectGitOptions {
  projectId: string;
  /** The editor capability that gates committing, pulling, pushing and branch switching. */
  canEdit: boolean;
}

/**
 * The last clean pull or branch switch, still undoable via {@link undoPull} — the same route the
 * conflict panel's Undo uses, which also covers "undo the most recent cleanly-succeeded pull/switch"
 * when nothing is currently `AWAITING_CONFLICT` (see `UndoPullUseCase.undoMostRecentSucceededContentOp`).
 */
export interface UndoableGitAction {
  /** Which kind of clean operation this is — only these two ever reach a success callback undoably. */
  kind: 'pull' | 'branch-switch';
  /** The status-bar label, e.g. `'Pulled'` or `'Switched to main'`. */
  label: string;
}

/** An undo attempt's settled failure to show the user — shaped like `PullMessage`/`PushMessage`. */
export interface UndoMessage {
  /** Always an error tone — a successful undo simply clears the affordance, with nothing to show. */
  tone: 'error';
  /** The message text. */
  text: string;
}

/**
 * Said when a refused undo has no more specific wording of its own. Deliberately its OWN fallback —
 * not `describeCompleteFailure`'s ("Couldn't complete the pull.") — since this affordance's `undoLast`
 * (below) undoes a branch switch just as often as a pull, and that fallback reads as pull-specific.
 */
const GENERIC_UNDO_FAILURE = "Couldn't undo the last change.";

/**
 * Turns a refused undo into the sentence shown in the status bar's alert, keyed by the backend's
 * typed error code — the same route (and mostly the same codes) the conflict panel's own
 * `describeCompleteFailure` maps, but with the undo-specific fallback above. `nothing_to_undo` is
 * deliberately NOT mapped here: `undoLast` special-cases it before ever reaching this function, since
 * that refusal clears the affordance quietly rather than showing any message at all.
 */
function describeUndoFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_UNDO_FAILURE;
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need editor access to do this.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    default: {
      return GENERIC_UNDO_FAILURE;
    }
  }
}

/**
 * All git-sync wiring for the project editor: the read-model subscriptions (per-file status,
 * branch/sync readout, ahead/behind counts, activity), the mutation hooks (pull/push/branch/
 * conflicts) with their shared refresh callback, and the open/closed state for every git dialog.
 * Extracted from the layout so the git surface is one cohesive unit the layout merely composes.
 */
export function useProjectGit({ projectId, canEdit }: UseProjectGitOptions) {
  // Per-file git status for the file tree's badges (a read-only display enhancement — see the hook
  // for why a project with no connected git repository resolves to an empty map rather than an error).
  // `refetch` is reused as the commit dialog's onCommitted callback below, so a commit's badges update
  // from the SAME hook instance rather than adding a second status subscription.
  const { statusByFileNodeId, refetch: refetchGitTreeStatus } = useGitTreeStatus(projectId);
  // Branch/sync/last-sync readout for the header's connection status bar. Same not-connected
  // convention as the tree-status hook above: a 404 means `connected:false`, not an error.
  const { status: gitStatus, connected: gitConnected, refetch: refetchGitStatus } = useGitStatus(projectId);

  // The transient "✓ Pulled — Undo" / "✓ Switched to <branch> — Undo" affordance: set ONLY by a
  // clean pull's or clean branch switch's own success callback below (never by the shared
  // `handlePullSucceeded`, which also runs for push/commit/conflict-resolve/discard — none of which
  // this affordance should ever follow). Cleared two ways: when another git action LANDS (it
  // supersedes whatever came before it as the "last operation" the undo route would revert), and —
  // critically — the MOMENT a new pull/switch/push/commit/discard is INITIATED, before it is even
  // delegated to. The second is not redundant with the first: a pull or switch that PAUSES in
  // `AWAITING_CONFLICT` never fires its own success callback, so clearing on success alone would
  // leave a PRIOR clean op's "Undo" button stranded on screen while the user resolves the new
  // conflict. Clicking that stale button would call `undoPull`, which prioritizes the now-paused op
  // (`UndoPullUseCase`'s Case A) and abort the conflict resolution in progress — discarding whatever
  // the user had already resolved — instead of undoing the unrelated earlier op. Every mutation
  // entry point below therefore clears first, then delegates.
  const [undoable, setUndoable] = useState<UndoableGitAction | null>(null);
  const [undoPending, setUndoPending] = useState(false);
  const [undoMessage, setUndoMessage] = useState<UndoMessage | null>(null);
  const clearUndoable = useCallback(() => setUndoable(null), []);

  const [commitDialogOpenState, setCommitDialogOpenState] = useState(false);
  // Opening the commit dialog counts as initiating a new git action, same reasoning as pull/push/
  // switch below — see the `undoable` comment above.
  const setCommitDialogOpen = useCallback(
    (open: boolean) => {
      if (open) clearUndoable();
      setCommitDialogOpenState(open);
    },
    [clearUndoable],
  );

  // Real ahead/behind commit counts for the status bar's "Pull available" affordance — distinct from
  // `gitStatus.ahead`/`.behind`, which are a fixed-`0` placeholder never rendered for this. Gated on
  // `gitConnected` so a project with no connected repository never polls (and never 404s every 4s).
  const { behindAhead, refetch: refetchBehindAhead } = useBehindAhead(projectId, gitConnected);
  // Tracks the latest `push.clear` so `handlePullSucceeded` (defined below, before `push` exists)
  // can dismiss a lingering push error whenever a pull/commit/branch-switch/discard lands, without
  // a circular dependency between the two hooks (`push` itself is constructed with
  // `handlePullSucceeded` as its own success callback — see below).
  const pushClearReference = useRef<() => void>(() => {});
  // A pull refetches the same three git read models a commit does, so its badges/counts/status all
  // move together once it lands. It also dismisses a lingering push error (e.g. a stale
  // `non_fast_forward` "pull first" alert) now that the condition it warned about may be gone.
  const handlePullSucceeded = useCallback(() => {
    refetchGitTreeStatus();
    refetchGitStatus();
    void refetchBehindAhead();
    pushClearReference.current();
  }, [refetchGitTreeStatus, refetchGitStatus, refetchBehindAhead]);

  const handlePullSucceededWithUndo = useCallback(() => {
    handlePullSucceeded();
    setUndoMessage(null);
    setUndoable({ kind: 'pull', label: 'Pulled' });
  }, [handlePullSucceeded]);
  const pullInternal = usePull(projectId, handlePullSucceededWithUndo);
  // Wraps the two entry points that actually START a pull — `start()`, and the confirm dialog's
  // `handleConfirmed()`, which is the one the status bar's normal Pull entry goes through in
  // practice (it always opens the preview/confirm dialog first; `PullConfirmForm` calls `startPull`
  // itself and hands the result to `handleConfirmed`) — to clear any stale affordance BEFORE
  // delegating. See the `undoable` comment above for why clearing on success alone isn't enough.
  const pullStart = useCallback(() => {
    clearUndoable();
    pullInternal.start();
  }, [clearUndoable, pullInternal.start]);
  const pullHandleConfirmed = useCallback(
    (result: StartPullResult) => {
      clearUndoable();
      pullInternal.handleConfirmed(result);
    },
    [clearUndoable, pullInternal.handleConfirmed],
  );
  const pull = useMemo(
    () => ({ ...pullInternal, start: pullStart, handleConfirmed: pullHandleConfirmed }),
    [pullInternal, pullStart, pullHandleConfirmed],
  );
  // Pulling requires the same editor capability as committing (see the route's requirement).
  const canPull = canEdit;

  // Push preview: read-only, so it needs no permission gate of its own beyond the status bar only
  // showing the trigger once there is something ahead to preview.
  const [pushPreviewOpen, setPushPreviewOpen] = useState(false);

  // A push refetches the same three git read models a pull does, so the ahead count (and the
  // Push button it gates) drops away once it lands. A push also supersedes any undoable pull/switch
  // (the undo route reverts the most recent PULL/BRANCH_SWITCH, which a push doesn't touch, but the
  // push is itself a new git action from the user's point of view — offering "Undo" for the pull
  // before it would be confusing once a push has landed on top of it).
  const handlePushSucceeded = useCallback(() => {
    handlePullSucceeded();
    setUndoable(null);
  }, [handlePullSucceeded]);
  const pushInternal = usePush(projectId, handlePushSucceeded);
  // Clears the affordance the MOMENT a push starts, same as pull/switch — a push can't itself pause
  // in `AWAITING_CONFLICT`, but clearing at initiation (not just on success) keeps every mutation
  // entry point consistent about when the "last operation" changes.
  const pushStart = useCallback(() => {
    clearUndoable();
    pushInternal.start();
  }, [clearUndoable, pushInternal.start]);
  const push = useMemo(() => ({ ...pushInternal, start: pushStart }), [pushInternal, pushStart]);
  // Keep the ref pointing at the latest `push.clear` as a committed effect rather than mutating it
  // during render (a render-time side effect). `handlePullSucceeded` reads it through the ref, so it
  // still sees the current `push.clear` without a circular dependency between the two hooks.
  useEffect(() => {
    pushClearReference.current = pushInternal.clear;
  }, [pushInternal.clear]);
  // Pushing requires the same editor capability as committing/pulling (see the route's requirement).
  const canPush = canEdit;

  // Branch switching changes the working tree exactly like a pull does, so it refetches the same
  // three git read models on success — reusing the pull handler rather than duplicating it. The
  // branch name a switch success's undo label needs isn't in `useBranches`'s own success callback
  // (it takes no argument, and by the time it fires `refetch()`'s new `current` may not have landed
  // yet), so `switchBranchTargetReference` captures it at the ORIGINAL `switchBranch(name)` call —
  // which stays valid even across a confirm-dialog retry, since the target branch never changes
  // between the first attempt and its confirmed retry.
  const switchBranchTargetReference = useRef<string | null>(null);
  const handleBranchSwitchSucceeded = useCallback(() => {
    handlePullSucceeded();
    const target = switchBranchTargetReference.current;
    setUndoMessage(null);
    setUndoable({ kind: 'branch-switch', label: target ? `Switched to ${target}` : 'Switched branch' });
  }, [handlePullSucceeded]);
  const branchesInternal = useBranches(projectId, handleBranchSwitchSucceeded);
  // Clears the affordance the MOMENT a switch is attempted — before the two possible synchronous
  // confirm-needed refusals could even fire — since it is `switchBranch` itself that reaches
  // `AWAITING_CONFLICT`, not `handleConfirmed`'s later retry. See the `undoable` comment above.
  // `createBranch` doesn't touch the working tree and can never itself conflict, but is wrapped too
  // for consistency: it is still a new git action landing.
  const switchBranch = useCallback(
    (name: string) => {
      clearUndoable();
      switchBranchTargetReference.current = name;
      branchesInternal.switchBranch(name);
    },
    [clearUndoable, branchesInternal.switchBranch],
  );
  const createBranch = useCallback(
    async (name: string) => {
      clearUndoable();
      await branchesInternal.createBranch(name);
    },
    [clearUndoable, branchesInternal.createBranch],
  );
  const branches = useMemo(
    () => ({ ...branchesInternal, switchBranch, createBranch }),
    [branchesInternal, switchBranch, createBranch],
  );
  // Creating/switching branches requires the same editor capability as committing/pulling; reading
  // the list does not (the route allows any project member), but the switcher is editor-only here.
  // It is ALSO a repository-only control — like History, discard, and the rest — so it additionally
  // requires a connected repository; without one there are no branches to switch between.
  const canSwitchBranches = canEdit && gitConnected;

  // Conflict resolution panel: shown once a pull/branch-switch pauses in AWAITING_CONFLICT (surfaced
  // as the status bar's CONFLICTED sync status). Completing or undoing changes the working tree the
  // same way a pull does, so it reuses the same refresh callback — and additionally closes the panel,
  // since there is nothing left to resolve once it succeeds.
  const [conflictPanelOpen, setConflictPanelOpen] = useState(false);
  const handleConflictsResolved = useCallback(() => {
    handlePullSucceeded();
    setConflictPanelOpen(false);
    // A completed (or undone) conflict resolution clears its own pre-operation snapshot server-side,
    // so offering "Undo" for it — or for whatever it superseded — would only fail. See `undoLast`.
    setUndoable(null);
  }, [handlePullSucceeded]);
  const conflicts = useConflicts(projectId, handleConflictsResolved);

  // Undoes the last clean pull/switch via the SAME route the conflict panel's Undo uses
  // (`POST .../git/undo-pull`) — that route already covers both "abandon a paused pull/switch" AND
  // "revert the most recently SUCCEEDED pull/switch when nothing is currently paused", so this is
  // just the missing entry point for the second case. Synchronous like the route itself (no operation
  // to poll): on success it refetches the same read models a pull does and clears the affordance; a
  // `nothing_to_undo` refusal (someone else already undid it, or it was otherwise superseded)
  // clears the affordance quietly rather than surfacing an error, since there is nothing actionable
  // left to tell the user — any other refusal surfaces as a minimal message instead, via the
  // undo-specific {@link describeUndoFailure}.
  const undoLast = useCallback(() => {
    if (!undoable) return;
    setUndoPending(true);
    setUndoMessage(null);
    undoPull(projectId)
      .then(() => {
        handlePullSucceeded();
        setUndoable(null);
      })
      .catch((caughtError: unknown) => {
        if (caughtError instanceof ApiError && caughtError.code === 'nothing_to_undo') {
          setUndoable(null);
          return;
        }
        setUndoMessage({ tone: 'error', text: describeUndoFailure(caughtError) });
      })
      .finally(() => setUndoPending(false));
  }, [undoable, projectId, handlePullSucceeded]);

  // History panel: read-only, so it needs no permission gate beyond having a connected repository
  // to read history from. `HistoryPanel` only fetches while it is open, so mounting it here
  // unconditionally never fires a request until the viewer actually opens it.
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);

  // Discard dialog: every unstaged/untracked path is discardable in one action. Reuses the same
  // `gitStatus` this header already reads, rather than a separate fetch.
  const [discardDialogOpenState, setDiscardDialogOpenState] = useState(false);
  // Opening the discard dialog counts as initiating a new git action, same reasoning as commit above.
  const setDiscardDialogOpen = useCallback(
    (open: boolean) => {
      if (open) clearUndoable();
      setDiscardDialogOpenState(open);
    },
    [clearUndoable],
  );
  const discardablePaths = useMemo(
    () => [...(gitStatus?.unstaged ?? []), ...(gitStatus?.untracked ?? [])].map((change) => change.path),
    [gitStatus],
  );

  // Collaboration-facing "git activity" signal: lets a member notice that ANOTHER member's (or the
  // system's) whole-project git operation is running, purely from polling the same `GitOperation`
  // row the progress read uses — no separate awareness channel.
  const { activeOperation: activeGitOperation } = useGitActivity(projectId, gitConnected);

  return {
    statusByFileNodeId,
    refetchGitTreeStatus,
    gitStatus,
    gitConnected,
    refetchGitStatus,
    commitDialogOpen: commitDialogOpenState,
    setCommitDialogOpen,
    behindAhead,
    refetchBehindAhead,
    handlePullSucceeded,
    pull,
    canPull,
    pushPreviewOpen,
    setPushPreviewOpen,
    push,
    canPush,
    branches,
    canSwitchBranches,
    conflictPanelOpen,
    setConflictPanelOpen,
    conflicts,
    undoable,
    undoPending,
    undoMessage,
    undoLast,
    clearUndoable,
    historyPanelOpen,
    setHistoryPanelOpen,
    discardDialogOpen: discardDialogOpenState,
    setDiscardDialogOpen,
    discardablePaths,
    activeGitOperation,
  };
}
