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

interface UseProjectGitOptions {
  projectId: string;
  /** The editor capability that gates committing, pulling, pushing and branch switching. */
  canEdit: boolean;
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
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);

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
  const pull = usePull(projectId, handlePullSucceeded);
  // Pulling requires the same editor capability as committing (see the route's requirement).
  const canPull = canEdit;

  // Push preview: read-only, so it needs no permission gate of its own beyond the status bar only
  // showing the trigger once there is something ahead to preview.
  const [pushPreviewOpen, setPushPreviewOpen] = useState(false);

  // A push refetches the same three git read models a pull does, so the ahead count (and the
  // Push button it gates) drops away once it lands.
  const push = usePush(projectId, handlePullSucceeded);
  // Keep the ref pointing at the latest `push.clear` as a committed effect rather than mutating it
  // during render (a render-time side effect). `handlePullSucceeded` reads it through the ref, so it
  // still sees the current `push.clear` without a circular dependency between the two hooks.
  useEffect(() => {
    pushClearReference.current = push.clear;
  }, [push.clear]);
  // Pushing requires the same editor capability as committing/pulling (see the route's requirement).
  const canPush = canEdit;

  // Branch switching changes the working tree exactly like a pull does, so it refetches the same
  // three git read models on success — reusing the pull handler rather than duplicating it.
  const branches = useBranches(projectId, handlePullSucceeded);
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
  }, [handlePullSucceeded]);
  const conflicts = useConflicts(projectId, handleConflictsResolved);

  // History panel: read-only, so it needs no permission gate beyond having a connected repository
  // to read history from. `HistoryPanel` only fetches while it is open, so mounting it here
  // unconditionally never fires a request until the viewer actually opens it.
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);

  // Discard dialog: every unstaged/untracked path is discardable in one action. Reuses the same
  // `gitStatus` this header already reads, rather than a separate fetch.
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
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
    commitDialogOpen,
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
    historyPanelOpen,
    setHistoryPanelOpen,
    discardDialogOpen,
    setDiscardDialogOpen,
    discardablePaths,
    activeGitOperation,
  };
}
