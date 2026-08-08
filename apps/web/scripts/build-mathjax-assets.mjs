// Copies the self-hosted MathJax 4 browser bundle into the web app's public assets so the preview's
// STEM renderer can load it same-origin via a real `<script>` tag (see src/components/math/render-math.ts).
//
// Why a script tag instead of `import('mathjax/...')`: the `mathjax` npm package ships browser bundles
// with global side effects and a deferred startup, NOT ES modules. Webpack/Next can resolve them as
// modules in Node (jsdom tests), but in the browser bundle the startup never runs, so
// `globalThis.MathJax.typesetPromise` never appears and nothing renders. The supported browser path is a
// self-hosted `<script src=".../tex-mml-chtml.js">`; MathJax derives its component base URL from that
// script's src, so the AsciiMath input component requested via `loader.load: ['input/asciimath']`
// resolves to `/vendor/mathjax/input/...`.
//
// TWO trees are copied, because MathJax 4 split the fonts out of the engine:
//
//  1. The `mathjax` component bundles. In v3 these lived under `es5/`; in v4 that directory is gone and
//     the bundles sit at the package root, so this copies the root (minus the packaging metadata).
//
//  2. The default font, `@mathjax/mathjax-newcm-font`, into `fonts/mathjax-newcm-font/`. This is NOT
//     optional housekeeping: v4's loader defaults `paths.fonts` to `https://cdn.jsdelivr.net/npm/@mathjax`,
//     so without a self-hosted copy AND the `loader.paths.fonts` override in render-math.ts, the first
//     equation on a page reaches out to a CDN. v3 had no such default — the fonts were inside `es5/`.
//     Only the CHTML half is copied; the preview never uses the browser SVG output jax (the PDF worker
//     does its own SVG typesetting from `@mathjax/src`, with glyphs embedded per expression).
//
// Runs in predev/prebuild. Output is git-ignored generated data — do not edit by hand.

import { createRequire } from 'node:module';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const outputDir = resolve(here, '../public/vendor/mathjax');

// Packaging metadata that would be served as dead weight (and, for package.json, would expose the
// dependency tree). The bundles themselves are everything else at the package root.
const PACKAGING_FILES = new Set(['package.json', 'README.md', 'LICENSE', 'CONTRIBUTING.md', 'tsconfig.json']);

// A stale tree from a previous MathJax major is worse than no tree: v3's `es5/` layout would still be
// sitting here alongside v4's root bundles, and whichever the loader happened to find first would win.
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const mathjaxRoot = dirname(require.resolve('mathjax/package.json'));
cpSync(mathjaxRoot, outputDir, {
  recursive: true,
  filter: (source) => !PACKAGING_FILES.has(source.slice(mathjaxRoot.length + 1)),
});
console.log(`Copied the MathJax component bundles → public/vendor/mathjax/ (from ${mathjaxRoot})`);

const fontRoot = dirname(require.resolve('@mathjax/mathjax-newcm-font/package.json'));
const fontOutputDir = resolve(outputDir, 'fonts/mathjax-newcm-font');
mkdirSync(fontOutputDir, { recursive: true });
// `chtml.js` is the font component the loader fetches; `chtml/` holds the woff2 files the generated
// `@font-face` rules point at and the dynamic glyph chunks loaded on demand.
for (const entry of ['chtml.js', 'chtml']) {
  cpSync(resolve(fontRoot, entry), resolve(fontOutputDir, entry), { recursive: true });
}
console.log(`Copied the mathjax-newcm CHTML font → public/vendor/mathjax/fonts/ (from ${fontRoot})`);
