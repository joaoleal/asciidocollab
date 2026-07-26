import * as Y from 'yjs';
import type { AnchorDto } from '@asciidocollab/shared';
import { unpackRelativePositionPair } from '@asciidocollab/shared';
import {
  QUOTE_CONTEXT_LEN,
  MAX_ANCHOR_LEN,
  captureAnchor,
  resolveAnchor,
  encodeRelativePositions,
  decodeRelativePositions,
  extractQuote,
  uint8ArrayToBase64,
  base64ToUint8Array,
} from '@/lib/review/anchor';

/**
 * Anchor-core tests (feature 038, T012): the base64 relative-position round-trip, quote-capture
 * bounds for empty and oversized selections, and — the load-bearing property — an anchor resolving
 * to the SAME text after an insert before it shifts the document.
 */

/** Builds a `Y.Doc`/`Y.Text('codemirror')` seeded with `text` and returns the pieces under test. */
function makeDocument(text: string): { ydoc: Y.Doc; ytext: Y.Text } {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('codemirror');
  ytext.insert(0, text);
  return { ydoc, ytext };
}

describe('base64 helpers', () => {
  test('uint8 ↔ base64 round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 128, 64, 255]);
    expect([...base64ToUint8Array(uint8ArrayToBase64(bytes))]).toEqual([...bytes]);
  });
});

describe('encode/decode relative positions', () => {
  test('round-trips a start/end pair back to the same absolute offsets', () => {
    const { ydoc, ytext } = makeDocument('Hello, world!');
    const start = Y.createRelativePositionFromTypeIndex(ytext, 3);
    const end = Y.createRelativePositionFromTypeIndex(ytext, 8);
    const decoded = decodeRelativePositions(encodeRelativePositions(start, end));
    expect(decoded).not.toBeNull();
    expect(Y.createAbsolutePositionFromRelativePosition(decoded!.start, ydoc)!.index).toBe(3);
    expect(Y.createAbsolutePositionFromRelativePosition(decoded!.end, ydoc)!.index).toBe(8);
  });

  test('returns null on malformed base64 rather than throwing', () => {
    expect(decodeRelativePositions('not-valid-base64!!!')).toBeNull();
  });

  test('returns null on a truncated buffer', () => {
    // A single-byte buffer cannot even hold the 4-byte length prefix.
    expect(decodeRelativePositions(uint8ArrayToBase64(new Uint8Array([1])))).toBeNull();
  });

  test('returns null when the length prefix overruns the buffer', () => {
    const packed = new Uint8Array(8);
    new DataView(packed.buffer).setUint32(0, 999, true); // claims 999 start bytes; only 4 exist.
    expect(decodeRelativePositions(uint8ArrayToBase64(packed))).toBeNull();
  });

  test('what the browser writes is unpackable by the shared codec the collab server reads with', () => {
    // The stored blob is a cross-process contract: the collaboration server unpacks the very same
    // bytes (with unpackRelativePositionPair) to re-measure the anchor's line hint on write-back. If
    // this side ever stopped using the shared layout, that refresh would silently resolve nothing.
    const { ydoc, ytext } = makeDocument('Hello, world!');
    const encoded = encodeRelativePositions(
      Y.createRelativePositionFromTypeIndex(ytext, 7),
      Y.createRelativePositionFromTypeIndex(ytext, 12),
    );

    const unpacked = unpackRelativePositionPair(base64ToUint8Array(encoded));

    expect(unpacked).not.toBeNull();
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unpacked!.start), ydoc);
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unpacked!.end), ydoc);
    expect(start!.index).toBe(7);
    expect(end!.index).toBe(12);
  });
});

describe('extractQuote', () => {
  test('captures prefix/exact/suffix bounded to the context length', () => {
    const text = 'abcdefghij';
    const quote = extractQuote(text, 4, 6, 2);
    expect(quote).toEqual({ prefix: 'cd', exact: 'ef', suffix: 'gh' });
  });

  test('clamps prefix/suffix at the document edges', () => {
    const text = 'abc';
    expect(extractQuote(text, 0, 3, 10)).toEqual({ prefix: '', exact: 'abc', suffix: '' });
  });
});

