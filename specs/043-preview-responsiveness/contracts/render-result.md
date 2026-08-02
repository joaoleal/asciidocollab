# Contract: Render Result & Preview Hook Surface

**Feature**: `043-preview-responsiveness` | Consumers: `apps/web` only — no package boundary crossed.

Two contracts change. Both are internal to `apps/web`; neither is a `packages/shared` DTO.

---

## C1. Worker → main: `RenderResult`

Declared twice today — in `asciidoc-render.worker.ts:336-363` and again in
`use-asciidoc-preview.ts:27-36`. The two copies have **already drifted**: the worker sends `details`,
the hook's copy does not declare it.

### Change

```ts
/** Per-stage cost of one render, in milliseconds. Absent on a failed render. */
interface RenderTimings {
  readonly parseMs: number;        // load()
  readonly convertMs: number;      // convert()
  readonly postProcessMs: number;  // worker's own whole-document passes
  readonly totalMs: number;        // whole handler
}

interface RenderResult {
  // ...existing fields unchanged...
  readonly details?: RenderDocumentDetails;  // already sent; now declared on both sides
  readonly timings?: RenderTimings;          // NEW
}
```

### Rules

- **Additive only.** Every existing field keeps its name, type and meaning. A consumer ignoring
  `timings` behaves exactly as today.
- `timings` is **omitted** on `ok: false`. A failed render has no meaningful stage breakdown, and
  zeros would poison the adaptive delay.
- Timings are always **computed**, in every build. FR-023 constrains *presentation*, not measurement:
  the adaptive delay consumes them in production.
- The duplicate declaration is reconciled to a **single shared type** in this feature, declared in a
  new module **`apps/web/src/workers/render-protocol.ts`** and imported by both the worker and the
  hook. Two independent definitions of one wire type is what let `details` drift, and the architecture
  constitution forbids cross-boundary type duplication; the same reasoning applies within an app.

  **Why `apps/web/src/workers/`, not `packages/shared`**: the architecture constitution reserves
  `packages/shared` for DTOs that cross *package* boundaries. This type crosses a worker↔main-thread
  boundary **inside one app**, and no package consumes it. Promoting it to `packages/shared` would
  widen its blast radius for no gain and would put a browser-only shape in a package the domain can
  see. It lives beside the worker that defines the protocol.

### Verification

`pnpm typecheck` on source is the gate, **not** a green test run — `apps/web` jest is transpile-only
and `tsc` excludes `tests/`, so a fixture asserting the old shape would pass regardless.

---

## C2. `useAsciidocPreview` return surface

The User Story 5 change with real refactor exposure. `apps/web/tests/hooks/use-asciidoc-preview.test.tsx`
(1062 lines) asserts against the current shape.

### Today

```ts
interface UseAsciidocPreviewResult {
  html: string | null;      // committed via dangerouslySetInnerHTML
  state: PreviewState;
  error: string | null;
  previewRef: React.RefObject<HTMLDivElement | null>;
  mathPresent: boolean;
  diagramsPresent: boolean;
}
```

### After User Story 5

```ts
interface UseAsciidocPreviewResult {
  /**
   * Sanitised output of the latest successful render, retained for identity/testing.
   * NO LONGER the commit path — the hook morphs into `outputRef` itself.
   */
  html: string | null;
  state: PreviewState;
  error: string | null;
  previewRef: React.RefObject<HTMLDivElement | null>;   // scroll container
  outputRef: React.RefObject<HTMLDivElement | null>;    // NEW — morph target
  mathPresent: boolean;
  diagramsPresent: boolean;
  timings: RenderTimings | null;                        // NEW — dev overlay + adaptive delay
  /** Bumped after each successful commit, so effects can depend on "a commit happened". */
  renderNonce: number;                                  // NEW
  /** Set when supervision exhausted its rebuild budget (FR-012b). */
  engineFailed: boolean;                                // NEW
  /** Manual retry after `engineFailed` (FR-012c). */
  retryEngine: () => void;                              // NEW
}
```

### Why `renderNonce` exists

Three effects in `asciidoc-preview.tsx` currently depend on `html` (`:260`, `:308`, `:368`) — using
the string's identity as a proxy for "the DOM changed". Once the hook commits by morphing, `html`
stops being that signal: **the same string can be committed to a different DOM** (after a file switch
back), and a morph can change the DOM without a new string.

`renderNonce` states the signal directly instead of inferring it. Keeping `html` as the dependency
would be a silent correctness bug — the math and diagram passes would skip a commit that genuinely
needed them.

### Rules

- `html` is **retained**, not removed. It stays the render's identity for tests and for the export
  path. Removing it would force a larger test rewrite for no behavioural gain.
- The hook owns the commit. The component supplies `outputRef` and stops using
  `dangerouslySetInnerHTML`.
- Sanitisation stays **inside the hook**, before the morph. There is no path from worker output to the
  DOM that bypasses it (Principle IX).
- On file switch the hook resets `previewRef.current.scrollTop` (FR-010) and keeps prior content
  visible with `state: 'rendering'` (FR-009).

---

## C3. Sanitisation call (unchanged in policy)

```ts
// before
DOMPurify.sanitize(result.html, { USE_PROFILES: { html: true } })                             // string
// after
DOMPurify.sanitize(result.html, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true })  // fragment
```

Same sanitiser, same profile, same allow-list, same call site. Only the return type changes.

**Principle VIII/IX obligation**: a test MUST assert that a payload rejected in string mode is
rejected identically in fragment mode — same input, same verdict. Until it passes, User Story 5 is
not done.

The other three call sites (`asciidoc-paste.ts:40`, `use-html-export.ts:317`,
`render-diagrams.ts:122`) are **not** touched.

---

## C4. `MaxWaitDebounce`

```ts
interface MaxWaitDebounce {
  schedule: (run: () => void) => void;
  cancel: () => void;
  flush: () => void;                            // NEW — FR-005, file switch bypasses the delay
  setInProgress: (busy: boolean) => void;       // NEW — FR-004 gate, FR-004a re-arm
}
```

Shared with `use-pdf-preview.ts`, which gets the same cleanup fix (FR-004) and drives
`setInProgress` from its existing `isRendering` state.

**Behavioural contract**:

| Scenario | Required |
|---|---|
| Trailing delay elapses | Run once |
| Max-wait elapses, no render in flight | Run once |
| Max-wait elapses, render in flight | **Suppress**, remember it was deferred |
| Render finishes with work deferred | **Run immediately** — the re-arm (FR-004a) |
| `flush()` | Run now, bypassing both timers |
| `cancel()` | Clear everything — **unmount only** |

The last row is the defect being fixed: `cancel()` on every content change is what re-arms the cap
from zero and prevents it ever elapsing.
