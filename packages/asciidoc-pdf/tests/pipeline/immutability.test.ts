/**
 * Integrated proof of shared-content immutability: the pre-processing pipeline (include inlining,
 * `.gen` diagram/math assets, and the citation rewrite) writes ONLY to the injected in-memory VFS and
 * never mutates the input {@link ProjectSnapshot}. The snapshot is deep-frozen before the run (so any
 * attempted mutation of `files` / `binaryAssets` / `attributes` throws) and deep-compared to a pre-run
 * clone afterward. Separately, the VFS is inspected to confirm the pre-processing DID land there — so
 * the assertions cannot pass by the stages simply doing nothing.
 *
 * This composes the already-built stage factories through the real orchestrator; it does not re-test
 * any individual stage's behavior.
 */

import { createIncludeResolveStage } from '../../src/pipeline/stages/include-resolve';
import { createCitationsStage } from '../../src/pipeline/stages/citations';
import { createDiagramsMathStage } from '../../src/pipeline/stages/diagrams-math';
import { createImageGuardStage } from '../../src/pipeline/stages/image-guard';
import { createMountAssetsStage } from '../../src/pipeline/stages/mount-assets';
import {
  cancellationToken,
  createDiagnosticsCollector,
  runPipeline,
  type AssetCachePort,
  type PipelineStage,
  type PipelineVfs,
  type StageContext,
} from '../../src/pipeline/orchestrator';
import {
  createShimRegistry,
  type RenderShim,
  type ShimInput,
  type ShimOutput,
} from '../../src/ports/shim';
import { GeneratedAssetCache } from '../../src/cache/content-address';
import type { ProjectFileReader, SandboxPathResolver } from '../../src/ports/include-assembler';
import type { IncludeAssembler } from '../../src/ports/include-assembler';
import type { ProjectSnapshot, RenderRequest } from '../../src/protocol';

// ---------------------------------------------------------------------------
// In-memory fakes for every injected seam.
// ---------------------------------------------------------------------------

const ROOT_PATH = 'main.adoc';
const CHAPTER_PATH = 'chapter.adoc';
const BIB_PATH = 'refs.bib';
const THEME_PATH = 'themes/brand-theme.yml';
// A WOFF2 font, so the asset-mount stage acts on it (decoding it in place); TTF/OTF are left to populate.
const FONT_PATH = 'fonts/Brand.woff2';
const LOGO_PATH = 'logo.png';

const INCLUDE_DIRECTIVE = 'include::chapter.adoc[]';
const CHAPTER_BODY = 'Chapter body with inline stem:[y].';
const REFERENCE_MARKER = '== References';

const PROJECT = '/project';
const ROOT_VFS_PATH = `${PROJECT}/${ROOT_PATH}`;
const GEN_PREFIX = `${PROJECT}/.gen/`;
const FONT_VFS_PATH = `${PROJECT}/${FONT_PATH}`;
// The `.ttf` the WOFF2 font decodes into: prawn dispatches by extension, so the embeddable sfnt is
// materialized under a `.ttf` base name (never written back to the `.woff2` name).
const DECODED_FONT_VFS_PATH = FONT_VFS_PATH.replace(/\.woff2$/, '.ttf');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ROOT_DOCUMENT = [
  '= Immutable Doc',
  '',
  INCLUDE_DIRECTIVE,
  '',
  'cite:[knuth1984]',
  '',
  '[mermaid]',
  '----',
  'graph TD; A-->B;',
  '----',
  '',
  '[stem]',
  '++++',
  'sqrt(9)=3',
  '++++',
  '',
  'image::logo.png[]',
  '',
].join('\n');

