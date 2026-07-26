import type { GrammarDialect } from './codemirror/harper/dialect';
import type { HarperEngine } from './codemirror/harper/harper-engine';
import { createHarperEngineProxy } from './codemirror/harper/harper-engine-proxy';

/**
 * Creates the Harper grammar Web Worker and the engine that drives it.
 *
 * Using the `new URL(path, import.meta.url)` pattern causes Next.js to bundle the worker file and its
 * npm dependencies (`harper.js`, an ESM+WASM package) into a self-contained asset, so the whole engine
 * — binary included — lives in the worker and the editor's thread never compiles a byte of it.
 *
 * The factory is extracted so tests can mock it without needing `import.meta.url` support: everything
 * with behaviour lives in {@link createHarperEngineProxy}, which unit-tests against a fake worker.
 */

/**
 * Spawn the grammar worker.
 *
 * @returns A worker serving the Harper engine protocol.
 */
function createHarperWorker(): Worker {
  return new Worker(new URL('../workers/harper.worker.ts', import.meta.url));
}

/**
 * Build the app's Harper engine: the worker plus the main-thread proxy in front of it.
 *
 * @param dialect - The English dialect to enforce.
 * @returns A {@link HarperEngine} backed by the self-hosted grammar worker.
 */
export function createHarperEngine(dialect: GrammarDialect): HarperEngine {
  return createHarperEngineProxy(dialect, createHarperWorker);
}
