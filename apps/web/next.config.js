const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle (.next/standalone) for the production
  // Docker image — Next traces exactly the node_modules the server needs.
  output: 'standalone',
  // The traced root must be the monorepo root so workspace deps are included.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: [
    '@asciidocollab/asciidoc-core',
    '@asciidocollab/asciidoc-pdf',
    '@asciidocollab/shared',
    '@dicebear/core',
    '@dicebear/styles',
  ],
  // Asciidoctor-PDF WebAssembly engine — asset handling:
  //
  // The engine is a large `.wasm` blob vendored into public/vendor/asciidoctor-pdf/ and fetched +
  // instantiated at runtime by the PDF worker. As a file under public/ it is served verbatim
  // same-origin with the correct application/wasm type, so it needs no bundler loader — it is never
  // imported into the module graph. Any `.wasm` that IS imported by a worker shim is handled
  // natively by the bundler's WebAssembly support (async instantiation), so no custom rule is added.
  //
  // No COOP/COEP cross-origin-isolation headers: the engine uses the single-threaded ruby.wasm build,
  // so there is no SharedArrayBuffer and cross-origin isolation is unnecessary. Adding those headers
  // would isolate the whole app and could break other same-origin assets, for no benefit here.
  turbopack: {
    resolveAlias: {
      // The citations shim pulls in `@citation-js/core`, whose `util/fetchFile.js` statically imports
      // `node-fetch` and `sync-fetch`. Both drag in Node built-ins (`fetch-blob` → node:fs/node:net;
      // sync-fetch → node:child_process) that cannot be bundled for the browser/worker. Neither is ever
      // invoked at runtime here (a worker uses the native `fetch`; the sync path is unused), so alias
      // both to browser stubs to keep the Node-only chains out of the client bundle. See the stub files.
      'node-fetch': './src/workers/shims/node-fetch-browser.js',
      'sync-fetch': './src/workers/shims/sync-fetch-browser.js',
    },
  },
};

module.exports = nextConfig;
