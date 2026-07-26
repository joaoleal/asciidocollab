'use client';

import { useCallback, useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { MessagesSquare, MoreHorizontal } from 'lucide-react';
import type { CollabAuthRole, CreateAnchorInput, ThreadDto } from '@asciidocollab/shared';
import { useReviewItems } from '@/hooks/use-review-items';
import { sortThreadsByDocumentOrder } from '@/lib/review/order';
import { cn } from '@/lib/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CommentComposer } from './composer';
import { ReviewThreadCard } from './thread-card';
import { ReviewStatusControl, ReviewTaskControls, RevertTaskAction, type TaskMember } from './task-controls';
import { DetachedTray, type DetachedTrayEntry } from './detached-tray';
import { BulkDeleteDocumentAction, DeleteItemAction } from './delete-controls';
import { useReviewViewStateOptional } from './view-state';

/** The three mutually-exclusive rail filters. Open is the default. */
type FilterMode = 'open' | 'all' | 'tasks';

/** The ordered filter tabs with their user-facing labels. */
const FILTERS: readonly { mode: FilterMode; label: string }[] = [
  { mode: 'open', label: 'Open' },
  { mode: 'all', label: 'All' },
  { mode: 'tasks', label: 'Tasks' },
];

/** Properties for {@link CommentRail}. */
export interface CommentRailProperties {
  /** The owning project id. */
  projectId: string;
  /** The document whose review threads to show. */
  documentId: string;
  /** The live shared Y.Doc backing the editor, or null before collab is ready. */
  ydoc: Y.Doc | null;
  /** The caller's collaboration role; `observer` renders the rail read-only. */
  role: CollabAuthRole;
  /** The signed-in user's id, used to gate the per-item Edit affordance to the author. */
  currentUserId?: string | null;
  /** Gates the underlying fetch (defaults to true). */
  enabled?: boolean;
  /**
   * A captured selection anchor for a brand-new comment. When present, the rail
   * shows the new-comment composer pinned at the top. Owned by the editor-wiring task.
   */
  pendingAnchor?: CreateAnchorInput | null;
  /** Called when the pending new-comment composer is submitted or cancelled. */
  onPendingResolved?: () => void;
  /** Hovered item id override; falls back to ambient view-state then local state. */
  hoveredItemId?: string | null;
  /**
   * Setter paired with {@link CommentRailProperties.hoveredItemId}.
   *
   * @param id - The item id to mark hovered, or null to clear it.
   */
  setHoveredItemId?: (id: string | null) => void;
  /** Active thread id override; falls back to ambient view-state then local state. */
  activeThreadId?: string | null;
  /**
   * Setter paired with {@link CommentRailProperties.activeThreadId}.
   *
   * @param id - The thread root id to activate, or null to clear it.
   */
  setActiveThreadId?: (id: string | null) => void;
  /**
   * The project members shown in each task's assignee picker (T034). Sourcing is left to the
   * editor-wiring task; an empty list still renders the "Unassigned" option.
   */
  members?: TaskMember[];
  /**
   * Enters reattach mode for a detached item (T040); the editor-wiring task captures a new
   * selection and calls {@link reanchorReviewItem}. Left undefined hides the Reattach affordance.
   *
   * @param itemId - The root item id the user wants to reattach.
   */
  onReattach?: (itemId: string) => void;
  /**
   * Called after any mutation made from the rail, in addition to the rail's own re-fetch. The layout
   * wires this to its shared review-items instance so the editor highlights, open-count badge, and
   * prev/next navigation refresh immediately rather than waiting for the round-trip SSE signal.
   */
  onMutated?: () => void;
}

/** Applies the current filter to the fetched threads (server already handles resolved). */
function filterThreads(threads: ThreadDto[], mode: FilterMode): ThreadDto[] {
  if (mode === 'tasks') return threads.filter((thread) => thread.root.kind === 'task');
  return threads;
}

/**
 * The slim right-side review rail: the open document's threads under a single toolbar row holding an
 * Open / All / Tasks segmented filter (wired to the hook's `includeResolved` plus a tasks-only view),
 * the live item count, and the document-scope overflow menu. It renders no title of its own — the
 * Comments view's panel header names it once — so the rail is all list and no chrome. When a
 * `pendingAnchor` is supplied it pins a new-comment composer at the top. It consumes
 * {@link useReviewItems} for data and links to the editor via the ambient
 * {@link useReviewViewStateOptional} view-state (overridable by props).
 */
export function CommentRail({
  projectId,
  documentId,
  ydoc,
  role,
  currentUserId,
  enabled = true,
  pendingAnchor,
  onPendingResolved,
  hoveredItemId,
  setHoveredItemId,
  activeThreadId,
  setActiveThreadId,
  members = [],
  onReattach,
  onMutated,
}: CommentRailProperties) {
  const readOnly = role === 'observer';
  const { threads, ranges, anchorStates, loading, error, refetch, setIncludeResolved } = useReviewItems({
    projectId,
    documentId,
    ydoc,
    enabled,
  });

  // Every rail mutation refreshes both the rail's own instance and the layout's shared instance (which
  // drives the editor highlights + count), so the two surfaces never disagree between SSE round-trips.
  const handleRefetch = useCallback(() => {
    refetch();
    onMutated?.();
  }, [refetch, onMutated]);

  const [mode, setMode] = useState<FilterMode>('open');

  // Only the "Open" view hides resolved items; All and Tasks include them.
  useEffect(() => {
    setIncludeResolved(mode !== 'open');
  }, [mode, setIncludeResolved]);

  // Resolve view-state: explicit props win, then ambient context, then local fallback.
  const ambient = useReviewViewStateOptional();
  const [localHovered, setLocalHovered] = useState<string | null>(null);
  const [localActive, setLocalActive] = useState<string | null>(null);
  const effectiveHovered = hoveredItemId ?? ambient?.hoveredItemId ?? localHovered;
  const effectiveSetHovered = setHoveredItemId ?? ambient?.setHoveredItemId ?? setLocalHovered;
  const effectiveActive = activeThreadId ?? ambient?.activeThreadId ?? localActive;
  const effectiveSetActive = setActiveThreadId ?? ambient?.setActiveThreadId ?? setLocalActive;

  // Document order, not creation order: the rail reads top-to-bottom like the document does. The rule
  // is shared with the cross-file panel and the prev/next thread walk (see `@/lib/review/order`), and
  // the split below preserves it in both the card list and the detached tray.
  const visible = sortThreadsByDocumentOrder(filterThreads(threads, mode), ranges);

  // Detached items can't be pinned in the document, so they surface in the tray instead of the list;
  // section-degraded items stay in the list with an inline indicator (T040).
  const cards: ThreadDto[] = [];
  const detached: DetachedTrayEntry[] = [];
  for (const thread of visible) {
    if (anchorStates.get(thread.root.id) === 'detached') {
      detached.push({ item: thread.root, state: 'detached' });
    } else {
      cards.push(thread);
    }
  }

  return (
    <section
      data-testid="comment-rail"
      aria-label="Comments and tasks"
      className="flex h-full min-w-0 flex-col bg-background"
    >
      {/* Toolbar: filters, the live count and the document-scope ⋯ menu on ONE row. The list carries
          no title of its own — the Comments view's panel header names it once, above this rail. */}
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <div
          role="tablist"
          aria-label="Filter comments"
          className="flex min-w-0 flex-1 items-center gap-0.5 rounded-md bg-muted p-0.5"
        >
          {FILTERS.map((filter) => (
            <button
              key={filter.mode}
              type="button"
              role="tab"
              aria-selected={mode === filter.mode}
              onClick={() => setMode(filter.mode)}
              className={cn(
                'flex-1 rounded-sm px-2 py-0.5 text-xs font-medium transition-colors',
                mode === filter.mode
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <span
          className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
          data-testid="comment-rail-count"
        >
          {visible.length}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Comment options"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {readOnly ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No actions</div>
            ) : (
              <BulkDeleteDocumentAction
                projectId={projectId}
                documentId={documentId}
                count={threads.length}
                onDeleted={handleRefetch}
              />
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Body. */}
      <div className="flex-1 overflow-y-auto p-2">
        {/* New-comment composer for a captured selection. */}
        {!readOnly && pendingAnchor && (
          <div className="mb-2 rounded-lg border bg-card p-2">
            <CommentComposer
              mode="new"
              projectId={projectId}
              documentId={documentId}
              anchor={pendingAnchor}
              autoFocus
              placeholder="Add a comment…"
              setActiveThreadId={effectiveSetActive}
              onSubmitted={() => {
                handleRefetch();
                onPendingResolved?.();
              }}
              onCancel={() => onPendingResolved?.()}
            />
          </div>
        )}

        {error && (
          <p className="px-2 py-4 text-xs text-destructive" role="alert">
            Couldn&apos;t load comments. {error.message}
          </p>
        )}

        {!error && visible.length === 0 && !loading && (
          <div
            className="flex flex-col items-center gap-1 px-4 py-10 text-center text-xs text-muted-foreground"
            data-testid="comment-rail-empty"
          >
            <MessagesSquare className="h-6 w-6" aria-hidden="true" />
            <p>{mode === 'tasks' ? 'No tasks yet.' : 'No comments yet.'}</p>
            {!readOnly && !pendingAnchor && (
              <p className="text-[11px]">Select text in the document to start a thread.</p>
            )}
          </div>
        )}

        {/* Detached items whose passage no longer resolves (T040). */}
        <DetachedTray
          projectId={projectId}
          entries={detached}
          readOnly={readOnly}
          onReattach={onReattach}
          onChanged={handleRefetch}
        />

        <div className="flex flex-col gap-2">
          {cards.map((thread) => (
            <ReviewThreadCard
              key={thread.root.id}
              projectId={projectId}
              thread={thread}
              readOnly={readOnly}
              currentUserId={currentUserId}
              onChanged={handleRefetch}
              hoveredItemId={effectiveHovered}
              activeThreadId={effectiveActive}
              setHoveredItemId={effectiveSetHovered}
              setActiveThreadId={effectiveSetActive}
              anchorState={anchorStates.get(thread.root.id)}
              statusControl={
                <ReviewStatusControl
                  projectId={projectId}
                  item={thread.root}
                  readOnly={readOnly}
                  onChanged={handleRefetch}
                />
              }
              taskControls={
                <ReviewTaskControls
                  projectId={projectId}
                  item={thread.root}
                  members={members}
                  readOnly={readOnly}
                  onChanged={handleRefetch}
                />
              }
              itemMenuExtra={
                <>
                  <RevertTaskAction
                    projectId={projectId}
                    item={thread.root}
                    readOnly={readOnly}
                    onChanged={handleRefetch}
                  />
                  <DeleteItemAction projectId={projectId} itemId={thread.root.id} onDeleted={handleRefetch} />
                </>
              }
            />
          ))}
        </div>
      </div>
    </section>
  );
}
