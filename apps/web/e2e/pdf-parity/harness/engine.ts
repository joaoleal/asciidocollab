/**
 * Loads and warms the REAL Asciidoctor-PDF wasm engine through the package's shipping bridge/VM
 * seams, headlessly in Node — the same code path the browser worker composes, minus the DOM. One warm
 * VM is compiled + booted once and reused across every fixture convert in a run, mirroring the warm-VM
 * reuse the production controller relies on.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  createWasiBridge,
  createRubyPdfVm,
  populateProject,
  invokeConvert,
  resolvePdfExtensions,
  type PdfExtensionSource,
  type ProjectSnapshot,
  type RenderRequest,
} from '@asciidocollab/asciidoc-pdf';
import type { PdfExtensionCatalogueEntry } from '@asciidocollab/asciidoc-core';

/** The first-party extension gem's lib directory: one directory per shipped extension. */
const SHIPPED_EXTENSIONS_DIR = path.resolve(
  __dirname,
  '../../../../../packages/asciidoc-pdf/ruby/extensions/asciidocollab-pdf-extensions/lib',
);

/** Every shipped extension directory carrying both a manifest and a source. */
function shippedDirectories(): string[] {
  if (!existsSync(SHIPPED_EXTENSIONS_DIR)) return [];
  return readdirSync(SHIPPED_EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        existsSync(path.join(SHIPPED_EXTENSIONS_DIR, name, 'manifest.json')) &&
        existsSync(path.join(SHIPPED_EXTENSIONS_DIR, name, 'extension.rb')),
    );
}

/** The shipped catalogue, as the server would assemble it. */
function shippedCatalogue(): PdfExtensionCatalogueEntry[] {
  return shippedDirectories().map((name) => ({
    manifest: JSON.parse(
      readFileSync(path.join(SHIPPED_EXTENSIONS_DIR, name, 'manifest.json'), 'utf8'),
    ) as PdfExtensionCatalogueEntry['manifest'],
    origin: 'shipped' as const,
    available: true,
  }));
}

/** Each shipped extension's Ruby source, as the composition root would inject it. */
function shippedSources(): PdfExtensionSource[] {
  return shippedDirectories().map((name) => ({
    id: JSON.parse(
      readFileSync(path.join(SHIPPED_EXTENSIONS_DIR, name, 'manifest.json'), 'utf8'),
    ).id as string,
    origin: 'shipped' as const,
    source: readFileSync(path.join(SHIPPED_EXTENSIONS_DIR, name, 'extension.rb'), 'utf8'),
  }));
}

/**
 * How many converts one VM serves before it is torn down and re-booted. Low enough that no fixture
 * renders on a heavily-grown heap, high enough that the ~1s boot is amortized across several
 * fixtures. The compiled module is retained across recycles, so only the VM is rebuilt.
 */
const CONVERTS_PER_VM = 5;

/** A warmed engine that converts project snapshots to normalized PDF bytes. */
export interface ParityEngine {
  /**
   * Populate the snapshot into the warm VM and convert it, returning the deterministic PDF bytes.
   *
   * @param snapshot - The project snapshot to populate and convert.
   * @returns The normalized PDF bytes produced by the engine.
   */
  convert(snapshot: ProjectSnapshot): Promise<Uint8Array>;
  /** Tear the VM down. */
  dispose(): void;
}

/**
 * Compile the wasm module once, boot one warm VM, and return an engine that converts snapshots. The
 * caller owns disposal. A convert failure surfaces as a thrown error carrying the engine's phase/code.
 */
export async function createParityEngine(wasmPath: string): Promise<ParityEngine> {
  const wasmBytes = readFileSync(wasmPath);
  const wasmModule = await WebAssembly.compile(wasmBytes);

  // Boot a VM from the ALREADY-COMPILED module. Compiling the ~71 MB wasm is the expensive part and
  // is done once above; booting and warming a fresh VM from it costs about a second, which is what
  // makes recycling affordable.
  const boot = async () => {
    const booted = createRubyPdfVm({ createBridge: () => createWasiBridge({ module: wasmModule }) });
    await booted.warmup();
    return booted;
  };

  let vm = await boot();
  let requestCounter = 0;
  let convertsOnThisVm = 0;

  return {
    async convert(snapshot: ProjectSnapshot): Promise<Uint8Array> {
      // Recycle the VM periodically. A single VM reused across the whole fixture set degrades
      // steeply: its wasm heap only grows (Ruby cannot un-prepend converter modules, and nothing
      // reclaims a previous fixture's allocations), and the cost shows up in proportion to how much
      // work a render does. Measured on this suite, the final determinism test — two renders of the
      // `theme-editing` fixture — took 4.0s alone on a fresh VM but 210s at the end of a full run, a
      // 52x penalty; small fixtures in between stayed fast, which is why the degradation is easy to
      // miss. Beyond the wall-clock cost it is also a correctness hazard: the bigger the heap, the
      // more `memory.grow` events during a convert, and a grow intermittently invalidates a pointer
      // mid-eval and fails the render with `RangeError: Start offset … is outside the bounds of the
      // buffer`. That is what turned this suite red on CI while passing locally on the same commit.
      if (convertsOnThisVm >= CONVERTS_PER_VM) {
        vm.dispose();
        vm = await boot();
        convertsOnThisVm = 0;
      }
      convertsOnThisVm += 1;

      populateProject(vm, snapshot);

      // Resolve the fixture's enabled extensions through the SAME registry a real render uses, and
      // mount each source at the path the registry chose. Reading the shipped `.rb` files here is
      // the harness standing in for the composition root that injects them in the app — the registry
      // still decides what is loadable and in what order, so the fixture exercises the real rule
      // rather than a parallel one.
      const resolution = resolvePdfExtensions(
        snapshot.enabledExtensions ?? [],
        shippedCatalogue(),
        shippedSources(),
      );
      if (resolution.rejected.length > 0) {
        throw new Error(
          `Extensions refused: ${resolution.rejected.map((entry) => `${entry.id} (${entry.reason})`).join(', ')}`,
        );
      }
      for (const extension of resolution.loaded) {
        vm.writeFile(extension.vfsPath, new TextEncoder().encode(extension.source));
      }

      requestCounter += 1;
      const request: RenderRequest = {
        requestId: `parity-${requestCounter}`,
        mode: 'export',
        snapshot,
        optimize: false,
      };
      // One warm VM serves every fixture in a run, so by this point the converter may still carry
      // modules a previous fixture prepended — Ruby cannot un-prepend them. What makes that harmless
      // is that the ids travel with the paths: the convert publishes THIS fixture's selection, and
      // each extension gates its hooks on it. Before that, fixtures inherited whatever ran before
      // them and three failed on nothing but the order the fixture directory was walked in.
      const result = await invokeConvert({
        vm,
        request,
        loadedExtensions: resolution.loaded.map(({ id, vfsPath }) => ({ id, vfsPath })),
      });
      if (!result.ok) {
        throw new Error(`Engine convert failed: ${result.error.phase}/${result.error.code}: ${result.error.message}`);
      }
      return result.bytes;
    },
    dispose(): void {
      vm.dispose();
    },
  };
}
