/**
 * @file The Ruby convert invocation: turns a {@link ProjectSnapshot} into a rendered PDF by driving
 * `Asciidoctor.convert_file(..., backend: 'pdf', safe: :unsafe, ...)` inside the warm Ruby VM, then
 * reading the result back, neutralizing its ambient nondeterminism, and wrapping it as a Blob.
 *
 * The WASM VM is the security boundary (so `safe: :unsafe` is deliberate — the VFS holds only local
 * AsciiDoc + local assets by the time this runs). The convert program is emitted as a Ruby string and
 * executed through the injected {@link RubyPdfVm} facade; this module never touches the raw interop
 * libraries.
 *
 * The attribute map is assembled in a deliberately separated, extendable helper
 * ({@link buildConvertAttributes}) so the project-faithful attribute wiring can grow without
 * disturbing the invocation/read-back plumbing. The optional `hexapdf` optimize pass is
 * capability-gated: it runs only behind an in-VM probe, and an unavailable optimizer is recorded as a
 * non-fatal notice rather than failing the export.
 */

import { normalizePdfBytes } from './normalize-pdf';
import type {
  DiagnosticCode,
  DiagnosticSeverity,
  PdfSourceMap,
  PdfSourceMapEntry,
  ProjectSnapshot,
  RenderDiagnostic,
  RenderError,
  RenderErrorPhase,
  RenderRequest,
} from '../protocol';
import type { RubyPdfVm } from '../vm/ruby-pdf-vm';

// ---------------------------------------------------------------------------
// Named paths, keys and literals (no magic strings).
// ---------------------------------------------------------------------------

/** The writable VFS mounts the convert reads from / writes to. */
const PROJECT_MOUNT = '/project';
const OUTPUT_MOUNT = '/out';
const PATH_SEPARATOR = '/';
const PDF_EXTENSION = '.pdf';
const DEFAULT_OUTPUT_NAME = 'document';

/**
 * VFS path the source-map tracking hook serializes its collected entries to. `invokeConvert` reads it
 * back after the PDF bytes (best-effort — an absent or malformed file simply yields no map). It lives
 * under `/out` so the existing output-clearing pass removes it alongside the rendered PDF.
 */
const SOURCEMAP_PATH = `${OUTPUT_MOUNT}${PATH_SEPARATOR}sourcemap.json`;

/** The MIME type of the rendered artifact. */
export const PDF_CONTENT_TYPE = 'application/pdf';

/** The syntax highlighter wired to match the Asciidoctor-PDF reference build. */
export const SOURCE_HIGHLIGHTER_ROUGE = 'rouge';

/**
 * The fonts directory of the engine gem baked into the wasm (default theme fonts), appended to any
 * custom project font directories so both resolve when a project ships its own fonts. This is the
 * runtime path inside the baked gem tree; the version segment tracks the pinned engine and must be
 * updated in lockstep if the engine gem is bumped. When a project has no custom fonts the attribute
 * is omitted entirely so the engine resolves its bundled fonts automatically.
 */
export const BAKED_FONTS_DIR = '/bundle/gems/asciidoctor-pdf-2.3.24/data/fonts';

/**
 * The separator Asciidoctor-PDF expects between `pdf-fontsdir` entries. The engine splits the
 * attribute on `;` or `,` (deliberately not `:`, which collides with Windows drive letters), so a
 * colon-joined value would be read as a single nonexistent directory and no custom font would resolve.
 */
const FONTS_DIR_SEPARATOR = ';';

/** Attribute keys the theme/font/imagesdir/highlighter wiring sets. */
export const CONVERT_ATTRIBUTE_KEYS = {
  SOURCE_HIGHLIGHTER: 'source-highlighter',
  PDF_THEME: 'pdf-theme',
  PDF_THEMESDIR: 'pdf-themesdir',
  PDF_FONTSDIR: 'pdf-fontsdir',
  IMAGESDIR: 'imagesdir',
} as const;

