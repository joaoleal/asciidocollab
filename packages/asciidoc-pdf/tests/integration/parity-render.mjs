/**
 * @file Headless reference-parity harness. Given a fixture directory (project source + a committed
 * `reference.pdf` produced by the external Asciidoctor-PDF toolchain), it renders the SAME project
 * through the real wasm engine — the exact shipping seams (`createWasiBridge → createRubyPdfVm →
 * warmup → populateProject → invokeConvert → normalizePdfBytes`), with the project's own theme, fonts,
 * images-dir and attributes, and with the project's `include::` tree pre-expanded through the shared
 * assembly primitive — then compares the two PDFs three ways and prints a single machine-readable JSON
 * summary on its last stdout line (human-readable progress goes to stderr):
 *
 *   1. Content parity   — `pdftotext` on both, normalized, must match.
 *   2. Print-readiness   — every font in our output is embedded, our text is selectable, and the page
 *                          count + geometry match the reference (`pdffonts` / `pdfinfo`).
 *   3. Visual parity     — rasterize both with pdf.js on a native canvas and pixel-diff per page at the
 *                          fixture's recorded tolerance; skipped-with-a-reason if no canvas backend is
 *                          installed (never faked to pass).
 *
 * It is invoked as its own Node process (the gated jest test spawns it with a fixture directory), for
 * the same reason as `engine-smoke.mjs`: the ESM-only interop libraries are awkward under ts-jest.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');
const DIST = join(PACKAGE_ROOT, 'dist');
const WASM_PATH = join(PACKAGE_ROOT, 'ruby', 'asciidoctor-pdf.wasm');

// Repo root, to reach the app's node_modules for the optional rasterization backends.
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
const WEB_MODULES = join(REPO_ROOT, 'apps', 'web', 'node_modules');

// Real shipping engine seams, pulled straight out of dist so this exercises the built package.
const requirePkg = createRequire(join(PACKAGE_ROOT, 'package.json'));
const { createWasiBridge } = requirePkg(join(DIST, 'vm', 'wasi-bridge.js'));
const { createRubyPdfVm } = requirePkg(join(DIST, 'vm', 'ruby-pdf-vm.js'));
const { populateProject } = requirePkg(join(DIST, 'vfs', 'populate.js'));
const { invokeConvert } = requirePkg(join(DIST, 'convert', 'invoke.js'));
const { assembleIncludes } = requirePkg('@asciidocollab/asciidoc-core');

const requireWeb = createRequire(join(WEB_MODULES, 'placeholder.js'));

const SOURCE_DIR_NAME = 'source';
const TEXT_EXTENSIONS = new Set(['adoc', 'asciidoc', 'ad', 'txt', 'yml', 'yaml', 'csv', 'json']);

function log(message) {
  process.stderr.write(`${message}\n`);
}

// ---------------------------------------------------------------------------
// Sandbox path resolver — mirrors the app's client-side include/image boundary (reject remote,
// data:, absolute, and traversal targets; resolve the rest relative to the referencing file). The
// shared assembly primitive routes every target through this before reading it.
// ---------------------------------------------------------------------------

const REMOTE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const DATA_URI_RE = /^data:/i;

function resolveSandboxedPath(fromPath, target) {
  let decoded;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }
  const trimmed = decoded.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (REMOTE_RE.test(trimmed) || DATA_URI_RE.test(trimmed)) return { ok: false, reason: 'remote' };
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { ok: false, reason: 'absolute' };
  }
  const baseSegments = fromPath.split('/').slice(0, -1);
  const resultSegments = [...baseSegments];
  for (const segment of trimmed.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resultSegments.length === 0) return { ok: false, reason: 'traversal' };
      resultSegments.pop();
      continue;
    }
    resultSegments.push(segment);
  }
  if (resultSegments.length === 0) return { ok: false, reason: 'traversal' };
  return { ok: true, path: resultSegments.join('/') };
}

// ---------------------------------------------------------------------------
// Fixture loading.
// ---------------------------------------------------------------------------

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
}

/** Read a fixture's source tree into text files and binary assets keyed by source-relative path. */
function readSource(sourceDir) {
  const files = {};
  const binaryAssets = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!statSync(absolute).isFile()) continue;
      const key = relative(sourceDir, absolute).split('\\').join('/');
      if (TEXT_EXTENSIONS.has(extensionOf(key))) {
        files[key] = readFileSync(absolute, 'utf8');
      } else {
        binaryAssets[key] = new Uint8Array(readFileSync(absolute));
      }
    }
  };
  walk(sourceDir);
  return { files, binaryAssets };
}

