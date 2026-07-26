import { assembledEntryAtPdfPosition } from '@/lib/pdf/pdf-click-to-source';
import type { PdfSourceMap } from '@asciidocollab/asciidoc-pdf';

/**
 * The governing block's assembled line — the projection most of these cases assert on. The production
 * caller needs the whole entry (it prefers the exact `path`/`sourceLine` origin), so the projection
 * lives here rather than as an app export nothing outside these tests would call.
 *
 * @param sourceMap - The engine source map.
 * @param page - The 1-based PDF page clicked.
 * @param yFraction - The click's vertical position as a fraction of page height.
 * @returns The governing block's assembled line, or undefined when the map is empty.
 */
function assembledLineAtPdfPosition(
  sourceMap: PdfSourceMap,
  page: number,
  yFraction: number,
): number | undefined {
  return assembledEntryAtPdfPosition(sourceMap, page, yFraction)?.line;
}

const MAP: PdfSourceMap = [
  { line: 1, page: 1, yFraction: 0.05 },
  { line: 10, page: 1, yFraction: 0.5 },
  { line: 20, page: 2, yFraction: 0.1 },
  { line: 30, page: 2, yFraction: 0.8 },
];

describe('assembledLineAtPdfPosition', () => {
  it('returns undefined for an empty map', () => {
    expect(assembledLineAtPdfPosition([], 1, 0.5)).toBeUndefined();
  });

  it('resolves a click to the block at or above it on the same page', () => {
    // Just below the second block on page 1 → that block.
    expect(assembledLineAtPdfPosition(MAP, 1, 0.6)).toBe(10);
    // Between the two page-1 blocks → the first.
    expect(assembledLineAtPdfPosition(MAP, 1, 0.3)).toBe(1);
  });

  it('resolves a click on a later page to that page’s governing block', () => {
    expect(assembledLineAtPdfPosition(MAP, 2, 0.2)).toBe(20);
    expect(assembledLineAtPdfPosition(MAP, 2, 0.9)).toBe(30);
  });

  it('a click above the first block on a page falls back to the last block of the previous page', () => {
    // Page 2, above its first block (yFraction 0.1) → the previous page's last governing block (line 10).
    expect(assembledLineAtPdfPosition(MAP, 2, 0.05)).toBe(10);
  });

  it('a click above the very first block resolves to the first block', () => {
    expect(assembledLineAtPdfPosition(MAP, 1, 0)).toBe(1);
  });

  it('a click on a page with no entries below the first uses preceding pages', () => {
    // Page 3 has no entries → the last block overall governs (line 30).
    expect(assembledLineAtPdfPosition(MAP, 3, 0.5)).toBe(30);
  });
});

describe('a map whose line order is not its layout order', () => {
  // Line order is not layout order in general: a keep-together measurement or a term stamped at its
  // inking point can put a later line above an earlier one. Walking in line order and stopping at the
  // first entry past the click's page made that one entry swallow every click after it — whole pages
  // collapsed onto a single destination line.
  const OUT_OF_ORDER: PdfSourceMap = [
    { line: 1, page: 1, yFraction: 0.05 },
    { line: 10, page: 3, yFraction: 0.2 }, // laid out on a later page than the lines that follow it
    { line: 20, page: 1, yFraction: 0.5 },
    { line: 30, page: 2, yFraction: 0.3 },
    { line: 40, page: 2, yFraction: 0.7 },
  ];

  it('still resolves each click to the block actually laid out above it', () => {
    expect(assembledLineAtPdfPosition(OUT_OF_ORDER, 1, 0.6)).toBe(20);
    expect(assembledLineAtPdfPosition(OUT_OF_ORDER, 2, 0.5)).toBe(30);
    expect(assembledLineAtPdfPosition(OUT_OF_ORDER, 2, 0.9)).toBe(40);
    expect(assembledLineAtPdfPosition(OUT_OF_ORDER, 3, 0.5)).toBe(10);
  });

  it('does not collapse a whole page onto one destination', () => {
    const destinations = [0.1, 0.4, 0.6, 0.9].map((y) => assembledLineAtPdfPosition(OUT_OF_ORDER, 2, y));
    expect(new Set(destinations).size).toBeGreaterThan(1);
  });
});

describe('entries sharing one layout position', () => {
  // A `[horizontal]` dlist inks its term and description on the same row, and a qanda question and
  // answer share a single capture point, so identical positions are legitimate rather than noise.
  const SHARED: PdfSourceMap = [
    { line: 5, page: 1, yFraction: 0.4 }, // the term / question
    { line: 6, page: 1, yFraction: 0.4 }, // the description / answer, inked on the same row
    { line: 12, page: 1, yFraction: 0.8 },
  ];

  it('resolves a click on the shared row to the line the row starts at', () => {
    expect(assembledLineAtPdfPosition(SHARED, 1, 0.4)).toBe(5);
    expect(assembledLineAtPdfPosition(SHARED, 1, 0.5)).toBe(5);
  });
});

describe('assembledEntryAtPdfPosition', () => {
  it('returns the governing entry, carrying its exact origin when present', () => {
    const mapWithOrigins: PdfSourceMap = [
      { line: 1, page: 1, yFraction: 0.05, path: 'main.adoc', sourceLine: 1 },
      { line: 10, page: 1, yFraction: 0.5, path: 'ch/one.adoc', sourceLine: 4 },
    ];
    expect(assembledEntryAtPdfPosition(mapWithOrigins, 1, 0.6)).toEqual({
      line: 10,
      page: 1,
      yFraction: 0.5,
      path: 'ch/one.adoc',
      sourceLine: 4,
    });
  });

  it('returns undefined for an empty map', () => {
    expect(assembledEntryAtPdfPosition([], 1, 0.5)).toBeUndefined();
  });
});
