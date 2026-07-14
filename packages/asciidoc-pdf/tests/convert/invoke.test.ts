import {
  BAKED_FONTS_DIR,
  buildConvertAttributes,
  CONVERT_ATTRIBUTE_KEYS,
  CONVERT_ERROR_CODES,
  invokeConvert,
  OPTIMIZE_UNAVAILABLE_CODE,
  PDF_CONTENT_TYPE,
  SOURCE_HIGHLIGHTER_ROUGE,
  type BlobFactory,
} from '../../src/convert/invoke';
import { normalizePdfBytes } from '../../src/convert/normalize-pdf';
import type { ProjectSnapshot, RenderRequest } from '../../src/protocol';
import type { RubyPdfVm } from '../../src/vm/ruby-pdf-vm';
import type { RubyValue } from '../../src/vm/wasi-bridge';

// ---------------------------------------------------------------------------
// Fixtures & helpers.
// ---------------------------------------------------------------------------

const toBytes = (text: string): Uint8Array =>
  Uint8Array.from(text, (character) => character.codePointAt(0) ?? 0);

/** A tiny PDF-shaped buffer whose Info dictionary carries a run-varying timestamp. */
const RAW_PDF_BYTES = toBytes(
  '%PDF-1.7\n<< /CreationDate (D:20230101000000+00\'00\') >>\ntrailer\n<< /ID [<abc><def>] >>\n%%EOF',
);

const OK_CONVERT_JSON = JSON.stringify({ ok: true, warnings: [] });

function makeValue(text: string): RubyValue {
  return { toString: () => text, toJS: () => text };
}

/** The VFS path the convert's tracking hook serializes the block source map to. */
const SOURCEMAP_PATH = '/out/sourcemap.json';

interface FakeConfig {
  convertReject?: boolean;
  convertJson?: string;
  probe?: string;
  optimizeJson?: string;
  outEntries?: string[];
  fileBytes?: Uint8Array;
  readFileThrows?: boolean;
  readdirThrows?: boolean;
  /** Raw bytes served for the source-map file; when set, the file also reports as existing. */
  sourceMapFile?: Uint8Array | null;
  /** Force a throw when the source-map file is read back. */
  sourceMapReadThrows?: boolean;
}

/**
 * In-memory fake of the warm-VM facade. It records every eval'd Ruby program and serves fake
 * `/out` bytes; responses are dispatched by matching recognizable substrings in the Ruby code so
 * the fake never needs to actually run Ruby.
 */
class FakeVm implements RubyPdfVm {
  ready = true;
  /** Every program run on the VM, in order, whether via sync `eval` or `evalAsync`. */
  readonly evalCalls: string[] = [];
  /** Only the programs run via `evalAsync` (the capability-gated optimize/probe path). */
  readonly evalAsyncCalls: string[] = [];
  readonly reads: string[] = [];
  readonly removed: string[] = [];

  constructor(private readonly config: FakeConfig = {}) {}

  async warmup(): Promise<{ coldStart: boolean }> {
    return { coldStart: false };
  }

  // The convert program runs synchronously (on the VM's main stack, not a fiber), so the fake serves
  // its response from `eval`.
  eval(code: string): RubyValue {
    this.evalCalls.push(code);
    if (code.includes('convert_file')) {
      if (this.config.convertReject === true) {
        throw new Error('vm exploded during convert');
      }
      return makeValue(this.config.convertJson ?? OK_CONVERT_JSON);
    }
    return makeValue('');
  }

  async evalAsync(code: string): Promise<RubyValue> {
    this.evalCalls.push(code);
    this.evalAsyncCalls.push(code);
    if (code.includes('HexaPDF::Document')) {
      return makeValue(this.config.optimizeJson ?? JSON.stringify({ ok: true }));
    }
    return makeValue(this.config.probe ?? 'false');
  }

  writeFile(): void {}

  readFile(path: string): Uint8Array {
    this.reads.push(path);
    if (path === SOURCEMAP_PATH) {
      if (this.config.sourceMapReadThrows === true) {
        throw new Error('cannot read source map');
      }
      return this.config.sourceMapFile ?? new Uint8Array();
    }
    if (this.config.readFileThrows === true) {
      throw new Error('no output file');
    }
    return this.config.fileBytes ?? RAW_PDF_BYTES;
  }

