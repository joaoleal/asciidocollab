/**
 * @file Column-layout invariant harness.
 *
 * The parity suite compares OUR render against a reference produced by the canonical toolchain. That
 * is the right check for fidelity, but it is blind to a whole class of defect: when a change breaks
 * the layout in BOTH toolchains, the two agree and parity passes while the output is wrong. That has
 * now happened twice on this feature — an unbalanced multi-column region, and a marginal paragraph
 * number that cost an extra page — and neither fixture caught it.
 *
 * So this harness asserts ABSOLUTE properties of a rendered PDF rather than agreement with another
 * renderer. It renders a stress document once per `paragraph-numbering.placement` plus an unnumbered
 * baseline, two regions that must divide and balance, and the theme editor's own preview sample, and
 * reports the geometry of each. The invariants live in the test beside it; this file only measures.
 *
 * It renders through the same shipping seams `parity-render.mjs` uses (dist VM + registry), and
 * prints a single JSON summary on stdout so the ts-jest test can spawn it and assert.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');
const DIST = join(PACKAGE_ROOT, 'dist');
const WASM_PATH = join(PACKAGE_ROOT, 'ruby', 'asciidoctor-pdf.wasm');
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
const WEB_MODULES = join(REPO_ROOT, 'apps', 'web', 'node_modules');

const requirePkg = createRequire(join(PACKAGE_ROOT, 'package.json'));
const { createWasiBridge } = requirePkg(join(DIST, 'vm', 'wasi-bridge.js'));
const { createRubyPdfVm } = requirePkg(join(DIST, 'vm', 'ruby-pdf-vm.js'));
const { populateProject } = requirePkg(join(DIST, 'vfs', 'populate.js'));
const { invokeConvert } = requirePkg(join(DIST, 'convert', 'invoke.js'));
const { resolvePdfExtensions } = requirePkg(join(DIST, 'extensions', 'registry.js'));

const SHIPPED_EXTENSIONS_DIR = join(
  PACKAGE_ROOT,
  'ruby',
  'extensions',
  'asciidocollab-pdf-extensions',
  'lib',
);

function shippedDirectories() {
  if (!existsSync(SHIPPED_EXTENSIONS_DIR)) return [];
  return readdirSync(SHIPPED_EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        existsSync(join(SHIPPED_EXTENSIONS_DIR, name, 'manifest.json')) &&
        existsSync(join(SHIPPED_EXTENSIONS_DIR, name, 'extension.rb')),
    );
}

/** The shipped catalogue, as the server would assemble it. */
function shippedCatalogue() {
  return shippedDirectories().map((name) => ({
    manifest: JSON.parse(readFileSync(join(SHIPPED_EXTENSIONS_DIR, name, 'manifest.json'), 'utf8')),
    origin: 'shipped',
    available: true,
  }));
}

/** Each shipped extension's Ruby source, as the composition root would inject it. */
function shippedSources() {
  return shippedDirectories().map((name) => ({
    id: JSON.parse(readFileSync(join(SHIPPED_EXTENSIONS_DIR, name, 'manifest.json'), 'utf8')).id,
    origin: 'shipped',
    source: readFileSync(join(SHIPPED_EXTENSIONS_DIR, name, 'extension.rb'), 'utf8'),
  }));
}

function buildDocument() {
  const paragraph = (n) =>
    `Numbered paragraph ${n} sits inside a columnised region and runs on for several ` +
    `lines so that the column measure, the column boundary, and any reflow around a ` +
    `marginal number are all unambiguous to measure.\n`;
  const lines = ['= Column layout\n:doctype: book\n\n== Regions\n\n', 'Full measure before.\n\n'];
  lines.push('[.multi-column]\n--\n');
  for (let n = 1; n <= 8; n += 1) lines.push(`${paragraph(n)}\n`);
  lines.push('--\n\nFull measure between.\n\n');
  lines.push('[.multi-column, columns=3]\n--\n');
  for (let n = 9; n <= 16; n += 1) lines.push(`${paragraph(n)}\n`);
  lines.push('--\n\nFull measure after.\n');
  return lines.join('');
}

