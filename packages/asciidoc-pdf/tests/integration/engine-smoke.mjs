/**
 * @file Standalone Node ESM harness that exercises the REAL Asciidoctor-PDF wasm engine through the
 * package's own typed bridge / warm-VM facade — no browser, no worker. It is invoked directly by Node
 * (the gated jest integration test spawns it) and prints a single machine-readable JSON summary on its
 * last stdout line; all human-readable progress goes to stderr.
 *
 * It covers four measurement/verification concerns against one warm VM instantiated exactly once:
 *
 *   1. Syntax highlighting — a document with `[source,ruby]` / `[source,js]` blocks and the rouge
 *      highlighter must convert cleanly with no "highlighter unavailable" engine warning, and (when a
 *      PDF text extractor is available) the code text must survive into the PDF.
 *   2. Deterministic output — converting the same input twice on the warm VM and normalizing each
 *      result must yield byte-identical bytes; normalization must also be idempotent.
 *   3. Performance — cold-start (module compile + first warmup), first-convert, and warm re-convert
 *      timings plus artifact sizes (raw + brotli).
 *   4. Source-map coordinate alignment — a second fixture is put through the REAL diagrams-math stage
 *      and converted, so the emitted map can be checked against the ORIGINAL line numbers: a block
 *      rewrite must not shift them, the exact-origin stamps must stay on the right side of an include
 *      boundary, and no position may come from the engine's throwaway scratch document.
 *
 * The engine is loaded ONLY through the built package (`dist/`): the WASI bridge, the warm-VM facade,
 * the attribute builder and the deterministic normalizer are all the real shipping code paths. The
 * ESM-only interop libraries are bound lazily inside the bridge itself, exactly as in production.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { brotliCompressSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');
const DIST = join(PACKAGE_ROOT, 'dist');
const WASM_PATH = join(PACKAGE_ROOT, 'ruby', 'asciidoctor-pdf.wasm');

// The built package is CommonJS; pull the real engine seams straight out of dist so the harness
// exercises the shipping code rather than a recompiled copy.
const { createWasiBridge } = require(join(DIST, 'vm', 'wasi-bridge.js'));
const { createRubyPdfVm } = require(join(DIST, 'vm', 'ruby-pdf-vm.js'));
const { populateProject, SOURCE_PROVENANCE_PATH } = require(join(DIST, 'vfs', 'populate.js'));
const { buildConvertAttributes, invokeConvert } = require(join(DIST, 'convert', 'invoke.js'));
const { normalizePdfBytes } = require(join(DIST, 'convert', 'normalize-pdf.js'));
const { createDiagramsMathStage } = require(join(DIST, 'pipeline', 'stages', 'diagrams-math.js'));
const { cancellationToken, createDiagnosticsCollector } = require(join(DIST, 'pipeline', 'orchestrator.js'));
const { createShimRegistry } = require(join(DIST, 'ports', 'shim.js'));

// ---------------------------------------------------------------------------
// Fixture: a document whose highlighting exercises the rouge integration in two languages.
// ---------------------------------------------------------------------------

const ROOT_DOC = 'doc.adoc';
const DOC_SOURCE = [
  '= Syntax Highlighting Reference',
  ':source-highlighter: rouge',
  '',
  'A short paragraph precedes the highlighted code so the render has body text.',
  '',
  '[source,ruby]',
  '----',
  'def greet(subject)',
  '  puts "Hello, #{subject}!"',
  'end',
  '',
  'greet("world")',
  '----',
  '',
  '[source,js]',
  '----',
  'const greet = (subject) => {',
  '  console.log(`Hello, ${subject}!`);',
  '};',
  '',
  'greet("world");',
  '----',
  '',
  // Lists exercise the source-map coverage of content laid out WITHOUT a `convert` dispatch: a
  // description list (an inline-description item, and a standalone term whose description is on the
  // next line) plus an unordered list. The tracking hook must emit an entry for each of these lines.
  'CPU:: the central processor',
  'Memory::',
  '  the volatile working storage',
  '',
  '* first bullet item',
  '* second bullet item',
  '',
].join('\n');

// Distinctive list lines (matched by substring) whose source-map coverage proves the tracking hook
// records list-item / dlist-term / description lines, not just blocks dispatched through `convert`.
const LIST_COVERAGE_NEEDLES = [
  'CPU:: the central processor', // dlist item: term + inline description (one line)
  'Memory::', // dlist term on its own line (laid out by convert_dlist, never via convert)
  'the volatile working storage', // dlist description on its own line (via traverse_list_item)
  '* first bullet item', // ulist item principal text (via traverse_list_item)
  '* second bullet item',
];

// Distinctive substrings expected to survive into the rendered PDF text layer when highlighting is
// active (the tokenizer wraps them in spans but the literal characters remain).
const EXPECTED_CODE_FRAGMENTS = ['greet', 'Hello', 'console.log'];

// Message shapes Asciidoctor emits when a requested highlighter gem is missing/inert. Detecting any
// of these means the highlighting is NOT actually happening.
const HIGHLIGHTER_UNAVAILABLE_PATTERN = /(rouge|highlight).*(not installed|unavailable|disabled|missing)/i;

function buildSnapshot() {
  return {
    files: { [ROOT_DOC]: DOC_SOURCE },
    binaryAssets: {},
    rootPath: ROOT_DOC,
    openPath: ROOT_DOC,
    fontPaths: [],
    attributes: {},
  };
}

// ---------------------------------------------------------------------------
// Fixture 2: source-map COORDINATE ALIGNMENT.
//
// The engine's source map is keyed to the assembled document, and two coordinate systems outlive the
// pre-processing pipeline that produced it: the include-resolve stage's line→source provenance (which
// the tracking hook indexes by `lineno` to stamp each block's origin file+line) and the web app's
// editor-line→assembled-line translation. So every line the pipeline rewrites must keep its number, and
// every captured position must describe the real document. This fixture drives the REAL diagrams-math
// stage over an authored document, converts the rewritten result, and checks the map against the
// ORIGINAL line numbers.
// ---------------------------------------------------------------------------

const ALIGN_ROOT = 'align.adoc';

/** The marker paragraph that stands in for the first line of an included file (see ALIGN_PROVENANCE). */
const INCLUDE_BOUNDARY_NEEDLE = 'INCLUDED-FILE marker paragraph.';

