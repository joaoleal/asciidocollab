'use client';

import {
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  KeyRound,
  Unplug,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatRelativeTime } from '@/lib/format-relative-time';
import type { BehindAheadDto, GitStatusDto, GitSyncStatus } from '@asciidocollab/shared';

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
    case 'NEEDS_REAUTH': {
      // The stored credential was rejected — an attention state that steers the owner to rotate it.
      return { className: 'text-[hsl(var(--warning))]', label: 'Reconnect needed' };
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
  NEEDS_REAUTH: KeyRound,
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
  /**
   * The real ahead/behind commit counts from the behind-ahead endpoint, or null while unknown (not
   * yet loaded, or not connected). `status.ahead`/`status.behind` are a fixed-`0` placeholder and are
   * never rendered here.
   */
  behindAhead: BehindAheadDto | null;
  /** Whether the viewer may pull — shows the Pull button (when a pull is available) when true. */
  canPull: boolean;
  /** Called when the Pull button is clicked. */
  onPullClick: () => void;
  /** True while a pull is in flight — disables the Pull button. */
  pullPending?: boolean;
  /**
   * Called when the "Preview push" affordance is activated (shown only while `behindAhead.ahead > 0`).
   * Left undefined to hide the affordance entirely, e.g. while the caller has nothing to open yet.
   */
  onPreviewPushClick?: () => void;
  /** Whether the viewer may push — shows the Push button (when a push is available) when true. */
  canPush?: boolean;
  /** Called when the Push button is clicked. */
  onPushClick?: () => void;
  /** True while a push is in flight — disables the Push button. */
  pushPending?: boolean;
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
  behindAhead,
  canPull,
  onPullClick,
  pullPending = false,
  onPreviewPushClick,
  canPush = false,
  onPushClick,
  pushPending = false,
}: GitConnectionStatusBarProperties): React.JSX.Element | null {
  if (!connected) return null;
  if (loading && !status) return null;
  if (!status) return null;

  const syncStyle = syncStatusStyle(status.syncStatus);
  const SyncIcon = SYNC_STATUS_ICON[status.syncStatus];
  // A rejected credential ("Reconnect needed"): the ahead count still reports commits from the last
  // known remote head, but a push would fail auth immediately. Suppress the Push affordance so the
  // owner is steered to reconnect rather than into a guaranteed auth failure. Keyed on the same sync
  // status that drives the "Reconnect needed" label so the affordance and the label never disagree.
  const needsReauth = status.syncStatus === 'NEEDS_REAUTH';

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={`flex items-center gap-1 shrink-0 whitespace-nowrap ${syncStyle.className}`} title={syncStyle.label}>
        <SyncIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {syncStyle.label}
        {behindAhead !== null && behindAhead.ahead > 0 && (
          <span className="flex items-center gap-0.5 tabular-nums" aria-label={`${behindAhead.ahead} commits ahead`}>
            <ArrowUp className="h-3 w-3" aria-hidden="true" />
            {behindAhead.ahead}
          </span>
        )}
        {behindAhead !== null && behindAhead.behind > 0 && (
          <span className="flex items-center gap-0.5 tabular-nums" aria-label={`${behindAhead.behind} commits behind`}>
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
            {behindAhead.behind}
          </span>
        )}
      </span>
      <span className="text-muted-foreground shrink-0 whitespace-nowrap">
        {status.lastSyncAt ? formatRelativeTime(status.lastSyncAt) : 'Never synced'}
      </span>
      {onPreviewPushClick && behindAhead !== null && behindAhead.ahead > 0 && (
        <Button variant="outline" size="sm" onClick={onPreviewPushClick}>
          <ArrowUp className="mr-2 h-4 w-4" aria-hidden="true" />
          Preview push
        </Button>
      )}
      {canPush && !needsReauth && behindAhead !== null && behindAhead.behind === 0 && behindAhead.ahead > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={onPushClick}
          disabled={pushPending}
          aria-label={`ahead by ${behindAhead.ahead} — push available`}
        >
          <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
          {pushPending ? 'Pushing…' : 'Push'}
        </Button>
      )}
      {canPull && behindAhead !== null && behindAhead.behind > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={onPullClick}
          disabled={pullPending}
          aria-label={`behind by ${behindAhead.behind} — pull available`}
        >
          <GitPullRequestArrow className="mr-2 h-4 w-4" aria-hidden="true" />
          {pullPending ? 'Pulling…' : 'Pull'}
        </Button>
      )}
      {canCommit && (
        <Button variant="outline" size="sm" onClick={onCommitClick}>
          <GitCommitHorizontal className="mr-2 h-4 w-4" aria-hidden="true" />
          Commit…
        </Button>
      )}
    </div>
  );
}
