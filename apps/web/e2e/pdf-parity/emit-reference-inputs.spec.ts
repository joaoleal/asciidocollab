/**
 * Reference-input emitter for the math + diagrams fixtures (a dev tool, NOT part of the comparison run).
 *
 * asciidoctor-mathematical will not build on this platform and an exact-version offline mermaid/vega
 * reference toolchain is impractical, so — per the corpus's element-level-tolerance policy — the math
 * and diagram references are the EXTERNAL Asciidoctor-PDF gem rendering the very same rewritten document
 * and shim-produced SVG assets our pipeline places. That isolates the parity risk under test to the wasm
 * engine's SVG embedding + placement vs the reference gem's, which is exactly the fidelity concern for
 * these families (the shims are shared code; the engines are not).
 *
 * This spec drives the real browser-backed mermaid/MathJax shims (plus the Node Graphviz/Vega shims)
 * through the real pre-processing pipeline to get that rewritten project, commits it under the fixture's
 * `reference-build/`, and renders it with the pinned `adc-pdf-ref` image into the committed reference.pdf.
 *
 * Hard-gated: it only runs when PARITY_EMIT=1, so the comparison suite never triggers a Docker render.
 * Run it with:
 *   PARITY_EMIT=1 pnpm --filter `@asciidocollab/web` exec playwright test emit-reference-inputs \
 *     --config playwright.pdf-parity.config.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, cpSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from '@playwright/test';
import type { ProjectSnapshot } from '@asciidocollab/asciidoc-pdf';
import { preprocessOurs } from './harness/pipeline';
import { browserShims } from './harness/shims';
import { startStaticServer, type StaticServer } from './harness/static-server';

const WEB_ROOT = process.cwd();
const FIXTURES_DIR = path.join(WEB_ROOT, 'e2e', 'pdf-parity', 'fixtures');
const MERMAID_BUNDLE = path.join(WEB_ROOT, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
const MATHJAX_ES5_DIR = path.join(WEB_ROOT, 'node_modules', 'mathjax', 'es5');
/**
 * The SAME content-addressed image the other reference tools use, built from the pinned Dockerfile
 * and locked gem closure. This used to be `adc-pdf-ref:latest` — a moving tag over an image nothing
 * rebuilds, so the reference it emitted depended on whatever the developer happened to have locally.
 *
 * Loaded through a dynamic import rather than a static one, and only once an emit actually runs.
 * Playwright transpiles every statically-imported module to CommonJS, which a `.mjs` file is then
 * loaded as ESM — `exports is not defined in ES module scope`, at import time, for the WHOLE config.
 * That took the comparison suite down with it, even though this spec self-skips without PARITY_EMIT
 * and the comparison suite never touches Docker. `import()` keeps the module in its own ESM graph.
 */
async function referenceImage(): Promise<{
  ensureReferenceImage: () => string;
  SOURCE_DATE_EPOCH: string;
}> {
  return (await import('./tools/reference-image.mjs')) as never;
}

const emitEnabled = process.env.PARITY_EMIT === '1';

function snapshotFor(fixtureName: string): ProjectSnapshot {
  const main = readFileSync(path.join(FIXTURES_DIR, fixtureName, 'source', 'main.adoc'), 'utf8');
  return {
    files: { 'main.adoc': main },
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    attributes: {},
  };
}

/** Write the rewritten project into `reference-build/`, then Docker-render main.adoc into reference.pdf. */
async function emitReference(
  fixtureName: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const { ensureReferenceImage, SOURCE_DATE_EPOCH: sourceDateEpoch } = await referenceImage();
  const image = ensureReferenceImage();
  const fixtureDirectory = path.join(FIXTURES_DIR, fixtureName);
  const buildDirectory = path.join(fixtureDirectory, 'reference-build');
  rmSync(buildDirectory, { recursive: true, force: true });
  mkdirSync(buildDirectory, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = path.join(buildDirectory, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }

  const work = mkdtempSync(path.join(tmpdir(), 'pdfref-emit-'));
  cpSync(buildDirectory, work, { recursive: true });
  execFileSync(
    'docker',
    ['run', '--rm',
      '--network', 'none',
      // Never root — the PDF is copied straight back into the developer's checkout.
      '--user', `${process.getuid()}:${process.getgid()}`,
      '-e', `SOURCE_DATE_EPOCH=${sourceDateEpoch}`,
      '-v', `${work}:/work`, '-w', '/work', image,
      // Through bundler, so the render resolves the LOCKED gem closure.
      'bundle', 'exec', 'asciidoctor-pdf', '-a', 'reproducible', '-o', 'reference.pdf', 'main.adoc'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  cpSync(path.join(work, 'reference.pdf'), path.join(fixtureDirectory, 'reference.pdf'));
  rmSync(work, { recursive: true, force: true });

  const genCount = readdirSync(buildDirectory).length;
  // eslint-disable-next-line no-console
  console.log(`${fixtureName}: emitted reference.pdf (${genCount} project files: rewritten doc + .gen assets)`);
}

test.describe('emit reference inputs (math + diagrams)', () => {
  test.skip(!emitEnabled, 'Set PARITY_EMIT=1 to regenerate the math/diagrams reference builds.');
  test.skip(
    !existsSync(MERMAID_BUNDLE) || !existsSync(path.join(MATHJAX_ES5_DIR, 'tex-mml-svg.js')),
    'mermaid/MathJax bundles not installed.',
  );

  let mathjaxServer: StaticServer;
  test.beforeAll(async () => {
    mathjaxServer = await startStaticServer(MATHJAX_ES5_DIR);
  });
  test.afterAll(async () => {
    await mathjaxServer?.stop();
  });

  for (const fixtureName of ['math', 'diagrams']) {
    test(`emit ${fixtureName}`, async ({ page }) => {
      const shims = browserShims(page, {
        mermaidBundlePath: MERMAID_BUNDLE,
        mathjaxBaseUrl: mathjaxServer.baseUrl,
      });
      const { files, diagnostics } = await preprocessOurs(snapshotFor(fixtureName), shims);
      if (diagnostics.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`${fixtureName} preprocess diagnostics:`, JSON.stringify(diagnostics, null, 2));
      }
      await emitReference(fixtureName, files);
    });
  }
});
