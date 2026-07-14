# Phase 0 Research: Diagrams & Math in PDF Export, Editor Diagram Highlighting, PDF Coverage Hygiene

**Feature**: 040-pdf-diagrams-math · **Date**: 2026-07-14

This document consolidates the investigation of the existing feature-039 substrate and resolves the
open technical questions before design. Four areas were researched: (1) the PDF render seam and how to
run DOM-bound renderers, (2) editor mixed-language highlighting, (3) the HTML-preview render path, and
(4) CI/quality-gate wiring and the parity harness.

---

## Decision 1 — Wiring diagrams/math into the real PDF export/preview

**Decision**: Push as much rendering as possible **into the worker**, and keep only the one genuinely
DOM-bound engine (mermaid) on the main thread, rendered **off the critical typing path** (idle-time,
time-sliced), with its output pre-seeded into the worker's asset cache. Specifically:
- **Math** moves **into the worker** via MathJax's DOM-free adapter (`mathjax-full` + `liteAdapter`),
  replacing the current browser-es5 MathJax integration for the PDF path. No main-thread math.
- **graphviz** (`@hpcc-js/wasm`, `engine.dot()`) and **vega** (`view.toSVG()`, `renderer:'none'`) already
  run headless — they render **in the worker** directly.
- **mermaid** genuinely needs real DOM layout (`getBBox`/text metrics) that a worker/jsdom cannot
  provide (this repo's own parity harness proves it — it drives a real Playwright browser page just to
  render mermaid). So mermaid renders in a **main-thread pre-pass scheduled in idle time**
  (`requestIdleCallback`) + time-sliced; content-addressed so each unique diagram renders once. Its
  `GeneratedAsset`s are attached to the render request and pre-seeded into the worker's cache, so the
  worker stage resolves mermaid blocks as cache hits and never invokes the (no-DOM) mermaid shim.

**Rationale**:
- Shrinks the Principle XIII main-thread exposure from "mermaid + MathJax" to **mermaid only, in idle
  time** — a real reduction, not just a mitigation (answers the "don't block the main page" requirement).
- The shim call site (`renderOrReuse`, `pipeline/stages/diagrams-math.ts`) is **cache-first**:
  `context.cache.get(sourceHash)` short-circuits `shim.render()`. On a hit the stage still writes the
  bytes to `/project/.gen/<hash>.<ext>` and rewrites the block to `image::`. This is the natural,
  no-new-protocol injection seam for the pre-seeded mermaid assets.
- `computeSourceHash({source, renderParams, shimVersion})` (FNV-1a, param-key-sorted, length-prefixed)
  is a **pure, deterministic** function — no clock/locale/network. The main thread computes the
  identical hash for mermaid and builds a `GeneratedAsset` the worker accepts verbatim.
- Keeps the worker message protocol **one-directional** (`render → progress* → result`).

**Alternatives considered**:
- *Render everything on the main thread* (my earlier draft): rejected — needlessly puts math on the main
  thread when MathJax has a DOM-free worker path.
- *Run mermaid off-thread* (jsdom-in-worker, OffscreenCanvas, cross-origin iframe): rejected — jsdom has
  no layout so mermaid text metrics break; mermaid renders SVG not canvas; a same-origin iframe shares
  the main-thread event loop. No reliable in-browser off-thread path for mermaid.
- *Mid-pipeline worker→main callback*: rejected — new bidirectional protocol, suspends `runPipeline`,
  complicates the staleness guard. Much higher churn.

**Spike required (math parity)**: switching the PDF math integration from browser-es5 MathJax to
`mathjax-full`/liteAdapter changes the code path that produces the math SVG. The committed math parity
reference was produced by the browser build, so a short **spike** must confirm the liteAdapter SVG
matches at the parity tolerance (and regenerate the math reference if the config/version differs) before
committing. This is a flagged task in `/speckit-tasks`.

**Critical risk — cache-key parity (mermaid)**: the main-thread mermaid pre-pass MUST produce the exact
same `sourceHash` as the worker stage — identical `source`, `params` (incl. the synthetic
`asciidoc-block-notation` param and `pos<N>` positional attrs), and `shimVersion`. **Mitigation**:
extract the block **detection + param-building** logic from `diagrams-math.ts` into a shared exported
helper (`detectRenderableBlocks`) used by both the stage and the pre-pass, and version-lock the mermaid
shim module.

