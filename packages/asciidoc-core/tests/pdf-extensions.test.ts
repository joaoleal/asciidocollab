import {
  compareExtensionIds,
  orderPdfExtensions,
  type PdfExtensionCatalogueEntry,
} from '../src';

/** A minimal catalogue entry carrying only the id ordering cares about. */
function entry(id: string): PdfExtensionCatalogueEntry {
  return {
    manifest: {
      id,
      displayName: id,
      description: '',
      targeting: '',
      themeKeys: [],
      sampleContent: '',
    },
    origin: 'shipped',
    available: true,
  };
}

describe('compareExtensionIds', () => {
  it('orders by Unicode code unit', () => {
    expect(compareExtensionIds('alpha', 'beta')).toBe(-1);
    expect(compareExtensionIds('beta', 'alpha')).toBe(1);
    expect(compareExtensionIds('same', 'same')).toBe(0);
  });

  it('orders the hyphen before letters, independent of locale collation', () => {
    // The whole reason this exists: `localeCompare` can treat the hyphen as ignorable punctuation and
    // order `title-block` and `titleblock` differently across ICU versions. A code-unit comparison
    // puts `-` (0x2D) before any letter, deterministically, everywhere.
    expect(compareExtensionIds('title-block', 'titleblock')).toBe(-1);
    expect(compareExtensionIds('titleblock', 'title-block')).toBe(1);
  });

  it('sorts a list into a stable, deterministic order', () => {
    const ids = ['per-chapter', 'auto-license', 'auto-license-page', 'narrow'];
    expect(ids.toSorted(compareExtensionIds)).toEqual([
      'auto-license',
      'auto-license-page',
      'narrow',
      'per-chapter',
    ]);
  });
});

describe('orderPdfExtensions', () => {
  it('orders entries by id', () => {
    const ordered = orderPdfExtensions([entry('narrow'), entry('auto-license'), entry('per-chapter')]);
    expect(ordered.map((candidate) => candidate.manifest.id)).toEqual([
      'auto-license',
      'narrow',
      'per-chapter',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [entry('narrow'), entry('auto-license')];
    const before = input.map((candidate) => candidate.manifest.id);
    orderPdfExtensions(input);
    expect(input.map((candidate) => candidate.manifest.id)).toEqual(before);
  });

  it('returns an empty array unchanged', () => {
    expect(orderPdfExtensions([])).toEqual([]);
  });
});