/** Build the ProjectSnapshot for a fixture, pre-expanding its include tree into the root document. */
function buildSnapshot(fixtureDir, manifest) {
  const sourceDir = join(fixtureDir, SOURCE_DIR_NAME);
  const { files, binaryAssets } = readSource(sourceDir);
  const render = manifest.render && typeof manifest.render === 'object' ? manifest.render : {};
  const rootPath = typeof manifest.mainFile === 'string' ? manifest.mainFile : 'main.adoc';

  const readFile = (path) => (typeof files[path] === 'string' ? files[path] : null);
  const assembled = assembleIncludes(
    rootPath,
    { readFile, resolveSandboxedPath, buildPlaceholder: () => '' },
    { seedAttributes: new Map(Object.entries(render.attributes ?? {})) },
  );
  // The engine sees ONE local document at the root path: the fully-inlined assembly.
  const mergedFiles = { ...files, [rootPath]: assembled.content };

  const snapshot = {
    files: mergedFiles,
    binaryAssets,
    rootPath,
    openPath: rootPath,
    fontPaths: Array.isArray(render.fontPaths) ? render.fontPaths : [],
    attributes: render.attributes && typeof render.attributes === 'object' ? render.attributes : {},
  };
  if (typeof render.themePath === 'string') snapshot.themePath = render.themePath;
  if (typeof render.imagesDir === 'string') snapshot.imagesDir = render.imagesDir;

  return { snapshot, unresolved: assembled.unresolved };
}

// ---------------------------------------------------------------------------
// Asset mount — custom WOFF2 fonts.
//
// Asciidoctor-PDF/prawn embeds only TTF/OTF and dispatches on the file extension, so a project that
// ships WOFF2 web fonts is made embeddable exactly the way the app's asset-mount stage does it: each
// WOFF2 is losslessly decompressed back to the sfnt (TTF/OTF) it wraps, materialized under a `.ttf`
// name, and the theme's font catalogue + the snapshot's `fontPaths` are repointed to that name. The
// decode uses the same codec the app's `FontConverter` uses (fonteditor-core's WOFF2 module, whose
// wasm loads from a local file — no network). A fixture that ships no WOFF2 font is returned untouched,
// so the TTF-only fixtures render through the unchanged path.
// ---------------------------------------------------------------------------

const WOFF2_SUFFIX = '.woff2';
const TTF_SUFFIX = '.ttf';

/** A standalone `ArrayBuffer` view of a `Uint8Array` (the shape `woff2.decode` accepts). */
function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/** The `.ttf` path a `.woff2` font decodes into (same directory + basename). */
function decodedTtfPath(woff2Path) {
  return `${woff2Path.slice(0, -WOFF2_SUFFIX.length)}${TTF_SUFFIX}`;
}

/**
 * Decompress every WOFF2 custom font a fixture ships back to the embeddable TTF it wraps, mirroring the
 * app's asset-mount stage: the decoded bytes are materialized under a `.ttf` name, the theme catalogue
 * and the snapshot's `fontPaths` are repointed to it, and the `.woff2` asset is dropped. Returns the
 * snapshot unchanged when it references no WOFF2 font, so TTF-only fixtures are untouched.
 */
