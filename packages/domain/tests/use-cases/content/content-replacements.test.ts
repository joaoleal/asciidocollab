import { dedupeReplacements } from '../../../src/use-cases/content/content-replacements';

describe('dedupeReplacements', () => {
  it('returns nothing for an empty set of pairs', () => {
    expect(dedupeReplacements([])).toEqual([]);
  });

  it('keeps every distinct find in first-seen order', () => {
    const pairs = [
      { find: 'include::old.adoc[]', replace: 'include::new.adoc[]' },
      { find: '<<old-id>>', replace: '<<new-id>>' },
    ];
    expect(dedupeReplacements(pairs)).toEqual(pairs);
  });

  it('keeps the first replacement when the same find occurs again', () => {
    const pairs = [
      { find: 'alpha', replace: 'first' },
      { find: 'alpha', replace: 'second' },
      { find: 'beta', replace: 'other' },
    ];
    expect(dedupeReplacements(pairs)).toEqual([
      { find: 'alpha', replace: 'first' },
      { find: 'beta', replace: 'other' },
    ]);
  });

  it('accepts any iterable, not just an array', () => {
    const pairs = new Set([{ find: 'a', replace: 'b' }]);
    expect(dedupeReplacements(pairs)).toEqual([{ find: 'a', replace: 'b' }]);
  });
});
