/**
 * @file The worker's diagram/math wiring: the `diagrams-math` stage runs over the worker's real shim
 * set, math and the graphviz/vega diagram engines render headlessly in-process, and pre-seeded assets
 * (produced by the main-thread pre-pass) resolve as cache hits so their DOM-bound shim is never invoked.
 *
 * These exercise the extracted composition helpers ({@link createDiagramsMathShims}, {@link seedGeneratedAssets})
 * the worker entry uses — the `*.worker.ts` entry itself runs in worker-global scope and the jest runtime
 * cannot load it, so the composition is verified through the helpers plus the real stage.
 *
 * Math renders through the REAL DOM-free MathJax converter (it works with no DOM), proving math typesets
 * in-process. The graphviz and vega engines are injected fakes because their real engines load WebAssembly
 * / a browser runtime that jest cannot drive; the stage's diagram path is exercised through those seams.
 */

import {
  cancellationToken,
  computeSourceHash,
  createDiagnosticsCollector,
  createDiagramsMathStage,
  createShimRegistry,
  type AssetCachePort,
  type GeneratedAsset,
  type IncludeAssembler,
  type PipelineVfs,
  type ProjectSnapshot,
  type RenderRequest,
  type StageContext,
} from '@asciidocollab/asciidoc-pdf';
import {
  createDiagramsMathShims,
  seedGeneratedAssets,
  type PdfRenderShimSeams,
} from '@/workers/diagrams-math-wiring';
import { createMermaidShim } from '@/workers/shims/mermaid';

// ---------------------------------------------------------------------------
// Fixture constants.
// ---------------------------------------------------------------------------

const ROOT_PATH = 'main.adoc';
const ROOT_VFS_PATH = `/project/${ROOT_PATH}`;
const GEN_DIR = '/project/.gen';
const BLOCK_NOTATION_PARAM = 'asciidoc-block-notation';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// In-memory fakes (mirrors the worker composition root's ports).
// ---------------------------------------------------------------------------

function createFakeVfs(): PipelineVfs {
  const files = new Map<string, Uint8Array>();
  return {
    writeFile: (path, bytes): void => void files.set(path, bytes),
    readFile: (path): Uint8Array | null => files.get(path) ?? null,
    writeText: (path, content): void => void files.set(path, encoder.encode(content)),
    readText: (path): string | null => {
      const bytes = files.get(path);
      return bytes === undefined ? null : decoder.decode(bytes);
    },
    exists: (path): boolean => files.has(path),
    remove: (path): void => void files.delete(path),
    list: (): readonly string[] => [...files.keys()],
  };
}

function createFakeCache(): AssetCachePort {
  const store = new Map<string, GeneratedAsset>();
  return {
    get: (sourceHash): GeneratedAsset | undefined => store.get(sourceHash),
    has: (sourceHash): boolean => store.has(sourceHash),
    set: (asset): void => void store.set(asset.sourceHash, asset),
  };
}

/** The diagrams-math stage never consults the include assembler; a no-op satisfies the context type. */
const NOOP_ASSEMBLER: IncludeAssembler = {
  assemble: () => ({ content: '', unresolved: [] }),
};

function createSnapshot(rootDocument: string): ProjectSnapshot {
  return {
    files: { [ROOT_PATH]: rootDocument },
    binaryAssets: {},
    rootPath: ROOT_PATH,
    openPath: ROOT_PATH,
    fontPaths: [],
    attributes: {},
  };
}

/**
 * Build a stage context wired exactly like the worker's `buildPipeline`: the worker's real shim set (with
 * optional injected engine seams), the pre-seed of `generatedAssets`, and the root document staged in the
 * VFS the way the upstream include-resolve stage would have.
 */