function makeSnapshot(): ProjectSnapshot {
  return {
    files: {
      [ROOT_PATH]: ROOT_DOCUMENT,
      [CHAPTER_PATH]: CHAPTER_BODY,
      [BIB_PATH]: '@book{knuth1984, title={The Art}}',
      [THEME_PATH]: 'extends: default',
    },
    binaryAssets: {
      [LOGO_PATH]: Uint8Array.from([0x89, 0x50, 0x4E, 0x47]),
      [FONT_PATH]: Uint8Array.from([0x00, 0x01, 0x00, 0x00]),
    },
    rootPath: ROOT_PATH,
    openPath: ROOT_PATH,
    themePath: THEME_PATH,
    fontPaths: [FONT_PATH],
    bibPath: BIB_PATH,
    attributes: { 'bibtex-style': 'ieee' },
  };
}

function makeRequest(snapshot: ProjectSnapshot): RenderRequest {
  return { requestId: 'req-imm', mode: 'export', optimize: false, snapshot };
}

function makeVfs(): PipelineVfs {
  const store = new Map<string, Uint8Array>();
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
  };
}

/** A stable, byte-level snapshot of every VFS entry, for comparing two independent runs. */
function dumpVfs(vfs: PipelineVfs): Record<string, string> {
  const dump: Record<string, string> = {};
  for (const path of vfs.list('').toSorted()) {
    const bytes = vfs.readFile(path);
    dump[path] = bytes === null ? '' : [...bytes].join(',');
  }
  return dump;
}

function makeCache(): AssetCachePort {
  const cache = new GeneratedAssetCache();
  return {
    get: (hash) => cache.get(hash),
    has: (hash) => cache.has(hash),
    set: (asset) => cache.set(asset.sourceHash, asset),
  };
}

/** An assembler that inlines the chapter into the root — proving include inlining lands in the VFS. */
const inliningAssembler: IncludeAssembler = {
  assemble: (request) => {
    const root = request.readFile(request.rootPath) ?? '';
    const chapter = request.readFile(CHAPTER_PATH) ?? '';
    return { content: root.replace(INCLUDE_DIRECTIVE, chapter), unresolved: [] };
  },
};

const passThroughResolver: SandboxPathResolver = (_fromPath, target) => ({ ok: true, path: target });

function okShim(kind: RenderShim['kind'], name: string, render: (input: ShimInput) => ShimOutput): RenderShim {
  return { kind, name, version: '1.0.0', render: (input) => Promise.resolve(render(input)) };
}

/** A citations shim that echoes the document plus a reference list — a real VFS rewrite. */
const citationsShim = okShim('citations', 'citation-js', (input) => ({
  ok: true,
  asset: {
    format: 'svg',
    bytes: encoder.encode(`${input.source}\n\n${REFERENCE_MARKER}\n\n* Knuth 1984`),
    rasterFallback: false,
  },
}));

const diagramShim = okShim('diagram', 'mermaid', () => ({
  ok: true,
  asset: { format: 'svg', bytes: encoder.encode('<svg/>'), rasterFallback: false },
}));

const mathShim = okShim('math', 'mathjax', () => ({
  ok: true,
  asset: { format: 'svg', bytes: encoder.encode('<svg/>'), rasterFallback: false },
}));

