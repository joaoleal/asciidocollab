---
description: "Task list for feature 043 — Live Preview Responsiveness"
---

# Tasks: Live Preview Responsiveness

**Input**: Design documents from `/specs/043-preview-responsiveness/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Implementation**: Every task MUST be executed via the `/tdd` skill (Constitution §Implementation
Discipline). Tasks describe **what** to implement; the skill owns **how** — failing test first,
minimal production code second, refactor third. Per that section, tasks deliberately do **not** name
test files, prescribe assertions, or pre-split test and source work. One deliverable = one task = one
`/tdd` invocation.

**Organization**: Grouped by user story. Delivery order is **US3 → US1 → US2 → US4 → US5 → US6 →
US7**, which deliberately differs from priority order (spec §Dependencies is authoritative).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: `[US1]`…`[US7]`; Setup / Foundational / Polish tasks carry no story label

## Path Conventions

Tests live in a dedicated `tests/` directory at the app or package root, mirroring the source tree —
never `__tests__/`, never co-located. `apps/web/src/hooks/use-x.ts` → `apps/web/tests/hooks/use-x…`.
Drop `src/`, keep the rest. The `/tdd` skill applies this; tasks below name **source** paths only.

E2E specs live in `apps/web/e2e/`. This feature adds `apps/web/e2e/render-equivalence/`.

**Machine constraint** (24 cores, no swap — see quickstart §6): always cap jest workers.

```bash
pnpm --filter @asciidocollab/web test -- --maxWorkers=4
```

---

## ⚠️ The one irreversible ordering constraint

**US3 must complete before ANY behavioural change in US1, US2, US4, US5 or US6 lands.** It carries two
captures that can only be taken from the unmodified system:

1. Performance figures → `specs/043-preview-responsiveness/baseline.md` (FR-023a, FR-023b). SC-003,
   SC-005, SC-006a and SC-009 are unevaluable without them.
2. Render-equivalence reference fixtures → `apps/web/e2e/render-equivalence/fixtures/previous-engine/`
   (FR-023c). US6's regression gate compares against these.

There is exactly one moment when both are available. Missing it means reconstructing the reference
from a reverted build, which in practice does not happen.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: dependency and directory scaffolding. No behaviour changes.

- [X] T001 Add `morphdom` `^2.7.8` to `dependencies` in `apps/web/package.json` and install, then
      confirm the architecture guard's declared-dependency check passes — it must be a declared direct
      dependency of `apps/web`, never relied on transitively (plan §Structure Decision, research R1)
- [X] T002 [P] Scaffold `apps/web/e2e/render-equivalence/` with `corpus/`, `fixtures/previous-engine/`,
      `fixtures/reference-toolchain/` and `harness/`, and add the runnable script entries to
      `apps/web/package.json` matching the commands in `contracts/render-equivalence.md` §Execution

**Checkpoint**: `morphdom` declared, equivalence suite directory runnable (empty).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: reconcile the drifted worker↔hook wire type before any story edits either side.

**⚠️ CRITICAL**: T003 blocks US3 (which adds a field to this type) and must land before it.

- [X] T003 Create `apps/web/src/workers/render-protocol.ts` as the single declaration of
      `RenderRequest`, `RenderResult` and `RenderDocumentDetails`, import it from both
      `apps/web/src/workers/asciidoc-render.worker.ts` (currently `:336-363`) and
      `apps/web/src/hooks/use-asciidoc-preview.ts` (currently `:27-36`), and delete both local copies.
      This closes the existing drift — the worker already sends `details` and the hook's copy does not
      declare it. **No new fields in this task**; additive only, behaviour unchanged
      (`contracts/render-result.md` C1). Gate is `pnpm --filter @asciidocollab/web typecheck` on
      source, NOT a green test run — jest here is transpile-only and `tsc` excludes `tests/`

**Checkpoint**: one wire type, two importers, typecheck green. User story work can begin.

---

## Phase 3: User Story 3 - Render cost is measurable (Priority: P1 — delivered first) 🎯 MVP

**Goal**: every render reports its stage costs; the current behaviour of the whole preview is recorded
in a committed artifact; the reference fixtures US6 is gated on are captured from the unmodified
engine.

**Independent Test**: render a document in a development build and confirm per-render stage timings are
visible; render a much larger document and confirm the reported timings grow accordingly.

- [X] T004 [US3] Add `RenderTimings` (`parseMs`, `convertMs`, `postProcessMs`, `totalMs`, all ≥ 0) to
      `apps/web/src/workers/render-protocol.ts` and instrument
      `apps/web/src/workers/asciidoc-render.worker.ts` to time `load()`, `convert()` and its own
      whole-document post-conversion passes separately with `performance.now()`, returning them on the
      result. **Omit `timings` entirely when `ok: false`** — zeros would poison the US4 adaptive delay
      (FR-021, data-model §RenderTimings, `contracts/render-result.md` C1)
- [X] T005 [US3] Surface `timings: RenderTimings | null` on the `useAsciidocPreview` return value in
      `apps/web/src/hooks/use-asciidoc-preview.ts`, retaining the most recent **successful** render's
      timings (FR-021, `contracts/render-result.md` C2)
- [X] T006 [US3] Stop discarding the already-computed `RenderStats` in
      `apps/web/src/hooks/use-pdf-preview.ts` (`:140-151`) and surface it from
      `apps/web/src/lib/pdf/pdf-render-controller.ts` (`:363-366`) — `coldStartMs`, `renderMs`,
      `cacheHits`, `rasterFallbacks`. No shape change in this task (FR-022)
- [X] T006a [US3] Report the real raster-fallback count in
      `apps/web/src/lib/pdf/pdf-render-controller.ts` (`:365`), which
      `packages/asciidoc-pdf/src/pipeline/stages/diagrams-math.ts` (`:706-714`) already knows, instead
      of the hardcoded `0`. Separate from T006 because surfacing a discarded value and correcting a
      fabricated one are different deliverables: the first changes who can see a number, the second
      changes whether the number is true (FR-022c)
- [X] T006b [US3] Add `stages: PdfRenderStages` to `RenderStats` in
      `packages/asciidoc-pdf/src/protocol.ts` and populate the main-thread-observable stages in
      `apps/web/src/lib/pdf/pdf-render-controller.ts` — VM boot around `warmup`, `populateMs` around
      `populateProject`, `pipelineMs` around `runPipeline`, `convertMs` around `invokeConvert`.
      Additive: a consumer ignoring `stages` behaves exactly as today (FR-022a, data-model
      §PdfRenderStages)
- [X] T006c [US3] Instrument the in-VM stages — parse, converter walk, **dry runs**, font parse and
      subset, and serialisation — inside `packages/asciidoc-pdf/src/convert/invoke.ts`, returning them
      by the same write-to-VFS-and-read-back mechanism that file already uses for the convert result
      and the optimize probe. Do NOT read them off the `eval` return value: a `memory.grow` mid-eval
      invalidates that read (`invoke.ts:368-380`), which is why the mechanism exists. The dry-run
      figure is the one this task exists for — reporting only the stages observable from outside the
      VM does not satisfy FR-022a.
      **Verification, in two parts, because neither alone is sufficient.** (a) Red phase and unit gate:
      `pnpm --filter @asciidocollab/asciidoc-pdf test`, using the existing `FakeVm`
      (`tests/convert/invoke.test.ts:69`) which records every eval'd program and serves VFS reads
      back — that proves the figures are requested and parsed correctly, but it cannot produce a real
      duration, because the fake never runs Ruby. (b) Real figures:
      `pnpm --filter @asciidocollab/asciidoc-pdf test:integration`, which needs a built wasm engine at
      `packages/asciidoc-pdf/ruby/asciidoctor-pdf.wasm`. **Build it first** — `pnpm --filter
      @asciidocollab/asciidoc-pdf build:wasm`. Without it, `engine-smoke.mjs` (`:427-428`) prints
      "wasm engine not present; nothing to measure" and exits `{ ran: false }` **with a success
      status**. That is the same silent-skip hazard as a SKIPPED Job 6, and it counts as a failure
      here for the same reason: T011's baseline cannot be filled from a run that measured nothing
      (FR-022a, FR-022b)
- [X] T007 [P] [US3] Create the dev-only overlay
      `apps/web/src/components/preview/render-stats-overlay.tsx`, gated on
      `process.env.NODE_ENV !== 'production'` so Next.js dead-code-eliminates it from the production
      bundle. It must render **two structurally different shapes** — the web path's `RenderTimings`
      (four fields) and the page path's `RenderStats` plus `PdfRenderStages` (four counters and nine
      stages) — so design it around a stage list supplied by the caller rather than around fixed field
      names, or it will be built for one format and retrofitted for the other. Design tokens only,
      correct in light and dark mode (Principle V); renders **outside** `.asciidoc-preview-content` so
      document-rendering style scoping is untouched (Principle VI) (FR-023, research R6)
- [X] T008 [US3] Wire the overlay into `apps/web/src/components/asciidoc-preview.tsx` and
      `apps/web/src/components/pdf-preview-panel.tsx` so both preview formats show their stage timings
      in development and neither shows anything in production (FR-023, SC-008)
- [X] T009 [US3] Author the web-format render-equivalence corpus in
      `apps/web/e2e/render-equivalence/corpus/`, covering every row of the coverage table in
      `contracts/render-equivalence.md` §G1: headings at every level with and without `sectnums`;
      explicit `[[anchors]]` and internal `xref`s; source blocks with and without a declared language;
      tables, lists, admonitions, footnotes, callouts; attribute entries and `ifdef`/`ifeval`
      conditionals; an `include::` tree with `leveloffset`; diagram and stem blocks; images both
      `imagesdir`-relative and absolute (FR-025a)
- [X] T010 [US3] Build the capture harness `apps/web/e2e/render-equivalence/harness/capture.ts` and run
      it against the **unmodified current engine**, writing one HTML fixture per corpus document to
      `apps/web/e2e/render-equivalence/fixtures/previous-engine/`. This is the only moment this capture
      is possible (FR-023c, `contracts/render-equivalence.md` §G1 Reference capture)
- [X] T011 [US3] Run the baseline measurement pass against the unmodified application and write
      `specs/043-preview-responsiveness/baseline.md`, recording for each figure the document used and
      its line count, the measured value, how it was obtained, and the date. Required coverage:
      time-to-first-render after a file switch (feeds SC-003); delay from last keystroke to refresh
      (feeds SC-005); conversion time across the document size range and the downloaded size of the
      conversion code (both feed SC-009); and **main-thread work during a sustained editing session on
      a document containing diagrams and equations** (feeds SC-006a — without this figure the
      Principle XIII claim in the plan can only be asserted, never confirmed); and the
      **page-formatted path's per-stage render cost** across the document size range, from T006b/T006c
      (feeds SC-008a, and is the input `044-pdf-render-performance` is gated on). Reserve a section for
      the FR-028 idle-machine re-measurement that US7 will fill, and mark the per-stage figures as
      **taken with render-VM reuse in force**, so that if T041 changes that reuse it is visible which
      figures T041 invalidates (FR-023a, FR-023b, FR-028b)

**Checkpoint**: US3 complete. Both irreversible captures are on disk and committed. Behavioural work
may now begin. **Do not start Phase 4 until T010 and T011 are committed.**

---

## Phase 4: User Story 1 - The preview keeps refreshing while I keep typing (Priority: P1)

**Goal**: the documented maximum-staleness guarantee is actually honoured, on both preview formats,
without stacking refreshes on slow documents.

**Independent Test**: type continuously for longer than the guaranteed refresh interval without ever
pausing; the preview updates at least once during that stretch, showing text entered after the previous
update.

- [X] T012 [US1] Extend `MaxWaitDebounce` in `apps/web/src/lib/max-wait-debounce.ts` with `flush()`
      and `setInProgress(busy)`, implementing the full transition table in
      `contracts/refresh-schedule.md` §S2: max-wait elapsing while a render is in progress
      **suppresses** and records `deferredByProgress`; `setInProgress(false)` with a deferred pending
      run fires it **immediately**. Suppression and re-arm are two distinct behaviours — implementing
      the first without the second makes the guarantee fire once and lapse silently for the rest of
      the session, which is the same defect class this feature exists to fix (FR-004, FR-004a, FR-005,
      SC-001a)
- [X] T013 [US1] Remove the per-edit cleanup in `apps/web/src/hooks/use-asciidoc-preview.ts`
      (`:251-259`) that calls `cancel()` before every re-schedule and so re-arms the max-wait cap from
      zero on every keystroke, move cancellation to an unmount-only effect, and drive `setInProgress`
      from the hook's in-flight state (FR-001, FR-002, `contracts/refresh-schedule.md` §S1)
- [X] T014 [US1] Apply the identical fix in `apps/web/src/hooks/use-pdf-preview.ts` (`:222-225`) and
      drive `setInProgress` from its existing `isRendering` state, so the page-formatted preview honours
      the same guarantee and self-limits on renders longer than the interval (FR-004)
- [X] T015 [P] [US1] Correct the `PREVIEW_MAX_WAIT_MS` documentation in
      `apps/web/src/lib/editor-config.ts` (`:23-28`) to state the actual contract — "at least once per
      maximum-staleness interval, or as soon as the refresh in progress finishes, whichever is later" —
      so the stated guarantee and the shipped behaviour agree (FR-004b)
- [X] T016 [US1] Deliver the story's acceptance coverage as `apps/web/e2e/preview-refresh-guarantee.spec.ts`:
      continuous typing refreshes the preview at least once per interval on **both** preview formats;
      on a slow-rendering document at most one refresh is in progress at any moment and refreshes
      continue for as long as the typing does (SC-001, SC-001a)

**Checkpoint**: the refresh guarantee is real on both formats and self-limiting on slow documents.

---

## Phase 5: User Story 2 - Switching file or preview format shows the new content straight away (Priority: P1)

**Goal**: the render worker outlives file switches, format switches and panel closes, is supervised
when it dies, and switching never shows an error message or a blank panel.

**Independent Test**: open a project with several AsciiDoc files, click between them repeatedly, and
observe each switch showing the new file's rendered content with no intervening error message or blank
panel, noticeably faster than a full application reload.

- [X] T017 [US2] Replace `apps/web/src/lib/create-render-worker.ts` with the retained, supervised
      holder exposing exactly `acquireRenderWorker(handlers) → { post, release, retry }` per
      `contracts/refresh-schedule.md` §S4. **`release()` reaching zero consumers must NOT terminate the
      worker** — it arms an idle-retention timer, and `acquire()` cancels it, so a format switch or
      panel reopen inside the window is a cache hit with no startup cost. Terminate only when that
      timer elapses with the count still at zero. This is the requirement's whole substance: the
      web-formatted preview is the worker's only consumer, so zero consumers is exactly the transition
      FR-007/FR-007a protect, and terminating there satisfies FR-006 while failing FR-007. Supervision:
      a worker `error`/unexpected close rebuilds and re-issues `lastRequest` while
      `rebuildCount < MAX_ENGINE_REBUILDS`, beyond which it transitions to `'failed'` and calls
      `onEngineFailed()`; `retry()` resets the count and rebuilds. **A failed render (`ok: false`)
      keeps the worker** — conflating it with a dead worker either tears down a healthy worker on a
      syntax error or leaves a dead one forever. Add `MAX_ENGINE_REBUILDS` (3) and
      `RENDER_WORKER_IDLE_RETENTION_MS` (60_000) as named constants in
      `apps/web/src/lib/editor-config.ts` (FR-006, FR-007, FR-007a, FR-012, FR-012a, FR-012b, FR-012c,
      data-model §RenderWorkerHolder)
- [X] T018 [US2] Consume the holder from `apps/web/src/hooks/use-asciidoc-preview.ts` — acquire once
      per hook instance, release on unmount — and implement the file-switch sequence from
      `contracts/refresh-schedule.md` §S5: post immediately rather than waiting for the trailing delay
      (FR-005), keep the previous content visible with `state: 'rendering'` (FR-009), reset
      `previewRef.current.scrollTop` to 0 (FR-010), and discard superseded in-flight results via the
      existing `requestId` guard (FR-011). Expose `engineFailed` and `retryEngine` on the return value
      (`contracts/render-result.md` C2)
- [X] T019 [US2] Remove the file-keyed remount `key={selectedFile?.nodeId}` on `<AsciiDocPreview>` in
      `apps/web/src/app/(dashboard)/dashboard/projects/[id]/project-editor-layout.tsx:1393`, and fix
      `apps/web/src/components/asciidoc-preview.tsx:452-453` so the "preview not available for this
      file type" message is shown only for files that genuinely cannot be previewed, never for
      `state === 'idle'` during a switch between two previewable files (FR-008, FR-009)
- [X] T020 [US2] Add the persistent engine-failure surface to
      `apps/web/src/components/asciidoc-preview.tsx`: when `engineFailed` is set, stop restarting
      automatically and show a persistent error offering a manual retry that calls `retryEngine`
      (FR-012b, FR-012c)
- [X] T021 [US2] Deliver the story's acceptance coverage as `apps/web/e2e/preview-file-switch.spec.ts`:
      repeated switching between two previewable files shows zero error messages and zero blank panels;
      switching web→page→web format does not repeat the engine-startup cost; **closing the preview
      panel and reopening it does not repeat it either** (FR-007a — the case a consumer-counted
      lifetime silently breaks); a terminated engine is recovered automatically and repeated
      terminations stop after the bound rather than looping. Compare time-to-content against
      `baseline.md` (SC-002, SC-003, SC-004, SC-004a)

**Checkpoint**: the engine is long-lived, retained across every no-consumer gap, and supervised;
switching is clean. US1 and US2 together are the felt-latency MVP.

---

## Phase 6: User Story 4 - Small documents feel near-live (Priority: P2)

**Goal**: the trailing delay is derived from measured render cost instead of fixed at the worst case.

**Independent Test**: type into a small document and into a very large one; the small document's preview
follows the typing visibly more closely while the large document's preview is no slower than today.

**Depends on**: US3 — this is a data dependency (`RenderResult.timings.totalMs`), not a preference.

- [X] T022 [P] [US4] Create the pure function `adaptiveDelayMs(lastRenderMs: number | null): number` in
      `apps/web/src/lib/preview/adaptive-delay.ts` implementing
      `clamp(lastRenderMs × 2, PREVIEW_ADAPTIVE_MIN_MS, PREVIEW_DEBOUNCE_MS)`, returning
      `PREVIEW_DEBOUNCE_MS` when `lastRenderMs` is `null`. Add `PREVIEW_ADAPTIVE_MIN_MS` (120) as a
      named constant in `apps/web/src/lib/editor-config.ts` — no literals at the call site
      (Principle I). The behaviour table in `contracts/refresh-schedule.md` §S3 is the specification
      (FR-003)
- [X] T023 [US4] Feed the most recent **successful** render's `timings.totalMs` into the schedule in
      `apps/web/src/hooks/use-asciidoc-preview.ts` via `adaptiveDelayMs`, held in a ref and seeded
      `null`. A failed render carries no timings and must leave the delay unchanged rather than
      resetting it (FR-003, US4 scenario 4)
- [X] T024 [US4] Deliver the story's performance assertion as
      `apps/web/e2e/preview-adaptive-delay.spec.ts`: a ~100-line document refreshes within 200 ms of
      the last keystroke, and a ~15,000-line document refreshes no later than the figure recorded in
      `baseline.md`. Performance assertions are in scope here by explicit spec request (SC-005, plan
      §Constitution Check II)

**Checkpoint**: short documents follow typing closely; large documents are no slower than baseline.

---

## Phase 7: User Story 5 - Diagrams, equations and reading position survive an edit (Priority: P3)

**Goal**: refreshes patch the displayed output in place instead of replacing it, so unchanged diagrams
and equations are left alone and scroll position and keyboard focus survive.

**Independent Test**: open a document containing several diagrams and equations, scroll part-way down,
edit a paragraph of prose that is not part of any diagram, and confirm the diagrams are not redrawn,
the equations are not re-typeset, and the scroll position is retained.

**⚠️ Largest change surface in the feature.** The ~23 existing preview e2e specs assert against the
rendered DOM, not the hook's `html` string, and are the primary regression net.

- [X] T025 [US5] Create `apps/web/src/lib/preview/morph-preview.ts` wrapping `morphdom` and exporting
      `morphPreview(container: HTMLElement, incoming: DocumentFragment): MorphOutcome`. Implement both
      delegated decisions from `contracts/morph-policy.md`: `getNodeKey` returns author `[[anchor]]`
      and auto-generated heading ids but **`undefined` for synthetic `__src_<context>_<line>` ids and
      for elements with no id**; `onBeforeElUpdated` returns `false` for `.adc-diagram-output` and
      `mjx-container` whose incoming source text is identical, and `true` otherwise. Compare **source
      text, never position**. Order the commit as: read focus → read `scrollTop` from the scroll
      container → `morphdom(..., { childrenOnly: true })` → restore focus (falling back to the
      container when the element is gone) → restore `scrollTop` → return counts. The R2 failure mode is
      the one to design against: **inserting a paragraph at the top must not rebuild the blocks below**
      — getting `getNodeKey` backwards turns every insertion into a full-document rebuild while every
      other behaviour still looks correct (FR-013, FR-014, FR-015, FR-016, FR-017, FR-020a, FR-020b,
      research R2)
- [X] T026 [US5] Mark diagrams that failed to draw with an explicit marker attribute in
      `apps/web/src/components/diagrams/render-diagrams.ts`, so the skip rule can distinguish
      "unchanged source" from "successfully drawn" and retry a failed diagram on the next refresh
      instead of freezing it on screen permanently (FR-016a)
- [X] T027 [US5] Change the sanitiser call at `apps/web/src/hooks/use-asciidoc-preview.ts:175` to
      `DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true })` — same
      sanitiser, same profile, same allow-list, same call site, return type only. The other three call
      sites (`asciidoc-paste.ts:40`, `use-html-export.ts:317`, `render-diagrams.ts:122`) are
      **untouched**. **Principle VIII/IX obligation**: this deliverable is not done until a payload
      rejected in string mode is proven rejected identically in fragment mode — same input, same
      verdict (FR-018, research R3, `contracts/render-result.md` C3)
- [X] T028 [US5] Move the commit into `apps/web/src/hooks/use-asciidoc-preview.ts`: sanitise to a
      fragment and `morphPreview` it into a new `outputRef`, adding `outputRef` and `renderNonce` to the
      return surface while **retaining `html`** as the render's identity for tests and the export path.
      `renderNonce` bumps after each successful commit because `html` is no longer a valid "the DOM
      changed" signal — the same string can be committed to a different DOM after a file switch back,
      and a morph can change the DOM without a new string. The existing 1062-line hook suite asserts
      against the old commit path and is revised as part of this deliverable, inside its red phase —
      not as a follow-up task. Because `apps/web` jest is transpile-only and `tsc` excludes `tests/`,
      confirm the contract itself with `pnpm --filter @asciidocollab/web typecheck`, not with a green
      test run (`contracts/render-result.md` C2, research R8)
- [X] T029 [US5] Update `apps/web/src/components/asciidoc-preview.tsx`: drop
      `dangerouslySetInnerHTML`, supply `outputRef` as the morph target, re-key the three effects
      currently depending on `html` (`:260`, `:308`, `:368`) onto `renderNonce`, and set `aria-busy` on
      the container while a render is in flight, clearing it on completion (FR-019, FR-020, FR-020c)
- [X] T030 [US5] Run the full existing preview e2e suite **unmodified** as the regression net
      (`pnpm --filter @asciidocollab/web exec playwright test e2e/preview-` plus
      `editor-preview-*.spec.ts`, `collab-consistency-preview.spec.ts`, `project-preview.spec.ts`) and
      deliver the story's acceptance coverage as `apps/web/e2e/preview-morph-preservation.spec.ts`:
      zero diagram redraws and zero equation re-typesets across a sustained editing session, unchanged
      `scrollTop` across a refresh in an image-bearing document, and keyboard focus surviving a refresh
      wherever the focused element still exists (SC-006, SC-007, SC-007a). The existing scroll-sync and
      click-to-source specs MUST pass unmodified — that is the Principle VIII verification obligation
- [X] T031 [US5] Measure main-thread work during a sustained editing session on the same
      diagram-and-equation document used for the baseline, and confirm it is no greater than the figure
      recorded in `specs/043-preview-responsiveness/baseline.md`; record the post-change figure there
      alongside it. The plan's Principle XIII argument is that replacing a whole-document `innerHTML`
      re-parse with a patch, and removing the per-keystroke diagram and math rework, reduces
      main-thread work on net — this task is what turns that from a claim into evidence, and a
      regression here is a finding, not a rounding error (SC-006a, plan §Constitution Check XIII)

**Checkpoint**: refreshes are partial; diagrams, equations, scroll and focus survive an edit, and the
main-thread claim is measured rather than asserted.

---

## Phase 8: User Story 6 - Documents convert faster (Priority: P4)

**Goal**: migrate to Asciidoctor.js v4.0.6 behind gates that actually exercise the engine being
changed — and give the web-formatted preview the external fidelity oracle it has never had.

**Independent Test**: render the equivalence corpus with the upgraded engine and compare it against
both the fixtures captured from the previous engine and the canonical reference toolchain's HTML;
compare measured conversion time and downloaded code size against the recorded baseline; confirm the
two preview formats still agree via a comparison that reads both outputs.

**Depends on**: US3 (T010 fixtures, T011 baseline).

**⚠️ Build all gates BEFORE the upgrade.** A gate written after the change is a gate written to pass
it. G0's first run is expected to fail on divergences that predate this feature — a clean first run is
more likely evidence that the normalisation is too permissive than that the renderer is perfect.

- [X] T032 [US6] Build the **pinned** HTML reference toolchain and its harness under
      `apps/web/e2e/render-equivalence/harness/`: a digest-pinned base image, a `--frozen` locked gem
      closure, a fixed `SOURCE_DATE_EPOCH`, and an image tag derived from a hash of those definition
      files, by generalising `apps/web/e2e/pdf-parity/tools/reference-image.mjs` to build *a*
      definition set rather than only its own. **The PDF definition set stays the default so its tag is
      byte-identical to today's** — re-tagging it would put the committed page-format reference corpus
      that SC-010c depends on in question. Then implement `reference-build.ts`, driving that toolchain
      over the corpus with the **same assembled source and the same seeded attributes** the app uses,
      and the normalisation for each intended divergence enumerated in
      `contracts/render-equivalence.md` §G0 — including the canonical
      `<adc-diagram type="TYPE">SOURCE</adc-diagram>` reduction that both sides collapse to.
      **Anything not on that enumerated list that differs is a failure** (FR-025c, FR-025c-i, FR-025d)
- [X] T033 [US6] Add `apps/web/e2e/render-equivalence/web-format-reference.spec.ts` comparing in-app
      web-format output against the canonical reference build for every corpus document, and triage the
      first run's divergences — each is either normalised via a named pass or enumerated as a deliberate
      divergence with justification. Zero unexplained differences. **This is the gate that discharges
      Principle XV** (FR-025c, FR-025d, SC-010d)
- [X] T034 [US6] Add `apps/web/e2e/render-equivalence/web-format-equivalence.spec.ts` comparing current
      output against the `fixtures/previous-engine/` fixtures captured in T010, under the FR-024
      normalisation: inter-element whitespace and attribute **ordering** normalised away; attribute
      values, element structure, hierarchy and text compared; `id` attributes and
      `data-source-line`/`data-source-file` compared **exactly** and never normalised, because unlike
      whitespace they carry behaviour. This is a **regression** gate and does not discharge Principle XV
      (FR-025a, FR-024, FR-024a, SC-010, SC-010a)
- [X] T035 [US6] Extend `apps/web/e2e/pdf-parity/harness/pdftools.ts` with internal link-destination
      extraction — walk each page's `/Annots` for `/Subtype /Link` and resolve the destination to a page
      and named target. Today the harness exposes `pageCount`, `extractText`, `pageInkMaps` and
      `compareInkMaps` only. Without this the third dimension of FR-025b is unimplementable and would
      quietly degrade to a two-dimension check still reported as satisfying the requirement (FR-025e,
      SC-010e)
- [X] T036 [US6] Add `apps/web/e2e/render-equivalence/cross-format-agreement.spec.ts` comparing
      web-formatted and page-formatted output on the three dimensions both media can express: rendered
      block text sequence, heading hierarchy and numbering, and cross-reference target set (using
      T035's extraction). Fonts, spacing, colour, page breaks and layout are explicitly **not**
      compared — those remain the province of the existing parity suite (FR-025, FR-025b, SC-010b,
      SC-010e)
- [X] T037 [US6] Upgrade `asciidoctor` from `^3.0.4` to `4.0.6` in `apps/web/package.json` and convert
      the now-async API in `apps/web/src/workers/asciidoc-render.worker.ts` — `load`/`convert` return
      Promises, so `onmessage` (`:415-672`) becomes an async handler; the `requestId` staleness protocol
      is unaffected. **Re-verify each document API call explicitly against v4** — `findBy`,
      `getSourceLocation`, `getStyle`, `getSource`, `setId`, `getAttribute`, `convert` — because those
      objects are dynamically typed at that boundary, so a rename is a silent behaviour change rather
      than a compile error. Gates T033, T034 and T036 must all be green after the change (research R4)
- [X] T038 [US6] Measure conversion time and the downloaded size of the conversion code against
      `specs/043-preview-responsiveness/baseline.md`, record the result in that artifact, and run the
      pre-existing page-format parity suite **unchanged** to confirm the page-formatted path was not
      disturbed. Invoke it so it **actually runs** — `scripts/ci/pdf-parity.sh` directly, or
      `pnpm gate` with poppler-utils and a built wasm engine present. `gate.sh:47-53` reports Job 6 as
      SKIPPED when either is missing, which would make SC-010c green having compared nothing; a skip
      counts as a failure here. The supplied v4 figures are hypotheses; SC-009 is judged against the
      recorded baseline (SC-009, SC-010c)

**Checkpoint**: conversion is faster and smaller, verified against a pinned external oracle, and the
web-formatted preview finally has a reference build.

---

## Phase 9: User Story 7 - Large documents export without hitting a wall (Priority: P2)

**Goal**: the page-formatted path either handles documents past the observed failure threshold or names
its limit — no opaque engine crash. Shares no code with US1–US6 and can be dropped without disturbing
any other story.

**Independent Test**: render a document past the observed failure threshold and confirm it either
completes, or fails with a message naming the limit — not with an engine crash.

- [X] T039 [US7] Determine the page-formatted path's actual supported document size by measurement in
      `packages/asciidoc-pdf`, characterising the out-of-memory failure observed at roughly 1,700
      lines / 80 pages, and record the measured bound in
      `specs/043-preview-responsiveness/baseline.md` (FR-027)
- [X] T040 [US7] Raise the supported bound to cover the measured range where the measurement supports
      it, and where a document genuinely exceeds it, fail with a clear, actionable message naming the
      limit and what to do about it rather than an opaque engine crash — keeping the application usable.
      Implement in `packages/asciidoc-pdf/src/pipeline/` (FR-027, FR-027a)
- [X] T041 [US7] Re-measure the reported degradation of repeated renders in a reused **page-format
      render VM** (~3 s rising to ~11 s over eight consecutive renders, against 2.9–3.4 s for a fresh
      VM each time) on an **otherwise idle machine** — the original figures were taken while the e2e
      suite occupied the same machine, so they may measure contention rather than degradation — and
      record the outcome in `specs/043-preview-responsiveness/baseline.md` either way. If confirmed,
      change VM reuse in `packages/asciidoc-pdf/src/vm/ruby-pdf-vm.ts` to whatever the measurement
      supports; if not reproduced, record that so the claim stops circulating. **If this task changes
      render-VM reuse, re-measure the per-stage figures T011 recorded and update them in place** — they
      were taken with reuse in force and VM boot is one of the stages they break out, so a change here
      changes the profile they describe. Leaving them would keep an artifact describing an arrangement
      the product no longer uses, still cited as current, which is the same failure this task exists to
      end (FR-028, FR-028a, FR-028b, SC-012)
- [X] T042 [US7] Deliver the story's acceptance coverage as
      `apps/web/e2e/pdf-preview-large-document.spec.ts`: a document at least twice the previously
      observed failure threshold either renders to the page format successfully or fails with a message
      naming the supported limit — zero opaque engine crashes (SC-011)
- [X] T043 [US7] Re-run the page-format reference-parity suite after T041 and confirm SC-010c still
      holds. T038's check predates this story, and T041 may change page-format render-VM reuse — which
      is squarely on the path SC-010c covers, so "unchanged throughout this feature" is not established
      by a check taken before the change. Invoke it so it actually runs, per T038's caution (SC-010c)

**Checkpoint**: the page-formatted path has a declared bound, an honest failure mode, and confirmed
parity after the change.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T044 [P] Audit every caller of `stripReservedAttributes` in
      `packages/asciidoc-core/src/extraction/document-order.ts:32` **before changing it** —
      `include-graph.ts:81`, `attribute-scope.ts:85` and `attribute-scope.ts:183` — then either make it
      return a copy as its documentation claims, or document the in-place mutation it actually performs.
      This is the single authority feeding attribute scope, `{ref}` resolution and the include graph,
      and the in-place delete has been the real behaviour long enough that callers may depend on it.
      Independent of all seven stories; may land at any point after the audit (FR-026)
- [X] T045 [P] Write `apps/web/e2e/render-equivalence/README.md` documenting what each of the four
      gates proves, which principle each discharges, why the page-format parity suite cannot serve as
      the web-format gate, and why the HTML oracle carries its own pinned definition set rather than
      sharing the PDF one — so those distinctions survive the next person to touch it
- [ ] T046 Run the full quality-gate sweep: `pnpm gate` with capped workers
      (`pnpm --filter @asciidocollab/web test -- --maxWorkers=4`), `pnpm typecheck` on all packages,
      lint, and the complete e2e suite including the new render-equivalence specs. **Job 6 must run,
      not skip** — provision poppler-utils and a built wasm engine, or invoke
      `scripts/ci/pdf-parity.sh` directly; a SKIPPED Job 6 is a failed sweep for this feature because
      SC-010c depends on it (Constitution §End-of-Feature Verification)
- [ ] T047 Run `/code-review` in a loop until zero findings, then verify every success criterion
      SC-001…SC-012 against the recorded figures in `specs/043-preview-responsiveness/baseline.md` —
      not against recollection

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup; T003 blocks US3
- **US3 (Phase 3)**: depends on Foundational. **Blocks every other story** — its two captures are
  irreversible
- **US1 (Phase 4)**, **US2 (Phase 5)**: depend on US3 completion only; independent of each other and
  may be delivered in either order
- **US4 (Phase 6)**: depends on US3 (data dependency: `timings.totalMs`)
- **US5 (Phase 7)**: depends on US3 (T031 needs the main-thread baseline); independent of US1/US2/US4
  in principle, but sequenced after them because it carries the largest change surface
- **US6 (Phase 8)**: depends on US3 (T010 fixtures, T011 baseline)
- **US7 (Phase 9)**: depends on T011's baseline artifact existing; shares no code with US1–US6 and is
  droppable — but if it *is* delivered, T043 is not optional
- **Polish (Phase 10)**: T044 is independent of everything; T046/T047 depend on all delivered stories

### User Story Dependencies

```text
Setup → Foundational → US3 ─┬─→ US1 ──┐
                            ├─→ US2 ──┤
                            ├─→ US4 ──┼─→ US5 → US6 → Polish
                            └─────────┘
                                   US7 (independent, droppable; T043 mandatory if delivered)