async function mountWoff2Fonts(snapshot) {
  const woff2Paths = snapshot.fontPaths.filter((path) => path.toLowerCase().endsWith(WOFF2_SUFFIX));
  if (woff2Paths.length === 0) {
    return snapshot;
  }
  log(`Decoding ${woff2Paths.length} WOFF2 custom font(s) to embeddable TTF...`);
  const { woff2 } = requireWeb(join(WEB_MODULES, 'fonteditor-core'));
  await woff2.init();

  const binaryAssets = { ...snapshot.binaryAssets };
  for (const woff2Path of woff2Paths) {
    const bytes = binaryAssets[woff2Path];
    if (bytes === undefined) continue;
    const ttf = woff2.decode(toArrayBuffer(bytes));
    binaryAssets[decodedTtfPath(woff2Path)] = new Uint8Array(ttf);
    delete binaryAssets[woff2Path];
  }
  const fontPaths = snapshot.fontPaths.map((path) =>
    path.toLowerCase().endsWith(WOFF2_SUFFIX) ? decodedTtfPath(path) : path,
  );
  // Repoint every text reference (the theme's font catalogue) from the `.woff2` names to the decoded
  // `.ttf` names the render now embeds.
  const files = { ...snapshot.files };
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === 'string' && content.includes(WOFF2_SUFFIX)) {
      files[path] = content.split(WOFF2_SUFFIX).join(TTF_SUFFIX);
    }
  }
  return { ...snapshot, binaryAssets, fontPaths, files };
}

// ---------------------------------------------------------------------------
// Engine render (the real shipping seams).
// ---------------------------------------------------------------------------

async function renderWithEngine(snapshot) {
  const wasmBytes = readFileSync(WASM_PATH);
  const module = await WebAssembly.compile(wasmBytes);
  const vm = createRubyPdfVm({ createBridge: () => createWasiBridge({ module }) });
  await vm.warmup();
  populateProject(vm, snapshot);
  const request = { requestId: 'parity-render', mode: 'export', snapshot, optimize: false };
  const result = await invokeConvert({ vm, request });
  vm.dispose();
  if (!result.ok) {
    throw new Error(`Engine convert failed: ${result.error.phase}/${result.error.code}: ${result.error.message}`);
  }
  return { bytes: result.bytes, diagnostics: result.diagnostics };
}

// ---------------------------------------------------------------------------
// Poppler helpers.
// ---------------------------------------------------------------------------

function toolAvailable(tool) {
  return !spawnSync(tool, ['-v'], { stdio: 'ignore' }).error;
}

function writeTemp(bytes, name) {
  const dir = mkdtempSync(join(tmpdir(), 'parity-'));
  const file = join(dir, name);
  writeFileSync(file, Buffer.from(bytes));
  return file;
}

function pdfText(pdfPath) {
  const result = spawnSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout;
}

