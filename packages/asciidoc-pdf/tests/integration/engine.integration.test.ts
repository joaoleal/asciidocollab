/**
 * @file Gated integration test that drives the REAL Asciidoctor-PDF wasm engine through the package's
 * own bridge and asserts on syntax highlighting, deterministic output, and performance timings.
 *
 * The engine wasm is a large, separately-built artifact that is not present in a clean checkout or on
 * CI without the dedicated build job. This test therefore SKIPS when the wasm is absent (keeping the
 * suite green everywhere) and runs the real assertions only when it is present. The heavy lifting
 * happens in a standalone Node ESM harness (`engine-smoke.mjs`) — the ESM-only interop libraries are
 * awkward under ts-jest/CommonJS, so the harness runs as its own Node process and this test spawns it,
 * parses its JSON summary, and asserts on the measured results.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HARNESS = path.join(__dirname, 'engine-smoke.mjs');
const WASM_PATH = path.join(__dirname, '..', '..', 'ruby', 'asciidoctor-pdf.wasm');
const enginePresent = existsSync(WASM_PATH);

interface HarnessTimings {
  readonly moduleCompileMs: number;
  readonly warmupMs: number;
  readonly coldStartMs: number;
  readonly firstConvertMs: number;
  readonly warmReconvertMs: number;
}

interface HarnessHighlighting {
  readonly convertOk: boolean;
  readonly rougeRequireable: boolean;
  readonly firstConvertIsPdf: boolean;
  readonly highlighterUnavailableWarnings: readonly string[];
  readonly totalEngineWarnings: number;
  readonly textExtractorAvailable: boolean;
  readonly foundCodeFragments: Readonly<Record<string, boolean>>;
}

interface HarnessDeterminism {
  readonly byteIdentical: boolean;
  readonly firstDiffOffset: number;
  readonly idempotentNormalize: boolean;
}

interface HarnessSourceMapEntry {
  readonly line: number;
  readonly page: number;
  readonly yFraction: number;
}

interface HarnessSourceMap {
  readonly entryCount: number;
  readonly sorted: boolean;
  readonly allEntriesValid: boolean;
  readonly listLinesCovered: boolean;
  readonly listPositionsDistinct: boolean;
  readonly sample: readonly HarnessSourceMapEntry[];
}

/** One paragraph whose source-map entry must still be keyed to its ORIGINAL assembled line. */
interface HarnessAlignmentRow {
  readonly needle: string;
  readonly expectedLine: number;
  readonly mapped: boolean;
  readonly path: string | null;
  readonly sourceLine: number | null;
}

interface HarnessAlignment {
  readonly lineCountPreserved: boolean;
  readonly linesAligned: boolean;
  readonly originAttributed: boolean;
  readonly scratchCapturesExcluded: boolean;
  readonly pagesWithinDocument: boolean;
  readonly paddingInert: boolean;
  readonly pageCount: number;
  readonly maxMappedPage: number;
  readonly rows: readonly HarnessAlignmentRow[];
}

interface HarnessSummary {
  readonly ran: true;
  readonly timings: HarnessTimings;
  readonly sizes: { readonly rawPdfBytes: number; readonly brotliBytes: number };
  readonly highlighting: HarnessHighlighting;
  readonly determinism: HarnessDeterminism;
  readonly sourceMap: HarnessSourceMap;
  readonly alignment: HarnessAlignment;
  readonly suggestedWarmBudgetMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`Expected an object at ${location}, got ${typeof value}`);
  }
  return value;
}

function numberAt(value: unknown, location: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`Expected a number at ${location}, got ${typeof value}`);
  }
  return value;
}

function booleanAt(value: unknown, location: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Expected a boolean at ${location}, got ${typeof value}`);
  }
  return value;
}

function stringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected an array at ${location}, got ${typeof value}`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new TypeError(`Expected a string at ${location}[${String(index)}], got ${typeof item}`);
    }
    return item;
  });
}

function booleanRecord(value: unknown, location: string): Record<string, boolean> {
  const source = record(value, location);
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(source)) {
    out[key] = booleanAt(entry, `${location}.${key}`);
  }
  return out;
}

