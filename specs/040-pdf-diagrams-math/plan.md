# Implementation Plan: Diagrams & Math in PDF Export, Editor Diagram Highlighting, and PDF Test-Coverage Hygiene

**Branch**: `040-pdf-diagrams-math` | **Date**: 2026-07-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/040-pdf-diagrams-math/spec.md`

## Summary

Complete feature 039's deferred diagram (FR-007) and math (FR-008) rendering by making the existing,
parity-proven `diagrams-math` pipeline stage reachable from the real in-browser PDF export and live
preview, without breaking the zero-source-egress guarantee. The blocker is that some render shims need a
browser DOM the dedicated PDF Web Worker lacks. The approach pushes rendering into the worker wherever
possible and keeps the smallest possible main-thread footprint: **math** moves into the worker via
MathJax's DOM-free adapter (`mathjax-full`/liteAdapter); **graphviz** and **vega** already run headless
in the worker; **mermaid** — the one engine that genuinely needs real DOM layout — renders in a
**main-thread pre-pass scheduled in idle time** (`requestIdleCallback`, time-sliced), content-addressed
with the exact same pure hash the worker stage uses, and **pre-seeded into the worker's asset cache** so
mermaid blocks resolve as cache hits. The worker protocol stays one-directional and the render stays
deterministic. This shrinks the Principle XIII main-thread exposure to **mermaid only, off the critical
typing path**. (A short spike verifies math parity after the MathJax integration switch.)

Alongside, three parallel deliverables: (2) **editor diagram highlighting** — distinct block
declarations plus per-language inner highlighting via the in-repo `parseMixed` nesting (JSON for
vega/vega-lite, a DOT StreamParser for graphviz, `codemirror-lang-mermaid` + a lexical fallback for
mermaid); (3) **diagrams in the HTML preview** — native on-screen rendering injected via the existing
MathJax-style post-render hook with a separate SVG-profile sanitizer; and (4) **CI hygiene** — run the
`asciidoc-pdf` unit suite in the gate + CI, and add a WOFF2 custom-font parity fixture.

## Technical Context

**Language/Version**: TypeScript 5.x (Node 22 / pnpm workspace), React 19 / Next.js (apps/web), ESM.

**Primary Dependencies**: `@asciidocollab/asciidoc-pdf` (browser-only render engine, ruby.wasm /
Asciidoctor-PDF), `mermaid@11.16.0`, `@hpcc-js/wasm` (graphviz), `vega`/`vega-lite`, MathJax — self-hosted
browser build (`/vendor/mathjax`) for the HTML preview + **new** `mathjax-full`/liteAdapter (DOM-free) for
the worker PDF math path, CodeMirror 6 / Lezer (`@codemirror/language`, `@lezer/common` parseMixed,
`@codemirror/lang-json`, `@codemirror/legacy-modes`), **new**: `codemirror-lang-mermaid` (MIT);
`fonteditor-core` (already present) for the Node WOFF2 converter.

**Storage**: N/A (client-side rendering; generated assets are in-memory, content-addressed). No DB
schema change.

**Testing**: Jest (unit, per package incl. the newly-gated `@asciidocollab/asciidoc-pdf`), Playwright
(e2e + the standalone `pdf-parity` project), the Node real-wasm parity integration suite
(`packages/asciidoc-pdf/tests/integration/parity.integration.test.ts`). TDD via the `/tdd` skill
(Principle II).

**Target Platform**: Modern browsers (Chromium-class for the wasm/pdf path); the dedicated PDF Web
Worker + the AsciiDoc→HTML render worker; the editor runs on the main thread.

**Project Type**: Web application (pnpm monorepo: `apps/web`, `apps/api`, `apps/collab`, `packages/*`).

**Performance Goals**: Editor typing never blocked (Principle XIII); live preview updates ride the
existing 1500 ms debounce; diagram/math pre-render is off the critical typing path and coalesced;
identical source never re-renders (content-addressed, Principle XII).

**Constraints**: Zero source egress (Principle X) — no diagram/math source or referenced URL leaves the
client; remote resources skipped-with-warning (FR-027). Reference-build parity for PDF output
(Principles XI/XV). Shared preview sanitizer MUST NOT be weakened (Principle VIII). All rendering
sandbox-confined (Principle XIV).

**Scale/Scope**: Four workstreams; ~6 user stories, 28 FRs. No new backend surface. Bounded net-new
code: one main-thread pre-pass, one shared detector, editor grammar/highlighting extensions, one
preview render module, CI edits + one parity fixture.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v2.6.0. Re-check after design.*

| Principle | Status | Notes |
|---|---|---|
| II — TDD (NON-NEGOTIABLE) | PASS | Every functional task runs through `/tdd`. Fidelity-critical PDF behavior gets comparison tests (XV). |
| IV — Reuse Before Rebuild | PASS | Reuses the diagrams-math stage/shims, the in-repo parseMixed nesting, `lang-json`, `codemirror-lang-mermaid`, the existing MathJax post-render infra, the parity harness. Hand-authoring is limited to a DOT StreamParser + a mermaid lexical fallback where no maintained grammar exists (documented, user-approved). |
| VI — Style Isolation | PASS | Preview diagram SVG is injected into the scoped preview container only; no app-chrome restyle. |
| VIII — Editor Pipeline Integrity | PASS (called out) | Extends the in-repo Lezer grammar and embeds source languages for highlighting — **explicitly permitted** by VIII. Embedded diagram text is inert (never executed). Preview diagram SVG is sanitized by a **separate** SVG-profile DOMPurify call; the shared `html`-profile sanitizer is **not** weakened, widened, or forked. Scroll-sync seam untouched. |
| IX — Untrusted Input Boundary (NON-NEGOTIABLE) | PASS | Diagram source treated as inert data (mermaid `securityLevel:'strict'`, vega `renderer:'none'` + remote-blocking loader, graphviz pure wasm); rendered SVG passes a sanitizer barrier before injection. |
| X — No Source Egress (NON-NEGOTIABLE) | PASS | All rendering client-side; vega remote loader kept; remote data/image URLs skipped-with-warning (FR-027), never fetched. |
| XI — Reference-Build Parity (NON-NEGOTIABLE) | PASS | PDF diagram/math/WOFF2 output verified against reference build via parity fixtures (T012/T014/T024) — the PDF export **and** live PDF preview remain fully parity-bound. The exception is **scoped strictly to the HTML on-screen preview** (a distinct rendering surface, never the PDF oracle): a **documented, spec-level exception** (native on-screen, not parity-bound, FR-024). XI is not traded away on the PDF path. |
| XII — Deterministic Output | PASS | Content-addressing preserved end-to-end; main-thread pre-pass reuses the same pure `computeSourceHash`; mermaid `deterministicIds`, MathJax `fontCache:'local'`. |
| XIII — Non-Blocking Responsiveness | PASS (minimized, called out) | Math renders in the worker (`mathjax-full`/liteAdapter); graphviz/vega already in the worker. **Only mermaid** is main-thread-bound (no reliable off-thread path) and runs off the critical typing path — idle-scheduled + time-sliced + coalesced + content-addressed + cancellation-guarded (see Complexity Tracking). Not a waiver; the heavy wasm convert stays in the worker and the PDF export pre-pass is user-triggered. |
| XIV — Sandbox-Safe Dependencies | PASS | All engines run in the browser sandbox; no subprocess/socket/native ext. |
| XV — Fidelity Verified Before Done | PASS | Diagrams, math, and fonts are named fidelity-critical; each ships a passing comparison test against reference output before done. |

**Result**: PASS. Two items are *called out* (VIII embedding + XIII main-thread rendering) rather than
waived; both are permitted/mitigated as noted. See Complexity Tracking for XIII.

## Project Structure

### Documentation (this feature)

```text
specs/040-pdf-diagrams-math/
├── plan.md              # This file
├── research.md          # Phase 0 output (complete)
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (internal interface contracts)
├── checklists/
│   └── requirements.md  # from /speckit-specify
└── tasks.md             # /speckit-tasks output (NOT created here)
```

### Source Code (repository root)

```text
packages/asciidoc-pdf/                     # browser-only render engine (feature 039 substrate)
├── src/pipeline/stages/diagrams-math.ts   # EXTRACT shared detectRenderableBlocks(); stage unchanged otherwise
├── src/protocol.ts                        # ADD RenderRequest.generatedAssets?: readonly GeneratedAsset[]
├── src/cache/content-address.ts           # (reused unchanged — pure hash)
├── src/index.ts                           # export the shared detector
└── package.json + jest.config.cjs         # ADD test:ci (coverage) — CI hygiene

apps/web/src/
├── lib/pdf/prerender-mermaid.ts           # NEW: main-thread, idle-scheduled mermaid pre-pass (detect → render → hash → GeneratedAsset[])
├── workers/asciidoc-pdf.worker.ts         # WIRE diagrams-math stage + graphviz/vega/worker-math shims + pre-seed mermaid cache
├── hooks/use-pdf-export.ts                # await mermaid pre-pass, attach assets, status
├── hooks/use-pdf-preview.ts               # same for live PDF preview
├── workers/shims/mathjax.ts               # SWITCH to mathjax-full/liteAdapter (DOM-free) → runs in the worker
├── workers/shims/{mermaid,graphviz,vega}.ts          # reuse; mermaid gains a native (preview) config export
├── workers/asciidoc-render.worker.ts      # HTML preview: diagram placeholder pass + diagramsPresent flag
├── hooks/use-asciidoc-preview.ts          # RenderResult.diagramsPresent + state
├── components/asciidoc-preview.tsx        # sibling post-render effect (mirror MathJax)
├── components/diagrams/render-diagrams.ts # NEW: main-thread render + SVG-profile sanitize + inject
└── lib/codemirror/                        # editor highlighting
    ├── asciidoc.grammar (+ regenerated asciidoc-parser.js/.terms.js)
    ├── asciidoc-block-token-logic.ts      # diagram declaration tokens
    ├── asciidoc-highlight-tags.ts         # ad.diagramDecl tag
    ├── asciidoc-theme.ts                  # theme rule for the declaration
    ├── asciidoc-source-highlight.ts       # diagram-aware body routing (parseMixed)
    ├── source-languages.ts                # engine → parser resolution
    └── diagram-langs/{mermaid,dot}.ts     # NEW: mermaid lexical fallback + DOT StreamParser
    # source-languages.ts holds the editor's OWN notation→parser map; a consistency test (below) asserts
    # its diagram-name set equals the renderer's — NO shared registry, NO editor→PDF coupling.

scripts/ci/unit.sh                          # ADD asciidoc-pdf test:ci step (wires gate + CI)
.github/workflows/ci.yml                    # OPTIONAL: add asciidoc-pdf coverage upload path
apps/web/e2e/pdf-parity/
├── fixtures/theme-fonts-woff2/**           # NEW WOFF2 fixture + committed reference.pdf
├── parity-render.mjs                       # run mount-assets (Node WOFF2 FontConverter) before convert
└── generate-reference.mjs                  # OPTIONAL: WOFF2 reference branch
```

**Structure Decision**: Existing monorepo layout; no new package. The one piece of *shared* code is the
exported `detectRenderableBlocks` detector in `packages/asciidoc-pdf` — used by the worker stage **and**
the main-thread mermaid pre-pass (same rendering concern, same package), so their cache keys can't drift.
There is **no shared diagram-name registry**: the renderer owns its `notation → shim` map (in
`asciidoc-pdf`) and the editor owns its `notation → parser` map (in `apps/web`, beside the highlighting
code) — separate concerns, separate maps. FR-015 ("editor's diagram set == renderer's diagram set") is
enforced by a single **consistency test**, not a shared module, avoiding both kernel pollution and an
editor→PDF-engine coupling. Everything else is app-local (web) or CI/test.

## Complexity Tracking

> Only the one genuinely-justified tension is recorded.

| Violation / Tension | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Principle XIII — **mermaid** renders on the **main thread** (not off-thread) | mermaid needs real DOM layout (`getBBox`/text metrics) that a Web Worker / jsdom cannot provide — the repo's own parity harness spins up a real browser page to render it. Math avoids this entirely (worker liteAdapter); graphviz/vega already run headless in the worker. So mermaid is the sole holdout. | *jsdom-in-worker*: rejected — no layout, mermaid text metrics break. *OffscreenCanvas*: rejected — mermaid renders SVG, not canvas. *Cross-origin iframe*: rejected — same-origin shares the main-thread event loop; a cross-origin isolated frame is heavy/fragile. *Server render*: rejected — Principle X. Mitigation keeps the principle's intent: mermaid renders **idle-scheduled** (`requestIdleCallback`) + **time-sliced** (yield between blocks), coalesced behind the preview debounce, content-addressed (renders once per unique diagram), cancellation-guarded; the heavy Ruby/wasm PDF convert stays in the worker; the PDF export pre-pass is user-triggered so it never competes with typing. |

**Accepted-deviation record for the mermaid main-thread render** (Architecture Constitution "Refactor & Drift Handling" requires rationale **and** a rollback plan): rationale above; **verification** — a responsiveness test (tasks T010) asserts input is serviced within an explicit budget while a worst-case mermaid diagram renders: the main-thread pre-pass yields at least every **50 ms** (time-slice ceiling) and a simulated keystroke is serviced within **100 ms** (RAIL interaction budget); preview updates coalesce behind the existing 1500 ms preview debounce (a concrete task, not an aspiration); **rollback** — if idle-time + time-slicing still regresses typing latency, fall back to render-on-demand for diagrams in the *live preview* (an explicit affordance) while the PDF export path is unaffected.

## Phase 1 outputs

- **data-model.md** — the render/transport entities and their invariants (GeneratedAsset transport,
  RenderableBlock detection record, diagram placeholder element, WOFF2 fixture manifest).
- **contracts/** — the internal interface contracts that must not drift: the `detectRenderableBlocks`
  detector signature, the `RenderRequest.generatedAssets` transport shape, the HTML-preview diagram
  placeholder DOM contract, and the FR-015 notation-set consistency seam (the renderer's public
  `DIAGRAM_NOTATIONS` name-set export + the editor↔renderer consistency test — no shared registry).
- **quickstart.md** — how to run each workstream's tests/gates and how to (re)generate the WOFF2
  reference PDF.
