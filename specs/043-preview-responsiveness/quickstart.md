# Quickstart: Live Preview Responsiveness

**Feature**: `043-preview-responsiveness` | **Branch**: `043-preview-responsiveness`

Orientation for picking up implementation. Read [plan.md](./plan.md) for the governance argument and
[research.md](./research.md) for the design decisions — especially **R2**, which corrects a spec
assumption.

---

## The one-paragraph version

Conversion is not the bottleneck. It costs 6–540 ms across the whole document size range, against a
500 ms debounce that never yields during continuous typing, a render worker that is destroyed and
rebuilt on every file switch, and a commit step that redraws every diagram and re-typesets every
equation on each keystroke. Fix the scheduling and the lifecycle first, measure it, then change how
output reaches the DOM, then take the faster engine.

---

## Deliver in this order

| # | Story | Delivers | Depends on |
|---|---|---|---|
| 1 | **US3** measurement | Stage timings + **recorded baseline** + reference fixtures | — |
| 2 | **US1** max-wait cap | Refresh during sustained typing (both formats) | — |
| 3 | **US2** worker lifetime | No flash, no rebuild, supervised restart | — |
| 4 | **US4** adaptive delay | Small documents feel near-live | US3 (data) |
| 5 | **US5** DOM morph | Diagrams/math/scroll/focus survive an edit | — |
| 6 | **US6** Asciidoctor v4 | Faster conversion, smaller bundle, **plus the web-format reference build the preview has never had** | US3 (fixtures) |
| 7 | **US7** page-format size bound | No unbounded OOM; engine-reuse question closed | — |

**US3 is first even though it is not the most valuable.** The only moment "today" can be recorded is
before it changes; SC-003, SC-005 and SC-009 are otherwise unevaluable. It carries **two** captures,
both of which need the unmodified system:

1. Performance figures → committed to `baseline.md` (FR-023a, FR-023b). This includes **main-thread
   work during sustained typing** — the figure US5's Principle XIII claim is judged against (SC-006a).
   Without it that claim can only ever be asserted.
2. **Render-equivalence reference fixtures** → `apps/web/e2e/render-equivalence/fixtures/`
   (FR-023c). These are what US6's upgrade is compared against. Miss this and the reference has to be
   reconstructed from a reverted build, which in practice does not happen.

Capture both before touching anything else.

---

## Seven things that will bite

**0. Releasing the render worker at zero consumers destroys it on the switch you are protecting.**
The web-formatted preview is the worker's *only* consumer (`use-asciidoc-preview` is called once, in
`asciidoc-preview.tsx:203`), and it lives inside
`previewMode === 'html' ? … : …` gated by `showPreview && previewOpen`
(`project-editor-layout.tsx:1391`). Switch to the page format, or close the panel, and the count hits
zero — the exact moment FR-007/FR-007a require the worker to survive. Terminating there satisfies
FR-006 and fails FR-007, **and every test written against it passes**, because nothing asserts a
surviving worker across an unmount. Zero consumers arms a retention timer; `acquire` cancels it. See
`contracts/refresh-schedule.md` §S4.

**1. Line-derived ids are unstable — do not key the morph on them.**
Synthetic ids are `__src_<context>_<line>` (`asciidoc-render.worker.ts:582`) and `data-source-line`
is a line number. Insert one paragraph at the top and every id below changes. `getNodeKey` must
return `undefined` for synthetic ids so `morphdom` falls back to structural matching. Returning them
turns every insertion into a full-document rebuild **while every other test still passes**. See
research R2 and `contracts/morph-policy.md`.

**2. Suppressing the guarantee without re-arming it is the same bug with a longer fuse.**
FR-004 suppresses the max-wait refresh while a render is in flight. FR-004a re-arms it when that
render finishes. Implement only the first and the guarantee fires once, then lapses for the session.
Both need their own test.

**3. A failed render and a dead worker are different events.**
`ok: false` keeps the worker (FR-012). A worker `error` rebuilds it (FR-012a). Conflate them and you
either tear down a healthy worker on a syntax error, or leave a dead one forever. This matters
*because* US2 removes the per-switch rebuild that currently masks a crash by accident.

**4. `apps/web` jest is transpile-only and `tsc` excludes `tests/`.**
A test can pass with an unfaithful fixture or wrong argument order. Verify contract changes with
`pnpm typecheck` on source — a green test run proves nothing about the worker↔hook shape.

