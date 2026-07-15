import {
  createMountAssetsStage,
  type FontConverter,
} from '../../../src/pipeline/stages/mount-assets';
import {
  cancellationToken,
  createDiagnosticsCollector,
  type AssetCachePort,
  type PipelineVfs,
  type StageContext,
} from '../../../src/pipeline/orchestrator';
import { createShimRegistry } from '../../../src/ports/shim';
import type { GeneratedAsset, ProjectSnapshot, RenderRequest } from '../../../src/protocol';
import type { AssembledDocument, IncludeAssembler, ProjectFileReader } from '../../../src/ports/include-assembler';

// ---------------------------------------------------------------------------
// In-memory fakes for the injected seams.
// ---------------------------------------------------------------------------

interface FakeVfs extends PipelineVfs {
  readonly writtenPaths: () => readonly string[];
}

function makeVfs(): FakeVfs {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    writeFile: (path, bytes) => void store.set(path, bytes),
    readFile: (path) => store.get(path) ?? null,
    writeText: (path, content) => void store.set(path, enc.encode(content)),
    readText: (path) => {
      const bytes = store.get(path);
      return bytes === undefined ? null : dec.decode(bytes);
    },
    exists: (path) => store.has(path),
    remove: (path) => void store.delete(path),
    list: (prefix) => [...store.keys()].filter((key) => key.startsWith(prefix)),
    writtenPaths: () => [...store.keys()],
  };
}

const noopReadFile: ProjectFileReader = () => null;

const noopAssembler: IncludeAssembler = {
  assemble: (request): AssembledDocument => ({
    content: request.readFile(request.rootPath) ?? '',
    unresolved: [],
  }),
};

function makeCache(): AssetCachePort {
  const store = new Map<string, GeneratedAsset>();
  return {
    get: (hash) => store.get(hash),
    has: (hash) => store.has(hash),
    set: (asset) => void store.set(asset.sourceHash, asset),
  };
}

function makeSnapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    files: {},
    binaryAssets: {},
    rootPath: 'main.adoc',
    openPath: 'main.adoc',
    fontPaths: [],
    attributes: {},
    ...overrides,
  };
}

function makeContext(snapshot: ProjectSnapshot, vfs: PipelineVfs): StageContext {
  const request: RenderRequest = { requestId: 'req-1', mode: 'export', optimize: false, snapshot };
  return {
    request,
    readFile: noopReadFile,
    vfs,
    shims: createShimRegistry([]),
    includeAssembler: noopAssembler,
    cache: makeCache(),
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
}

/** The sfnt bytes the fake decoder returns for a WOFF2 font (a stand-in for a real decoded TTF). */
const DECODED_SFNT = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x74]);

function makeFontConverter(): FontConverter & { readonly woff2ToTtf: jest.Mock } {
  const woff2ToTtf: jest.Mock = jest.fn(async (): Promise<Uint8Array> => DECODED_SFNT);
  return { woff2ToTtf };
}

