import { ReviewCommentId } from '../value-objects/ids/review-comment-id';
import { ProjectId } from '../value-objects/ids/project-id';
import { DocumentId } from '../value-objects/ids/document-id';
import { UserId } from '../value-objects/ids/user-id';
import { Timestamps } from '../value-objects/common/timestamps';
import { ReviewAnchor } from '../value-objects/review/review-anchor';
import { ReviewItemKind, ReviewItemStatus, isResolvedStatus } from '../constants/review';
import { ReviewOperationInvalidError } from '../errors/review/review-operation-invalid';

/**
 * A single review item — a comment or a task — attached to a document passage.
 * A root item (`parentId === null`) plus its replies forms a thread.
 *
 * The aggregate owns every review invariant and state transition. Resolution has
 * exactly one internal writer ({@link ReviewComment._stampResolved} /
 * {@link ReviewComment._clearResolved}) shared by the task-status path and the
 * comment-resolve path, so the timestamps are identical regardless of entry.
 *
 * @invariant `body` is non-empty.
 * @invariant A reply carries no anchor, status, assignee, or due date and is a comment.
 * @invariant `status`/`assignee`/`dueDate` are non-null only on task-kind items.
 * @invariant Anchor fields exist only on root items.
 */
export class ReviewComment {
  private _kind: ReviewItemKind;
  private _body: string;
  private _status: ReviewItemStatus | null;
  private _assigneeId: UserId | null;
  private _dueDate: Date | null;
  private _resolvedAt: Date | null;
  private _resolvedById: UserId | null;
  private _anchor: ReviewAnchor | null;
  private _timestamps: Timestamps;

  /**
   * @throws {Error} If any structural invariant is violated.
   */
  constructor(
    /** Unique identifier of the item. */
    public readonly id: ReviewCommentId,
    /** Owning project (tenant key). */
    public readonly projectId: ProjectId,
    /** Document the item is attached to. */
    public readonly documentId: DocumentId,
    /** Root item id when this is a reply; null for roots. */
    public readonly parentId: ReviewCommentId | null,
    kind: ReviewItemKind,
    body: string,
    /** Authoring user, or null when that user was deleted. */
    public readonly authorId: UserId | null,
    status: ReviewItemStatus | null = null,
    assigneeId: UserId | null = null,
    dueDate: Date | null = null,
    resolvedAt: Date | null = null,
    resolvedById: UserId | null = null,
    anchor: ReviewAnchor | null = null,
    timestamps: Timestamps = new Timestamps(),
  ) {
    if (body.trim().length === 0) {
      throw new Error('review body must be non-empty');
    }

    const isReply = parentId !== null;
    if (isReply) {
      if (kind !== 'comment') throw new Error('a reply must be a comment');
      if (anchor !== null) throw new Error('a reply must not carry an anchor');
      if (status !== null) throw new Error('a reply must not carry a status');
      if (assigneeId !== null) throw new Error('a reply must not carry an assignee');
      if (dueDate !== null) throw new Error('a reply must not carry a due date');
    } else if (kind === 'comment') {
      if (status !== null) throw new Error('a comment must not carry a status');
      if (assigneeId !== null) throw new Error('a comment must not carry an assignee');
      if (dueDate !== null) throw new Error('a comment must not carry a due date');
    } else {
      // root task
      if (status === null) throw new Error('a task must carry a status');
    }

    if (resolvedById !== null && resolvedAt === null) {
      throw new Error('resolvedById requires resolvedAt');
    }

    this._kind = kind;
    this._body = body;
    this._status = status;
    this._assigneeId = assigneeId;
    this._dueDate = dueDate === null ? null : new Date(dueDate);
    this._resolvedAt = resolvedAt === null ? null : new Date(resolvedAt);
    this._resolvedById = resolvedById;
    this._anchor = anchor;
    this._timestamps = timestamps;
  }

  /** @returns Whether this item is a thread root (has an anchor, may be a task). */
  isRoot(): boolean {
    return this.parentId === null;
  }

  /** @returns Whether this item is a reply. */
  isReply(): boolean {
    return this.parentId !== null;
  }

