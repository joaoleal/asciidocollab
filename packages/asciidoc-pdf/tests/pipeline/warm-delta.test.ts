/**
 * Warm re-render delta path: a re-render on a live VM must rewrite ONLY the files that actually
 * changed under `/project`, and re-render ONLY the generated assets whose block source actually
 * changed. Stable diagram/math blocks resolve to the same content-address, hit the persistent
 * generated-asset cache, and are reused without re-invoking the (spied) shim — while a changed block
 * produces a new content-address, misses the cache, and is re-rendered into a fresh `.gen` asset. The
 * full (non-delta) render path stays unchanged: every file is written and every block is processed.
 *
 * The delta flow spans two collaborators that persist across warm re-renders — the VFS population
 * (`populateProject`, delta-aware via `changedPaths`) and the content-addressed generated-asset cache
 * consumed by the diagrams-math stage. Both are exercised over a single shared in-memory store so the
 * cross-render reuse is observed for real, not re-implemented.
 */

import {
  populateProject,
  type PopulateResult,
  type VfsWritePort,
} from '../../src/vfs/populate';
import { createDiagramsMathStage } from '../../src/pipeline/stages/diagrams-math';
import {
  cancellationToken,
  createDiagnosticsCollector,
  type AssetCachePort,
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
import type { ProjectSnapshot, RenderRequest } from '../../src/protocol';
import type { AssembledDocument, IncludeAssembler } from '../../src/ports/include-assembler';

// ---------------------------------------------------------------------------
// A single in-memory store exposed through BOTH the population write port and
// the pipeline VFS surface, so populate() and the stage read/write the same
// bytes across two simulated warm re-renders.
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project';
const GEN_PREFIX = `${PROJECT_ROOT}/.gen/`;
const ROOT_KEY = 'main.adoc';
const CHAPTER_KEY = 'chapter.adoc';
const ROOT_VFS_PATH = `${PROJECT_ROOT}/${ROOT_KEY}`;
const CHAPTER_VFS_PATH = `${PROJECT_ROOT}/${CHAPTER_KEY}`;

interface DualStore {
  readonly raw: Map<string, Uint8Array>;
  readonly writePort: VfsWritePort;
  readonly vfs: PipelineVfs;
}

function makeStore(): DualStore {
  const raw = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const existsWithPrefix = (path: string): boolean => {
    if (raw.has(path)) {
      return true;
    }
    const prefix = `${path}/`;
    for (const key of raw.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  };

  const writePort: VfsWritePort = {
    writeFile: (path, data) => void raw.set(path, data),
    readFile: (path) => {
      const data = raw.get(path);
      if (data === undefined) {
        throw new Error(`No file at ${path}`);
      }
      return data;
    },
    readdir: (path) => {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of raw.keys()) {
        if (key.startsWith(prefix)) {
          const head = key.slice(prefix.length).split('/')[0];
          if (head !== undefined && head.length > 0) {
            names.add(head);
          }
        }
      }
      return [...names];
    },
    removeFile: (path) => void raw.delete(path),
    exists: existsWithPrefix,
  };

  const vfs: PipelineVfs = {
    writeFile: (path, bytes) => void raw.set(path, bytes),
    readFile: (path) => raw.get(path) ?? null,
    writeText: (path, content) => void raw.set(path, enc.encode(content)),
    readText: (path) => {
      const bytes = raw.get(path);
      return bytes === undefined ? null : dec.decode(bytes);
    },
    exists: (path) => raw.has(path),
    remove: (path) => void raw.delete(path),
    list: (prefix) => [...raw.keys()].filter((key) => key.startsWith(prefix)),
  };

  return { raw, writePort, vfs };
}

/** The real content-addressed store, adapted to the port so hashing/determinism is exercised for real. */
function makeCache(): AssetCachePort {
  const cache = new GeneratedAssetCache();
  return {
    get: (hash) => cache.get(hash),
    has: (hash) => cache.has(hash),
    set: (asset) => cache.set(asset.sourceHash, asset),
  };
}

const noopAssembler: IncludeAssembler = {
  assemble: (request): AssembledDocument => ({
    content: request.readFile(request.rootPath) ?? '',
    unresolved: [],
  }),
};

function makeSnapshot(files: Record<string, string>): ProjectSnapshot {
  return {
    files,
    binaryAssets: {},
    rootPath: ROOT_KEY,
    openPath: ROOT_KEY,
    fontPaths: [],
    attributes: {},
  };
}

type RenderMock = jest.Mock<Promise<ShimOutput>, [ShimInput]>;

const enc = new TextEncoder();

function okSvg(bytes = 'svg-bytes'): ShimOutput {
  return { ok: true, asset: { format: 'svg', bytes: enc.encode(bytes), rasterFallback: false } };
}

function mermaidShim(render: RenderMock): RenderShim {
  return { kind: 'diagram', name: 'mermaid', version: '1.0.0', render };
}

/** Run the diagrams-math stage against the shared store + persistent cache for one warm re-render. */
async function runDiagrams(
  store: DualStore,
  cache: AssetCachePort,
  snapshot: ProjectSnapshot,
  shim: RenderShim,
): Promise<void> {
  const request: RenderRequest = {
    requestId: 'req',
    mode: 'preview',
    optimize: false,
    snapshot,
  };
  const context: StageContext = {
    request,
    readFile: (path) => store.vfs.readText(`${PROJECT_ROOT}/${path}`),
    vfs: store.vfs,
    shims: createShimRegistry([shim]),
    includeAssembler: noopAssembler,
    cache,
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
  await createDiagramsMathStage().run(context);
}

const dec = new TextDecoder();
function readText(store: DualStore, path: string): string {
  const bytes = store.raw.get(path);
  return bytes === undefined ? '' : dec.decode(bytes);
}

const mermaidDocument = (graph: string, prose: string): string =>
  [prose, '', '[mermaid]', '----', graph, '----'].join('\n');

const GRAPH_A = 'graph TD; A-->B;';
const GRAPH_B = 'graph TD; A-->C;';

describe('warm re-render delta path', () => {
  it('rewrites ONLY the changed paths under /project and leaves untouched files byte-identical', () => {
    const store = makeStore();
    populateProject(store.writePort, makeSnapshot({ [ROOT_KEY]: '= V1', [CHAPTER_KEY]: 'chapter v1' }));

    // Capture the untouched file's backing bytes before the warm re-render.
    const chapterReferenceBefore = store.raw.get(CHAPTER_VFS_PATH);
    expect(chapterReferenceBefore).toBeDefined();

    const result: PopulateResult = populateProject(
      store.writePort,
      makeSnapshot({ [ROOT_KEY]: '= V2', [CHAPTER_KEY]: 'chapter v1' }),
      { changedPaths: [ROOT_KEY] },
    );

    // Only the changed root was rewritten; the untouched chapter keeps its exact backing array.
    expect(result.written).toEqual([ROOT_VFS_PATH]);
    expect(readText(store, ROOT_VFS_PATH)).toBe('= V2');
    expect(store.raw.get(CHAPTER_VFS_PATH)).toBe(chapterReferenceBefore);
    expect(readText(store, CHAPTER_VFS_PATH)).toBe('chapter v1');
    expect(result.rootPresent).toBe(true);
  });

  it('reuses a stable diagram from the cache on a warm re-render — no shim re-invocation', async () => {
    const store = makeStore();
    const cache = makeCache();
    const render = jest.fn<Promise<ShimOutput>, [ShimInput]>(async () => okSvg());
    const shim = mermaidShim(render);

    // Cold render: populate everything, render the diagram once.
    populateProject(store.writePort, makeSnapshot({ [ROOT_KEY]: mermaidDocument(GRAPH_A, 'Intro') }));
    await runDiagrams(store, cache, makeSnapshot({ [ROOT_KEY]: mermaidDocument(GRAPH_A, 'Intro') }), shim);

    expect(render).toHaveBeenCalledTimes(1);
    const genAfterCold = store.vfs.list(GEN_PREFIX);
    expect(genAfterCold).toHaveLength(1);

    // Warm re-render: the SAME diagram, only the surrounding prose edited. Delta populate resets the
    // root document to fresh source (block re-detected), but the identical block source content-
    // addresses to the same cache key, so the shim is NOT called again.
    const edited = mermaidDocument(GRAPH_A, 'Intro edited');
    populateProject(store.writePort, makeSnapshot({ [ROOT_KEY]: edited }), { changedPaths: [ROOT_KEY] });
    await runDiagrams(store, cache, makeSnapshot({ [ROOT_KEY]: edited }), shim);

    expect(render).toHaveBeenCalledTimes(1); // served from cache, not re-rendered
    // The stable asset is unchanged and still the only generated asset.
    expect(store.vfs.list(GEN_PREFIX)).toEqual(genAfterCold);
    // The edited prose survived and the block was re-rewritten to the same image reference.
    const rewritten = readText(store, ROOT_VFS_PATH);
    expect(rewritten).toContain('Intro edited');
    const hash = genAfterCold[0].slice(GEN_PREFIX.length, -'.svg'.length);
    expect(rewritten).toContain(`image::.gen/${hash}.svg["mermaid diagram"]`);
  });

  it('re-renders a changed diagram block on a warm re-render — cache miss, new .gen asset', async () => {
    const store = makeStore();
    const cache = makeCache();
    const render = jest.fn<Promise<ShimOutput>, [ShimInput]>(async () => okSvg());
    const shim = mermaidShim(render);

    populateProject(store.writePort, makeSnapshot({ [ROOT_KEY]: mermaidDocument(GRAPH_A, 'Intro') }));
    await runDiagrams(store, cache, makeSnapshot({ [ROOT_KEY]: mermaidDocument(GRAPH_A, 'Intro') }), shim);

    expect(render).toHaveBeenCalledTimes(1);
    const genAfterCold = store.vfs.list(GEN_PREFIX);
    expect(genAfterCold).toHaveLength(1);

    // Warm re-render: the diagram SOURCE changed → new content-address → cache miss → re-render.
    const changed = mermaidDocument(GRAPH_B, 'Intro');
    populateProject(store.writePort, makeSnapshot({ [ROOT_KEY]: changed }), { changedPaths: [ROOT_KEY] });
    await runDiagrams(store, cache, makeSnapshot({ [ROOT_KEY]: changed }), shim);

    expect(render).toHaveBeenCalledTimes(2); // the changed block was re-rendered
    const genAfterWarm = store.vfs.list(GEN_PREFIX);
    const newAssets = genAfterWarm.filter((path) => !genAfterCold.includes(path));
    expect(newAssets).toHaveLength(1); // a fresh, distinctly-addressed asset was written
    expect(render.mock.calls[1][0].source).toBe(GRAPH_B);
  });

  it('full (non-delta) render still writes every file and processes every block', async () => {
    const store = makeStore();
    const cache = makeCache();
    const render = jest.fn<Promise<ShimOutput>, [ShimInput]>(async () => okSvg());
    const shim = mermaidShim(render);

    const snapshot = makeSnapshot({
      [ROOT_KEY]: mermaidDocument(GRAPH_A, 'Intro'),
      [CHAPTER_KEY]: 'chapter body',
    });
    const populated = populateProject(store.writePort, snapshot); // no changedPaths → full write
    expect(populated.written).toEqual(
      expect.arrayContaining([ROOT_VFS_PATH, CHAPTER_VFS_PATH]),
    );
    expect(populated.written).toHaveLength(2);

    await runDiagrams(store, cache, snapshot, shim);

    expect(render).toHaveBeenCalledTimes(1);
    expect(store.vfs.list(GEN_PREFIX)).toHaveLength(1);
    expect(readText(store, CHAPTER_VFS_PATH)).toBe('chapter body');
  });
});
