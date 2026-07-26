'use client';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type * as Y from 'yjs';
import type { CollabAuthRole, CreateAnchorInput, ReviewItemDto } from '@asciidocollab/shared';
import { Button } from '@/components/ui/button';
import { CommentRail, TaskPanel, type TaskMember } from '@/components/review';
import { PanelViewHeader } from './panel-view-header';
import { PanelViewTabs, type PanelViewTab } from './panel-view-tabs';

/** Which list the Comments view is showing: the open file's threads, or everything in the project. */
export type CommentsSubView = 'threads' | 'tasks';

const TABS: readonly PanelViewTab<CommentsSubView>[] = [
  { id: 'threads', label: 'This file', testId: 'comments-view-threads' },
  { id: 'tasks', label: 'All comments & tasks', testId: 'comments-view-tasks' },
];

interface CommentsPanelViewProperties {
  /** The sub-view currently showing. */
  view: CommentsSubView;
  /**
   * Called with the sub-view the user selected.
   *
   * @param view - The newly selected sub-view.
   */
  onViewChange: (view: CommentsSubView) => void;
  /** Whether there is anything for the prev/next walk to step through. */
  canStepThreads: boolean;
  /**
   * Step the active thread forwards or backwards through the document's threads.
   *
   * @param delta - +1 for the next thread, -1 for the previous one.
   */
  onStepThread: (delta: number) => void;
  /** The owning project id. */
  projectId: string;
  /** The open document's id. */
  documentId: string;
  /** The live shared Y.Doc backing the editor, or null before collab is ready. */
  ydoc: Y.Doc | null;
  /** The caller's collaboration role; `observer` renders both lists read-only. */
  role: CollabAuthRole;
  /** The signed-in user's id. */
  currentUserId: string;
  /** Whether the signed-in user owns the project (gates the project-wide bulk delete). */
  isProjectOwner: boolean;
  /** Gates the underlying fetches. */
  enabled: boolean;
  /** Project members shown in each task's assignee picker. */
  members: TaskMember[];
  /** A captured selection anchor pinning a new-comment composer at the top of the thread list. */
  pendingAnchor: CreateAnchorInput | null;
  /** Called when the pending new-comment composer is submitted or cancelled. */
  onPendingResolved: () => void;
  /** The hovered item id, shared with the editor's highlights. */
  hoveredItemId: string | null;
  /**
   * Setter paired with {@link CommentsPanelViewProperties.hoveredItemId}.
   *
   * @param id - The item id to mark hovered, or null to clear it.
   */
  setHoveredItemId: (id: string | null) => void;
  /** The active thread id, shared with the editor's highlights. */
  activeThreadId: string | null;
  /**
   * Setter paired with {@link CommentsPanelViewProperties.activeThreadId}.
   *
   * @param id - The thread root id to activate, or null to clear it.
   */
  setActiveThreadId: (id: string | null) => void;
  /**
   * Enters reattach mode for a detached item.
   *
   * @param itemId - The root item id the user wants to reattach.
   */
  onReattach: (itemId: string) => void;
  /** Called after any mutation made from the thread list, so the layout's shared state refreshes. */
  onMutated: () => void;
  /**
   * Opens a project-wide row's file and scrolls to its passage.
   *
   * @param item - The activated review item.
   */
  onNavigateToItem: (item: ReviewItemDto) => void;
}

/**
 * The right panel's Comments view: a "Comments" section header with the prev/next thread walk as its
 * header actions, a This file / All comments & tasks control row beneath it, and the selected list
 * filling the rest of the panel.
 *
 * It is the structural mirror of a left-panel view (Files, Outline, Search): the view owns its own
 * header, so the panel adds none and the view's name appears exactly once. The two lists it hosts
 * therefore render no title of their own — only their filters, counts and rows.
 *
 * @param properties - The sub-view state plus everything the two lists need.
 * @returns The Comments view element.
 */
export function CommentsPanelView({
  view,
  onViewChange,
  canStepThreads,
  onStepThread,
  projectId,
  documentId,
  ydoc,
  role,
  currentUserId,
  isProjectOwner,
  enabled,
  members,
  pendingAnchor,
  onPendingResolved,
  hoveredItemId,
  setHoveredItemId,
  activeThreadId,
  setActiveThreadId,
  onReattach,
  onMutated,
  onNavigateToItem,
}: CommentsPanelViewProperties) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PanelViewHeader title="Comments">
        {canStepThreads && (
          <>
            <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Previous comment" onClick={() => onStepThread(-1)}>
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Next comment" onClick={() => onStepThread(1)}>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </PanelViewHeader>

      <PanelViewTabs label="Comments view" tabs={TABS} active={view} onChange={onViewChange} />

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'threads' ? (
          <CommentRail
            projectId={projectId}
            documentId={documentId}
            ydoc={ydoc}
            role={role}
            currentUserId={currentUserId}
            enabled={enabled}
            members={members}
            pendingAnchor={pendingAnchor}
            onPendingResolved={onPendingResolved}
            hoveredItemId={hoveredItemId}
            setHoveredItemId={setHoveredItemId}
            activeThreadId={activeThreadId}
            setActiveThreadId={setActiveThreadId}
            onReattach={onReattach}
            onMutated={onMutated}
          />
        ) : (
          <TaskPanel
            projectId={projectId}
            currentUserId={currentUserId}
            isOwner={isProjectOwner}
            readOnly={role === 'observer'}
            enabled={enabled}
            onNavigate={onNavigateToItem}
          />
        )}
      </div>
    </div>
  );
}
