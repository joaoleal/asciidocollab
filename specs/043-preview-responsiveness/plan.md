# Implementation Plan: Live Preview Responsiveness

**Branch**: `043-preview-responsiveness` | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/043-preview-responsiveness/spec.md`

## Summary

The live preview's felt latency is dominated by its own scheduling and panel lifecycle, not by
Asciidoctor: conversion costs 6–540 ms across the document size range, against a 500 ms debounce that
in practice never yields during continuous typing. This plan delivers, in order: per-render
measurement plus a recorded baseline; a max-wait cap that actually fires; a long-lived, supervised
render worker that survives file and preview-format switches; an adaptive trailing delay derived from
measured render cost; an in-place DOM morph replacing wholesale `innerHTML`; and finally the
Asciidoctor.js v4 migration.

The commit mechanism changes; **AsciiDoc semantics do not**. Every render still comes from the same
authoritative full convert, through the same sanitiser, with the same attribute resolution. That
containment is what keeps a broad performance change inside Principles VIII, IX and XI.

## Technical Context

**Language/Version**: TypeScript 5.x, React 19, Next.js 16 (App Router)

**Primary Dependencies**: `asciidoctor` ^3.0.4 → 4.0.6 (User Story 6); `dompurify` ^3.4.11;
**`morphdom` ^2.7.8 (new, MIT)**; `mathjax` 3.x; `mermaid` / `vega` / `@hpcc-js/wasm` (diagram
engines); `@asciidocollab/asciidoc-pdf` (page-formatted path)

**Storage**: N/A — no persistence, no schema change, no Prisma migration

**Testing**: Jest + Testing Library (`apps/web/tests/`), Playwright (`apps/web/e2e/`). ~23 existing
preview e2e specs are the primary regression net for User Story 5.

**Target Platform**: Browser (Web Worker for rendering; main thread for morph, math, diagrams)

**Project Type**: Web application — `apps/web` only

**Performance Goals**: refresh ≤200 ms after last keystroke at ~100 lines; no regression at ~15,000
lines; a guaranteed refresh every 2 s during sustained typing (self-limiting when a single render
exceeds that interval); file-switch time-to-content halved against the recorded baseline

**Constraints**: rendering stays off the main thread (Principle XIII); sanitisation boundary
unchanged (VIII/IX); preview/export parity preserved (XI); no `any`, no `as` in production code

**Scale/Scope**: ~20 source files plus one new dependency, one new e2e harness (the canonical
web-format reference build), and two changes in `packages/asciidoc-pdf` — per-stage instrumentation
(US3) and the size-bound fix (US7). No domain/application/infrastructure code is involved. Note this
is materially larger than the original scoping: the reference build and User Story 7 were both pulled
in by explicit decision so that nothing is left as a follow-up, and the page-format per-stage
breakdown was added later still (FR-022a–FR-022c) after a gap review found that surfacing the
existing two-figure report would rank documents against each other and support no decision beyond
that.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

| Principle | Applies | Assessment |
|---|---|---|
| **I. Clean Code** | Yes | Adaptive-delay computation and morph decisions extracted as named pure functions, not inlined in effects. Bounds (`120`, `500`, rebuild cap) are named constants in `editor-config.ts`, not literals. |
| **II. TDD (NON-NEGOTIABLE)** | Yes | Every implementation task via `/tdd`. **Performance assertions are in scope here**: Principle II makes them opt-in, and this spec explicitly requests them (SC-003/005/009, FR-023a), so they follow the same red-green discipline. One deliverable = one task = one `/tdd` invocation. |
| **III. In-memory fakes** | No | No repository ports involved. |
| **IV. Reuse Before Rebuild** | **Yes — decisive** | Hand-rolling a DOM diff is prohibited while a compatible library exists. `morphdom` (MIT) adopted; `idiomorph` evaluated and recorded as the rejected alternative (research R1). |
| **V. Design tokens** | Yes | The dev measurement overlay is app chrome: tokens only, correct in light and dark mode. |
| **VI. Style isolation** | Yes | Overlay renders **outside** `.asciidoc-preview-content`; document-rendering styles stay scoped. Morphing patches inside the existing scoped container and introduces no new global selector. |
| **VII. Per-user preferences** | Yes | Nothing persisted; nothing shared. The overlay is build-time, not a user setting. |
| **VIII. Editor Pipeline Integrity** | **Yes — must be justified** | This feature touches **both** protected seams. See "Principle VIII justification" below. |
| **IX. Untrusted Input Boundary (NON-NEGOTIABLE)** | Yes | Same sanitiser, same `USE_PROFILES: { html: true }`, same call site — only the return type changes (`RETURN_DOM_FRAGMENT`). No parallel or relaxed path is introduced. No new content source enters the pipeline. |
| **X. Client-side / no egress (NON-NEGOTIABLE)** | Yes | Unaffected. No content leaves the client; nothing new is fetched. `morphdom` is a build-time dependency, not a runtime fetch. |
| **XI. Reference-Build Parity (NON-NEGOTIABLE)** | Yes | User Story 6 is the only story that can affect fidelity. **It is NOT covered by the existing page-format reference-parity suite** — see "Principle XI correction" below. A new web-format render-equivalence corpus (FR-025a) and a cross-format agreement check (FR-025b) are the gates. Stories 1–5 change *when* and *how output is committed to the DOM*, never what is produced. |
| **XII. Deterministic output** | Yes | The adaptive wait makes render **timing** depend on measurement; rendered **output** remains a pure function of source + attributes. No timing value reaches output. Diagram/math skip decisions are **content-addressed** (research R2), which is what XII requires of derived assets. The page-format in-VM instrumentation (FR-022b) carries its figures on a separate result path and never into the rendered document; the page-formatted path MUST still produce byte-identical output for the same source with instrumentation active, which the existing parity suite (SC-010c) is the check on. |
| **XIII. Non-Blocking Responsiveness** | **Yes — the feature's own subject** | Conversion stays in the worker. The morph runs on the main thread, as any DOM write must. It replaces a whole-document `innerHTML` re-parse with a patch of the changed parts and removes the per-keystroke diagram redraw and math re-typeset. Net main-thread work is *expected* to decrease; that is a hypothesis to be **confirmed against the FR-023a baseline**, not a discharged obligation — this repo's discipline is to verify, not assume. **The obligation now has a vehicle**: FR-023a captures main-thread work during sustained typing as part of the baseline, and SC-006a judges the post-morph figure against it. An earlier revision stated the obligation and provided neither the capture nor the check, which would have left it discharged by assertion — exactly what the wording forbids. |
| **XIV. Sandbox-safe dependencies** | Yes | `morphdom` is dependency-free, DOM-only. No subprocess, socket, or native extension. |
| **XV. Fidelity Verified Before Done** | Yes | Satisfied by FR-025c: a **canonical web-format reference build** (the reference Asciidoctor toolchain rendering the corpus to HTML), compared against in-app output with every intended difference enumerated (FR-025d). The regression corpus (FR-025a) is retained alongside it, but is explicitly NOT what discharges XV — a snapshot of in-app output against itself is excluded by the principle's own wording, and an earlier revision of this plan wrongly claimed otherwise. Stories 1–5 are not fidelity-critical but MUST keep the existing preview e2e suite green. |

### Principle VIII justification (required call-out)

Principle VIII requires any change that necessarily affects the sanitisation or scroll-sync seams to
be called out and justified. This feature affects both.

**Sanitisation seam.** `use-asciidoc-preview.ts:175` changes from returning a sanitised *string* to a
sanitised *DocumentFragment*. The sanitiser, its profile and its allow-list are byte-for-byte
unchanged; DOMPurify already builds this fragment internally and currently serialises it purely so
`innerHTML` can re-parse it. This is the same boundary with one fewer round trip — not a widened,
relaxed, or forked one. **Verification obligation**: a test MUST prove a payload rejected in string
mode is rejected identically in fragment mode. Until that test passes, User Story 5 is not done.

**Scroll-sync seam.** Two changes touch it. FR-010 resets scroll on file switch (behaviour the
remount previously provided implicitly, now explicit). FR-017 preserves scroll across a refresh —
today's jump is a *defect* caused by wholesale replacement collapsing image heights, so this is a
repair of the seam, not a regression of it. FR-019 requires click-to-source and scroll-to-line to
keep working after a partial refresh. **Verification obligation**: the existing preview e2e specs
covering scroll-sync and click-to-source MUST pass unmodified.

Neither change relaxes a guarantee. Both are covered by tests as Principle VIII requires.

### Principle XI correction (the parity gate this plan originally named was wrong)

An earlier revision of this plan claimed User Story 6 was gated on the existing PDF reference-parity
suite, and that parity "held by construction" because `getCoreVersion()` reports 2.0.26. **Both halves
were wrong, and the architecture guard caught it.** Recording the correction rather than quietly
editing it, because the failure mode is instructive: the claim would have produced a green gate that
tested nothing.

**What is actually true:**

- The JS `asciidoctor` package is imported by exactly one non-build file in the repository —
  `apps/web/src/workers/asciidoc-render.worker.ts:1`. It drives the **web-formatted preview only**.
- The page-format parity suite (`apps/web/e2e/pdf-parity/pdf-parity-render.spec.ts`) renders through
  `@asciidocollab/asciidoc-pdf` (ruby.wasm) and compares PDF text layers and page counts. It never
  loads the JS engine. Upgrading 3.0.4 → 4.0.6 **cannot** be detected by it — that suite would pass
  unchanged whether the upgrade were correct or catastrophic.
- "Parity holds by construction" is an argument from code inspection. Principle XI forbids exactly
  that: parity "MUST be verified against reference output, never assumed from code inspection or from
  the in-app result looking plausible." A matching version string is not evidence.

**The gates that replace it:**

1. **Canonical web-format reference build (FR-025c/FR-025d, SC-010d)** — the gate that discharges
   Principle XV. The reference Asciidoctor toolchain renders the corpus to HTML; in-app output is
   compared against it, with each of the app's deliberate post-conversion passes (source-line
   provenance, synthetic ids, endpoint-mapped image targets, highlighting markup, diagram
   placeholders, assembled includes) either normalised or enumerated as an intended divergence. An
   unexplained difference fails. This is what the page-formatted path has always had and the
   web-formatted path never did.
2. **Web-format render-equivalence corpus (FR-025a, SC-010/SC-010a)** — a **regression** gate, kept
   alongside gate 1 rather than instead of it. It proves the upgrade changed nothing relative to the
   previous version, which gate 1 alone would not isolate. It does not discharge Principle XV: a
   snapshot of in-app output against itself is excluded by the principle's own wording, and a second
   revision of this plan wrongly claimed it qualified. Both claims are recorded rather than quietly
   edited, because each produced a gate that looked stronger than it was.
3. **Cross-format agreement check (FR-025b/FR-025e, SC-010b/SC-010e)** — reads *both* outputs and
   compares what both media can express. Its third dimension needs internal link-destination
   extraction from page-formatted output, which the existing tooling cannot do; FR-025e makes building
   that extraction part of the work rather than letting the check silently degrade to two dimensions.
4. **The existing page-format parity suite still runs (SC-010c)** — not as the upgrade's gate, but to
   confirm the page-formatted path was not disturbed. That is a real and useful assurance; it is
   simply a different one from what was claimed.

**Timing consequence**: gate 1 needs reference fixtures captured from the *unmodified* engine, so its
capture belongs to the User Story 3 baseline pass. There is exactly one moment when that is possible.
This is now FR-023c.

### Accepted deviation: module-level worker holder

**Deviation**: `apps/web/src/lib/create-render-worker.ts` gains a module-level, ref-counted holder,
against the architecture constitution's "no service locators, no static singletons" clause.

**Rationale**: that clause governs wiring concrete implementations to **domain interfaces** at the
composition root. This holder is a browser resource pool for a UI-layer Web Worker: it injects no
domain dependency, implements no port, and crosses no layer boundary. It mirrors the processor
singleton the render worker already holds internally
(`asciidoc-render.worker.ts:407-413`). The worker must outlive any single component instance to
satisfy FR-006 and FR-007 at all.

**Correction to the holder's lifetime, from the post-task analysis.** The first revision of the
contract released the worker by terminating it once the consumer count reached zero, citing FR-006 and
FR-007. That satisfies FR-006 and **provably fails FR-007**: `useAsciidocPreview` has exactly one
caller, inside a component rendered by `project-editor-layout.tsx:1391` as
`previewMode === 'html' ? … : …` and gated by `showPreview && previewOpen`, so a format switch or a
panel close drops the count to zero on the very transition the requirement protects. FR-007a is added
to the spec to name the case, and the holder now retains the worker for
`RENDER_WORKER_IDLE_RETENTION_MS` after the last release rather than terminating. Recorded rather than
edited away, because the mechanism looked obviously correct and every test written against it would
have passed.

**Rollback plan** (required by Architecture Constitution › Refactor & Drift Handling, and absent from
the previous revision):

1. The holder's public surface is exactly `acquireRenderWorker(handlers) → { post, release, retry }`
   (`contracts/refresh-schedule.md` S4). Consumers never touch the module state directly, so the
   holder is replaceable without touching call sites.
2. To roll back, reimplement `acquireRenderWorker` to construct a worker per call and terminate it on
   `release()`. That restores today's per-mount lifetime with no change to any consumer.
3. Rolling back reintroduces the file-switch cost (FR-006/FR-007 regress) and disables supervision
   (FR-012a–FR-012c), so it is a deliberate trade, not a free revert. The e2e specs asserting no
   "preview not available" flash would fail, which is the intended alarm.
4. Trigger conditions: worker leakage across sessions that supervision cannot contain, or a
   cross-tab/multi-project isolation defect traced to shared worker state.

### Gate result

**PASS**, after the Principle XI correction above. The two NON-NEGOTIABLE principles in play are
satisfied by design rather than by exception: IX because the sanitiser is untouched in policy, XI
because the only fidelity-affecting story is now gated on a comparison that actually exercises the
engine being changed (FR-025a/FR-025b), rather than on a suite that does not load it.

One accepted deviation is documented above with rationale **and** rollback plan (the module-level
worker holder). It does not require Complexity Tracking, because it is not a Constitution Check
violation — the clause it brushes against governs domain-interface wiring, not browser resource
pooling.

## Project Structure

### Documentation (this feature)

```text
specs/043-preview-responsiveness/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── baseline.md          # US3 output (FR-023b) — recorded pre-change figures
├── contracts/           # Phase 1 output
│   ├── render-result.md
│   ├── refresh-schedule.md
│   ├── morph-policy.md
│   └── render-equivalence.md   # the US6 gates (added after the architecture-guard scan)
├── checklists/
│   └── requirements.md
└── tasks.md             # Created by /speckit-tasks — NOT by this command
```

### Source Code (repository root)

```text
apps/web/
├── src/
│   ├── workers/
│   │   ├── render-protocol.ts             # US3: NEW — the single RenderRequest/RenderResult/
│   │   │                                  #   RenderTimings declaration, imported by BOTH the worker
│   │   │                                  #   and the hook (they declare it twice today, and the two
│   │   │                                  #   copies have already drifted over `details`)
│   │   └── asciidoc-render.worker.ts      # US3: time load/convert separately, return on result
│   ├── hooks/
│   │   ├── use-asciidoc-preview.ts        # US1,2,3,4,5: cleanup fix, worker holder, timings,
│   │   │                                  #   adaptive delay, fragment return
│   │   └── use-pdf-preview.ts             # US1,3: same cleanup fix; stop discarding RenderStats
│   ├── lib/
│   │   ├── max-wait-debounce.ts           # US1: flush(), in-progress gate, re-arm
│   │   ├── editor-config.ts               # US1,4: adaptive bounds, rebuild cap; FR-004b doc update
│   │   ├── create-render-worker.ts        # US2: ref-counted holder + supervision
│   │   ├── preview/
│   │   │   ├── adaptive-delay.ts          # US4: pure clamp function (new)
│   │   │   └── morph-preview.ts           # US5: morphdom wrapper + skip policy (new)
│   │   └── pdf/pdf-render-controller.ts   # US3: surface existing RenderStats, report the real
│   │                                      #   raster-fallback count (FR-022c), and time the
│   │                                      #   main-thread stages — boot, populate, pipeline, convert
│   └── components/
│       ├── asciidoc-preview.tsx           # US2,3,5: stale-content state, overlay, fragment commit
│       └── preview/render-stats-overlay.tsx  # US3: dev-only overlay (new)
└── tests/
    ├── workers/asciidoc-render.worker.test.ts
    ├── hooks/use-asciidoc-preview.test.tsx    # primary refactor surface (1062 lines)
    ├── hooks/use-pdf-preview.test.tsx
    ├── lib/max-wait-debounce.test.ts
    ├── lib/preview/adaptive-delay.test.ts     # new
    └── lib/preview/morph-preview.test.ts      # new

