# Data Model: 040-pdf-diagrams-math

This feature adds no persistent (database) entities. The "entities" here are the in-memory / transport
shapes that cross the main-thread ↔ worker boundary and the editor/parse boundary. They must stay stable
because two independent code paths (a main-thread pre-pass and the worker stage) content-address the
same blocks, and a shared detector prevents them from drifting.

---

## RenderableBlock (detection record)

Produced by the shared `detectRenderableBlocks(rootOrFileText)` helper (extracted from
`diagrams-math.ts`) and consumed by both the main-thread pre-pass and the worker stage. It is the single
source of truth for "what is a renderable diagram/math unit and what cache params identify it."

| Field | Type | Notes |
|---|---|---|
| `category` | `'diagram' \| 'math'` | Drives which shim family renders it. |
| `notation` | `string` | Lowercased engine/notation name (`mermaid`, `graphviz`, `vega`, `vegalite`, `stem`, `latexmath`, `asciimath`). Also becomes the synthetic `asciidoc-block-notation` param. |
| `kind` | `'block' \| 'inline'` | Inline only applies to math macros. |
| `source` | `string` | The exact block/inline source text (verbatim; part of the hash). |
| `params` | `Record<string,string>` | Named + positional (`pos<N>`) block attributes **plus** `asciidoc-block-notation`. Must match the stage's construction byte-for-byte. |
| `line` | `number` | 1-based location, for diagnostics. |

**Invariants**:
- The `(source, params, shimVersion)` triple MUST hash (via `computeSourceHash`) identically in the
  pre-pass and the stage — otherwise the worker misses the cache and invokes a no-DOM shim. This is
  guaranteed by both paths calling the same detector and the same shim modules.
- Unsupported-offline notations (`plantuml`, `ditaa`) are NOT returned as renderable — they remain
  skipped-with-warning by the stage.

---

## GeneratedAsset (transport) — extends the existing feature-039 shape

Already defined in `packages/asciidoc-pdf/src/protocol.ts`; now also produced on the main thread and
carried into the worker via a new optional request field.

| Field | Type | Notes |
|---|---|---|
| `sourceHash` | `string` | FNV-1a hash = the cache key. Computed identically main-thread and worker. |
| `kind` | `'diagram' \| 'math'` | |
| `format` | `'svg' \| 'png'` | `png` when a raster fallback occurred. |
| `bytes` | `Uint8Array` | The rendered asset bytes (structured-cloneable across the worker boundary). |
| `rasterFallback` | `boolean` | True when SVG was rasterized; carries a warning diagnostic. |
| `altText` *(new)* | `string` | Derived from block title/caption else a default (FR-028). Applied to the emitted `image::`/`image:` alt. |

**New transport field** on `RenderRequest`:

| Field | Type | Notes |
|---|---|---|
| `generatedAssets?` | `readonly GeneratedAsset[]` | Optional. **Mermaid** assets rendered in the main-thread idle-time pre-pass, which the worker pre-seeds into its `AssetCachePort` before running the pipeline. Math (worker liteAdapter), graphviz, and vega render in-process in the worker and are NOT carried here. Absent = the worker renders everything it can in-process (mermaid would then degrade to a no-DOM diagnostic — but the pre-pass always supplies mermaid). |

**Invariants**:
- Pre-seeding is idempotent and order-independent (cache keyed by `sourceHash`).
- A pre-seeded asset makes its block a guaranteed cache hit; the stage still writes bytes to
  `/project/.gen/<hash>.<format>` and rewrites the block to `image::`/`image:` with `altText`.

---

## Diagram render diagnostic (reused)

The existing `Diagnostic` shape (severity, code, resource, location, message). New/relevant codes in
play: `diagram-unsupported` (PlantUML/ditaa), `malformed-diagram`, `unsupported-image` (raster
fallback), and a **remote-resource-skipped** warning (FR-027) when a diagram references an external
`url`. Diagnostics produced during the main-thread pre-pass are carried alongside `generatedAssets` so
the PDF diagnostics panel still surfaces them.

---