function createContext(
  rootDocument: string,
  options: { seams?: PdfRenderShimSeams; generatedAssets?: readonly GeneratedAsset[] } = {},
): { context: StageContext; cache: AssetCachePort; vfs: PipelineVfs } {
  const vfs = createFakeVfs();
  vfs.writeText(ROOT_VFS_PATH, rootDocument);
  const cache = createFakeCache();
  seedGeneratedAssets(cache, options.generatedAssets);
  const snapshot = createSnapshot(rootDocument);
  const request: RenderRequest = {
    requestId: 'render-1',
    mode: 'export',
    snapshot,
    optimize: true,
    ...(options.generatedAssets === undefined ? {} : { generatedAssets: options.generatedAssets }),
  };
  const context: StageContext = {
    request,
    readFile: (path): string | null => snapshot.files[path] ?? null,
    vfs,
    shims: createShimRegistry(createDiagramsMathShims(options.seams)),
    includeAssembler: NOOP_ASSEMBLER,
    cache,
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
  return { context, cache, vfs };
}

/** The rewritten root document after the stage has run. */
async function runStage(context: StageContext, vfs: PipelineVfs): Promise<string> {
  await createDiagramsMathStage().run(context);
  const rewritten = vfs.readText(ROOT_VFS_PATH);
  if (rewritten === null) {
    throw new Error('root document missing from VFS after the stage ran');
  }
  return rewritten;
}

/** The single `.gen/<hash>.<ext>` filename an `image::`/`image:` line points at. */
function genFilenameOf(rewritten: string): string {
  const match = rewritten.match(/image::?\.gen\/([^[\]]+)\[/);
  if (match === null) {
    throw new Error(`no generated image reference in:\n${rewritten}`);
  }
  return match[1];
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('worker diagram/math wiring', () => {
  it('typesets a stem math block to an in-process SVG asset via the DOM-free MathJax shim', async () => {
    const rootDocument = ['= Doc', '', '[stem]', '++++', 'sqrt(x)', '++++', ''].join('\n');
    const { context, vfs } = createContext(rootDocument);

    const rewritten = await runStage(context, vfs);

    // The block was rewritten to a generated image reference, and its bytes are a real SVG document —
    // proof MathJax typeset it inside this (DOM-free) process.
    const filename = genFilenameOf(rewritten);
    expect(filename.endsWith('.svg')).toBe(true);
    const bytes = vfs.readFile(`${GEN_DIR}/${filename}`);
    expect(bytes).not.toBeNull();
    const svg = decoder.decode(bytes ?? new Uint8Array());
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    expect(rewritten).not.toContain('[stem]');
  });

  it('renders a graphviz block to an in-process image asset (diagram family runs headless)', async () => {
    const svgMarkup = '<svg data-engine="graphviz"><text>a</text></svg>';
    const rootDocument = ['= Doc', '', '[graphviz]', '....', 'digraph { a -> b }', '....', ''].join('\n');
    const { context, vfs } = createContext(rootDocument, {
      seams: { graphvizRenderer: () => Promise.resolve(svgMarkup) },
    });

    const rewritten = await runStage(context, vfs);

    const filename = genFilenameOf(rewritten);
    const bytes = vfs.readFile(`${GEN_DIR}/${filename}`);
    expect(decoder.decode(bytes ?? new Uint8Array())).toBe(svgMarkup);
    expect(rewritten).not.toContain('[graphviz]');
  });

  it('renders a vega block to an in-process image asset (diagram family runs headless)', async () => {
    const svgMarkup = '<svg data-engine="vega"></svg>';
    const spec = '{ "$schema": "https://vega.github.io/schema/vega/v5.json", "marks": [] }';
    const rootDocument = ['= Doc', '', '[vega]', '----', spec, '----', ''].join('\n');
    const { context, vfs } = createContext(rootDocument, {
      seams: {
        vegaEngine: {
          compileVegaLite: (s) => Promise.resolve(s),
          renderToSvg: () => Promise.resolve(svgMarkup),
        },
      },
    });

    const rewritten = await runStage(context, vfs);

    const filename = genFilenameOf(rewritten);
    const bytes = vfs.readFile(`${GEN_DIR}/${filename}`);
    expect(decoder.decode(bytes ?? new Uint8Array())).toBe(svgMarkup);
    expect(rewritten).not.toContain('[vega]');
  });

  it('serves a pre-seeded mermaid block from cache without ever invoking the mermaid shim', async () => {
    const source = 'graph TD; A-->B';
    const rootDocument = ['= Doc', '', '[mermaid]', '----', source, '----', ''].join('\n');

    // Content-address the block exactly as the stage will, so the pre-seeded asset is a guaranteed hit.
    const sourceHash = computeSourceHash({
      source,
      renderParams: { [BLOCK_NOTATION_PARAM]: 'mermaid' },
      shimVersion: createMermaidShim().version,
    });
    const seededBytes = encoder.encode('<svg data-engine="mermaid-preseeded"></svg>');
    const preseeded: GeneratedAsset = {
      sourceHash,
      kind: 'diagram',
      format: 'svg',
      bytes: seededBytes,
      rasterFallback: false,
      altText: '',
    };

    // A mermaid engine seam that fails loudly if the worker ever calls it — a cache hit must bypass it.
    const mermaidRenderer = jest.fn(() =>
      Promise.reject(new Error('mermaid shim must not run in the worker for a pre-seeded block')),
    );
    const { context, vfs } = createContext(rootDocument, {
      seams: { mermaidRenderer },
      generatedAssets: [preseeded],
    });

    const rewritten = await runStage(context, vfs);

    // The block became a generated image reference pointing at the pre-seeded bytes...
    const filename = genFilenameOf(rewritten);
    expect(filename).toBe(`${sourceHash}.svg`);
    expect(vfs.readFile(`${GEN_DIR}/${filename}`)).toEqual(seededBytes);
    expect(rewritten).not.toContain('[mermaid]');
    // ...and the mermaid engine was never invoked.
    expect(mermaidRenderer).not.toHaveBeenCalled();
  });

  it('renders a request that carries no pre-seeded assets (generatedAssets is optional)', async () => {
    const rootDocument = ['= Doc', '', '[stem]', '++++', 'a+b', '++++', ''].join('\n');
    const { context, vfs } = createContext(rootDocument, { generatedAssets: undefined });

    const rewritten = await runStage(context, vfs);

    const filename = genFilenameOf(rewritten);
    expect(vfs.readFile(`${GEN_DIR}/${filename}`)).not.toBeNull();
    expect(rewritten).not.toContain('[stem]');
  });
});
