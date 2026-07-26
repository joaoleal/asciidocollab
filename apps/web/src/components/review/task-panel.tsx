'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, MessagesSquare, MoreHorizontal } from 'lucide-react';
import type { ReviewItemDto, ReviewItemKind, ReviewItemStatus } from '@asciidocollab/shared';
import { listProjectReviewItems } from '@/lib/api/review';
import { classifyDueDate, dueDateTextClass, formatDueDate } from '@/lib/review/due-date';
import { sortReviewItemsByDocumentOrder } from '@/lib/review/order';
import { STATUS_LABELS, STATUS_VARIANTS } from '@/lib/review/status';
import { useFileTreeEvents } from '@/hooks/use-file-tree-events';
import { cn } from '@/lib/utilities';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ReviewAvatar } from './thread-card';
import { ProjectBulkDeleteButton } from './delete-controls';

/** The status filter options, including an "All" sentinel. */
type StatusFilter = ReviewItemStatus | 'all';

/** The ordered status filter tabs with their user-facing labels. */
const STATUS_FILTERS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'wontfix', label: "Won't fix" },
];

/** The kind filter options — the list spans both comments and tasks, so it can be narrowed to either. */
type KindFilter = ReviewItemKind | 'all';

/** The ordered kind filter tabs with their user-facing labels. */
const KIND_FILTERS: readonly { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'comment', label: 'Comments' },
  { value: 'task', label: 'Tasks' },
];

/** A document reference used to label and filter the panel's document dropdown. */
export interface TaskPanelDocument {
  /** The document id. */
  id: string;
  /** A human-readable document name/title. */
  name: string;
}

/** Properties for {@link TaskPanel}. */
export interface TaskPanelProperties {
  /** The owning project id. */
  projectId: string;
  /** The current user's id, used by the "Assigned to me" toggle. */
  currentUserId: string;
  /**
   * Extra document labels to seed the document filter with. The list itself now carries each item's
   * file name, so this is optional; it only pre-populates the dropdown before any item is loaded.
   */
  documents?: TaskPanelDocument[];
  /** Whether the caller owns the project (gates the project-wide bulk delete, T049). */
  isOwner?: boolean;
  /** When true, hides every mutation control (viewer/observer mode, T043). */
  readOnly?: boolean;
  /** Gates the underlying fetch (defaults to true). */
  enabled?: boolean;
  /**
   * Called when a row is activated so the owner can open the item's file and scroll to its passage.
   * When omitted the rows render as plain, non-interactive summaries.
   *
   * @param item - The activated review item (carries `fileNodeId`/`documentId` for the jump).
   */
  onNavigate?: (item: ReviewItemDto) => void;
}

/**
 * The project-wide, cross-document list of comments AND tasks. It filters by "Assigned to me",
 * kind (comment/task), status, and document, fetching through the frozen {@link listProjectReviewItems}
 * client fn on every server-side filter change (kind is applied client-side). Each row surfaces its
 * file, passage, status, assignee, and due date, and — when `onNavigate` is wired — opens that file
 * and scrolls to the passage on click. Owners see the project-wide bulk-delete control (T049);
 * `readOnly` hides every mutation. Like the per-document rail it renders no title of its own — the
 * Comments view's panel header names it once, above whichever list is showing.
 */