function parseSummary(value: unknown): HarnessSummary {
  const root = record(value, 'summary');
  if (root['ran'] !== true) {
    throw new TypeError(`Harness did not run to completion: ${JSON.stringify(root)}`);
  }
  const timings = record(root['timings'], 'timings');
  const sizes = record(root['sizes'], 'sizes');
  const highlighting = record(root['highlighting'], 'highlighting');
  const determinism = record(root['determinism'], 'determinism');
  const sourceMap = record(root['sourceMap'], 'sourceMap');
  return {
    ran: true,
    timings: {
      moduleCompileMs: numberAt(timings['moduleCompileMs'], 'timings.moduleCompileMs'),
      warmupMs: numberAt(timings['warmupMs'], 'timings.warmupMs'),
      coldStartMs: numberAt(timings['coldStartMs'], 'timings.coldStartMs'),
      firstConvertMs: numberAt(timings['firstConvertMs'], 'timings.firstConvertMs'),
      warmReconvertMs: numberAt(timings['warmReconvertMs'], 'timings.warmReconvertMs'),
    },
    sizes: {
      rawPdfBytes: numberAt(sizes['rawPdfBytes'], 'sizes.rawPdfBytes'),
      brotliBytes: numberAt(sizes['brotliBytes'], 'sizes.brotliBytes'),
    },
    highlighting: {
      convertOk: booleanAt(highlighting['convertOk'], 'highlighting.convertOk'),
      rougeRequireable: booleanAt(highlighting['rougeRequireable'], 'highlighting.rougeRequireable'),
      firstConvertIsPdf: booleanAt(highlighting['firstConvertIsPdf'], 'highlighting.firstConvertIsPdf'),
      highlighterUnavailableWarnings: stringArray(
        highlighting['highlighterUnavailableWarnings'],
        'highlighting.highlighterUnavailableWarnings',
      ),
      totalEngineWarnings: numberAt(
        highlighting['totalEngineWarnings'],
        'highlighting.totalEngineWarnings',
      ),
      textExtractorAvailable: booleanAt(
        highlighting['textExtractorAvailable'],
        'highlighting.textExtractorAvailable',
      ),
      foundCodeFragments: booleanRecord(
        highlighting['foundCodeFragments'],
        'highlighting.foundCodeFragments',
      ),
    },
    determinism: {
      byteIdentical: booleanAt(determinism['byteIdentical'], 'determinism.byteIdentical'),
      firstDiffOffset: numberAt(determinism['firstDiffOffset'], 'determinism.firstDiffOffset'),
      idempotentNormalize: booleanAt(
        determinism['idempotentNormalize'],
        'determinism.idempotentNormalize',
      ),
    },
    sourceMap: {
      entryCount: numberAt(sourceMap['entryCount'], 'sourceMap.entryCount'),
      sorted: booleanAt(sourceMap['sorted'], 'sourceMap.sorted'),
      allEntriesValid: booleanAt(sourceMap['allEntriesValid'], 'sourceMap.allEntriesValid'),
      listLinesCovered: booleanAt(sourceMap['listLinesCovered'], 'sourceMap.listLinesCovered'),
      listPositionsDistinct: booleanAt(
        sourceMap['listPositionsDistinct'],
        'sourceMap.listPositionsDistinct',
      ),
      sample: sourceMapSample(sourceMap['sample'], 'sourceMap.sample'),
    },
    alignment: parseAlignment(root['alignment']),
    suggestedWarmBudgetMs: numberAt(root['suggestedWarmBudgetMs'], 'suggestedWarmBudgetMs'),
  };
}