describe('captureAnchor', () => {
  test('captures a normal selection with bounded quote context', () => {
    const long = 'x'.repeat(100);
    const documentText = `${long}SELECTED${long}`;
    const { ytext } = makeDocument(documentText);
    const from = long.length;
    const to = from + 'SELECTED'.length;
    const input = captureAnchor(ytext, from, to, documentText, 1);
    expect(input.quote.exact).toBe('SELECTED');
    expect(input.quote.prefix).toHaveLength(QUOTE_CONTEXT_LEN);
    expect(input.quote.suffix).toHaveLength(QUOTE_CONTEXT_LEN);
    expect(input.lineHint).toBe(1);
    expect(typeof input.relPos).toBe('string');
  });

  test('an empty selection expands to a single non-empty character', () => {
    const documentText = 'abcdef';
    const { ytext } = makeDocument(documentText);
    const input = captureAnchor(ytext, 3, 3, documentText, 2);
    expect(input.quote.exact.length).toBe(1);
    expect(input.quote.exact).toBe('d');
  });

  test('an empty selection at end-of-document expands backward', () => {
    const documentText = 'abc';
    const { ytext } = makeDocument(documentText);
    const input = captureAnchor(ytext, 3, 3, documentText, 1);
    expect(input.quote.exact).toBe('c');
  });

  test('an oversized selection is capped at MAX_ANCHOR_LEN', () => {
    const documentText = 'y'.repeat(MAX_ANCHOR_LEN + 500);
    const { ytext } = makeDocument(documentText);
    const input = captureAnchor(ytext, 0, documentText.length, documentText, 1);
    expect(input.quote.exact).toHaveLength(MAX_ANCHOR_LEN);
  });

  test('an inverted selection (from > to) is normalised', () => {
    const documentText = 'abcdefghij';
    const { ytext } = makeDocument(documentText);
    const input = captureAnchor(ytext, 7, 2, documentText, 1);
    expect(input.quote.exact).toBe('cdefg');
  });
});

describe('resolveAnchor', () => {
  test('resolves a fresh anchor back to its capture offsets', () => {
    const documentText = 'The quick brown fox';
    const { ydoc, ytext } = makeDocument(documentText);
    const input = captureAnchor(ytext, 4, 9, documentText, 1); // "quick"
    const anchor: AnchorDto = { ...input, state: 'located' };
    expect(resolveAnchor(anchor, ytext, ydoc)).toEqual({ from: 4, to: 9 });
  });

  test('follows an insert BEFORE the anchor so it still points to the same text', () => {
    const documentText = 'The quick brown fox';
    const { ydoc, ytext } = makeDocument(documentText);
    const input = captureAnchor(ytext, 4, 9, documentText, 1); // "quick"
    const anchor: AnchorDto = { ...input, state: 'located' };

    // Insert 6 characters at the very start; the anchored word shifts right by 6.
    ytext.insert(0, 'XXXXXX');
    const resolved = resolveAnchor(anchor, ytext, ydoc);
    expect(resolved).toEqual({ from: 10, to: 15 });
    expect(ytext.toString().slice(resolved!.from, resolved!.to)).toBe('quick');
  });

  test('returns null when the anchor has no relPos', () => {
    const { ydoc, ytext } = makeDocument('abc');
    const anchor: AnchorDto = { quote: { prefix: '', exact: 'a', suffix: '' }, state: 'detached' };
    expect(resolveAnchor(anchor, ytext, ydoc)).toBeNull();
  });

  test('returns null when the relPos is malformed', () => {
    const { ydoc, ytext } = makeDocument('abc');
    const anchor: AnchorDto = { relPos: 'garbage!!!', state: 'located' };
    expect(resolveAnchor(anchor, ytext, ydoc)).toBeNull();
  });
});
