'use client';

import type { FileGitStatus } from '@asciidocollab/shared';
import type { FileTreeNode } from './types';

/** A git status's rendered style: the tokenized dot className plus its accessible label. */
export interface GitStatusBadgeStyle {
  /** Tailwind classes for the dot, built from design tokens only (no hardcoded colors). */
  className: string;
  /** Human-readable label — both the accessible name and the visible tooltip. */
  label: string;
}

/**
 * Maps a file's git status to its badge style, or `null` for `'unchanged'` (no badge — most files in
 * a project are unchanged, so the tree stays quiet by default). Pure and exported for unit testing.
 * Colors come from design tokens (CSS vars / the `destructive` theme color) so the badge reads
 * correctly in both light and dark themes.
 */
export function gitStatusBadgeStyle(status: FileGitStatus): GitStatusBadgeStyle | null {
  switch (status) {
    case 'modified': {
      return { className: 'bg-[hsl(var(--warning))]', label: 'Modified' };
    }
    case 'staged': {
      return { className: 'bg-[hsl(var(--success))]', label: 'Staged' };
    }
    case 'untracked': {
      return { className: 'bg-[hsl(var(--info))]', label: 'Untracked' };
    }
    case 'removed': {
      return { className: 'bg-destructive', label: 'Removed' };
    }
    case 'conflicted': {
      return { className: 'bg-destructive', label: 'Conflicted' };
    }
    case 'unchanged': {
      return null;
    }
  }
}

/**
 * Descendant-file statuses that mean a folder gets a roll-up badge, most urgent first. A folder shows
 * whichever of these is present among its descendants, in this order — e.g. one conflicted file
 * outranks any number of merely-staged ones.
 */
const FOLDER_ROLLUP_PRECEDENCE: readonly FileGitStatus[] = ['conflicted', 'removed', 'modified', 'untracked', 'staged'];

/**
 * Aggregates a folder's descendant FILE statuses (recursively, at any depth) into the single status
 * its roll-up badge should show, or `null` when every descendant is unchanged (or absent from the
 * map) — no folder badge in that case. When multiple descendants carry different statuses, the
 * highest-precedence one wins (see {@link FOLDER_ROLLUP_PRECEDENCE}). Pure and exported for unit
 * testing; O(subtree) per folder, which is fine for these tree sizes.
 */
export function rollUpFolderStatus(
  node: FileTreeNode,
  statusByFileNodeId: Readonly<Record<string, FileGitStatus>>,
): FileGitStatus | null {
  const found = new Set<FileGitStatus>();
  const walk = (current: FileTreeNode): void => {
    for (const child of current.children) {
      if (child.type === 'file') {
        const status = statusByFileNodeId[child.id];
        if (status && status !== 'unchanged') found.add(status);
      } else {
        walk(child);
      }
    }
  };
  walk(node);

  return FOLDER_ROLLUP_PRECEDENCE.find((status) => found.has(status)) ?? null;
}

/** Props for {@link GitStatusBadge}. */
export interface GitStatusBadgeProperties {
  /** The file or folder's current (or, for a folder, rolled-up) git status. */
  status: FileGitStatus;
  /**
   * True for a folder's aggregate badge (from {@link rollUpFolderStatus}) rather than a file's own
   * status — adjusts the accessible label/tooltip to say so, e.g. "Contains changes: Modified".
   */
  rollup?: boolean;
}

/**
 * A small colored dot conveying a file's (or folder's rolled-up) git status in the file tree
 * (modified, staged, …). Renders nothing for an unchanged status. Unlike the decorative
 * grammar-status dot, this dot itself carries information, so it gets an accessible name
 * (`role="img"` + `aria-label`) and a native tooltip rather than being hidden from assistive tech.
 */
export function GitStatusBadge({ status, rollup = false }: GitStatusBadgeProperties): React.JSX.Element | null {
  const style = gitStatusBadgeStyle(status);
  if (!style) return null;

  const label = rollup ? `Contains changes: ${style.label}` : style.label;

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${style.className}`}
    />
  );
}
