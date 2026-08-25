'use client';

import {
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatRelativeTime } from '@/lib/format-relative-time';
import type { GitStatusDto, GitSyncStatus } from '@asciidocollab/shared';

/** A sync status's rendered style: the tokenized text className plus its accessible label. */
export interface SyncStatusStyle {
  /** Tailwind classes for the label's text color, built from design tokens only (no hardcoded colors). */
  className: string;
  /** Human-readable label — both the accessible name and the visible text. */
  label: string;
}

/**
 * Maps a repository's sync status to its rendered style. Pure and exported for unit testing.
 * Colors come from design tokens (CSS vars / the `destructive` theme color) so the readout reads
 * correctly in both light and dark themes. The switch is exhaustive with no `default` arm, so
 * adding a new {@link GitSyncStatus} value is a compile error here until it's mapped.
 */
export function syncStatusStyle(status: GitSyncStatus): SyncStatusStyle {
  switch (status) {
    case 'UP_TO_DATE': {
      return { className: 'text-[hsl(var(--success))]', label: 'Up to date' };
    }
    case 'AHEAD': {
      return { className: 'text-[hsl(var(--info))]', label: 'Ahead' };
    }
    case 'BEHIND': {
      return { className: 'text-[hsl(var(--warning))]', label: 'Behind' };
    }
    case 'DIVERGED': {
      return { className: 'text-[hsl(var(--warning))]', label: 'Diverged' };
    }
    case 'CONFLICTED': {
      return { className: 'text-destructive', label: 'Conflicted' };
    }
    case 'DISCONNECTED': {
      return { className: 'text-muted-foreground', label: 'Disconnected' };
    }
  }
}

/** The sync-status icon, keyed on the same value as {@link syncStatusStyle} — kept JSX-free there. */
const SYNC_STATUS_ICON: Readonly<Record<GitSyncStatus, LucideIcon>> = {
  UP_TO_DATE: GitBranch,
  AHEAD: ArrowUp,
  BEHIND: ArrowDown,
  DIVERGED: GitMerge,
  CONFLICTED: AlertTriangle,
  DISCONNECTED: Unplug,
};

/** Props for {@link GitConnectionStatusBar}. */
export interface GitConnectionStatusBarProperties {
  /** The connected repository's current status, or null when not connected (or still loading). */
  status: GitStatusDto | null;
  /** Whether the project has a connected git repository. When false, the bar renders nothing. */
  connected: boolean;
  /** True while the status is loading. */
  loading?: boolean;
  /** Whether the viewer may commit — shows the Commit button when true. */
  canCommit: boolean;
  /** Called when the Commit button is clicked. */
  onCommitClick: () => void;
}

/**
 * Compact status-bar readout of a project's connected git repository: current branch, sync state,
 * and last-sync time, plus (when the viewer can commit) the Commit button that a previous task
 * placed standalone in the editor header — absorbed here so the git affordances live together.
 * Renders nothing for a project with no connected git repository (a 404 from the status endpoint) —
 * that is distinct from the rendered `DISCONNECTED` sync status, which means a repo exists but its
 * remote link is currently down.
 */
export function GitConnectionStatusBar({
  status,
  connected,
  loading = false,
  canCommit,
  onCommitClick,
}: GitConnectionStatusBarProperties): React.JSX.Element | null {
  if (!connected) return null;
  if (loading && !status) return null;
  if (!status) return null;

  const syncStyle = syncStatusStyle(status.syncStatus);
  const SyncIcon = SYNC_STATUS_ICON[status.syncStatus];

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="flex items-center gap-1 text-muted-foreground" title="Current branch">
        <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
        {status.branch}
      </span>
      <span className={`flex items-center gap-1 ${syncStyle.className}`} title={syncStyle.label}>
        <SyncIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {syncStyle.label}
        {status.ahead > 0 && (
          <span className="flex items-center gap-0.5 tabular-nums" aria-label={`${status.ahead} commits ahead`}>
            <ArrowUp className="h-3 w-3" aria-hidden="true" />
            {status.ahead}
          </span>
        )}
        {status.behind > 0 && (
          <span className="flex items-center gap-0.5 tabular-nums" aria-label={`${status.behind} commits behind`}>
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
            {status.behind}
          </span>
        )}
      </span>
      <span className="text-muted-foreground">
        {status.lastSyncAt ? formatRelativeTime(status.lastSyncAt) : 'Never synced'}
      </span>
      {canCommit && (
        <Button variant="outline" size="sm" onClick={onCommitClick}>
          <GitCommitHorizontal className="mr-2 h-4 w-4" aria-hidden="true" />
          Commit…
        </Button>
      )}
    </div>
  );
}
