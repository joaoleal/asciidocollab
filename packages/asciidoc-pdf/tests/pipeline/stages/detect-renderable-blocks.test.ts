import {
  createDiagramsMathStage,
  detectRenderableBlocks,
  type RenderableBlock,
} from '../../../src/pipeline/stages/diagrams-math';
import {
  cancellationToken,
  createDiagnosticsCollector,
  type AssetCachePort,
  type PipelineVfs,
  type StageContext,
} from '../../../src/pipeline/orchestrator';
import {
  createShimRegistry,
  type RenderShim,
  type ShimInput,
  type ShimOutput,
} from '../../../src/ports/shim';
import { GeneratedAssetCache, computeSourceHash } from '../../../src/cache/content-address';
import type { RenderRequest } from '../../../src/protocol';
import type { AssembledDocument, IncludeAssembler } from '../../../src/ports/include-assembler';

// ---------------------------------------------------------------------------
// The detector is the single source of truth for what the diagrams-math stage
// renders and hashes. These tests pin its contract directly, and — the crucial
// seam — prove that the `(source, params)` it reports for every block is
// byte-identical to what the stage feeds `computeSourceHash`, so the cache key
// can never drift between detection and rendering.
// ---------------------------------------------------------------------------

const ROOT_PATH = 'main.adoc';
const ROOT_VFS_PATH = `/project/${ROOT_PATH}`;
const GEN_PREFIX = '/project/.gen/';

const DIAGRAM_SHIM_VERSION = 'diagram-v1';
const MATH_SHIM_VERSION = 'math-v1';

function makeRequest(): RenderRequest {
  return {
    requestId: 'req-1',
    mode: 'export',
    optimize: false,
    snapshot: {
      files: {},
      binaryAssets: {},
      rootPath: ROOT_PATH,
      openPath: ROOT_PATH,
      fontPaths: [],
      attributes: {},
    },
  };
}

function makeVfs(): PipelineVfs {
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
  };
}

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

const enc = new TextEncoder();

function okSvg(): ShimOutput {
  return { ok: true, asset: { format: 'svg', bytes: enc.encode('svg'), rasterFallback: false } };
}

function fakeShim(kind: RenderShim['kind'], name: string, version: string): RenderShim {
  return {
    kind,
    name,
    version,
    render: (_input: ShimInput): Promise<ShimOutput> => Promise.resolve(okSvg()),
  };
}

interface ContextParts {
  ctx: StageContext;
  vfs: PipelineVfs;
}

function makeContext(document: string): ContextParts {
  const vfs = makeVfs();
  vfs.writeText(ROOT_VFS_PATH, document);
  const context: StageContext = {
    request: makeRequest(),
    readFile: () => vfs.readText(ROOT_VFS_PATH),
    vfs,
    shims: createShimRegistry([
      fakeShim('diagram', 'mermaid', DIAGRAM_SHIM_VERSION),
      fakeShim('math', 'mathjax', MATH_SHIM_VERSION),
    ]),
    includeAssembler: noopAssembler,
    cache: makeCache(),
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
  return { ctx: context, vfs };
}

/** A document covering every detectable shape plus the two that must be excluded. */
const REPRESENTATIVE_DOCUMENT = [
  '= Title',
  '',
  'A mermaid diagram with named and positional attributes:',
  '',
  '[mermaid,scale=2,frame]',
  '----',
  'graph TD; A-->B;',
  '----',
  '',
  'A stem math block:',
  '',
  '[stem]',
  '++++',
  'sqrt(4) = 2',
  '++++',
  '',
  String.raw`Inline stem:[x^2] and latexmath:[\alpha] on one line.`,
  '',
  'An unsupported engine that must be skipped, not detected:',
  '',
  '[plantuml]',
  '----',
  'Alice -> Bob',
  '----',
  '',
  'A verbatim listing whose inline math must stay literal:',
  '',
  '[source]',
  '----',
  'stem:[not_rendered] here',
  '----',
].join('\n');

/** Version the stage would key a record's asset under, given its family. */
function shimVersionFor(block: RenderableBlock): string {
  return block.category === 'diagram' ? DIAGRAM_SHIM_VERSION : MATH_SHIM_VERSION;
}

describe('detectRenderableBlocks', () => {
  it('returns block and inline renderables in document order, excluding unsupported and verbatim', () => {
    const blocks = detectRenderableBlocks(REPRESENTATIVE_DOCUMENT);

    expect(blocks.map((block) => [block.category, block.notation, block.kind])).toEqual([
      ['diagram', 'mermaid', 'block'],
      ['math', 'stem', 'block'],
      ['math', 'stem', 'inline'],
      ['math', 'latexmath', 'inline'],
    ]);
  });

  it('carries the verbatim block source and 1-based line for each record', () => {
    const blocks = detectRenderableBlocks(REPRESENTATIVE_DOCUMENT);

    const mermaid = blocks[0];
    expect(mermaid.source).toBe('graph TD; A-->B;');
    expect(mermaid.line).toBe(5); // the `[mermaid,...]` attribute line

    const stemBlock = blocks[1];
    expect(stemBlock.source).toBe('sqrt(4) = 2');

    const inlineStem = blocks[2];
    expect(inlineStem.source).toBe('x^2');
    expect(inlineStem.line).toBe(17);
  });

  it('builds params from named + positional attrs plus the synthetic notation param', () => {
    const [mermaid] = detectRenderableBlocks(REPRESENTATIVE_DOCUMENT);

    expect(mermaid.params).toEqual({
      scale: '2',
      pos2: 'frame',
      'asciidoc-block-notation': 'mermaid',
    });
  });

  it('gives an inline math record the notation param plus the inline (non-display) marker', () => {
    const inlineStem = detectRenderableBlocks(REPRESENTATIVE_DOCUMENT)[2];

    // Inline math must render at text size, so it carries the display=false marker; a block math/diagram
    // omits it and the shim defaults to display layout.
    expect(inlineStem.params).toEqual({
      'asciidoc-block-notation': 'stem',
      'asciidoc-math-display': 'false',
    });
  });

  it('does not detect plantuml/ditaa or inline math inside a verbatim listing', () => {
    const blocks = detectRenderableBlocks(REPRESENTATIVE_DOCUMENT);

    expect(blocks.some((block) => block.notation === 'plantuml')).toBe(false);
    expect(blocks.some((block) => block.source.includes('not_rendered'))).toBe(false);
  });

  it('reports a cache key byte-identical to the one the stage renders and hashes', async () => {
    const { ctx, vfs } = makeContext(REPRESENTATIVE_DOCUMENT);

    await createDiagramsMathStage().run(ctx);

    // Hashes the stage actually wrote to `.gen`, deduped by content address.
    const stageHashes = new Set(
      vfs.list(GEN_PREFIX).map((path) => path.slice(GEN_PREFIX.length, -'.svg'.length)),
    );

    // Hashes re-derived from the detector's (source, params) with the family's shim version.
    const detectorHashes = new Set(
      detectRenderableBlocks(REPRESENTATIVE_DOCUMENT).map((block) =>
        computeSourceHash({
          source: block.source,
          renderParams: block.params,
          shimVersion: shimVersionFor(block),
        }),
      ),
    );

    expect(detectorHashes).toEqual(stageHashes);
    expect(detectorHashes.size).toBe(4);
  });
});
