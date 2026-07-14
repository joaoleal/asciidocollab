---
description: "Task list for feature 040 — Diagrams & Math in PDF Export, Editor Diagram Highlighting, and PDF Test-Coverage Hygiene"
---

# Tasks: Diagrams & Math in PDF Export, Editor Diagram Highlighting, and PDF Test-Coverage Hygiene

**Input**: Design documents from `/specs/040-pdf-diagrams-math/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/internal-contracts.md

**Implementation**: Every task below MUST be executed via the `/tdd` skill (Constitution §II — TDD
NON-NEGOTIABLE). Tasks describe WHAT to deliver; the skill owns the red-green-refactor cycle. One
deliverable = one task = one `/tdd` invocation — do **not** split a task into separate "write test" /
"write implementation" tasks.

**Path convention**: Test files live under the package/app `tests/` root mirroring `src/` (never
`__tests__/`, never co-located). e.g. `packages/asciidoc-pdf/src/pipeline/stages/diagrams-math.ts` →
`packages/asciidoc-pdf/tests/pipeline/stages/diagrams-math.test.ts`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task).
- **[Story]**: US1–US6 traceability (Setup/Foundational/Polish carry no story label).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Bring in the two new dependencies the plan requires. No new package/project structure.

- [X] T001 Add `mathjax-full` (DOM-free `liteAdapter` math path for the worker) to `apps/web/package.json` and install; confirm it resolves in the worker build (no `window`/DOM references pulled into the bundle).
- [X] T002 [P] Add `codemirror-lang-mermaid` (MIT) to `apps/web/package.json` and install; confirm it imports under the editor build.

---

## Phase 2: Foundational (Blocking Prerequisites for US1, US2, US3)

**Purpose**: The shared PDF-pipeline plumbing that the diagram (US1) and math (US2) rendering paths both
depend on. **US4 (editor), US5 (CI), and US6 (HTML preview) do NOT depend on this phase** and may begin
after Setup.

**⚠️ CRITICAL**: US1/US2/US3 work cannot begin until this phase is complete.

- [X] T003 Extract a shared `detectRenderableBlocks(text): RenderableBlock[]` from the existing detection logic in `packages/asciidoc-pdf/src/pipeline/stages/diagrams-math.ts`, export it from `packages/asciidoc-pdf/src/index.ts`, and refactor `createDiagramsMathStage()` to consume it (do not fork the logic). Includes the **cache-key parity test** (Contract A) asserting the detector's `(source, params)` output is byte-identical to what the stage feeds `computeSourceHash` — the highest-risk seam. Excludes `plantuml`/`ditaa`. Files: `packages/asciidoc-pdf/src/pipeline/stages/diagrams-math.ts`, `packages/asciidoc-pdf/src/index.ts`, `packages/asciidoc-pdf/tests/pipeline/stages/detect-renderable-blocks.test.ts`.
- [X] T004 [P] Add the transport fields in `packages/asciidoc-pdf/src/protocol.ts`: `RenderRequest.generatedAssets?: readonly GeneratedAsset[]` (optional, additive, structured-cloneable) and `GeneratedAsset.altText: string` (Contract B + data-model). Test the shape is optional/back-compatible in `packages/asciidoc-pdf/tests/protocol.test.ts`.
- [X] T005 [P] Switch the MathJax render shim to `mathjax-full`/`liteAdapter` (DOM-free) so math typesets **inside the worker** in `apps/web/src/workers/shims/mathjax.ts`; keep `fontCache:'local'` for determinism. Test in `apps/web/tests/workers/shims/mathjax.test.ts`.
- [X] T006 Wire `createDiagramsMathStage()` into `buildPipeline` and pre-seed each `request.generatedAssets[i]` into the `AssetCachePort` (`cache.set(asset)`) **before** running the stage, in `apps/web/src/workers/asciidoc-pdf.worker.ts` (graphviz/vega render headless in-worker; math via T005; pre-seeded mermaid resolves as cache hits so the no-DOM mermaid shim is never invoked). Depends on T003, T004, T005. Test in `apps/web/tests/workers/asciidoc-pdf.worker.test.ts`.

**Checkpoint**: The PDF worker can render graphviz/vega/math in-process and accept pre-rendered mermaid
assets by cache-key. US1/US2/US3 can now proceed.

---

## Phase 3: User Story 1 — Diagrams appear in the exported PDF (Priority: P1) 🎯 MVP

**Goal**: mermaid/graphviz/vega/vega-lite blocks render as images in the PDF export and live PDF
preview, at reference parity, without blocking typing.

**Independent Test**: Export a project whose top-level doc embeds a mermaid, a graphviz, and a
vega/vega-lite block; all three appear as images in the correct positions, no diagram-dropped warnings,
matching the reference build.

- [X] T007 [US1] Create the main-thread mermaid pre-pass in `apps/web/src/lib/pdf/prerender-mermaid.ts`: call the shared `detectRenderableBlocks` (T003), render only `mermaid` blocks (`securityLevel:'strict'`, `deterministicIds`) **scheduled in idle time** (`requestIdleCallback`) + time-sliced (yield between blocks) + coalesced + cancellation-guarded, content-address each with the same pure `computeSourceHash`, and return `GeneratedAsset[]` (+ any diagnostics). Depends on T003, T004, T006. Test in `apps/web/tests/lib/pdf/prerender-mermaid.test.ts`.
- [X] T008 [US1] Wire the mermaid pre-pass into the PDF export flow in `apps/web/src/hooks/use-pdf-export.ts`: await the pre-pass, attach its assets as `RenderRequest.generatedAssets`, surface status. Depends on T007. Test in `apps/web/tests/hooks/use-pdf-export.test.ts`.
- [X] T009 [US1] Wire the mermaid pre-pass into the live PDF preview in `apps/web/src/hooks/use-pdf-preview.ts`, coalesced behind the existing preview debounce so a superseded render never overwrites a newer one (FR-010). Include an **FR-011 equivalence assertion**: for the same document state, the set of renderable blocks and the diagnostics produced on the preview path match those on the export path (both ride the shared detector + worker pipeline). Depends on T007. Test in `apps/web/tests/hooks/use-pdf-preview.test.ts`.
- [X] T010 [US1] Mermaid responsiveness verification test (plan Complexity-Tracking accepted-deviation requirement): while a worst-case mermaid diagram renders in the idle-scheduled pre-pass, assert the **responsiveness budget** holds — the main-thread pre-pass yields at least every **50 ms** (time-slice ceiling, no single synchronous chunk exceeds it) AND a simulated editor keystroke is serviced (input handler + editor state update) within **100 ms** (RAIL interaction budget). Test in `apps/web/tests/lib/pdf/prerender-mermaid.responsiveness.test.ts`.
- [X] T011 [P] [US1] *(serves US1 + US2; FR-028)* Derive and apply meaningful alt text (FR-028) on the emitted `image::`/`image:` for **both diagram and math** assets — from block title/caption else a sensible default (engine/notation name or math expression) — in `packages/asciidoc-pdf/src/pipeline/stages/diagrams-math.ts`. Does not affect visual parity. Test in `packages/asciidoc-pdf/tests/pipeline/stages/diagrams-math.alttext.test.ts`.
- [X] T012 [US1] Add a diagram parity fixture (one mermaid + one graphviz + one vega/vega-lite block) with its committed reference PDF and a parity assertion under `apps/web/e2e/pdf-parity/fixtures/diagrams/**` (SC-001, SC-003). Self-skips until the wasm engine + reference exist, consistent with the existing parity suite.

**Checkpoint**: US1 fully functional — all three diagram engines render in export + preview, off the
critical typing path. MVP deliverable.

---

## Phase 4: User Story 2 — Math renders in the exported PDF (Priority: P1)

**Goal**: block (`[stem]`/`[latexmath]`/`[asciimath]`) and inline (`stem:[…]` etc.) math render as
typeset images at reference parity via the worker `liteAdapter` path (enabled by T005/T006).

**Independent Test**: Export a doc with a `[stem]` block equation and an inline `stem:[…]` expression;
both appear as typeset images at correct positions, matching the reference build.

- [X] T013 [US2] Math-parity spike (plan-flagged): verify `mathjax-full`/`liteAdapter` SVG output matches the committed math reference from feature 039 (which came from browser MathJax); if the adapter switch changes glyph geometry, regenerate the committed math reference via the reference toolchain and document the delta. Files: `packages/asciidoc-pdf/tests/integration/parity.integration.test.ts` (math cases) + reference assets.
- [X] T014 [US2] Add a math parity fixture exercising a `[stem]` block equation, an inline `stem:[…]` macro mid-sentence, and math-like text inside a verbatim block (must pass through untouched), with committed reference and parity assertion under `apps/web/e2e/pdf-parity/fixtures/math/**` (SC-002). Depends on T013.

**Checkpoint**: US1 AND US2 both render in the PDF export/preview.

---

## Phase 5: User Story 3 — Rendering failures are surfaced, never silent (Priority: P2)

**Goal**: per-block, located, fail-soft diagnostics — unsupported-offline engines, malformed source,
raster fallback, remote-resource-skipped — with every other block still rendering.

**Independent Test**: Export a doc mixing one valid mermaid, one broken mermaid, and one PlantUML block;
the valid block renders, the other two each produce a distinct located warning, and the export succeeds.

- [X] T015 [US3] Improve the unsupported-offline diagnostic (FR-008) to name the supported alternatives (mermaid for most PlantUML diagrams, graphviz/DOT for DOT) rather than only "skipped", in `packages/asciidoc-pdf/src/pipeline/stages/diagrams-math.ts`. Test in `packages/asciidoc-pdf/tests/pipeline/stages/diagrams-math.unsupported.test.ts`.
- [X] T016 [US3] Ensure the remote-resource-skipped warning (FR-027) is raised for a vega/vega-lite `data.url` (or remote image) on **both** the worker stage and the mermaid pre-pass path (no fetch attempted), and that pre-pass diagnostics are carried alongside `generatedAssets` and surfaced in the PDF diagnostics panel. Files: `packages/asciidoc-pdf/src/pipeline/stages/diagrams-math.ts`, `apps/web/src/lib/pdf/prerender-mermaid.ts`; tests in the respective `tests/` trees.
- [X] T017 [US3] Fail-soft integration coverage (SC-006): a document mixing a valid block, a malformed block, an unsupported-offline (PlantUML) block, and a vector-feature-that-triggers-raster-fallback (FR-009) still exports successfully with each failing block producing a distinct located diagnostic and the raster fallback warned. Test in `packages/asciidoc-pdf/tests/pipeline/stages/diagrams-math.failsoft.test.ts`.

**Checkpoint**: US1–US3 complete — the PDF path renders diagrams + math and fails soft with clear
per-block diagnostics.

---

## Phase 6: User Story 4 — Diagram blocks are highlighted in their own language (Priority: P2)

**Goal**: distinct diagram-block declarations plus parser-accurate inner highlighting (mermaid /
DOT / JSON), scoped to the block body. **Independent of the PDF pipeline — needs only Setup (T002).**

**Independent Test**: Type a `[mermaid]` flowchart, a `[graphviz]` DOT block, a `[vega-lite]` JSON
block, and a `[source,ruby]` listing; each diagram declaration is distinct from the generic source
block AND its body is highlighted per its own grammar, with no bleed into surrounding AsciiDoc.

- [X] T018 [US4] Distinguish the diagram block **declaration** from generic listing/source (FR-012/013/014): add declaration tokens in `apps/web/src/lib/codemirror/asciidoc-block-token-logic.ts`, an `ad.diagramDecl` tag in `asciidoc-highlight-tags.ts`, a theme rule in `asciidoc-theme.ts`, and regenerate `asciidoc-parser.js`/`asciidoc-parser.terms.js` from `asciidoc.grammar`. Recognise only an attribute line immediately followed by a block delimiter. Test in `apps/web/tests/lib/codemirror/asciidoc-diagram-decl.test.ts`.
- [X] T019 [P] [US4] Faithful DOT StreamParser (graph/digraph keywords, node/edge operators, attribute lists) in `apps/web/src/lib/codemirror/diagram-langs/dot.ts`. Test in `apps/web/tests/lib/codemirror/diagram-langs/dot.test.ts`.
- [X] T020 [P] [US4] Mermaid inner parser (FR-021): `codemirror-lang-mermaid` for the grammar-covered types (flowchart, sequence, class, state, ER) + a consistent **lexical fallback** (diagram-type keyword, `%%` comments, quoted labels, arrows/edges, node shapes) selected by the first-content-line keyword for every other type; unknown keyword degrades to plain, never breaks the document. In `apps/web/src/lib/codemirror/diagram-langs/mermaid.ts`. Depends on T002. Test in `apps/web/tests/lib/codemirror/diagram-langs/mermaid.test.ts`.
- [X] T021 [US4] Wire the editor `notation → parser` map in `apps/web/src/lib/codemirror/source-languages.ts` and the `parseMixed` body routing in `apps/web/src/lib/codemirror/asciidoc-source-highlight.ts` (JSON via `@codemirror/lang-json` for vega/vega-lite, DOT via T019, mermaid via T020), scoped with `overlay:[blockBodySpan]` so highlighting never bleeds and math STEM blocks are untouched (FR-020/022). Depends on T018, T019, T020. Test in `apps/web/tests/lib/codemirror/asciidoc-diagram-inner.test.ts`.
- [X] T022 [US4] Diagram notation-set **consistency seam** (Contract E / FR-015), two parts in one deliverable: (a) **publish** read-only notation name sets from the renderer's public API — add `DIAGRAM_NOTATIONS` and `UNSUPPORTED_DIAGRAM_NOTATIONS` exports in `packages/asciidoc-pdf/src/pipeline/stages/diagrams-math.ts` (already re-exported by `src/index.ts`), **derived from** the existing private `DIAGRAM_SHIM_BY_BLOCK` / `UNSUPPORTED_DIAGRAM_BLOCKS` so the map stays single-source (no shared registry, no duplicated set); (b) the **consistency test** asserting the editor's diagram-name set (from `apps/web/src/lib/codemirror/source-languages.ts`) equals the published renderer set, and that the unsupported-offline sets agree — the test imports the **public** `@asciidocollab/asciidoc-pdf` export, never a package internal. Tests in `packages/asciidoc-pdf/tests/pipeline/stages/diagram-notations.test.ts` (the public seam is stable) and `apps/web/tests/lib/codemirror/diagram-notation-consistency.test.ts`.

**Checkpoint**: Editor highlights diagram declarations distinctly and renders inner-language
highlighting for mermaid/DOT/JSON without regressing existing block highlighting.

---

## Phase 7: User Story 5 — PDF rendering package is guarded by the quality gate (Priority: P2)

**Goal**: run the `asciidoc-pdf` unit suite in the gate + CI with its coverage threshold, and add a
WOFF2 custom-font parity fixture. **Independent — needs only Setup.**

**Independent Test**: Introduce a deliberate regression in `packages/asciidoc-pdf`; the standard
quality-gate command fails. Separately, run the parity suite and confirm a WOFF2-font fixture is
exercised against its committed reference.

- [X] T023 [P] [US5] Add a `test:ci` script (`jest --coverage`, enforcing the existing `global: 90` threshold) to `packages/asciidoc-pdf/package.json` (+ confirm `jest.config.cjs`), and invoke it from `scripts/ci/unit.sh` so it runs in both `pnpm gate` and CI's `unit` job (FR-016/017/019). Verify a seeded regression fails the gate.
- [ ] T024 [US5] Add the WOFF2 custom-font parity fixture (FR-018): the `theme-fonts-woff2` project (`source/main.adoc`, `brand-theme.yml` with a `Brand Mono` WOFF2 catalog, four `.woff2` subsets, `manifest.json` with no `ink`/`variants`, committed `reference.pdf`) under `apps/web/e2e/pdf-parity/fixtures/theme-fonts-woff2/**`, and make the Node parity harness run `mount-assets` (a Node `fonteditor-core` WOFF2→TTF `FontConverter`) before convert in `apps/web/e2e/pdf-parity/parity-render.mjs`; assert `allFontsEmbedded === true` + content/geometry parity. Self-skips until wasm engine + `reference.pdf` exist.

**Checkpoint**: The PDF package is gated in the local gate and CI, and WOFF2 embedding is parity-proven.

---

## Phase 8: User Story 6 — Diagrams appear in the HTML preview (Priority: P2)

**Goal**: mermaid/graphviz/vega/vega-lite render as native on-screen diagrams in the HTML preview,
XSS-safe, updating on edit. **Independent of the PDF pipeline.**

**Independent Test**: Open the HTML preview on a doc with a mermaid, a graphviz, and a vega/vega-lite
block; all three render on-screen, update when edited, and a diagram-free doc is unaffected.

- [X] T025 [US6] Emit the diagram placeholder from the AsciiDoc→HTML render worker (Contract C): `<div class="adc-diagram" data-diagram-engine data-source-line>` with the inert source as escaped text content, plus `RenderResult.diagramsPresent: boolean`, in `apps/web/src/workers/asciidoc-render.worker.ts`. Placeholder is `html`-profile-safe so the shared preview sanitizer keeps it. Test in `apps/web/tests/workers/asciidoc-render.worker.diagrams.test.ts`.
- [X] T026 [US6] Thread `diagramsPresent` through preview state in `apps/web/src/hooks/use-asciidoc-preview.ts` to gate the lazy engine import. Depends on T025. Test in `apps/web/tests/hooks/use-asciidoc-preview.test.ts`.
- [X] T027 [US6] Create `apps/web/src/components/diagrams/render-diagrams.ts`: locate `.adc-diagram` placeholders, render each engine's **native on-screen** output (mermaid `securityLevel:'strict'` — add a native/preview config export in `apps/web/src/workers/shims/mermaid.ts`; vega `renderer:'none'` remote-blocking loader; graphviz wasm), sanitize the SVG with a **separate SVG-profile DOMPurify** (shared `html`-profile sanitizer untouched — Principle VIII), inject idempotently, and skip-with-warning on remote resources (FR-027). FR-023/024/025. Depends on T025. Test in `apps/web/tests/components/diagrams/render-diagrams.test.ts`.
- [X] T028 [US6] Add the sibling post-render effect in `apps/web/src/components/asciidoc-preview.tsx` (mirror the MathJax post-render hook, gated on `diagramsPresent`), with fail-soft placeholder/warning for unsupported-offline (PlantUML/ditaa) or malformed blocks so the rest of the preview still renders (FR-026). Depends on T026, T027. Test in `apps/web/tests/components/asciidoc-preview.diagrams.test.ts`.

**Checkpoint**: HTML preview renders diagrams natively on-screen, XSS-safe, updating on edit.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T029 **Zero source-egress verification** (SC-004, FR-005/FR-026 — Principle X NON-NEGOTIABLE): an e2e network-intercept test that renders a document containing mermaid/graphviz/vega + block/inline math across **all three new render surfaces** — PDF export, live PDF preview, and the HTML preview diagram pass — and asserts **zero source-bearing outbound requests** (no diagram/math source text and no referenced resource URL leaves the client), including that a vega `data.url` / remote image is skipped-with-warning and never fetched (FR-027). Test in `apps/web/e2e/pdf-diagrams-math-egress.spec.ts`.
- [ ] T030 Run `specs/040-pdf-diagrams-math/quickstart.md` validation end-to-end (each workstream's build/test/verify + WOFF2 reference regen steps) and fix any drift.
- [ ] T031 Full quality-gate sweep (`pnpm gate`: lint, typecheck, unit incl. the newly-gated asciidoc-pdf, integration, security scan, e2e) then run `/code-review` in a loop until zero findings (Constitution §End-of-Feature Verification).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies — start immediately.
- **Foundational (Phase 2)**: depends on Setup — **blocks US1, US2, US3 only**.
- **US1 (Phase 3)**: after Foundational. **MVP.**
- **US2 (Phase 4)**: after Foundational (its render path is enabled by T005/T006; work is verify + fixtures).
- **US3 (Phase 5)**: after Foundational; best after US1/US2 so diagnostics can be exercised end-to-end.
- **US4 (Phase 6)**: after Setup (T002) — **independent of the PDF pipeline**.
- **US5 (Phase 7)**: after Setup — **independent**.
- **US6 (Phase 8)**: after Setup — **independent of the PDF pipeline**.
- **Polish (Phase 9)**: after all targeted stories complete.

### Cross-story parallelism

Once Setup + Foundational are done, three independent tracks can run concurrently:
**Track A** = US1 → US2 → US3 (the PDF pipeline). **Track B** = US4 (editor). **Track C** = US5 (CI) +
US6 (HTML preview). US4/US5/US6 do not touch the PDF worker plumbing and share no files with Track A.

### Within-phase parallel opportunities

- Setup: T002 [P] alongside T001.
- Foundational: T004 [P] and T005 [P] run alongside T003 (different files); T006 joins them.
- US1: T011 [P] (renderer alt-text) runs alongside T007–T010 (web pre-pass/hooks).
- US4: T019 [P] (DOT) and T020 [P] (mermaid) run in parallel before T021 wires them.
- US5: T023 [P] independent of everything.

---

## Implementation Strategy

### MVP (US1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → **STOP and validate**: diagrams render in
export + preview, off the critical typing path (SC-001, SC-005). Demo.

### Incremental delivery

Setup + Foundational → US1 (MVP: diagrams in PDF) → US2 (math in PDF) → US3 (fail-soft diagnostics) →
US4 (editor highlighting) → US5 (CI hygiene) → US6 (HTML preview diagrams). Each story is independently
testable and adds value without breaking the previous ones. US4/US5/US6 can be interleaved earlier since
they don't depend on the Foundational phase.

### Notes

- Each task = one `/tdd` invocation; never split test and implementation.
- Commit after each task or logical group (only after green).
- The two plan-flagged risk tasks are **T010** (mermaid responsiveness verification — the accepted-deviation
  rollback trigger) and **T013** (math-parity spike after the MathJax adapter switch).
- The highest-risk seam is the cache-key parity between the mermaid pre-pass and the worker stage — locked
  by **T003**'s parity test (Contract A).
