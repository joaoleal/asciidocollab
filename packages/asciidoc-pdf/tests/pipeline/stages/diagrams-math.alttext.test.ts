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
import type { GeneratedAsset, RenderRequest } from '../../../src/protocol';
import type { AssembledDocument, IncludeAssembler } from '../../../src/ports/include-assembler';

// ---------------------------------------------------------------------------
// These tests pin the alt text the stage derives and applies. Alt text is
// accessibility metadata: it must ride on both the emitted image macro and the
// cached `GeneratedAsset`, and it must never perturb the rendered bytes, the
// content-addressed `.gen` path, or the block's placement.
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

const enc = new TextEncoder();

function okSvg(bytes = 'svg-bytes'): ShimOutput {
  return { ok: true, asset: { format: 'svg', bytes: enc.encode(bytes), rasterFallback: false } };
}

function renderMock(impl: (input: ShimInput) => Promise<ShimOutput>): jest.Mock<Promise<ShimOutput>, [ShimInput]> {
  return jest.fn<Promise<ShimOutput>, [ShimInput]>(impl);
}

function fakeShim(kind: RenderShim['kind'], name: string, render: jest.Mock<Promise<ShimOutput>, [ShimInput]>): RenderShim {
  return { kind, name, version: '1.0.0', render };
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

/** The single `.gen/<hash>.<ext>` asset the stage wrote, and the read-back rewritten document. */
function singleAsset(vfs: PipelineVfs): { hash: string; ext: string; rewritten: string } {
  const gen = vfs.list(GEN_PREFIX);
  expect(gen).toHaveLength(1);
  const name = gen[0].slice(GEN_PREFIX.length);
  const dot = name.lastIndexOf('.');
  return {
    hash: name.slice(0, dot),
    ext: name.slice(dot + 1),
    rewritten: vfs.readText(ROOT_VFS_PATH) ?? '',
  };
}

describe('diagrams-math alt text', () => {
  it('uses a block-title caption as the diagram image alt', async () => {
    const render = renderMock(async () => okSvg());
    const document = ['.Login sequence', '[mermaid]', '----', 'graph TD; A-->B;', '----'].join('\n');
    const { ctx, vfs } = makeContext(document, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    const { hash, rewritten } = singleAsset(vfs);
    expect(rewritten).toContain(`image::.gen/${hash}.svg["Login sequence"]`);
    // The visible caption line is preserved, so its rendered figure title is unchanged.
    expect(rewritten).toContain('.Login sequence');
  });

  it('uses a title= attribute as the diagram image alt', async () => {
    const render = renderMock(async () => okSvg());
    const document = ['[mermaid,title=Flowchart]', '----', 'graph TD; A-->B;', '----'].join('\n');
    const { ctx, vfs } = makeContext(document, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    const { hash, rewritten } = singleAsset(vfs);
    expect(rewritten).toContain(`image::.gen/${hash}.svg["Flowchart"]`);
  });

  it('defaults an untitled diagram alt to the engine name', async () => {
    const render = renderMock(async () => okSvg());
    const document = ['[graphviz]', '....', 'digraph { a -> b }', '....'].join('\n');
    const { ctx, vfs } = makeContext(document, [fakeShim('diagram', 'graphviz', render)]);

    await createDiagramsMathStage().run(ctx);

    const { hash, rewritten } = singleAsset(vfs);
    expect(rewritten).toContain(`image::.gen/${hash}.svg["graphviz diagram"]`);
  });

  it('defaults an untitled math block alt to its trimmed source expression', async () => {
    const render = renderMock(async () => okSvg('math'));
    const document = ['[stem]', '++++', 'sqrt(4) = 2', '++++'].join('\n');
    const { ctx, vfs } = makeContext(document, [fakeShim('math', 'mathjax', render)]);

    await createDiagramsMathStage().run(ctx);

    const { hash, rewritten } = singleAsset(vfs);
    expect(rewritten).toContain(`image::.gen/${hash}.svg["sqrt(4) = 2"]`);
  });

  it('defaults an empty math expression alt to a generic label', async () => {
    const render = renderMock(async () => okSvg('empty'));
    const document = ['[latexmath]', '++++', '', '++++'].join('\n');
    const { ctx, vfs } = makeContext(document, [fakeShim('math', 'mathjax', render)]);

    await createDiagramsMathStage().run(ctx);

    const { hash, rewritten } = singleAsset(vfs);
    expect(rewritten).toContain(`image::.gen/${hash}.svg["math expression"]`);
  });

  it('derives alt for inline math from its expression', async () => {
    const render = renderMock(async () => okSvg('inline'));
    const document = 'The value stem:[x^2] is shown.';
    const { ctx, vfs } = makeContext(document, [fakeShim('math', 'mathjax', render)]);

    await createDiagramsMathStage().run(ctx);

    const { hash, rewritten } = singleAsset(vfs);
    expect(rewritten).toBe(`The value image:.gen/${hash}.svg["x^2"] is shown.`);
  });

  it('escapes quotes and commas in the caption for the macro attribute', async () => {
    const render = renderMock(async () => okSvg());
    const document = ['.Fig, "A"', '[mermaid]', '----', 'graph TD; A-->B;', '----'].join('\n');
    const { ctx, vfs } = makeContext(document, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    const { hash, rewritten } = singleAsset(vfs);
    expect(rewritten).toContain(`image::.gen/${hash}.svg["Fig, \\"A\\""]`);
  });

  it('stores the same alt text on the cached GeneratedAsset', async () => {
    const render = renderMock(async () => okSvg());
    const document = ['[mermaid]', '----', 'graph TD; A-->B;', '----'].join('\n');
    const { ctx, vfs } = makeContext(document, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    const { hash } = singleAsset(vfs);
    const asset: GeneratedAsset | undefined = ctx.cache.get(hash);
    expect(asset?.altText).toBe('mermaid diagram');
  });

  it('does not change the asset path or bytes: alt text is not part of the content address', async () => {
    const untitled = renderMock(async () => okSvg('same-bytes'));
    const titled = renderMock(async () => okSvg('same-bytes'));
    const plain = ['[mermaid]', '----', 'graph TD; A-->B;', '----'].join('\n');
    const withTitle = ['.A caption', ...plain.split('\n')].join('\n');

    const a = makeContext(plain, [fakeShim('diagram', 'mermaid', untitled)]);
    const b = makeContext(withTitle, [fakeShim('diagram', 'mermaid', titled)]);
    await createDiagramsMathStage().run(a.ctx);
    await createDiagramsMathStage().run(b.ctx);

    const untitledAsset = singleAsset(a.vfs);
    const titledAsset = singleAsset(b.vfs);
    // Same source ⇒ same content address (hash + filename) regardless of the caption/alt.
    expect(titledAsset.hash).toBe(untitledAsset.hash);
    expect(titledAsset.ext).toBe(untitledAsset.ext);
    expect(b.vfs.readFile(`${GEN_PREFIX}${titledAsset.hash}.${titledAsset.ext}`)).toEqual(
      a.vfs.readFile(`${GEN_PREFIX}${untitledAsset.hash}.${untitledAsset.ext}`),
    );
    // Only the alt attribute differs between the two emitted macros; the path is identical.
    expect(a.vfs.readText(ROOT_VFS_PATH) ?? '').toContain(`image::.gen/${untitledAsset.hash}.svg["mermaid diagram"]`);
    expect(b.vfs.readText(ROOT_VFS_PATH) ?? '').toContain(`image::.gen/${titledAsset.hash}.svg["A caption"]`);
  });
});
