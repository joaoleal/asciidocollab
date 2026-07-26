/**
 * @file Resolves the vendored Harper WASM asset to the URL form the engine's worker can actually
 * fetch. Pure (no DOM, no harper.js), so the rule below is unit-tested even though its only caller —
 * the browser-only worker entry — cannot run under jest.
 */

/** Same-origin PATH of the vendored full Harper WASM binary, as served from `public/`. */
export const HARPER_WASM_PATH = '/vendor/harper/harper_wasm_bg.wasm';

/**
 * Resolve the vendored WASM path against an origin, producing an ABSOLUTE url.
 *
 * This absoluteness is load-bearing, not cosmetic. The URL is resolved and fetched inside the grammar
 * worker, whose base URL is the bundled worker asset rather than the page — and a bundler is free to
 * serve that asset from a nested path or, as `harper.js`'s own `WorkerLinter` did, from a `blob:` URL
 * that has no path to resolve against at all (there, a root-relative `/vendor/...` makes `fetch` throw
 * `Failed to parse URL` inside the worker, which surfaces as warm-up hanging rather than as an error).
 * Handing over an absolute same-origin URL keeps the fetch resolvable wherever the worker is served
 * from — and same-origin, so the binary is never fetched from a third party.
 *
 * @param origin - The page origin to resolve against (`globalThis.location.origin` at runtime).
 * @returns The absolute, same-origin URL of the full Harper WASM binary.
 */
export function resolveHarperWasmUrl(origin: string): string {
  return new URL(HARPER_WASM_PATH, origin).href;
}
