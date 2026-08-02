/**
 * Verifies the harness's internal cross-reference extraction (`internalLinkTargets`) against COMMITTED
 * reference PDFs — real output from the canonical Asciidoctor-PDF toolchain, never a hand-written
 * fixture of what the parser is expected to see. A hand-built PDF would only prove the extraction
 * agrees with its author's model of the format; what has to hold is that it agrees with what the
 * renderer whose fidelity this suite polices actually emits.
 *
 * The expectations below are derived INDEPENDENTLY of the extraction, from poppler: `pdfinfo -dests`
 * gives each named destination's page, and `pdftohtml -xml` shows which pages carry link annotations.
 * (Neither can join the two — that gap is why the extraction exists; see `harness/pdftools.ts`.)
 *
 * Runs stack-free and engine-free: it only reads files that are in the repository.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { internalLinkTargets, pageCount, type InternalLink } from './harness/pdftools';

const FIXTURES_DIR = path.join(process.cwd(), 'e2e', 'pdf-parity', 'fixtures');

/** Absolute path of a fixture's committed reference PDF. */
function referencePath(fixture: string, file = 'reference.pdf'): string {
  return path.join(FIXTURES_DIR, fixture, file);
}

/** Read a reference PDF, skipping the test cleanly when the fixture is not present. */
function readReference(fixture: string): Uint8Array {
  const file = referencePath(fixture);
  test.skip(!existsSync(file), `reference PDF missing for fixture ${fixture}`);
  return new Uint8Array(readFileSync(file));
}

/**
 * `name → target page` for the links found on one page, collapsing the duplicate annotations a
 * contents row emits (Asciidoctor-PDF covers the title and the page number with separate links).
 */
function namedTargets(links: readonly InternalLink[], onPage: number): Map<string, number | null> {
  const targets = new Map<string, number | null>();
  for (const link of links) {
    if (link.page !== onPage || link.targetName === null) continue;
    targets.set(link.targetName, link.targetPage);
  }
  return targets;
}

test.describe('internal link targets of a rendered PDF', () => {
  test('resolves every contents entry to its named destination and page', async () => {
    const bytes = readReference('theme-editing');
    const links = await internalLinkTargets(bytes);

    // Straight from `pdfinfo -dests theme-editing/reference.pdf`: the contents lists twelve entries,
    // two of which (`_headings_and_prose`, `_third_level_heading`) sit on the same page.
    expect(namedTargets(links, 2)).toEqual(
      new Map([
        ['_headings_and_prose', 4],
        ['_third_level_heading', 4],
        ['_lists', 5],
        ['_tables', 6],
        ['_figures', 7],
        ['_columns', 8],
        ['_admonitions', 9],
        ['_quotations', 10],
        ['_source_code', 11],
        ['_sidebars_and_examples', 12],
        ['_text_styles', 13],
        ['_colophon', 14],
      ]),
    );
    // Same-page links are just as real as cross-page ones: the footnote round-trip (reference →
    // definition and back) lives entirely on page 13.
    expect(namedTargets(links, 13)).toEqual(
      new Map([
        ['_footnotedef_1', 13],
        ['_footnoteref_1', 13],
      ]),
    );
    // Every destination in this document resolves, and none of them dangles.
    expect(links.every((link) => link.targetPage !== null)).toBe(true);
    expect(links.every((link) => link.targetPage !== null && link.targetPage <= pageCount(bytes))).toBe(true);
  });

  test('excludes links that leave the document', async () => {
    const links = await internalLinkTargets(readReference('theme-editing'));

    // The source's body carries `https://asciidoctor.org[the Asciidoctor site]`, which the renderer
    // emits as a third link annotation on page 13. An external link is not a cross-reference, so the
    // count is the 24 contents annotations (twelve rows × two, title and page number) plus the two
    // footnote links — 26 of the document's 27 link annotations.
    expect(links).toHaveLength(26);
    expect(links.every((link) => link.targetName === null || !link.targetName.includes(':'))).toBe(true);
  });

  test('resolves a multi-page contents to the body pages it points at', async () => {
    const links = await internalLinkTargets(readReference('extension-narrow-contents'));

    // Six sections with two subsections each, one section per page from page 3 (`pdfinfo -dests`).
    expect(namedTargets(links, 2).size).toBe(18);
    expect(namedTargets(links, 2).get('_section_1')).toBe(3);
    expect(namedTargets(links, 2).get('_subsection_1_2')).toBe(3);
    expect(namedTargets(links, 2).get('_section_6')).toBe(8);
    expect(namedTargets(links, 2).get('_subsection_6_2')).toBe(8);
    // Every link sits on the contents page and points forward into the body.
    expect(links.every((link) => link.page === 2)).toBe(true);
    expect(links.every((link) => link.targetPage !== null && link.targetPage > 2)).toBe(true);
  });

  test('reports no links for a document that has no cross-references', async () => {
    // A document with neither a contents nor an xref must come back empty rather than, say, picking
    // up outline (bookmark) entries, which are a different structure pointing at the same pages.
    expect(await internalLinkTargets(readReference('code'))).toEqual([]);
  });
});