function parseAlignment(value: unknown): HarnessAlignment {
  const source = record(value, 'alignment');
  const rows = source['rows'];
  if (!Array.isArray(rows)) {
    throw new TypeError('Expected an array at alignment.rows');
  }
  return {
    lineCountPreserved: booleanAt(source['lineCountPreserved'], 'alignment.lineCountPreserved'),
    linesAligned: booleanAt(source['linesAligned'], 'alignment.linesAligned'),
    originAttributed: booleanAt(source['originAttributed'], 'alignment.originAttributed'),
    scratchCapturesExcluded: booleanAt(
      source['scratchCapturesExcluded'],
      'alignment.scratchCapturesExcluded',
    ),
    pagesWithinDocument: booleanAt(source['pagesWithinDocument'], 'alignment.pagesWithinDocument'),
    paddingInert: booleanAt(source['paddingInert'], 'alignment.paddingInert'),
    pageCount: numberAt(source['pageCount'], 'alignment.pageCount'),
    maxMappedPage: numberAt(source['maxMappedPage'], 'alignment.maxMappedPage'),
    rows: rows.map((item, index) => {
      const row = record(item, `alignment.rows[${String(index)}]`);
      const path = row['path'];
      const sourceLine = row['sourceLine'];
      return {
        needle: String(row['needle']),
        expectedLine: numberAt(row['expectedLine'], `alignment.rows[${String(index)}].expectedLine`),
        mapped: booleanAt(row['mapped'], `alignment.rows[${String(index)}].mapped`),
        path: typeof path === 'string' ? path : null,
        sourceLine: typeof sourceLine === 'number' ? sourceLine : null,
      };
    }),
  };
}

function sourceMapSample(value: unknown, location: string): HarnessSourceMapEntry[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected an array at ${location}, got ${typeof value}`);
  }
  return value.map((item, index) => {
    const entry = record(item, `${location}[${String(index)}]`);
    return {
      line: numberAt(entry['line'], `${location}[${String(index)}].line`),
      page: numberAt(entry['page'], `${location}[${String(index)}].page`),
      yFraction: numberAt(entry['yFraction'], `${location}[${String(index)}].yFraction`),
    };
  });
}

function runHarness(): HarnessSummary {
  const result = spawnSync(process.execPath, [HARNESS], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Harness exited with status ${String(result.status)}:\n${result.stderr}`);
  }
  const lines = result.stdout.trim().split('\n');
  const lastLine = lines.at(-1);
  if (lastLine === undefined) {
    throw new Error(`Harness produced no JSON output. stderr:\n${result.stderr}`);
  }
  const parsed: unknown = JSON.parse(lastLine);
  return parseSummary(parsed);
}

const describeOrSkip = enginePresent ? describe : describe.skip;

