# Contract: Refresh Schedule & Worker Lifetime

**Feature**: `043-preview-responsiveness` | Modules: `apps/web/src/lib/max-wait-debounce.ts`,
`apps/web/src/lib/create-render-worker.ts`, `apps/web/src/lib/preview/adaptive-delay.ts` (new)

---

## S1. Hook effect structure (the actual defect)

### Today — `use-asciidoc-preview.ts:251-259`

```ts
useEffect(() => {
  if (!isEnabled || !content) return;
  setState('pending');
  scheduleRender(content);
  return () => {
    debounceReference.current?.cancel();   // ← runs before EVERY re-schedule
  };
}, [content]);
```

React runs cleanup before the next effect, so every keystroke calls `cancel()`, which clears
`maxWaitTimer` (`max-wait-debounce.ts:42-45`) as well as the trailing timer. The cap is re-armed from
zero on every keystroke and **can never elapse**.

### Required

```ts
useEffect(() => {
  if (!isEnabled || !content) return;
  setState('pending');
  scheduleRender(content);
  // No cleanup. `schedule()` already replaces `pendingRun` and restarts the trailing
  // timer, so per-edit cancellation buys nothing and defeats the max-wait cap.
}, [content]);

// Cancellation belongs to unmount alone.
useEffect(() => () => debounceReference.current?.cancel(), []);
```

**The same fix applies verbatim to `use-pdf-preview.ts:222-225`.** Identical defect, identical shape.

---

## S2. `MaxWaitDebounce` behaviour

| Trigger | Precondition | Effect |
|---|---|---|
| `schedule(run)` | — | Replace `pendingRun`; restart trailing timer; arm max-wait if unarmed |
| trailing elapses | — | Run; disarm both |
| max-wait elapses | not in progress | Run; disarm both |
| max-wait elapses | **in progress** | **Suppress**; set `deferredByProgress` (FR-004) |
| `setInProgress(false)` | `deferredByProgress` && `pendingRun` | **Run immediately**; clear flag (FR-004a) |
| `flush()` | `pendingRun` | Run now, bypass both timers (FR-005) |
| `cancel()` | — | Clear all state (unmount only) |

**Invariant**: at most one render in flight (SC-001a).

The two rows that carry the whole correctness argument are the suppression and the re-arm. Implement
suppression without re-arm and the guarantee fires once then lapses silently for the session — the
same defect class this feature exists to fix, with a longer fuse. Each needs its own test.

### Timer discipline

`maxWaitTimer` is armed once per burst and **never restarted** by later `schedule` calls. That is
already correct today (`max-wait-debounce.ts:59-60`); the bug is entirely in the caller's cleanup.

---

## S3. Adaptive delay

```ts
export function adaptiveDelayMs(lastRenderMs: number | null): number;
```

| Input | Output |
|---|---|
| `null` (no render observed yet) | `PREVIEW_DEBOUNCE_MS` (500) — US4 scenario 4 |
| `30` | `120` (clamped to floor) |
| `100` | `200` |
| `250` | `500` (clamped to ceiling) |
| `600` | `500` (ceiling) |

Formula: `clamp(lastRenderMs × 2, PREVIEW_ADAPTIVE_MIN_MS, PREVIEW_DEBOUNCE_MS)`.

Both bounds are named constants in `editor-config.ts` (Principle I: no magic numbers). A **pure
function**, so it is testable without React and without timers.

**Source of `lastRenderMs`**: `RenderResult.timings.totalMs` of the most recent *successful* render.
A failed render carries no timings (see `render-result.md` C1), so it leaves the delay unchanged
rather than resetting it.

**Determinism (Principle XII)**: affects *when* a render is scheduled, never *what* it produces.

---

## S4. Worker holder

```ts
export function acquireRenderWorker(handlers: {
  onMessage: (event: MessageEvent<RenderResult>) => void;
  onEngineFailed: () => void;
}): RenderWorkerHandle;

export interface RenderWorkerHandle {
  post: (request: RenderRequest) => void;
  release: () => void;
  retry: () => void;        // FR-012c
}
```

