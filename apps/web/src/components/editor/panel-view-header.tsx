'use client';
import type { ReactNode } from 'react';

interface PanelViewHeaderProperties {
  /** The view's name, rendered as the small uppercase label. */
  title: string;
  /** Actions for this view, pushed to the right edge of the header row. */
  children?: ReactNode;
}

/**
 * The section header every editor panel view opens with: a small uppercase, letter-spaced, muted
 * label on a fixed 36px bottom-bordered row, with the view's own actions pushed to the right edge.
 *
 * It exists so both panels share ONE definition of that row — the left panel grew three hand-written
 * copies of it (Files, Outline, Search) and the right panel had none, which is why the two sides read
 * as different products. The panel container adds no title of its own (see {@link LeftPanel}), so a
 * view rendering this header is the single place its name appears.
 *
 * @param properties - The view title and its optional header actions.
 * @returns The header row element.
 */
export function PanelViewHeader({ title, children }: PanelViewHeaderProperties) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b px-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
      {children && <div className="ml-auto flex items-center gap-0.5">{children}</div>}
    </div>
  );
}
