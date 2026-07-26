/**
 * @file Cross-boundary DTOs and the `postMessage` protocol shared between the main thread
 * (the export/preview hooks) and the PDF Web Worker. Messages are raw structured-clone objects
 * (no Comlink), discriminated by a literal `type`/`severity`/`phase` tag. All fallible worker
 * operations report results as data — per-resource problems ride inside a successful render as
 * {@link RenderDiagnostic}s; only whole-render failures cross the boundary as a {@link RenderError}.
 *
 * The string unions below are each anchored to a single frozen tuple so the runtime validators and
 * the compile-time types cannot drift apart, and so no consumer has to repeat a bare string literal.
 */

import type { PdfExtensionCatalogueEntry } from '@asciidocollab/asciidoc-core';
import type { PdfExtensionSource } from './extensions/registry';

/**
 * Which artifact a render produces: `export` returns a downloadable full PDF Blob; `preview` may
 * return a page-limited or rasterized rendering for on-screen display.
 */
export type RenderMode = 'export' | 'preview';

/**
 * The ordered pre-processing steps run in the worker before the Ruby convert, then the convert
 * itself. The order is a contract: earlier stages rewrite the in-memory VFS that later stages read.
 */
export type PipelineStageKind =
  | 'include-resolve'
  | 'citations'
  | 'diagrams-math'
  | 'image-guard'
  | 'mount-assets'
  | 'convert';

/**
 * An immutable capture of the project state to render, taken from the editor at request time. The
 * pipeline works on copies; this snapshot is never mutated. Every path is expected to be
 * sandbox-validated by the producer (no `..`, no absolute escape, no remote target).
 */
export interface ProjectSnapshot {
  /** Path → AsciiDoc/text content, with the editor-live overlay already applied. */
  readonly files: Readonly<Record<string, string>>;
  /** Path → image/font bytes (PNG/JPG/SVG/TTF/OTF). */
  readonly binaryAssets: Readonly<Record<string, Uint8Array>>;
  /** The document to convert (main file, falling back to the open file). */
  readonly rootPath: string;
  /** The currently-open file, used for preview focus. */
  readonly openPath: string;
  /** Project PDF-theme YAML path, if the project defines one. */
  readonly themePath?: string;
  /** Custom font files to mount into the VFS. */
  readonly fontPaths: readonly string[];
  /**
   * Extra project-relative directories to APPEND to the PDF font search path (never replacing the
   * per-font dirs or the baked default). Sourced from the project render config; sandbox-validated by
   * the snapshot builder. Each is mounted under `/project/<dir>` in the resolved `pdf-fontsdir`.
   */
  readonly extraFontDirs?: readonly string[];
  /** Project `:imagesdir:` value, if set. */
  readonly imagesDir?: string;
  /** BibTeX source path, if citations are used. */
  readonly bibPath?: string;
  /** Seeded/intrinsic attributes (render-intrinsic set merged with project attributes). */
  readonly attributes: Readonly<Record<string, string>>;
  /**
   * The converter extensions this project applies, as IDENTIFIERS ONLY.
   *
   * Never code, never paths. Every extension's source lives in the deployment — the shipped gem or
   * the administrator's folder — and is resolved from an id by the registry, so a snapshot travelling
   * from the browser to the worker can carry nothing executable no matter what a project stores.
   */
  readonly enabledExtensions?: readonly string[];
}

/**
 * A request to render a snapshot. Export and preview share the same shape and differ only by
 * {@link RenderMode}. Only the latest `requestId` per mode is honored; superseded requests are
 * cancelled at the next stage boundary.
 */
export interface RenderRequest {
  /** Monotonic id used for the staleness guard; stale results are discarded by the main thread. */
  readonly requestId: string;
  /** Selects the export (full PDF) versus preview (on-screen) rendering path for this request. */
  readonly mode: RenderMode;
  /** The immutable project state to render; the pipeline reads it and never mutates it. */
  readonly snapshot: ProjectSnapshot;
  /** For warm re-renders: only these project files are rewritten. */
  readonly changedPaths?: readonly string[];
  /** Run the PDF optimize pass (export sets this; preview may skip it). */
  readonly optimize: boolean;
  /**
   * Assets already rendered on the main thread (e.g. Mermaid diagrams the worker's shims cannot
   * produce in-VM) to pre-seed into the worker's content-addressed asset cache before preprocessing.
   * Optional and additive — a request without it renders exactly as before. Each entry is keyed by its
   * {@link GeneratedAsset.sourceHash}, so a pre-seeded hit skips re-rendering the matching block.
   */
  readonly generatedAssets?: readonly GeneratedAsset[];
  /**
   * What the worker needs to turn {@link ProjectSnapshot.enabledExtensions} into loadable code.
   *
   * Carried on the REQUEST rather than held as worker state, deliberately. Worker state would have to
   * arrive in its own message, and a render posted before that message landed would render silently
   * without its extensions — output that looks correct and is not. There is no ordering to get wrong
   * if every request carries what it needs.
   *
   * Absent means no extensions, which is what a caller with no project context (the theme preview
   * outside a project, a test) supplies.
   */
  readonly extensions?: PdfExtensionBundle;
}