  /** @returns Whether this item is a task. */
  isTask(): boolean {
    return this._kind === 'task';
  }

  /** @returns Whether this item is a pure comment. */
  isComment(): boolean {
    return this._kind === 'comment';
  }

  /** @returns Whether this item currently carries a resolution stamp. */
  isResolved(): boolean {
    return this._resolvedAt !== null;
  }

  /** @returns The item kind. */
  get kind(): ReviewItemKind {
    return this._kind;
  }

  /** @returns The body text. */
  get body(): string {
    return this._body;
  }

  /** @returns The task status, or null for pure comments. */
  get status(): ReviewItemStatus | null {
    return this._status;
  }

  /** @returns The assignee id, or null. */
  get assigneeId(): UserId | null {
    return this._assigneeId;
  }

  /** @returns A defensive copy of the due date, or null. */
  get dueDate(): Date | null {
    return this._dueDate === null ? null : new Date(this._dueDate);
  }

  /** @returns A defensive copy of the resolution timestamp, or null. */
  get resolvedAt(): Date | null {
    return this._resolvedAt === null ? null : new Date(this._resolvedAt);
  }

  /** @returns The resolver id, or null. */
  get resolvedById(): UserId | null {
    return this._resolvedById;
  }

  /** @returns The anchor (root items only), or null. */
  get anchor(): ReviewAnchor | null {
    return this._anchor;
  }

  /** @returns A defensive copy of the creation date. */
  get createdAt(): Date {
    return new Date(this._timestamps.createdAt);
  }

  /** @returns A defensive copy of the last-update date. */
  get updatedAt(): Date {
    return new Date(this._timestamps.updatedAt);
  }

  /**
   * Replaces the body text.
   *
   * @param body - The new, non-empty body.
   * @throws {Error} If `body` is empty.
   */
  editBody(body: string): void {
    if (body.trim().length === 0) {
      throw new Error('review body must be non-empty');
    }
    this._body = body;
    this._touch();
  }

  /**
   * Promotes a comment to a task, defaulting its status to `open`.
   *
   * @throws {ReviewOperationInvalidError} If this is a reply or already a task.
   */
  convertToTask(): void {
    if (this.isReply()) throw new ReviewOperationInvalidError('a reply cannot become a task');
    if (this.isTask()) throw new ReviewOperationInvalidError('item is already a task');
    this._kind = 'task';
    this._status = 'open';
    // A promoted comment starts as an OPEN task, so drop any resolution stamp it
    // carried as a resolved comment — otherwise it reads as resolved-yet-open and
    // vanishes from the default (unresolved) list.
    this._clearResolved();
    this._touch();
  }

  /**
   * Reverts a task to a plain comment, clearing status, assignee, due date, and
   * any resolution stamp.
   *
   * @throws {ReviewOperationInvalidError} If this item is not a task.
   */
  convertToComment(): void {
    if (!this.isTask()) throw new ReviewOperationInvalidError('item is not a task');
    this._kind = 'comment';
    this._status = null;
    this._assigneeId = null;
    this._dueDate = null;
    this._clearResolved();
    this._touch();
  }

  /**
   * Sets (or clears) the assignee and optional due date of a task.
   *
   * @param assigneeId - The assignee, or null to clear.
   * @param dueDate - The due date, or null to clear.
   * @throws {ReviewOperationInvalidError} If this item is not a task.
   */
  assign(assigneeId: UserId | null, dueDate: Date | null): void {
    if (!this.isTask()) throw new ReviewOperationInvalidError('only a task can be assigned');
    this._assigneeId = assigneeId;
    this._dueDate = dueDate === null ? null : new Date(dueDate);
    this._touch();
  }

  /**
   * Sets a task's lifecycle status — the sole resolution path for tasks. A
   * resolved/wontfix status stamps the resolution; reopening clears it.
   *
   * @param status - The target status.
   * @param resolverId - The acting user, recorded when the status resolves the task.
   * @throws {ReviewOperationInvalidError} If this item is not a task.
   */
  setStatus(status: ReviewItemStatus, resolverId: UserId | null): void {
    if (!this.isTask()) throw new ReviewOperationInvalidError('only a task has a status');
    this._status = status;
    if (isResolvedStatus(status)) {
      this._stampResolved(resolverId);
    } else {
      this._clearResolved();
    }
    this._touch();
  }

