import { createIncludeResolveStage } from '../../../src/pipeline/stages/include-resolve';
import {
  cancellationToken,
  createDiagnosticsCollector,
  runPipeline,
  type AssetCachePort,
  type PipelineVfs,
  type StageContext,
} from '../../../src/pipeline/orchestrator';
import { createShimRegistry } from '../../../src/ports/shim';
import { PROJECT_ROOT, SOURCE_PROVENANCE_PATH } from '../../../src/vfs/populate';
import type {
  AssembledDocument,
  IncludeAssembler,
  IncludeAssemblyRequest,
  ProjectFileReader,
  SandboxPathResolver,
  UnresolvedInclude,
} from '../../../src/ports/include-assembler';
import type { GeneratedAsset, ProjectSnapshot, RenderRequest } from '../../../src/protocol';

// ---------------------------------------------------------------------------
// In-memory fakes. The stage is pure w.r.t. its injected seams, so an
// in-process context with a fake IncludeAssembler + VFS fully exercises it.
// ---------------------------------------------------------------------------

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

function makeRequest(snapshot: ProjectSnapshot, mode: RenderRequest['mode'] = 'export'): RenderRequest {
  return { requestId: 'req-1', mode, optimize: false, snapshot };
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
  const store = new Map<string, GeneratedAsset>();
  return {
    get: (hash) => store.get(hash),
    has: (hash) => store.has(hash),
    set: (asset) => void store.set(asset.sourceHash, asset),
  };
}

/** A fake assembler that returns a controlled document and records the request it was handed. */
function makeAssembler(document: AssembledDocument): {
  readonly assembler: IncludeAssembler;
  readonly calls: IncludeAssemblyRequest[];
} {
  const calls: IncludeAssemblyRequest[] = [];
  return {
    assembler: {
      assemble: (request) => {
        calls.push(request);
        return document;
      },
    },
    calls,
  };
}

const passthroughResolver: SandboxPathResolver = (_from, target) => ({ ok: true, path: target });
const nullReadFile: ProjectFileReader = () => null;
const rootContentReader: ProjectFileReader = () => 'root content';

function makeContext(overrides: {
  snapshot?: ProjectSnapshot;
  assembler?: IncludeAssembler;
  readFile?: ProjectFileReader;
  vfs?: PipelineVfs;
  mode?: RenderRequest['mode'];
}): StageContext {
  const snapshot = overrides.snapshot ?? makeSnapshot();
  return {
    request: makeRequest(snapshot, overrides.mode),
    readFile: overrides.readFile ?? nullReadFile,
    vfs: overrides.vfs ?? makeVfs(),
    shims: createShimRegistry([]),
    includeAssembler: overrides.assembler ?? makeAssembler({ content: '', unresolved: [] }).assembler,
    cache: makeCache(),
    diagnostics: createDiagnosticsCollector(),
    cancellation: cancellationToken(() => false),
  };
}

function unresolved(from: string, target: string, reason: string): UnresolvedInclude {
  return { from, target, reason };
}

