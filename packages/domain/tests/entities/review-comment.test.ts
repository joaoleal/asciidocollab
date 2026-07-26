import { ReviewComment } from '../../src/entities/review-comment';
import { ReviewCommentId } from '../../src/value-objects/ids/review-comment-id';
import { ProjectId } from '../../src/value-objects/ids/project-id';
import { DocumentId } from '../../src/value-objects/ids/document-id';
import { UserId } from '../../src/value-objects/ids/user-id';
import { ReviewAnchor } from '../../src/value-objects/review/review-anchor';
import { ReviewOperationInvalidError } from '../../src/errors/review/review-operation-invalid';

const PROJECT = ProjectId.create('11111111-1111-4111-8111-111111111111');
const DOCUMENT = DocumentId.create('22222222-2222-4222-8222-222222222222');
const ROOT = ReviewCommentId.create('33333333-3333-4333-8333-333333333333');
const REPLY = ReviewCommentId.create('44444444-4444-4444-8444-444444444444');
const AUTHOR = UserId.create('55555555-5555-4555-8555-555555555555');
const ASSIGNEE = UserId.create('66666666-6666-4666-8666-666666666666');
const RESOLVER = UserId.create('77777777-7777-4777-8777-777777777777');

function anchor(): ReviewAnchor {
  return new ReviewAnchor(null, { prefix: 'a ', exact: 'passage', suffix: ' b' }, 3, null, 'located');
}

function rootComment(): ReviewComment {
  return new ReviewComment(ROOT, PROJECT, DOCUMENT, null, 'comment', 'hello', AUTHOR, null, null, null, null, null, anchor());
}

function rootTask(): ReviewComment {
  return new ReviewComment(ROOT, PROJECT, DOCUMENT, null, 'task', 'do it', AUTHOR, 'open', null, null, null, null, anchor());
}

describe('ReviewComment invariants', () => {
  test('rejects an empty body', () => {
    expect(() => new ReviewComment(ROOT, PROJECT, DOCUMENT, null, 'comment', '   ', AUTHOR)).toThrow();
  });

  test('a reply must not carry anchor/status/assignee/dueDate and must be a comment', () => {
    expect(() => new ReviewComment(REPLY, PROJECT, DOCUMENT, ROOT, 'comment', 'r', AUTHOR, null, null, null, null, null, anchor())).toThrow();
    expect(() => new ReviewComment(REPLY, PROJECT, DOCUMENT, ROOT, 'task', 'r', AUTHOR, 'open')).toThrow();
    const reply = new ReviewComment(REPLY, PROJECT, DOCUMENT, ROOT, 'comment', 'r', AUTHOR);
    expect(reply.isReply()).toBe(true);
    expect(reply.anchor).toBeNull();
  });

  test('a comment must not carry task fields; a task must carry a status', () => {
    expect(() => new ReviewComment(ROOT, PROJECT, DOCUMENT, null, 'comment', 'c', AUTHOR, 'open')).toThrow();
    expect(() => new ReviewComment(ROOT, PROJECT, DOCUMENT, null, 'task', 't', AUTHOR, null)).toThrow();
  });
});

describe('ReviewComment kind transitions', () => {
  test('convert comment → task defaults status to open, then back clears task fields', () => {
    const item = rootComment();
    item.convertToTask();
    expect(item.isTask()).toBe(true);
    expect(item.status).toBe('open');
    item.assign(ASSIGNEE, new Date('2026-07-20'));
    item.convertToComment();
    expect(item.isComment()).toBe(true);
    expect(item.status).toBeNull();
    expect(item.assigneeId).toBeNull();
    expect(item.dueDate).toBeNull();
  });

  test('a reply cannot become a task', () => {
    const reply = new ReviewComment(REPLY, PROJECT, DOCUMENT, ROOT, 'comment', 'r', AUTHOR);
    expect(() => reply.convertToTask()).toThrow(ReviewOperationInvalidError);
  });

  test('converting a resolved comment to a task clears the stale resolution stamp', () => {
    const item = rootComment();
    item.resolveAsComment(RESOLVER);
    expect(item.isResolved()).toBe(true);
    item.convertToTask();
    // An open task must never carry a resolution stamp, or it vanishes from the default list.
    expect(item.status).toBe('open');
    expect(item.isResolved()).toBe(false);
    expect(item.resolvedAt).toBeNull();
    expect(item.resolvedById).toBeNull();
  });
});

