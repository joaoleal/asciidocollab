/**
 * PDF reference-parity render suite (stack-free; runs under playwright.pdf-parity.config.ts).
 *
 * For each fixture it produces the PDF the way production does — the real rendering shims feed the real
 * pre-processing pipeline, then the real wasm engine converts — and compares the result against a
 * committed reference PDF built by the EXTERNAL Asciidoctor-PDF toolchain (see tools/build-references.mjs).
 *
 * The suite is MANIFEST-DRIVEN: every case comes from a fixture directory's `manifest.json`, so
 * adding a fixture is adding a directory. Each manifest's `kind` selects the oracle, because different
 * fidelity risks need different comparisons:
 *
 *   structural  page count + the reference's text layer surviving into ours (themes, fonts, includes)
 *   code        page count + the highlighted code text surviving into ours
 *   citations   the reference-list entries, order and (numeric styles) assigned numbers
 *   ink         rasterized ink-map footprint/position + text labels (math, diagrams)
 *
 * The suite self-gates: absent wasm or absent reference PDF ⇒ a clean skip.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import type { ProjectSnapshot } from '@asciidocollab/asciidoc-pdf';
import { createParityEngine, type ParityEngine } from './harness/engine';
import { renderOurs } from './harness/pipeline';
import { nodeShims, browserShims } from './harness/shims';
import { pageCount, extractText, pageInkMaps, compareInkMaps } from './harness/pdftools';
import { startStaticServer, type StaticServer } from './harness/static-server';
import {
  loadParityCases,
  readFixtureSource,
  type ParityCase,
  type ParityProjectConfig,
} from './harness/manifest';
// The app's OWN snapshot builder, imported deliberately: a fixture declaring a `projectConfig` is
// covered only if the code under test is the code that ships.
import { buildProjectSnapshot, type SnapshotFile } from '@/lib/pdf/build-project-snapshot';
import {
  extractCitationFacts,
  compareCitationFacts,
  CITED_WORKS,
} from './harness/citations-check';

const WEB_ROOT = process.cwd();
const WASM_PATH = path.join(WEB_ROOT, '..', '..', 'packages', 'asciidoc-pdf', 'ruby', 'asciidoctor-pdf.wasm');
const FIXTURES_DIR = path.join(WEB_ROOT, 'e2e', 'pdf-parity', 'fixtures');
const MERMAID_BUNDLE = path.join(WEB_ROOT, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
// MathJax 4 dropped the `es5/` directory — the browser bundles sit at the package root now.
const MATHJAX_BUNDLE_DIR = path.join(WEB_ROOT, 'node_modules', 'mathjax');
// MathJax 4's fonts live in their own package; serving the scope directory means the loader's
// `[fonts]/mathjax-newcm-font/...` resolves against this origin instead of the default CDN.
const MATHJAX_FONTS_DIR = path.join(WEB_ROOT, 'node_modules', '@mathjax');

const enginePresent = existsSync(WASM_PATH);
const parityCases = loadParityCases(FIXTURES_DIR);

/**
 * Build the fixture's snapshot: its source tree plus the render fields its manifest declares.
 *
 * This is the hand-built path, and it is the reason a whole class of defect was invisible here. The
 * manifest's `render` block RESTATES what `buildProjectSnapshot` is believed to produce, and both
 * sides of the comparison read that restatement — so a builder that stops agreeing with it changes
 * neither side and the fixture stays green. A fixture that declares a `projectConfig` takes
 * {@link derivedSnapshotFor} instead, which runs the real builder.
 */
function declaredSnapshotFor(parityCase: ParityCase): ProjectSnapshot {
  const { files, binaryAssets } = readFixtureSource(path.join(FIXTURES_DIR, parityCase.fixture, 'source'));
  const mainFile = 'main.adoc';
  return {
    files,
    binaryAssets,
    rootPath: mainFile,
    openPath: mainFile,
    fontPaths: [],
    attributes: {},
    ...parityCase.render,
  };
}

/**
 * Build the fixture's snapshot the way the APP does: by running `buildProjectSnapshot` over the
 * project configuration the fixture declares.
 *
 * The reference for such a fixture is still generated from its `render` block, independently. So the
 * comparison now spans the app's own input assembly: if the builder derives a different theme path,
 * font search path, images dir or attribute set than the reference was built with, the two renders
 * diverge and the fixture fails. That is the coverage the hand-built path cannot provide, because
 * there the builder is not on the path at all.
 */