describe('createIncludeResolveStage', () => {
  it('declares the include-resolve pipeline kind', () => {
    const stage = createIncludeResolveStage({ resolveSandboxedPath: passthroughResolver });
    expect(stage.kind).toBe('include-resolve');
  });

  describe('expanded document write-back', () => {
    it('writes the fully-expanded single document into /project at the root path', async () => {
      const snapshot = makeSnapshot({ rootPath: 'book/main.adoc' });
      const { assembler } = makeAssembler({ content: 'inlined body of the whole book', unresolved: [] });
      const vfs = makeVfs();
      const context = makeContext({ snapshot, assembler, vfs });
      const stage = createIncludeResolveStage({ resolveSandboxedPath: passthroughResolver });

      const result = await stage.run(context);

      expect(vfs.readText(`${PROJECT_ROOT}/book/main.adoc`)).toBe('inlined body of the whole book');
      expect(result.diagnostics ?? []).toEqual([]);
    });

    it('still writes the expanded content even when some includes could not be resolved', async () => {
      const { assembler } = makeAssembler({
        content: 'partial doc with the resolvable parts inlined',
        unresolved: [unresolved('main.adoc', 'missing.adoc', 'not-found')],
      });
      const vfs = makeVfs();
      const context = makeContext({ assembler, vfs });
      const stage = createIncludeResolveStage({ resolveSandboxedPath: passthroughResolver });

      await stage.run(context);

      expect(vfs.readText(`${PROJECT_ROOT}/main.adoc`)).toBe(
        'partial doc with the resolvable parts inlined',
      );
    });
  });

  describe('source provenance sidecar (preview click-to-source)', () => {
    const provenance = { lineToSource: [{ path: 'main.adoc', sourceLine: 1 }, { path: 'ch/one.adoc', sourceLine: 3 }] };

    it('requests the source map and writes the provenance sidecar for PREVIEW renders', async () => {
      const { assembler, calls } = makeAssembler({ content: 'body', unresolved: [], sourceMap: provenance });
      const vfs = makeVfs();
      const context = makeContext({ assembler, vfs, mode: 'preview' });
      const stage = createIncludeResolveStage({ resolveSandboxedPath: passthroughResolver });

      await stage.run(context);

      expect(calls[0].options?.withSourceMap).toBe(true);
      expect(JSON.parse(vfs.readText(SOURCE_PROVENANCE_PATH)!)).toEqual(provenance.lineToSource);
    });

    it('writes an empty provenance for EXPORT renders (no origins leak into an export on a warm VM)', async () => {
      const { assembler, calls } = makeAssembler({ content: 'body', unresolved: [] });
      const vfs = makeVfs();
      const context = makeContext({ assembler, vfs, mode: 'export' });
      const stage = createIncludeResolveStage({ resolveSandboxedPath: passthroughResolver });

      await stage.run(context);

      expect(calls[0].options?.withSourceMap).toBe(false);
      expect(JSON.parse(vfs.readText(SOURCE_PROVENANCE_PATH)!)).toEqual([]);
    });
  });

  describe('assembler wiring (injected seams)', () => {
    it('threads the root path, readFile, sandbox resolver, and seeded attributes into the port', async () => {
      const snapshot = makeSnapshot({ rootPath: 'main.adoc', attributes: { doctype: 'book', env: 'pdf' } });
      const { assembler, calls } = makeAssembler({ content: '', unresolved: [] });
      const context = makeContext({ snapshot, assembler, readFile: rootContentReader });
      const stage = createIncludeResolveStage({ resolveSandboxedPath: passthroughResolver });

      await stage.run(context);

      expect(calls).toHaveLength(1);
      const request = calls[0];
      expect(request.rootPath).toBe('main.adoc');
      expect(request.readFile).toBe(rootContentReader);
      expect(request.resolveSandboxedPath).toBe(passthroughResolver);
      expect(request.options?.seedAttributes?.get('doctype')).toBe('book');
      expect(request.options?.seedAttributes?.get('env')).toBe('pdf');
    });
  });

  describe('unresolved → diagnostic mapping', () => {
    it('maps remote / absolute / traversal (sandbox-escaping) targets to remote-skipped warnings', async () => {
      const entries = [
        unresolved('main.adoc', 'https://example.com/remote.adoc', 'remote'),
        unresolved('main.adoc', '/etc/passwd', 'absolute'),
        unresolved('chapters/a.adoc', '../../escape.adoc', 'traversal'),
      ];
      const { assembler } = makeAssembler({ content: 'body', unresolved: entries });
      const context = makeContext({ assembler });
      const stage = createIncludeResolveStage({ resolveSandboxedPath: passthroughResolver });

      const result = await stage.run(context);
      const diagnostics = result.diagnostics ?? [];

      expect(diagnostics.map((d) => d.code)).toEqual([
        'remote-skipped',
        'remote-skipped',
        'remote-skipped',
      ]);
      for (const [index, diagnostic] of diagnostics.entries()) {
        expect(diagnostic.severity).toBe('warning');
        expect(diagnostic.resource).toBe(entries[index].target);
        expect(diagnostic.location).toEqual({ path: entries[index].from });
      }
    });

    it('maps not-found / cycle / depth / limit targets to unresolved-include diagnostics', async () => {
      const entries = [
        unresolved('main.adoc', 'missing.adoc', 'not-found'),
        unresolved('a.adoc', 'b.adoc', 'cycle'),
        unresolved('a.adoc', 'deep.adoc', 'depth'),
        unresolved('a.adoc', 'many.adoc', 'limit'),
      ];
      const { assembler } = makeAssembler({ content: 'body', unresolved: entries });
      const context = makeContext({ assembler });
      const stage = createIncludeResolveStage({ resolveSandboxedPath: passthroughResolver });

      const result = await stage.run(context);
      const diagnostics = result.diagnostics ?? [];

      expect(diagnostics.map((d) => d.code)).toEqual([
        'unresolved-include',
        'unresolved-include',
        'unresolved-include',
        'unresolved-include',
      ]);
      for (const [index, diagnostic] of diagnostics.entries()) {
        expect(diagnostic.resource).toBe(entries[index].target);
        expect(diagnostic.location).toEqual({ path: entries[index].from });
      }
    });

    it('produces located diagnostics that name both the referencing file and the target', async () => {
      const entry = unresolved('chapters/intro.adoc', 'missing.adoc', 'not-found');
      const { assembler } = makeAssembler({ content: 'body', unresolved: [entry] });
      const context = makeContext({ assembler });
      const stage = createIncludeResolveStage({ resolveSandboxedPath: passthroughResolver });

      const result = await stage.run(context);
      const diagnostic = (result.diagnostics ?? [])[0];

      expect(diagnostic.message).toContain('missing.adoc');
      expect(diagnostic.message).toContain('chapters/intro.adoc');
    });
  });

  describe('never aborts', () => {
    it('runs to completion through the orchestrator with a mix of resolved + unresolved includes', async () => {
      const entries = [
        unresolved('main.adoc', 'https://example.com/r.adoc', 'remote'),
        unresolved('main.adoc', 'missing.adoc', 'not-found'),
      ];
      const { assembler } = makeAssembler({ content: 'expanded document', unresolved: entries });
      const vfs = makeVfs();
      const context = makeContext({ assembler, vfs });
      const stage = createIncludeResolveStage({ resolveSandboxedPath: passthroughResolver });

      const outcome = await runPipeline([stage], context);

      expect(outcome.completed).toBe(true);
      expect(outcome.cancelled).toBe(false);
      expect(outcome.ranStages).toEqual(['include-resolve']);
      expect(outcome.diagnostics.map((d) => d.code)).toEqual(['remote-skipped', 'unresolved-include']);
      expect(vfs.readText(`${PROJECT_ROOT}/main.adoc`)).toBe('expanded document');
    });
  });
});
