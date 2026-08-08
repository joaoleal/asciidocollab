/**
 * The Node-side WOFF2→TTF decoder the parity harness feeds to the asset-mount stage.
 *
 * Production supplies this from the worker, where the codec wasm is fetched same-origin from
 * `/vendor/woff2/woff2.wasm`. The harness runs in Node with no server, so it initializes the codec
 * from the SAME vendored artifact read off disk — the decoder under test is byte-identical to the one
 * that ships, which is the only way a WOFF2 parity result means anything.
 *
 * Without this stage the engine receives the raw `.woff2` and aborts with "is not a known font", which
 * is exactly why the WOFF2 theme-font fixture shipped with a reference PDF but no test running it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { woff2 } from 'fonteditor-core';
import type { FontConverter } from '@asciidocollab/asciidoc-pdf';

/** The vendored codec wasm, kept in sync with `scripts/build-woff2-wasm.mjs`. */
const WOFF2_WASM_PATH = path.join(process.cwd(), 'public', 'vendor', 'woff2', 'woff2.wasm');

let initialization: Promise<void> | null = null;

function ensureCodecReady(): Promise<void> {
  // `woff2.init` resolves with the codec handle; the callers only need to know it is ready. Discard
  // it explicitly so the memoised promise's type matches, and clear the slot on failure so a later
  // call retries rather than re-awaiting a rejected promise forever.
  initialization ??= woff2
    .init(readFileSync(WOFF2_WASM_PATH).buffer as ArrayBuffer)
    .then(() => undefined)
    .catch((error: unknown) => {
      initialization = null;
      throw error;
    });
  return initialization;
}

/**
 * Build the harness's WOFF2→TTF/OTF font converter.
 *
 * @returns A {@link FontConverter} backed by the vendored codec wasm.
 */
export function nodeFontConverter(): FontConverter {
  return {
    async woff2ToTtf(bytes: Uint8Array): Promise<Uint8Array> {
      await ensureCodecReady();
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return woff2.decode(copy.buffer);
    },
  };
}