/** The project-relative paths the synthetic provenance attributes lines to. */
const ALIGN_MAIN_PATH = 'main.adoc';
const ALIGN_INCLUDED_PATH = 'chapter/one.adoc';

const ALIGN_DOC_SOURCE = [
  '= Coordinate Alignment Fixture',
  '',
  'Opening paragraph, before anything the pipeline rewrites.',
  '',
  '[mermaid]',
  '----',
  'graph TD;',
  '  A[Start] --> B[Middle];',
  '  B --> C[End];',
  '----',
  '',
  'MARKER after the diagram block.',
  '',
  '[stem]',
  '++++',
  'x^2 + y^2 = z^2',
  '++++',
  '',
  'MARKER after the math block.',
  '',
  // Explicit page breaks push the measured blocks below onto page four. The scratch document is ONE
  // document reused for every measurement — each container block's `dry_run` starts a new page on it —
  // so by the time the example block is measured the scratch is on its own page three. On a one-page
  // fixture that lands out of range and the out-of-range backstop quietly repairs it, hiding the defect
  // the guard exists for; with a real document that is deeper than the scratch, it does not.
  '<<<',
  '',
  'Filler paragraph holding page two.',
  '',
  '<<<',
  '',
  'Filler paragraph holding page three.',
  '',
  '<<<',
  '',
  'MARKER before the measured blocks.',
  '',
  // Three nested-content blocks in a row, so the scratch page numbering has run on before the block the
  // assertions bracket is measured.
  '****',
  'A sidebar, whose content is measured in the scratch document before it is inked.',
  '****',
  '',
  '[NOTE]',
  '====',
  'An admonition, measured in the scratch document as well.',
  '====',
  '',
  // Asciidoctor-PDF lays a container block out by converting its content into a THROWAWAY scratch
  // document first, to measure it. That document is a Marshal copy of the converter, so it carries the
  // same tracking hooks, and it swaps itself in as the document's converter for the duration — so the
  // captures it takes carry ITS page numbering. They also come first, winning the keep-first
  // de-duplication, which pinned this paragraph to a position that exists nowhere in the PDF.
  '[example]',
  '====',
  'INNER paragraph, measured in a scratch document before it is inked.',
  '====',
  '',
  'MARKER after the example block.',
  '',
  INCLUDE_BOUNDARY_NEEDLE,
  '',
].join('\n');

