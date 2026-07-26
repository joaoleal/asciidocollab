/**
 * @file Resolves the vendored Harper WASM asset to the URL form the engine's worker can actually
 * fetch. Pure (no DOM, no harper.js), so the rule below is unit-tested even though its only caller —
 * the browser-only engine adapter — cannot run under jest.
 */

/** Same-origin PATH of the vendored full Harper WASM binary, as served from `public/`. */
export const HARPER_WASM_PATH = '/vendor/harper/harper_wasm_bg.wasm';

/**
 * Resolve the vendored WASM path against an origin, producing an ABSOLUTE url.
 *
 * This absoluteness is load-bearing, not cosmetic. `WorkerLinter` runs the engine inside a worker it
 * spawns from a `blob:` URL, and the binary's URL is handed across to that worker and fetched there.
 * A `blob:` script's base URL is the blob URL itself, which has no path to resolve against, so a
 * root-relative path like `/vendor/...` makes `fetch` throw `Failed to parse URL` inside the worker.
 * The library never rejects the pending request when its worker errors, so that throw does not surface
 * as a failed init — it simply leaves warm-up pending forever, pinning the panel on "loading". Handing
 * over an absolute same-origin URL is what keeps the fetch resolvable in the blob worker.
 *
 * @param origin - The page origin to resolve against (`globalThis.location.origin` at runtime).
 * @returns The absolute, same-origin URL of the full Harper WASM binary.
 */
export function resolveHarperWasmUrl(origin: string): string {
  return new URL(HARPER_WASM_PATH, origin).href;
}
