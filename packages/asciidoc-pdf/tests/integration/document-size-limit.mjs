/**
 * @file Standalone Node ESM harness that measures how large a document the page-formatted render path
 * actually supports, by rendering documents of increasing size through the REAL Asciidoctor-PDF wasm
 * engine and recording where — and how — it stops working.
 *
 * Why a harness rather than a test: the failure being characterised is an out-of-memory one, and an
 * out-of-memory failure in a wasm VM is not always a catchable exception. A wasm trap can abort the VM
 * mid-eval and, at the extreme, take the whole Node process with it. A single in-process loop over the
 * sizes would therefore lose every measurement taken before the size that killed it, and would report
 * the crash as "the suite failed" rather than as the datum it is. So each size is rendered in its OWN
 * child process (`--lines=N`), and the sweep driver (`--sweep=a,b,c`) records that child's JSON summary
 * when it exits cleanly and its exit signal/status when it does not. Both outcomes are measurements.
 *
 * Each child starts a FRESH VM, so the size at which a render fails is a property of the document and
 * not of whatever the preceding renders left behind in a reused VM.
 *
 * Usage:
 *   node document-size-limit.mjs --lines=1700 [--repeat=1] [--shape=sections|dense]
 *   node document-size-limit.mjs --sweep=400,800,1700,3000 [--shape=sections|dense]
 *
 * Two document SHAPES are offered because the engine's cost tracks printed pages, not source lines,
 * and the two are only loosely related. `sections` is sparse (short lines, blank lines, list and code
 * blocks) and yields roughly 52 source lines per page; `dense` is long wrapped prose and yields
 * roughly 20. Measuring both is what separates a bound in lines from a bound in content, and the
 * reported failure — "1,700 lines / 80 pages" — is only self-consistent under a dense shape.
 *
 * The last stdout line is always a machine-readable JSON summary; human-readable progress goes to
 * stderr.
 *
 * NOTE on re-running this after the bound was declared: the harness drives the real, shipping convert
 * path, which now refuses a document past the declared bound before the engine sees it. So sizes above
 * the bound report the refusal (in milliseconds) rather than the underlying engine failure. That IS
 * the behaviour under test — but it means the raw engine ceiling recorded in the baseline cannot be
 * re-derived from this harness without first raising the declared bound.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');
const DIST = join(PACKAGE_ROOT, 'dist');
const WASM_PATH = join(PACKAGE_ROOT, 'ruby', 'asciidoctor-pdf.wasm');

const { createWasiBridge } = require(join(DIST, 'vm', 'wasi-bridge.js'));
const { createRubyPdfVm } = require(join(DIST, 'vm', 'ruby-pdf-vm.js'));
const { populateProject } = require(join(DIST, 'vfs', 'populate.js'));
const { invokeConvert } = require(join(DIST, 'convert', 'invoke.js'));

const ROOT_DOC = 'doc.adoc';
const PAGE_COUNT_PROBE = '/out/pagecount.txt';

// ---------------------------------------------------------------------------
// Document generator.
//
// The shape mirrors the one the web-formatted size curve was taken with (a title, then repeating
// sections of prose, a two-item list and a Ruby source block, truncated to the requested line count),
// so a page-formatted bound and a web-formatted timing describe the same document and can be read
// against each other.
// ---------------------------------------------------------------------------

/** A ~400-character prose line, so one source line wraps to roughly five printed ones. */
function densePassage(index) {
  const sentence =
    `Passage ${index} continues the argument at the length an authored paragraph actually runs to, ` +
    'so that a single source line wraps across several printed lines and the page count climbs with ' +
    'the content rather than with the number of newlines the author happened to type. ';
  return (sentence.repeat(2) + sentence).slice(0, 400);
}

/**
 * Build a document of approximately `lines` lines in the requested shape.
 *
 * `sections` repeats an authored section (heading, prose, a two-item list, a Ruby source block) and is
 * the shape the web-formatted size curve was taken with, so a page-formatted bound and a web-formatted
 * timing describe the same kind of document. `dense` repeats a long wrapped prose paragraph, which
 * reaches a given page count in far fewer source lines.
 *
 * @param lines - The target line count the generated document is truncated to.
 * @param shape - Which repeating body to build the document out of.
 * @returns The AsciiDoc source of a document that long.
 */
function buildDocument(lines, shape) {
  const out = ['= Document Size Probe', ':source-highlighter: rouge', ''];
  let section = 0;
  while (out.length < lines) {
    section += 1;
    if (shape === 'dense') {
      out.push(densePassage(section), '');
      continue;
    }
    out.push(
      `== Section ${section}`,
      '',
      `Prose paragraph ${section} carrying enough words to occupy a realistic amount of a printed`,
      'line, so the page count grows with the document the way an authored one does.',
      '',
      `* First list item in section ${section}`,
      `* Second list item in section ${section}`,
      '',
      '[source,ruby]',
      '----',
      `def section_${section}(subject)`,
      '  puts "Hello, #{subject}!"',
      'end',
      '----',
      '',
    );
  }
  return out.slice(0, lines).join('\n');
}

/**
 * Wrap a generated document as the project snapshot the convert path consumes.
 *
 * @param source - The AsciiDoc source to render as the project's root document.
 * @returns A single-file project snapshot rooted at that document.
 */
