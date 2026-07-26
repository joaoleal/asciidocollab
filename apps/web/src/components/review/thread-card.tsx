'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Link2, MoreHorizontal, Pencil, Reply, RotateCcw } from 'lucide-react';
import type {
  AnchorState,
  ReviewItemDto,
  ReviewUserDto,
  ThreadDto,
} from '@asciidocollab/shared';
import { resolveReviewItem } from '@/lib/api/review';
import { STATUS_LABELS, STATUS_VARIANTS } from '@/lib/review/status';
import { Avatar } from '@/components/avatar';
import { cn } from '@/lib/utilities';
import { formatRelativeTime } from '@/lib/format-relative-time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CommentComposer } from './composer';
import { ReactionBar } from './reaction-bar';

/** The display name shown for an item whose author/resolver was deleted. */
const DELETED_USER_LABEL = 'Deleted user';

/**
 * The avatar for a review user, rendering the DiceBear avatar they configured for
 * themselves ({@link ReviewUserDto.avatarKey}) via the shared {@link Avatar} — the
 * same identity shown in the account menu and presence bar — so reviewers appear
 * consistently across the app. A deleted user (null) falls back to a neutral
 * placeholder. Decorative; the surrounding name text supplies the accessible identity.
 */
export function ReviewAvatar({
  user,
  size = 24,
  className,
}: {
  user: ReviewUserDto | null;
  size?: number;
  className?: string;
}) {
  if (!user) {
    return (
      <span
        aria-hidden="true"
        title={DELETED_USER_LABEL}
        style={{ width: size, height: size }}
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground',
          className,
        )}
      >
        —
      </span>
    );
  }
  return (
    <Avatar
      avatarKey={user.avatarKey}
      displayName={user.displayName}
      size={size}
      className={className}
    />
  );
}

/** A single item's header row: a small avatar, author name, and a relative timestamp inline. */
function ItemHeader({ item }: { item: ReviewItemDto }) {
  const name = item.author?.displayName ?? DELETED_USER_LABEL;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ReviewAvatar user={item.author} size={20} />
      <span className="truncate text-xs font-semibold text-foreground">{name}</span>
      <time className="shrink-0 text-[11px] text-muted-foreground" dateTime={item.createdAt}>
        · {formatRelativeTime(item.createdAt)}
      </time>
    </div>
  );
}

/** Properties for {@link ReviewThreadCard}. */
export interface ReviewThreadCardProperties {
  /** The owning project id (tenant key for mutations). */
  projectId: string;
  /** The thread to render: its root item plus ordered replies. */
  thread: ThreadDto;
  /** When true, hides every mutation control (viewer/observer mode, T043). */
  readOnly?: boolean;
  /**
   * The signed-in user's id. Only items authored by this user get an Edit affordance — an editor
   * may resolve/assign/delete anyone's item, but rewriting another person's words is disallowed
   * (mirrored by the server's author check). Left undefined hides every Edit control.
   */
  currentUserId?: string | null;
  /** Called after a successful mutation so the owner can refetch. */
  onChanged?: () => void;
  /** The id currently hovered across the review UI (drives hover emphasis). */
  hoveredItemId?: string | null;
  /** The active thread's root id (drives focus emphasis, FR-005). */
  activeThreadId?: string | null;
  /**
   * Sets/clears the hovered item id (FR-028 rail↔editor linkage).
   *
   * @param id - The item id to mark hovered, or null to clear it.
   */
  setHoveredItemId?: (id: string | null) => void;
  /**
   * Sets/clears the active thread's root id when the card is focused.
   *
   * @param id - The thread root id to activate, or null to clear it.
   */
  setActiveThreadId?: (id: string | null) => void;
  /**
   * Extension slot for the task affordances (assignee / due date). Rendered in the card's action row;
   * left empty here so the owner can fill it without a rewrite.
   */
  taskControls?: ReactNode;
  /**
   * Extension slot for the task status control, rendered in the header where the status badge sits so
   * the status reads (and edits) in one place. When omitted, a static status badge is shown instead —
   * so a card rendered without wiring still displays a task's status.
   */
  statusControl?: ReactNode;
  /**
   * Extension slot for the per-item overflow menu (US5 delete lands here). Rendered
   * inside the `⋯` dropdown; the placeholder menu is otherwise empty.
   */
  itemMenuExtra?: ReactNode;
  /**
   * The root anchor's degraded {@link AnchorState} (T040). When `section` the card shows a small
   * "On this section" indicator; `located`/undefined render nothing (detached items live in the
   * {@link DetachedTray}, not here).
   */
  anchorState?: AnchorState;
}

