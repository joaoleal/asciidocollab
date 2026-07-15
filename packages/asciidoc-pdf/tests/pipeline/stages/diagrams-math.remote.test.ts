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

// ---------------------------------------------------------------------------
// In-memory fakes matching the sibling stage tests, so the remote-skip path is
// exercised the same way (real hashing, a real diagnostics collector, an
// in-memory VFS). A remote-referencing diagram must be skipped with a warning
// and NEVER handed to a shim or fetched.
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
    includeAssembler: {
      assemble: (request) => ({ content: request.readFile(request.rootPath) ?? '', unresolved: [] }),
    },
    cache: makeCache(),
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
  return { ctx: context, vfs };
}

const REMOTE_VEGA_BLOCK = [
  '[vega]',
  '----',
  '{ "data": { "url": "https://example.com/data.json" }, "marks": [] }',
  '----',
].join('\n');

const MERMAID_BLOCK = ['[mermaid]', '----', 'graph TD; A-->B;', '----'].join('\n');

describe('createDiagramsMathStage remote-resource skipping', () => {
  it('skips a vega block with a remote data.url — warning, located, never rendered or fetched', async () => {
    const render = renderMock(async () => okSvg());
    const fetchMock = jest.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { ctx, vfs } = makeContext(REMOTE_VEGA_BLOCK, [fakeShim('diagram', 'vega', render)]);

      await createDiagramsMathStage().run(ctx);

      const diags = ctx.diagnostics.all();
      expect(diags).toHaveLength(1);
      const diag = diags[0];
      expect(diag.severity).toBe('warning');
      expect(diag.code).toBe('remote-skipped');
      expect(diag.location?.line).toBe(1);
      expect(diag.location?.path).toBe(ROOT_PATH);
      expect(diag.message).toMatch(/remote/i);
      // Zero source egress: neither the shim nor the network was ever reached.
      expect(render).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      // Fail-soft: the block is left untouched, nothing written to .gen.
      expect(vfs.list(GEN_PREFIX)).toHaveLength(0);
      expect(vfs.readText(ROOT_VFS_PATH) ?? '').toContain('https://example.com/data.json');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips a mermaid block that embeds a remote resource (non-JSON engine, scheme:// scan)', async () => {
    const render = renderMock(async () => okSvg());
    const remoteMermaid = [
      '[mermaid]',
      '----',
      'flowchart TD',
      "  A[\"<img src='https://cdn.example.com/logo.png'>\"] --> B",
      '----',
    ].join('\n');
    const { ctx } = makeContext(remoteMermaid, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    expect(render).not.toHaveBeenCalled();
    expect(ctx.diagnostics.all().filter((d) => d.code === 'remote-skipped')).toHaveLength(1);
  });

  it('renders a sibling diagram while skipping the remote one (fail-soft, whole doc still exports)', async () => {
    const vega = renderMock(async () => okSvg('vega'));
    const mermaid = renderMock(async () => okSvg('mermaid'));
    const document = [MERMAID_BLOCK, '', REMOTE_VEGA_BLOCK].join('\n');
    const { ctx, vfs } = makeContext(document, [
      fakeShim('diagram', 'mermaid', mermaid),
      fakeShim('diagram', 'vega', vega),
    ]);

    await createDiagramsMathStage().run(ctx);

    // The clean mermaid block renders; the remote vega block is skipped, never rendered.
    expect(mermaid).toHaveBeenCalledTimes(1);
    expect(vega).not.toHaveBeenCalled();

    const rewritten = vfs.readText(ROOT_VFS_PATH) ?? '';
    expect(rewritten).toContain('image::.gen/');
    expect(rewritten).not.toContain('graph TD');
    // The remote block is left in place with a located warning.
    expect(rewritten).toContain('https://example.com/data.json');
    const remote = ctx.diagnostics.all().filter((d) => d.code === 'remote-skipped');
    expect(remote).toHaveLength(1);
    expect(remote[0].location?.line).toBe(6);
  });

  it('renders a local (relative) vega data.url normally — only remote scheme URLs are skipped', async () => {
    const render = renderMock(async () => okSvg());
    const localBlock = [
      '[vega]',
      '----',
      '{ "data": { "url": "data/local.json" }, "marks": [] }',
      '----',
    ].join('\n');
    const { ctx } = makeContext(localBlock, [fakeShim('diagram', 'vega', render)]);

    await createDiagramsMathStage().run(ctx);

    // A relative reference is local: it is not skipped here (the shim decides its fate).
    expect(render).toHaveBeenCalledTimes(1);
    expect(ctx.diagnostics.all().filter((d) => d.code === 'remote-skipped')).toHaveLength(0);
  });

  it('renders a vega spec whose only remote-looking URL is its $schema identifier (inline data)', async () => {
    const render = renderMock(async () => okSvg());
    const schemaOnly = [
      '[vega]',
      '----',
      '{ "$schema": "https://vega.github.io/schema/vega/v5.json", "data": { "values": [{ "x": 1 }] }, "marks": [] }',
      '----',
    ].join('\n');
    const { ctx } = makeContext(schemaOnly, [fakeShim('diagram', 'vega', render)]);

    await createDiagramsMathStage().run(ctx);

    // `$schema` is a schema NAME, never fetched — it must not trip the remote-skip guard.
    expect(render).toHaveBeenCalledTimes(1);
    expect(ctx.diagnostics.all().filter((d) => d.code === 'remote-skipped')).toHaveLength(0);
  });

  it('renders a vega-lite spec with a $schema plus inline data (alias folds onto vega detection)', async () => {
    const render = renderMock(async () => okSvg());
    const vegaLite = [
      '[vega-lite]',
      '----',
      '{ "$schema": "https://vega.github.io/schema/vega-lite/v5.json", "data": { "values": [] }, "mark": "point" }',
      '----',
    ].join('\n');
    const { ctx } = makeContext(vegaLite, [fakeShim('diagram', 'vega', render)]);

    await createDiagramsMathStage().run(ctx);

    expect(render).toHaveBeenCalledTimes(1);
    expect(ctx.diagnostics.all().filter((d) => d.code === 'remote-skipped')).toHaveLength(0);
  });

  it('skips a vega spec whose remote url sits deep in a data-set array, alongside a harmless $schema', async () => {
    const render = renderMock(async () => okSvg());
    const nestedRemote = [
      '[vega]',
      '----',
      '{ "$schema": "https://vega.github.io/schema/vega/v5.json", "data": [{ "name": "src", "url": "https://cdn.example.com/points.json" }], "marks": [] }',
      '----',
    ].join('\n');
    const { ctx } = makeContext(nestedRemote, [fakeShim('diagram', 'vega', render)]);

    await createDiagramsMathStage().run(ctx);

    // A deep remote `url` key is still caught, even alongside a (harmless) $schema.
    expect(render).not.toHaveBeenCalled();
    expect(ctx.diagnostics.all().filter((d) => d.code === 'remote-skipped')).toHaveLength(1);
  });

  it('renders a vega spec whose data.url is an inline data: URI (carries its bytes, never fetched)', async () => {
    const render = renderMock(async () => okSvg());
    const dataUri = [
      '[vega]',
      '----',
      '{ "data": { "url": "data:application/json,[]" }, "marks": [] }',
      '----',
    ].join('\n');
    const { ctx } = makeContext(dataUri, [fakeShim('diagram', 'vega', render)]);

    await createDiagramsMathStage().run(ctx);

    expect(render).toHaveBeenCalledTimes(1);
    expect(ctx.diagnostics.all().filter((d) => d.code === 'remote-skipped')).toHaveLength(0);
  });

  it('skips a vega spec with a protocol-relative (//host) data.url', async () => {
    const render = renderMock(async () => okSvg());
    const protocolRelative = [
      '[vega]',
      '----',
      '{ "data": { "url": "//cdn.example.com/data.json" }, "marks": [] }',
      '----',
    ].join('\n');
    const { ctx } = makeContext(protocolRelative, [fakeShim('diagram', 'vega', render)]);

    await createDiagramsMathStage().run(ctx);

    expect(render).not.toHaveBeenCalled();
    expect(ctx.diagnostics.all().filter((d) => d.code === 'remote-skipped')).toHaveLength(1);
  });

  it('does not treat a malformed (non-JSON) vega spec as remote — it is left for the engine to reject', async () => {
    const render = renderMock(async () => okSvg());
    const malformed = [
      '[vega]',
      '----',
      'this is not json https://cdn.example.com/data.json',
      '----',
    ].join('\n');
    const { ctx } = makeContext(malformed, [fakeShim('diagram', 'vega', render)]);

    await createDiagramsMathStage().run(ctx);

    // A vega body that is not valid JSON cannot drive a data fetch; it is handed to the shim, not skipped.
    expect(render).toHaveBeenCalledTimes(1);
    expect(ctx.diagnostics.all().filter((d) => d.code === 'remote-skipped')).toHaveLength(0);
  });
});