## HTML-preview diagram placeholder (DOM contract)

Emitted by the AsciiDoc→HTML render worker so the main thread can locate diagram blocks to render.

```html
<div class="adc-diagram"
     data-diagram-engine="mermaid"      <!-- mermaid | graphviz | vega | vegalite -->
     data-source-line="42">
  <!-- inert diagram source as escaped text content (survives the html-profile sanitizer) -->
</div>
```

| Attribute | Purpose |
|---|---|
| `class="adc-diagram"` | Locator for the main-thread render pass. |
| `data-diagram-engine` | Engine to dispatch to (from the shared diagram block-name set). |
| `data-source-line` | Scroll-sync + diagnostics. |
| text content | The inert diagram source (never executed; re-read on re-render for idempotency). |

**Invariants**:
- Placeholder markup is `html`-profile-safe (`div` + `class`/`data-*` + text), so the shared preview
  sanitizer keeps it intact.
- The worker also sets `RenderResult.diagramsPresent = true` when any placeholder is emitted, gating the
  main thread's lazy engine import.
- The rendered SVG replaces the placeholder's contents **after** a separate SVG-profile sanitize; the
  source is preserved (attribute/text) so a re-render is idempotent (mirrors MathJax `render-math.ts`).

---

## Diagram notation maps (FR-015 consistency — NOT a shared registry)

The renderer and the editor are **separate concerns with separate maps** — there is deliberately no
shared registry:

- **Renderer** (`packages/asciidoc-pdf`): `notation → render shim` — the existing
  `DIAGRAM_SHIM_BY_BLOCK` (`mermaid→mermaid`, `graphviz→graphviz`, `vega|vegalite|vega-lite→vega`) +
  the unsupported-offline set `{plantuml, ditaa}`. Consumed by the stage and (for the mermaid subset)
  the main-thread pre-pass.
- **Editor** (`apps/web/src/lib/codemirror`): `notation → highlight parser` —
  `mermaid→(codemirror-lang-mermaid | lexical fallback)`, `graphviz→DOT StreamParser`,
  `vega|vegalite|vega-lite→JSON`. Owned beside the highlighting code.

They share no logic. FR-015 requires only that the **set of diagram notation names** be consistent, so
that a block the editor highlights as a diagram is one the pipeline renders as a diagram. To compare the
two without reaching into a package internal, the renderer **publishes its notation name set** from the
`@asciidocollab/asciidoc-pdf` public API (`DIAGRAM_NOTATIONS`, `UNSUPPORTED_DIAGRAM_NOTATIONS`), derived
from `DIAGRAM_SHIM_BY_BLOCK` / `UNSUPPORTED_DIAGRAM_BLOCKS` so the map stays single-source. FR-015 is then
enforced by a single **consistency test** asserting the editor's set equals that published set — not by a
shared module (which would couple the editor to the PDF engine or pollute the kernel).

---

## WOFF2 parity fixture (test asset)

A self-contained fixture project under `apps/web/e2e/pdf-parity/fixtures/theme-fonts-woff2/`:

| Part | Content |
|---|---|
| `source/main.adoc` | Same document as `theme-fonts` (headings in branded mono, bold/italic runs, an embedded PNG). |
| `source/theme/brand-theme.yml` | `extends: default`; `font.catalog.merge` names a `Brand Mono` family mapping normal/bold/italic/bold_italic → the four `.woff2` files. |
| `source/fonts/mplus1mn-*-subset.woff2` | WOFF2-compressed versions of the existing TTF subsets. |
| `manifest.json` | Mirrors `theme-fonts`; `render.fontPaths` → the four `.woff2` files; no `ink`/`variants` (so the Node parity suite picks it up). |
| `reference.pdf` | Committed, produced by the reference toolchain (`-a reproducible`, `SOURCE_DATE_EPOCH=1704067200`) from the decoded-TTF bytes at the `.woff2` filenames. |

**Invariant**: the Node parity harness runs `mount-assets` (decode WOFF2 in place) before convert, so the
in-app render embeds the font; the assertion is `allFontsEmbedded === true` + content/geometry parity.