/**
 * Paragraph lines whose source-map entry must be keyed to their ORIGINAL line number. Each sits after at
 * least one rewritten block, so a rewrite that shortens the document shifts them.
 */
const ALIGNMENT_NEEDLES = [
  'MARKER after the diagram block.',
  'MARKER after the math block.',
  'MARKER before the measured blocks.',
  'MARKER after the example block.',
  INCLUDE_BOUNDARY_NEEDLE,
];

/** Deterministic stand-in artwork for the diagram/math shims (prawn-svg embeds it as-is). */
function stubSvg(width, height, fill) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}"><rect x="0" y="0" width="${width}" height="${height}" ` +
    `fill="${fill}"/></svg>`
  );
}

/** A shim that always renders the same SVG, so the stage's content addressing stays deterministic. */
function stubShim(kind, name, svg) {
  const bytes = new TextEncoder().encode(svg);
  return {
    kind,
    name,
    version: 'engine-smoke-1',
    render: async () => ({ ok: true, asset: { format: 'svg', bytes, rasterFallback: false } }),
  };
}

/** An in-memory PipelineVfs, the same shape the worker composition root supplies to the stages. */
function memoryVfs() {
  const store = new Map();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    writeFile: (path, bytes) => void store.set(path, bytes),
    readFile: (path) => store.get(path) ?? null,
    writeText: (path, content) => void store.set(path, encoder.encode(content)),
    readText: (path) => {
      const bytes = store.get(path);
      return bytes === undefined ? null : decoder.decode(bytes);
    },
    exists: (path) => store.has(path),
    remove: (path) => void store.delete(path),
    list: (prefix) => [...store.keys()].filter((key) => key.startsWith(prefix)),
    entries: () => [...store.entries()],
  };
}

/**
 * Run the REAL diagrams-math stage over a document and return the rewritten text plus the generated
 * assets it placed, so the convert below sees exactly what a production render would.
 */
