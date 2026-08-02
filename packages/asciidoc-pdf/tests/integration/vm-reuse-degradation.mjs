/**
 * @file Standalone Node ESM harness that measures whether a REUSED page-format render VM degrades
 * across consecutive renders, against the same document rendered in a FRESH VM every time.
 *
 * The question it answers is narrow and comparative: does keeping one warm VM make the eighth render
 * slower than the first, and if so, is the slowdown big enough to be worth paying a cold start to
 * avoid? Both arms render the SAME document the SAME number of times through the real engine, and both
 * report every individual render rather than an average, because a degradation claim is a claim about
 * the SHAPE of the series — an average hides exactly the thing being tested.
 *
 * The wasm module is compiled once and shared by both arms. Module compilation is cacheable and is not
 * part of what "reuse the VM" buys you; charging it to the fresh arm would credit reuse with a saving
 * it does not make.
 *
 * The fresh arm reports the render alone and the render plus the VM boot it had to pay for, because
 * those answer different questions: the first says whether a fresh VM renders faster, the second says
 * what an author actually waits for.
 *
 * A third arm, `shipping`, drives the lifecycle the render worker actually runs (warmup per render on
 * one facade, a per-render delta populate, then the convert) and reports the per-stage breakdown, so
 * the recorded stage profile can be taken under the arrangement the product uses rather than inferred.
 *
 * Usage:
 *   node vm-reuse-degradation.mjs [--lines=1500] [--renders=8] [--arm=reused|fresh|shipping|both]
 *
 * The last stdout line is a machine-readable JSON summary; progress goes to stderr.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

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

const now = () => Number(process.hrtime.bigint()) / 1e6;

function log(message) {
  process.stderr.write(`${message}\n`);
}

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

/**
 * Build a document of approximately `lines` lines, in the same repeating shape the size sweep and the
 * web-formatted baseline use, so the three sets of figures describe the same kind of document.
 *
 * @param lines - The target line count the generated document is truncated to.
 * @returns The AsciiDoc source of a document that long.
 */