function makeContext(snapshot: ProjectSnapshot, vfs: PipelineVfs): StageContext {
  const readFile: ProjectFileReader = (path) => snapshot.files[path] ?? null;
  return {
    request: makeRequest(snapshot),
    readFile,
    vfs,
    shims: createShimRegistry([citationsShim, diagramShim, mathShim]),
    includeAssembler: inliningAssembler,
    cache: makeCache(),
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
}

function allStages(): PipelineStage[] {
  return [
    createIncludeResolveStage({ resolveSandboxedPath: passThroughResolver }),
    createCitationsStage(),
    createDiagramsMathStage(),
    createImageGuardStage(),
    createMountAssetsStage({ fontConverter: { woff2ToTtf: async (bytes) => bytes } }),
  ];
}

/** Freeze the snapshot and each of its nested containers so any write attempt throws. */
function deepFreezeSnapshot(snapshot: ProjectSnapshot): void {
  Object.freeze(snapshot.files);
  Object.freeze(snapshot.binaryAssets);
  Object.freeze(snapshot.attributes);
  Object.freeze(snapshot.fontPaths);
  Object.freeze(snapshot);
}

describe('pipeline shared-content immutability', () => {
  it('rewrites include inlining, .gen assets, and citations into the VFS only, never the snapshot', async () => {
    const snapshot = makeSnapshot();
    const expected = structuredClone(snapshot);
    deepFreezeSnapshot(snapshot);

    const vfs = makeVfs();
    const context = makeContext(snapshot, vfs);

    const result = await runPipeline(allStages(), context);

    // The whole run completed: no fatal throw, no cancellation.
    expect(result.completed).toBe(true);
    expect(result.cancelled).toBe(false);

    // The input snapshot is structurally unchanged and still frozen.
    expect(snapshot).toEqual(expected);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.files)).toBe(true);
    expect(Object.isFrozen(snapshot.binaryAssets)).toBe(true);
    expect(Object.isFrozen(snapshot.attributes)).toBe(true);

    // The snapshot source is untouched: the raw directive/blocks remain in the ORIGINAL files.
    expect(snapshot.files[ROOT_PATH]).toContain(INCLUDE_DIRECTIVE);
    expect(snapshot.files[ROOT_PATH]).toContain('graph TD; A-->B;');
    expect(snapshot.files[ROOT_PATH]).toContain('cite:[knuth1984]');
    expect(snapshot.files[ROOT_PATH]).not.toContain('image::.gen/');

    // Every rewrite landed in the VFS instead.
    const rootInVfs = vfs.readText(ROOT_VFS_PATH) ?? '';
    expect(rootInVfs).toContain(CHAPTER_BODY.slice(0, 12)); // include inlined
    expect(rootInVfs).not.toContain(INCLUDE_DIRECTIVE);
    expect(rootInVfs).toContain(REFERENCE_MARKER); // citation rewrite
    expect(rootInVfs).toContain('image::.gen/'); // block diagram/math rewritten
    expect(rootInVfs).toContain('image:.gen/'); // inline math rewritten
    expect(rootInVfs).not.toContain('graph TD; A-->B;');

    const genAssets = vfs.list(GEN_PREFIX);
    expect(genAssets.length).toBeGreaterThanOrEqual(1); // .gen assets written to the VFS
    // The asset-mount stage decoded the custom WOFF2 font into the VFS (not the snapshot), under a
    // `.ttf` base name — prawn dispatches by extension, so the stale `.woff2` name is dropped.
    // (Theme + TTF/OTF fonts are mounted by populateProject, which runs before the pipeline.)
    expect(vfs.exists(DECODED_FONT_VFS_PATH)).toBe(true);
    expect(vfs.exists(FONT_VFS_PATH)).toBe(false);
  });

  it('re-runs against the same snapshot produce byte-identical VFS writes, so no mutation accumulates', async () => {
    // One frozen snapshot shared by two independent runs into two independent VFS instances. If any
    // stage smuggled state back into the snapshot, the second run would read a different input and
    // diverge; identical writes prove every rewrite went to the VFS and nothing accreted on the input.
    const snapshot = makeSnapshot();
    const expected = structuredClone(snapshot);
    deepFreezeSnapshot(snapshot);

    const firstVfs = makeVfs();
    const first = await runPipeline(allStages(), makeContext(snapshot, firstVfs));
    expect(first.completed).toBe(true);
    expect(first.cancelled).toBe(false);

    const secondVfs = makeVfs();
    const second = await runPipeline(allStages(), makeContext(snapshot, secondVfs));
    expect(second.completed).toBe(true);
    expect(second.cancelled).toBe(false);

    // The two runs wrote exactly the same files with exactly the same bytes.
    expect(dumpVfs(secondVfs)).toEqual(dumpVfs(firstVfs));
    // And the shared input is still deep-equal to its pre-run clone (and untouched) after both runs.
    expect(snapshot).toEqual(expected);
    expect(snapshot.files[ROOT_PATH]).toContain(INCLUDE_DIRECTIVE);
    expect(snapshot.files[ROOT_PATH]).toContain('cite:[knuth1984]');
  });
});
