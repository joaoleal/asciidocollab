import * as Y from 'yjs';
import type { AnchorDto, ReviewItemDto, ThreadDto } from '@asciidocollab/shared';
import { captureAnchor } from '@/lib/review/anchor';
import {
  resolveThreadAnchors,
  resolveThreadRanges,
  toReviewAnchorRanges,
} from '@/lib/review/thread-ranges';

/**
 * Pure `resolveThreadRanges` tests (feature 038, T014): a resolvable root anchor yields a live
 * `{from,to}` range, an unresolvable/absent anchor yields `null`, and the projection to the
 * decoration layer drops the nulls.
 */

/** Builds a `Y.Doc`/`Y.Text('codemirror')` seeded with `text`. */
function makeDocument(text: string): { ydoc: Y.Doc; ytext: Y.Text } {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('codemirror');
  ytext.insert(0, text);
  return { ydoc, ytext };
}

/** Wraps an anchor as a root-item thread with the given id. */
function threadWith(id: string, anchor: AnchorDto | undefined): ThreadDto {
  const root = { id, anchor } as unknown as ReviewItemDto;
  return { root, replies: [] };
}

describe('resolveThreadRanges', () => {
  test('resolves a live relative-position anchor to the same passage after a preceding insert', () => {
    const { ydoc, ytext } = makeDocument('Hello, world!');
    const captured = captureAnchor(ytext, 7, 12, ytext.toString(), 1); // "world"
    const anchor: AnchorDto = { relPos: captured.relPos, quote: captured.quote, state: 'located' };

    // A collaborator inserts before the passage; the relpos must track the shift.
    ytext.insert(0, 'XYZ ');

    const [entry] = resolveThreadRanges([threadWith('r1', anchor)], ytext, ydoc);
    expect(entry.id).toBe('r1');
    expect(entry.range).not.toBeNull();
    expect(ytext.toString().slice(entry.range!.from, entry.range!.to)).toBe('world');
  });

  test('yields a null range when the anchor has no relative position (degrades)', () => {
    const { ydoc, ytext } = makeDocument('Hello, world!');
    const anchor: AnchorDto = { quote: { prefix: '', exact: 'world', suffix: '' }, state: 'detached' };
    const [entry] = resolveThreadRanges([threadWith('r2', anchor)], ytext, ydoc);
    expect(entry).toEqual({ id: 'r2', range: null });
  });

  test('yields a null range when the root carries no anchor at all', () => {
    const { ydoc, ytext } = makeDocument('Hello, world!');
    const [entry] = resolveThreadRanges([threadWith('r3', undefined)], ytext, ydoc);
    expect(entry).toEqual({ id: 'r3', range: null });
  });

  test('preserves input order across resolvable and unresolvable threads', () => {
    const { ydoc, ytext } = makeDocument('abcdefghij');
    const captured = captureAnchor(ytext, 2, 5, ytext.toString(), 1);
    const resolvable: AnchorDto = { relPos: captured.relPos, quote: captured.quote, state: 'located' };
    const detached: AnchorDto = { quote: { prefix: '', exact: 'cde', suffix: '' }, state: 'detached' };

    const result = resolveThreadRanges(
      [threadWith('a', resolvable), threadWith('b', detached)],
      ytext,
      ydoc,
    );
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result[0].range).not.toBeNull();
    expect(result[1].range).toBeNull();
  });
});

describe('resolveThreadAnchors', () => {
  test('reports a live relative-position anchor as located with its resolved range', () => {
    const { ydoc, ytext } = makeDocument('Hello, world!');
    const captured = captureAnchor(ytext, 7, 12, ytext.toString(), 1); // "world"
    const anchor: AnchorDto = { relPos: captured.relPos, quote: captured.quote, state: 'located' };

    const [entry] = resolveThreadAnchors([threadWith('r1', anchor)], ytext, ydoc);

    expect(entry).toEqual({ id: 'r1', range: { from: 7, to: 12 }, state: 'located' });
  });

  test('treats a root without an anchor as detached', () => {
    const { ydoc, ytext } = makeDocument('Hello, world!');

    const [entry] = resolveThreadAnchors([threadWith('r2', undefined)], ytext, ydoc);

    expect(entry).toEqual({ id: 'r2', range: null, state: 'detached' });
  });

  test('detaches an unresolvable anchor when no degradation inputs are supplied', () => {
    const { ydoc, ytext } = makeDocument('Hello, world!');
    const anchor: AnchorDto = { quote: { prefix: '', exact: 'world', suffix: '' }, state: 'located' };

    const [entry] = resolveThreadAnchors([threadWith('r3', anchor)], ytext, ydoc);

    expect(entry).toEqual({ id: 'r3', range: null, state: 'detached' });
  });

  test('degrades a stale anchor to its section when a section resolver is supplied', () => {
    const { ydoc, ytext } = makeDocument('Hello, world!');
    const anchor: AnchorDto = {
      quote: { prefix: '', exact: 'vanished', suffix: '' },
      sectionId: 'intro',
      state: 'located',
    };

    const [entry] = resolveThreadAnchors([threadWith('r4', anchor)], ytext, ydoc, {
      documentText: ytext.toString(),
      findSectionRange: (id) => (id === 'intro' ? { from: 0, to: 5 } : null),
    });

    expect(entry).toEqual({ id: 'r4', range: { from: 0, to: 5 }, state: 'section' });
  });

  test('preserves input order across anchored and unanchored threads', () => {
    const { ydoc, ytext } = makeDocument('abcdefghij');
    const captured = captureAnchor(ytext, 2, 5, ytext.toString(), 1);
    const resolvable: AnchorDto = { relPos: captured.relPos, quote: captured.quote, state: 'located' };

    const result = resolveThreadAnchors(
      [threadWith('a', resolvable), threadWith('b', undefined)],
      ytext,
      ydoc,
    );

    expect(result.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(result.map((entry) => entry.state)).toEqual(['located', 'detached']);
  });
});

describe('toReviewAnchorRanges', () => {
  test('projects only resolved entries to the decoration layer shape', () => {
    const ranges = toReviewAnchorRanges([
      { id: 'a', range: { from: 2, to: 5 } },
      { id: 'b', range: null },
      { id: 'c', range: { from: 8, to: 10 } },
    ]);
    expect(ranges).toEqual([
      { id: 'a', from: 2, to: 5 },
      { id: 'c', from: 8, to: 10 },
    ]);
  });
});
