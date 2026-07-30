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
  PdfVmStages,
  ProjectSnapshot,
  RenderDiagnostic,
  RenderError,
  RenderErrorPhase,
  RenderRequest,
} from '../protocol';
import type { RubyPdfVm } from '../vm/ruby-pdf-vm';
import { SOURCE_PROVENANCE_PATH } from '../vfs/populate';

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

/**
 * VFS path the convert program serializes its `{ ok, warnings | code, message }` result to, read back
 * through the VFS rather than the eval's return value so a `memory.grow` during the render cannot
 * corrupt the read (see the convert step in {@link invokeConvert}). Under `/out` so the existing
 * output-clearing pass removes it alongside the rendered PDF.
 */
const RESULT_PATH = `${OUTPUT_MOUNT}${PATH_SEPARATOR}result.json`;

/**
 * VFS path the optimize program serializes its `{ ok, message }` result to. Read back through the VFS
 * for the same reason as {@link RESULT_PATH}: hexapdf rewrites the whole PDF and grows the wasm heap.
 * Under `/out` so the output-clearing pass removes it too.
 */
const OPTIMIZE_RESULT_PATH = `${OUTPUT_MOUNT}${PATH_SEPARATOR}optimize-result.json`;

/**
 * VFS path the hexapdf capability probe writes `true`/`false` to. Read through the VFS because the
 * probe's `require 'hexapdf'` grows the heap when the gem is present — same hazard as {@link RESULT_PATH}.
 */
const PROBE_RESULT_PATH = `${OUTPUT_MOUNT}${PATH_SEPARATOR}optimize-probe.txt`;

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

/** Diagnostic code for an enabled extension that could not be loaded this render. Mirrors the worker's registry-rejection code. */
const EXTENSION_NOT_LOADED_CODE: DiagnosticCode = 'extension-not-loaded';

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
  /**
   * The converter extensions this render selected, already resolved and ORDERED by the registry.
   *
   * Both halves travel together deliberately. The path is what gets `require`d; the id is what the
   * extension gates itself on at runtime (see {@link ENABLED_EXTENSIONS_GLOBAL}). Passing them
   * separately would allow the one state that is silently wrong — code loaded into the VM with no id
   * published alongside it, so the extension is required and then never activates.
   *
   * Injected rather than derived, because this package has no filesystem access and must never reach
   * the administrator's folder itself; and resolving an id to a path is the registry's security
   * boundary, which must not be re-implemented here.
   */
  readonly loadedExtensions?: readonly LoadedExtensionReference[];
}

/** A converter extension the registry cleared for this render: what to require, and what to enable. */
export interface LoadedExtensionReference {
  /** The extension's catalogue id, published into the VM as this render's selection. */
  readonly id: string;
  /** The absolute VFS path its Ruby source was written to, under a deployment-controlled mount. */
  readonly vfsPath: string;
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
  /**
   * What the stages inside the render VM cost, when the convert reported them. Absent on a render
   * that could not measure them — the render is unaffected either way; only the breakdown is poorer.
   */
  readonly vmStages?: PdfVmStages;
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

  if (snapshot.imagesDir !== undefined) {
    attributes[CONVERT_ATTRIBUTE_KEYS.IMAGESDIR] = snapshot.imagesDir;
  }

  // Project source of truth — layered here so project attributes take precedence over the wiring.
  for (const [key, value] of Object.entries(snapshot.attributes)) {
    attributes[key] = value;
  }

  // The theme pair is applied AFTER the project's own attributes, and is the one place the wiring
  // deliberately wins.
  //
  // `themePath` is not a competing opinion about which theme to use — it IS the project's `pdf-theme`
  // selection, already resolved to a real file and sandbox-checked by the snapshot builder. The raw
  // config value is not a usable reference for the engine: it is a project-relative PATH, while
  // `pdf-themesdir` is derived from that same path, so letting the raw value through made the engine
  // resolve `<dir>/<dir>/<file>`, find nothing, and silently fall back to the built-in theme — a
  // project's theme simply never applied, with no error anywhere.
  //
  // The soft-default marker is preserved so a document header's own `:pdf-theme:` still wins, which
  // is the override the project-level config model promises everywhere else.
  if (snapshot.themePath !== undefined) {
    // Referenced through `engineThemePath`, because the engine only recognises `.yml`. The alias is
    // mounted by `mountThemeAlias` before the convert runs.
    const enginePath = engineThemePath(snapshot.themePath);
    attributes[CONVERT_ATTRIBUTE_KEYS.PDF_THEME] = `${leafName(enginePath)}${SOFT_DEFAULT_MARKER}`;
    attributes[CONVERT_ATTRIBUTE_KEYS.PDF_THEMESDIR] = mountedDirectory(enginePath);
  }

  return attributes;
}

/**
 * Mount a `.yaml` theme under the `.yml` name the engine will look for.
 *
 * Writing a second copy rather than renaming: the author's own path stays exactly where it is, so
 * everything that refers to it — the file tree, the editor, diagnostics that name the file — keeps
 * naming the file the author created.
 *
 * @param vm - The VM whose VFS the alias is written into.
 * @param snapshot - The snapshot being rendered.
 */
