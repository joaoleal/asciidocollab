'use client';
import { Check, GitBranch, History, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GitConnectionStatusBar } from '@/components/git/git-connection-status-bar';
import { GitActivityIndicator } from '@/components/git/git-activity-indicator';
import { BranchSwitcher } from '@/components/git/branch-switcher';
import type { useProjectGit } from './use-project-git';

interface GitToolbarProperties {
  git: ReturnType<typeof useProjectGit>;
  /** The editor capability that gates committing/pulling/pushing/branch-switching and discarding. */
  canEdit: boolean;
}

/** The header's git-sync controls: activity, branch switcher, sync status bar, and action buttons. */
export function GitToolbar({ git, canEdit }: GitToolbarProperties) {
  // Whether the actions cluster (Resolve conflicts / History / Discard changes) has anything to
  // show — kept out of the JSX below so an empty cluster never renders its divider with nothing in it.
  const hasActions =
    git.gitStatus?.syncStatus === 'CONFLICTED' ||
    git.gitConnected ||
    (canEdit && git.discardablePaths.length > 0);

  return (
    <div className="flex items-center gap-2 shrink-0 overflow-x-auto">
      <div className="flex items-center gap-2 shrink-0">
        <GitActivityIndicator activeOperation={git.activeGitOperation} />
        {git.canSwitchBranches ? (
          <BranchSwitcher
            current={git.branches.current}
            branches={git.branches.branches}
            loading={git.branches.loading}
            switchPending={git.branches.switchPending}
            onSwitch={git.branches.switchBranch}
            onCreate={git.branches.createBranch}
          />
        ) : (
          // A read-only viewer (no BranchSwitcher, since it can't switch) still needs to see which
          // branch a connected repo is on — otherwise a connected repo shows no branch name at all.
          git.gitConnected && (
            <span
              className="flex min-w-0 shrink-0 items-center gap-2 whitespace-nowrap text-sm text-muted-foreground"
              title={git.branches.current ?? undefined}
            >
              <GitBranch className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="max-w-[10rem] truncate">
                {git.branches.current ?? (git.branches.loading ? 'Loading…' : 'Branch')}
              </span>
            </span>
          )
        )}
        <GitConnectionStatusBar
          status={git.gitStatus}
          connected={git.gitConnected}
          canCommit={canEdit}
          onCommitClick={() => git.setCommitDialogOpen(true)}
          behindAhead={git.behindAhead}
          canPull={git.canPull}
          onPullClick={git.pull.openPreview}
          pullPending={git.pull.pending}
          onPreviewPushClick={() => git.setPushPreviewOpen(true)}
          canPush={git.canPush}
          onPushClick={git.push.start}
          pushPending={git.push.pending}
        />
        {canEdit && git.undoable && (
          <span className="flex items-center gap-1.5 shrink-0 whitespace-nowrap text-sm">
            <span
              role="status"
              aria-live="polite"
              className="flex items-center gap-1 text-[hsl(var(--success))]"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {git.undoable.label}
            </span>
            <span className="text-muted-foreground" aria-hidden="true">
              —
            </span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-sm"
              onClick={git.undoLast}
              disabled={git.undoPending}
              aria-label={`Undo the last ${git.undoable.kind === 'pull' ? 'pull' : 'branch switch'}`}
            >
              {git.undoPending ? 'Undoing…' : 'Undo'}
            </Button>
          </span>
        )}
      </div>
      {hasActions && (
        <div className="flex items-center gap-2 shrink-0 border-l pl-2">
          {git.gitStatus?.syncStatus === 'CONFLICTED' && (
            <Button variant="destructive" size="sm" onClick={() => git.setConflictPanelOpen(true)}>
              Resolve conflicts
            </Button>
          )}
          {git.gitConnected && (
            <Button variant="outline" size="sm" onClick={() => git.setHistoryPanelOpen(true)}>
              <History className="mr-2 h-4 w-4" aria-hidden="true" />
              History
            </Button>
          )}
          {canEdit && git.discardablePaths.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => git.setDiscardDialogOpen(true)}>
              <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
              Discard changes
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