const SLIVER_THEME = [
  // A `base`-extending theme with explicit metrics, because the page-foot sliver is a function of
  // THOSE. Under `extends: default` the cursor lands elsewhere entirely, which is exactly why the
  // original defect survived every existing fixture.
  'extends: base',
  'page:',
  '  layout: portrait',
  '  margin: [0.75in, 1in, 0.75in, 1in]',
  '  size: Letter',
  'base:',
  '  font-family: Times-Roman',
  '  font-size: 12',
  '  line-height-length: 17',
  '  line-height: $base-line-height-length / $base-font-size',
  'heading:',
  '  font-size: 17',
  '  line-height: 1.2',
  '  margin-bottom: 10',
  '',
].join('\n');

/**
 * The document the THEME EDITOR previews, read from the web app's shipping module.
 *
 * Synthesising a document that reproduces the page-foot sliver turned out to be unreliable: filler
 * paragraphs, a figure and base-theme metrics in every combination tried still never put the cursor
 * within a line of the foot exactly where the region begins. The real sample does, under a
 * base-extending theme — that IS the case a user hit — so the regression is pinned against it
 * rather than against an approximation that happens to render fine.
 */
function previewSample() {
  const source = join(REPO_ROOT, 'apps', 'web', 'src', 'lib', 'pdf', 'theme-preview-sample.ts');
  if (!existsSync(source)) return null;
  const text = readFileSync(source, 'utf8');
  const doc = text.match(/export const THEME_PREVIEW_SAMPLE = `([\s\S]*?)`;\n/);
  const fig = text.match(/export const THEME_PREVIEW_FIGURE = `([\s\S]*?)`;\n/);
  const figPath = text.match(/export const THEME_PREVIEW_FIGURE_PATH = '([^']+)'/);
  if (!doc || !fig || !figPath) return null;
  const unescape = (value) => value.replace(/\\`/g, '`').replace(/\\\$/g, '$');
  return { doc: unescape(doc[1]), figure: fig[1], figurePath: figPath[1] };
}

/**
 * Render the theme editor's own preview sample and report whether the columnised region survived.
 *
 * ONE document, not a sweep. Opening a column box in a sliver of space at the foot of a page makes
 * Prawn drop the region silently, and reproducing that needs the cursor to land within a line of the
 * foot exactly where the region begins. Synthesised documents did not manage it: filler paragraphs,
 * a figure and base-theme metrics in every combination tried still rendered fine at every offset.
 * The real sample does reproduce it under a base-extending theme, and it is the case a user actually
 * hit, so the regression is pinned against the sample itself rather than an approximation of it.
 */
async function renderPreviewSample() {
  const sample = previewSample();
  if (!sample) return { regionPresent: true, skipped: 'sample-unavailable' };
  const snapshot = {
    files: {
      'main.adoc': sample.doc,
      [sample.figurePath]: sample.figure,
      'theme.yml': SLIVER_THEME,
    },
    themePath: 'theme.yml',
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    // The attributes the THEME EDITOR injects (`RENDER_INTRINSIC_ATTRIBUTES`). They belong here
    // because they are part of the reproducing case: the preview declares an html5 backend even for
    // a PDF render, and dropping them from this snapshot is enough to make the defect disappear.
    attributes: {
      backend: 'html5',
      'backend-html5': '',
      basebackend: 'html',
      'basebackend-html': '',
      filetype: 'html',
      'filetype-html': '',
      doctype: 'article',
      'doctype-article': '',
      'backend-html5-doctype-article': '',
      'basebackend-html-doctype-article': '',
      'safe-mode-name': 'safe',
      'safe-mode-safe': '',
      'safe-mode-level': '1',
    },
    enabledExtensions: ['additional-contents-entries', 'multi-column-sections', 'paragraph-numbering'],
  };
  const bytes = await renderSnapshot(snapshot);
  const pages = await geometry(bytes);
  const text = pages.flatMap((page) => page.items.map((item) => item.text)).join(' ');
  return { regionPresent: text.includes('narrow measure') };
}

/**
 * The phrase carried by the prose OUTSIDE the region, so the measurement can drop it.
 *
 * It has to be dropped by text rather than by geometry. Surrounding prose is set at the full
 * measure, but a short full-measure line is narrower than one column, so it is indistinguishable
 * from a column line by width alone — and it sits directly above and below the region, which is
 * exactly where it would corrupt the column extents this measures.
 */
const OUTSIDE_REGION = 'Full measure';

