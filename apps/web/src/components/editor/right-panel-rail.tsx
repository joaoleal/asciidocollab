'use client';
import { useRef } from 'react';
import { MessageSquare, SpellCheck, ChevronRight, ChevronLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RightPanelTab } from '@/hooks/use-editor-preferences';

interface RightPanelRailProperties {
  activeTab: RightPanelTab;
  // Called with the selected view id when the user activates a different tab.
  onTabChange: (tab: RightPanelTab) => void;
  // When provided, renders a collapse control at the TOP of the rail — always visible regardless of
  // the active view, so the panel can be collapsed from Writing as well as Comments.
  onCollapse?: () => void;
  // Per-view counts (open comments, writing issues). Zero/undefined renders no badge.
  commentCount?: number;
  writingCount?: number;
  // Whether the panel body is hidden. The rail itself stays mounted either way (see the component
  // docs); this only flips the top control between collapse and expand.
  collapsed?: boolean;
  // Reopens the panel body. Required for the collapsed rail to be more than decoration.
  onExpand?: () => void;
}

interface RailView {
  id: RightPanelTab;
  label: string;
  icon: LucideIcon;
}

// Data-driven view list, mirroring the left panel's rail: adding a view is a one-line append.
const VIEWS: readonly RailView[] = [
  { id: 'comments', label: 'Comments', icon: MessageSquare },
  { id: 'writing', label: 'Writing', icon: SpellCheck },
];

/**
 * The vertical ARIA tablist rail selecting the active right-panel view — the mirror image of the left
 * panel's rail, so both sides of the editor are navigated the same way. Icon-only, ~46px wide, with a
 * 2px primary accent bar on the active tab and roving ArrowUp/ArrowDown focus (WAI-ARIA vertical
 * tablist). The accent sits on the RIGHT edge here because the rail borders the window, not the body.
 *
 * Like the left rail, it stays visible while the panel is COLLAPSED, so the open-comment and writing
 * issue counts remain on screen and either view is one click away. While collapsed, activating a view
 * expands the panel onto that view.
 */
export function RightPanelRail({ activeTab, onTabChange, onCollapse, commentCount, writingCount, collapsed = false, onExpand }: RightPanelRailProperties) {
  const buttonReferences = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = VIEWS.findIndex((view) => view.id === activeTab);
  const countOf = (id: RightPanelTab): number | undefined => (id === 'comments' ? commentCount : writingCount);

  function moveFocus(nextIndex: number) {
    const wrapped = (nextIndex + VIEWS.length) % VIEWS.length;
    onTabChange(VIEWS[wrapped].id);
    if (collapsed) onExpand?.();
    buttonReferences.current[wrapped]?.focus();
  }

  // Activating a tab is a TOGGLE on the view that is already showing: a second click on the open
  // view collapses the panel, so the same button both opens and closes it. Any other view (or a
  // click while collapsed) opens the panel onto that view.
  function activate(id: RightPanelTab) {
    if (collapsed) {
      onTabChange(id);
      onExpand?.();
      return;
    }
    if (id === activeTab) {
      onCollapse?.();
      return;
    }
    onTabChange(id);
  }

  return (
    <div className="flex flex-col items-center gap-1 w-[46px] shrink-0 border-l py-2 bg-popover">
      {collapsed
        ? onExpand && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              data-testid="review-toggle"
              // Names the PANEL, not a view: this control is deliberately view-independent (it
              // collapses Writing exactly as it collapses Comments), so an accessible name of
              // "expand comments" described the wrong thing to every reader on the Writing tab.
              // Mirrors the left rail's "expand sidebar".
              aria-label="expand panel"
              title="Expand panel"
              onClick={onExpand}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )
        : onCollapse && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="collapse panel"
              title="Collapse panel"
              onClick={onCollapse}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label="Right panel views"
        className="flex flex-col items-center gap-1"
      >
        {VIEWS.map((view, index) => {
          const Icon = view.icon;
          const isActive = view.id === activeTab;
          const count = countOf(view.id);
          return (
            <button
              key={view.id}
              ref={(element) => { buttonReferences.current[index] = element; }}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls="right-panel-body"
              aria-label={view.label}
              title={view.label}
              data-testid={`right-panel-tab-${view.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => activate(view.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(activeIndex + 1); }
                else if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(activeIndex - 1); }
              }}
              className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              {isActive && (
                <span className="absolute right-0 top-1 bottom-1 w-0.5 rounded-full bg-primary" aria-hidden="true" />
              )}
              <Icon className="h-4 w-4" aria-hidden="true" />
              {count !== undefined && count > 0 && (
                <span
                  className="absolute -top-0.5 -left-0.5 min-w-[15px] rounded-full bg-primary px-1 text-[10px] font-medium leading-[15px] text-primary-foreground tabular-nums"
                  data-testid={`right-panel-count-${view.id}`}
                  aria-hidden="true"
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
