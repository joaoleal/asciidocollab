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
// In-memory fakes for the injected seams the stage touches, matching the main
// stage test's harness so the unsupported-diagnostic path is exercised the same
// way (real hashing, a real diagnostics collector, an in-memory VFS).
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
    includeAssembler: { assemble: (request) => ({ content: request.readFile(request.rootPath) ?? '', unresolved: [] }) },
    cache: makeCache(),
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
  return { ctx: context, vfs };
}

const MERMAID_BLOCK = ['[mermaid]', '----', 'graph TD; A-->B;', '----'].join('\n');

describe('createDiagramsMathStage unsupported-offline diagnostics', () => {
  it('names mermaid as the alternative for a skipped PlantUML block, fail-soft and located', async () => {
    const render = renderMock(async () => okSvg());
    const block = ['[plantuml]', '----', 'Alice -> Bob', '----'].join('\n');
    const { ctx, vfs } = makeContext(block, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    const diags = ctx.diagnostics.all();
    expect(diags).toHaveLength(1);
    const diag = diags[0];
    // Same fail-soft warning + code + located line as before — only the text improves.
    expect(diag.severity).toBe('warning');
    expect(diag.code).toBe('diagram-unsupported');
    expect(diag.location?.line).toBe(1);
    expect(diag.location?.path).toBe(ROOT_PATH);
    // The message now NAMES the supported alternative instead of only saying "skipped".
    expect(diag.message).toMatch(/skipped/i);
    expect(diag.message).toMatch(/mermaid/i);
    // Fail-soft: the block is left untouched and never fetched/rendered.
    expect(render).not.toHaveBeenCalled();
    expect(vfs.list(GEN_PREFIX)).toHaveLength(0);
    expect(vfs.readText(ROOT_VFS_PATH) ?? '').toContain('Alice -> Bob');
  });

  it('names Graphviz/DOT as the alternative when a PlantUML block wraps DOT', async () => {
    const render = renderMock(async () => okSvg());
    const block = ['[plantuml]', '----', 'digraph { a -> b }', '----'].join('\n');
    const { ctx } = makeContext(block, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    const diags = ctx.diagnostics.all();
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe('diagram-unsupported');
    expect(diags[0].message).toMatch(/graphviz/i);
  });

  it('gives a clear, honest message with no false alternative for a skipped ditaa block', async () => {
    const render = renderMock(async () => okSvg());
    const block = ['[ditaa]', '----', '+---+', '| A |', '+---+', '----'].join('\n');
    const { ctx, vfs } = makeContext(block, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    const diags = ctx.diagnostics.all();
    expect(diags).toHaveLength(1);
    const diag = diags[0];
    expect(diag.severity).toBe('warning');
    expect(diag.code).toBe('diagram-unsupported');
    expect(diag.message).toMatch(/ditaa/i);
    // Honest: it must not falsely promise mermaid/graphviz as a ditaa equivalent.
    expect(diag.message).not.toMatch(/mermaid/i);
    // Fail-soft: block untouched.
    expect(vfs.readText(ROOT_VFS_PATH) ?? '').toContain('| A |');
  });

  it('renders a valid mermaid block AND still warns (located) on a sibling PlantUML block', async () => {
    const render = renderMock(async () => okSvg());
    const document = [MERMAID_BLOCK, '', '[plantuml]', '----', 'Alice -> Bob', '----'].join('\n');
    const { ctx, vfs } = makeContext(document, [fakeShim('diagram', 'mermaid', render)]);

    await createDiagramsMathStage().run(ctx);

    // The mermaid block renders (fail-soft: the plantuml skip does not stop the rest).
    expect(render).toHaveBeenCalledTimes(1);
    const gen = vfs.list(GEN_PREFIX);
    expect(gen).toHaveLength(1);
    const rewritten = vfs.readText(ROOT_VFS_PATH) ?? '';
    expect(rewritten).toContain('image::.gen/');
    expect(rewritten).not.toContain('graph TD');
    // The plantuml block is skipped, left in place, with a located warning naming mermaid.
    expect(rewritten).toContain('Alice -> Bob');
    const diags = ctx.diagnostics.all();
    const unsupported = diags.filter((d) => d.code === 'diagram-unsupported');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].location?.line).toBe(6);
    expect(unsupported[0].message).toMatch(/mermaid/i);
  });
});