/** Collapse whitespace so a text comparison ignores rasterizer-irrelevant spacing/line-wrap noise. */
function normalizeText(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Parse `pdffonts` into { total, embedded } — the emb flag is the 5th token from the end of a row. */
function pdfFonts(pdfPath) {
  const result = spawnSync('pdffonts', [pdfPath], { encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const lines = result.stdout.split('\n');
  const separator = lines.findIndex((line) => /^-{3,}/.test(line));
  const rows = separator === -1 ? [] : lines.slice(separator + 1).filter((line) => line.trim().length > 0);
  let embedded = 0;
  for (const row of rows) {
    const tokens = row.trim().split(/\s+/);
    if (tokens.length >= 5 && tokens[tokens.length - 5] === 'yes') embedded += 1;
  }
  return { total: rows.length, embedded };
}

/** Parse `pdfinfo` into { pages, width, height } (page geometry in points). */
function pdfInfo(pdfPath) {
  const result = spawnSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  let pages = null;
  let width = null;
  let height = null;
  for (const line of result.stdout.split('\n')) {
    const pagesMatch = /^Pages:\s+(\d+)/.exec(line);
    if (pagesMatch) pages = Number(pagesMatch[1]);
    const sizeMatch = /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)/.exec(line);
    if (sizeMatch) {
      width = Number(sizeMatch[1]);
      height = Number(sizeMatch[2]);
    }
  }
  return { pages, width, height };
}

// ---------------------------------------------------------------------------
// Visual parity (pdf.js + native canvas + pixelmatch). Skipped-with-reason when unavailable.
// ---------------------------------------------------------------------------

async function loadRasterBackends() {
  const canvas = requireWeb(join(WEB_MODULES, '@napi-rs', 'canvas'));
  // pdf.js paints glyph outlines through the global `Path2D`/`DOMMatrix`/`ImageData`; in Node those
  // come from the native canvas backend and must be installed as globals before pdf.js renders.
  for (const name of ['Path2D', 'DOMMatrix', 'ImageData']) {
    if (globalThis[name] === undefined && canvas[name] !== undefined) {
      globalThis[name] = canvas[name];
    }
  }
  const pixelmatchModule = requireWeb(join(WEB_MODULES, 'pixelmatch'));
  const pixelmatch = typeof pixelmatchModule === 'function' ? pixelmatchModule : pixelmatchModule.default;
  const pdfjs = await import(pathToFileURL(join(WEB_MODULES, 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href);
  return { canvas, pixelmatch, pdfjs };
}

function nodeCanvasFactory(createCanvas) {
  return {
    create(width, height) {
      const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
      return { canvas, context: canvas.getContext('2d') };
    },
    reset(canvasAndContext, width, height) {
      canvasAndContext.canvas.width = Math.ceil(width);
      canvasAndContext.canvas.height = Math.ceil(height);
    },
    destroy(canvasAndContext) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
    },
  };
}

async function rasterizePages(pdfBytes, scale, backends) {
  const { canvas, pdfjs } = backends;
  const canvasFactory = nodeCanvasFactory(canvas.createCanvas);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    canvasFactory,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const cc = canvasFactory.create(width, height);
      await page.render({ canvasContext: cc.context, viewport, canvasFactory }).promise;
      const imageData = cc.context.getImageData(0, 0, width, height);
      pages.push({ width, height, data: new Uint8ClampedArray(imageData.data) });
      canvasFactory.destroy(cc);
      page.cleanup();
    }
  } finally {
    await doc.cleanup();
    await doc.destroy();
  }
  return pages;
}

async function compareVisually(ourBytes, referenceBytes, scale, tolerance) {
  let backends;
  try {
    backends = await loadRasterBackends();
  } catch (error) {
    return { ran: false, reason: `canvas/pdf.js backend unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const { pixelmatch } = backends;
  const [ourPages, referencePages] = await Promise.all([
    rasterizePages(ourBytes, scale, backends),
    rasterizePages(referenceBytes, scale, backends),
  ]);
  const pageCountMatches = ourPages.length === referencePages.length;
  const comparable = Math.min(ourPages.length, referencePages.length);
  let worstRatio = 0;
  let allWithin = true;
  for (let index = 0; index < comparable; index += 1) {
    const ours = ourPages[index];
    const reference = referencePages[index];
    if (ours.width !== reference.width || ours.height !== reference.height) {
      allWithin = false;
      worstRatio = 1;
      continue;
    }
    const total = reference.width * reference.height;
    const diff = new Uint8ClampedArray(total * 4);
    const mismatched = pixelmatch(ours.data, reference.data, diff, reference.width, reference.height, {
      threshold: tolerance.pixelThreshold,
    });
    const ratio = total === 0 ? 0 : mismatched / total;
    worstRatio = Math.max(worstRatio, ratio);
    if (ratio > tolerance.maxMismatchRatio) allWithin = false;
  }
  return {
    ran: true,
    ourPageCount: ourPages.length,
    referencePageCount: referencePages.length,
    pageCountMatches,
    worstRatio,
    tolerance,
    withinTolerance: pageCountMatches && allWithin,
  };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const fixtureDir = process.argv[2];
  if (!fixtureDir) {
    log('Usage: node parity-render.mjs <fixture-dir>');
    process.stdout.write(`${JSON.stringify({ ran: false, reason: 'no-fixture' })}\n`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(WASM_PATH)) {
    process.stdout.write(`${JSON.stringify({ ran: false, reason: 'wasm-absent' })}\n`);
    return;
  }
  const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'));
  const referencePdf = typeof manifest.referencePdf === 'string' ? manifest.referencePdf : 'reference.pdf';
  const referencePath = join(fixtureDir, referencePdf);
  if (!existsSync(referencePath)) {
    process.stdout.write(`${JSON.stringify({ ran: false, reason: 'reference-absent' })}\n`);
    return;
  }

  const scale = typeof manifest.scale === 'number' ? manifest.scale : 2;
  const tolerance = manifest.tolerance ?? { pixelThreshold: 0.1, maxMismatchRatio: 0.01 };

  log(`Building snapshot for ${manifest.name}...`);
  const { snapshot: rawSnapshot, unresolved } = buildSnapshot(fixtureDir, manifest);
  const snapshot = await mountWoff2Fonts(rawSnapshot);

  log('Rendering through the wasm engine...');
  const { bytes: ourBytes, diagnostics } = await renderWithEngine(snapshot);

  const ourPath = writeTemp(ourBytes, 'ours.pdf');
  const referenceBytes = new Uint8Array(readFileSync(referencePath));

  const haveText = toolAvailable('pdftotext');
  const haveFonts = toolAvailable('pdffonts');
  const haveInfo = toolAvailable('pdfinfo');

  // Content parity.
  let content = { ran: false, reason: 'pdftotext-absent' };
  if (haveText) {
    const ourText = pdfText(ourPath);
    const refText = pdfText(referencePath);
    if (ourText !== null && refText !== null) {
      const ourNorm = normalizeText(ourText);
      const refNorm = normalizeText(refText);
      content = {
        ran: true,
        equal: ourNorm === refNorm,
        ourSelectable: ourNorm.length > 0,
        ourChars: ourNorm.length,
        referenceChars: refNorm.length,
      };
    } else {
      content = { ran: false, reason: 'pdftotext-failed' };
    }
  }

  // Print-readiness.
  const ourFonts = haveFonts ? pdfFonts(ourPath) : null;
  const ourInfo = haveInfo ? pdfInfo(ourPath) : null;
  const referenceInfo = haveInfo ? pdfInfo(referencePath) : null;
  const geometryMatches =
    ourInfo !== null &&
    referenceInfo !== null &&
    ourInfo.pages === referenceInfo.pages &&
    Math.abs((ourInfo.width ?? 0) - (referenceInfo.width ?? 0)) < 1 &&
    Math.abs((ourInfo.height ?? 0) - (referenceInfo.height ?? 0)) < 1;
  const printReadiness = {
    fontsChecked: ourFonts !== null,
    fontsTotal: ourFonts?.total ?? 0,
    fontsEmbedded: ourFonts?.embedded ?? 0,
    allFontsEmbedded: ourFonts !== null && ourFonts.total > 0 && ourFonts.embedded === ourFonts.total,
    geometryChecked: ourInfo !== null && referenceInfo !== null,
    geometryMatches,
    ourPages: ourInfo?.pages ?? null,
    referencePages: referenceInfo?.pages ?? null,
    ourPageSize: ourInfo ? { width: ourInfo.width, height: ourInfo.height } : null,
    referencePageSize: referenceInfo ? { width: referenceInfo.width, height: referenceInfo.height } : null,
  };

  // Visual parity.
  const visual = await compareVisually(ourBytes, referenceBytes, scale, tolerance);

  const summary = {
    ran: true,
    fixture: manifest.name,
    includeResolution: { unresolved: unresolved.length, unresolvedDetail: unresolved },
    diagnostics: diagnostics.map((d) => ({ severity: d.severity, code: d.code, resource: d.resource ?? null })),
    content,
    printReadiness,
    visual,
    tolerance,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  log(`Harness failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.stdout.write(`${JSON.stringify({ ran: false, reason: 'error', message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
