import { ReviewAnchor } from '../../../src/value-objects/review/review-anchor';

const quote = { prefix: 'a', exact: 'passage', suffix: 'b' };

describe('ReviewAnchor', () => {
  test('defensively copies the relative position and quote', () => {
    const relativePos = new Uint8Array([1, 2, 3]);
    const anchor = new ReviewAnchor(relativePos, quote, 5, null);

    // Mutating the inputs or the returned copies must not affect the stored value.
    relativePos[0] = 99;
    expect([...anchor.relPos!]).toEqual([1, 2, 3]);
    anchor.relPos![0] = 42;
    expect([...anchor.relPos!]).toEqual([1, 2, 3]);

    const returnedQuote = anchor.quote!;
    returnedQuote.exact = 'mutated';
    expect(anchor.quote!.exact).toBe('passage');
  });

  test('exposes its fields with a default located state', () => {
    const anchor = new ReviewAnchor(null, null, 7, 'sec-1');
    expect(anchor.relPos).toBeNull();
    expect(anchor.quote).toBeNull();
    expect(anchor.lineHint).toBe(7);
    expect(anchor.sectionId).toBe('sec-1');
    expect(anchor.state).toBe('located');
  });

  test('rejects an empty quote exact', () => {
    expect(() => new ReviewAnchor(null, { prefix: '', exact: '', suffix: '' }, 1, null)).toThrow(/exact/);
  });

  test('derives new states while preserving the other fields', () => {
    const base = new ReviewAnchor(new Uint8Array([9]), quote, 3, null, 'detached');

    const located = base.located();
    expect(located.state).toBe('located');
    expect(located.lineHint).toBe(3);

    const detached = base.detached();
    expect(detached.state).toBe('detached');

    const sectioned = base.toSection('sec-9');
    expect(sectioned.state).toBe('section');
    expect(sectioned.sectionId).toBe('sec-9');
    expect(sectioned.quote!.exact).toBe('passage');
  });

  test('withLineHint replaces only the hint, preserving relPos, quote, section and state', () => {
    const base = new ReviewAnchor(new Uint8Array([1, 2]), quote, 3, 'sec-4', 'section');

    const refreshed = base.withLineHint(120);

    expect(refreshed.lineHint).toBe(120);
    expect([...refreshed.relPos!]).toEqual([1, 2]);
    expect(refreshed.quote!.exact).toBe('passage');
    expect(refreshed.sectionId).toBe('sec-4');
    expect(refreshed.state).toBe('section');
    // The original is untouched — the anchor is a value object.
    expect(base.lineHint).toBe(3);
  });

  test('withLineHint accepts null for an unknown position', () => {
    expect(new ReviewAnchor(null, quote, 8, null).withLineHint(null).lineHint).toBeNull();
  });
});
