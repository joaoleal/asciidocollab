# Internal Interface Contracts: 040-pdf-diagrams-math

This feature exposes no new public API, CLI, or network endpoint. The contracts that matter are the
**internal seams** where two independently-evolving code paths must agree. Each is stated with its
consumers so a change on one side that breaks the other is caught in review/tests.

---

## Contract A — `detectRenderableBlocks` (shared detector)

**Location**: `packages/asciidoc-pdf/src/pipeline/stages/diagrams-math.ts` (extracted), exported from
`packages/asciidoc-pdf/src/index.ts`.

```ts
export interface RenderableBlock {
  category: 'diagram' | 'math';
  notation: string;                 // lowercased engine/notation
  kind: 'block' | 'inline';
  source: string;                   // verbatim
  params: Record<string, string>;   // incl. 'asciidoc-block-notation' + pos<N>
  line: number;                     // 1-based
}

export function detectRenderableBlocks(text: string): RenderableBlock[];
```

**Consumers**: (1) the worker `createDiagramsMathStage()` (it already contains this logic — extract, do
not fork); (2) the main-thread `prerender-diagrams.ts`.

**Contract invariants**:
- For the same `text`, both consumers receive identical records.
- `params` construction (named, positional `pos<N>`, and the synthetic `asciidoc-block-notation`) is
  byte-identical to what the stage feeds `computeSourceHash`.
- Verbatim regions (listing/literal/passthrough) are excluded (inline math inside them is not detected).
- `plantuml`/`ditaa` are NOT returned (they stay skipped-with-warning in the stage).

**Test**: a unit test asserting the detector output for a representative document equals what the stage
would hash (guards cache-key parity — the highest-risk seam in the feature).

---

## Contract B — `RenderRequest.generatedAssets` transport + worker pre-seed

**Location**: `packages/asciidoc-pdf/src/protocol.ts` (field), consumed in
`apps/web/src/workers/asciidoc-pdf.worker.ts` `buildPipeline`.

```ts
interface RenderRequest {
  // …existing fields…
  generatedAssets?: readonly GeneratedAsset[];   // NEW — main-thread pre-rendered MERMAID assets
}
```

**Producer**: `prerender-mermaid.ts` (main thread, idle-scheduled), attached in `use-pdf-export.ts` /
`use-pdf-preview.ts`. Carries **mermaid** assets only — math (worker liteAdapter), graphviz, and vega
render in the worker.

**Consumer**: worker `buildPipeline` seeds each entry into the `AssetCachePort` (`cache.set(asset)`)
before returning the `StageContext`, then runs `createDiagramsMathStage()`.

**Contract invariants**:
- Every `generatedAssets[i].sourceHash` MUST equal the hash the stage computes for the corresponding
  mermaid block → guaranteed cache hit → the no-DOM mermaid shim is never invoked in the worker.
- The field is optional and additive; a request without it is still valid (worker renders math/graphviz/
  vega in-process; only mermaid would degrade to a diagnostic — but the pre-pass always supplies mermaid).
- Structured-cloneable (`Uint8Array` bytes) across the worker boundary.

---

## Contract C — HTML-preview diagram placeholder (worker → main thread)

**Location**: emitted by `apps/web/src/workers/asciidoc-render.worker.ts`; consumed by
`apps/web/src/components/diagrams/render-diagrams.ts` (invoked from `asciidoc-preview.tsx`).

```html
<div class="adc-diagram" data-diagram-engine="<engine>" data-source-line="<n>"><!-- inert source --></div>
```
plus `RenderResult.diagramsPresent: boolean`.

**Contract invariants**:
- `data-diagram-engine` ∈ the shared diagram block-name set (Contract E).
- Placeholder is `html`-profile-safe so the shared preview sanitizer keeps it; the rendered SVG is
  injected only after a **separate** SVG-profile sanitize (Principle VIII — shared sanitizer untouched).
- `diagramsPresent` is `true` iff ≥1 placeholder is emitted (gates the lazy engine import).
- Render is idempotent: the source is preserved so a re-render re-derives the SVG rather than nesting.

---

## Contract D — Editor diagram highlighting seam

**Location**: `apps/web/src/lib/codemirror/asciidoc-source-highlight.ts` (`parseMixed` routing) +
`source-languages.ts` (engine → CodeMirror `Parser`).

**Contract**:
- A diagram block declaration (`[mermaid]`/`[graphviz]`/`[vega]`/`[vegalite]` immediately above a block
  delimiter) resolves its body span to a `Parser`: JSON (`@codemirror/lang-json`) for vega/vega-lite; a
  DOT StreamParser for graphviz; `codemirror-lang-mermaid` (covered types) or a lexical mermaid
  StreamParser (all other types) for mermaid.
- Nested parsing is scoped to the block body via `overlay: [blockBodySpan]` — MUST NOT bleed into
  surrounding AsciiDoc.
- The declaration itself gets a distinct highlight tag (`ad.diagramDecl`), separate from generic
  `[source,…]`/listing.

**Contract invariants**:
- The block-name set the tokenizer/router recognizes as diagrams == Contract E (FR-015).
- Unknown mermaid diagram-type keyword or malformed source degrades to plain/partial highlighting and
  never breaks the surrounding document's highlighting.

---

## Contract E — Diagram notation-set consistency (FR-015) — a test, not a shared module

There is **no shared registry**. The renderer and editor keep their own concern-specific maps:
- Renderer: `notation → render shim` in `packages/asciidoc-pdf` (`DIAGRAM_SHIM_BY_BLOCK`).
- Editor: `notation → highlight parser` in `apps/web/src/lib/codemirror`.

To let the two sides be compared without deep-importing a package internal, the renderer **publishes its
notation name set** through the `@asciidocollab/asciidoc-pdf` public API — `DIAGRAM_NOTATIONS` and
`UNSUPPORTED_DIAGRAM_NOTATIONS`, **derived from** the private `DIAGRAM_SHIM_BY_BLOCK` /
`UNSUPPORTED_DIAGRAM_BLOCKS` so the map remains single-source (a published *set*, not a second copy, not a
shared registry).

**Contract**: a **consistency test** in `apps/web` imports the renderer's **public** name set and asserts
it equals the editor's diagram-name set (and that the unsupported-offline sets agree), so a block the
editor highlights as a diagram is one the pipeline renders as a diagram, and vice versa.

**Contract invariant**: adding/removing a diagram engine requires updating both maps; the consistency
test fails until they agree — catching the drift without coupling the editor to the PDF engine package
internals (it consumes only the public name-set export) and without placing a rendering constant in the
shared kernel.

---

## Contract F — CI + parity harness

- **`packages/asciidoc-pdf` `test:ci`**: `jest --coverage` enforcing the existing `global: 90` threshold;
  invoked by `scripts/ci/unit.sh` (→ runs in both `pnpm gate` and CI's `unit` job).
- **WOFF2 parity fixture**: discovered by `parity.integration.test.ts` (manifest present, no
  `ink`/`variants`); the Node harness runs `mount-assets` (Node WOFF2 `FontConverter`) before convert;
  asserts `allFontsEmbedded === true` + content/geometry parity against the committed `reference.pdf`.
  Self-skips until both the wasm engine and `reference.pdf` exist (CI stays green in the interim).
