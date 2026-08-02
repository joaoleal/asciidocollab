# Contract: DOM Morph Policy

**Feature**: `043-preview-responsiveness` | Module: `apps/web/src/lib/preview/morph-preview.ts` (new)

Wraps `morphdom` (MIT, ^2.7.8 — adopted per Principle IV, research R1). The library owns tree
walking; this module owns the two decisions the library delegates.

---

## Entry point

```ts
export interface MorphOutcome {
  readonly diagramsSkipped: number;   // FR-014 — asserted by SC-006
  readonly mathSkipped: number;       // FR-015 — asserted by SC-006
  readonly focusRestored: boolean;    // FR-020a/FR-020b
}

/**
 * Patch `container` in place so it matches `incoming`, preserving unchanged
 * diagram and math subtrees, keyboard focus, and scroll position.
 */
export function morphPreview(
  container: HTMLElement,
  incoming: DocumentFragment,
): MorphOutcome;
```

`incoming` is **already sanitised** — `morphPreview` never sanitises and never accepts a string. A
string parameter would reintroduce the parse this feature removes and create a second path to the DOM
that could bypass the sanitiser (Principle IX).

---

## Decision 1 — `getNodeKey`

| Element has | Key | Why |
|---|---|---|
| author `[[anchor]]` id, or auto-generated heading id | that id | Derived from title text, not position — survives insertion |
| synthetic `__src_<context>_<line>` id | `undefined` | Line-derived; renumbers on insertion |
| no id | `undefined` | Structural matching |

Synthetic ids must be recognised by prefix and **excluded**. Returning one is worse than returning
nothing: `morphdom` reads a renumbered id as a different node and forces a replace, where absent keys
fall back to structural matching and patch in place. This is the single most consequential detail in
the module — getting it backwards silently turns every insertion into a full-document rebuild while
all tests still pass.

---

## Decision 2 — `onBeforeElUpdated(fromEl, toEl) → boolean`

`false` skips `fromEl` **and its entire subtree**.

| Condition | Return | Requirement |
|---|---|---|
| `fromEl` matches `.adc-diagram-output` and incoming source text is identical | `false` | FR-014 |
| `fromEl` matches `mjx-container` and incoming expression is identical | `false` | FR-015 |
| Either subtree's source differs | `true` | FR-016 |
| `fromEl` is a diagram marked failed | `true` | FR-016a |
| anything else | `true` | FR-013 |

### Source comparison is content-addressed

A rendered diagram (`.adc-diagram-output`) replaced its placeholder, so its source must be recoverable
for comparison — `render-diagrams.ts` retains it (`adc-diagram-source`, `:36`). The incoming
placeholder carries its source as escaped text (`buildDiagramPlaceholder`,
`asciidoc-render.worker.ts:212-214`).

**Compare source text, never position.** A diagram whose line moved but whose source did not is the
same diagram (research R2; Principle XII requires derived assets to be content-addressed).

### Failure marking

FR-016a needs "successfully drawn" distinguishable from "unchanged". `renderDiagrams` already
produces per-diagram warnings; the failed element must carry a marker attribute so the skip rule can
see it. Without this, a transient draw failure is frozen on screen permanently — the skip rule would
keep deciding "source unchanged, skip" forever.

---

## Ordering within a commit

1. Read focus: is `document.activeElement` inside `container`? Record how to find it again.
2. Read `scrollTop` from the **scroll container** (`previewRef`), not the output element.
3. `morphdom(container, incoming, { getNodeKey, onBeforeElUpdated, childrenOnly: true })`.
4. Restore focus (FR-020a); if the element is gone, focus `container` (FR-020b).
5. Restore `scrollTop` (FR-017).
6. Return counts.

Focus and scroll are captured **before** the morph and restored **after**. `childrenOnly: true`
preserves the container element itself, which carries `data-preview-style` and the delegated
listeners.

### Busy marking

`aria-busy` is set on the container while a render is in flight and cleared on completion (FR-020c).
Owned by the component, not this module — it spans the whole render, not just the commit.

---

## What this module does **not** do

- **No sanitisation.** Input is already sanitised.
- **No math typesetting or diagram rendering.** Existing effects own those, now keyed on
  `renderNonce` rather than `html` (see `render-result.md` C2).
- **No scroll-sync navigation.** `data-source-line` lookup is unchanged; this module only preserves
  the attributes it depends on.

---

## Test obligations

| Requirement | Assertion |
|---|---|
| FR-013 | Editing one paragraph leaves other blocks' node identity intact |
| FR-014 / FR-015 | `diagramsSkipped` / `mathSkipped` > 0 when prose changes; `MorphOutcome` exists to make SC-006 assertable rather than eyeballed |
| FR-016 | Changing a diagram's source redraws it |
| FR-016a | A diagram marked failed is retried on the next refresh |
| FR-017 | `scrollTop` unchanged across a morph in an image-bearing document |
| FR-020a | A focused link keeps focus |
| FR-020b | Focus falls back to the container when the focused element is removed |
| **R2 regression** | **Inserting a paragraph at the top does not rebuild the blocks below** — the failure that would otherwise pass every other test while defeating the feature |
| Principle VIII | A payload rejected in string mode is rejected identically in fragment mode |