```

### Within Each User Story

- Each task is one `/tdd` invocation — red, green, refactor
- Pure functions and protocol types before the hooks that consume them
- Hooks before the components that render them
- The story's acceptance coverage closes the story

### Critical Sequencing Rules

1. **T010 and T011 must be committed before any task in Phase 4 or later.** Both capture state that
   ceases to exist once behaviour changes.
2. **T032–T036 must be green before T037.** A gate written after the upgrade is a gate written to pass
   it.
3. **T012 before T013/T014** — the hooks cannot drive `setInProgress` before it exists.
4. **T022 before T023** — the hook consumes the pure function.
5. **T025–T027 before T028** — the hook cannot morph before `morphPreview` and the fragment sanitiser
   exist.
6. **T041 before T043** — the point of T043 is to check what T041 changed.
7. **T044's caller audit precedes its change** — non-negotiable; the in-place behaviour may be depended
   upon.
8. **T006b and T006c before T011.** T011 records the per-stage figures those two tasks produce; run
   before them it would record a breakdown that does not exist yet.
9. **T006c requires a built wasm engine before it can be considered done.** Its unit gate passes
   against a fake VM that never runs Ruby, so it can go green having measured nothing. See the task.
10. **If T041 changes render-VM reuse, T011's per-stage figures are re-measured within T041.** They
    were captured under the arrangement T041 may remove (FR-028b).

### Parallel Opportunities

- T002 runs alongside T001
- T007 (overlay component) runs alongside T004–T006c
- T015 (config doc) runs alongside T012–T014
- T022 (pure function) runs alongside any US2 task
- T035 (pdftools link extraction) runs alongside T032–T034 — different file, no dependency
- T044 and T045 run alongside each other and alongside any story phase
- US1 and US2 can be worked in parallel by two developers once US3 is committed

---

## Parallel Example: User Story 3

```bash
# After T003 lands, these three touch different files and can run together:
Task: "T004 Instrument the render worker with stage timings in apps/web/src/workers/asciidoc-render.worker.ts"
Task: "T007 Create the dev-only overlay in apps/web/src/components/preview/render-stats-overlay.tsx"
Task: "T009 Author the equivalence corpus in apps/web/e2e/render-equivalence/corpus/"
```

## Parallel Example: User Story 6

```bash
# Gate construction — T035 is in a different file from T032-T034:
Task: "T032 Build the pinned HTML reference toolchain and harness in apps/web/e2e/render-equivalence/harness/"
Task: "T035 Add link-destination extraction to apps/web/e2e/pdf-parity/harness/pdftools.ts"
```

---

## Implementation Strategy

### MVP scope

**US3 + US1 + US2** (T001–T021). US3 alone is not shippable value — it is the measurement that makes
every later claim checkable — but it must land first regardless. US1 and US2 together close the two
delay gaps every author feels on every document: the frozen preview during sustained typing, and the
error-flash-then-blank on every file switch. That is the smallest genuinely valuable increment.

### Incremental Delivery

1. Setup + Foundational → one wire type, `morphdom` declared
2. **US3** → timings visible, `baseline.md` and reference fixtures committed → **irreversible captures
   are safe**
3. **US1** → the refresh guarantee is real on both formats → validate independently
4. **US2** → clean, fast file and format switching, engine retained across every gap → validate → **MVP**
5. **US4** → short documents feel near-live → validate
6. **US5** → diagrams, equations, scroll and focus survive an edit; main-thread cost measured →
   validate against the ~23-spec regression net
7. **US6** → faster, smaller conversion behind four gates and a pinned oracle → validate
8. **US7** → declared page-format size bound, parity re-confirmed → validate
9. Polish → FR-026, docs, full gate sweep, `/code-review` to zero findings

Stop at any checkpoint and the feature is coherent. US7 can be dropped entirely without disturbing
anything else — it is sequenced last precisely so that remains true.

### Parallel Team Strategy

1. Everyone waits on US3. It is small and it blocks correctly.
2. Then: Developer A takes US1 (scheduling), Developer B takes US2 (worker lifetime). Different files,
   no shared surface beyond `use-asciidoc-preview.ts`, which needs coordination on T013/T018.
3. US4 follows US3 and can start alongside either.
4. US5 wants one developer with the whole change surface in view.
5. US7 can run in parallel with anything, by anyone — it shares no code.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task
- Each task = one `/tdd` invocation; never split test and implementation. Tasks name source paths only
  — test placement follows the Path Conventions rule and belongs to the skill
- Commit after each task or logical group, only after green
- **Performance assertions are in scope for this feature.** Principle II makes them opt-in and this
  spec explicitly requests them (SC-003, SC-005, SC-006a, SC-009, FR-023a), so they follow the same
  red-green discipline as any other test
- **`apps/web` jest is transpile-only and `tsc` excludes `tests/`** — a test can pass with an unfaithful
  fixture or the wrong argument order. Verify every contract change with
  `pnpm --filter @asciidocollab/web typecheck` on source
- **Cap jest workers.** 24 cores, no swap; default fan-out will OOM the machine
- Four traps worth re-reading before the tasks that hit them: releasing the worker at zero consumers
  destroys it on the very switch FR-007 protects (T017); `getNodeKey` must return `undefined` for
  synthetic ids (T025); suppression without re-arm is the same bug with a longer fuse (T012); a failed
  render and a dead worker are different events (T017)
