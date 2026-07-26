'use client';
import { useRef } from 'react';
import { FolderTree, ListTree, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LeftPanelTab } from '@/hooks/use-editor-preferences';

interface LeftPanelRailProperties {
  activeTab: LeftPanelTab;
  // Called with the selected view id when the user activates a different tab.
  onTabChange: (tab: LeftPanelTab) => void;
  // When provided, renders a collapse control at the TOP of the rail — always visible regardless of
  // the active view, so the panel can be collapsed from Outline as well as Files.
  onCollapse?: () => void;
  // Whether the panel body is hidden. The rail itself stays mounted either way (see the component
  // docs); this only flips the top control between collapse and expand.
  collapsed?: boolean;
  // Reopens the panel body. Required for the collapsed rail to be more than decoration.
  onExpand?: () => void;
}

interface RailView {
  id: LeftPanelTab;
  label: string;
  icon: LucideIcon;
}

// Data-driven view list: adding a third view (e.g. search/history) is a one-line append, no
// redesign — the rail, roving focus, and rendering all derive from this array.
const VIEWS: readonly RailView[] = [
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'outline', label: 'Outline', icon: ListTree },
  { id: 'search', label: 'Search', icon: Search },
];

/**
 * The vertical ARIA tablist rail selecting the active left-panel view (028). Icon-only, ~46px wide,
 * with a 2px primary accent bar on the active tab. Roving focus: ArrowUp/ArrowDown move (and wrap)
 * between tabs, mirroring the WAI-ARIA vertical tablist pattern.
 *
 * The rail stays visible while the panel is COLLAPSED — it is the editor's activity bar, not part of
 * the panel body. Collapsing therefore hides the content and keeps the views one click away, instead
 * of swapping the whole thing for an anonymous chevron strip that says nothing about what is behind
 * it. While collapsed, activating a view expands the panel onto that view.
 */
export function LeftPanelRail({ activeTab, onTabChange, onCollapse, collapsed = false, onExpand }: LeftPanelRailProperties) {
  const buttonReferences = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = VIEWS.findIndex((view) => view.id === activeTab);

  function moveFocus(nextIndex: number) {
    const wrapped = (nextIndex + VIEWS.length) % VIEWS.length;
    onTabChange(VIEWS[wrapped].id);
    if (collapsed) onExpand?.();
    buttonReferences.current[wrapped]?.focus();
  }

  // Activating a tab is a TOGGLE on the view that is already showing: a second click on the open
  // view collapses the panel, so the same button both opens and closes it. Any other view (or a
  // click while collapsed) opens the panel onto that view.
  function activate(id: LeftPanelTab) {
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
    <div className="flex flex-col items-center gap-1 w-[46px] shrink-0 border-r py-2 bg-popover">
      {collapsed
        ? onExpand && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="expand sidebar"
              title="Expand panel"
              onClick={onExpand}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          )
        : onCollapse && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="collapse sidebar"
              title="Collapse panel"
              onClick={onCollapse}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label="Left panel views"
        className="flex flex-col items-center gap-1"
      >
        {VIEWS.map((view, index) => {
        const Icon = view.icon;
        const isActive = view.id === activeTab;
        return (
          <button
            key={view.id}
            ref={(element) => { buttonReferences.current[index] = element; }}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls="left-panel-body"
            aria-label={view.label}
            title={view.label}
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
              <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-primary" aria-hidden="true" />
            )}
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        );
      })}
      </div>
    </div>
  );
}