/** Stable machine codes for the fatal failures this module can return. */
export const CONVERT_ERROR_CODES = {
  CONVERT_FAILED: 'convert-failed',
  READ_OUTPUT_FAILED: 'read-output-failed',
} as const;

/** The code carried by the notice recorded when the optimize pass is skipped. */
export const OPTIMIZE_UNAVAILABLE_CODE = 'optimize-unavailable';

const PHASE_CONVERT: RenderErrorPhase = 'convert';
const PHASE_READ_OUTPUT: RenderErrorPhase = 'read-output';

/** The subset of enumerated diagnostic codes this module classifies convert warnings into. */
const CONVERT_DIAGNOSTIC_CODES = {
  MISSING_GLYPH: 'missing-glyph',
  FONT_UNAVAILABLE: 'font-unavailable',
  UNSUPPORTED_IMAGE: 'unsupported-image',
} as const satisfies Record<string, DiagnosticCode>;

const GLYPH_PATTERN = /glyph/i;
const FONT_PATTERN = /font/i;
// Asciidoctor-PDF/prawn emits these when it cannot embed a referenced image — "image to embed not
// found or not readable: <path>" and "could not embed image: <path>; <reason>". Surfacing them (never
// silently dropping) lets the UI tell the user which picture failed and why (FR-012).
const IMAGE_EMBED_PATTERN = /image to embed|embed image/i;
const ERROR_SEVERITIES: ReadonlySet<string> = new Set(['ERROR', 'FATAL']);

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** A Ruby attribute value: a string, or `nil` (modeled as `null`) for value-less attributes. */
export type ConvertAttributeValue = string | null;

/** The assembled attribute map passed to `Asciidoctor.convert_file`. */
export type ConvertAttributes = Record<string, ConvertAttributeValue>;

/**
 * A non-fatal engine notice that does not map to a per-resource {@link RenderDiagnostic} code — used
 * when the optimize pass is skipped because the in-VM optimizer is unavailable. Carried alongside the
 * per-resource diagnostics so the skip is visible without aborting the export.
 */
export interface OptimizeNotice {
  /** Always `warning`: a skipped optimize costs file size, never correctness, so it must not abort the export. */
  readonly severity: 'warning';
  /** Always {@link OPTIMIZE_UNAVAILABLE_CODE}, tagging this notice as the optimizer-unavailable skip. */
  readonly code: typeof OPTIMIZE_UNAVAILABLE_CODE;
  /** A human-readable explanation of why the optimize pass was skipped. */
  readonly message: string;
}

/** A diagnostic surfaced by the convert path: a per-resource problem or an engine-level notice. */
export type ConvertDiagnostic = RenderDiagnostic | OptimizeNotice;

/** How a blob is constructed from bytes; injected so the wrapping is testable off a real `Blob`. */
export type BlobFactory = (bytes: Uint8Array, contentType: string) => Blob;

/** Default blob factory over the platform `Blob` (present in the browser and modern Node). */
export const defaultBlobFactory: BlobFactory = (bytes, contentType) => {
  // Copy into a fresh, non-shared ArrayBuffer so the byte view is an unambiguous blob part
  // regardless of the source buffer's backing store.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: contentType });
};

/** Everything the convert invocation needs, injected for testability. */
export interface InvokeConvertDeps {
  /** The warm Ruby VM the convert program runs against. */
  readonly vm: RubyPdfVm;
  /** The render request (snapshot, optimize flag, correlation id). */
  readonly request: RenderRequest;
  /** How to wrap the normalized bytes as a Blob; defaults to {@link defaultBlobFactory}. */
  readonly createBlob?: BlobFactory;
  /** Override for the fixed epoch that seeds deterministic PDF metadata. */
  readonly sourceDateEpochSeconds?: number;
}

