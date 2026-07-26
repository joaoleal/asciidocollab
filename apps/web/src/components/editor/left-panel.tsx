'use client';
import type { ReactNode } from 'react';
import type { LeftPanelTab } from '@/hooks/use-editor-preferences';
import { LeftPanelRail } from './left-panel-rail';

interface LeftPanelProperties {
  activeTab: LeftPanelTab;
  // Called with the selected view id when the user activates a different tab via the rail.
  onTabChange: (tab: LeftPanelTab) => void;
  // Collapses the whole panel; rendered on the rail so it works from any view.
  onCollapse?: () => void;
  // Whether the body is hidden. The rail stays visible either way — see the component docs.
  collapsed?: boolean;
  // Reopens the body, from the rail's expand control or from activating a view.
  onExpand?: () => void;
  filesSlot: ReactNode;
  outlineSlot: ReactNode;
  searchSlot: ReactNode;
}

/**
 * The editor left panel (028): a vertical view rail beside a content body that renders BOTH slots at
 * once — the inactive one carries the `hidden` class so neither ever unmounts. That keeps the file
 * tree's scroll/expansion alive across a view switch and guarantees the editor/preview never remount.
 *
 * Each view owns its OWN header (the file tree's "Files" header with its create/options actions, the
 * Outline view's "Outline" header), so the panel adds no title row of its own — that avoids showing
 * the active title twice. File actions therefore appear only while Files is active.
 *
 * Collapsing hides only the BODY: the rail stays on screen as the editor's activity bar, so the
 * views stay visible and one click away. The body's slots stay mounted while collapsed too, so the
 * file tree keeps its scroll position and expanded folders across a collapse/expand cycle.
 */
export function LeftPanel({ activeTab, onTabChange, onCollapse, collapsed = false, onExpand, filesSlot, outlineSlot, searchSlot }: LeftPanelProperties) {
  return (
    <div className="flex h-full overflow-hidden">
      <LeftPanelRail
        activeTab={activeTab}
        onTabChange={onTabChange}
        onCollapse={onCollapse}
        collapsed={collapsed}
        onExpand={onExpand}
      />
      <div id="left-panel-body" className={`flex flex-1 flex-col overflow-hidden ${collapsed ? 'hidden' : ''}`}>
        <div className={`h-full overflow-y-auto ${activeTab === 'files' ? '' : 'hidden'}`}>
          {filesSlot}
        </div>
        <div className={`h-full overflow-y-auto ${activeTab === 'outline' ? '' : 'hidden'}`}>
          {outlineSlot}
        </div>
        <div className={`h-full overflow-hidden ${activeTab === 'search' ? '' : 'hidden'}`}>
          {searchSlot}
        </div>
      </div>
    </div>
  );
}