  removeFile(path: string): void {
    this.removed.push(path);
  }

  readdir(): string[] {
    if (this.config.readdirThrows === true) {
      throw new Error('no /out dir');
    }
    return this.config.outEntries ?? ['book.pdf'];
  }

  exists(path: string): boolean {
    // The source-map file exists only when the fixture provides its bytes, so the default (no map)
    // never attempts to read it — mirroring a convert whose tracking hook wrote no file.
    if (path === SOURCEMAP_PATH) {
      return this.config.sourceMapFile !== undefined && this.config.sourceMapFile !== null;
    }
    return true;
  }

  dispose(): void {}
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    files: { 'book.adoc': '= Title' },
    binaryAssets: {},
    rootPath: 'book.adoc',
    openPath: 'book.adoc',
    fontPaths: [],
    attributes: { doctype: 'book' },
    ...overrides,
  };
}

function request(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    requestId: 'req-1',
    mode: 'export',
    snapshot: snapshot(),
    optimize: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Attribute builder.
// ---------------------------------------------------------------------------

describe('buildConvertAttributes', () => {
  it('wires source-highlighter: rouge and folds in the project attributes (source of truth)', () => {
    const attributes = buildConvertAttributes(
      snapshot({ attributes: { doctype: 'book', 'my-attr': 'val' } }),
    );

    expect(attributes[CONVERT_ATTRIBUTE_KEYS.SOURCE_HIGHLIGHTER]).toBe(SOURCE_HIGHLIGHTER_ROUGE);
    expect(attributes['doctype']).toBe('book');
    expect(attributes['my-attr']).toBe('val');
  });

  it('does NOT invent a theme default when the project defines no theme', () => {
    const attributes = buildConvertAttributes(snapshot({ themePath: undefined }));

    expect(attributes[CONVERT_ATTRIBUTE_KEYS.PDF_THEME]).toBeUndefined();
    expect(attributes[CONVERT_ATTRIBUTE_KEYS.PDF_THEMESDIR]).toBeUndefined();
  });

  it('wires theme, fonts and imagesdir from the snapshot when present', () => {
    const attributes = buildConvertAttributes(
      snapshot({
        themePath: 'themes/brand-theme.yml',
        fontPaths: ['fonts/Brand.ttf'],
        imagesDir: 'images',
      }),
    );

    expect(attributes[CONVERT_ATTRIBUTE_KEYS.PDF_THEME]).toBe('brand-theme.yml');
    expect(attributes[CONVERT_ATTRIBUTE_KEYS.PDF_THEMESDIR]).toBe('/project/themes');
    expect(attributes[CONVERT_ATTRIBUTE_KEYS.PDF_FONTSDIR]).toContain('/project/fonts');
    expect(attributes[CONVERT_ATTRIBUTE_KEYS.IMAGESDIR]).toBe('images');
  });

  it('does NOT set imagesdir when the project defines none (no invented default)', () => {
    const attributes = buildConvertAttributes(snapshot({ imagesDir: undefined }));

    expect(attributes[CONVERT_ATTRIBUTE_KEYS.IMAGESDIR]).toBeUndefined();
  });

  it('appends extra font dirs after the per-font dirs and keeps the baked default last', () => {
    const attributes = buildConvertAttributes(
      snapshot({ fontPaths: ['fonts/Brand.ttf'], extraFontDirs: ['assets/fonts', 'branding'] }),
    );

    const fontsDirectory = attributes[CONVERT_ATTRIBUTE_KEYS.PDF_FONTSDIR];
    expect(fontsDirectory).toBe(`/project/fonts;/project/assets/fonts;/project/branding;${BAKED_FONTS_DIR}`);
  });

  it('sets pdf-fontsdir from extra dirs even when the project ships no font files', () => {
    const attributes = buildConvertAttributes(snapshot({ fontPaths: [], extraFontDirs: ['assets/fonts'] }));

    expect(attributes[CONVERT_ATTRIBUTE_KEYS.PDF_FONTSDIR]).toBe(`/project/assets/fonts;${BAKED_FONTS_DIR}`);
  });

  it('leaves pdf-fontsdir unset when there are no fonts and no extra dirs', () => {
    const attributes = buildConvertAttributes(snapshot({ fontPaths: [], extraFontDirs: [] }));

    expect(attributes[CONVERT_ATTRIBUTE_KEYS.PDF_FONTSDIR]).toBeUndefined();
  });

  it('joins the project font dirs WITH the baked default so both resolve', () => {
    const attributes = buildConvertAttributes(
      snapshot({ fontPaths: ['fonts/Brand.ttf', 'fonts/Brand-Bold.ttf'] }),
    );

    const fontsDirectory = attributes[CONVERT_ATTRIBUTE_KEYS.PDF_FONTSDIR];
    expect(fontsDirectory).toContain('/project/fonts');
    expect(fontsDirectory).toContain(BAKED_FONTS_DIR);
    // The baked default is last so custom fonts take precedence over the bundled ones.
    expect(fontsDirectory?.indexOf('/project/fonts')).toBeLessThan(
      fontsDirectory?.indexOf(BAKED_FONTS_DIR) ?? -1,
    );
  });

  it('omits pdf-fontsdir entirely when the project ships no custom fonts', () => {
    const attributes = buildConvertAttributes(snapshot({ fontPaths: [] }));

    expect(attributes[CONVERT_ATTRIBUTE_KEYS.PDF_FONTSDIR]).toBeUndefined();
  });

  it('lets the project attributes override the wired theme/imagesdir/highlighter defaults', () => {
    const attributes = buildConvertAttributes(
      snapshot({
        themePath: 'themes/brand-theme.yml',
        imagesDir: 'images',
        attributes: {
          doctype: 'book',
          [CONVERT_ATTRIBUTE_KEYS.SOURCE_HIGHLIGHTER]: 'pygments',
          [CONVERT_ATTRIBUTE_KEYS.IMAGESDIR]: 'assets',
          [CONVERT_ATTRIBUTE_KEYS.PDF_THEME]: 'override-theme.yml',
        },
      }),
    );

    expect(attributes[CONVERT_ATTRIBUTE_KEYS.SOURCE_HIGHLIGHTER]).toBe('pygments');
    expect(attributes[CONVERT_ATTRIBUTE_KEYS.IMAGESDIR]).toBe('assets');
    expect(attributes[CONVERT_ATTRIBUTE_KEYS.PDF_THEME]).toBe('override-theme.yml');
  });
});

// ---------------------------------------------------------------------------
// Convert invocation shape.
// ---------------------------------------------------------------------------

describe('invokeConvert — invocation shape', () => {
  it('builds a convert_file invocation with the required backend/safe/to_file/attributes', async () => {
    const vm = new FakeVm();
    await invokeConvert({
      vm,
      request: request({ snapshot: snapshot({ attributes: { doctype: 'book' } }) }),
    });

    const convertCode = vm.evalCalls.find((code) => code.includes('convert_file'));
    expect(convertCode).toBeDefined();
    const code = convertCode ?? '';
    expect(code).toContain("Asciidoctor.convert_file('/project/book.adoc'");
    expect(code).toContain("backend: 'pdf'");
    expect(code).toContain('safe: :unsafe');
    expect(code).toContain("to_file: '/out/book.pdf'");
    // base_dir is pinned to the project root so project-root-relative image/imagesdir targets resolve
    // the same way the app mounts them — even when the root document lives in a subfolder.
    expect(code).toContain("base_dir: '/project'");
    expect(code).toContain('mkdirs: true');
    expect(code).toContain("'source-highlighter' => 'rouge'");
    expect(code).toContain("'doctype' => 'book'");
    // No invented theme default when the project defines none.
    expect(code).not.toContain("'pdf-theme'");
    // The document is converted with sourcemap enabled and the tracking hook is prepended so the block
    // source map can be built as the PDF is laid out.
    expect(code).toContain('sourcemap: true');
    expect(code).toContain('::Asciidoctor::PDF::Converter.prepend(::AsciidocollabSourceMap)');
    expect(code).toContain("File.write('/out/sourcemap.json'");
  });

  it('only issues the convert eval when optimize is not requested', async () => {
    const vm = new FakeVm();
    await invokeConvert({ vm, request: request({ optimize: false }) });

    // Exactly one program runs — the (synchronous) convert — and no evalAsync/optimize probe fires.
    expect(vm.evalCalls).toHaveLength(1);
    expect(vm.evalCalls[0]).toContain('convert_file');
    expect(vm.evalAsyncCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Read-back, normalization, Blob, /out clearing.
// ---------------------------------------------------------------------------

describe('invokeConvert — read-back & determinism', () => {
  it('reads /out, normalizes the bytes, wraps a Blob, and clears /out', async () => {
    const vm = new FakeVm();
    const result = await invokeConvert({ vm, request: request() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(vm.reads).toEqual(['/out/book.pdf']);
    expect([...result.bytes]).toEqual([...normalizePdfBytes(RAW_PDF_BYTES)]);
    expect(result.pdf).toBeInstanceOf(Blob);
    expect(result.pdf.type).toBe(PDF_CONTENT_TYPE);
    expect(result.pdf.size).toBe(result.bytes.length);
    expect(vm.removed).toEqual(['/out/book.pdf']);
  });

  it('uses an injected Blob factory when supplied (env-independent wrapping)', async () => {
    const vm = new FakeVm();
    const captured: Array<{ bytes: Uint8Array; contentType: string }> = [];
    const createBlob: BlobFactory = (bytes, contentType) => {
      captured.push({ bytes, contentType });
      // Copy into a fresh ArrayBuffer-backed view so the byte part is an unambiguous BlobPart.
      return new Blob([new Uint8Array(bytes)], { type: contentType });
    };

    await invokeConvert({ vm, request: request(), createBlob });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.contentType).toBe(PDF_CONTENT_TYPE);
  });

  it('still returns a PDF when /out cannot be enumerated for clearing', async () => {
    const vm = new FakeVm({ readdirThrows: true });
    const result = await invokeConvert({ vm, request: request() });

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source map read-back.
// ---------------------------------------------------------------------------

const encodeText = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('invokeConvert — source map read-back', () => {
  it('reads /out/sourcemap.json back and carries valid, clamped entries on the result', async () => {
    const map = [
      { line: 1, page: 1, yFraction: 0.1 },
      { line: 5, page: 1, yFraction: 0.6 },
      { line: 9, page: 2, yFraction: 1.4 }, // over-range fraction is clamped to 1
    ];
    const vm = new FakeVm({ sourceMapFile: encodeText(JSON.stringify(map)) });
    const result = await invokeConvert({ vm, request: request() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.sourceMap).toEqual([
      { line: 1, page: 1, yFraction: 0.1 },
      { line: 5, page: 1, yFraction: 0.6 },
      { line: 9, page: 2, yFraction: 1 },
    ]);
  });

  it('drops malformed entries and omits the map entirely when none survive', async () => {
    const map = [
      { line: 'x', page: 1, yFraction: 0.1 }, // non-numeric line
      { page: 2, yFraction: 0.5 }, // missing line
      42, // not an object
    ];
    const vm = new FakeVm({ sourceMapFile: encodeText(JSON.stringify(map)) });
    const result = await invokeConvert({ vm, request: request() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.sourceMap).toBeUndefined();
  });

  it('omits the map when no source-map file was written (the common no-hook-output case)', async () => {
    const vm = new FakeVm();
    const result = await invokeConvert({ vm, request: request() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.sourceMap).toBeUndefined();
    // The absent file is never read, so the read log stays limited to the PDF.
    expect(vm.reads).toEqual(['/out/book.pdf']);
  });

  it('degrades to no map when the source-map file is present but not valid JSON', async () => {
    const vm = new FakeVm({ sourceMapFile: encodeText('not json{') });
    const result = await invokeConvert({ vm, request: request() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.sourceMap).toBeUndefined();
  });

  it('degrades to no map when reading the source-map file throws', async () => {
    const vm = new FakeVm({ sourceMapFile: encodeText('[]'), sourceMapReadThrows: true });
    const result = await invokeConvert({ vm, request: request() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.sourceMap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hexapdf capability gating.
// ---------------------------------------------------------------------------

describe('invokeConvert — hexapdf optimize gating', () => {
  it('runs the optimize step when hexapdf is available', async () => {
    const vm = new FakeVm({ probe: 'true' });
    const result = await invokeConvert({ vm, request: request({ optimize: true }) });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(vm.evalAsyncCalls.some((code) => code.includes('HexaPDF::Document'))).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('skips optimize SILENTLY (still returns a PDF, no diagnostic) when hexapdf is unavailable', async () => {
    const vm = new FakeVm({ probe: 'false' });
    const result = await invokeConvert({ vm, request: request({ optimize: true }) });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.pdf).toBeInstanceOf(Blob);
    expect(vm.evalAsyncCalls.some((code) => code.includes('HexaPDF::Document'))).toBe(false);
    // The optimizer is deliberately absent from this VM build, so its unavailability is a constant,
    // expected condition — not a per-document warning. The render is complete without it.
    expect(result.diagnostics).toHaveLength(0);
  });

  it('records a diagnostic (never fails) when the optimize step itself errors', async () => {
    const vm = new FakeVm({ probe: 'true', optimizeJson: JSON.stringify({ ok: false, message: 'boom' }) });
    const result = await invokeConvert({ vm, request: request({ optimize: true }) });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe(OPTIMIZE_UNAVAILABLE_CODE);
  });
});

// ---------------------------------------------------------------------------
// Per-block convert diagnostics.
// ---------------------------------------------------------------------------

describe('invokeConvert — per-block diagnostics', () => {
  it('classifies convert warnings into render diagnostics and drops unclassifiable ones', async () => {
    const convertJson = JSON.stringify({
      ok: true,
      warnings: [
        { severity: 'WARN', message: 'Could not find glyph U+1F600 in the font' },
        { severity: 'ERROR', message: 'font Brand not found; falling back' },
        { severity: 'WARN', message: 'image to embed not found or not readable: /project/logo.png' },
        { severity: 'WARN', message: 'could not embed image: /project/shot.png; bignum too big to convert into `long\'' },
        { severity: 'INFO', message: 'section title out of sequence' },
      ],
    });
    const vm = new FakeVm({ convertJson });
    const result = await invokeConvert({ vm, request: request() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'missing-glyph',
      'font-unavailable',
      'unsupported-image',
      'unsupported-image',
    ]);
    expect(result.diagnostics[0]?.severity).toBe('warning');
    expect(result.diagnostics[1]?.severity).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Failure surface.
// ---------------------------------------------------------------------------

describe('invokeConvert — failure', () => {
  it('returns a RenderError{phase:convert} when the convert reports failure', async () => {
    const vm = new FakeVm({
      convertJson: JSON.stringify({ ok: false, code: 'RuntimeError', message: 'unparseable root' }),
    });
    const result = await invokeConvert({ vm, request: request() });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error.phase).toBe('convert');
    expect(result.error.code).toBe('RuntimeError');
    expect(result.error.message).toBe('unparseable root');
    expect(result.error.requestId).toBe('req-1');
  });

  it('returns a RenderError{phase:convert} when the convert eval rejects', async () => {
    const vm = new FakeVm({ convertReject: true });
    const result = await invokeConvert({ vm, request: request() });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error.phase).toBe('convert');
    expect(result.error.code).toBe(CONVERT_ERROR_CODES.CONVERT_FAILED);
  });

  it('returns a RenderError{phase:read-output} when the output cannot be read back', async () => {
    const vm = new FakeVm({ readFileThrows: true });
    const result = await invokeConvert({ vm, request: request() });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error.phase).toBe('read-output');
    expect(result.error.code).toBe(CONVERT_ERROR_CODES.READ_OUTPUT_FAILED);
  });
});