export function TaskPanel({
  projectId,
  currentUserId,
  documents = [],
  isOwner = false,
  readOnly = false,
  enabled = true,
  onNavigate,
}: TaskPanelProperties) {
  const [items, setItems] = useState<ReviewItemDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const [assignedToMe, setAssignedToMe] = useState(false);
  const [kind, setKind] = useState<KindFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [documentId, setDocumentId] = useState<string>('all');

  // Document labels accumulate across fetches (keyed by document id) so filtering the list down to one
  // document never empties the document dropdown — every file seen so far stays selectable.
  const [documentLabels, setDocumentLabels] = useState<Record<string, string>>(() =>
    Object.fromEntries(documents.map((document) => [document.id, document.name])),
  );
  const documentName = useCallback((id: string) => documentLabels[id] ?? id, [documentLabels]);

  // Rows show root items only (the project list returns replies too, but the cross-document panel is
  // a list of threads, not individual reply rows) narrowed by the client-side kind filter. `items`
  // stays the full server set — including replies — because the project bulk-delete guard compares
  // against the server's all-rows `countByProject`. The rows are then put in document order (file,
  // then anchor position) by the rule shared with the per-file rail — the server returns them in no
  // defined order at all.
  const visibleItems = useMemo(
    () =>
      sortReviewItemsByDocumentOrder(
        items.filter((item) => !item.parentId && (kind === 'all' || item.kind === kind)),
      ),
    [items, kind],
  );

  // The project-wide count only equals `items.length` when nothing is narrowing the list.
  const filtersActive = assignedToMe || kind !== 'all' || status !== 'all' || documentId !== 'all';

  const fetchItems = useCallback(async () => {
    if (!enabled || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listProjectReviewItems(projectId, {
        assigneeId: assignedToMe ? currentUserId : undefined,
        status: status === 'all' ? undefined : status,
        documentId: documentId === 'all' ? undefined : documentId,
      });
      setItems(result);
      setDocumentLabels((previous) => {
        const next = { ...previous };
        for (const item of result) if (item.fileName) next[item.documentId] = item.fileName;
        return next;
      });
    } catch (error_) {
      setError(error_ instanceof Error ? error_ : new Error('Failed to load comments and tasks'));
    } finally {
      setLoading(false);
    }
  }, [enabled, projectId, assignedToMe, currentUserId, status, documentId]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  // Stay in sync with everyone else: any review change on the project SSE stream (from any document)
  // refetches, so the cross-document list is live rather than a manual snapshot. Debounced so a burst
  // of events (many collaborators, a bulk operation) coalesces into a single project-wide refetch.
  const refetchTimerReference = useRef<ReturnType<typeof setTimeout> | null>(null);
  useFileTreeEvents(projectId, {
    onReviewItemsChanged: () => {
      if (refetchTimerReference.current) clearTimeout(refetchTimerReference.current);
      refetchTimerReference.current = setTimeout(() => void fetchItems(), 250);
    },
  });
  useEffect(() => () => {
    if (refetchTimerReference.current) clearTimeout(refetchTimerReference.current);
  }, []);

  const documentOptions = useMemo(
    () => Object.entries(documentLabels).toSorted((a, b) => a[1].localeCompare(b[1])),
    [documentLabels],
  );

  /** The ⋯ menu body: the owner-only project-wide delete, a "clear filters" hint, or "No actions". */
  const renderMenuContent = () => {
    if (readOnly || !isOwner) {
      return <div className="px-2 py-1.5 text-sm text-muted-foreground">No actions</div>;
    }
    if (filtersActive) {
      // The delete removes every item in the project, so it stays exact only with no filter
      // narrowing the count below the true total.
      return (
        <div className="max-w-[15rem] px-2 py-1.5 text-xs text-muted-foreground">
          Clear the filters to delete every comment and task across the project.
        </div>
      );
    }
    return (
      <ProjectBulkDeleteButton
        projectId={projectId}
        count={items.length}
        isOwner={isOwner}
        readOnly={readOnly}
        onDeleted={() => void fetchItems()}
      />
    );
  };

  return (
    <section
      data-testid="task-panel"
      aria-label="Project comments and tasks"
      className="flex h-full min-w-0 flex-col bg-background"
    >
      {/* Filters. The list carries no title of its own — the Comments view's panel header names it
          once, above this list. The kind filter shares its row with the count and the ⋯ menu. */}
      <div className="flex flex-col gap-1 border-b px-2 py-1">
        <div className="flex items-center gap-1">
          {/* Comments / Tasks kind filter. */}
          <div
            role="tablist"
            aria-label="Filter by kind"
            className="flex min-w-0 flex-1 items-center gap-0.5 rounded-md bg-muted p-0.5"
          >
            {KIND_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                role="tab"
                aria-selected={kind === filter.value}
                data-testid={`task-panel-kind-${filter.value}`}
                onClick={() => setKind(filter.value)}
                className={cn(
                  'flex-1 rounded-sm px-2 py-0.5 text-xs font-medium transition-colors',
                  kind === filter.value
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
            data-testid="task-panel-count"
          >
            {visibleItems.length}
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
            <DropdownMenuContent align="end">{renderMenuContent()}</DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* "Assigned to me" + document filter share one row that shrinks rather than wraps, so the
            document dropdown stays inline at the panel's default (narrow) width. */}
        <div className="flex items-center gap-1">
          {/* Assigned-to-me toggle (compact, never shrinks). */}
          <button
            type="button"
            role="switch"
            aria-checked={assignedToMe}
            data-testid="task-panel-assignee-me"
            onClick={() => setAssignedToMe((value) => !value)}
            className={cn(
              'inline-flex h-7 shrink-0 items-center rounded-md border px-2 text-xs font-medium transition-colors',
              assignedToMe
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-input text-muted-foreground hover:text-foreground',
            )}
          >
            Assigned to me
          </button>

          {/* Document filter — takes the remaining width and truncates instead of wrapping. */}
          {documentOptions.length > 0 && (
            <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
              <span className="sr-only">Filter by document</span>
              <select
                value={documentId}
                data-testid="task-panel-document"
                onChange={(event) => setDocumentId(event.target.value)}
                className="h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="all">All documents</option>
                {documentOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {/* Status filter. */}
        <div
          role="tablist"
          aria-label="Filter by status"
          className="flex items-center gap-0.5 overflow-x-auto rounded-md bg-muted p-0.5"
        >
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              role="tab"
              aria-selected={status === filter.value}
              onClick={() => setStatus(filter.value)}
              className={cn(
                'whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-medium transition-colors',
                status === filter.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {/* Rows. */}
      <div className="flex-1 overflow-y-auto p-2">
        {error && (
          <p className="px-2 py-4 text-xs text-destructive" role="alert">
            Couldn&apos;t load comments and tasks. {error.message}
          </p>
        )}

        {!error && visibleItems.length === 0 && !loading && (
          <div
            className="flex flex-col items-center gap-1 px-4 py-10 text-center text-xs text-muted-foreground"
            data-testid="task-panel-empty"
          >
            <MessagesSquare className="h-6 w-6" aria-hidden="true" />
            <p>No comments or tasks match these filters.</p>
          </div>
        )}

        <ul className="flex flex-col gap-1.5">
          {visibleItems.map((item) => {
            const rowContent = (
              <>
                <div className="flex items-center gap-2">
                  {item.status ? (
                    <Badge variant={STATUS_VARIANTS[item.status]} className="text-[10px]">
                      {STATUS_LABELS[item.status]}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">
                      Comment
                    </Badge>
                  )}
                  <span className="truncate text-xs text-muted-foreground" title={documentName(item.documentId)}>
                    {documentName(item.documentId)}
                  </span>
                  <span className="ml-auto flex items-center gap-1" title={item.assignee?.displayName ?? 'Unassigned'}>
                    <ReviewAvatar user={item.assignee ?? null} size={20} />
                  </span>
                </div>

                {item.anchor?.quote?.exact && (
                  <p className="truncate text-xs italic text-muted-foreground">“{item.anchor.quote.exact}”</p>
                )}
                <p className="whitespace-pre-wrap break-words text-sm text-foreground">{item.body}</p>

                {item.dueDate && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 text-[11px]',
                      dueDateTextClass(classifyDueDate(item.dueDate) ?? 'upcoming'),
                    )}
                  >
                    <CalendarClock className="h-3 w-3" aria-hidden="true" />
                    Due {formatDueDate(item.dueDate)}
                  </span>
                )}
              </>
            );

            return (
              <li
                key={item.id}
                data-testid="task-panel-row"
                data-item-id={item.id}
                className={cn(
                  'rounded-md border bg-card text-card-foreground',
                  onNavigate && 'transition-colors focus-within:ring-1 focus-within:ring-ring hover:border-primary/40 hover:bg-accent/40',
                )}
              >
                {onNavigate ? (
                  <button
                    type="button"
                    data-testid="task-panel-row-open"
                    onClick={() => onNavigate(item)}
                    className="flex w-full flex-col gap-1.5 p-2 text-left focus-visible:outline-none"
                  >
                    {rowContent}
                  </button>
                ) : (
                  <div className="flex flex-col gap-1.5 p-2">{rowContent}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