| Event | Effect | Requirement |
|---|---|---|
| `acquire` | `refCount++`; **cancel any pending idle release**; create worker if absent | FR-006, FR-007, FR-007a |
| `release` | `refCount--`; at 0 **start the idle-retention timer — do NOT terminate** | FR-007a |
| idle-retention timer elapses with `refCount` still 0 | Terminate; clear the holder | FR-007a |
| render fails (`ok: false`) | Report the error; **keep the worker** | FR-012 |
| worker `error` / unexpected close, `rebuildCount < MAX` | `rebuildCount++`; rebuild; re-issue `lastRequest` | FR-012a |
| worker dies, `rebuildCount >= MAX` | State `'failed'`; `onEngineFailed()` | FR-012b |
| `retry()` | Reset `rebuildCount`; rebuild | FR-012c |

**Distinction that matters**: a *failed render* (`ok: false`) and a *dead worker* are different
events with different handling. Conflating them either tears down a healthy worker on a syntax error,
or leaves a dead one in place forever.

### Why `release` must not terminate at zero (FR-007a)

An earlier revision of this contract said "terminate only at 0" and cited FR-006 **and FR-007** for
it. That satisfies FR-006 and **provably fails FR-007**, and the analysis pass caught it before
implementation. Recording the correction rather than quietly editing it, because the failure mode is
the instructive part: the mechanism looked obviously right, and every test written against it would
have passed.

`useAsciidocPreview` has exactly one caller — `asciidoc-preview.tsx:203` — inside a component rendered
by `project-editor-layout.tsx:1391` as `previewMode === 'html' ? <AsciiDocPreview/> : <PdfPreviewPanel/>`,
itself gated by `showPreview && previewOpen`. So the web-formatted preview is the worker's **only**
consumer, and switching to the page format, closing the panel, or hiding the preview each unmount it.
`refCount` reaches zero on precisely the transitions FR-007 and FR-007a exist to protect. A lifetime
that ends at zero consumers therefore destroys the engine at the exact moment it is supposed to
survive — while `pdf-preview-panel` is unaffected, because `usePdfPreview` is hoisted to the layout
(`:991`) and never unmounts.

**Resolution**: zero consumers starts a timer, not a termination. `acquireRenderWorker` cancels that
timer, so a switch back inside the window is a straight cache hit with no startup cost. Termination
happens when the retention window expires with the count still at zero, or when the editor leaves the
project.

`MAX_ENGINE_REBUILDS` (**3**) and `RENDER_WORKER_IDLE_RETENTION_MS` (**60_000**) are named constants
in `editor-config.ts`. Both values are chosen, not derived: three rebuilds is enough to ride out a
transient reclaim without letting a reproducibly-crashing document loop, and sixty seconds comfortably
covers a format-switch round trip or a panel toggle while still releasing the worker from an editor
left idle. Adjust on evidence, not on taste.

### Why a module-level holder

The worker must outlive any single component instance to survive the file switch (FR-006), the
HTML↔PDF switch (FR-007) and the panel close/reopen (FR-007a). React context would tie its lifetime to
a provider's position in the tree — the same mistake the remount key already makes — and would not
survive the format switch unless the provider sat above both panels. Note that hoisting to a provider
would *also* not have fixed the zero-consumer problem above on its own: the provider would have to sit
above the `previewOpen` gate too, which is a second, easily-missed condition.

**Not a service locator** under the architecture constitution: a browser resource pool for a UI-layer
worker. It injects no domain dependency and crosses no layer boundary, mirroring the processor
singleton the worker already holds internally (`asciidoc-render.worker.ts:407-413`).

---

## S5. File-switch sequence (FR-005, FR-008, FR-009, FR-010)

On `openFileId` change:

1. `flush()` **or** post immediately — do not wait for the trailing delay (FR-005).
2. Keep the previous content displayed; set `state: 'rendering'` (FR-009).
3. Reset `previewRef.current.scrollTop = 0` (FR-010).
4. Do **not** render the "preview not available" message for a previewable file (FR-008) — that
   message is reserved for files that genuinely cannot be previewed.
5. Discard any in-flight result for the previous file via the existing `requestId` guard (FR-011).

Step 4 is the visible bug today: `asciidoc-preview.tsx:452-453` shows that message whenever
`state === 'idle'`, and the remount resets state to `'idle'` on every switch.