async function runDiagramsMathStage(source, rootPath) {
  const vfs = memoryVfs();
  const rootVfsPath = `/project/${rootPath}`;
  vfs.writeText(rootVfsPath, source);
  const cache = new Map();
  const snapshot = {
    files: { [rootPath]: source },
    binaryAssets: {},
    rootPath,
    openPath: rootPath,
    fontPaths: [],
    attributes: {},
  };
  const context = {
    request: { requestId: 'engine-smoke-align', mode: 'preview', optimize: false, snapshot },
    readFile: () => vfs.readText(rootVfsPath),
    vfs,
    shims: createShimRegistry([
      stubShim('diagram', 'mermaid', stubSvg(240, 120, '#dde4f0')),
      stubShim('math', 'mathjax', stubSvg(120, 32, '#f0e4dd')),
    ]),
    includeAssembler: { assemble: () => ({ content: source, unresolved: [] }) },
    cache: {
      get: (hash) => cache.get(hash),
      has: (hash) => cache.has(hash),
      set: (asset) => void cache.set(asset.sourceHash, asset),
    },
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
  await createDiagramsMathStage().run(context);
  return {
    rewritten: vfs.readText(rootVfsPath) ?? '',
    generated: vfs.entries().filter(([path]) => path.startsWith('/project/.gen/')),
    diagnostics: context.diagnostics.all(),
  };
}

/**
 * The synthetic assembled-line→source provenance for the alignment fixture: everything from the
 * {@link INCLUDE_BOUNDARY_NEEDLE} line onwards is attributed to a second file, starting at ITS line 1.
 * This is what an include boundary looks like to the tracking hook, and a shifted `lineno` reads the
 * wrong side of it — the exact-origin stamp then names the wrong file entirely.
 */
function buildAlignProvenance(lines, boundaryIndex) {
  return lines.map((_line, index) =>
    index < boundaryIndex
      ? { path: ALIGN_MAIN_PATH, sourceLine: index + 1 }
      : { path: ALIGN_INCLUDED_PATH, sourceLine: index - boundaryIndex + 1 },
  );
}

/** Layout order for two source-map entries: page first, then vertical position down the page. */
function positionRank(entry) {
  return entry.page * 2 + entry.yFraction;
}

// ---------------------------------------------------------------------------
// Ruby program: convert the populated project capturing the FULL engine log so a highlighter-
// unavailable warning is visible (the packaged convert path deliberately filters warnings down to a
// per-resource subset, which would hide it). Mirrors the shipping convert semantics otherwise.
// ---------------------------------------------------------------------------

const PROBE_OUTPUT = '/out/probe.pdf';

function rubyString(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function rubyHash(attributes) {
  const entries = Object.entries(attributes).map(
    ([key, value]) => `${rubyString(key)} => ${value === null ? 'nil' : rubyString(value)}`,
  );
  return `{ ${entries.join(', ')} }`;
}

function buildProbeConvertCode(attributes) {
  return [
    "require 'json'",
    "require 'asciidoctor'",
    "require 'asciidoctor-pdf'",
    'begin',
    '  logger = Asciidoctor::MemoryLogger.new',
    '  Asciidoctor::LoggerManager.logger = logger',
    `  Asciidoctor.convert_file('/project/${ROOT_DOC}', backend: 'pdf', safe: :unsafe, ` +
      `to_file: '${PROBE_OUTPUT}', mkdirs: true, attributes: ${rubyHash(attributes)})`,
    "  warnings = logger.messages.map { |m| { 'severity' => m[:severity].to_s, " +
      "'message' => (m[:message].is_a?(::Hash) ? m[:message][:text] : m[:message]).to_s } }",
    "  JSON.generate({ 'ok' => true, 'warnings' => warnings })",
    'rescue => e',
    "  JSON.generate({ 'ok' => false, 'code' => e.class.name, 'message' => e.message })",
    'end',
  ].join('\n');
}

const ROUGE_REQUIRE_PROBE = [
  'begin',
  "  require 'rouge'",
  "  'true'",
  'rescue ::LoadError, ::StandardError',
  "  'false'",
  'end',
].join('\n');

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

const now = () => Number(process.hrtime.bigint()) / 1e6;

function log(message) {
  process.stderr.write(`${message}\n`);
}

function isPdf(bytes) {
  const header = Buffer.from(bytes.slice(0, 5)).toString('latin1');
  return header === '%PDF-';
}

function bytesEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function firstDiffOffset(a, b) {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return a.length === b.length ? -1 : limit;
}

// Extract the PDF text layer with poppler's pdftotext when present; returns null when the tool is
// unavailable so the caller can fall back to warning-based verification.
function extractPdfText(rawPdf) {
  const probe = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' });
  if (probe.error) {
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), 'engine-smoke-'));
  const pdfFile = join(dir, 'doc.pdf');
  writeFileSync(pdfFile, Buffer.from(rawPdf));
  const result = spawnSync('pdftotext', [pdfFile, '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(WASM_PATH)) {
    log(`wasm engine not present at ${WASM_PATH}; nothing to measure.`);
    process.stdout.write(`${JSON.stringify({ ran: false, reason: 'wasm-absent' })}\n`);
    return;
  }

  // Cold start: read + compile the wasm module, then warm the VM once.
  const wasmBytes = readFileSync(WASM_PATH);
  log(`Compiling wasm module (${(wasmBytes.length / (1024 * 1024)).toFixed(1)} MiB)...`);
  const compileStart = now();
  const module = await WebAssembly.compile(wasmBytes);
  const moduleCompileMs = now() - compileStart;

  const vm = createRubyPdfVm({ createBridge: () => createWasiBridge({ module }) });
  log('Warming VM (instantiate + Ruby boot)...');
  const warmupStart = now();
  const warmupOutcome = await vm.warmup();
  const warmupMs = now() - warmupStart;
  const coldStartMs = moduleCompileMs + warmupMs;
  log(`Cold start: compile ${moduleCompileMs.toFixed(0)}ms + warmup ${warmupMs.toFixed(0)}ms (coldStart=${warmupOutcome.coldStart}).`);

  // Populate /project once; the warm VM keeps it across every convert.
  const snapshot = buildSnapshot();
  populateProject(vm, snapshot);
  const attributes = buildConvertAttributes(snapshot);
  log(`Convert attributes: ${JSON.stringify(attributes)}`);

  // Does the highlighter gem actually load inside the VM?
  const rougeRequireable = vm.eval(ROUGE_REQUIRE_PROBE).toString().trim() === 'true';
  log(`rouge require inside VM: ${rougeRequireable}`);

  const request = { requestId: 'engine-smoke', mode: 'export', snapshot, optimize: false };

  // First convert (through the real packaged invoke path — buildConvertCode + normalizePdfBytes).
  const firstStart = now();
  const first = await invokeConvert({ vm, request });
  const firstConvertMs = now() - firstStart;
  if (!first.ok) {
    throw new Error(`First convert failed: ${first.error.phase}/${first.error.code}: ${first.error.message}`);
  }
  log(`First convert: ${firstConvertMs.toFixed(0)}ms, ${first.bytes.length} normalized bytes.`);

  // Source map: the real convert path writes /out/sourcemap.json via the tracking hook and reads it
  // back onto `first.sourceMap`. Verify it is non-empty, line-sorted, and every entry is plausible.
  const sourceMapEntries = Array.isArray(first.sourceMap) ? first.sourceMap : [];
  let sourceMapSorted = true;
  for (let index = 1; index < sourceMapEntries.length; index += 1) {
    if (sourceMapEntries[index].line < sourceMapEntries[index - 1].line) {
      sourceMapSorted = false;
    }
  }
  const sourceMapEntryValid = (entry) =>
    Number.isInteger(entry.line) &&
    entry.line > 0 &&
    Number.isInteger(entry.page) &&
    entry.page > 0 &&
    typeof entry.yFraction === 'number' &&
    entry.yFraction >= 0 &&
    entry.yFraction <= 1;
  const sourceMapAllValid = sourceMapEntries.length > 0 && sourceMapEntries.every(sourceMapEntryValid);
  log(`Source map: ${sourceMapEntries.length} entries, sorted=${sourceMapSorted}, allValid=${sourceMapAllValid}`);
  log(`Source map sample: ${JSON.stringify(sourceMapEntries.slice(0, 8))}`);

  // Every list/term/description line (content laid out without a `convert` dispatch) must be covered
  // by a source-map entry. The document has no includes, so an assembled line equals its source line.
  const docLines = DOC_SOURCE.split('\n');
  const mapLines = new Set(sourceMapEntries.map((entry) => entry.line));
  const listCoverageLines = LIST_COVERAGE_NEEDLES.map(
    (needle) => docLines.findIndex((line) => line.includes(needle)) + 1,
  );
  const listLinesCovered =
    listCoverageLines.every((line) => line > 0) && listCoverageLines.every((line) => mapLines.has(line));
  log(`Source map list coverage: lines ${JSON.stringify(listCoverageLines)}, covered=${listLinesCovered}`);

  // Covered is not enough: each list line must be recorded at the position it is ACTUALLY laid out
  // at. A term whose description sits on the following line ("Memory::") is inked directly by
  // convert_dlist, and when it is only approximated at the list's top it lands on the very position
  // an earlier item already occupies — so a click there resolves to that other item's line and PDF
  // click-to-source jumps to the wrong place in the editor. Distinct positions are what rule that out.
  const positionByLine = new Map(sourceMapEntries.map((entry) => [entry.line, `${entry.page}:${entry.yFraction}`]));
  const listPositions = listCoverageLines.map((line) => positionByLine.get(line));
  const listPositionsDistinct =
    listPositions.every((position) => position !== undefined) &&
    new Set(listPositions).size === listPositions.length;
  log(`Source map list positions: ${JSON.stringify(listPositions)}, distinct=${listPositionsDistinct}`);

  // Warm re-convert (same input, same warm VM).
  const warmStart = now();
  const second = await invokeConvert({ vm, request });
  const warmReconvertMs = now() - warmStart;
  if (!second.ok) {
    throw new Error(`Warm re-convert failed: ${second.error.phase}/${second.error.code}: ${second.error.message}`);
  }
  log(`Warm re-convert: ${warmReconvertMs.toFixed(0)}ms, ${second.bytes.length} normalized bytes.`);
  log(`In-VM stages (first convert): ${JSON.stringify(first.vmStages ?? null)}`);
  log(`In-VM stages (warm re-convert): ${JSON.stringify(second.vmStages ?? null)}`);

  // Determinism: the two normalized outputs must be byte-identical; normalize must be idempotent.
  const byteIdentical = bytesEqual(first.bytes, second.bytes);
  const diffOffset = byteIdentical ? -1 : firstDiffOffset(first.bytes, second.bytes);
  const idempotent = bytesEqual(first.bytes, normalizePdfBytes(first.bytes));
  log(`Determinism: byteIdentical=${byteIdentical} idempotent=${idempotent}${byteIdentical ? '' : ` firstDiff@${diffOffset}`}`);

  // Full-warning convert for the highlighting check + a raw (valid, un-normalized) PDF for text
  // extraction.
  const probeValue = await vm.evalAsync(buildProbeConvertCode(attributes));
  const probeRaw = JSON.parse(probeValue.toString());
  const probeOk = probeRaw.ok === true;
  const probeWarnings = Array.isArray(probeRaw.warnings) ? probeRaw.warnings : [];
  const highlighterWarnings = probeWarnings.filter((w) => HIGHLIGHTER_UNAVAILABLE_PATTERN.test(String(w.message)));
  log(`Probe convert ok=${probeOk}, warnings=${probeWarnings.length}, highlighter-unavailable=${highlighterWarnings.length}`);

  let rawProbePdf = null;
  if (probeOk) {
    rawProbePdf = vm.readFile(PROBE_OUTPUT);
    vm.removeFile(PROBE_OUTPUT);
  }

  // Text-layer verification (best-effort; null when no extractor is installed).
  let extractedText = null;
  const foundFragments = {};
  if (rawProbePdf !== null) {
    extractedText = extractPdfText(rawProbePdf);
    if (extractedText !== null) {
      for (const fragment of EXPECTED_CODE_FRAGMENTS) {
        foundFragments[fragment] = extractedText.includes(fragment);
      }
    }
  }

  // Sizes: raw engine output + brotli-compressed, from the un-normalized probe render.
  const rawPdfBytes = rawProbePdf !== null ? rawProbePdf.length : first.bytes.length;
  const brotliBytes = brotliCompressSync(Buffer.from(rawProbePdf ?? first.bytes)).length;

  // -------------------------------------------------------------------------
  // Coordinate alignment: the REAL diagrams-math rewrite, then a real convert of its output.
  // -------------------------------------------------------------------------
  const alignLines = ALIGN_DOC_SOURCE.split('\n');
  const stage = await runDiagramsMathStage(ALIGN_DOC_SOURCE, ALIGN_ROOT);
  const rewrittenLines = stage.rewritten.split('\n');
  const lineCountPreserved = rewrittenLines.length === alignLines.length;
  log(
    `Alignment: stage rewrote ${alignLines.length} lines into ${rewrittenLines.length} ` +
      `(preserved=${lineCountPreserved}), ${stage.generated.length} generated assets, ` +
      `${stage.diagnostics.length} diagnostics.`,
  );

  const alignSnapshot = {
    files: { [ALIGN_ROOT]: stage.rewritten },
    binaryAssets: {},
    rootPath: ALIGN_ROOT,
    openPath: ALIGN_ROOT,
    fontPaths: [],
    attributes: {},
  };
  populateProject(vm, alignSnapshot);
  for (const [genPath, genBytes] of stage.generated) {
    vm.writeFile(genPath, genBytes);
  }

  // The provenance sidecar the include-resolve stage would have written for a preview render.
  const boundaryIndex = alignLines.indexOf(INCLUDE_BOUNDARY_NEEDLE);
  const provenance = buildAlignProvenance(alignLines, boundaryIndex);
  vm.writeFile(SOURCE_PROVENANCE_PATH, new TextEncoder().encode(JSON.stringify(provenance)));

  const alignRequest = {
    requestId: 'engine-smoke-align',
    mode: 'preview',
    snapshot: alignSnapshot,
    optimize: false,
  };
  const alignResult = await invokeConvert({ vm, request: alignRequest });
  if (!alignResult.ok) {
    throw new Error(
      `Alignment convert failed: ${alignResult.error.phase}/${alignResult.error.code}: ${alignResult.error.message}`,
    );
  }
  const alignMap = Array.isArray(alignResult.sourceMap) ? alignResult.sourceMap : [];

  // The document's real page count, published by the hook's convert_document wrapper. Read through the
  // VFS rather than the eval's return value, for the same memory-safety reason the convert result is.
  const PAGE_COUNT_PROBE = '/out/pagecount.txt';
  vm.eval(`File.write('${PAGE_COUNT_PROBE}', ($__asciidocollab_page_count || 0).to_s)`);
  const alignPageCount = Number(new TextDecoder().decode(vm.readFile(PAGE_COUNT_PROBE)).trim());
  vm.removeFile(PAGE_COUNT_PROBE);

  const alignByLine = new Map(alignMap.map((entry) => [entry.line, entry]));
  const alignmentRows = ALIGNMENT_NEEDLES.map((needle) => {
    const expectedLine = alignLines.indexOf(needle) + 1;
    const entry = alignByLine.get(expectedLine);
    return {
      needle,
      expectedLine,
      mapped: entry !== undefined,
      path: entry?.path ?? null,
      sourceLine: entry?.sourceLine ?? null,
    };
  });
  const linesAligned = alignmentRows.every((row) => row.mapped);
  log(`Alignment rows: ${JSON.stringify(alignmentRows)}`);

  // Exact-origin attribution across the include boundary: the boundary line is line 1 of the SECOND
  // file, and the marker above it still belongs to the first. A shifted `lineno` reads the wrong side.
  const boundaryRow = alignmentRows.at(-1);
  const beforeBoundaryRow = alignmentRows.at(-2);
  const originAttributed =
    boundaryRow.path === ALIGN_INCLUDED_PATH &&
    boundaryRow.sourceLine === 1 &&
    beforeBoundaryRow.path === ALIGN_MAIN_PATH;
  log(`Alignment origin attribution: correct=${originAttributed}`);

  // Scratch-document captures: the paragraph inside the example block is measured in a throwaway
  // document before it is inked, and that measurement must NOT become its recorded position. Its real
  // position lies between the markers that bracket the block.
  const rankOf = (needle) => {
    const entry = alignByLine.get(alignLines.indexOf(needle) + 1);
    return entry === undefined ? null : positionRank(entry);
  };
  const beforeRank = rankOf('MARKER before the measured blocks.');
  const innerRank = rankOf('INNER paragraph, measured in a scratch document before it is inked.');
  const afterRank = rankOf('MARKER after the example block.');
  const scratchCapturesExcluded =
    beforeRank !== null &&
    innerRank !== null &&
    afterRank !== null &&
    beforeRank < innerRank &&
    innerRank < afterRank;
  const maxMappedPage = alignMap.reduce((max, entry) => Math.max(max, entry.page), 0);
  const pagesWithinDocument = alignPageCount > 0 && maxMappedPage <= alignPageCount;
  log(
    `Alignment scratch: ranks ${beforeRank}/${innerRank}/${afterRank} ordered=${scratchCapturesExcluded}, ` +
      `maxPage=${maxMappedPage} of ${alignPageCount} pages (withinDocument=${pagesWithinDocument}).`,
  );

  // The padding must be INERT: converting the rewrite with its filler lines stripped has to produce
  // byte-identical output, or preserving the line span would be buying coordinates with fidelity.
  vm.writeFile(
    `/project/${ALIGN_ROOT}`,
    new TextEncoder().encode(rewrittenLines.filter((line) => line !== '//').join('\n')),
  );
  const unpaddedResult = await invokeConvert({ vm, request: alignRequest });
  if (!unpaddedResult.ok) {
    throw new Error(
      `Unpadded alignment convert failed: ${unpaddedResult.error.phase}/${unpaddedResult.error.code}: ${unpaddedResult.error.message}`,
    );
  }
  const paddingInert = bytesEqual(alignResult.bytes, unpaddedResult.bytes);
  log(`Alignment padding inert (padded vs stripped render byte-identical): ${paddingInert}`);

  // Suggested warm re-render budget: the measured warm time plus generous headroom, rounded up to a
  // clean ceiling so it is a stable, assertable number rather than a moving measurement.
  const suggestedWarmBudgetMs = Math.max(500, Math.ceil((warmReconvertMs * 2) / 500) * 500);

  const summary = {
    ran: true,
    wasm: { path: WASM_PATH, bytes: wasmBytes.length },
    timings: {
      moduleCompileMs: Math.round(moduleCompileMs),
      warmupMs: Math.round(warmupMs),
      coldStartMs: Math.round(coldStartMs),
      firstConvertMs: Math.round(firstConvertMs),
      warmReconvertMs: Math.round(warmReconvertMs),
    },
    // What the convert cost INSIDE the VM, measured by the engine itself. The figures above bound the
    // whole call and cannot separate the dry runs from the rest; only these can, and only a run
    // against the real engine produces them — a fake VM never executes Ruby, so it can prove the
    // program asks for them and nothing about what they are.
    vmStages: { first: first.vmStages ?? null, warm: second.vmStages ?? null },
    sizes: { rawPdfBytes, brotliBytes, normalizedPdfBytes: first.bytes.length },
    highlighting: {
      convertOk: first.ok && probeOk,
      rougeRequireable,
      firstConvertIsPdf: isPdf(first.bytes),
      highlighterUnavailableWarnings: highlighterWarnings.map((w) => w.message),
      totalEngineWarnings: probeWarnings.length,
      textExtractorAvailable: extractedText !== null,
      foundCodeFragments: foundFragments,
    },
    determinism: {
      byteIdentical,
      firstDiffOffset: diffOffset,
      normalizedLen1: first.bytes.length,
      normalizedLen2: second.bytes.length,
      idempotentNormalize: idempotent,
    },
    sourceMap: {
      entryCount: sourceMapEntries.length,
      sorted: sourceMapSorted,
      allEntriesValid: sourceMapAllValid,
      listLinesCovered,
      listPositionsDistinct,
      sample: sourceMapEntries.slice(0, 8),
    },
    alignment: {
      lineCountPreserved,
      linesAligned,
      originAttributed,
      scratchCapturesExcluded,
      pagesWithinDocument,
      paddingInert,
      pageCount: alignPageCount,
      maxMappedPage,
      entryCount: alignMap.length,
      rows: alignmentRows,
    },
    suggestedWarmBudgetMs,
  };

  vm.dispose();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  log(`Harness failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.stdout.write(`${JSON.stringify({ ran: false, reason: 'error', message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
