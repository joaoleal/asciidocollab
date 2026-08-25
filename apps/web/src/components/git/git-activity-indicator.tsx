'use client';

import { AlertTriangle, Loader2, type LucideIcon } from 'lucide-react';
import type { GitOperationKind, GitOperationState, GitOperationStatusDto } from '@asciidocollab/shared';

/** Friendly label for each kind of whole-project git operation, used by the activity indicator. */
const OPERATION_KIND_LABELS: Readonly<Record<GitOperationKind, string>> = {
  IMPORT: 'Import',
  INITIALIZE: 'Initialize',
  CONNECT: 'Connect',
  DISCONNECT: 'Disconnect',
  COMMIT: 'Commit',
  PUSH: 'Push',
  PULL: 'Pull',
  FETCH: 'Fetch',
  BRANCH_CREATE: 'Branch create',
  BRANCH_SWITCH: 'Branch switch',
  RESOLVE: 'Resolve',
  DISCARD: 'Discard',
  AMEND: 'Amend',
  UNDO_PULL: 'Undo pull',
};

/** The `GitOperationState` values that count as "activity" for the indicator; every other state renders nothing. */
const ACTIVE_STATES: ReadonlySet<GitOperationState> = new Set(['QUEUED', 'RUNNING', 'AWAITING_CONFLICT']);

/** An active operation's rendered style: the tokenized text className, its label, and its icon. */
export interface GitActivityStyle {
  /** Tailwind classes for the label's text color, built from design tokens only (no hardcoded colors). */
  className: string;
  /** Human-readable label — both the accessible name and the visible text. */
  label: string;
  /** The icon to render alongside the label. */
  icon: LucideIcon;
  /** Whether the icon should spin — true for actively-running work, false for a paused/waiting state. */
  spinning: boolean;
}

/**
 * Maps an operation to the indicator's rendered style, or null when the operation's state is not
 * one that counts as "activity" (a terminal state — should not normally reach here, since the
 * active-operation endpoint only ever returns `QUEUED`/`RUNNING`/`AWAITING_CONFLICT` operations, but
 * this stays defensive rather than assuming that). Pure and exported for unit testing, mirroring
 * `syncStatusStyle`'s pattern — kept JSX-free so it can be tested without rendering.
 */
export function gitActivityStyle(operation: GitOperationStatusDto): GitActivityStyle | null {
  if (!ACTIVE_STATES.has(operation.state)) return null;

  const kindLabel = OPERATION_KIND_LABELS[operation.kind];

  if (operation.state === 'AWAITING_CONFLICT') {
    return {
      className: 'text-[hsl(var(--warning))]',
      label: `${kindLabel} paused — conflicts`,
      icon: AlertTriangle,
      spinning: false,
    };
  }

  // QUEUED and RUNNING both read as "in progress" to a member watching from outside — the
  // distinction between waiting-to-start and actively-running isn't meaningful at this signal's
  // granularity.
  return {
    className: 'text-[hsl(var(--info))]',
    label: `Git activity: ${kindLabel} in progress`,
    icon: Loader2,
    spinning: true,
  };
}

/** Props for {@link GitActivityIndicator}. */
export interface GitActivityIndicatorProperties {
  /** The project's current active operation, or null when none is active. */
  activeOperation: GitOperationStatusDto | null;
}

/**
 * Compact presence-style indicator showing that a whole-project git operation (started by any
 * member, or the system) is currently running for the project. Renders nothing when there is no
 * active operation. Mounted next to the git connection status bar in the editor header, reusing
 * that same presence surface rather than adding a new one.
 */
export function GitActivityIndicator({
  activeOperation,
}: GitActivityIndicatorProperties): React.JSX.Element | null {
  if (!activeOperation) return null;

  const style = gitActivityStyle(activeOperation);
  if (!style) return null;

  const Icon = style.icon;

  return (
    <span className={`flex items-center gap-1 text-sm ${style.className}`} role="status">
      <Icon className={`h-3.5 w-3.5 ${style.spinning ? 'animate-spin' : ''}`} aria-hidden="true" />
      {style.label}
    </span>
  );
}
