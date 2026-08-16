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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { internalLinkTargets, pageCount, type InternalLink } from './harness/pdftools';

const FIXTURES_DIR = path.join(process.cwd(), 'e2e', 'pdf-parity', 'fixtures');

/** Absolute path of a fixture's committed reference PDF. */
function referencePath(fixture: string, file = 'reference.pdf'): string {
  return path.join(FIXTURES_DIR, fixture, file);
}

/**
 * Every reference PDF git is tracking under the fixtures tree, by absolute path.
 *
 * The same derivation `pdf-parity-render.spec.ts` uses, and imported from git rather than hard-coded
 * for the same reason: what the repository is COMMITTED to is a fact about the index, not a list a
 * spec restates and then forgets to update.
 */
function committedReferencePdfs(): ReadonlySet<string> {
  const listed = execFileSync('git', ['ls-files', '-z', '--', '.'], {
    cwd: FIXTURES_DIR,
    encoding: 'utf8',
  });
  return new Set(
    listed
      .split('\0')
      .filter((entry) => entry.endsWith('.pdf'))
      .map((entry) => path.join(FIXTURES_DIR, entry)),
  );
}

const committedReferences = committedReferencePdfs();

/**
 * Read a fixture's committed reference PDF.
 *
 * It ASSERTS the reference is there; it does not skip. This used to be
 * `test.skip(!existsSync(file), …)`, which contradicted the policy stated at the top of
 * playwright.pdf-parity.config.ts — the suite self-gates on the wasm engine, but "does NOT extend
 * that leniency to a missing reference PDF, since a skip there is a comparison silently deleted" —
 * and contradicted the hardening already applied to `pdf-parity-render.spec.ts`, whose twin
 * assertions this spec's were left behind by.
 *
 * The failure mode was concrete: deleting a fixture directory wholesale removes it from
 * `parityCases`, so the render suite loses that comparison, AND turned all three assertions here into
 * a green skip. Nothing anywhere then said the document had stopped being checked.
 *
 * The one legitimate absence — a fixture declared but never given a reference, the inert template —
 * is untracked by definition, so it is distinguished the way the render spec distinguishes it: by
 * asking git, not by name. An untracked reference is still a hard failure HERE, because unlike the
 * render suite this spec names its fixtures explicitly: it was written against `theme-editing`,
 * `extension-narrow-contents` and `code`, all of which are committed. A named fixture that has no
 * committed reference is a spec pointing at something that does not exist.
 */
function readReference(fixture: string): Uint8Array {
  const file = referencePath(fixture);
  const label = path.relative(FIXTURES_DIR, file);
  expect(
    existsSync(file),
    committedReferences.has(file)
      ? `${label} is committed to git but missing from the working tree — the reference was lost, ` +
          'not never generated. Restore it (git checkout) rather than regenerating it.'
      : `${label} is not there. This spec names its fixtures, so a missing reference is a broken ` +
          'expectation and not a fixture that has yet to be generated — regenerate the corpus ' +
          '(e2e/pdf-parity/tools/build-references.mjs) or update the fixture this test names.',
  ).toBe(true);
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
