# Phase 1 Data Model: Live Preview Responsiveness

**Feature**: `043-preview-responsiveness` | **Date**: 2026-07-26

No persisted data, no schema change, no Prisma migration. Every entity below is in-memory, browser
session-scoped, and lives in `apps/web`. Field names are the intended TypeScript shape.

---

## RenderTimings

Per-render stage costs, produced by the render worker and carried on its result. **New.**

| Field | Type | Notes |
|---|---|---|
| `parseMs` | `number` | Time in `load()` — parsing the assembled source into a document |
| `convertMs` | `number` | Time in `convert()` — producing output from the parsed document |
| `postProcessMs` | `number` | Time in the worker's own passes: diagram placeholder swap, image-source rewrite, syntax highlighting, source-line injection |
| `totalMs` | `number` | Whole handler duration, including assembly. `totalMs ≥ parseMs + convertMs + postProcessMs` |

**Validation**: every field ≥ 0. Measured with `performance.now()`.

**Why `postProcessMs` exists**: the spec (FR-021) requires parse and convert separately. The worker
also runs four whole-document string passes after conversion, and attributing their cost to neither
stage would leave an unexplained gap between the two figures and `totalMs` — the exact ambiguity the
measurement exists to remove.

**Determinism note (Principle XII)**: these values are *reported alongside* output, never *into* it.
No timing influences rendered content.

---

## RenderResult (extended)

The existing worker→main result. **Extended**, not replaced.

