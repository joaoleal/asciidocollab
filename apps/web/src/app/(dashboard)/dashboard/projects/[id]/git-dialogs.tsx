'use client';
import { CommitDialog } from '@/components/git/commit-dialog';
import { PullDialog } from '@/components/git/pull-dialog';
import { PushPreviewDialog } from '@/components/git/push-preview-dialog';
import { BranchSwitchDialog } from '@/components/git/branch-switch-dialog';
import { HistoryPanelWithDiff } from '@/components/git/history-panel-with-diff';
import { DiscardDialog } from '@/components/git/discard-dialog';
import { ConflictPanel } from '@/components/git/conflict-panel';
import type { useProjectGit } from './use-project-git';

interface GitDialogsProperties {
  git: ReturnType<typeof useProjectGit>;
  projectId: string;
}

/**
 * Every git-sync dialog/panel the layout mounts: commit, pull, push, branch, history, discard and
 * conflict resolution. Rendered unconditionally; each fetches only while open. Per-line blame is no
 * longer a dialog here: it is an inline gutter toggled from the editor toolbar.
 */
export function GitDialogs({ git, projectId }: GitDialogsProperties) {
  return (
    <>
      <CommitDialog
        projectId={projectId}
        open={git.commitDialogOpen}
        onOpenChange={git.setCommitDialogOpen}
        onCommitted={() => {
          git.refetchGitTreeStatus();
          git.refetchGitStatus();
          void git.refetchBehindAhead();
          git.push.clear();
          // A commit is a new git action superseding whatever pull/switch the affordance offered to
          // undo — see `use-project-git.ts`'s `undoable` state.
          git.clearUndoable();
        }}
      />
      <PullDialog
        projectId={projectId}
        open={git.pull.confirmOpen}
        onOpenChange={git.pull.closeConfirm}
        onConfirmed={git.pull.handleConfirmed}
      />
      <PushPreviewDialog projectId={projectId} open={git.pushPreviewOpen} onOpenChange={git.setPushPreviewOpen} />
      <BranchSwitchDialog
        projectId={projectId}
        open={git.branches.confirmOpen}
        branchName={git.branches.confirmBranchName}
        code={git.branches.confirmCode}
        onOpenChange={git.branches.closeConfirm}
        onConfirmed={git.branches.handleConfirmed}
      />
      <HistoryPanelWithDiff
        projectId={projectId}
        open={git.historyPanelOpen}
        onOpenChange={git.setHistoryPanelOpen}
      />
      <DiscardDialog
        projectId={projectId}
        open={git.discardDialogOpen}
        onOpenChange={git.setDiscardDialogOpen}
        paths={git.discardablePaths}
        onDone={() => {
          git.handlePullSucceeded();
          // A discard is a new git action superseding whatever pull/switch the affordance offered to
          // undo — see `use-project-git.ts`'s `undoable` state.
          git.clearUndoable();
        }}
      />
      <ConflictPanel
        projectId={projectId}
        open={git.conflictPanelOpen}
        onOpenChange={git.setConflictPanelOpen}
        files={git.conflicts.files}
        loading={git.conflicts.loading}
        error={git.conflicts.error}
        allResolved={git.conflicts.allResolved}
        resolve={git.conflicts.resolve}
        complete={git.conflicts.complete}
        undo={git.conflicts.undo}
        completing={git.conflicts.completing}
        message={git.conflicts.message}
      />
    </>
  );
}