**Secondary risks**:
- *Include expansion*: the stage runs on the include-assembled root; the main thread does not assemble.
  Resolve by scanning **all project text files** in the mermaid pre-pass — content-addressing makes
  identical source anywhere hash the same. Cost: a bounded number of wasted renders for unreferenced
  blocks.
- *Raster-fallback diagnostics / stats*: on a cache hit, `renderOrReuse` does not re-emit the
  raster-fallback diagnostic and `RenderStats.rasterFallbacks` is hardcoded `0`. If the mermaid pre-pass
  rasterizes, carry those diagnostics/counters alongside `generatedAssets`.
- *Progress UX*: the mermaid render happens before the worker starts; add a main-thread status so a
  slow mermaid bundle load doesn't read as a stall.

**Files/types touched**: `packages/asciidoc-pdf/src/protocol.ts` (add
`RenderRequest.generatedAssets?: readonly GeneratedAsset[]`); `pipeline/stages/diagrams-math.ts`
(extract + export `detectRenderableBlocks`); `packages/asciidoc-pdf/src/index.ts` (export it);
the **math shim** switches to a `mathjax-full`/liteAdapter converter that runs **in the worker**;
new `apps/web/src/lib/pdf/prerender-mermaid.ts` (main thread, idle-scheduled — mermaid only);
`apps/web/src/workers/asciidoc-pdf.worker.ts` (`buildPipeline`: add the stage; register the graphviz,
vega, and worker-math shims; pre-seed the cache from `request.generatedAssets` for mermaid);
`apps/web/src/hooks/use-pdf-export.ts` + `use-pdf-preview.ts` (await the mermaid pre-pass, attach assets,
status). New dep: `mathjax-full`.

---

## Decision 2 — Editor diagram highlighting (declaration + inner language)

**Decision**: Reuse the **existing in-repo `parseMixed` nesting** that already highlights
`[source,<lang>]` bodies. Extend it to diagram blocks: (a) add distinct **declaration** tokens for
`[mermaid]`/`[graphviz]`/`[vega]`/`[vegalite]` mirroring the existing `[stem]`/`[cols=]` special-casing;
(b) route diagram **body** spans to a per-engine parser — JSON for vega/vega-lite, a DOT StreamParser
for graphviz, and for mermaid `codemirror-lang-mermaid` (grammar-accurate types) + a lexical
StreamParser fallback (all other types).

**Rationale**:
- `parseMixed` + `overlay: [blockBodySpan]` is **already wired** (`asciidoc-source-highlight.ts`,
  `sourceMixedWrap`) and already scopes nested parsing to the block body without bleeding into
  surrounding AsciiDoc. No new nesting infrastructure needed — the loader/cache/`reparse(fresh:true)`
  plumbing is reusable as-is.