/** The catalogue and code a render needs to resolve its enabled extension ids. */
export interface PdfExtensionBundle {
  /** Every extension currently on offer, for checking availability and origin. */
  readonly catalogue: readonly PdfExtensionCatalogueEntry[];
  /** The Ruby source for each id the caller could supply, injected by the composition root. */
  readonly sources: readonly PdfExtensionSource[];
}

/**
 * A rendered diagram/math/formatted-bibliography artifact, content-addressed for caching and
 * determinism: an identical `sourceHash` yields identical `bytes` and stable placement.
 */
export interface GeneratedAsset {
  /** Hash of the block source, render params, and shim version — the cache key. */
  readonly sourceHash: string;
  /** The producing shim family. */
  readonly kind: 'diagram' | 'math' | 'bibliography';
  /** Output format; `png` means an SVG raster fallback fired and was recorded as a diagnostic. */
  readonly format: 'svg' | 'png';
  /** The asset bytes written into the generated-assets VFS directory. */
  readonly bytes: Uint8Array;
  /** True when the SVG renderer could not consume the source and a raster fallback was used. */
  readonly rasterFallback: boolean;
  /** Derived alt text applied to the emitted `image::`/`image:` reference for accessibility. */
  readonly altText: string;
}

/**
 * An entry in the content-addressed generated-asset cache. `lastUsedTick` is a logical LRU counter,
 * not a wall-clock timestamp, so the render output path stays deterministic.
 */
export interface CacheEntry {
  /** The {@link GeneratedAsset.sourceHash}. */
  readonly key: string;
  /** The cached artifact this entry holds, reused verbatim whenever its `key` is requested again. */
  readonly asset: GeneratedAsset;
  /** Logical (not wall-clock) LRU counter. */
  readonly lastUsedTick: number;
}

/** Severity of a {@link RenderDiagnostic}; `error` still allows the rest of the doc to export. */
export type DiagnosticSeverity = 'warning' | 'error';

/** The enumerated per-resource/per-block diagnostic codes, in a stable order. */
export const DIAGNOSTIC_CODES = Object.freeze([
  'remote-skipped',
  'unsupported-image',
  'missing-glyph',
  'font-unavailable',
  'diagram-unsupported',
  'malformed-diagram',
  'malformed-math',
  'malformed-citation',
  'unresolved-include',
  'optimize-unavailable',
  'extension-not-loaded',
] as const);

/** A machine-readable diagnostic code drawn from {@link DIAGNOSTIC_CODES}. */
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** Membership index over {@link DIAGNOSTIC_CODES} for constant-time, cast-free code validation. */
const DIAGNOSTIC_CODE_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_CODES);

/**
 * A per-resource/per-block warning or non-fatal error. Diagnostics never abort a render; they ride
 * inside a successful {@link RenderResult} so partial success is the norm.
 */
export interface RenderDiagnostic {
  /** How serious the problem is; even `error` leaves the rest of the document exportable. */
  readonly severity: DiagnosticSeverity;
  /** The enumerated reason code the UI maps to a localized explanation and remedy. */
  readonly code: DiagnosticCode;
  /** File path / URL / block id the diagnostic refers to. */
  readonly resource: string;
  /** Source location for the editor to surface, when known. */
  readonly location?: { readonly path: string; readonly line?: number };
  /** Localized, human-readable message. */
  readonly message: string;
}

/**
 * One entry in the engine-emitted source map: the vertical position, in the rendered PDF, of a source
 * block. Produced by the Ruby converter hook as each block with a known source location is laid out, so
 * the preview can scroll the editor's current line to the exact place it renders (rather than a
 * proportional guess). Coordinates are pre-normalized for the client: `yFraction` is measured from the
 * TOP of the page as a fraction of page height, so no unit conversion is needed on the receiving side.
 */
export interface PdfSourceMapEntry {
  /**
   * 1-based line number of the block in the CONVERTED (include-expanded / assembled) document — NOT the
   * open file. The client translates its open-file line into this assembled coordinate before lookup.
   */
  readonly line: number;
  /** 1-based PDF page the block was laid out on. */
  readonly page: number;
  /** Vertical position of the block's TOP as a fraction of page height from the top, clamped to `[0, 1]`. */
  readonly yFraction: number;
  /**
   * Project-relative path of the SOURCE file this block originated in, resolved at render time from the
   * assembly provenance (preview renders only). Lets a click on the rendered block jump to the exact
   * source file — including an included file — with no client-side reverse mapping. Absent when the
   * render carried no provenance, as for an export.
   */
  readonly path?: string;
  /** The 1-based line of this block within {@link path} (its origin source line). Paired with {@link path}. */
  readonly sourceLine?: number;
}

