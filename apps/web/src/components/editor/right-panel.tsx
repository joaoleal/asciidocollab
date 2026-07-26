'use client';
import type { ReactNode } from 'react';
import type { RightPanelTab } from '@/hooks/use-editor-preferences';
import { RightPanelRail } from './right-panel-rail';

interface RightPanelProperties {
  activeTab: RightPanelTab;
  // Called with the selected view id when the user activates a different tab via the rail.
  onTabChange: (tab: RightPanelTab) => void;
  // Collapses the whole panel; rendered on the rail so it works from any view.
  onCollapse?: () => void;
  // Counts surfaced as rail badges so the other view's activity is visible without switching to it.
  commentCount?: number;
  writingCount?: number;
  commentsSlot: ReactNode;
  writingSlot: ReactNode;
}

/**
 * The editor right panel: a vertical view rail beside a content body, mirroring {@link LeftPanel} so
 * both sides of the editor behave identically. The rail sits on the far right (against the window)
 * with the body to its left.
 *
 * As on the left, BOTH slots render at once and the inactive one carries the `hidden` class, so
 * neither view ever unmounts — the comment list keeps its scroll position and open thread across a
 * switch to Writing and back, and neither switch remounts the editor.
 *
 * Each view owns its OWN header and controls — {@link CommentsPanelView}'s "Comments" header with the
 * prev/next thread walk, {@link WritingPanelView}'s "Writing" header — exactly as the left panel's
 * views do, so the panel adds neither a title row nor a control row of its own. That keeps a view's
 * name from appearing twice, and keeps a view's controls on screen only while that view is active
 * rather than in one shared strip mixing both features' options.
 */
export function RightPanel({
  activeTab,
  onTabChange,
  onCollapse,
  commentCount,
  writingCount,
  commentsSlot,
  writingSlot,
}: RightPanelProperties) {
  return (
    <div className="flex h-full overflow-hidden">
      <div id="right-panel-body" className="flex flex-1 flex-col overflow-hidden">
        <div className={`flex h-full flex-col overflow-hidden ${activeTab === 'comments' ? '' : 'hidden'}`}>
          {commentsSlot}
        </div>
        <div className={`flex h-full flex-col overflow-hidden ${activeTab === 'writing' ? '' : 'hidden'}`}>
          {writingSlot}
        </div>
      </div>
      <RightPanelRail
        activeTab={activeTab}
        onTabChange={onTabChange}
        onCollapse={onCollapse}
        commentCount={commentCount}
        writingCount={writingCount}
      />
    </div>
  );
}