describeOrSkip('Asciidoctor-PDF engine (real wasm)', () => {
  // Cold-start module compile + two converts + a text-extraction pass: give it plenty of headroom.
  jest.setTimeout(180_000);

  let summary: HarnessSummary;

  beforeAll(() => {
    summary = runHarness();
  });

  it('highlights source blocks via the rouge highlighter with no unavailable-highlighter warning', () => {
    expect(summary.highlighting.convertOk).toBe(true);
    expect(summary.highlighting.firstConvertIsPdf).toBe(true);
    expect(summary.highlighting.rougeRequireable).toBe(true);
    expect(summary.highlighting.highlighterUnavailableWarnings).toEqual([]);

    // When a PDF text extractor is available, the highlighted code text must survive into the PDF.
    // Otherwise the clean convert + zero highlighter warnings above stand as the verification.
    if (summary.highlighting.textExtractorAvailable) {
      for (const [fragment, found] of Object.entries(summary.highlighting.foundCodeFragments)) {
        expect(`${fragment}:${String(found)}`).toBe(`${fragment}:true`);
      }
    }
  });

  it('produces byte-identical output for identical input and a stable (idempotent) normalization', () => {
    expect(summary.determinism.byteIdentical).toBe(true);
    expect(summary.determinism.firstDiffOffset).toBe(-1);
    expect(summary.determinism.idempotentNormalize).toBe(true);
  });

  it('records positive cold-start, first-convert, and warm re-convert timings', () => {
    expect(summary.timings.coldStartMs).toBeGreaterThan(0);
    expect(summary.timings.firstConvertMs).toBeGreaterThan(0);
    expect(summary.timings.warmReconvertMs).toBeGreaterThan(0);
    expect(summary.sizes.rawPdfBytes).toBeGreaterThan(0);
  });

  it('renders a warm re-convert within the pinned preview-latency budget', () => {
    expect(summary.timings.warmReconvertMs).toBeLessThan(summary.suggestedWarmBudgetMs);
  });

  it('emits a non-empty, line-sorted block source map with plausible page/yFraction values', () => {
    // This is the proof the runtime Ruby tracking hook actually laid down entries as the PDF was
    // rendered: a real fixture must yield at least one block with a source location.
    expect(summary.sourceMap.entryCount).toBeGreaterThan(0);
    expect(summary.sourceMap.sorted).toBe(true);
    expect(summary.sourceMap.allEntriesValid).toBe(true);

    // The emitted sample is surfaced here so the coordinates are visible in the run log.
    // eslint-disable-next-line no-console
    console.info('Emitted source map sample:', JSON.stringify(summary.sourceMap.sample));

    for (const entry of summary.sourceMap.sample) {
      expect(Number.isInteger(entry.line)).toBe(true);
      expect(entry.line).toBeGreaterThan(0);
      expect(entry.page).toBeGreaterThan(0);
      expect(entry.yFraction).toBeGreaterThanOrEqual(0);
      expect(entry.yFraction).toBeLessThanOrEqual(1);
    }
  });

  it('covers list-item, dlist-term, and description lines (content laid out without a convert dispatch)', () => {
    // Description-list terms/descriptions and (u/o/colist) list items are inked by convert_dlist /
    // traverse_list_item, never dispatched through `convert`. Without the traverse_list_item hook and
    // the dlist-term pass, clicking such a line in the editor would snap the preview to a preceding
    // block. This asserts every one of those fixture lines now has its own source-map entry.
    expect(summary.sourceMap.listLinesCovered).toBe(true);
  });

  it('keeps every line number intact when the diagrams-math stage rewrites a block', () => {
    // The stage replaces a multi-line diagram/math block with a single `image::` macro, but the
    // provenance array the origin stamps index into — and the app's editor-line→assembled-line
    // translation — were both built against the PRE-rewrite text. Collapsing an 8-line mermaid block
    // shifted every later `lineno` by −7, cumulatively, so scroll sync drifted further off with each
    // block. The rewrite therefore has to preserve each block's line span.
    expect(summary.alignment.lineCountPreserved).toBe(true);
    // eslint-disable-next-line no-console
    console.info('Alignment rows:', JSON.stringify(summary.alignment.rows));
    for (const row of summary.alignment.rows) {
      expect(`${row.needle}:${String(row.mapped)}`).toBe(`${row.needle}:true`);
    }
    expect(summary.alignment.linesAligned).toBe(true);
  });

  it('renders the padded rewrite byte-identically to the unpadded one', () => {
    // Preserving the line span must cost nothing in fidelity: the filler is an AsciiDoc line comment,
    // which the reader drops before any block is built, so stripping it cannot change the output.
    expect(summary.alignment.paddingInert).toBe(true);
  });

  it('stamps the exact source origin on the right side of an include boundary', () => {
    // The origin stamp reads `provenance[lineno - 1]`, so a shifted `lineno` does not merely land on
    // the wrong line — near an include boundary it names the wrong FILE, and click-to-source opens a
    // document the block never came from.
    expect(summary.alignment.originAttributed).toBe(true);
  });

  it('excludes scratch-document captures taken while measuring a keep-together block', () => {
    // Asciidoctor-PDF measures example/sidebar/admonition/quote blocks by converting them into a
    // throwaway scratch document first. That document is a Marshal copy of the converter, so it carries
    // these hooks and records positions from its own page numbering — and it records them FIRST, so the
    // keep-first de-duplication pinned the measured block to a position that exists nowhere in the PDF.
    // The paragraph inside the example block must sit between the markers that bracket it.
    expect(summary.alignment.scratchCapturesExcluded).toBe(true);
    // Backstop: nothing may claim a page beyond the finished document.
    expect(summary.alignment.pageCount).toBeGreaterThan(0);
    expect(summary.alignment.maxMappedPage).toBeLessThanOrEqual(summary.alignment.pageCount);
    expect(summary.alignment.pagesWithinDocument).toBe(true);
  });

  it('records each list line at its own layout position, not a shared approximation', () => {
    // Coverage alone let a term be recorded at the LIST's top rather than where it is inked, which
    // put two different items on one point. Reverse lookup resolves a click to the last block at or
    // above it, so the collision made clicking one item in the PDF jump to the other one's line in
    // the editor. Distinct positions per list line are what make that reverse lookup unambiguous.
    expect(summary.sourceMap.listPositionsDistinct).toBe(true);
  });
});