  /**
   * Resolves a comment thread — the resolution path for comments only. Idempotent
   * under concurrent resolve (a second call keeps the original stamp).
   *
   * @param resolverId - The acting user.
   * @throws {ReviewOperationInvalidError} If this item is a task (resolve via status).
   */
  resolveAsComment(resolverId: UserId | null): void {
    if (this.isTask()) throw new ReviewOperationInvalidError('a task is resolved via its status');
    if (this.isResolved()) return;
    this._stampResolved(resolverId);
    this._touch();
  }

  /**
   * Reopens a resolved comment thread, clearing its resolution stamp — the inverse of
   * {@link resolveAsComment}. Idempotent (reopening an already-open thread is a no-op).
   *
   * @throws {ReviewOperationInvalidError} If this item is a task (reopen via status).
   */
  reopenAsComment(): void {
    if (this.isTask()) throw new ReviewOperationInvalidError('a task is reopened via its status');
    if (!this.isResolved()) return;
    this._clearResolved();
    this._touch();
  }

  /**
   * Manually reattaches a root item to a new passage, returning it to `located`.
   *
   * @param anchor - The new anchor.
   * @throws {ReviewOperationInvalidError} If this item is a reply.
   */
  reanchor(anchor: ReviewAnchor): void {
    if (this.isReply()) throw new ReviewOperationInvalidError('a reply has no anchor');
    this._anchor = anchor.located();
    this._touch();
  }

  /**
   * Degrades the anchor to its enclosing section (the passage was lost).
   *
   * @param sectionId - The enclosing section symbol id.
   * @throws {ReviewOperationInvalidError} If this item has no anchor.
   */
  degradeToSection(sectionId: string): void {
    if (this._anchor === null) throw new ReviewOperationInvalidError('item has no anchor');
    this._anchor = this._anchor.toSection(sectionId);
    this._touch();
  }

  /**
   * Marks the anchor detached (neither passage nor section resolves).
   *
   * @throws {ReviewOperationInvalidError} If this item has no anchor.
   */
  detachAnchor(): void {
    if (this._anchor === null) throw new ReviewOperationInvalidError('item has no anchor');
    this._anchor = this._anchor.detached();
    this._touch();
  }

  /**
   * Re-measures the anchor's line hint. The hint is a DERIVED coordinate — the line the anchor's
   * relative position currently resolves to — captured when the item was created and otherwise never
   * refreshed, which made it drift further from the truth with every edit to the document. Refreshing
   * it changes nothing a user authored, so unlike every other mutator here this one deliberately does
   * NOT touch `updatedAt`: a housekeeping re-measurement must not make an untouched comment look
   * freshly edited, nor churn the column on every write-back.
   *
   * @param lineHint - The newly measured 1-based line number.
   * @returns True when the stored hint actually changed (the caller need only persist those).
   * @throws {ReviewOperationInvalidError} If this item has no anchor.
   */
  refreshAnchorLineHint(lineHint: number): boolean {
    if (this._anchor === null) throw new ReviewOperationInvalidError('item has no anchor');
    if (this._anchor.lineHint === lineHint) return false;
    this._anchor = this._anchor.withLineHint(lineHint);
    return true;
  }

  /** Single writer of the resolution stamp (shared by task-status and comment-resolve paths). */
  private _stampResolved(resolverId: UserId | null): void {
    this._resolvedAt = new Date();
    this._resolvedById = resolverId;
  }

  /** Single clearer of the resolution stamp. */
  private _clearResolved(): void {
    this._resolvedAt = null;
    this._resolvedById = null;
  }

  /** Re-stamps the last-update timestamp, preserving creation time. */
  private _touch(): void {
    this._timestamps = new Timestamps(this._timestamps.createdAt, new Date());
  }
}