function derivedSnapshotFor(parityCase: ParityCase, config: ParityProjectConfig): ProjectSnapshot {
  const { files, binaryAssets } = readFixtureSource(path.join(FIXTURES_DIR, parityCase.fixture, 'source'));
  const snapshotFiles: SnapshotFile[] = [
    ...Object.entries(files).map(([filePath, content]) => ({ path: filePath, kind: 'text' as const, content })),
    ...Object.entries(binaryAssets).map(([filePath, bytes]) => ({ path: filePath, kind: 'binary' as const, bytes })),
  ];

  const { snapshot, excluded } = buildProjectSnapshot({
    files: snapshotFiles,
    mainPath: config.mainFile,
    openPath: config.mainFile ?? 'main.adoc',
    attributes: new Map(Object.entries(config.attributes)),
    ...(config.extraFontDirs === undefined ? {} : { extraFontDirs: config.extraFontDirs }),
    ...(config.enabledExtensions === undefined ? {} : { enabledExtensions: config.enabledExtensions }),
  });

  // A path the sandbox refused never reaches the render, so it would show up as a missing theme or a
  // substituted font — a confusing pixel difference rather than the configuration error it is.
  expect(excluded, `${parityCase.fixture}: sandbox excluded ${JSON.stringify(excluded)}`).toEqual([]);

  // The builder's derivation, checked directly against what the reference was built from.
  //
  // The render below would catch a divergence anyway, but only as a page count or a text-layer diff —
  // a symptom several steps removed from "the theme path came out wrong". Comparing here names the
  // field, which is the difference between a five-minute fix and an afternoon bisecting a PDF.
  const declared = parityCase.render;
  if (declared.themePath !== undefined) {
    expect(snapshot.themePath, `${parityCase.fixture}: derived themePath`).toBe(declared.themePath);
  }
  if (declared.imagesDir !== undefined) {
    expect(snapshot.imagesDir, `${parityCase.fixture}: derived imagesDir`).toBe(declared.imagesDir);
  }
  if (declared.fontPaths !== undefined) {
    // Order-insensitive: these become a font SEARCH PATH, so the set is what matters.
    expect([...snapshot.fontPaths].toSorted(), `${parityCase.fixture}: derived fontPaths`).toEqual(
      [...declared.fontPaths].toSorted(),
    );
  }
  return snapshot;
}

/** The snapshot for a case, derived through the real builder when the fixture declares a config. */
function snapshotFor(parityCase: ParityCase): ProjectSnapshot {
  return parityCase.projectConfig === undefined
    ? declaredSnapshotFor(parityCase)
    : derivedSnapshotFor(parityCase, parityCase.projectConfig);
}

/** Both renders must contain every fragment the fixture names — checked against the reference first. */
function expectSharedText(ours: string, reference: string, fragments: readonly string[]): void {
  for (const fragment of fragments) {
    expect(reference, `reference contains ${JSON.stringify(fragment)}`).toContain(fragment);
    expect(ours, `ours contains ${JSON.stringify(fragment)}`).toContain(fragment);
  }
}

/** Non-empty text-layer lines, trimmed with internal runs of whitespace collapsed to one space. */
function normalizeTextLayer(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim().replaceAll(/\s+/g, ' '))
    .filter((line) => line !== '');
}

/**
 * Every non-empty line of the reference's text layer must survive into ours. Compared line-wise with
 * internal whitespace collapsed: `pdftotext -layout` pads columns to the glyph positions, so exact
 * equality would fail on sub-point advance-width differences that are not fidelity defects. What this
 * does catch — and what a theme regression actually looks like — is text dropped, reordered, or
 * reflowed onto different lines.
 */
function expectTextLayerParity(ours: string, reference: string): void {
  expect(normalizeTextLayer(ours), 'text layer vs reference').toEqual(normalizeTextLayer(reference));
}