/** A region deliberately taller than one column, so that it has to divide and then balance. */
function buildBalanceDocument(columns, paragraphs) {
  const attribute = columns === 2 ? '[.multi-column]' : `[.multi-column, columns=${columns}]`;
  const body = [];
  for (let n = 1; n <= paragraphs; n += 1) {
    body.push(
      `Region paragraph ${n} runs on for several lines so that the column measure and the ` +
        `column boundary are both unambiguous to measure from the rendered text layer.\n\n`,
    );
  }
  return (
    `= Balance\n:doctype: book\n\n== Region\n\n${OUTSIDE_REGION} before.\n\n` +
    `${attribute}\n--\n${body.join('')}--\n\n${OUTSIDE_REGION} after.\n`
  );
}

/**
 * The REGION's own text items on one page.
 *
 * Running header and footer are dropped by their position outside the margin box; the surrounding
 * prose is dropped by its text, one whole baseline at a time.
 */
function regionItems(page) {
  const baselines = new Map();
  for (const item of page.items) {
    if (item.y < 40 || item.y > 800) continue; // running header and footer
    // A marginal paragraph number sits OUTSIDE the measure by design. Counting it would widen the
    // measure the columns are recovered from and shift every band, so the labels are dropped and
    // only the prose they annotate is measured.
    if (/^\d+\.$/.test(item.text.trim())) continue;
    const key = Math.round(item.y * 2) / 2;
    if (!baselines.has(key)) baselines.set(key, []);
    baselines.get(key).push(item);
  }
  const region = [];
  for (const items of baselines.values()) {
    if (items.map((item) => item.text).join(' ').includes(OUTSIDE_REGION)) continue;
    region.push(...items);
  }
  return region;
}

/**
 * Per-column vertical extent, given the measure the region is set to.
 *
 * Columns are recovered by dividing that measure evenly rather than by trusting a theme constant:
 * no item can start inside a gutter, so an equal division puts every item in the column it was
 * actually set in. The measure has to come from the WHOLE document, not from the page being banded
 * — an unbalanced last page is exactly the case where one column is nearly empty and stops short of
 * the right edge, which would shrink the measure and misfile the very items being judged.
 */
function bandsOf(region, columns, left, right) {
  if (region.length === 0) return null;
  const span = (right - left) / columns;
  const bands = Array.from({ length: columns }, () => []);
  for (const item of region) {
    const index = Math.min(columns - 1, Math.max(0, Math.floor((item.x - left) / span)));
    bands[index].push(item);
  }
  return bands.map((items, index) => {
    if (items.length === 0) return { index, fill: 0, count: 0 };
    const ys = items.map((item) => item.y);
    // pdfjs measures upward from the page foot, so the TOP of a column is its largest y.
    return {
      index,
      fill: Math.round((Math.max(...ys) - Math.min(...ys)) * 10) / 10,
      count: items.length,
    };
  });
}

/**
 * Render a region taller than one column and report how its columns divided, page by page.
 *
 * `numbering` switches paragraph numbering on. It belongs here because numbering and balancing are
 * coupled in a way parity CANNOT see: an interior column has only the gutter to offer, which cannot
 * hold a number, so those paragraphs fall back to numbering inline — and an inline number is in the
 * flow. If the measuring pass skips it while the real pass inks it, the balancer divides a total
 * that is short by one prefix per paragraph and the columns come out uneven. Both toolchains load
 * the same extension, so they agree about the wrong layout and the parity suite stays green.
 */
async function renderBalance(columns, paragraphs, numbering = false) {
  const snapshot = {
    files: {
      'main.adoc': buildBalanceDocument(columns, paragraphs),
      'theme.yml': 'extends: default\n',
    },
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    attributes: {},
    themePath: 'theme.yml',
    enabledExtensions: numbering
      ? ['multi-column-sections', 'paragraph-numbering']
      : ['multi-column-sections'],
  };
  const pages = await geometry(await renderSnapshot(snapshot));
  const perPage = pages.map(regionItems);
  const everything = perPage.flat();
  if (everything.length === 0) return { columns, paragraphs, pages: [] };
  const left = Math.min(...everything.map((item) => item.x));
  const right = Math.max(...everything.map((item) => item.x + item.width));
  return {
    columns,
    paragraphs,
    numbering,
    // Only the pages the REGION is on. A title page carries a line of its own, which survives the
    // header/footer filter and would otherwise be reported as a page of perfectly level empty
    // columns — the one shape that must never be mistaken for a balanced region.
    pages: perPage
      .map((items) => bandsOf(items, columns, left, right))
      .filter((fills) => fills !== null && fills.some((band) => band.fill > 0)),
  };
}