**Declared once, in `apps/web/src/workers/render-protocol.ts`**, and imported by both the worker and
the hook. It is currently declared independently on each side, and the two copies have already drifted
(the worker sends `details`; the hook's copy does not declare it). Not promoted to `packages/shared`:
that is reserved for types crossing *package* boundaries, and this one crosses a worker↔main-thread
boundary inside one app. See `contracts/render-result.md` C1.

| Field | Type | Status |
|---|---|---|
| `requestId` | `number` | existing |
| `ok` | `boolean` | existing |
| `html` | `string \| null` | existing |
| `error` | `string \| null` | existing |
| `mathPresent` | `boolean?` | existing |
| `diagramsPresent` | `boolean?` | existing |
| `details` | `RenderDocumentDetails?` | existing (already produced by the worker; note the hook's local interface does not currently declare it) |
| `timings` | `RenderTimings?` | **new** |

**Optionality**: `timings` is optional so a failed render, which has no meaningful stage breakdown,
omits it rather than reporting zeros that would pollute the adaptive delay.

---

## RenderStats (page-formatted path — existing, currently discarded)

Already defined at `packages/asciidoc-pdf/src/protocol.ts:228-237` and already computed at
`apps/web/src/lib/pdf/pdf-render-controller.ts:363-366`. This feature stops discarding it at
`use-pdf-preview.ts:140-151` **and grows it** — the earlier "no shape change" note is superseded by
FR-022a, which requires a per-stage breakdown rather than one whole-render total.

| Field | Type | Status |
|---|---|---|
| `coldStartMs` | `number?` (first render only) | existing |
| `renderMs` | `number` | existing — whole render, retained as the total |
| `cacheHits` | `number` | existing |
| `rasterFallbacks` | `number` | existing, but **hardcoded `0`** at `pdf-render-controller.ts:365`; must report the value `diagrams-math.ts:706-714` already knows (FR-022c) |
| `stages` | `PdfRenderStages` | **new** (FR-022a) |

### PdfRenderStages

All values in milliseconds, all ≥ 0. Additive: a consumer ignoring `stages` behaves as today.

| Field | Measured where | Notes |
|---|---|---|
| `vmBootMs` | main thread, around `warmup` | `0` when the VM was already warm; distinct from `coldStartMs`, which is only ever the session's first |
| `populateMs` | main thread, around `populateProject` | the VFS write pass |
| `pipelineMs` | main thread, around `runPipeline` | the five pre-convert stages |
| `convertMs` | main thread, around `invokeConvert` | wall time of the synchronous `vm.eval` |
| `parseMs` | **inside the VM** | Asciidoctor load |
| `converterWalkMs` | **inside the VM** | tree walk, excluding dry runs |
| `dryRunMs` | **inside the VM** | the double-layout cost; the largest suspected item |
| `fontMs` | **inside the VM** | parse + subset |
| `serializeMs` | **inside the VM** | Prawn/pdf-core render + write |

The five in-VM figures cross the boundary by the mechanism `invoke.ts` already uses for its other
results — written to a VFS path and read back with `readVfsText` — rather than off the `eval` return
value, for the same reason that mechanism exists there: a `memory.grow` mid-eval invalidates the
return-value read (`invoke.ts:368-380`). FR-022b requires this reuse rather than a second mechanism.

---

## RefreshSchedule

The policy deciding when a pending edit becomes a render. Extends the existing `MaxWaitDebounce`.

| Member | Type | Status |
|---|---|---|
| `schedule(run)` | `(run: () => void) => void` | existing |
| `cancel()` | `() => void` | existing |
| `flush()` | `() => void` | **new** — run any pending callback immediately (FR-005, file switch) |
| `setInProgress(busy)` | `(busy: boolean) => void` | **new** — gates the guarantee (FR-004) and drives re-arm (FR-004a) |

### State

| State | Meaning |
|---|---|
| `trailingTimer` | Restarted by every `schedule` call |
| `maxWaitTimer` | Armed once per burst; **not** restarted by later calls |
| `pendingRun` | Latest scheduled callback; only this one ever fires |
| `inProgress` | **New.** True while a render is running |
| `deferredByProgress` | **New.** True when the guarantee elapsed but was suppressed because `inProgress` |

### Transitions

1. `schedule` → replace `pendingRun`, restart `trailingTimer`, arm `maxWaitTimer` if unarmed.
2. `trailingTimer` fires → run and disarm both.
3. `maxWaitTimer` fires **and** `inProgress` is false → run and disarm both.
4. `maxWaitTimer` fires **and** `inProgress` is true → **suppress**; set `deferredByProgress` (FR-004).
5. `setInProgress(false)` with `deferredByProgress` **and** a `pendingRun` → run immediately and clear
   the flag (FR-004a — the re-arm; without it the guarantee fires once and lapses forever).
6. `flush()` → run `pendingRun` immediately, bypassing both timers (FR-005).
7. `cancel()` → clear everything. Called **on unmount only**, never per edit — the per-edit call is
   the defect this feature removes.

**Invariant**: at most one render is in flight (SC-001a). Transitions 4 and 5 together are the whole
correctness argument; each needs its own test.

---

## RenderWorkerHolder

Module-level, ref-counted, supervised holder for the render worker. **New.**

| Field | Type | Notes |
|---|---|---|
| `worker` | `Worker \| null` | Null before first acquire and after the retention window expires |
| `refCount` | `number` | Consumers currently holding it. **Zero does not mean terminate** — see below |
| `idleTimer` | `Timeout \| null` | **New.** Armed when `refCount` hits 0; cancelled by the next `acquire` (FR-007a) |
| `rebuildCount` | `number` | Automatic rebuilds this session (FR-012b) |
| `lastRequest` | `RenderRequest \| null` | Re-issued after a rebuild (FR-012a) |
| `state` | `'idle' \| 'alive' \| 'retained' \| 'rebuilding' \| 'failed'` | `'retained'` = no consumers, worker alive inside the retention window; `'failed'` = bound exhausted, awaiting manual retry |

### Lifecycle

| Event | Effect |
|---|---|
| `acquire()` | Cancel `idleTimer` if armed; `refCount++`; create the worker if absent |
| `release()` | `refCount--`; at 0, arm `idleTimer` and enter `'retained'` — **do not terminate** (FR-007a) |
| `idleTimer` elapses, `refCount` still 0 | Terminate and clear |
| worker `error` / unexpected close | If `rebuildCount < MAX`: `rebuildCount++`, rebuild, re-issue `lastRequest` (FR-012a). Else → `'failed'` (FR-012b) |
| `retry()` (author action) | Reset `rebuildCount` to 0, rebuild (FR-012c) |

**Why zero consumers is not a terminate signal**: the web-formatted preview is the worker's only
consumer, so a format switch, a panel close, or hiding the preview all drop `refCount` to zero — the
exact transitions FR-007 and FR-007a require the worker to survive. Terminating at zero satisfies
FR-006 and fails FR-007. See `contracts/refresh-schedule.md` §S4 for the full argument and the
evidence it rests on.

**Not a service locator** (architecture constitution): a browser resource pool for a UI-layer worker,
injecting no domain dependency and crossing no layer boundary. It mirrors the processor singleton the
worker already holds internally.

---

## AdaptiveDelay

Derived trailing delay. **New**, as a pure function so it is testable independently of React.

| Input | Type |
|---|---|
| `lastRenderMs` | `number \| null` — null before any render completes |

Output: `number` — `lastRenderMs === null ? PREVIEW_DEBOUNCE_MS : clamp(lastRenderMs * 2, 120, 500)`

**Rules**: FR-003 (adapts), plus US4 scenario 4 (falls back to the fixed delay before any
measurement). Bounds are named constants in `editor-config.ts`, never literals at the call site
(Principle I).

---

## MorphSkipDecision

Per-element decision made during the DOM morph. **New.** Not a stored entity — the input/output shape
of the `morphdom` `onBeforeElUpdated` hook.

| Input | Type |
|---|---|
| `fromEl` | `Element` — currently displayed |
| `toEl` | `Element` — incoming |

Output: `boolean` — `false` skips `fromEl` **and its subtree**.

### Policy

| Condition | Decision | Requirement |
|---|---|---|
| `fromEl` is a rendered diagram (`.adc-diagram-output`) and the incoming source text is identical | skip | FR-014 |
| `fromEl` is typeset math (`mjx-container`) and the incoming expression is identical | skip | FR-015 |
| Either subtree's source **differs** | patch | FR-016 |
| `fromEl` is a diagram marked failed | patch | FR-016a — "unchanged" and "successfully drawn" are different conditions |
| anything else | patch | FR-013 |

**Identity is content-addressed, never positional** (research R2, Principle XII). A diagram whose
line number moved but whose source did not is the *same* diagram.

### Companion: `getNodeKey`

| Element has | Key returned |
|---|---|
| author `[[anchor]]` or auto-generated heading id | that id — stable under insertion |
| synthetic `__src_<context>_<line>` id | **`undefined`** |
| no id | `undefined` |

Returning a synthetic id would be actively harmful: `morphdom` would read a renumbered id as a
different node and force a replace, where no key falls back to structural matching and patches in
place.

---

## Entity relationships

```text
RefreshSchedule ──fires──> render request ──> RenderWorkerHolder ──> worker
                                                      │
                                                      ▼
                                            RenderResult { html, timings? }
                                                      │
                        ┌─────────────────────────────┼──────────────────────────┐
                        ▼                             ▼                          ▼
                  AdaptiveDelay              sanitise → fragment          RenderStatsOverlay
              (feeds next schedule)          morph (MorphSkipDecision)      (dev builds only)
                        │                             │
                        └──────> RefreshSchedule      └──> live preview DOM
```

The loop from `RenderResult.timings` back into `RefreshSchedule` via `AdaptiveDelay` is why User
Story 3 must be delivered before User Story 4 — it is a data dependency, not a preference.