/** A successful convert: the wrapped PDF, its normalized bytes, and any non-fatal diagnostics. */
export interface ConvertInvocationSuccess {
  /** The success discriminant of {@link ConvertInvocationResult}, always `true` on this arm. */
  readonly ok: true;
  /** The rendered PDF, wrapped as a Blob ready to hand to the download path. */
  readonly pdf: Blob;
  /** The deterministic (normalized) PDF bytes — useful for caching / parity diffing. */
  readonly bytes: Uint8Array;
  /** The non-fatal warnings and notices gathered during the convert; empty when nothing was flagged. */
  readonly diagnostics: readonly ConvertDiagnostic[];
  /**
   * The engine-emitted block source map for scroll sync, when the tracking hook produced one. Absent
   * when the hook could not emit it (degrades gracefully — the render never fails over a missing map).
   */
  readonly sourceMap?: PdfSourceMap;
}

/** A failed convert: a structured, non-thrown fatal error. */
export interface ConvertInvocationFailure {
  /** The success discriminant of {@link ConvertInvocationResult}, always `false` on this arm. */
  readonly ok: false;
  /** The structured, non-thrown fatal error describing what stopped the convert. */
  readonly error: RenderError;
}

/** The result of a convert invocation — success (with diagnostics) or a structured failure. */
export type ConvertInvocationResult = ConvertInvocationSuccess | ConvertInvocationFailure;

// ---------------------------------------------------------------------------
// Attribute-map builder (the extendable seam for the project-faithful wiring).
// ---------------------------------------------------------------------------

/**
 * Assemble the attribute map for the convert. `ProjectSnapshot.attributes` is the source of truth
 * (it already merges the render-intrinsic set with the project's own attributes); the theme, fonts,
 * imagesdir and `source-highlighter: rouge` wiring is layered underneath so the project's attributes
 * win on any overlap. It deliberately invents no styling defaults — parity requires the *project's*
 * theme, not a fixed one, so `pdf-theme`/`pdf-themesdir` are set only when the project defines a theme.
 *
 * This is a basic assembly; the project-faithful refinement extends it in place.
 */
export function buildConvertAttributes(snapshot: ProjectSnapshot): ConvertAttributes {
  const attributes: ConvertAttributes = { [CONVERT_ATTRIBUTE_KEYS.SOURCE_HIGHLIGHTER]: SOURCE_HIGHLIGHTER_ROUGE,};

  // Wiring layer (overridable by the project's own attributes).

  const fontsDirectory = buildFontsDirectory(snapshot.fontPaths, snapshot.extraFontDirs ?? []);
  if (fontsDirectory !== null) {
    attributes[CONVERT_ATTRIBUTE_KEYS.PDF_FONTSDIR] = fontsDirectory;
  }

  if (snapshot.themePath !== undefined) {
    attributes[CONVERT_ATTRIBUTE_KEYS.PDF_THEME] = leafName(snapshot.themePath);
    attributes[CONVERT_ATTRIBUTE_KEYS.PDF_THEMESDIR] = mountedDirectory(snapshot.themePath);
  }

  if (snapshot.imagesDir !== undefined) {
    attributes[CONVERT_ATTRIBUTE_KEYS.IMAGESDIR] = snapshot.imagesDir;
  }

  // Project source of truth — layered last so project attributes take precedence.
  for (const [key, value] of Object.entries(snapshot.attributes)) {
    attributes[key] = value;
  }

  return attributes;
}

