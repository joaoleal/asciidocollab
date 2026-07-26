// Vendors the Harper grammar engine's WebAssembly binary into the web app's public assets so the
// Harper linter (its dedicated worker) can fetch it same-origin — no CDN, no network — which keeps the
// on-device grammar checker working fully offline and guarantees no document text ever egresses.
//
// Unlike the Asciidoctor-PDF engine (built from a sibling Ruby package), Harper's wasm ships inside the
// `harper.js` npm package, so the source blob is normally present after `pnpm install`. This copier
// still NO-OPS GRACEFULLY when it is absent — it warns and exits 0 so the predev/prebuild chain never
// breaks on a machine where the dependency has not been installed yet (mirrors build-asciidoctor-pdf-wasm.mjs).
//
// We vendor BOTH the full (non-slim) and slim binaries: the app explicitly loads the full build (the
// slim flavor drops rules we rely on for grammar/style checks), but harper.js's worker bootstrap may
// also request the slim binary by its own same-origin URL, so both must be present to avoid a 404.
// Runs in predev/prebuild. Output is git-ignored generated data — do not edit by hand.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// The wasm sits in harper.js's dist/ alongside its binary loader. harper.js's `exports` map does not
// expose `./package.json` (so `require.resolve` is blocked) — resolve through the app's node_modules
// entry instead, which pnpm symlinks into place regardless of the flat/hoisted store layout.
const sourceDir = resolve(here, '../node_modules/harper.js/dist');
const outputDir = resolve(here, '../public/vendor/harper');

// Both wasm flavors harper.js ships: the full engine the app loads, and the slim engine its worker
// bootstrap may fetch by its own same-origin URL.
const binaries = ['harper_wasm_bg.wasm', 'harper_wasm_slim_bg.wasm'];

mkdirSync(outputDir, { recursive: true });

for (const binary of binaries) {
  const sourceWasm = resolve(sourceDir, binary);
  if (!existsSync(sourceWasm)) {
    console.warn(
      `[harper-wasm] source engine not found at ${sourceWasm} — skipping. ` +
        `Run "pnpm install" to enable on-device grammar checking.`,
    );
    continue;
  }
  copyFileSync(sourceWasm, resolve(outputDir, binary));
  console.log(`Copied Harper wasm engine → public/vendor/harper/${binary} (from ${sourceWasm})`);
}