packages/asciidoc-core/src/extraction/document-order.ts   # FR-026 only (audit callers first)

apps/web/e2e/
├── preview-*.spec.ts                       # ~23 existing specs — regression net for US5
├── pdf-parity/harness/pdftools.ts          # US6: EXTEND — internal link-destination extraction
│                                           #   (FR-025e); today it has page count, text, ink only
└── render-equivalence/                     # US6: NEW
    ├── corpus/                             #   the fixed document set (FR-025a); authored in US3,
    │                                       #   because the US3 capture cannot run without it
    ├── fixtures/
    │   ├── previous-engine/                #   captured from the CURRENT engine, US3 (FR-023c)
    │   └── reference-toolchain/            #   canonical Asciidoctor HTML (FR-025c)
    ├── harness/
    │   ├── capture.ts                      #   US3: renders the corpus with the unmodified engine
    │   ├── reference-build.ts              #   drives the reference toolchain + normalisation
    │   ├── Dockerfile / Gemfile / Gemfile.lock  #   the PINNED HTML oracle (FR-025c-i). A separate
    │                                       #   definition set from the PDF one, so reusing the
    │                                       #   shared builder cannot re-tag the PDF image
    ├── web-format-reference.spec.ts        #   FR-025c / FR-025d / SC-010d  ← discharges XV
    ├── web-format-equivalence.spec.ts      #   FR-025a / SC-010 / SC-010a   ← regression only
    └── cross-format-agreement.spec.ts      #   FR-025b / FR-025e / SC-010b / SC-010e