function buildDocument(lines) {
  const out = ['= Render VM Reuse Probe', ':source-highlighter: rouge', ''];
  let section = 0;
  while (out.length < lines) {
    section += 1;
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

function memorySample() {
  const usage = process.memoryUsage();
  return {
    rssMiB: Math.round(usage.rss / (1024 * 1024)),
    externalMiB: Math.round(usage.external / (1024 * 1024)),
  };
}

/**
 * Render once and REPORT the outcome, success or failure. A failed render is not a harness error: a VM
 * that stops being able to render after N reuses is precisely the finding this harness exists to
 * record, and throwing here would discard the series that shows it.
 */
async function renderOnce(vm, snapshot, index) {
  const request = {
    requestId: `reuse-probe-${index}`,
    mode: 'export',
    snapshot,
    optimize: false,
  };
  const start = now();
  let result;
  try {
    result = await invokeConvert({ vm, request });
  } catch (error) {
    return { ms: now() - start, ok: false, failure: error instanceof Error ? error.message : String(error) };
  }
  const ms = now() - start;
  return result.ok
    ? { ms, ok: true, bytes: result.bytes.length, vmStages: result.vmStages }
    : { ms, ok: false, failure: `${result.error.phase}/${result.error.code}: ${result.error.message}` };
}

/** Render `count` times against ONE VM warmed once — the arrangement under test. */
async function runReused(module, snapshot, count) {
  const vm = createRubyPdfVm({ createBridge: () => createWasiBridge({ module }) });
  const bootStart = now();
  await vm.warmup();
  const bootMs = now() - bootStart;
  populateProject(vm, snapshot);

  const renders = [];
  for (let index = 0; index < count; index += 1) {
    const outcome = await renderOnce(vm, snapshot, index);
    const memory = memorySample();
    renders.push({
      renderMs: Math.round(outcome.ms),
      bootMs: 0,
      totalMs: Math.round(outcome.ms),
      ok: outcome.ok,
      ...(outcome.ok ? { bytes: outcome.bytes } : { failure: outcome.failure }),
      memory,
    });
    log(
      `  reused #${index + 1}: ${Math.round(outcome.ms)}ms (rss ${memory.rssMiB}MiB, ` +
        `wasm+host buffers ${memory.externalMiB}MiB)` + (outcome.ok ? '' : ` FAILED: ${outcome.failure}`),
    );
  }
  vm.dispose();
  return { bootMs: Math.round(bootMs), renders };
}

/** Render `count` times, each against a VM booted for that render alone and disposed after it. */
async function runFresh(module, snapshot, count) {
  const renders = [];
  for (let index = 0; index < count; index += 1) {
    const vm = createRubyPdfVm({ createBridge: () => createWasiBridge({ module }) });
    const bootStart = now();
    await vm.warmup();
    const bootMs = now() - bootStart;
    populateProject(vm, snapshot);
    const outcome = await renderOnce(vm, snapshot, index);
    vm.dispose();
    const memory = memorySample();
    renders.push({
      renderMs: Math.round(outcome.ms),
      bootMs: Math.round(bootMs),
      totalMs: Math.round(bootMs + outcome.ms),
      ok: outcome.ok,
      ...(outcome.ok ? { bytes: outcome.bytes } : { failure: outcome.failure }),
      memory,
    });
    log(
      `  fresh  #${index + 1}: ${Math.round(outcome.ms)}ms render + ${Math.round(bootMs)}ms boot ` +
        `(rss ${memory.rssMiB}MiB)` + (outcome.ok ? '' : ` FAILED: ${outcome.failure}`),
    );
  }
  return { renders };
}

/**
 * Render `count` times through the SHIPPING lifecycle, exactly as the render worker drives it: one
 * long-lived VM facade, a `warmup()` at the top of every render (which retires an instance that has
 * already served one), a per-render populate carrying a changed-path delta, then the convert.
 *
 * This arm exists because the `fresh` arm above proves a point about the engine, not about the
 * product: it builds and disposes the facade itself, which no caller does. Only this arm exercises the
 * lifecycle the worker actually runs, including the interaction that a fresh instance creates — a
 * delta populate arriving at an empty filesystem. It also reports the per-stage breakdown, so the
 * profile can be re-recorded under the arrangement the product now uses.
 */
async function runShipping(module, snapshot, count) {
  const vm = createRubyPdfVm({ createBridge: () => createWasiBridge({ module }) });
  const renders = [];
  for (let index = 0; index < count; index += 1) {
    const bootStart = now();
    const { coldStart } = await vm.warmup();
    const bootMs = coldStart ? now() - bootStart : 0;

    const populateStart = now();
    // Every render after the first carries a delta, which is what the worker sends once a document is
    // open and being edited. On an instance booted for this render there is nothing to be a delta
    // against, and the populate has to notice that; an empty delta is the sharpest case.
    const populated = populateProject(vm, snapshot, index === 0 ? {} : { changedPaths: [] });
    const populateMs = now() - populateStart;

    const outcome = await renderOnce(vm, snapshot, index);
    const memory = memorySample();
    renders.push({
      bootMs: Math.round(bootMs),
      populateMs: Math.round(populateMs),
      renderMs: Math.round(outcome.ms),
      totalMs: Math.round(bootMs + populateMs + outcome.ms),
      rootPresent: populated.rootPresent,
      filesWritten: populated.written.length,
      ok: outcome.ok,
      ...(outcome.ok ? { bytes: outcome.bytes, vmStages: outcome.vmStages ?? null } : { failure: outcome.failure }),
      memory,
    });
    log(
      `  shipping #${index + 1}: ${Math.round(outcome.ms)}ms render + ${Math.round(bootMs)}ms boot + ` +
        `${Math.round(populateMs)}ms populate, ${populated.written.length} files written, ` +
        `rootPresent=${populated.rootPresent} (rss ${memory.rssMiB}MiB)` +
        (outcome.ok ? '' : ` FAILED: ${outcome.failure}`),
    );
  }
  vm.dispose();
  return { renders };
}

/** Summary statistics that make a degradation claim checkable: first, last, min, max, median. */
function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    first: values[0],
    last: values.at(-1),
    min: sorted[0],
    max: sorted.at(-1),
    median:
      sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle],
    lastOverFirst: Number((values.at(-1) / values[0]).toFixed(2)),
  };
}

async function main() {
  if (!existsSync(WASM_PATH)) {
    process.stdout.write(`${JSON.stringify({ ran: false, reason: 'wasm-absent' })}\n`);
    return;
  }

  const lines = Number(argValue('lines') ?? '1500');
  const count = Number(argValue('renders') ?? '8');
  const arm = argValue('arm') ?? 'both';

  const module = await WebAssembly.compile(readFileSync(WASM_PATH));
  const snapshot = buildSnapshot(buildDocument(lines));

  const summary = { ran: true, lines, renders: count, arms: {} };

  if (arm === 'both' || arm === 'reused') {
    log(`--- reused VM, ${count} consecutive renders of a ${lines}-line document ---`);
    const reused = await runReused(module, snapshot, count);
    summary.arms.reused = {
      ...reused,
      renderStats: statistics(reused.renders.map((entry) => entry.renderMs)),
    };
  }

  if (arm === 'both' || arm === 'fresh') {
    log(`--- fresh VM per render, ${count} renders of a ${lines}-line document ---`);
    const fresh = await runFresh(module, snapshot, count);
    summary.arms.fresh = {
      ...fresh,
      renderStats: statistics(fresh.renders.map((entry) => entry.renderMs)),
      totalStats: statistics(fresh.renders.map((entry) => entry.totalMs)),
    };
  }

  if (arm === 'both' || arm === 'shipping') {
    log(`--- shipping lifecycle, ${count} renders of a ${lines}-line document ---`);
    const shipping = await runShipping(module, snapshot, count);
    summary.arms.shipping = {
      ...shipping,
      renderStats: statistics(shipping.renders.map((entry) => entry.renderMs)),
      totalStats: statistics(shipping.renders.map((entry) => entry.totalMs)),
    };
  }

  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  log(`Harness failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.stdout.write(
    `${JSON.stringify({ ran: false, reason: 'error', message: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});