/**
 * The engine-emitted source map: block source-line → rendered `(page, yFraction)` positions, sorted by
 * line and de-duplicated so each source line has at most one (its first-rendered) entry. Optional and
 * best-effort — a render that could not produce it simply omits it and the client falls back to a
 * proportional scroll sync.
 */
export type PdfSourceMap = readonly PdfSourceMapEntry[];

/** Logical timings and counters for budget tracking and observability. */
export interface RenderStats {
  /** Cold-start (VM instantiation) time, present only on the first render. */
  readonly coldStartMs?: number;
  /** Wall-independent elapsed render time, in milliseconds, used for budget tracking. */
  readonly renderMs: number;
  /** How many generated assets were served from cache instead of re-rendered this run. */
  readonly cacheHits: number;
  /** How many SVG renders fell back to a PNG raster because the PDF engine could not draw them. */
  readonly rasterFallbacks: number;
}

/** A successful render returned to the main thread, possibly carrying non-fatal diagnostics. */
export interface RenderResult {
  /** Echoes the originating {@link RenderRequest.requestId} so the main thread can drop stale results. */
  readonly requestId: string;
  /** Echoes the request's {@link RenderMode} so the receiver routes export versus preview output. */
  readonly mode: RenderMode;
  /** The `application/pdf` blob (downloadable for export; rendered on screen for preview). */
  readonly pdf: Blob;
  /** Non-fatal per-resource problems gathered during this render; an empty array means clean. */
  readonly diagnostics: readonly RenderDiagnostic[];
  /** Timing and cache counters for this render, for budget tracking and observability. */
  readonly stats: RenderStats;
  /**
   * The engine-emitted block source map for accurate editor↔preview scroll sync, when the converter
   * hook produced one. Absent on renders where it could not be emitted; the client then degrades to a
   * proportional scroll sync.
   */
  readonly sourceMap?: PdfSourceMap;
}

/** The phases in which a whole-render (fatal) failure can be reported, in pipeline order. */
export const RENDER_ERROR_PHASES = Object.freeze([
  'vm-init',
  'preprocessing',
  'convert',
  'read-output',
] as const);

/** A phase at which a {@link RenderError} can originate. */
export type RenderErrorPhase = (typeof RENDER_ERROR_PHASES)[number];

/** Membership index over {@link RENDER_ERROR_PHASES} for constant-time, cast-free phase validation. */
const RENDER_ERROR_PHASE_SET: ReadonlySet<string> = new Set(RENDER_ERROR_PHASES);

/**
 * A structured, fatal failure for the whole render (e.g. Empty/unparseable root, VM instantiation
 * failure). Carried over the protocol as data rather than thrown across the worker boundary.
 */
export interface RenderError {
  /** Echoes the originating {@link RenderRequest.requestId} so a stale failure can be ignored. */
  readonly requestId: string;
  /** Which pipeline phase the fatal failure originated in, to steer the user-facing explanation. */
  readonly phase: RenderErrorPhase;
  /** Stable machine code. */
  readonly code: string;
  /** User-facing message. */
  readonly message: string;
}

/** The progress phases emitted worker→main, one per stage boundary, in order. */
export const RENDER_PHASES = Object.freeze([
  'vm-init',
  'preprocessing',
  'citations',
  'diagrams-math',
  'converting',
  'optimizing',
  'done',
] as const);

/** A progress phase drawn from {@link RENDER_PHASES}. */
export type RenderPhase = (typeof RENDER_PHASES)[number];

/** Messages sent main → worker. */
export type ToWorker =
  | { readonly type: 'render'; readonly request: RenderRequest }
  | { readonly type: 'cancel'; readonly requestId: string }
  | { readonly type: 'warmup' };

/** Messages sent worker → main. */
export type FromWorker =
  | { readonly type: 'progress'; readonly requestId: string; readonly phase: RenderPhase; readonly pct?: number }
  | { readonly type: 'result'; readonly result: RenderResult }
  | { readonly type: 'error'; readonly error: RenderError };

/** Narrow a {@link FromWorker} message to a progress update. */
export function isProgressMessage(
  message: FromWorker,
): message is Extract<FromWorker, { type: 'progress' }> {
  return message.type === 'progress';
}

/** Narrow a {@link FromWorker} message to a successful result. */
export function isResultMessage(
  message: FromWorker,
): message is Extract<FromWorker, { type: 'result' }> {
  return message.type === 'result';
}

/** Narrow a {@link FromWorker} message to a fatal error. */
export function isErrorMessage(
  message: FromWorker,
): message is Extract<FromWorker, { type: 'error' }> {
  return message.type === 'error';
}

/**
 * Validate that a string names a phase at which a fatal {@link RenderError} can originate — used to
 * confirm an incoming error's `phase` before treating it as a whole-render failure.
 */
export function isFatalPhase(phase: string): phase is RenderErrorPhase {
  return RENDER_ERROR_PHASE_SET.has(phase);
}

/** Validate that a string is one of the enumerated {@link DiagnosticCode}s. */
export function isDiagnosticCode(code: string): code is DiagnosticCode {
  return DIAGNOSTIC_CODE_SET.has(code);
}
