# @asciidocollab/asciidoc-pdf

The browser-only leaf capability that renders an AsciiDoc project to a print-ready PDF **entirely in
the client** — no server, no network — by running the real Asciidoctor-PDF Ruby gem compiled to
WebAssembly (CRuby `wasm32-wasip1`) inside a long-lived Web Worker.

The point of shipping the actual gem, rather than reimplementing it, is fidelity: the output is meant
to match what the canonical Asciidoctor-PDF toolchain produces, down to element-level layout, fonts,
and colour (see [Reference-parity fixtures](#reference-parity-fixtures)).

## What lives here

This package holds the **environment-agnostic engine** — everything that does not need a DOM:

- **`protocol`** — the cross-boundary DTOs and the `postMessage` protocol between the main thread and
  the PDF worker (`RenderRequest`/`RenderResult`/`RenderDiagnostic`/`RenderError`, progress phases).
  Whole-render failures cross the boundary as data; per-resource problems ride inside a successful
  render as diagnostics, so partial success is the norm.
- **`vm/wasi-bridge`** — the single typed adapter over the untyped, ESM-only interop libraries
  (`@ruby/wasm-wasi` + `@bjorn3/browser_wasi_shim`). Every interop cast is confined here, behind a
  narrow `WasiBridge` interface, so no `any`/`as` leaks into the rest of the package.
- **`vm/ruby-pdf-vm`** — the warm-VM lifecycle facade. One Ruby VM is instantiated per session (the
  cold start) and reused for every subsequent render.
- **`vfs/populate`** — maps a `ProjectSnapshot` into the in-memory `/project` WASI filesystem the VM
  sees, and reads the produced PDF back out of `/out`. Re-validates every path as defense in depth
  (no traversal, absolute, remote, or NUL-bearing keys reach the VFS).
- **`cache/content-address`** — a content-addressed, logical-tick LRU cache for generated
  diagram/math/bibliography assets, keyed by a hash of *what was rendered from*. Identical source →
  identical bytes → cache hit and stable placement.
- **`pipeline/orchestrator` + `pipeline/stages/*`** — the fixed-order pre-processing pipeline
  (`include-resolve` → `citations` → `diagrams-math` → `image-guard` → `mount-assets` → `convert`).
  Each earlier stage rewrites the in-memory VFS the later stages read. The orchestrator implements no
  stage itself; concrete stages are injected.
- **`convert/invoke` + `convert/normalize-pdf`** — drives `Asciidoctor.convert_file(..., backend:
  'pdf')` in the warm VM, reads the PDF back, and neutralizes ambient nondeterminism (creation/mod
  dates and the document `/ID`) so identical inputs yield byte-stable output.
- **`ports/*`** — the seams the app supplies at the composition root: the rendering shims
  (mermaid/graphviz/vega/mathjax/citation-js) and the shared include-tree assembler. These are
  interfaces only; the DOM-bound implementations live in `apps/web`.

The DOM-bound rendering shims, the worker host, and the export/preview UI stay in **`apps/web`**,
which supplies the concrete adapters. Because every collaborator is injected, the whole engine is
unit-testable with in-memory fakes.

### Architecture boundary

This package depends inward on `@asciidocollab/asciidoc-core` **only**. It is a one-directional
browser leaf: it **must never** be imported by the domain, application, or infrastructure rings, nor
by any app's server code. The web app is the sole consumer, and only from its browser/worker layer.

## Building / re-syncing the wasm engine

The engine binary (`ruby/asciidoctor-pdf.wasm`) is a large, git-ignored **generated** artifact. Do
not hand-edit it — it is fully re-syncable from its pinned inputs.

### Pinned inputs

- **`ruby/Gemfile`** + **`ruby/Gemfile.lock`** — the pinned gem closure: `asciidoctor`,
  `asciidoctor-pdf`, `prawn-svg`, `prawn-templates`, `rouge`, `text-hyphen`, and the `js` host
  bridge, plus their transitive dependencies. Every gem must be pure Ruby (no C extension that
  survives the `wasm32-wasip1` closure), because the engine runs in the WASI sandbox with no
  subprocess, no socket, and no native extension loading. To change the closure, edit the `Gemfile`
  and re-resolve the lockfile — never edit the `.wasm`.
- **`ruby/build-wasm.sh`** pins the toolchain versions (`RUBY_WASM_VERSION`, `RBWASM_RUBY_VERSION`, the
  `wasm32-wasip1` target) and a fixed `SOURCE_DATE_EPOCH` so identical inputs produce a stable
  artifact. Bump the pins deliberately and re-run.

### How the build works

`ruby/build-wasm.sh` does three things:

1. **Vendors** the pinned gem closure from the frozen lockfile (`force_ruby_platform`, no dependency
   drift).
2. **Fails closed** on any native extension: if a compiled `.so`/`.bundle`/`.dylib` or a gem shipping
   an `extconf.rb` build recipe enters the tree, the build aborts rather than shipping something that
   cannot load in the sandbox. The sole exception is the `js` host bridge, whose extension is compiled
   to wasm and statically linked in.
3. **Compiles** CRuby with `rbwasm` and bakes the full stdlib + gem closure into the engine's in-image
   virtual filesystem under `/usr` via wasi-vfs, emitting a single self-contained `asciidoctor-pdf.wasm`.

Running it requires a host **Ruby 3.3** toolchain on PATH (plus a host C toolchain to compile CRuby).
The `ruby_wasm` gem — which provides the `rbwasm` CLI and bundles wasi-vfs — is installed by the
script itself if absent, pinned to `RUBY_WASM_VERSION`. The first run downloads the wasi-sdk and
builds CRuby, which is slow; `ruby/build` + `ruby/rubies` cache it so subsequent runs are fast.

```bash
# Requires a host Ruby 3.3 (rbenv/asdf/rvm or system). rbwasm is auto-installed on first run.
pnpm --filter @asciidocollab/asciidoc-pdf build:wasm      # → bash ruby/build-wasm.sh
```

> **Note — host header removal.** The `js` host bridge is compiled once for the host (during
> `bundle install`) and once for wasm (by rbwasm); to stop the host Ruby headers from shadowing the
> wasm headers, the build removes the running Ruby's header dir after vendoring. Because that deletes
> your Ruby's dev headers, it only runs automatically under CI (`$CI`); locally it is skipped and you
> opt in with `WASM_STRIP_HOST_HEADERS=1` if the js wasm compile fails with `'ruby/config.h' file not
> found`. CI builds this via `ruby/setup-ruby` (see the `pdf-wasm` job), whose `/opt/hostedtoolcache`
> prefix keeps it off the default include path.

### Optional: PDF optimize (hexapdf) is intentionally unbaked

Post-convert PDF optimization (the `hexapdf` gem) is deliberately **left out** of the closure: it
hard-depends on compiled native extensions that cannot be built for, or loaded inside, the
no-compiler WASI sandbox. It is an optional capability — the convert path probes for the optimizer
in-VM, and when it is absent simply skips the optimize pass, still emitting a valid PDF and recording
a non-fatal notice. If a pure-Ruby optimizer ever becomes viable, it can be re-added to the `Gemfile`.

### How the blob is vendored + served

The web app never fetches the engine from a CDN. `apps/web/scripts/build-asciidoctor-pdf-wasm.mjs`
copies the built `ruby/asciidoctor-pdf.wasm` verbatim into
`apps/web/public/vendor/asciidoctor-pdf/`, so the worker fetches it **same-origin** and caches it
immutably. That copier runs in the web app's `predev`/`prebuild` and **no-ops gracefully** when the
binary has not been built yet — it warns and exits 0 so the dev/build chain never breaks on a machine
that has not run the wasm build. Because it is single-threaded (no `SharedArrayBuffer`), the app needs
no COOP/COEP cross-origin-isolation headers.

## Reference-parity fixtures

Faithfulness to the reference toolchain is verified against a team-maintained corpus of parity
fixtures. Each fixture is:

- a **project source** (main file + includes + theme YAML + fonts + images) — exactly what a user
  would export;
- a **committed reference PDF** produced by the **external** Asciidoctor-PDF CLI/Maven build (never
  the in-app export);
- a **manifest** (`manifest.json`) that records the element-level **tolerance** at which the two PDFs
  are diffed page-by-page.

The corpus, the manifest format, and the procedure for adding a fixture live in
[`apps/web/e2e/pdf-parity/fixtures/README.md`](../../apps/web/e2e/pdf-parity/fixtures/README.md).
Comparison is element-level, not byte- or pixel-identical: the recorded tolerance absorbs sub-pixel
antialiasing and rasterizer noise while still catching real layout, font, and colour divergence. The
`normalize-pdf` step in this package is what makes that diff meaningful — it removes the ambient
timestamp/ID nondeterminism before comparison.

## Testing

- **Unit tests** (`tests/`) cover the engine in isolation with in-memory fakes for the orchestrator,
  each pipeline stage, the content-addressed cache, the protocol validators, the WASI bridge, the
  warm-VM facade, the VFS population, and the convert invocation / PDF normalization:

  ```bash
  pnpm --filter @asciidocollab/asciidoc-pdf test
  pnpm --filter @asciidocollab/asciidoc-pdf build   # tsc type-check / emit
  ```

- **Integration / e2e / parity** tests live in the web app (they need a real browser: the shims are
  DOM-bound and pdf.js rasterization needs a canvas). The visual parity spec runs under Playwright:

  ```bash
  pnpm --filter @asciidocollab/web e2e -- pdf-parity
  ```

  The parity run activates only once the wasm engine is vendored **and** at least one fixture with a
  committed reference PDF exists; until then it skips with a clear message so CI stays green.