test.describe('PDF reference parity (render vs external build)', () => {
  let engine: ParityEngine;
  let mathjaxServer: StaticServer;
  let mathjaxFontsServer: StaticServer;

  test.beforeAll(async () => {
    test.skip(
      !enginePresent,
      `Asciidoctor-PDF wasm engine not present at ${WASM_PATH}; build it to enable the parity suite.`,
    );
    engine = await createParityEngine(WASM_PATH);
    mathjaxServer = await startStaticServer(MATHJAX_BUNDLE_DIR);
    mathjaxFontsServer = await startStaticServer(MATHJAX_FONTS_DIR);
  });

  test.afterAll(async () => {
    engine?.dispose();
    await mathjaxServer?.stop();
    await mathjaxFontsServer?.stop();
  });

  // A fixture with no committed reference PDF contributes no case at all, so an empty list means the
  // references have not been generated — which must fail loudly rather than reporting a green run over
  // nothing. Principle XV is not satisfied by a suite that silently compares zero documents.
  test('the fixture set yields comparison cases', () => {
    expect(parityCases.length, 'fixtures with committed reference PDFs').toBeGreaterThan(0);
  });

  for (const parityCase of parityCases) {
    test(`${parityCase.id} matches the reference build`, async ({ page }) => {
      test.skip(
        !existsSync(parityCase.referencePath),
        `${path.relative(FIXTURES_DIR, parityCase.referencePath)} not committed yet.`,
      );
      test.skip(
        parityCase.needsBrowser && !existsSync(MERMAID_BUNDLE),
        'mermaid bundle not installed.',
      );

      const shims = parityCase.needsBrowser
        ? browserShims(page as Page, {
            mermaidBundlePath: MERMAID_BUNDLE,
            mathjaxBaseUrl: mathjaxServer.baseUrl,
        mathjaxFontsBaseUrl: mathjaxFontsServer.baseUrl,
          })
        : nodeShims();
      const { pdfBytes, diagnostics } = await renderOurs(snapshotFor(parityCase), shims, engine);
      expect(diagnostics, `no render diagnostics: ${JSON.stringify(diagnostics)}`).toHaveLength(0);

      const referenceBytes = new Uint8Array(readFileSync(parityCase.referencePath));
      const oursText = extractText(pdfBytes);
      const referenceText = extractText(referenceBytes);

      if (parityCase.kind === 'citations') {
        const oursFacts = extractCitationFacts(oursText);
        const referenceFacts = extractCitationFacts(referenceText);
        // The reference build is correct by construction; assert it parsed as expected before diffing.
        expect(referenceFacts.referenceOrder, 'reference has all works').toHaveLength(CITED_WORKS.length);
        const mismatches = compareCitationFacts(oursFacts, referenceFacts, parityCase.numericCitations);
        expect(mismatches, `citation divergence(s): ${JSON.stringify(mismatches, null, 2)}`).toHaveLength(0);
        // Self-check: our rewriter emits reference-list back-links (the ↑ glyph), the anchor/back-link
        // model the reference's forward hyperlinks correspond to.
        expect(oursText, 'our reference entries carry back-links').toContain('↑');
        return;
      }

      expect(pageCount(pdfBytes), 'page count vs reference').toBe(pageCount(referenceBytes));
      expectSharedText(oursText, referenceText, parityCase.requiredText);

      if (parityCase.kind === 'ink') {
        const tolerance = parityCase.ink;
        expect(tolerance, `${parityCase.fixture} declares an "ink" tolerance block`).toBeDefined();
        if (tolerance === undefined) return;
        const inkMismatches = compareInkMaps(
          pageInkMaps(pdfBytes, tolerance.dpi),
          pageInkMaps(referenceBytes, tolerance.dpi),
          tolerance,
        );
        expect(inkMismatches, `ink-map divergence: ${JSON.stringify(inkMismatches, null, 2)}`).toHaveLength(0);
        return;
      }

      if (parityCase.kind === 'structural') {
        expectTextLayerParity(oursText, referenceText);
      }
    });
  }

  // Determinism is asserted separately from parity because it is a different property: parity says
  // our output matches the reference, determinism says our output does not depend on anything that
  // varies between runs (FR-020, SC-007, Principle XII). A renderer can be reproducibly WRONG, and a
  // renderer that matches the reference once but not twice would pass every test above.
  //
  // One fixture carries it rather than all of them: the property is of the engine, not of any
  // document, so paying the cost of a second full render on eleven fixtures buys nothing. The theme
  // fixture is chosen because a theme is the input most likely to introduce iteration-order
  // dependence — it is a hash of settings applied across every element.
  const determinismCase = parityCases.find((entry) => entry.fixture === 'theme-editing');

  test('the same theme and document render identically twice', async ({ page }) => {
    test.skip(determinismCase === undefined, 'theme-editing fixture has no committed reference yet.');
    if (determinismCase === undefined) return;

    const shims = determinismCase.needsBrowser
      ? browserShims(page as Page, {
          mermaidBundlePath: MERMAID_BUNDLE,
          mathjaxBaseUrl: mathjaxServer.baseUrl,
        mathjaxFontsBaseUrl: mathjaxFontsServer.baseUrl,
        })
      : nodeShims();

    const first = await renderOurs(snapshotFor(determinismCase), shims, engine);
    const second = await renderOurs(snapshotFor(determinismCase), shims, engine);

    // Compared on extracted text and page count rather than bytes: the PDF container carries an
    // object-ordering that the engine is free to vary, and pinning bytes would fail on a change that
    // alters nothing an author can observe. What must not vary is the rendered document.
    expect(pageCount(second.pdfBytes), 'page count across runs').toBe(pageCount(first.pdfBytes));
    expect(extractText(second.pdfBytes), 'text layer across runs').toBe(extractText(first.pdfBytes));
  });
});