packages/asciidoc-pdf/
├── src/protocol.ts                         # US3: FR-022a — RenderStats gains `stages`, additive
├── src/convert/invoke.ts                   # US3: FR-022b — time the in-VM stages (parse, converter
│                                           #   walk, DRY RUNS, font parse/subset, serialise) and
│                                           #   return them via the write-to-VFS/read-back mechanism
│                                           #   this file already uses for the convert result
└── src/pipeline/, src/vm/                  # US7: FR-027–FR-028a — size bound + render-VM reuse
                                            #   re-measurement

specs/043-preview-responsiveness/baseline.md    # US3: FR-023b — committed baseline figures,
                                                #   incl. the FR-028 idle-machine re-measurement
```

**Structure Decision**: Primarily `apps/web`, plus one isolated correctness fix in
`packages/asciidoc-core` (FR-026) and two separate pieces of work in `packages/asciidoc-pdf` — the
per-stage instrumentation (US3, FR-022a–FR-022c) and the page-format size bound (US7,
FR-027–FR-028a). No layer boundary is crossed: no domain, application, or infrastructure code is
touched, no package imports an app, and no DTO crosses a package boundary. `packages/asciidoc-pdf` is
the accepted browser-only capability package the architecture constitution already records; both
stories stay inside it and add no new inward dependency. Note US3 now reaches into this package,
which an earlier revision of this plan stated US7 alone did — the per-stage breakdown FR-022a
requires cannot be produced from `apps/web`, because the stages that matter run inside the render VM. The architecture guard's declared-dependency check
requires `morphdom` to be added to `apps/web/package.json` — it must not be relied upon transitively.

## Delivery Sequence

Delivery order differs deliberately from priority order; the spec's Dependencies section is
authoritative and this plan follows it.

| # | Story | Why here |
|---|---|---|
| 1 | **US3 — measurement** | Delivered first. The only moment "today" can be recorded is before it changes (FR-023a). Also supplies US4's input signal, and — added after the architecture-guard scan — captures the **render-equivalence reference fixtures** US6 is gated on (FR-023c). Both captures need the unmodified engine, so they share one moment. Now also carries the page-format per-stage breakdown (FR-022a–FR-022c), which must be taken before US7 potentially changes render-VM reuse, and which the follow-on feature `044-pdf-render-performance` is gated on. |
| 2 | **US1 — max-wait cap** | Smallest slice, largest promise gap, no dependencies. Includes the PDF hook. |
| 3 | **US2 — worker lifetime + supervision** | Independent of US1; ordering between them is free. |
| 4 | **US4 — adaptive delay** | Needs US3's measured duration. |
| 5 | **US5 — DOM morph** | Largest change surface; gated on the full preview e2e suite. |
| 6 | **US6 — Asciidoctor v4** | Gated on the canonical web-format reference build (FR-025c) plus the regression corpus, cross-format agreement, and the untouched page-format suite. |
| 7 | **US7 — page-format size bound** | Last. Shares no code with the latency work. Correctness, not performance: pulled in by explicit decision so nothing is deferred (see Out of Scope, where the original exclusion reasoning is retained). |

FR-026 (the `stripReservedAttributes` cleanup) is independent of all six and may land at any point,
provided its call-site audit precedes the change.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Block identity is position-derived** — synthetic `__src_<context>_<line>` ids and `data-source-line` both shift when a line is inserted, so a positional morph key would force a full-document rebuild, defeating US5 | Layered identity (research R2): content-addressed comparison for diagram/math subtrees, stable author/auto ids as morph keys, **no key** for synthetic ids so `morphdom` falls back to structural matching rather than replacing |
| Removing the remount removes the accidental worker restart that currently masks a crash | FR-012a–FR-012c supervision, delivered **with** US2, not after it |
| `apps/web` jest is transpile-only and `tsc` excludes `tests/` — a contract change can pass with unfaithful fixtures | New contract tests use the real exported types; the worker↔hook contract change is verified by `pnpm typecheck` on source, not by a green test run |
| US5 changes the hook's public contract; 1062 lines of hook tests assert on the `html` string | Contract documented in `contracts/render-result.md` before implementation; e2e specs assert on DOM and are unaffected, so they gate the behaviour while the unit tests are revised |
| v4's dynamically-typed document API (`findBy`, `getStyle`, `getSource`, `setId`) could rename silently — a behaviour change, not a compile error | US6 sequenced last, gated on reference parity; each API call re-verified explicitly rather than assumed |
| Morph runs on the main thread (Principle XIII) | Net main-thread work decreases: it replaces a full `innerHTML` re-parse and removes per-keystroke diagram/math rework. Confirmed against the FR-023a baseline rather than asserted |
| Reported v4 gains are supplied figures, not measured here | Treated as hypotheses; SC-009 judged against the recorded baseline in `baseline.md` (FR-023b) |
| **The obvious parity gate does not cover the engine being changed** — the page-format suite never loads the JS engine, so it would pass regardless of whether the v4 upgrade was correct | New web-format render-equivalence corpus (FR-025a) with fixtures captured pre-change (FR-023c), plus a cross-format agreement check (FR-025b). The page-format suite still runs, as a check that the *other* path was undisturbed (SC-010c) |
| The equivalence fixtures can only be captured once — before any change lands | Capture is part of the US3 baseline task, not a later step. Missing it means reconstructing the reference from a reverted build, which in practice gets skipped |
| **The canonical reference build may show long-standing divergences** that the regression corpus would never surface, because they predate the upgrade | That is the point of having it (FR-025c). Each difference must be normalised or enumerated as intended (FR-025d). Expect the first run to fail and to need triage — budget for it; a clean first run more likely means the normalisation is too permissive |
| The app's post-conversion passes make raw comparison against reference HTML meaningless | FR-025d enumerates them explicitly rather than loosening the comparison until it passes. An unexplained difference fails; an enumerated one does not |
| **US7 is a correctness defect riding in a performance feature** — the exact coupling the spec's Out of Scope originally warned against | Sequenced last, shares no code with US1–US6, and confined to `packages/asciidoc-pdf`. It can be dropped without disturbing any other story if the feature needs to ship sooner |
| FR-028's degradation figures were measured under load and may not reproduce | Re-measurement on an idle machine is the requirement itself, and both outcomes are recorded. No change is made on the original numbers |
| **US7 can silently invalidate US3's per-stage baseline** — the stage figures are captured with render-VM reuse in force, VM boot is one of the stages they break out, and FR-028a may remove that reuse. The artifact would keep being cited as current while describing an arrangement the product had stopped using | FR-028b requires the figures to be re-measured inside T041 whenever reuse changes; T011 labels them as reuse-dependent so it is visible which figures a change invalidates; SC-012 covers the re-measurement. Found by `/speckit-analyze`, not by implementation |
| **A consumer-counted worker lifetime destroys the engine on exactly the transitions FR-007 protects** — the web-formatted preview is its only consumer, so a format switch or panel close drops the count to zero | FR-007a states the case; the holder retains for `RENDER_WORKER_IDLE_RETENTION_MS` after the last release instead of terminating (`contracts/refresh-schedule.md` §S4). Caught by analysis before implementation; every test written against the original mechanism would have passed |
| **An unpinned HTML reference toolchain is not an oracle** — it answers "does this match?" differently on two machines, breaking XII and therefore XI | FR-025c-i pins it to the standard the page-formatted path already meets, reusing `e2e/pdf-parity/tools/reference-image.mjs` (digest-pinned base, `--frozen` lock, definition-hash tag, fixed `SOURCE_DATE_EPOCH`) with its own definition set so the PDF image's tag — and the committed PDF corpus SC-010c depends on — are untouched |
| **`pnpm gate` can report green having never run the page-format parity suite** — `gate.sh:47-53` skips Job 6 when poppler or the wasm engine are absent, though `pdf-parity.sh` itself refuses to skip | For this feature a SKIPPED Job 6 counts as a failed sweep: provision the prerequisites or invoke `scripts/ci/pdf-parity.sh` directly. SC-010c is evidence only if the comparison actually ran |
| **US7 disturbs the page-formatted path after SC-010c was checked** — FR-028a may change render-VM reuse, and the US6 check predates it | SC-010c is re-verified after US7, not only during US6 (spec §Dependencies, `contracts/render-equivalence.md` §G3) |
| **The in-VM instrumentation perturbs what it measures, or leaks into output** — FR-022b adds timing calls and a result write inside the render VM, on the path whose cost it is measuring | Instrument at stage boundaries only, not per block; reuse the existing write-to-VFS result mechanism rather than adding a second (FR-022b), so the added write is one more of a kind already paid per render. Output containment is checked by SC-010c, which must pass with instrumentation active |
| **US3 now reaches into `packages/asciidoc-pdf`, which the plan previously said only US7 did** — US7's "droppable without disturbing any other story" property does not transfer to US3 | The two touch different subtrees (`protocol.ts` + `convert/` for US3; `pipeline/` + `vm/` for US7) and US3 lands first. US7 remains droppable; **US3 does not** — the whole feature's comparative criteria depend on its baseline |

## Complexity Tracking

> No Constitution Check violations. This section is intentionally empty.

The one governance-sensitive decision — adding a runtime dependency (`morphdom`) — is *required* by
Principle IV rather than a deviation from it, and is recorded in research R1 with its rejected
alternative.
