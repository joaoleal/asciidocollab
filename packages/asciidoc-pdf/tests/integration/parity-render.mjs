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
const { createMountAssetsStage } = requirePkg(join(DIST, 'pipeline', 'stages', 'mount-assets.js'));
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
// Asset mount — custom WOFF2 fonts, through the SHIPPING production stage.
//
// Asciidoctor-PDF/prawn embeds only TTF/OTF and dispatches on the file extension, so a project that
// ships WOFF2 web fonts must have each WOFF2 losslessly decompressed back to the sfnt (TTF/OTF) it
// wraps, materialized under a `.ttf` name, the `.woff2` dropped, and the theme's font catalogue
// repointed to the `.ttf`. Rather than reimplement that here, this harness runs the app's OWN
// `createMountAssetsStage` against the live VM VFS (exactly as the worker does, after populate and
// before convert) so the `theme-fonts-woff2` fixture guards the real production decode/repoint path.
// The stage's injected `FontConverter` uses the same codec the app uses (fonteditor-core's WOFF2
// module, whose wasm loads from a local file — no network). A fixture that ships no WOFF2 font never
// invokes the decoder, so the TTF-only fixtures render through the unchanged path.
// ---------------------------------------------------------------------------

/** A standalone `ArrayBuffer` view of a `Uint8Array` (the shape `woff2.decode` accepts). */
function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/** The production stage's WOFF2→TTF `FontConverter`, using the app's own codec (lazy, local wasm). */
function createFontConverter() {
  const { woff2 } = requireWeb(join(WEB_MODULES, 'fonteditor-core'));
  let initialized = null;
  return {
    async woff2ToTtf(bytes) {
      if (initialized === null) {
        initialized = woff2.init();
      }
      await initialized;
      return new Uint8Array(woff2.decode(toArrayBuffer(bytes)));
    },
  };
}

/** A `PipelineVfs` (the surface the asset-mount stage writes through) backed by the live VM VFS. */
function pipelineVfsOverVm(vm) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const readBytes = (path) => {
    try {
      return vm.readFile(path);
    } catch {
      return null;
    }
  };
  return {
    writeFile: (path, bytes) => vm.writeFile(path, bytes),
    readFile: (path) => readBytes(path),
    writeText: (path, content) => vm.writeFile(path, encoder.encode(content)),
    readText: (path) => {
      const bytes = readBytes(path);
      return bytes === null ? null : decoder.decode(bytes);
    },
    exists: (path) => vm.exists(path),
    remove: (path) => vm.removeFile(path),
    list: () => [],
  };
}

/**
 * Make a fixture's custom WOFF2 fonts embeddable through the app's OWN asset-mount stage, run against
 * the live VM VFS after populate and before convert — the exact production seam. A fixture with no
 * WOFF2 font never constructs the codec, so TTF-only fixtures are untouched.
 */
async function mountAssets(vm, snapshot) {
  if (!snapshot.fontPaths.some((path) => path.toLowerCase().endsWith('.woff2'))) {
    return;
  }
  log('Decoding WOFF2 custom font(s) via the production asset-mount stage...');
  const stage = createMountAssetsStage({ fontConverter: createFontConverter() });
  const request = { requestId: 'parity-mount', mode: 'export', snapshot, optimize: false };
  const { diagnostics } = await stage.run({ request, vfs: pipelineVfsOverVm(vm) });
  for (const diagnostic of diagnostics ?? []) {
    log(`asset-mount ${diagnostic.code}: ${diagnostic.resource ?? ''}`);
  }
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
  // The shipping asset-mount stage: decode each WOFF2 already mounted under /project to the TTF it
  // wraps, drop the `.woff2`, and repoint the theme catalogue — all in the VFS the convert reads.
  await mountAssets(vm, snapshot);
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
  const { snapshot, unresolved } = buildSnapshot(fixtureDir, manifest);

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
