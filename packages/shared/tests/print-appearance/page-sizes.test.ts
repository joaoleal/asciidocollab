import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  FALLBACK_PAGE_SIZE_NAME,
  NAMED_PAGE_SIZES_PT,
  PAGE_SIZE_GEM_VERSION,
} from '../../src/print-appearance/page-sizes.generated';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

describe('the generated named page-size table', () => {
  it('records the pdf-core release the application actually renders with', () => {
    // This asserted `/^\d+\.\d+\.\d+$/` against a literal in the same repository, which constrained
    // nothing: the generator writes the constant, so any string it wrote would have matched, and a
    // gem bump that left this table stale would have gone on passing. The lockfile is the authority
    // on which pdf-core the wasm is built from, and it is committed, so it can be compared against.
    const lockfile = readFileSync(path.join(REPO_ROOT, 'packages/asciidoc-pdf/ruby/Gemfile.lock'), 'utf8');
    const locked = /^ {4}pdf-core \((\d+\.\d+\.\d+)\)$/m.exec(lockfile);
    expect(locked).not.toBeNull();
    expect(PAGE_SIZE_GEM_VERSION).toBe(locked?.[1]);
  });

  it('carries the size the renderer falls back to when a name is unrecognised', () => {
    expect(NAMED_PAGE_SIZES_PT[FALLBACK_PAGE_SIZE_NAME]).toBeDefined();
  });

  // Spot-checks against the ISO/US dimensions the table claims to hold. A generator that emitted an
  // empty table, doubled it from the file's prose comment, or swapped width for height would still
  // produce a plausible-looking module — these are what make it fail instead.
  it.each([
    ['A4', 595.28, 841.89],
    ['A3', 841.89, 1190.55],
    ['A5', 419.53, 595.28],
    ['LETTER', 612, 792],
    ['LEGAL', 612, 1008],
    ['TABLOID', 792, 1224],
  ])('gives %s its portrait dimensions in points', (name, width, height) => {
    expect(NAMED_PAGE_SIZES_PT[name]).toEqual([width, height]);
  });

  it('holds every size portrait — width no greater than height', () => {
    for (const [name, [width, height]] of Object.entries(NAMED_PAGE_SIZES_PT)) {
      expect({ name, portrait: width <= height }).toEqual({ name, portrait: true });
    }
  });

  it('holds only positive dimensions, so a lookup can never yield a zero-width page', () => {
    for (const [name, [width, height]] of Object.entries(NAMED_PAGE_SIZES_PT)) {
      expect({ name, positive: width > 0 && height > 0 }).toEqual({ name, positive: true });
    }
  });

  it('covers the whole table the renderer offers, not a hand-picked subset', () => {
    // 50 entries: 4A0/2A0, A0-A10, B0-B10, C0-C10, RA0-RA4, SRA0-SRA4, and the five named US sizes.
    expect(Object.keys(NAMED_PAGE_SIZES_PT)).toHaveLength(50);
  });

  it('names sizes in upper case, which is the form the renderer looks up', () => {
    for (const name of Object.keys(NAMED_PAGE_SIZES_PT)) {
      expect(name).toBe(name.toUpperCase());
    }
  });
});