/** Build the `pdf-fontsdir` (custom project font dirs + the baked default), or `null` if none. */
function buildFontsDirectory(
  fontPaths: readonly string[],
  extraFontDirectories: readonly string[],
): string | null {
  if (fontPaths.length === 0 && extraFontDirectories.length === 0) {
    return null;
  }
  const directories = new Set<string>();
  // Each font file contributes its own mounted directory...
  for (const path of fontPaths) {
    directories.add(mountedDirectory(path));
  }
  // ...and each project-relative extra dir is mounted under the project root and APPENDED (the baked
  // default stays last as a fallback, so a custom dir never replaces the built-in fonts).
  for (const directory of extraFontDirectories) {
    directories.add(join(PROJECT_MOUNT, directory));
  }
  return [...directories, BAKED_FONTS_DIR].join(FONTS_DIR_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Invocation.
// ---------------------------------------------------------------------------

/**
 * Drive the Ruby convert for the request's snapshot and return the rendered PDF (or a structured
 * failure). The convert program runs through the injected VM; the output is read back, normalized for
 * determinism, wrapped as a Blob, and `/out` is cleared. Convert failures surface as a returned
 * {@link RenderError} rather than a thrown exception.
 */
export async function invokeConvert(deps: InvokeConvertDeps): Promise<ConvertInvocationResult> {
  const { vm, request } = deps;
  const { snapshot, requestId } = request;

  const sourcePath = join(PROJECT_MOUNT, snapshot.rootPath);
  const outputPath = join(OUTPUT_MOUNT, `${deriveOutputName(snapshot.rootPath)}${PDF_EXTENSION}`);
  const attributes = buildConvertAttributes(snapshot);

  const diagnostics: ConvertDiagnostic[] = [];

  // 1. Convert.
  //
  // Run the convert SYNCHRONOUSLY (`eval`), not via `evalAsync`. `evalAsync` executes the Ruby program
  // inside a Ruby Fiber (ruby.wasm drives it through `__eval_async_rb` so the code *may* suspend on a JS
  // promise). A Fiber has its own, small, FIXED machine (C) stack — far smaller than the VM's main
  // stack. Asciidoctor-PDF/prawn-svg lay diagrams out with deep recursion, and a document embedding
  // several SVG diagrams at once overflows that fiber stack; on wasm a machine-stack overflow is not a
  // catchable Ruby `SystemStackError` but a hard `memory access out of bounds` trap that aborts the VM
  // (it escapes the in-Ruby `rescue`, is layout-sensitive, and reproduces most reliably under a deep
  // host async context). The convert program is pure Ruby and never awaits a JS promise, so it does not
  // need a fiber; running it on the main stack removes the overflow while changing nothing else.
  let convertOutcome: ConvertOutcome;
  try {
    const value = vm.eval(buildConvertCode(sourcePath, outputPath, attributes));
    convertOutcome = parseConvertOutcome(value.toString());
  } catch (error) {
    return failure(requestId, PHASE_CONVERT, CONVERT_ERROR_CODES.CONVERT_FAILED, messageOf(error));
  }
  if (!convertOutcome.ok) {
    return failure(requestId, PHASE_CONVERT, convertOutcome.code, convertOutcome.message);
  }
  for (const warning of convertOutcome.warnings) {
    const diagnostic = classifyConvertWarning(warning, snapshot.rootPath);
    if (diagnostic !== null) {
      diagnostics.push(diagnostic);
    }
  }

  // 2. Optional optimize (capability-gated; never fatal).
  if (request.optimize) {
    await optimize(vm, outputPath, diagnostics);
  }

  // 3. Read back.
  let rawBytes: Uint8Array;
  try {
    rawBytes = vm.readFile(outputPath);
  } catch (error) {
    return failure(
      requestId,
      PHASE_READ_OUTPUT,
      CONVERT_ERROR_CODES.READ_OUTPUT_FAILED,
      messageOf(error),
    );
  }

  const bytes = normalizePdfBytes(rawBytes, deps.sourceDateEpochSeconds);
  const createBlob = deps.createBlob ?? defaultBlobFactory;
  const pdf = createBlob(bytes, PDF_CONTENT_TYPE);

  // 4. Read back the source map the tracking hook emitted (best-effort — a missing/malformed map never
  // fails the render; the client falls back to a proportional scroll sync).
  const sourceMap = readSourceMap(vm);

  // 5. Clear /out (removes the rendered PDF and the source-map file).
  clearOutput(vm);

  return { ok: true, pdf, bytes, diagnostics, ...(sourceMap === undefined ? {} : { sourceMap }) };
}

/**
 * Read and validate the source map the Ruby tracking hook wrote to {@link SOURCEMAP_PATH}. Returns
 * `undefined` when the file is absent, unreadable, malformed, or empty — the render stays valid without
 * a map, so every failure here degrades silently to no map.
 */
function readSourceMap(vm: RubyPdfVm): PdfSourceMap | undefined {
  let raw: string;
  try {
    if (!vm.exists(SOURCEMAP_PATH)) {
      return undefined;
    }
    raw = new TextDecoder().decode(vm.readFile(SOURCEMAP_PATH));
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const entries: PdfSourceMapEntry[] = [];
  for (const item of parsed) {
    const entry = toSourceMapEntry(item);
    if (entry !== null) {
      entries.push(entry);
    }
  }
  return entries.length > 0 ? entries : undefined;
}

/** Coerce one deserialized item into a valid {@link PdfSourceMapEntry}, or `null` when it is not one. */
function toSourceMapEntry(item: unknown): PdfSourceMapEntry | null {
  if (!isRecord(item)) {
    return null;
  }
  const { line, page, yFraction } = item;
  if (
    typeof line !== 'number' ||
    typeof page !== 'number' ||
    typeof yFraction !== 'number' ||
    !Number.isFinite(line) ||
    !Number.isFinite(page) ||
    !Number.isFinite(yFraction)
  ) {
    return null;
  }
  return { line, page, yFraction: Math.min(1, Math.max(0, yFraction)) };
}

// ---------------------------------------------------------------------------
// Ruby program builders.
// ---------------------------------------------------------------------------

/**
 * Ruby prelude that repairs `File.readable?` inside the WASI runtime. WASI has no file-permission
 * model, so the runtime reports every VFS file as NOT readable even though its bytes read back fine —
 * and Asciidoctor-PDF gates image embedding on `File.readable?`, so without this every `image::` would
 * silently fall back to its "missing image" placeholder. The fallback treats any existing regular file
 * as readable, which is correct for the sandboxed VFS (a present file is always readable). It is
 * guarded so re-running it on the warm VM does not re-alias itself into infinite recursion.
 */
const READABLE_SHIM = [
  'unless ::File.respond_to?(:__vfs_readable_patched)',
  '  class << ::File',
  '    alias_method :__vfs_orig_readable?, :readable?',
  '    def readable?(path); __vfs_orig_readable?(path) || file?(path); end',
  '    def __vfs_readable_patched; true; end',
  '  end',
  'end',
].join('\n');

/**
 * The global (in the Ruby VM) the tracking hook appends entries to during a convert. It is set to a
 * fresh array immediately before each convert and read back after, so entries never leak between runs.
 */
const SOURCEMAP_GLOBAL = '$__asciidocollab_source_map';

/**
 * Ruby prelude that PREPENDS a tracking module onto `Asciidoctor::PDF::Converter` so the block source
 * map can be built as the PDF is laid out. The converter IS a `Prawn::Document` subclass, so inside the
 * wrapped `convert` dispatch `page_number`, `page` and `y` describe the live layout cursor. Because the
 * document is converted with `sourcemap: true`, each block carries a `source_location` whose `lineno`
 * is its line in the CONVERTED (include-expanded) document; the hook records that line together with
 * the current page and the block's TOP as a fraction of page height from the top (Prawn's `y` is the
 * absolute position measured up from the page bottom, so `(page_height - y) / page_height` is the
 * distance down from the top). Capture happens BEFORE `super` lays the block out, so `y`/`page` are the
 * block's starting position. Every step is wrapped so a hook failure can never break the render — a
 * failed capture simply omits that entry. The prepend is guarded so re-running on the warm VM is inert.
 */
const SOURCEMAP_SHIM = [
  `${SOURCEMAP_GLOBAL} = nil`,
  // Defining (reopening) the module every run is harmless; the prepend below is guarded so it happens
  // exactly once per warm VM (Ruby forbids `def <Const::Path>.method`, so an ancestor check is the guard).
  'module ::AsciidocollabSourceMap',
  '  def convert(node, *rest)',
  '    __asciidocollab_record_source_map(node)',
  '    super',
  '  end',
  '  def __asciidocollab_record_source_map(node)',
  `    sink = ${SOURCEMAP_GLOBAL}`,
  '    return if sink.nil?',
  '    loc = (node.respond_to?(:source_location) ? node.source_location : nil)',
  '    return if loc.nil?',
  '    lineno = (loc.respond_to?(:lineno) ? loc.lineno : nil)',
  '    return unless lineno.is_a?(::Integer) && lineno > 0',
  '    pnum = page_number',
  '    return unless pnum.is_a?(::Integer) && pnum > 0',
  '    dims = page.dimensions',
  '    height = (dims[3] - dims[1]).to_f',
  '    return unless height > 0',
  '    top_offset = (dims[3] - y) / height',
  '    top_offset = 0.0 if top_offset < 0',
  '    top_offset = 1.0 if top_offset > 1',
  "    sink << { 'line' => lineno, 'page' => pnum, 'yFraction' => top_offset }",
  '  rescue ::StandardError',
  '    # A source-map capture must never abort a render; drop this entry silently.',
  '  end',
  'end',
  'unless ::Asciidoctor::PDF::Converter.ancestors.include?(::AsciidocollabSourceMap)',
  '  ::Asciidoctor::PDF::Converter.prepend(::AsciidocollabSourceMap)',
  'end',
].join('\n');

/**
 * Ruby that serializes the collected source-map entries to {@link SOURCEMAP_PATH}: de-duplicate in
 * render order (keep the first entry per line), then sort by line. Wrapped so a serialization failure
 * leaves the render untouched (the client just gets no map).
 */
const SOURCEMAP_WRITE = [
  'begin',
  `  collected = (${SOURCEMAP_GLOBAL} || [])`,
  `  ${SOURCEMAP_GLOBAL} = nil`,
  '  seen = {}',
  '  deduped = []',
  '  collected.each do |entry|',
  "    key = entry['line']",
  '    next if seen[key]',
  '    seen[key] = true',
  '    deduped << entry',
  '  end',
  "  deduped.sort_by! { |entry| entry['line'] }",
  `  File.write(${rubyString(SOURCEMAP_PATH)}, JSON.generate(deduped))`,
  'rescue ::StandardError',
  '  # Emitting the source map is best-effort; never let it break a successful render.',
  'end',
].join('\n');

function buildConvertCode(
  sourcePath: string,
  outputPath: string,
  attributes: ConvertAttributes,
): string {
  return [
    "require 'json'",
    "require 'asciidoctor'",
    "require 'asciidoctor-pdf'",
    READABLE_SHIM,
    SOURCEMAP_SHIM,
    'begin',
    '  logger = Asciidoctor::MemoryLogger.new',
    '  Asciidoctor::LoggerManager.logger = logger',
    `  ${SOURCEMAP_GLOBAL} = []`,
    // `base_dir` is pinned to the project mount root, NOT left to default to the root document's own
    // directory. Image (and `imagesdir`) targets are project-root-relative throughout the app — that is
    // how the snapshot mounts them into the VFS, how `collectReferencedAssetPaths` keys them, and how
    // the HTML preview resolves them. Without this, a root document that lives in a SUBFOLDER (e.g.
    // `New Folder/doc.adoc`) makes Asciidoctor resolve `image::New Folder/pic.png[]` against that
    // subfolder — doubling it to `/project/New Folder/New Folder/pic.png` — so every image fails to embed.
    `  Asciidoctor.convert_file(${rubyString(sourcePath)}, backend: 'pdf', safe: :unsafe, ` +
      `base_dir: ${rubyString(PROJECT_MOUNT)}, ` +
      `sourcemap: true, to_file: ${rubyString(outputPath)}, mkdirs: true, attributes: ${rubyHash(attributes)})`,
    SOURCEMAP_WRITE,
    "  warnings = logger.messages.map { |m| { 'severity' => m[:severity].to_s, " +
      "'message' => (m[:message].is_a?(::Hash) ? m[:message][:text] : m[:message]).to_s } }",
    "  JSON.generate({ 'ok' => true, 'warnings' => warnings })",
    'rescue => e',
    `  ${SOURCEMAP_GLOBAL} = nil`,
    "  JSON.generate({ 'ok' => false, 'code' => e.class.name, 'message' => e.message })",
    'end',
  ].join('\n');
}

/** Probes whether the (native-dependent) optimizer + zlib actually loaded in-wasm. */
const HEXAPDF_PROBE_CODE = [
  'begin',
  "  require 'hexapdf'",
  "  require 'zlib'",
  "  'true'",
  'rescue ::LoadError, ::StandardError',
  "  'false'",
  'end',
].join('\n');

function buildOptimizeCode(outputPath: string): string {
  return [
    "require 'json'",
    'begin',
    `  doc = HexaPDF::Document.open(${rubyString(outputPath)})`,
    `  doc.write(${rubyString(outputPath)}, optimize: true)`,
    "  JSON.generate({ 'ok' => true })",
    'rescue => e',
    "  JSON.generate({ 'ok' => false, 'message' => e.message })",
    'end',
  ].join('\n');
}

/** Serialize a JS string as a single-quoted Ruby string literal. */
function rubyString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll('\'', String.raw`\'`)}'`;
}

/** Serialize an attribute value as a Ruby literal (`nil` for `null`). */
function rubyValue(value: ConvertAttributeValue): string {
  return value === null ? 'nil' : rubyString(value);
}

/** Serialize the attribute map as a Ruby hash literal. */
function rubyHash(attributes: ConvertAttributes): string {
  const entries = Object.entries(attributes).map(
    ([key, value]) => `${rubyString(key)} => ${rubyValue(value)}`,
  );
  return `{ ${entries.join(', ')} }`;
}

// ---------------------------------------------------------------------------
// Optimize (capability-gated).
// ---------------------------------------------------------------------------

async function optimize(
  vm: RubyPdfVm,
  outputPath: string,
  diagnostics: ConvertDiagnostic[],
): Promise<void> {
  const probe = await vm.evalAsync(HEXAPDF_PROBE_CODE);
  if (probe.toString().trim() !== 'true') {
    // The optimizer (hexapdf) is deliberately not bundled in this VM build, so its absence is a
    // constant, expected condition — not a per-document problem. Optimization only shrinks the file;
    // the produced PDF is complete and correct without it. Skip silently rather than warning on every
    // render. A genuine attempted-but-failed optimization (below) is still surfaced.
    return;
  }
  try {
    const value = await vm.evalAsync(buildOptimizeCode(outputPath));
    const outcome = parseOptimizeOutcome(value.toString());
    if (!outcome.ok) {
      diagnostics.push(optimizeNotice(`PDF optimization skipped: ${outcome.message}`));
    }
  } catch (error) {
    diagnostics.push(optimizeNotice(`PDF optimization skipped: ${messageOf(error)}`));
  }
}

function optimizeNotice(message: string): OptimizeNotice {
  return { severity: 'warning', code: OPTIMIZE_UNAVAILABLE_CODE, message };
}

// ---------------------------------------------------------------------------
// Result parsing.
// ---------------------------------------------------------------------------

interface ConvertWarning {
  readonly severity: string;
  readonly message: string;
}

type ConvertOutcome =
  | { readonly ok: true; readonly warnings: readonly ConvertWarning[] }
  | { readonly ok: false; readonly code: string; readonly message: string };

function parseConvertOutcome(raw: string): ConvertOutcome {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('Convert returned a malformed result');
  }
  if (parsed['ok'] === true) {
    return { ok: true, warnings: parseWarnings(parsed['warnings']) };
  }
  return {
    ok: false,
    code: stringOr(parsed['code'], CONVERT_ERROR_CODES.CONVERT_FAILED),
    message: stringOr(parsed['message'], 'Asciidoctor convert failed'),
  };
}