function buildSnapshot(source) {
  return {
    files: { [ROOT_DOC]: source },
    binaryAssets: {},
    rootPath: ROOT_DOC,
    openPath: ROOT_DOC,
    fontPaths: [],
    attributes: {},
  };
}

// ---------------------------------------------------------------------------
// Utilities.
// ---------------------------------------------------------------------------

const now = () => Number(process.hrtime.bigint()) / 1e6;

function log(message) {
  process.stderr.write(`${message}\n`);
}

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

/** Megabytes of resident set / external (wasm linear memory lands in the latter) for this process. */
function memorySample() {
  const usage = process.memoryUsage();
  return {
    rssMiB: Math.round(usage.rss / (1024 * 1024)),
    externalMiB: Math.round(usage.external / (1024 * 1024)),
    heapUsedMiB: Math.round(usage.heapUsed / (1024 * 1024)),
  };
}

/**
 * Read the page count the converter's tracking hook published for the last render.
 *
 * @param vm - The warm VM the render ran in.
 * @returns The rendered page count, or 0 when the hook published none.
 */
function readPageCount(vm) {
  try {
    vm.eval(`File.write('${PAGE_COUNT_PROBE}', ($__asciidocollab_page_count || 0).to_s)`);
    const value = Number(new TextDecoder().decode(vm.readFile(PAGE_COUNT_PROBE)).trim());
    vm.removeFile(PAGE_COUNT_PROBE);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Single size, in this process.
// ---------------------------------------------------------------------------

async function runOneSize(lines, repeat, shape) {
  const source = buildDocument(lines, shape);
  const wasmBytes = readFileSync(WASM_PATH);
  const module = await WebAssembly.compile(wasmBytes);
  const vm = createRubyPdfVm({ createBridge: () => createWasiBridge({ module }) });
  await vm.warmup();

  const snapshot = buildSnapshot(source);
  populateProject(vm, snapshot);

  const renders = [];
  for (let index = 0; index < repeat; index += 1) {
    const request = {
      requestId: `size-${lines}-${index}`,
      mode: 'export',
      snapshot,
      optimize: false,
    };
    const start = now();
    let outcome;
    try {
      const result = await invokeConvert({ vm, request });
      outcome = result.ok
        ? { ok: true, bytes: result.bytes.length }
        : { ok: false, phase: result.error.phase, code: result.error.code, message: result.error.message };
    } catch (error) {
      outcome = {
        ok: false,
        phase: 'thrown',
        code: error instanceof Error ? error.constructor.name : 'unknown',
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      };
    }
    const ms = Math.round(now() - start);
    renders.push({ ...outcome, ms, pages: outcome.ok ? readPageCount(vm) : 0, memory: memorySample() });
    log(
      `  lines=${lines} render ${index + 1}/${repeat}: ok=${outcome.ok} ${ms}ms ` +
        `pages=${renders.at(-1).pages} rss=${renders.at(-1).memory.rssMiB}MiB` +
        (outcome.ok ? '' : ` -> ${outcome.phase}/${outcome.code}: ${outcome.message.split('\n')[0]}`),
    );
  }

  vm.dispose();
  return { lines, shape, sourceBytes: Buffer.byteLength(source), renders };
}

// ---------------------------------------------------------------------------
// Sweep driver: one child process per size.
// ---------------------------------------------------------------------------

function runSweep(sizes, repeat, shape) {
  const results = [];
  for (const lines of sizes) {
    log(`--- sweeping ${lines} ${shape} lines ---`);
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), `--lines=${lines}`, `--repeat=${repeat}`, `--shape=${shape}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    process.stderr.write(child.stderr ?? '');
    const lastLine = (child.stdout ?? '').trim().split('\n').at(-1) ?? '';
    let summary = null;
    try {
      summary = JSON.parse(lastLine);
    } catch {
      summary = null;
    }
    results.push({
      lines,
      exitStatus: child.status,
      exitSignal: child.signal,
      // A child that produced no summary died before it could print one — the harness records that as
      // the measurement it is (a process-level abort), not as a harness bug.
      summary,
    });
    if (summary === null) {
      log(`  lines=${lines}: child produced no summary (status=${child.status} signal=${child.signal})`);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(WASM_PATH)) {
    process.stdout.write(`${JSON.stringify({ ran: false, reason: 'wasm-absent' })}\n`);
    return;
  }

  const repeat = Number(argValue('repeat') ?? '1');
  const shape = argValue('shape') ?? 'sections';
  const sweep = argValue('sweep');
  if (sweep !== null) {
    const sizes = sweep.split(',').map((value) => Number(value.trim())).filter((value) => value > 0);
    const results = runSweep(sizes, repeat, shape);
    process.stdout.write(`${JSON.stringify({ ran: true, mode: 'sweep', shape, results })}\n`);
    return;
  }

  const lines = Number(argValue('lines') ?? '1700');
  const result = await runOneSize(lines, repeat, shape);
  process.stdout.write(`${JSON.stringify({ ran: true, mode: 'single', ...result })}\n`);
}

main().catch((error) => {
  log(`Harness failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.stdout.write(
    `${JSON.stringify({ ran: false, reason: 'error', message: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});
