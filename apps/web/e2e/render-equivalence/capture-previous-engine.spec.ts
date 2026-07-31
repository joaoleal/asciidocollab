/**
 * Captures the render-equivalence reference fixtures from the CURRENT engine (a dev tool, not a check).
 *
 * The regression gate compares later output against these files, so they have to be taken from the
 * engine as it behaves before this feature changes it — and that moment passes once. Hard-gated behind
 * `CAPTURE_PREVIOUS_ENGINE=1` so a normal suite run can never re-take them, and the harness refuses to
 * overwrite an existing fixture even when the gate is open.
 *
 * Run it with:
 *   CAPTURE_PREVIOUS_ENGINE=1 pnpm --filter `@asciidocollab/web` exec playwright test \
 *     capture-previous-engine --config playwright.render-equivalence.config.ts
 */

import { test, expect } from '@playwright/test';
import {
  corpusDocuments,
  renderCorpusDocument,
  writeFixture,
  readFixture,
  fixturePath,
} from './harness/capture';

const captureEnabled = process.env['CAPTURE_PREVIOUS_ENGINE'] === '1';

test.describe('previous-engine capture', () => {
  test.skip(!captureEnabled, 'set CAPTURE_PREVIOUS_ENGINE=1 to capture the reference fixtures');

  test('renders every corpus document through the app render path and captures it', async () => {
    const documents = corpusDocuments();
    expect(documents.length).toBeGreaterThan(0);

    const written: string[] = [];
    for (const [index, document] of documents.entries()) {
      if (readFixture(document.name) !== null) {
        // Already captured. Left exactly as it is — see writeFixture.
        continue;
      }
      const html = await renderCorpusDocument(document, index + 1);

      // The capture must carry the app's own post-conversion passes, not raw conversion: those passes
      // are part of what the gate compares, and a reference taken without them describes a render the
      // product never performs.
      expect(html.length).toBeGreaterThan(0);

      written.push(writeFixture(document.name, html));
    }

    // Every document ends up with a fixture, whether this run wrote it or a previous one did.
    for (const document of documents) {
      expect(readFixture(document.name), `${fixturePath(document.name)} is missing`).not.toBeNull();
    }
    test.info().annotations.push({ type: 'captured', description: `${written.length} fixture(s)` });
  });

  test('carries the provenance and placeholders the app itself emits', async () => {
    const documents = corpusDocuments();

    const withDiagrams = documents.find((document) => document.name === 'diagrams-stem');
    expect(withDiagrams).toBeDefined();
    const diagramsHtml = readFixture(withDiagrams!.name) ?? (await renderCorpusDocument(withDiagrams!, 900));
    expect(diagramsHtml).toContain('class="adc-diagram"');
    expect(diagramsHtml).toContain('data-source-line=');

    // The include tree is captured ASSEMBLED, so offset composition is visible in the fixture rather
    // than hidden behind a placeholder.
    const withIncludes = documents.find((document) => document.name === 'include-tree');
    expect(withIncludes).toBeDefined();
    const includesHtml = readFixture(withIncludes!.name) ?? (await renderCorpusDocument(withIncludes!, 901));
    expect(includesHtml).toContain('A Section Of Chapter One');
    expect(includesHtml).toContain('data-source-file="includes/chapter-one.adoc"');
  });
});