function parseWarnings(value: unknown): ConvertWarning[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const warnings: ConvertWarning[] = [];
  for (const item of value) {
    if (isRecord(item)) {
      warnings.push({
        severity: stringOr(item['severity'], ''),
        message: stringOr(item['message'], ''),
      });
    }
  }
  return warnings;
}

function parseOptimizeOutcome(raw: string): { ok: boolean; message: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && parsed['ok'] === true) {
      return { ok: true, message: '' };
    }
    const message = isRecord(parsed) ? stringOr(parsed['message'], 'unknown error') : 'unknown error';
    return { ok: false, message };
  } catch {
    return { ok: false, message: 'malformed optimize result' };
  }
}

// ---------------------------------------------------------------------------
// Diagnostics.
// ---------------------------------------------------------------------------

/** Map a convert warning to an enumerated diagnostic; drop those with no matching code. */
function classifyConvertWarning(
  warning: ConvertWarning,
  resource: string,
): RenderDiagnostic | null {
  const code = codeForWarning(warning.message);
  if (code === null) {
    return null;
  }
  return {
    severity: toSeverity(warning.severity),
    code,
    resource,
    message: warning.message,
  };
}

function codeForWarning(message: string): DiagnosticCode | null {
  if (IMAGE_EMBED_PATTERN.test(message)) {
    return CONVERT_DIAGNOSTIC_CODES.UNSUPPORTED_IMAGE;
  }
  if (GLYPH_PATTERN.test(message)) {
    return CONVERT_DIAGNOSTIC_CODES.MISSING_GLYPH;
  }
  if (FONT_PATTERN.test(message)) {
    return CONVERT_DIAGNOSTIC_CODES.FONT_UNAVAILABLE;
  }
  return null;
}