/**
 * Render the stress document under one placement, or with numbering switched off entirely.
 *
 * `none` is the BASELINE and the whole point of this harness. Marginal numbers are drawn into a
 * `float`, so they must not move a single line of prose — which can only be checked against the same
 * document with the extension disabled. Checking margin against INLINE proves nothing: inline adds
 * text to the flow, and that changed a region's measured height enough to flip `single_page?` and
 * switch column balancing on, so inline can legitimately paginate differently from both.
 */
async function render(placement) {
  const numbering = placement !== 'none';
  const theme = numbering
    ? `extends: default\nparagraph-numbering:\n  placement: ${placement}\n`
    : 'extends: default\n';
  const snapshot = {
    files: { 'main.adoc': buildDocument(), 'theme.yml': theme },
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    attributes: {},
    themePath: 'theme.yml',
    enabledExtensions: numbering
      ? ['multi-column-sections', 'paragraph-numbering']
      : ['multi-column-sections'],
  };

  return renderSnapshot(snapshot);
}

async function renderSnapshot(snapshot) {
  const module = await WebAssembly.compile(readFileSync(WASM_PATH));
  const vm = createRubyPdfVm({ createBridge: () => createWasiBridge({ module }) });
  await vm.warmup();
  populateProject(vm, snapshot);

  const resolution = resolvePdfExtensions(
    snapshot.enabledExtensions,
    shippedCatalogue(),
    shippedSources(),
  );
  if (resolution.rejected.length > 0) {
    throw new Error(`Extensions refused: ${JSON.stringify(resolution.rejected)}`);
  }
  for (const extension of resolution.loaded) {
    vm.writeFile(extension.vfsPath, new TextEncoder().encode(extension.source));
  }

  const loadedExtensions = resolution.loaded.map(({ id, vfsPath }) => ({ id, vfsPath }));
  const result = await invokeConvert({
    vm,
    request: { requestId: 'column-layout', mode: 'export', snapshot, optimize: false },
    loadedExtensions,
  });
  vm.dispose();
  if (!result.ok) {
    throw new Error(`convert failed: ${result.error.phase}/${result.error.code}: ${result.error.message}`);
  }
  return result.bytes;
}

/**
 * Per-page text geometry.
 *
 * Read straight from the PDF's own text layer via pdfjs rather than from `pdftotext -layout`, whose
 * line grouping merges words that share a baseline ACROSS columns — an artifact that has twice made
 * a correct multi-column render look scrambled in a dump. Positions here are per item, so a column
 * band is recovered from the item's own x rather than inferred from a merged line.
 */
async function geometry(bytes) {
  const pdfjs = await import(
    pathToFileURL(join(WEB_MODULES, 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href
  );
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: false }).promise;
  const pages = [];
  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index);
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => typeof item.str === 'string' && item.str.trim() !== '')
      .map((item) => ({
        text: item.str,
        x: Math.round(item.transform[4] * 10) / 10,
        y: Math.round(item.transform[5] * 10) / 10,
        width: Math.round((item.width ?? 0) * 10) / 10,
      }));
    pages.push({ page: index, items });
  }
  return pages;
}

async function main() {
  if (!existsSync(WASM_PATH)) {
    process.stdout.write(`${JSON.stringify({ ran: false, reason: 'wasm-absent' })}\n`);
    return;
  }
  if (!existsSync(join(WEB_MODULES, 'pdfjs-dist'))) {
    process.stdout.write(`${JSON.stringify({ ran: false, reason: 'pdfjs-absent' })}\n`);
    return;
  }
  try {
    const out = { ran: true, placements: {}, balance: [] };
    for (const placement of ['none', 'inline', 'margin']) {
      out.placements[placement] = await geometry(await render(placement));
    }
    // Both column counts, and both taller than a single page. Two columns and three fail
    // DIFFERENTLY when balancing is skipped — two leaves a half-empty last column, three leaves the
    // last column with a single line — so neither count stands in for the other.
    for (const columns of [2, 3]) {
      out.balance.push(await renderBalance(columns, 26));
    }
    // Three columns WITH numbering: the interior column cannot hold a number, so its paragraphs
    // fall back inline and the measuring pass has to account for them.
    out.balance.push(await renderBalance(3, 26, true));
    out.previewSample = await renderPreviewSample();
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ran: false, reason: 'error', message: String(error), stack: String(error && error.stack) })}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
