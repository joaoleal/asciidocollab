import type { AnchorDto, ReviewItemDto, ThreadDto } from '@asciidocollab/shared';
import {
  compareReviewOrder,
  sortReviewItemsByDocumentOrder,
  sortThreadsByDocumentOrder,
} from '@/lib/review/order';

/** A faithful root {@link ReviewItemDto} — every required field of the real wire DTO is present. */
const item = (overrides: Partial<ReviewItemDto> = {}): ReviewItemDto => ({
  id: 'r1',
  documentId: 'd1',
  projectId: 'p1',
  kind: 'comment',
  body: 'body',
  author: { id: 'u1', displayName: 'Alice', avatarKey: null },
  reactions: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const anchor = (overrides: Partial<AnchorDto> = {}): AnchorDto => ({
  relPos: 'AAAA',
  quote: { prefix: 'before ', exact: 'passage', suffix: ' after' },
  lineHint: 1,
  state: 'located',
  ...overrides,
});

const thread = (overrides: Partial<ReviewItemDto>): ThreadDto => ({ root: item(overrides), replies: [] });

const idsOf = (threads: ThreadDto[]) => threads.map((entry) => entry.root.id);

describe('compareReviewOrder', () => {
  test('returns 0 for two identical keys', () => {
    const key = { fileRank: 0, position: 10, createdAt: '2026-01-01T00:00:00.000Z', id: 'a' };
    expect(compareReviewOrder(key, { ...key })).toBe(0);
  });

  test('orders by file rank before position', () => {
    const late = { fileRank: 0, position: 900, createdAt: '2026-01-01T00:00:00.000Z', id: 'a' };
    const early = { fileRank: 1, position: 1, createdAt: '2026-01-01T00:00:00.000Z', id: 'b' };
    expect(compareReviewOrder(late, early)).toBeLessThan(0);
    expect(compareReviewOrder(early, late)).toBeGreaterThan(0);
  });
});

describe('sortThreadsByDocumentOrder', () => {
  test('orders threads by their resolved anchor offset, not by creation time', () => {
    const threads = [
      thread({ id: 'first-created', createdAt: '2026-01-01T00:00:00.000Z' }),
      thread({ id: 'second-created', createdAt: '2026-01-02T00:00:00.000Z' }),
      thread({ id: 'third-created', createdAt: '2026-01-03T00:00:00.000Z' }),
    ];
    const ranges = [
      { id: 'first-created', from: 900, to: 910 },
      { id: 'second-created', from: 12, to: 20 },
      { id: 'third-created', from: 400, to: 420 },
    ];
    expect(idsOf(sortThreadsByDocumentOrder(threads, ranges))).toEqual([
      'second-created',
      'third-created',
      'first-created',
    ]);
  });

  test('puts threads whose anchor no longer resolves at the end', () => {
    const threads = [
      thread({ id: 'orphan', createdAt: '2026-01-01T00:00:00.000Z' }),
      thread({ id: 'located', createdAt: '2026-01-09T00:00:00.000Z' }),
    ];
    const ranges = [{ id: 'located', from: 42, to: 50 }];
    expect(idsOf(sortThreadsByDocumentOrder(threads, ranges))).toEqual(['located', 'orphan']);
  });

  test('orders several orphans among themselves by creation time then id', () => {
    const threads = [
      thread({ id: 'b', createdAt: '2026-01-05T00:00:00.000Z' }),
      thread({ id: 'a', createdAt: '2026-01-05T00:00:00.000Z' }),
      thread({ id: 'c', createdAt: '2026-01-04T00:00:00.000Z' }),
    ];
    expect(idsOf(sortThreadsByDocumentOrder(threads, []))).toEqual(['c', 'a', 'b']);
  });

  test('breaks a position tie by creation time, then by id', () => {
    const threads = [
      thread({ id: 'z-newest', createdAt: '2026-01-03T00:00:00.000Z' }),
      thread({ id: 'b-same-time', createdAt: '2026-01-02T00:00:00.000Z' }),
      thread({ id: 'a-same-time', createdAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const ranges = [
      { id: 'z-newest', from: 5, to: 6 },
      { id: 'b-same-time', from: 5, to: 6 },
      { id: 'a-same-time', from: 5, to: 6 },
    ];
    expect(idsOf(sortThreadsByDocumentOrder(threads, ranges))).toEqual([
      'a-same-time',
      'b-same-time',
      'z-newest',
    ]);
  });

  test('is stable across repeated calls and does not mutate its input', () => {
    const threads = [
      thread({ id: 'b', createdAt: '2026-01-01T00:00:00.000Z' }),
      thread({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const ranges = [
      { id: 'a', from: 7, to: 8 },
      { id: 'b', from: 7, to: 8 },
    ];
    const once = idsOf(sortThreadsByDocumentOrder(threads, ranges));
    const twice = idsOf(sortThreadsByDocumentOrder(sortThreadsByDocumentOrder(threads, ranges), ranges));
    expect(once).toEqual(['a', 'b']);
    expect(twice).toEqual(once);
    expect(idsOf(threads)).toEqual(['b', 'a']);
  });
});

describe('sortReviewItemsByDocumentOrder', () => {
  test('orders items within one file by the anchor line hint', () => {
    const items = [
      item({ id: 'line-30', fileName: 'guide.adoc', anchor: anchor({ lineHint: 30 }) }),
      item({ id: 'line-2', fileName: 'guide.adoc', anchor: anchor({ lineHint: 2 }) }),
      item({ id: 'line-11', fileName: 'guide.adoc', anchor: anchor({ lineHint: 11 }) }),
    ];
    expect(sortReviewItemsByDocumentOrder(items).map((entry) => entry.id)).toEqual([
      'line-2',
      'line-11',
      'line-30',
    ]);
  });

  test('groups by file in stable path order before position', () => {
    const items = [
      item({ id: 'z-line-1', documentId: 'd2', fileName: 'zeta.adoc', anchor: anchor({ lineHint: 1 }) }),
      item({ id: 'a-line-9', documentId: 'd1', fileName: 'alpha.adoc', anchor: anchor({ lineHint: 9 }) }),
      item({ id: 'a-line-4', documentId: 'd1', fileName: 'alpha.adoc', anchor: anchor({ lineHint: 4 }) }),
    ];
    expect(sortReviewItemsByDocumentOrder(items).map((entry) => entry.id)).toEqual([
      'a-line-4',
      'a-line-9',
      'z-line-1',
    ]);
  });

  test('falls back to the document id when the file name is absent', () => {
    const items = [
      item({ id: 'in-b', documentId: 'doc-b', anchor: anchor({ lineHint: 1 }) }),
      item({ id: 'in-a', documentId: 'doc-a', anchor: anchor({ lineHint: 99 }) }),
    ];
    expect(sortReviewItemsByDocumentOrder(items).map((entry) => entry.id)).toEqual(['in-a', 'in-b']);
  });

  test('puts detached, anchorless and hintless items last within their own file', () => {
    const items = [
      item({ id: 'detached', fileName: 'guide.adoc', anchor: anchor({ state: 'detached' }) }),
      item({ id: 'no-anchor', fileName: 'guide.adoc', anchor: undefined }),
      item({ id: 'no-hint', fileName: 'guide.adoc', anchor: anchor({ lineHint: undefined }) }),
      item({ id: 'located', fileName: 'guide.adoc', anchor: anchor({ lineHint: 60 }) }),
      item({ id: 'other-file', fileName: 'zeta.adoc', anchor: anchor({ lineHint: 1 }) }),
    ];
    expect(sortReviewItemsByDocumentOrder(items).map((entry) => entry.id)).toEqual([
      'located',
      'detached',
      'no-anchor',
      'no-hint',
      'other-file',
    ]);
  });

  test('keeps a section-degraded anchor in the list at its hinted position', () => {
    const items = [
      item({ id: 'section', fileName: 'guide.adoc', anchor: anchor({ lineHint: 3, state: 'section' }) }),
      item({ id: 'located', fileName: 'guide.adoc', anchor: anchor({ lineHint: 8 }) }),
    ];
    expect(sortReviewItemsByDocumentOrder(items).map((entry) => entry.id)).toEqual(['section', 'located']);
  });

  test('breaks a hint tie by creation time then id, and does not mutate its input', () => {
    const items = [
      item({ id: 'c', fileName: 'g.adoc', createdAt: '2026-02-02T00:00:00.000Z', anchor: anchor({ lineHint: 4 }) }),
      item({ id: 'a', fileName: 'g.adoc', createdAt: '2026-02-03T00:00:00.000Z', anchor: anchor({ lineHint: 4 }) }),
      item({ id: 'b', fileName: 'g.adoc', createdAt: '2026-02-02T00:00:00.000Z', anchor: anchor({ lineHint: 4 }) }),
    ];
    expect(sortReviewItemsByDocumentOrder(items).map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
    expect(items.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
  });
});