function toSeverity(raw: string): DiagnosticSeverity {
  return ERROR_SEVERITIES.has(raw.toUpperCase()) ? 'error' : 'warning';
}

// ---------------------------------------------------------------------------
// VFS helpers.
// ---------------------------------------------------------------------------

function clearOutput(vm: RubyPdfVm): void {
  let entries: readonly string[];
  try {
    entries = vm.readdir(OUTPUT_MOUNT);
  } catch {
    return;
  }
  for (const name of entries) {
    vm.removeFile(join(OUTPUT_MOUNT, name));
  }
}

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

function failure(
  requestId: string,
  phase: RenderErrorPhase,
  code: string,
  message: string,
): ConvertInvocationFailure {
  return { ok: false, error: { requestId, phase, code, message } };
}

function deriveOutputName(rootPath: string): string {
  const base = leafName(rootPath);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.length > 0 ? stem : DEFAULT_OUTPUT_NAME;
}

/** The final `/`-separated segment of a project-relative path. */
function leafName(path: string): string {
  const segments = path.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

/** The mount-qualified directory of a project-relative path (e.g. `themes/x.yml` → `/project/themes`). */
function mountedDirectory(path: string): string {
  const segments = path.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);
  const directorySegments = segments.slice(0, -1);
  return directorySegments.length > 0
    ? join(PROJECT_MOUNT, directorySegments.join(PATH_SEPARATOR))
    : PROJECT_MOUNT;
}

function join(mount: string, relative: string): string {
  const trimmed = relative.replace(/^\/+/, '');
  return `${mount}${PATH_SEPARATOR}${trimmed}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