**5. The obvious parity gate for the v4 upgrade is the wrong one — and so is the obvious replacement.**
The page-format reference-parity suite (`e2e/pdf-parity/`) renders through ruby.wasm and **never loads
the JS engine** US6 upgrades — the JS `asciidoctor` package has exactly one non-build importer,
`asciidoc-render.worker.ts:1`. It passes whether the upgrade is correct or catastrophic. But the
natural fix — capture the old engine's output, compare the new one against it — is a *self-comparison*,
which Principle XV explicitly excludes from counting as a fidelity check. Both gates are needed and do
different jobs: **G0** compares against the canonical reference toolchain (external truth, discharges
XV), **G1** compares against the previous engine (isolates this upgrade's effect). See
`contracts/render-equivalence.md`. Expect G0's first run to fail on divergences that predate this
work — that is the gap it exists to expose. And G0's toolchain must be **pinned** the way the PDF one
is (digest-pinned base, `--frozen` lock, definition-hash tag), reusing
`e2e/pdf-parity/tools/reference-image.mjs` with its *own* definition set so the PDF image's tag — and
the committed corpus SC-010c rests on — stay untouched (FR-025c-i, research R4b).

**7. `pnpm gate` can go green having never run the parity suite.**
`scripts/ci/pdf-parity.sh` correctly refuses to skip, but `gate.sh:47-53` wraps it in a conditional
and reports Job 6 as SKIPPED when poppler-utils or the built wasm engine are missing. SC-010c is
evidence only if the comparison actually ran — provision the prerequisites or invoke the script
directly, and treat a skip as a failure.

**6. Capping test workers is not optional on this machine.**
24 cores, no swap. Default jest fan-out will OOM the box.

```bash
pnpm --filter @asciidocollab/web test -- --maxWorkers=4
```

---

## Files you will touch

```text
apps/web/src/
  workers/render-protocol.ts           US3  NEW — single RenderRequest/RenderResult/RenderTimings
                                            declaration (declared twice today; already drifted)
  workers/asciidoc-render.worker.ts    US3  time load/convert/post-process separately
  hooks/use-asciidoc-preview.ts        US1,2,3,4,5  (the centre of gravity)
  hooks/use-pdf-preview.ts             US1  same cleanup defect; US3 surface existing RenderStats
  lib/max-wait-debounce.ts             US1  flush() + in-progress gate + re-arm
  lib/create-render-worker.ts          US2  ref-counted holder + supervision
  lib/editor-config.ts                 US1,4  bounds & rebuild cap; FR-004b doc correction
  lib/preview/adaptive-delay.ts        US4  NEW, pure function
  lib/preview/morph-preview.ts         US5  NEW, morphdom wrapper
  lib/pdf/pdf-render-controller.ts     US3  stats already computed at :363-366 — stop discarding;
                                            add main-thread stage timings + real raster-fallback count
  components/asciidoc-preview.tsx      US2,3,5  stale content, overlay, fragment commit
  components/preview/render-stats-overlay.tsx  US3  NEW, dev-only

packages/asciidoc-pdf/src/
  protocol.ts                          US3  RenderStats gains `stages` (additive)
  convert/invoke.ts                    US3  time the in-VM stages incl. DRY RUNS; return them the way
                                            this file already returns the convert result (VFS write
                                            + read back) — NOT off the eval return value
  pipeline/, vm/                       US7  size bound + render-VM reuse re-measurement

packages/asciidoc-core/src/extraction/document-order.ts   FR-026 (audit callers first)
```

---

## Verifying

```bash
# Unit — capped workers
pnpm --filter @asciidocollab/web test -- --maxWorkers=4

# Types — the real gate for contract changes
pnpm --filter @asciidocollab/web typecheck

# The regression net for US5: ~23 preview specs, all asserting on DOM (not the html string)
pnpm --filter @asciidocollab/web exec playwright test e2e/preview-

# The gates for US6 — these exercise the engine being upgraded; e2e/pdf-parity does not
pnpm --filter @asciidocollab/web exec playwright test e2e/render-equivalence
```

Per the constitution: `/tdd` for every implementation task, and the full quality-gate sweep plus a
clean `/code-review` pass before the feature is done.

---

## Where the requirements live

| Question | File |
|---|---|
| What must be true | [spec.md](./spec.md) — FR-001…FR-026, SC-001…SC-010a |
| Why these decisions | [research.md](./research.md) — R1…R8 |
| Shapes and state | [data-model.md](./data-model.md) |
| Exact interfaces | [contracts/](./contracts/) — `render-result.md`, `refresh-schedule.md`, `morph-policy.md`, `render-equivalence.md` |
| Recorded pre-change figures | `baseline.md` — written by US3, does not exist until then |
| Governance argument | [plan.md](./plan.md) — Constitution Check, incl. the Principle VIII call-out |

---

## Independent item

- **FR-026** (`stripReservedAttributes` mutates despite documenting a copy) is independent of all
  seven stories. **Audit callers before changing it** — the in-place delete has been the real
  behaviour for a while, and this is the single authority feeding attribute scope, `{ref}` resolution
  and the include graph.

Nothing else is deferred. The page-format memory failure and the reused-engine degradation, both
previously recorded as follow-ups, are now User Story 7 (FR-027–FR-028a). The reasoning for their
original exclusion is retained in the spec's Out of Scope section, because it remains a fair
description of the size trade-off this feature accepted.
