'use client';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utilities';

/** One selectable sub-view of a panel view. */
export interface PanelViewTab<Id extends string> {
  /** The sub-view id reported to `onChange`. */
  id: Id;
  /** The user-facing label. */
  label: string;
  /** Optional test id kept stable across restyles (e2e specs select on it). */
  testId?: string;
}

interface PanelViewTabsProperties<Id extends string> {
  /** Accessible name for the tablist. */
  label: string;
  /** The ordered tabs. */
  tabs: readonly PanelViewTab<Id>[];
  /** The currently selected tab id. */
  active: Id;
  /**
   * Called with the newly selected tab id.
   *
   * @param id - The tab the user activated.
   */
  onChange: (id: Id) => void;
  /** Extra controls rendered at the right edge of the same row. */
  children?: ReactNode;
}

/**
 * The control row a panel view puts UNDER its {@link PanelViewHeader} when it has mutually exclusive
 * sub-views: an ARIA tablist of small text tabs on a bottom-bordered row, at the same type scale as
 * every other piece of panel chrome.
 *
 * The row is deliberately separate from the header rather than standing in for it — the sub-view
 * labels are long enough ("All comments & tasks") that they would crowd the title out at the panel's
 * minimum width, so the header keeps announcing the view and this row switches within it.
 *
 * @param properties - The tabs, the active id, and the change handler.
 * @returns The control row element.
 */
export function PanelViewTabs<Id extends string>({ label, tabs, active, onChange, children }: PanelViewTabsProperties<Id>) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
      <div role="tablist" aria-label={label} className="flex min-w-0 flex-wrap items-center gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            data-testid={tab.testId}
            onClick={() => onChange(tab.id)}
            className={cn(
              'rounded px-2 py-0.5 text-xs font-medium transition-colors',
              active === tab.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {children && <div className="ml-auto flex items-center gap-0.5">{children}</div>}
    </div>
  );
}
