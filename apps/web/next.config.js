const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep the dev server's build dir SEPARATE from the production build's.
  //
  // Both used to be `.next`: `next dev` keeps its Turbopack cache in `.next/dev` while `next build`
  // owns `.next/server`, `.next/static` and BUILD_ID. Six scripts (gate.sh, unit.sh, integration.sh,
  // quality.sh, e2e*.sh via `pnpm -r build`) write a production build there, and the sharing was
  // deliberate — see the notes in scripts/ci/gate.sh and scripts/ci/e2e-local.sh.
  //
  // It is not survivable, though. A production build rewrites those directories out from under the
  // dev cache, which then mass-invalidates and re-runs every CSS transform. Measured on this repo:
  // compiling `/` against such a mixed `.next` spawned 200 postcss child processes, peaked at
  // 12.5 GB, and had not finished after 5 minutes. The same page against a clean cache: 7.6s, 5.5 GB,
  // 3 processes. So dev gets its own directory and the two never touch.
  //
  // Only scripts/dev.sh sets this (to .next-dev); every other path — CI, e2e, `next start`, the
  // Docker build, which copies .next/standalone and .next/static — keeps the default `.next`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Emit a self-contained server bundle (.next/standalone) for the production
  // Docker image — Next traces exactly the node_modules the server needs.
  output: 'standalone',
  // The traced root must be the monorepo root so workspace deps are included.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // Cap the build's worker pool. Next otherwise sizes the static-generation jest-worker pool to
  // (core count - 1) — 23 children on this 24-core box, each loading the whole app module graph.
  //
  // What is certain: a `next build` here once reached 588 node processes / 21.7 GB and the OOM-killer
  // took the desktop with it; and with this cap the build reports "Collecting page data using 4
  // workers" and peaks at ~7 jest-workers / 22 node processes.
  //
  // What is NOT established: which pool those 588 processes belonged to. They were only ever seen in
  // a kernel OOM dump, where node reports comm `MainThread`, so they were never attributed. The
  // jest-worker pool was inferred from the "using 23 workers" line, but `next build` also drives
  // Turbopack's postcss ChildProcessPool, which has separately been caught at 200 children (see the
  // distDir note above). It may well have been that pool, or both. Keep this cap regardless — it is
  // cheap (a 4-worker build is not measurably slower here) and it bounds the one pool we can bound.
  experimental: {
    cpus: 4,
  },
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