- **vega/vega-lite is free**: `@codemirror/lang-json@6.0.2` (MIT) is already installed and already in the
  `ALLOWLIST`; only the *routing* of `[vega]` bodies to it is new (they aren't `[source,json]`, so the
  existing mix doesn't fire on them).
- **DOT is low-risk**: small, stable grammar; a `StreamLanguage` StreamParser (the `@codemirror/legacy-modes`
  model, MIT, already installed) is genuinely faithful.
- **Declaration highlighting** follows the established `[stem]`/`[NOTE]`/`[cols=]` pattern in the
  external tokenizer (`asciidoc-block-token-logic.ts`) → new grammar node → `styleTags` → theme rule.

**Mermaid (resolved via clarification)**: No maintained grammar covers all ~20+ mermaid diagram types
(`codemirror-lang-mermaid`, MIT, covers ~5–6; mermaid's own `@mermaid-js/parser` is Langium, unusable
for CM highlighting). Per the user decision (amends FR-021/SC-010): **reuse `codemirror-lang-mermaid`
for its covered types + a generic lexical StreamParser for the rest** (diagram-type keyword, `%%`
comments, quoted labels, `-->`/`---`/`==>` edges, node-shape brackets). Every type is highlighted;
grammar-accurate where a maintained grammar exists, consistent lexical otherwise. Honors
Reuse-Before-Rebuild (Principle IV); hand-authoring ~20 grammars is explicitly out of scope.

**Alternatives considered**: uniform lexical-only for all mermaid types (simpler, but not
grammar-accurate even for flowchart/sequence — rejected as lower fidelity for the common cases);
full grammar for all types (rejected — Principle IV conflict, very large effort/maintenance).

**Files/types touched**: `asciidoc-block-token-logic.ts` (diagram declaration branches);
`asciidoc.grammar` + regenerate `asciidoc-parser.js`/`.terms.js`; `asciidoc-highlight-tags.ts` (new
`ad.diagramDecl` tag); `asciidoc-theme.ts` (theme rule); `asciidoc-source-highlight.ts` (diagram-aware
body routing + loader entries); `source-languages.ts` (engine→parser resolution); new
`mermaid`/`dot` StreamParser modules; `apps/web` deps: `codemirror-lang-mermaid`.

**FR-015 consistency — no shared registry**: the renderer and the editor are **separate concerns with
separate maps**: the renderer maps `notation → render shim` (in `asciidoc-pdf`), the editor maps
`notation → highlight parser` (in `apps/web`, beside the highlighting code). They share no logic, only
the *set of diagram notation names* must stay consistent (FR-015). So there is **no shared registry** and
no cross-package constant to place: each concern owns its own map, and FR-015 is enforced by a small
**consistency test** asserting the editor's diagram-name set equals the renderer's. (This supersedes the
earlier "shared diagram block-name registry" idea, which over-coupled a rendering concern to the editor.)

**Constitution note (VIII)**: this is "extending the in-repo Lezer grammar / embedding a source language
for highlighting," which Principle VIII explicitly permits provided the embedded text is treated as
**inert data** (it is — highlighting never executes it) and the sanitizer is not weakened (highlighting
does not touch the render/sanitize path at all).

---

## Decision 3 — Diagrams in the HTML preview

**Decision**: Mirror the existing **MathJax post-render pattern**. The AsciiDoc→HTML worker emits a
locatable placeholder element per diagram block (carrying engine name + inert source) plus a
`diagramsPresent` flag; the main thread, gated on that flag, lazy-imports a new `render-diagrams`
module that finds each placeholder, renders it to SVG with the engine's **native** (on-screen) config,
sanitizes that SVG with a **separate SVG-profile DOMPurify call**, and injects it idempotently into the
scoped preview container.

**Rationale**:
- The MathJax hook (`asciidoc-preview.tsx`) is a proven template: gated on a worker flag
  (`mathPresent`), lazy `import()`, runs after the sanitized HTML is committed, scoped to the container,
  `cancelled` guard, idempotent source-restore. Diagrams slot in as a **sibling effect**.
- The shared preview sanitizer is `DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })` — it
  **strips inline SVG**. Principle VIII forbids weakening it. So SVG must be injected **after** that
  call and sanitized **separately** with an SVG profile (`{ USE_PROFILES: { svg: true, svgFilters: true } }`),
  confining the SVG allow-list to diagram output only.
- Native on-screen fidelity (per clarification) means a **different mermaid config** than the PDF path's
  prawn-svg-constrained `buildMermaidConfig()` (which forces `htmlLabels:false`/no-foreignObject). The
  mermaid shim already takes `config` as a parameter, so the preview passes its own; graphviz/vega
  engine calls are reused as-is (vega keeps its remote-blocking loader — no egress).

**Rationale — non-blocking (Principle XIII)**: rendering rides the existing 1500 ms preview
debounce/coalescing (the effect keys on `[html, diagramsPresent]`, which only changes after the
debounced worker round-trip); engines run async per-diagram with a `cancelled` guard and per-diagram
try/catch, so one slow/bad diagram never blocks typing or breaks the preview.

**Alternatives considered**: registering `asciidoctor-diagram` in the render worker (rejected — the
worker has no DOM either, and diagram engines are DOM/wasm-bound; and it would try to run engines the
same way the PDF worker can't); widening the shared sanitizer to allow SVG (rejected — Principle VIII).

**Files/types touched**: `apps/web/src/workers/asciidoc-render.worker.ts` (placeholder pass +
`diagramsPresent`); `use-asciidoc-preview.ts` (`RenderResult.diagramsPresent`, state, return);
`asciidoc-preview.tsx` (sibling post-render effect); new `apps/web/src/components/diagrams/render-diagrams.ts`;
reuse `workers/shims/{mermaid,graphviz,vega}.ts` engine calls with a native mermaid config.

---

## Decision 4 — CI/quality-gate hygiene

**Decision (asciidoc-pdf tests)**: Add a `test:ci` script to `packages/asciidoc-pdf/package.json` and a
single step to `scripts/ci/unit.sh` invoking it. Because `ci.yml`'s `unit` job is a pure wrapper of
`unit.sh`, this one edit wires the package's 90%-threshold coverage into **both** the local gate and CI.
Optionally add `packages/asciidoc-pdf/coverage/` to the ci.yml coverage-upload path list.

**Rationale**: `unit.sh` today runs six suites (asciidoc-core, shared, domain, api, collab, web) and
omits asciidoc-pdf; its jest config already enforces `global: 90` on all metrics and currently sits at
100%, so enabling it is safe. The top-level `pnpm -r build` already builds the package, so no ordering
change. The two `tests/integration/*.test.ts` suites `describe.skip` without a built wasm engine, so
they don't run or affect coverage in the unit job.

**Decision (WOFF2 parity fixture)**: Add `fixtures/theme-fonts-woff2/` mirroring the TTF `theme-fonts`
fixture but with `.woff2` fonts referenced by the theme; make the **Node parity harness run the
`mount-assets` stage** (via a Node `FontConverter` using `fonteditor-core`'s `woff2.decode` against the
vendored `/vendor/woff2/woff2.wasm`) so WOFF2 is decoded in place before convert; generate the
`reference.pdf` with the existing `generate-reference.mjs` (Docker `asciidoctor-pdf` + `-a reproducible`,
`SOURCE_DATE_EPOCH=1704067200`) from decoded-TTF bytes stored at the `.woff2` filenames (prawn keys on
the sfnt signature, not the extension).

**Rationale**: prawn/asciidoctor-pdf embeds TTF/OTF only; the app makes WOFF2 embeddable via
`mount-assets` (decode-in-place). But **neither parity harness runs `mount-assets` today**, so a naive
WOFF2 fixture would fall back to the default font and prove nothing. Running `mount-assets` in the Node
harness is the load-bearing change. `parity.integration.test.ts` auto-discovers any fixture with a
manifest and no `ink`/`variants`, asserts `allFontsEmbedded === true`, and self-skips until both the
engine and `reference.pdf` exist — so CI stays green in the interim.

**Files/types touched**: `packages/asciidoc-pdf/package.json` (`test:ci`); `scripts/ci/unit.sh` (+1
step); `.github/workflows/ci.yml` (optional coverage path); new
`apps/web/e2e/pdf-parity/fixtures/theme-fonts-woff2/**` (+ committed `reference.pdf`);
`apps/web/e2e/pdf-parity/parity-render.mjs` (run mount-assets with a Node WOFF2 FontConverter);
possibly `apps/web/e2e/pdf-parity/generate-reference.mjs` / `tools/build-references.mjs` (WOFF2 branch).

---

## Cross-cutting constitutional resolutions

- **Principle XIII (Non-Blocking)**: minimized by construction. Math moves into the worker
  (`mathjax-full`/liteAdapter); graphviz/vega already render in the worker. **Only mermaid** remains
  main-thread (no reliable in-browser off-thread path), and it runs off the critical typing path —
  idle-scheduled (`requestIdleCallback`), time-sliced, coalesced behind the preview debounce,
  content-addressed (renders once per unique diagram), `cancelled`-guarded. Documented in the plan's
  Constitution Check + Complexity Tracking as an accepted, minimized deviation (not a waiver); the PDF
  export pre-pass is user-triggered so it never competes with typing.
- **Principle X (No Source Egress)**: FR-027 aligns with the existing rule — vega's remote-blocking
  loader is kept; remote data `url`s and remote images are skipped-with-warning, never fetched.
- **Principle XI/XV (Reference Parity, Fidelity Verified)**: PDF diagram/math/WOFF2 outputs are
  fidelity-critical and get comparison tests against reference output (parity fixtures). The **HTML
  preview** diagrams are explicitly **not** parity-bound (native on-screen rendering, per clarification)
  — a documented, spec-level exception, since the preview is a screen view not the fidelity oracle.
- **Principle IV (Reuse Before Rebuild)**: drives every highlighting choice — lang-json for vega,
  codemirror-lang-mermaid for mermaid's covered types, StreamParsers only where no maintained grammar
  exists (DOT, mermaid fallback).
- **Principle XII (Deterministic)**: content-addressing is preserved end-to-end; the main-thread pre-pass
  reuses the same pure hash. mermaid `deterministicIds`, MathJax `fontCache:'local'` retained.