describe('createMountAssetsStage', () => {
  it('has the fixed pipeline kind', () => {
    expect(createMountAssetsStage({ fontConverter: makeFontConverter() }).kind).toBe('mount-assets');
  });

  it('leaves TTF and OTF fonts to populate — writes nothing and never invokes the decoder', async () => {
    // Prawn embeds TTF/OTF directly, and populateProject already mounted them byte-for-byte, so this
    // stage must not touch them (no `.fonts` copy, no re-mount) and must not call the WOFF2 decoder.
    const snapshot = makeSnapshot({
      fontPaths: ['fonts/Brand-Regular.ttf', 'fonts/Brand-Bold.otf'],
      binaryAssets: {
        'fonts/Brand-Regular.ttf': new Uint8Array([1, 2, 3, 4]),
        'fonts/Brand-Bold.otf': new Uint8Array([5, 6, 7, 8]),
      },
    });
    const vfs = makeVfs();
    const converter = makeFontConverter();

    const result = await createMountAssetsStage({ fontConverter: converter }).run(makeContext(snapshot, vfs));

    expect(vfs.writtenPaths()).toEqual([]);
    expect(converter.woff2ToTtf).not.toHaveBeenCalled();
    expect(result.diagnostics ?? []).toEqual([]);
  });

  it('decodes a WOFF2 font to a .ttf asset in the VFS and drops the stale .woff2', async () => {
    // Prawn dispatches font loading by file EXTENSION: a `.woff2`-named file holding TTF bytes hits its
    // AFM branch and fails to embed. So the decoded sfnt must be materialized under a `.ttf` base name
    // and the stale `.woff2` asset dropped. The immutable snapshot is never mutated — only the VFS.
    const woff2 = new Uint8Array([0x77, 0x4F, 0x46, 0x32]);
    const snapshot = makeSnapshot({
      fontPaths: ['fonts/Brand-Regular.woff2'],
      binaryAssets: { 'fonts/Brand-Regular.woff2': woff2 },
    });
    const vfs = makeVfs();
    // Simulate populate: the source .woff2 font is already mounted under /project.
    vfs.writeFile('/project/fonts/Brand-Regular.woff2', woff2);
    const converter = makeFontConverter();

    const result = await createMountAssetsStage({ fontConverter: converter }).run(makeContext(snapshot, vfs));

    expect(converter.woff2ToTtf).toHaveBeenCalledTimes(1);
    expect(converter.woff2ToTtf).toHaveBeenCalledWith(woff2);
    // The decoded sfnt lands under a `.ttf` base name in the same directory...
    expect(vfs.readFile('/project/fonts/Brand-Regular.ttf')).toEqual(DECODED_SFNT);
    // ...and no `.woff2`-named font asset survives on the VFS.
    expect(vfs.exists('/project/fonts/Brand-Regular.woff2')).toBe(false);
    // The immutable input snapshot is untouched — the convert derives `pdf-fontsdir` from the font's
    // (unchanged) directory, so the `.ttf` resolves from the same search dir without a fontPaths edit.
    expect(snapshot.fontPaths).toEqual(['fonts/Brand-Regular.woff2']);
    expect(result.diagnostics ?? []).toEqual([]);
  });

  it('repoints the project theme font catalogue from the .woff2 base name to the decoded .ttf', async () => {
    // The theme references each font by base name within `pdf-fontsdir`; a stale `.woff2` catalogue
    // entry would fail to embed (extension dispatch) even though the mounted bytes are TTF.
    const woff2 = new Uint8Array([0x77, 0x4F, 0x46, 0x32]);
    const snapshot = makeSnapshot({
      themePath: 'theme/brand.yml',
      fontPaths: ['fonts/Brand-Regular.woff2', 'fonts/Brand-Bold.woff2'],
      binaryAssets: {
        'fonts/Brand-Regular.woff2': woff2,
        'fonts/Brand-Bold.woff2': woff2,
      },
    });
    const vfs = makeVfs();
    // Simulate populate: the theme catalogue and both .woff2 fonts are already mounted under /project.
    vfs.writeText(
      '/project/theme/brand.yml',
      'font:\n  catalog:\n    Brand:\n      normal: Brand-Regular.woff2\n      bold: Brand-Bold.woff2\n',
    );
    vfs.writeFile('/project/fonts/Brand-Regular.woff2', woff2);
    vfs.writeFile('/project/fonts/Brand-Bold.woff2', woff2);

    const result = await createMountAssetsStage({ fontConverter: makeFontConverter() }).run(makeContext(snapshot, vfs));

    const theme = vfs.readText('/project/theme/brand.yml') ?? '';
    expect(theme).toContain('Brand-Regular.ttf');
    expect(theme).toContain('Brand-Bold.ttf');
    expect(theme).not.toContain('.woff2');
    // Both decoded fonts are materialized under their `.ttf` names; the `.woff2` assets are dropped.
    expect(vfs.exists('/project/fonts/Brand-Regular.ttf')).toBe(true);
    expect(vfs.exists('/project/fonts/Brand-Bold.ttf')).toBe(true);
    expect(vfs.exists('/project/fonts/Brand-Regular.woff2')).toBe(false);
    expect(result.diagnostics ?? []).toEqual([]);
  });

  it('leaves a theme that names no decoded font untouched', async () => {
    // A project theme that does not reference the decoded font by base name is not rewritten — the
    // decode still lands as a `.ttf` in the VFS, but the theme bytes stay byte-identical.
    const woff2 = new Uint8Array([0x77, 0x4F, 0x46, 0x32]);
    const snapshot = makeSnapshot({
      themePath: 'theme/brand.yml',
      fontPaths: ['fonts/Brand-Regular.woff2'],
      binaryAssets: { 'fonts/Brand-Regular.woff2': woff2 },
    });
    const vfs = makeVfs();
    const themeText = 'extends: default\nbase:\n  font-family: Noto Serif\n';
    vfs.writeText('/project/theme/brand.yml', themeText);
    vfs.writeFile('/project/fonts/Brand-Regular.woff2', woff2);

    await createMountAssetsStage({ fontConverter: makeFontConverter() }).run(makeContext(snapshot, vfs));

    expect(vfs.readText('/project/theme/brand.yml')).toBe(themeText);
    expect(vfs.readFile('/project/fonts/Brand-Regular.ttf')).toEqual(DECODED_SFNT);
  });

  it('writes nothing under /usr — the baked default fonts are never touched', async () => {
    const snapshot = makeSnapshot({
      fontPaths: ['fonts/Brand-Regular.woff2'],
      binaryAssets: { 'fonts/Brand-Regular.woff2': new Uint8Array([0x77]) },
    });
    const vfs = makeVfs();

    await createMountAssetsStage({ fontConverter: makeFontConverter() }).run(makeContext(snapshot, vfs));

    expect(vfs.writtenPaths().some((path) => path.startsWith('/usr'))).toBe(false);
  });

  it('writes nothing when there are no custom fonts', async () => {
    const vfs = makeVfs();

    const result = await createMountAssetsStage({ fontConverter: makeFontConverter() }).run(makeContext(makeSnapshot(), vfs));

    expect(vfs.writtenPaths()).toEqual([]);
    expect(result.diagnostics ?? []).toEqual([]);
  });

  it('warns with font-unavailable when a declared WOFF2 font has no captured bytes', async () => {
    const snapshot = makeSnapshot({ fontPaths: ['fonts/Missing.woff2'] });
    const vfs = makeVfs();
    const converter = makeFontConverter();

    const result = await createMountAssetsStage({ fontConverter: converter }).run(makeContext(snapshot, vfs));

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics?.[0]?.code).toBe('font-unavailable');
    expect(result.diagnostics?.[0]?.severity).toBe('warning');
    expect(result.diagnostics?.[0]?.resource).toBe('fonts/Missing.woff2');
    expect(converter.woff2ToTtf).not.toHaveBeenCalled();
    expect(vfs.writtenPaths()).toEqual([]);
  });

  it('warns with font-unavailable for unsupported (incl. extensionless) font formats and skips the decoder', async () => {
    const snapshot = makeSnapshot({
      fontPaths: ['fonts/Legacy.woff', 'fonts/Old.eot', 'fonts/Extensionless'],
      binaryAssets: {
        'fonts/Legacy.woff': new Uint8Array([1]),
        'fonts/Old.eot': new Uint8Array([2]),
        'fonts/Extensionless': new Uint8Array([3]),
      },
    });
    const vfs = makeVfs();
    const converter = makeFontConverter();

    const result = await createMountAssetsStage({ fontConverter: converter }).run(makeContext(snapshot, vfs));

    expect(result.diagnostics?.map((diagnostic) => diagnostic.code)).toEqual([
      'font-unavailable',
      'font-unavailable',
      'font-unavailable',
    ]);
    expect(converter.woff2ToTtf).not.toHaveBeenCalled();
    expect(vfs.writtenPaths()).toEqual([]);
  });

  it('warns with font-unavailable when the decoder fails, and never aborts the render', async () => {
    const snapshot = makeSnapshot({
      fontPaths: ['fonts/Broken.woff2'],
      binaryAssets: { 'fonts/Broken.woff2': new Uint8Array([0x77]) },
    });
    const vfs = makeVfs();
    const converter: FontConverter = {
      woff2ToTtf: jest.fn(async () => {
        throw new Error('corrupt WOFF2 stream');
      }),
    };

    const result = await createMountAssetsStage({ fontConverter: converter }).run(makeContext(snapshot, vfs));

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics?.[0]?.code).toBe('font-unavailable');
    expect(result.diagnostics?.[0]?.resource).toBe('fonts/Broken.woff2');
    expect(vfs.writtenPaths()).toEqual([]);
  });
});