describe('ReviewComment resolution (single stamp writer)', () => {
  test('task resolves via status and clears on reopen', () => {
    const item = rootTask();
    item.setStatus('resolved', RESOLVER);
    expect(item.isResolved()).toBe(true);
    expect(item.resolvedById?.equals(RESOLVER)).toBe(true);
    item.setStatus('open', RESOLVER);
    expect(item.isResolved()).toBe(false);
    expect(item.resolvedAt).toBeNull();
  });

  test('comment resolves via resolveAsComment and is idempotent', () => {
    const item = rootComment();
    item.resolveAsComment(RESOLVER);
    const firstStamp = item.resolvedAt;
    item.resolveAsComment(RESOLVER);
    expect(item.resolvedAt).toEqual(firstStamp);
  });

  test('resolveAsComment rejects a task; setStatus rejects a comment', () => {
    expect(() => rootTask().resolveAsComment(RESOLVER)).toThrow(ReviewOperationInvalidError);
    expect(() => rootComment().setStatus('resolved', RESOLVER)).toThrow(ReviewOperationInvalidError);
  });
});

describe('ReviewComment anchor transitions', () => {
  test('degrade located → section → detached, then manual reanchor → located', () => {
    const item = rootComment();
    expect(item.anchor?.state).toBe('located');
    item.degradeToSection('intro/overview');
    expect(item.anchor?.state).toBe('section');
    expect(item.anchor?.sectionId).toBe('intro/overview');
    item.detachAnchor();
    expect(item.anchor?.state).toBe('detached');
    item.reanchor(new ReviewAnchor(null, { prefix: '', exact: 'x', suffix: '' }, 1, null, 'detached'));
    expect(item.anchor?.state).toBe('located');
  });

  test('a reply cannot be reanchored', () => {
    const reply = new ReviewComment(REPLY, PROJECT, DOCUMENT, ROOT, 'comment', 'r', AUTHOR);
    expect(() => reply.reanchor(anchor())).toThrow(ReviewOperationInvalidError);
  });
});

describe('ReviewComment.refreshAnchorLineHint', () => {
  test('replaces the hint and reports the change, leaving every other anchor field alone', () => {
    const item = rootComment();
    item.degradeToSection('intro/overview');

    expect(item.refreshAnchorLineHint(42)).toBe(true);

    expect(item.anchor?.lineHint).toBe(42);
    // A re-measurement says nothing about whether the passage still resolves.
    expect(item.anchor?.state).toBe('section');
    expect(item.anchor?.sectionId).toBe('intro/overview');
    expect(item.anchor?.quote?.exact).toBe('passage');
  });

  test('reports no change (and stays untouched) when the hint already matches', () => {
    const item = rootComment();
    const before = item.anchor;

    expect(item.refreshAnchorLineHint(3)).toBe(false);

    expect(item.anchor).toBe(before);
    expect(item.anchor?.lineHint).toBe(3);
  });

  test('does NOT touch updatedAt — a derived re-measurement is not a user edit', async () => {
    const item = rootComment();
    const updatedAt = item.updatedAt.getTime();
    // Guarantee a distinguishable clock tick, so an accidental `_touch()` cannot pass unnoticed.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(item.refreshAnchorLineHint(99)).toBe(true);

    expect(item.updatedAt.getTime()).toBe(updatedAt);
  });

  test('throws for an item with no anchor', () => {
    const reply = new ReviewComment(REPLY, PROJECT, DOCUMENT, ROOT, 'comment', 'r', AUTHOR);
    expect(() => reply.refreshAnchorLineHint(1)).toThrow(ReviewOperationInvalidError);
  });
});
