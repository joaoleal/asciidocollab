import { createDiagramsMathStage } from '../../../src/pipeline/stages/diagrams-math';
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
import { GeneratedAssetCache } from '../../../src/cache/content-address';
import type { RenderRequest } from '../../../src/protocol';
import type { AssembledDocument, IncludeAssembler } from '../../../src/ports/include-assembler';

// ---------------------------------------------------------------------------
// One document mixing four block outcomes, driven through the same in-memory
// harness as the other stage tests, to prove the stage is fail-soft as a whole:
// a valid block renders, and every failing block records its own located
// diagnostic without aborting the export.
// ---------------------------------------------------------------------------

const ROOT_PATH = 'main.adoc';
const ROOT_VFS_PATH = `/project/${ROOT_PATH}`;
const GEN_PREFIX = '/project/.gen/';

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

type RenderMock = jest.Mock<Promise<ShimOutput>, [ShimInput]>;

function renderMock(impl: (input: ShimInput) => Promise<ShimOutput>): RenderMock {
  return jest.fn<Promise<ShimOutput>, [ShimInput]>(impl);
}

function fakeShim(kind: RenderShim['kind'], name: string, render: RenderMock): RenderShim {
  return { kind, name, version: '1.0.0', render };
}

const enc = new TextEncoder();

function okSvg(bytes = 'svg-bytes'): ShimOutput {
  return { ok: true, asset: { format: 'svg', bytes: enc.encode(bytes), rasterFallback: false } };
}

function okPngRaster(bytes = 'png-bytes'): ShimOutput {
  return { ok: true, asset: { format: 'png', bytes: enc.encode(bytes), rasterFallback: true } };
}

interface ContextParts {
  ctx: StageContext;
  vfs: PipelineVfs;
}

function makeContext(document: string, shims: readonly RenderShim[]): ContextParts {
  const vfs = makeVfs();
  vfs.writeText(ROOT_VFS_PATH, document);
  const context: StageContext = {
    request: makeRequest(),
    readFile: () => vfs.readText(ROOT_VFS_PATH),
    vfs,
    shims: createShimRegistry(shims),
    includeAssembler: noopAssembler,
    cache: makeCache(),
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
  return { ctx: context, vfs };
}

// Source markers the single mermaid shim branches on, so one document can drive
// four distinct outcomes from one injected renderer.
const VALID_SOURCE = 'graph TD; A-->B;';
const MALFORMED_SOURCE = '@@ not a graph @@';
const RASTER_SOURCE = 'graph LR; usesVectorFeature';

/** A mermaid shim that renders the valid block, rejects the malformed one, and rasterizes the third. */
function mixedOutcomeShim(): { shim: RenderShim; render: RenderMock } {
  const render = renderMock(async (input) => {
    if (input.source === MALFORMED_SOURCE) {
      return { ok: false, diagnostic: { code: 'malformed-diagram', message: 'unparseable diagram source' } };
    }
    if (input.source === RASTER_SOURCE) {
      return okPngRaster();
    }
    return okSvg();
  });
  return { shim: fakeShim('diagram', 'mermaid', render), render };
}

/**
 * A document mixing, in order and on known lines:
 *   line 1  — a valid mermaid block (renders to an image::),
 *   line 6  — a malformed mermaid block (shim rejects → malformed-diagram),
 *   line 11 — an unsupported-offline PlantUML block (diagram-unsupported, skipped),
 *   line 16 — a mermaid block whose render rasterizes to PNG (unsupported-image warning).
 */
function mixedFailureDocument(): string {
  return [
    '[mermaid]', // 1
    '----', // 2
    VALID_SOURCE, // 3
    '----', // 4
    '', // 5
    '[mermaid]', // 6
    '----', // 7
    MALFORMED_SOURCE, // 8
    '----', // 9
    '', // 10
    '[plantuml]', // 11
    '----', // 12
    'Alice -> Bob', // 13
    '----', // 14
    '', // 15
    '[mermaid]', // 16
    '----', // 17
    RASTER_SOURCE, // 18
    '----', // 19
  ].join('\n');
}

const VALID_LINE = 1;
const MALFORMED_LINE = 6;
const UNSUPPORTED_LINE = 11;
const RASTER_LINE = 16;

describe('createDiagramsMathStage fail-soft across mixed block failures', () => {
  it('exports successfully while each failing block records its own located diagnostic', async () => {
    const { shim, render } = mixedOutcomeShim();
    const { ctx, vfs } = makeContext(mixedFailureDocument(), [shim]);

    // The export completes; a mix of failing blocks never aborts the whole stage.
    await expect(createDiagramsMathStage().run(ctx)).resolves.toBeDefined();

    const rewritten = vfs.readText(ROOT_VFS_PATH) ?? '';
    const diags = ctx.diagnostics.all();

    // The valid block became an image:: reference and its source is gone.
    expect(rewritten).toContain('image::.gen/');
    expect(rewritten).not.toContain(VALID_SOURCE);

    // The three failing blocks are left in place untouched (fail-soft).
    expect(rewritten).toContain(MALFORMED_SOURCE);
    expect(rewritten).toContain('Alice -> Bob');

    // The unsupported PlantUML block is skipped without ever calling the shim.
    const renderedSources = render.mock.calls.map((call) => call[0].source);
    expect(renderedSources).not.toContain('Alice -> Bob');

    // A distinct located diagnostic per failing block, at its own line + code.
    const malformed = diags.find((d) => d.code === 'malformed-diagram');
    expect(malformed).toBeDefined();
    expect(malformed?.location?.path).toBe(ROOT_PATH);
    expect(malformed?.location?.line).toBe(MALFORMED_LINE);

    const unsupported = diags.find((d) => d.code === 'diagram-unsupported');
    expect(unsupported).toBeDefined();
    expect(unsupported?.severity).toBe('warning');
    expect(unsupported?.location?.path).toBe(ROOT_PATH);
    expect(unsupported?.location?.line).toBe(UNSUPPORTED_LINE);
    expect(unsupported?.message).toMatch(/mermaid/i);

    // The raster-fallback block still renders (to PNG) but is warned about.
    const raster = diags.find((d) => d.code === 'unsupported-image');
    expect(raster).toBeDefined();
    expect(raster?.severity).toBe('warning');
    expect(raster?.location?.path).toBe(ROOT_PATH);
    expect(raster?.location?.line).toBe(RASTER_LINE);

    // The four diagnostics are located at four distinct lines — none collapsed together.
    const failingLines = [malformed, unsupported, raster].map((d) => d?.location?.line);
    expect(new Set(failingLines).size).toBe(failingLines.length);
    expect(failingLines).not.toContain(VALID_LINE);

    // Nothing beyond these three failing-block diagnostics was reported.
    expect(diags).toHaveLength(3);

    // Both successfully rendered blocks (the valid SVG and the rasterized PNG) were written.
    const gen = vfs.list(GEN_PREFIX);
    expect(gen.some((path) => path.endsWith('.svg'))).toBe(true);
    expect(gen.some((path) => path.endsWith('.png'))).toBe(true);
  });
});