function mountThemeAlias(vm: RubyPdfVm, snapshot: ProjectSnapshot): void {
  const { themePath } = snapshot;
  if (themePath === undefined) return;
  const enginePath = engineThemePath(themePath);
  if (enginePath === themePath) return;

  const content = snapshot.files[themePath];
  // A theme whose content is absent is already broken in a way the render will surface; inventing an
  // empty alias here would replace that with a silent unthemed document.
  if (content === undefined) return;
  vm.writeFile(join(PROJECT_MOUNT, enginePath), new TextEncoder().encode(content));
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

  mountThemeAlias(vm, snapshot);

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
  //
  // The convert result is read back FROM A VFS FILE, not from the eval's return value. A full render is
  // the single most memory-hungry operation in the VM, and Asciidoctor-PDF/prawn-svg lay out SVG
  // diagrams with allocation spikes that grow the wasm linear memory mid-eval. Reading the return
  // value means calling `value.toString()`, which reaches back INTO that linear memory through
  // ruby.wasm's own glue to marshal the Ruby string — and after a grow that read intermittently
  // computes an out-of-range pointer and throws a JS `RangeError: Start offset … is outside the bounds
  // of the buffer`, failing an otherwise-successful render. The VFS read path does NOT touch wasm
  // memory at read time: `fd_write` copied the bytes into a host-side buffer when Ruby wrote the file,
  // and `readFile` returns that buffer directly. So the program writes its JSON result to
  // {@link RESULT_PATH} and we read it the same robust way the PDF bytes themselves are read below —
  // the eval's return value is deliberately discarded. Verified against the warm-VM parity suite,
  // where the return-value read failed roughly one run in three under memory pressure and the file
  // read does not. (A hard VM-aborting trap is a different failure and still surfaces as a throw from
  // `eval` itself, caught below.)
  let convertOutcome: ConvertOutcome;
  try {
    vm.eval(buildConvertCode(sourcePath, outputPath, attributes, deps.loadedExtensions ?? []));
  } catch (error) {
    return failure(
      requestId,
      PHASE_CONVERT,
      CONVERT_ERROR_CODES.CONVERT_FAILED,
      attributeThemeFailure(messageOf(error), snapshot.themePath),
    );
  }
  try {
    convertOutcome = parseConvertOutcome(readVfsText(vm, RESULT_PATH));
  } catch (error) {
    // The program writes RESULT_PATH in both its success and rescue branches, so an unreadable or
    // malformed result means the eval never reached either — a VM-level failure, not an author error.
    return failure(
      requestId,
      PHASE_CONVERT,
      CONVERT_ERROR_CODES.CONVERT_FAILED,
      attributeThemeFailure(`Convert produced no readable result: ${messageOf(error)}`, snapshot.themePath),
    );
  }
  if (!convertOutcome.ok) {
    return failure(
      requestId,
      PHASE_CONVERT,
      convertOutcome.code,
      attributeThemeFailure(convertOutcome.message, snapshot.themePath),
    );
  }
  for (const warning of convertOutcome.warnings) {
    const diagnostic = classifyConvertWarning(warning, snapshot.rootPath);
    if (diagnostic !== null) {
      diagnostics.push(diagnostic);
    }
  }
  // An extension that raised while loading is reported per-extension and the document still renders —
  // a broken extension must degrade to "not applied, and you are told", never fail the whole export.
  for (const extensionFailure of convertOutcome.extensionFailures) {
    diagnostics.push({
      severity: 'warning',
      code: EXTENSION_NOT_LOADED_CODE,
      resource: extensionFailure.id,
      message: `The "${extensionFailure.id}" extension failed to load and was not applied: ${extensionFailure.message}`,
    });
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

  return {
    ok: true,
    pdf,
    bytes,
    diagnostics,
    ...(sourceMap === undefined ? {} : { sourceMap }),
    ...(convertOutcome.vmStages === undefined ? {} : { vmStages: convertOutcome.vmStages }),
  };
}

/**
 * Read a VFS text file as UTF-8. This is the memory-safe way to get a result out of the VM: it reads
 * the host-side buffer `fd_write` populated, never wasm linear memory, so a `memory.grow` during the
 * eval that produced the file cannot corrupt the read (see the convert step in {@link invokeConvert}).
 *
 * @param vm - The Ruby VM whose VFS is read.
 * @param path - The absolute VFS path to read.
 * @returns The file's decoded UTF-8 contents.
 */
function readVfsText(vm: RubyPdfVm, path: string): string {
  return new TextDecoder().decode(vm.readFile(path));
}

/**
 * Read a VFS text file, returning `fallback` when it is absent or unreadable. For results whose absence
 * has a safe default (the hexapdf probe, where "unavailable" means skip optimization), rather than one
 * that must fail the render.
 *
 * @param vm - The Ruby VM whose VFS is read.
 * @param path - The absolute VFS path to read.
 * @param fallback - The value to return when the file cannot be read.
 * @returns The file's decoded contents, or `fallback`.
 */
function readVfsTextOr(vm: RubyPdfVm, path: string, fallback: string): string {
  try {
    return readVfsText(vm, path);
  } catch {
    return fallback;
  }
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
    raw = readVfsText(vm, SOURCEMAP_PATH);
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
  const { line, page, yFraction, path, sourceLine } = item;
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
  // The exact source origin is optional (present only for preview renders that carried provenance): keep
  // it only when BOTH a non-empty path and a finite line are present, so a partial stamp never half-fills.
  const hasOrigin = typeof path === 'string' && path.length > 0 && typeof sourceLine === 'number' && Number.isFinite(sourceLine);
  return {
    line,
    page,
    yFraction: Math.min(1, Math.max(0, yFraction)),
    ...(hasOrigin ? { path, sourceLine } : {}),
  };
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
 * The global (in the Ruby VM) holding the assembly line→source provenance for the current render: a JSON
 * array where index `i` is the origin `{ 'path', 'sourceLine' }` of assembled line `i + 1`. Loaded from
 * {@link SOURCE_PROVENANCE_PATH} before each convert (empty array for exports, which write no provenance),
 * and read by the source-map hook to stamp each block's exact source location onto its entry.
 */
const PROVENANCE_GLOBAL = '$__asciidocollab_provenance';

/**
 * The global (in the Ruby VM) holding the REAL page count of the document just laid out, published by the
 * hook's `convert_document` wrapper. It backstops the scratch-document guard in
 * {@link SOURCEMAP_SHIM}: any entry claiming a page beyond the finished document cannot describe a real
 * position, so {@link SOURCEMAP_WRITE} drops it. Reset per convert so a warm VM never filters against a
 * previous render's page count.
 */
const PAGE_COUNT_GLOBAL = '$__asciidocollab_page_count';

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
  // `convert` fires for every block node. Record the node's own line at its top position.
  '  def convert(node, *rest)',
  '    __asciidocollab_record_node(node)',
  '    super',
  '  end',
  // `traverse_list_item` is the single choke point that lays out list-item principal text (ulist,
  // olist, colist), dlist descriptions, and qanda terms/answers — none of which pass through
  // `convert`. Record at the live cursor (the item's top) BEFORE `super` so the entry is accurate.
  //
  // It also delimits the DESCRIPTION region of a dlist: everything a description inks happens inside
  // it, so a non-zero depth is what tells the term hook below that an `ink_prose` is not a term.
  '  def traverse_list_item(node, list_type, *rest)',
  '    __asciidocollab_record_list_item(node, list_type)',
  '    return super if @__asciidocollab_dlist_terms.nil?',
  '    @__asciidocollab_desc_depth = (@__asciidocollab_desc_depth || 0) + 1',
  '    begin',
  '      super',
  '    ensure',
  '      @__asciidocollab_desc_depth -= 1',
  '    end',
  '  end',
  // A dlist's TERMS are inked directly by `convert_dlist` — never dispatched through `convert`, and
  // never routed through `traverse_list_item` (which only takes the description). Publishing the
  // list's terms in layout order for the duration of the call lets the `ink_prose` hook below stamp
  // each one at the position it is actually inked at, instead of the whole list sharing its top.
  //
  // Saved and restored rather than assigned, so a dlist nested inside another list's description
  // restores its parent's pending terms (and its own description depth starts at zero).
  //
  // Whatever is still pending after the list has laid out is a term no hook recognised (a style that
  // inks terms some other way). Those — and only those — fall back to the list's top, so a term line
  // always has SOME rendered position for the editor to scroll to.
  '  def convert_dlist(node, *rest)',
  '    prev_terms = @__asciidocollab_dlist_terms',
  '    prev_depth = @__asciidocollab_desc_depth',
  '    @__asciidocollab_dlist_terms = __asciidocollab_flatten_terms(node)',
  '    @__asciidocollab_desc_depth = 0',
  '    pos = __asciidocollab_position',
  '    begin',
  '      super',
  '    ensure',
  '      __asciidocollab_record_leftover_terms(pos) if pos',
  '      @__asciidocollab_dlist_terms = prev_terms',
  '      @__asciidocollab_desc_depth = prev_depth',
  '    end',
  '  end',
  // Every line of prose the converter lays out passes through `ink_prose`. Inside a dlist and outside
  // any description, it is a term — matched against the pending queue by text so a string the hook
  // does not recognise is left alone rather than mis-attributed.
  '  def ink_prose(string, *rest)',
  '    __asciidocollab_record_dlist_term(string)',
  '    super',
  '  end',
  // The document's final page count, published for the out-of-range backstop in SOURCEMAP_WRITE. Taken
  // after `super` has laid the whole document out, so it is the real total rather than a running value.
  '  def convert_document(node, *rest)',
  '    result = super',
  '    begin',
  `      ${PAGE_COUNT_GLOBAL} = page_count if page_count.is_a?(::Integer) && page_count > 0`,
  '    rescue ::StandardError',
  '    end',
  '    result',
  '  end',
  '  def __asciidocollab_sink',
  `    ${SOURCEMAP_GLOBAL}`,
  '  end',
  // The live layout cursor as [page_number, top-as-fraction-of-page-height]. Prawn's `y` is measured up
  // from the page bottom, so `(page_height - y) / page_height` is the distance down from the top.
  //
  // Returns nil inside a SCRATCH document. Asciidoctor-PDF measures every keep-together block (example,
  // sidebar, admonition, quote, block image, table cell…) by converting it a first time into a throwaway
  // scratch `Prawn::Document` — a Marshal copy of the converter, so it carries these hooks too. Its page
  // numbering is its own: it starts a fresh page per `dry_run` and accumulates across the render, which
  // is why a six-page document produced entries claiming pages 9, 10, 11, 19, 20 with plausible-looking
  // y positions. Worse than being out of range, those captures come FIRST (the measuring pass precedes
  // the real one) and the write-out keeps the first entry per line, so the measured block's line ended up
  // pinned to a position that exists nowhere in the PDF. `scratch?` is the engine's own predicate
  // (`@label == :scratch`); it is called defensively in case a future engine version drops it.
  '  def __asciidocollab_position',
  '    return nil if respond_to?(:scratch?) && scratch?',
  '    pnum = page_number',
  '    return nil unless pnum.is_a?(::Integer) && pnum > 0',
  '    dims = page.dimensions',
  '    height = (dims[3] - dims[1]).to_f',
  '    return nil unless height > 0',
  '    top = (dims[3] - y) / height',
  '    top = 0.0 if top < 0',
  '    top = 1.0 if top > 1',
  '    [pnum, top]',
  '  rescue ::StandardError',
  '    nil',
  '  end',
  '  def __asciidocollab_lineno_of(obj)',
  '    return nil unless obj.respond_to?(:source_location)',
  '    loc = obj.source_location',
  '    return nil if loc.nil?',
  '    lineno = (loc.respond_to?(:lineno) ? loc.lineno : nil)',
  '    (lineno.is_a?(::Integer) && lineno > 0) ? lineno : nil',
  '  rescue ::StandardError',
  '    nil',
  '  end',
  // Build, provenance-stamp, and push one entry. `lineno` is the 1-based ASSEMBLED line, so its origin
  // (preview renders only) is provenance[lineno - 1]; absent/short → no stamp. A nil line is a no-op.
  '  def __asciidocollab_emit(lineno, pnum, top)',
  '    sink = __asciidocollab_sink',
  '    return if sink.nil? || lineno.nil?',
  "    entry = { 'line' => lineno, 'page' => pnum, 'yFraction' => top }",
  `    prov = ${PROVENANCE_GLOBAL}`,
  '    if prov.is_a?(::Array)',
  '      origin = prov[lineno - 1]',
  "      if origin.is_a?(::Hash) && origin['path'] && origin['sourceLine']",
  "        entry['path'] = origin['path']",
  "        entry['sourceLine'] = origin['sourceLine']",
  '      end',
  '    end',
  '    sink << entry',
  '  rescue ::StandardError',
  '    # A source-map capture must never abort a render; drop this entry silently.',
  '  end',
  '  def __asciidocollab_record_node(node)',
  '    return if __asciidocollab_sink.nil?',
  '    lineno = __asciidocollab_lineno_of(node)',
  '    return if lineno.nil?',
  '    pos = __asciidocollab_position',
  '    return if pos.nil?',
  '    __asciidocollab_emit(lineno, pos[0], pos[1])',
  '  rescue ::StandardError',
  '  end',
  // The list's term nodes, flattened into layout order (`items` is an array of [terms, description]).
  '  def __asciidocollab_flatten_terms(node)',
  '    items = (node.respond_to?(:items) ? node.items : nil)',
  '    return [] unless items.is_a?(::Array)',
  '    flat = []',
  '    items.each do |pair|',
  '      next unless pair.is_a?(::Array)',
  '      terms = pair[0]',
  '      next unless terms.is_a?(::Array)',
  '      terms.each { |term| flat << term }',
  '    end',
  '    flat',
  '  rescue ::StandardError',
  '    []',
  '  end',
  // Whether an inked string IS the given term. The `horizontal` dlist style inks a case-transformed
  // copy of the term, so an exact match is tried first and a case-insensitive one second.
  '  def __asciidocollab_same_text?(string, term)',
  '    return false unless term.respond_to?(:text)',
  '    inked = string.to_s.strip',
  '    text = term.text.to_s.strip',
  '    return false if text.empty?',
  '    inked == text || inked.downcase == text.downcase',
  '  rescue ::StandardError',
  '    false',
  '  end',
  // Stamp the next pending term at the live cursor, which is where it is about to be inked. A string
  // that is not the next term consumes nothing, so an unrecognised layout simply falls back to the
  // approximate list-top entries emitted after the list is laid out.
  '  def __asciidocollab_record_dlist_term(string)',
  '    pending = @__asciidocollab_dlist_terms',
  '    return if pending.nil? || pending.empty?',
  '    return unless (@__asciidocollab_desc_depth || 0) == 0',
  '    term = pending[0]',
  '    return unless __asciidocollab_same_text?(string, term)',
  '    pending.shift',
  '    pos = __asciidocollab_position',
  '    __asciidocollab_emit(__asciidocollab_lineno_of(term), pos[0], pos[1]) if pos',
  '  rescue ::StandardError',
  '  end',
  // Terms the `ink_prose` hook never claimed, emitted at the list's top as a coverage backstop. Runs
  // AFTER the list is laid out, so every accurately-placed entry already won the keep-first dedup.
  '  def __asciidocollab_record_leftover_terms(pos)',
  '    pending = @__asciidocollab_dlist_terms',
  '    return if pending.nil? || __asciidocollab_sink.nil?',
  '    pending.each { |term| __asciidocollab_emit(__asciidocollab_lineno_of(term), pos[0], pos[1]) }',
  '  rescue ::StandardError',
  '  end',
  // For a qanda item `list_type == :dlist` the node is a [terms, description] pair; for every other
  // list it is the ListItem itself. Record the term/item line (and the qanda description line) at top.
  '  def __asciidocollab_record_list_item(node, list_type)',
  '    return if __asciidocollab_sink.nil?',
  '    pos = __asciidocollab_position',
  '    return if pos.nil?',
  '    if list_type == :dlist && node.is_a?(::Array)',
  '      terms = node[0]',
  '      __asciidocollab_emit(__asciidocollab_lineno_of(terms[0]), pos[0], pos[1]) if terms.is_a?(::Array) && !terms.empty?',
  '      __asciidocollab_emit(__asciidocollab_lineno_of(node[1]), pos[0], pos[1])',
  '    else',
  '      __asciidocollab_emit(__asciidocollab_lineno_of(node), pos[0], pos[1])',
  '    end',
  '  rescue ::StandardError',
  '  end',
  'end',
  'unless ::Asciidoctor::PDF::Converter.ancestors.include?(::AsciidocollabSourceMap)',
  '  ::Asciidoctor::PDF::Converter.prepend(::AsciidocollabSourceMap)',
  'end',
].join('\n');

/**
 * Ruby that serializes the collected source-map entries to {@link SOURCEMAP_PATH}: drop entries that
 * land beyond the finished document, de-duplicate in render order (keep the first entry per line), then
 * sort by line. Wrapped so a serialization failure leaves the render untouched (the client just gets no
 * map).
 *
 * The out-of-range drop happens BEFORE the de-duplication, never after: a bogus entry recorded ahead of
 * the real one would otherwise win the keep-first pass and then be removed, leaving that line with no
 * entry at all. It is a backstop for the scratch-document guard in {@link SOURCEMAP_SHIM}, not a
 * replacement for it — a scratch capture whose page happens to fall inside the real range is invisible
 * here and must be prevented at the source.
 */
const SOURCEMAP_WRITE = [
  'begin',
  `  collected = (${SOURCEMAP_GLOBAL} || [])`,
  `  ${SOURCEMAP_GLOBAL} = nil`,
  `  max_page = ${PAGE_COUNT_GLOBAL}`,
  '  max_page = nil unless max_page.is_a?(::Integer) && max_page > 0',
  '  seen = {}',
  '  deduped = []',
  '  collected.each do |entry|',
  "    next if max_page && entry['page'].is_a?(::Integer) && entry['page'] > max_page",
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

/**
 * The Ruby global accumulating this render's per-stage costs, in milliseconds, keyed by stage. Set to
 * a fresh hash immediately before each convert, so a warm VM never reports one render's cost on the
 * next. The hooks below accumulate into it only while it is a Hash, which makes every eval outside a
 * convert (the probe, the optimize pass) inert as far as measurement is concerned.
 */
const STAGE_MS_GLOBAL = '$__asciidocollab_stage_ms';

/** The Ruby global marking the timing hooks as installed, so a warm VM prepends them exactly once. */
const TIMING_INSTALLED_GLOBAL = '$__asciidocollab_timing_installed';

/**
 * Ruby prelude installing the in-VM stage timers.
 *
 * These stages cannot be measured from outside the VM. The main thread sees one synchronous `eval`
 * and can only report what the whole conversion cost, which ranks documents against each other and
 * supports no decision beyond that. The dry runs are the reason this exists: Asciidoctor-PDF lays
 * every keep-together block out twice — once into a throwaway scratch document to measure it, once
 * for real — and that cost is invisible in every figure the host can take.
 *
 * Three properties matter and each is deliberate:
 *
 * - **Every figure is SELF time.** The stages nest — fonts are parsed during the converter's walk,
 *   dry runs happen inside it, and dry runs nest inside each other — so a naive accumulator reports
 *   the same milliseconds under several stages at once and a breakdown that sums to more than the
 *   render took. A stack keeps each frame's clock paused while a nested frame runs, so the figures
 *   partition the instrumented time instead of overlapping it.
 * - **A missing seam is skipped, not faked.** Each hook resolves its constant and checks the method
 *   exists; an engine version that renamed one simply reports no figure for that stage, which the
 *   protocol expresses as an absent field rather than a zero.
 * - **Installation happens once per warm VM.** Prepending on every render would stack wrappers,
 *   multiplying the measurement overhead on the very path being measured.
 *
 * Stage boundaries only — never per block — so the instrumentation cannot meaningfully perturb what
 * it measures.
 */
const TIMING_SHIM = [
  'module ::AsciidocollabTiming',
  '  def self.accumulate(key, seconds)',
  `    acc = ${STAGE_MS_GLOBAL}`,
  '    return unless acc.is_a?(::Hash)',
  '    acc[key] = (acc[key] || 0.0) + (seconds * 1000.0)',
  '  rescue ::StandardError',
  '  end',
  '  def self.stack',
  '    @stack ||= []',
  '  end',
  '  def self.now',
  '    ::Process.clock_gettime(::Process::CLOCK_MONOTONIC)',
  '  end',
  // Charge the frame we are leaving behind for the time it has run so far, then start this one's.
  '  def self.enter(key)',
  '    frames = stack',
  '    at = now',
  '    parent = frames.last',
  '    accumulate(parent[0], at - parent[1]) if parent',
  '    frames.push([key, at])',
  '  rescue ::StandardError',
  '  end',
  // Charge this frame, then restart the parent's clock from here so the nested time is not its.
  '  def self.leave',
  '    frames = stack',
  '    frame = frames.pop',
  '    return if frame.nil?',
  '    at = now',
  '    accumulate(frame[0], at - frame[1])',
  '    parent = frames.last',
  '    parent[1] = at if parent',
  '  rescue ::StandardError',
  '  end',
  // Resolve a constant by name so a renamed or absent engine class yields nil instead of raising.
  '  def self.resolve(path)',
  "    path.split('::').reject { |name| name.empty? }.inject(::Object) { |scope, name| scope.const_get(name) }",
  '  rescue ::NameError',
  '    nil',
  '  end',
  '  def self.install(path, method, key, singleton = false)',
  '    owner = resolve(path)',
  '    return if owner.nil?',
  '    target = singleton ? owner.singleton_class : owner',
  '    return unless target.method_defined?(method) || target.private_method_defined?(method)',
  '    wrapper = ::Module.new do',
  '      define_method(method) do |*args, &block|',
  '        ::AsciidocollabTiming.enter(key)',
  '        begin',
  '          super(*args, &block)',
  '        ensure',
  '          ::AsciidocollabTiming.leave',
  '        end',
  '      end',
  // Keyword arguments must survive the delegation: `dry_run` takes them, and losing them would turn
  // a measurement into a broken render.
  '      ruby2_keywords(method) if respond_to?(:ruby2_keywords, true)',
  '    end',
  '    target.prepend(wrapper)',
  '  rescue ::StandardError',
  '  end',
  'end',
  `unless ${TIMING_INSTALLED_GLOBAL}`,
  "  ::AsciidocollabTiming.install('Asciidoctor::Document', :parse, 'parseMs')",
  // The converter walk. Everything below happens inside it, and the self-time accounting keeps each
  // of those out of this figure rather than reporting them twice.
  "  ::AsciidocollabTiming.install('Asciidoctor::PDF::Converter', :convert_document, 'converterWalkMs')",
  "  ::AsciidocollabTiming.install('Asciidoctor::PDF::Converter', :dry_run, 'dryRunMs')",
  // Parsing a font file and building its subset are both font cost, so they share one bucket; a parse
  // nested inside a subset contributes its time once, to that bucket, like any other nesting.
  "  ::AsciidocollabTiming.install('TTFunk::File', :open, 'fontMs', true)",
  "  ::AsciidocollabTiming.install('TTFunk::Subset::Base', :encode, 'fontMs')",
  "  ::AsciidocollabTiming.install('Prawn::Document', :render, 'serializeMs')",
  "  ::AsciidocollabTiming.install('Prawn::Document', :render_file, 'serializeMs')",
  `  ${TIMING_INSTALLED_GLOBAL} = true`,
  'end',
].join('\n');

/** Ruby local (in `buildConvertCode`'s eval scope) holding the stage costs written with the result. */
const TIMINGS_LOCAL = '__asciidocollab_timings';

/**
 * Ruby that folds the accumulated stage costs into the shape the host reads, dropping any stage that
 * was never measured. The figures are already self time (see {@link TIMING_SHIM}), so nothing needs
 * subtracting out of anything else here.
 */
const TIMINGS_BUILD = [
  `${TIMINGS_LOCAL} = begin`,
  `  acc = ${STAGE_MS_GLOBAL} || {}`,
  '  out = {}',
  "  ['parseMs', 'converterWalkMs', 'dryRunMs', 'fontMs', 'serializeMs'].each do |key|",
  '    out[key] = acc[key] if acc[key]',
  '  end',
  '  out',
  'rescue ::StandardError',
  '  {}',
  'end',
].join('\n');

/**
 * The Ruby global naming the extensions THIS render selected, read by every extension's hooks to
 * decide whether to act.
 *
 * Why a runtime set rather than the load list. Extensions customise the converter with
 * `Module#prepend`, which Ruby cannot undo, and the wasm VM is warm and never torn down. So "loaded"
 * is a one-way door: once a render enables an extension, every later render in that VM inherits it,
 * whatever that project selected. Gating on being loaded therefore cannot express a render that does
 * NOT want an extension the VM has already seen — which is exactly what SC-015a (disable returns the
 * unextended document) and FR-031b1 (preview without one extension) both require.
 *
 * Separating the two — prepend once, activate per render — makes the warm VM's accumulation
 * harmless: a module still in the ancestor chain simply declines to act.
 *
 * `nil` means "every loaded extension is enabled". That is not a fallback for our own callers, who
 * always publish a set (an empty array when they selected nothing); it is the contract for the
 * canonical `asciidoctor-pdf -r <file>` CLI, which never runs this program at all and where
 * requiring a file IS the selection. Keeping that case meaningful is what lets the parity references
 * be produced by the real toolchain from the same extension sources.
 */
const ENABLED_EXTENSIONS_GLOBAL = '$__asciidocollab_enabled_extensions';

/** Ruby local (in `buildConvertCode`'s top-level eval scope) collecting extensions that raised while loading. */
const EXTENSION_FAILURES_LOCAL = '__asciidocollab_extension_failures';

/** Ruby that publishes this render's extension selection, replacing whatever the last render set. */
function enabledExtensionsAssignment(ids: readonly string[]): string {
  return `${ENABLED_EXTENSIONS_GLOBAL} = [${ids.map((id) => rubyString(id)).join(', ')}]`;
}

/**
 * Ruby that publishes this render's extension selection and then loads each extension UNDER ITS OWN
 * `begin/rescue`, so an administrator-provided extension that raises at load time (a syntax error, a
 * `LoadError`, or a runtime error during `require`) degrades to "skipped and reported" instead of
 * aborting the whole export.
 *
 * Each `require` is guarded INDIVIDUALLY (not the batch) so one broken extension cannot suppress the
 * others that load fine. On failure the extension's id is deleted from the enabled global, which is the
 * runtime gate every extension checks before acting (see {@link ENABLED_EXTENSIONS_GLOBAL}): a module a
 * failed `require` had already `prepend`ed to the converter would otherwise stay active with only half
 * its code loaded. The failure — class name + message, keyed by id — is collected into
 * {@link EXTENSION_FAILURES_LOCAL}, a top-level local read back with the convert result so the host can
 * surface a per-extension warning naming the culprit rather than a raw whole-render failure.
 *
 * `::ScriptError` covers `SyntaxError`/`LoadError` (which are NOT `StandardError`), `::StandardError`
 * covers runtime errors raised while the file's top level executes. When `loadedExtensions` is empty
 * the block still emits both assignments and a harmless empty `[].each`.
 */
function extensionRequireBlock(loadedExtensions: readonly LoadedExtensionReference[]): string {
  const pairs = loadedExtensions
    .map((extension) => `[${rubyString(extension.id)}, ${rubyString(extension.vfsPath)}]`)
    .join(', ');
  return [
    enabledExtensionsAssignment(loadedExtensions.map((extension) => extension.id)),
    `${EXTENSION_FAILURES_LOCAL} = []`,
    `[${pairs}].each do |__ext_id, __ext_path|`,
    '  begin',
    '    require __ext_path',
    '  rescue ::ScriptError, ::StandardError => __ext_error',
    `    ${EXTENSION_FAILURES_LOCAL} << { 'id' => __ext_id, ` +
      `'message' => "#{__ext_error.class.name}: #{__ext_error.message}" }`,
    `    ${ENABLED_EXTENSIONS_GLOBAL}.delete(__ext_id)`,
    '  end',
    'end',
  ].join('\n');
}

function buildConvertCode(
  sourcePath: string,
  outputPath: string,
  attributes: ConvertAttributes,
  loadedExtensions: readonly LoadedExtensionReference[] = [],
): string {
  return [
    "require 'json'",
    "require 'asciidoctor'",
    "require 'asciidoctor-pdf'",
    READABLE_SHIM,
    SOURCEMAP_SHIM,
    TIMING_SHIM,
    // Extensions load AFTER the shims and BEFORE convert_file: they customise the converter, so the
    // converter must exist, and the document must not yet have been built.
    //
    // Loaded by `require` from a deployment-controlled mount — NEVER from `/project`, which is
    // member-writable, and never eval'd inline. `require` (not `load`) is what makes a double
    // selection harmless: the VM is warm and never torn down, so an extension that `prepend`s a
    // module would corrupt every later render if it ran twice.
    //
    // The selection is published UNCONDITIONALLY and BEFORE the requires — including as an empty
    // array. A render that selected nothing still has to say so, because the warm VM may carry
    // extensions an earlier render loaded and only this assignment switches them off.
    //
    // Each require is individually guarded (see `extensionRequireBlock`): a broken extension is skipped,
    // removed from the enabled set, and recorded — never allowed to abort the render, mirroring how the
    // theme path attributes its own failures rather than surfacing a raw whole-render error.
    extensionRequireBlock(loadedExtensions),
    'begin',
    '  logger = Asciidoctor::MemoryLogger.new',
    '  Asciidoctor::LoggerManager.logger = logger',
    `  ${SOURCEMAP_GLOBAL} = []`,
    // Cleared per convert so the out-of-range backstop never filters against a prior render's page count.
    `  ${PAGE_COUNT_GLOBAL} = nil`,
    // A fresh accumulator per convert: on a warm VM the previous render's figures would otherwise be
    // added to this one's, and every stage would look worse the longer the session ran.
    `  ${STAGE_MS_GLOBAL} = {}`,
    // Load the assembly line→source provenance the include-resolve stage wrote (a JSON array; `[]` for
    // exports). The source-map hook reads it to stamp each block's exact origin. Best-effort: any read/parse
    // failure leaves an empty provenance, so the map simply carries no origins.
    `  ${PROVENANCE_GLOBAL} = begin`,
    `    File.exist?(${rubyString(SOURCE_PROVENANCE_PATH)}) ? JSON.parse(File.read(${rubyString(SOURCE_PROVENANCE_PATH)})) : []`,
    '  rescue ::StandardError',
    '    []',
    '  end',
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
    TIMINGS_BUILD,
    "  warnings = logger.messages.map { |m| { 'severity' => m[:severity].to_s, " +
      "'message' => (m[:message].is_a?(::Hash) ? m[:message][:text] : m[:message]).to_s } }",
    // The result is WRITTEN to the VFS, not returned. The host reads it via `readFile`, which does not
    // touch wasm memory — unlike marshalling the eval's return value, which a `memory.grow` during this
    // render can corrupt. See the convert step in `invokeConvert`. Both branches must write it.
    `  File.write(${rubyString(RESULT_PATH)}, JSON.generate({ 'ok' => true, 'warnings' => warnings, ` +
      `'extension_failures' => ${EXTENSION_FAILURES_LOCAL}, 'timings' => ${TIMINGS_LOCAL} }))`,
    'rescue => e',
    `  ${SOURCEMAP_GLOBAL} = nil`,
    `  File.write(${rubyString(RESULT_PATH)}, JSON.generate({ 'ok' => false, 'code' => e.class.name, ` +
      `'message' => e.message, 'extension_failures' => ${EXTENSION_FAILURES_LOCAL} }))`,
    'end',
  ].join('\n');
}

/**
 * Asciidoctor's soft-set marker: a trailing `@` on an attribute value means "a document header may
 * override this". Duplicated here rather than imported because this package must not depend on
 * `shared` (it is bundled into a Web Worker); the shared `SOFT_DEFAULT_SUFFIX` is the same character
 * and a test asserts they agree.
 */
const SOFT_DEFAULT_MARKER = '@';

/**
 * The ONLY theme extension Asciidoctor-PDF recognises as a filename.
 *
 * Its loader tests `value.end_with? '.yml'` and, failing that, appends `-theme.yml`. So a theme named
 * `house-theme.yaml` is looked for at `house-theme.yaml-theme.yml`, is not found, and the engine
 * REVERTS TO THE DEFAULT THEME — a warning in its log, a perfectly good unthemed PDF out.
 */
const ENGINE_THEME_EXTENSION = '.yml';
/** The other extension authors legitimately use, which the app recognises as a theme. */
const ALTERNATE_THEME_EXTENSION = '.yaml';

/**
 * The path a theme must be mounted at for the engine to load it.
 *
 * `.yaml` is a perfectly ordinary way to name a YAML file, the app's own theme-recognition rule
 * accepts it, and an author who names their theme that way gets the theme editor, the file-tree
 * marking and the live sample preview — everything except the theme actually applying. Rather than
 * narrowing what authors may name their files to suit the engine, the file is ALSO mounted under a
 * `.yml` name inside our own VFS and the engine is pointed there.
 *
 * @param themePath - The project-relative theme path, as the author named it.
 * @returns The path to mount and reference, equal to `themePath` when no alias is needed.
 */
export function engineThemePath(themePath: string): string {
  return themePath.toLowerCase().endsWith(ALTERNATE_THEME_EXTENSION)
    ? `${themePath.slice(0, -ALTERNATE_THEME_EXTENSION.length)}${ENGINE_THEME_EXTENSION}`
    : themePath;
}

/**
 * Probes whether the (native-dependent) optimizer + zlib actually loaded in-wasm, writing `true`/`false`
 * to {@link PROBE_RESULT_PATH}.
 *
 * The answer goes through the VFS rather than the eval's return value for the same reason the convert
 * and optimize results do (see the convert step in {@link invokeConvert}): `require 'hexapdf'` loads a
 * large gem when it is present, which grows the wasm heap, and marshalling a return value out of grown
 * memory is the read that intermittently throws `Start offset … outside the bounds of the buffer`.
 */
const HEXAPDF_PROBE_CODE = [
  'begin',
  "  require 'hexapdf'",
  "  require 'zlib'",
  `  File.write(${rubyString(PROBE_RESULT_PATH)}, 'true')`,
  'rescue ::LoadError, ::StandardError',
  `  File.write(${rubyString(PROBE_RESULT_PATH)}, 'false')`,
  'end',
].join('\n');

function buildOptimizeCode(outputPath: string): string {
  return [
    "require 'json'",
    'begin',
    `  doc = HexaPDF::Document.open(${rubyString(outputPath)})`,
    `  doc.write(${rubyString(outputPath)}, optimize: true)`,
    // Written to the VFS, not returned — hexapdf rewrites the whole PDF and grows the wasm heap, so the
    // result is read back through `readFile` for the same reason the convert result is (see the convert
    // step in `invokeConvert`). Both branches must write it.
    `  File.write(${rubyString(OPTIMIZE_RESULT_PATH)}, JSON.generate({ 'ok' => true }))`,
    'rescue => e',
    `  File.write(${rubyString(OPTIMIZE_RESULT_PATH)}, JSON.generate({ 'ok' => false, 'message' => e.message }))`,
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
  await vm.evalAsync(HEXAPDF_PROBE_CODE);
  if (readVfsTextOr(vm, PROBE_RESULT_PATH, 'false').trim() !== 'true') {
    // The optimizer (hexapdf) is deliberately not bundled in this VM build, so its absence is a
    // constant, expected condition — not a per-document problem. Optimization only shrinks the file;
    // the produced PDF is complete and correct without it. Skip silently rather than warning on every
    // render. A genuine attempted-but-failed optimization (below) is still surfaced. An unreadable
    // probe result reads as unavailable, which is the safe default (skip, never fail).
    return;
  }
  try {
    await vm.evalAsync(buildOptimizeCode(outputPath));
    const outcome = parseOptimizeOutcome(readVfsText(vm, OPTIMIZE_RESULT_PATH));
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

/** An extension that raised while loading; the render proceeded without it. */
interface ExtensionFailure {
  readonly id: string;
  readonly message: string;
}

type ConvertOutcome =
  | {
      readonly ok: true;
      readonly warnings: readonly ConvertWarning[];
      readonly extensionFailures: readonly ExtensionFailure[];
      /** The in-VM stage costs the convert program measured, when it reported any. */
      readonly vmStages?: PdfVmStages;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly extensionFailures: readonly ExtensionFailure[];
    };

function parseConvertOutcome(raw: string): ConvertOutcome {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('Convert returned a malformed result');
  }
  // Extension failures ride out with BOTH arms: they are reported even when the convert itself failed,
  // because a broken extension is worth naming regardless of whether the render also died for another
  // reason.
  const extensionFailures = parseExtensionFailures(parsed['extension_failures']);
  if (parsed['ok'] === true) {
    const vmStages = parseVmStages(parsed['timings']);
    return {
      ok: true,
      warnings: parseWarnings(parsed['warnings']),
      extensionFailures,
      ...(vmStages === undefined ? {} : { vmStages }),
    };
  }
  return {
    ok: false,
    code: stringOr(parsed['code'], CONVERT_ERROR_CODES.CONVERT_FAILED),
    message: stringOr(parsed['message'], 'Asciidoctor convert failed'),
    extensionFailures,
  };
}

/** The in-VM stages, in the order they occur, as the convert program names them. */
const VM_STAGE_KEYS = ['parseMs', 'converterWalkMs', 'dryRunMs', 'fontMs', 'serializeMs'] as const;

/**
 * Read the stage costs the convert program reported, keeping only those that are usable durations.
 *
 * A value that is not a finite, non-negative number is DROPPED rather than coerced: a stage reported
 * as `-1`, `NaN` or a string is a stage whose measurement failed, and passing it through would put a
 * figure that is not a duration into a breakdown people read as one. Returns `undefined` when nothing
 * usable survives, so "measured nothing" and "measured zero" stay distinguishable.
 */
function parseVmStages(value: unknown): PdfVmStages | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const stages: Record<string, number> = {};
  for (const key of VM_STAGE_KEYS) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      stages[key] = raw;
    }
  }
  return Object.keys(stages).length > 0 ? stages : undefined;
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

/** Parse the extension-load failures the convert program collected; drop non-records and empty ids. */
function parseExtensionFailures(value: unknown): ExtensionFailure[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const failures: ExtensionFailure[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const id = stringOr(item['id'], '');
    // A failure with no id cannot be attributed to an extension, so it would produce a warning that
    // names nothing — worse than saying nothing. Drop it.
    if (id === '') {
      continue;
    }
    failures.push({ id, message: stringOr(item['message'], '') });
  }
  return failures;
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

/**
 * A YAML parse failure as Psych reports it, with the position it managed to locate.
 *
 * Psych's message names the file `(<unknown>)` — it is handed a string, not a path — so the raw
 * failure reaching an author says only that *something* was malformed at line 12. Which of the
 * project's files is left for them to guess.
 */
const YAML_SYNTAX_ERROR = /Psych::SyntaxError|did not find expected|mapping values are not allowed|could not find expected/i;
/** The position Psych appends to a syntax error, e.g. `at line 12 column 5`. */
const YAML_POSITION = /\bat line (\d+) column (\d+)/i;

/**
 * Name the theme file when a convert failure was caused by it.
 *
 * An unparseable theme aborts the whole render, and the engine's own message is written from inside
 * the YAML parser: it knows the line but not which document it came from. Since the theme is the
 * only YAML the convert loads, a YAML syntax error here is attributable with certainty — and telling
 * the author *which file* and *which line* is the difference between a fixable error and a document
 * that mysteriously stopped exporting (FR-017b, SC-010a).
 *
 * Any other failure is passed through untouched: attributing a message we are not sure about would
 * point the author at the wrong file, which is worse than the vague message they started with.
 *
 * @param message - The raw failure message from the convert.
 * @param themePath - The project-relative theme path, when the snapshot defines one.
 * @returns The message, prefixed with the theme's identity when it is the certain cause.
 */
export function attributeThemeFailure(message: string, themePath: string | undefined): string {
  if (themePath === undefined || !YAML_SYNTAX_ERROR.test(message)) return message;
  const position = YAML_POSITION.exec(message);
  const where = position === null ? themePath : `${themePath}, line ${position[1]}`;
  return `The PDF theme ${where} could not be read: ${message}`;
}