/**
 * Renders one review thread as a {@link Card}: the root item (author, timestamp,
 * body, and a status {@link Badge} for tasks), its replies, a {@link ReactionBar},
 * and the inline action controls (Reply always; Resolve for unresolved comments).
 * Hovering the card publishes the root id via `setHoveredItemId` and clicking
 * focuses it via `setActiveThreadId`. All mutation controls disappear when
 * `readOnly` is set. Task-specific affordances and per-item delete are deliberately
 * left to the `taskControls` / `itemMenuExtra` extension slots — this card does not
 * implement them.
 */
export function ReviewThreadCard({
  projectId,
  thread,
  readOnly = false,
  currentUserId,
  onChanged,
  hoveredItemId,
  activeThreadId,
  setHoveredItemId,
  setActiveThreadId,
  taskControls,
  statusControl,
  itemMenuExtra,
  anchorState,
}: ReviewThreadCardProperties) {
  const { root, replies } = thread;
  const isTask = root.kind === 'task';
  const isResolved = Boolean(root.resolvedAt) || root.status === 'resolved';
  const [replying, setReplying] = useState(false);
  const [resolving, setResolving] = useState(false);
  // The id of the item (root or a reply) currently open in the inline edit composer, or null.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Only the author may edit their own item's body, and never in read-only mode.
  const canEdit = (item: ReviewItemDto) =>
    !readOnly && !!currentUserId && item.author?.id === currentUserId;

  /** Renders an item's body, swapping in the inline edit composer while it is being edited. */
  const renderBody = (item: ReviewItemDto, className: string) =>
    editingId === item.id ? (
      <div onClick={(event) => event.stopPropagation()}>
        <CommentComposer
          mode="edit"
          projectId={projectId}
          itemId={item.id}
          initialBody={item.body}
          autoFocus
          onSubmitted={() => {
            setEditingId(null);
            onChanged?.();
          }}
          onCancel={() => setEditingId(null)}
        />
      </div>
    ) : (
      <p className={className}>{item.body}</p>
    );

  /** A compact author-only Edit button that opens the inline edit composer for `item`. */
  const editButton = (item: ReviewItemDto) =>
    canEdit(item) && editingId !== item.id ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        data-testid="review-edit"
        onClick={(event) => {
          event.stopPropagation();
          setEditingId(item.id);
        }}
      >
        <Pencil className="h-3 w-3" aria-hidden="true" />
        Edit
      </Button>
    ) : null;

  const isActive = activeThreadId === root.id;
  const isHovered = hoveredItemId === root.id;

  // When this card becomes the hovered one — including hover originating in the editor passage — pull
  // it into view within the scrolling rail so the highlight is actually visible. `block: 'nearest'`
  // makes it a no-op when the card is already on screen (e.g. hovering the card itself). Deferred by a
  // short delay so sweeping the pointer across many passages does not scroll every card it passes over
  // — only a hover that settles for ~150ms reveals its card.
  const cardReference = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isHovered) return;
    const timer = setTimeout(() => {
      // Optional-call `scrollIntoView` — it is absent in jsdom (tests) and older engines.
      cardReference.current?.scrollIntoView?.({ block: 'nearest' });
    }, 150);
    return () => clearTimeout(timer);
  }, [isHovered]);

  const handleResolve = async (reopen: boolean) => {
    if (resolving) return;
    setResolving(true);
    try {
      await resolveReviewItem(projectId, root.id, reopen);
      onChanged?.();
    } finally {
      setResolving(false);
    }
  };

  return (
    <div
      ref={cardReference}
      data-testid="review-thread-card"
      data-item-id={root.id}
      data-active={isActive || undefined}
      data-hovered={isHovered || undefined}
      onMouseEnter={() => setHoveredItemId?.(root.id)}
      onMouseLeave={() => setHoveredItemId?.(null)}
      onClick={() => setActiveThreadId?.(root.id)}
      className={cn(
        'rounded-lg border bg-card text-card-foreground shadow-sm transition-colors',
        isHovered && 'border-primary bg-primary/5',
        isActive && 'border-primary ring-1 ring-primary/40',
        isResolved && 'opacity-75',
      )}
    >
      <div className="flex flex-col gap-1.5 p-2.5">
        {/* Root header: identity + task status badge + overflow menu. */}
        <div className="flex items-center justify-between gap-1.5">
          <div className="min-w-0 flex-1">
            <ItemHeader item={root} />
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {isTask &&
              root.status &&
              (statusControl ?? (
                <Badge variant={STATUS_VARIANTS[root.status]} className="text-[10px]">
                  {STATUS_LABELS[root.status]}
                </Badge>
              ))}
            {!readOnly && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Thread actions"
                    onClick={(event) => event.stopPropagation()}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* US5 wires Delete (and any owner bulk actions) into this slot. */}
                  {itemMenuExtra ?? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No actions</div>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* Root body — plain text + emoji; React escapes it, so no sanitizer is needed. */}
        {renderBody(root, 'whitespace-pre-wrap break-words text-sm text-foreground')}

        {/* Structural-fallback indicator: the exact passage is gone but its section survives (T040). */}
        {anchorState === 'section' && (
          <span
            data-testid="thread-card-section-indicator"
            className="inline-flex w-fit items-center gap-1 rounded-full border border-amber-500/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
            title="The original passage was removed; this comment is now pinned to its section."
          >
            <Link2 className="h-3 w-3" aria-hidden="true" />
            On this section
          </span>
        )}

        {/* Replies. */}
        {replies.length > 0 && (
          <ul className="flex flex-col gap-1.5 border-l border-border pl-2.5">
            {replies.map((reply) => (
              <li key={reply.id} className="flex flex-col gap-1">
                <ItemHeader item={reply} />
                {renderBody(reply, 'whitespace-pre-wrap break-words text-sm text-foreground')}
                <div className="flex flex-wrap items-center gap-1">
                  <ReactionBar
                    projectId={projectId}
                    itemId={reply.id}
                    reactions={reply.reactions}
                    readOnly={readOnly}
                    onChanged={onChanged ? () => onChanged() : undefined}
                  />
                  {editButton(reply)}
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Task affordances (assignee / status / due) on their own wrapping row. */}
        {taskControls}

        {/* Primary actions + reactions in one wrapping row so nothing overflows the narrow rail. */}
        <div className="flex flex-wrap items-center gap-1">
          <ReactionBar
            projectId={projectId}
            itemId={root.id}
            reactions={root.reactions}
            readOnly={readOnly}
            onChanged={onChanged ? () => onChanged() : undefined}
          />
          {!readOnly && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                data-testid="review-reply"
                onClick={(event) => {
                  event.stopPropagation();
                  setReplying((value) => !value);
                }}
              >
                <Reply className="h-3.5 w-3.5" aria-hidden="true" />
                Reply
              </Button>
              {editButton(root)}
              {!isTask && !isResolved && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={resolving}
                  className="h-7 gap-1 px-2 text-xs"
                  data-testid="review-resolve"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleResolve(false);
                  }}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Resolve
                </Button>
              )}
              {!isTask && isResolved && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={resolving}
                  className="h-7 gap-1 px-2 text-xs"
                  data-testid="review-reopen"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleResolve(true);
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Reopen
                </Button>
              )}
            </>
          )}
        </div>

        {/* Inline reply composer. */}
        {!readOnly && replying && (
          <div onClick={(event) => event.stopPropagation()}>
            <CommentComposer
              mode="reply"
              projectId={projectId}
              rootId={root.id}
              autoFocus
              placeholder="Write a reply…"
              setActiveThreadId={setActiveThreadId}
              onSubmitted={() => {
                setReplying(false);
                onChanged?.();
              }}
              onCancel={() => setReplying(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
