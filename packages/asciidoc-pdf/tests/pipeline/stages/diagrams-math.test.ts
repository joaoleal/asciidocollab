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
// In-memory fakes for every injected seam the stage touches. The stage is pure
// w.r.t. these, so an in-process fake context fully exercises detection,
// rendering, caching, and the `.gen`/`image::` rewrite.
// ---------------------------------------------------------------------------

const ROOT_PATH = 'main.adoc';
const ROOT_VFS_PATH = `/project/${ROOT_PATH}`;
const GEN_PREFIX = '/project/.gen/';

function makeRequest(overrides: Partial<RenderRequest> = {}): RenderRequest {
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
    ...overrides,
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
  // Adapt the real content-addressed store to the `set(asset)` port so the test
  // exercises real hashing/determinism, not a re-implementation.
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

/** A jest mock matching a shim's render signature, so calls (and cache-skips) can be asserted. */
type RenderMock = jest.Mock<Promise<ShimOutput>, [ShimInput]>;

function renderMock(impl: (input: ShimInput) => Promise<ShimOutput>): RenderMock {
  return jest.fn<Promise<ShimOutput>, [ShimInput]>(impl);
}

/** A shim whose render is a jest mock so calls (and cache-skips) can be asserted. */
function fakeShim(
  kind: RenderShim['kind'],
  name: string,
  render: RenderMock,
  version = '1.0.0',
): RenderShim {
  return { kind, name, version, render };
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

/** Like {@link makeContext} but roots the document at an arbitrary project-relative path. */
function makeContextWithRoot(
  rootPath: string,
  document: string,
  shims: readonly RenderShim[],
): ContextParts {
  const vfs = makeVfs();
  const rootVfsPath = `/project/${rootPath}`;
  vfs.writeText(rootVfsPath, document);
  const base = makeRequest();
  const context: StageContext = {
    request: { ...base, snapshot: { ...base.snapshot, rootPath, openPath: rootPath } },
    readFile: () => vfs.readText(rootVfsPath),
    vfs,
    shims: createShimRegistry(shims),
    includeAssembler: noopAssembler,
    cache: makeCache(),
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
  return { ctx: context, vfs };
}

const MERMAID_BLOCK = ['[mermaid]', '----', 'graph TD; A-->B;', '----'].join('\n');

describe('createDiagramsMathStage', () => {
  it('detects a diagram block, renders it, writes to .gen, and rewrites to image::', async () => {
    const render = renderMock(async() => okSvg());
    const { ctx, vfs } = makeContext(`Intro\n\n${MERMAID_BLOCK}\n\nOutro`, [
      fakeShim('diagram', 'mermaid', render),
    ]);

    await createDiagramsMathStage().run(ctx);

    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0].source).toBe('graph TD; A-->B;');
    expect(render.mock.calls[0][0].preferredFormat).toBe('svg');

    const gen = vfs.list(GEN_PREFIX);
    expect(gen).toHaveLength(1);
    expect(gen[0]).toMatch(/^\/project\/\.gen\/[0-9a-f]{16}\.svg$/);

    const rewritten = vfs.readText(ROOT_VFS_PATH) ?? '';
    const hash = gen[0].slice(GEN_PREFIX.length, -'.svg'.length);
    expect(rewritten).toContain(`image::.gen/${hash}.svg["mermaid diagram"]`);
    expect(rewritten).not.toContain('graph TD');
    expect(rewritten).toContain('Intro');
    expect(rewritten).toContain('Outro');
    expect(ctx.diagnostics.all()).toHaveLength(0);
  });

  it('selects the diagram shim by engine name (graphviz)', async () => {
    const mermaid = renderMock(async() => okSvg('mermaid'));
    const graphviz = renderMock(async() => okSvg('graphviz'));
    const block = ['[graphviz]', '....', 'digraph { a -> b }', '....'].join('\n');
    const { ctx } = makeContext(block, [
      fakeShim('diagram', 'mermaid', mermaid),
      fakeShim('diagram', 'graphviz', graphviz),
    ]);

    await createDiagramsMathStage().run(ctx);

    expect(graphviz).toHaveBeenCalledTimes(1);
    expect(mermaid).not.toHaveBeenCalled();
  });

  it('reuses the cache for an identical block: renders once, same .gen filename twice', async () => {
    const render = renderMock(async() => okSvg());
    const document = `${MERMAID_BLOCK}\n\nmiddle\n\n${MERMAID_BLOCK}`;
    const { ctx, vfs } = makeContext(document, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    expect(render).toHaveBeenCalledTimes(1);
    const gen = vfs.list(GEN_PREFIX);
    expect(gen).toHaveLength(1); // identical source ⇒ one stable file
    const hash = gen[0].slice(GEN_PREFIX.length, -'.svg'.length);
    const rewritten = vfs.readText(ROOT_VFS_PATH) ?? '';
    const references =
      rewritten.match(new RegExp(String.raw`image::\.gen/${hash}\.svg\["mermaid diagram"\]`, 'g')) ?? [];
    expect(references).toHaveLength(2); // both occurrences point at the same asset
  });

  it('records a non-error diagnostic and writes .png when a shim raster-falls-back', async () => {
    const render = renderMock(async() => okPngRaster());
    const { ctx, vfs } = makeContext(MERMAID_BLOCK, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    const diags = ctx.diagnostics.all();
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
    const gen = vfs.list(GEN_PREFIX);
    expect(gen[0]).toMatch(/\.png$/);
    const hash = gen[0].slice(GEN_PREFIX.length, -'.png'.length);
    expect(vfs.readText(ROOT_VFS_PATH) ?? '').toContain(`image::.gen/${hash}.png["mermaid diagram"]`);
  });

  it('emits malformed-diagram and leaves the block unchanged when the shim returns {ok:false}', async () => {
    const render = renderMock(async () => ({
      ok: false,
      diagnostic: { code: 'malformed-diagram', message: 'bad graph' },
    }));
    const { ctx, vfs } = makeContext(MERMAID_BLOCK, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    const diags = ctx.diagnostics.all();
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe('malformed-diagram');
    expect(vfs.list(GEN_PREFIX)).toHaveLength(0);
    expect(vfs.readText(ROOT_VFS_PATH) ?? '').toContain('graph TD; A-->B;');
  });

  it('warns diagram-unsupported for PlantUML/ditaa and never calls a shim', async () => {
    const render = renderMock(async() => okSvg());
    const block = ['[plantuml]', '----', 'Alice -> Bob', '----'].join('\n');
    const { ctx, vfs } = makeContext(block, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    const diags = ctx.diagnostics.all();
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe('diagram-unsupported');
    expect(diags[0].severity).toBe('warning');
    expect(render).not.toHaveBeenCalled();
    expect(vfs.readText(ROOT_VFS_PATH) ?? '').toContain('Alice -> Bob');
  });

  it('renders a stem math block via the math shim and rewrites to image::', async () => {
    const render = renderMock(async() => okSvg('math'));
    const block = ['[stem]', '++++', 'sqrt(4) = 2', '++++'].join('\n');
    const { ctx, vfs } = makeContext(block, [fakeShim('math', 'mathjax', render)]);

    await createDiagramsMathStage().run(ctx);

    expect(render).toHaveBeenCalledTimes(1);
    const gen = vfs.list(GEN_PREFIX);
    expect(gen).toHaveLength(1);
    const hash = gen[0].slice(GEN_PREFIX.length, -'.svg'.length);
    expect(vfs.readText(ROOT_VFS_PATH) ?? '').toContain(`image::.gen/${hash}.svg["sqrt(4) = 2",align=center]`);
  });

  it('distinguishes latexmath from asciimath with identical source (different assets)', async () => {
    const render = renderMock(async() => okSvg('m'));
    const document = [
      '[latexmath]',
      '++++',
      'x',
      '++++',
      '',
      '[asciimath]',
      '++++',
      'x',
      '++++',
    ].join('\n');
    const { ctx, vfs } = makeContext(document, [fakeShim('math', 'mathjax', render)]);

    await createDiagramsMathStage().run(ctx);

    expect(render).toHaveBeenCalledTimes(2);
    expect(vfs.list(GEN_PREFIX)).toHaveLength(2); // notation participates in the hash
  });

  it('rewrites inline math to an inline image macro', async () => {
    const render = renderMock(async() => okSvg('inline'));
    const document = 'The value stem:[x^2] is shown.';
    const { ctx, vfs } = makeContext(document, [fakeShim('math', 'mathjax', render)]);

    await createDiagramsMathStage().run(ctx);

    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0].source).toBe('x^2');
    const gen = vfs.list(GEN_PREFIX);
    const hash = gen[0].slice(GEN_PREFIX.length, -'.svg'.length);
    const rewritten = vfs.readText(ROOT_VFS_PATH) ?? '';
    expect(rewritten).toBe(`The value image:.gen/${hash}.svg["x^2"] is shown.`);
  });

  it('leaves inline math inside a verbatim listing block untouched', async () => {
    const render = renderMock(async() => okSvg());
    const document = ['[source]', '----', 'stem:[x] literal', '----'].join('\n');
    const { ctx, vfs } = makeContext(document, [fakeShim('math', 'mathjax', render)]);

    await createDiagramsMathStage().run(ctx);

    expect(render).not.toHaveBeenCalled();
    expect(vfs.readText(ROOT_VFS_PATH) ?? '').toContain('stem:[x] literal');
  });

  it('produces a deterministic filename for identical source across separate runs', async () => {
    const first = makeContext(MERMAID_BLOCK, [fakeShim('diagram', 'mermaid', renderMock(async() => okSvg()))]);
    const second = makeContext(MERMAID_BLOCK, [fakeShim('diagram', 'mermaid', renderMock(async() => okSvg()))]);

    await createDiagramsMathStage().run(first.ctx);
    await createDiagramsMathStage().run(second.ctx);

    expect(first.vfs.list(GEN_PREFIX)).toEqual(second.vfs.list(GEN_PREFIX));
  });

  it('is a no-op with no diagnostics when the document has no diagram/math', async () => {
    const render = renderMock(async() => okSvg());
    const document = '= Title\n\nJust prose, no blocks.';
    const { ctx, vfs } = makeContext(document, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    expect(render).not.toHaveBeenCalled();
    expect(vfs.readText(ROOT_VFS_PATH)).toBe(document);
    expect(ctx.diagnostics.all()).toHaveLength(0);
  });

  it('references .gen relative to the project root for a root document in a subfolder', async () => {
    // The convert pins base_dir to the project mount root and resolves image targets against it, so a
    // `../`-prefixed reference from a subfolder root would escape to `/.gen/...` and the asset written
    // under /project/.gen would fail to embed ("image to embed not found or not readable").
    const render = renderMock(async () => okSvg());
    const rootPath = 'New Folder/new-document-2.adoc';
    const { ctx, vfs } = makeContextWithRoot(rootPath, `Intro\n\n${MERMAID_BLOCK}`, [
      fakeShim('diagram', 'mermaid', render),
    ]);

    await createDiagramsMathStage().run(ctx);

    const gen = vfs.list(GEN_PREFIX);
    expect(gen).toHaveLength(1);
    expect(gen[0]).toMatch(/^\/project\/\.gen\/[0-9a-f]{16}\.svg$/); // asset lives at the project root
    const hash = gen[0].slice(GEN_PREFIX.length, -'.svg'.length);
    const rewritten = vfs.readText(`/project/${rootPath}`) ?? '';
    expect(rewritten).toContain(`image::.gen/${hash}.svg`); // project-root-relative, never ../-prefixed
    expect(rewritten).not.toContain('../.gen/');
  });

  it('has the diagrams-math stage kind', () => {
    expect(createDiagramsMathStage().kind).toBe('diagrams-math');
  });
});
