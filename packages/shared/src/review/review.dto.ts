/** @file Wire DTOs describing review items, anchors, reactions, and threads. */

import type { AnchorState, ReviewItemKind, ReviewItemStatus } from './enums';

/** The text-quote selector captured at anchor creation, used for durable re-anchoring. */
export interface AnchorQuoteDto {
  /** Up to N characters immediately before the quoted passage. */
  prefix: string;
  /** The quoted passage itself. */
  exact: string;
  /** Up to N characters immediately after the quoted passage. */
  suffix: string;
}

/**
 * A root item's anchor as it crosses the wire. The relative-position pair is
 * base64-encoded; the quote + line hint + section id are the degradation
 * fallbacks, and `state` tells the client how to present the item.
 */
export interface AnchorDto {
  /** Base64-encoded Yjs RelativePosition pair (start,end), when present. */
  relPos?: string;
  /** Text-quote selector for durable re-anchoring. */
  quote?: AnchorQuoteDto;
  /**
   * The 1-based line the anchored passage sits on: a coarse fallback for re-anchoring, and the only
   * position available to a reader with no shared document loaded (the cross-file comments & tasks
   * panel). Captured at creation and re-measured by the collaboration server on every write-back, so
   * it tracks the document rather than freezing where the passage once was.
   */
  lineHint?: number;
  /** Enclosing section symbol id — the structural fallback. */
  sectionId?: string;
  /** Current resolution state of the anchor. */
  state: AnchorState;
}

/** A minimal user reference for author/assignee/resolver fields (null ⇒ deleted user). */
export interface ReviewUserDto {
  /** The user's unique identifier. */
  id: string;
  /** The user's display name. */
  displayName: string;
  /** The user's configured DiceBear avatar key, or null to fall back to the default style. */
  avatarKey: string | null;
}

/** Aggregated reactions for a single emoji on one item. */
export interface ReactionSummaryDto {
  /** The normalized unicode emoji key. */
  emoji: string;
  /** How many distinct users reacted with this emoji. */
  count: number;
  /** Whether the requesting user is one of the reactors. */
  reactedByMe: boolean;
  /** The ids of the reacting users. */
  userIds: string[];
}

/**
 * A single review item (root or reply). Replies carry no anchor, status,
 * assignee, or due date. `author`/`assignee`/`resolvedBy` are null when the
 * referenced user was deleted (rendered as "Deleted user"/unassigned).
 */
export interface ReviewItemDto {
  /** Unique identifier of the item. */
  id: string;
  /** The document the item is attached to. */
  documentId: string;
  /** The owning project (tenant key). */
  projectId: string;
  /** The root item id when this is a reply; absent/undefined for roots. */
  parentId?: string;
  /** Whether this item is a comment or a task. */
  kind: ReviewItemKind;
  /** The (sanitized-on-render) body text; may contain emoji. */
  body: string;
  /** The authoring user, or null when that user was deleted. */
  author: ReviewUserDto | null;
  /** Task lifecycle status; absent for pure comments. */
  status?: ReviewItemStatus;
  /** Assigned user for a task, or null when unassigned/deleted. */
  assignee?: ReviewUserDto | null;
  /** Optional task due date, ISO-8601 date string. */
  dueDate?: string;
  /** When the item was resolved, ISO-8601 timestamp; absent when unresolved. */
  resolvedAt?: string;
  /** The user who resolved the item, or null when that user was deleted. */
  resolvedBy?: ReviewUserDto | null;
  /** The anchor (root items only). */
  anchor?: AnchorDto;
  /**
   * The file node backing this item's document. Populated only by the project-wide list (which spans
   * files), so a cross-document view can label each item by file and open it; document-scoped reads
   * omit it because the file is already the open one.
   */
  fileNodeId?: string;
  /** A display name for {@link fileNodeId}'s file, populated alongside it by the project-wide list. */
  fileName?: string;
  /** Aggregated reaction summaries. */
  reactions: ReactionSummaryDto[];
  /** Creation timestamp, ISO-8601. */
  createdAt: string;
  /** Last-update timestamp, ISO-8601. */
  updatedAt: string;
}

/** A root item together with its ordered replies. */
export interface ThreadDto {
  /** The root comment/task. */
  root: ReviewItemDto;
  /** Replies in creation order. */
  replies: ReviewItemDto[];
}
