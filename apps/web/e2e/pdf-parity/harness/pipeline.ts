/**
 * Drives the REAL pre-processing pipeline (the shipping citations + diagrams-math stages) over an
 * in-memory VFS, exactly as the production orchestrator does, then hands the rewritten project to the
 * warm engine. This is the "our output" side of the parity comparison: the same stages, the same
 * shims, the same content-addressed asset placement the browser worker composes — only the VFS backing
 * store is an in-memory map instead of the WASI-mounted one, and the engine runs headlessly in Node.
 */

import {
  runPipeline,
  createShimRegistry,
  createDiagnosticsCollector,
  cancellationToken,
  createCitationsStage,
  createDiagramsMathStage,
  createMountAssetsStage,
  PROJECT_ROOT,
  type PipelineVfs,
  type AssetCachePort,
  type StageContext,
  type PipelineStage,
  type RenderShim,
  type GeneratedAsset,
  type ProjectSnapshot,
  type RenderRequest,
  type RenderDiagnostic,
  type IncludeAssembler,
} from '@asciidocollab/asciidoc-pdf';
import type { ParityEngine } from './engine';
import { nodeFontConverter } from './font-converter';
import { BINARY_EXTENSIONS } from './manifest';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** An in-memory {@link PipelineVfs} — a flat map keyed by absolute VFS path. */
function createMemoryVfs(): PipelineVfs & { entries(): ReadonlyMap<string, Uint8Array> } {
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
    list: (path) => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      return [...store.keys()].filter((key) => key.startsWith(prefix));
    },
    entries: () => store,
  };
}

/** A simple, unbounded content-addressed asset cache (a fresh one per render, so no cross-talk). */
function createMemoryCache(): AssetCachePort {
  const store = new Map<string, GeneratedAsset>();
  return {
    get: (sourceHash) => store.get(sourceHash),
    has: (sourceHash) => store.has(sourceHash),
    set: (asset) => void store.set(asset.sourceHash, asset),
  };
}

/** The include-resolve stage is not run here (fixtures have no includes), so this is never invoked. */
const unusedIncludeAssembler: IncludeAssembler = {
  assemble: () => {
    throw new Error('include assembly is not exercised by the parity harness');
  },
};

/** The result of running just the pre-processing stages: the rewritten project + stage diagnostics. */
export interface PreprocessResult {
  /** The rewritten project, project-relative path → UTF-8 content (root doc + placed `.gen/*.svg`). */
  readonly files: Readonly<Record<string, string>>;
  /** The binary assets carried through unchanged (fonts, images) — never decoded as text. */
  readonly binaryAssets: Readonly<Record<string, Uint8Array>>;
  /** Diagnostics the stages raised (a divergence or malformed-block skip is visible here). */
  readonly diagnostics: readonly RenderDiagnostic[];
}

/**
 * Run the citations + diagrams-math stages over `snapshot` with the supplied shims — the exact
 * production pre-processing — and return the rewritten project (root doc rewritten to reference the
 * placed `.gen` assets, plus those assets). No engine is involved, so this drives the shims (including
 * the browser-backed mermaid/MathJax ones) without the wasm VM.
 */
export async function preprocessOurs(
  snapshot: ProjectSnapshot,
  shims: readonly RenderShim[],
): Promise<PreprocessResult> {
  const vfs = createMemoryVfs();
  for (const [relativePath, content] of Object.entries(snapshot.files)) {
    vfs.writeText(`${PROJECT_ROOT}/${relativePath}`, content);
  }
  for (const [relativePath, bytes] of Object.entries(snapshot.binaryAssets)) {
    vfs.writeFile(`${PROJECT_ROOT}/${relativePath}`, bytes);
  }

  const request: RenderRequest = { requestId: 'parity-pre', mode: 'export', snapshot, optimize: false };
  const diagnostics = createDiagnosticsCollector();
  const context: StageContext = {
    request,
    readFile: (path) => snapshot.files[path] ?? null,
    vfs,
    shims: createShimRegistry(shims),
    includeAssembler: unusedIncludeAssembler,
    cache: createMemoryCache(),
    diagnostics,
    cancellation: cancellationToken(() => false),
  };

  // The asset-mount stage is what makes a custom WOFF2 theme font embeddable: prawn dispatches font
  // loading by file extension, so without the decode-and-repoint this stage performs the engine aborts
  // with "…`.woff2`… is not a known font". Production runs it too — omitting it here would make a
  // WOFF2 fixture untestable, which is precisely what had happened.
  const stages: PipelineStage[] = [
    createCitationsStage(),
    createDiagramsMathStage(),
    createMountAssetsStage({ fontConverter: nodeFontConverter() }),
  ];
  await runPipeline(stages, context);

  // Split the rewritten project back into text and bytes. Classification is by EXTENSION rather than
  // by "was it binary on the way in", because the asset-mount stage emits a decoded `.ttf` that was
  // never in the input. Decoding any of these as UTF-8 silently corrupts the font or image, and the
  // engine then falls back to a default face — quietly defeating the fidelity the fixture asserts.
  const files: Record<string, string> = {};
  const binaryAssets: Record<string, Uint8Array> = {};
  const prefix = `${PROJECT_ROOT}/`;
  for (const [path, bytes] of vfs.entries()) {
    const relativePath = path.slice(prefix.length);
    const extension = relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase();
    if (relativePath in snapshot.binaryAssets || BINARY_EXTENSIONS.has(extension)) {
      binaryAssets[relativePath] = bytes;
    } else {
      files[relativePath] = decoder.decode(bytes);
    }
  }
  return { files, binaryAssets, diagnostics: diagnostics.all() };
}

/** The outcome of the full our-side render: the produced PDF bytes plus any stage diagnostics. */
export interface OursRenderResult {
  readonly pdfBytes: Uint8Array;
  readonly diagnostics: readonly RenderDiagnostic[];
}

/**
 * Pre-process `snapshot` with the supplied shims and convert the rewritten project with the warm
 * engine — the full production path, headless in Node. Returns the PDF bytes and the stage diagnostics.
 */
export async function renderOurs(
  snapshot: ProjectSnapshot,
  shims: readonly RenderShim[],
  engine: ParityEngine,
): Promise<OursRenderResult> {
  const { files, binaryAssets, diagnostics } = await preprocessOurs(snapshot, shims);
  const convertSnapshot: ProjectSnapshot = { ...snapshot, files, binaryAssets };
  const pdfBytes = await engine.convert(convertSnapshot);
  return { pdfBytes, diagnostics };
}
