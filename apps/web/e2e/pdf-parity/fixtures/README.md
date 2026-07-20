# PDF reference-parity fixtures

This directory holds the team-maintained corpus that the in-browser PDF export is verified against.
Each fixture pairs an AsciiDoc project with the PDF the **external Asciidoctor-PDF toolchain** (the
CLI / Maven "reference build") produces for it. Two suites drive the same wasm engine over these
fixtures and compare against the committed reference at each fixture's recorded, element-level
tolerance: the stack-free browser suite (`../pdf-parity-render.spec.ts`) and the Node real-wasm
integration test (`packages/asciidoc-pdf/tests/integration/parity.integration.test.ts`). Comparison
is **structural** — text-layer content/order, a rasterized ink-map for vector families (math/diagrams),
and citation facts — rather than a byte- or pixel-identical match, since the produced and reference
PDFs come from different builds of the same engine.

The comparison target is **element-level parity**, not a byte- or pixel-identical match: the recorded
tolerance absorbs sub-pixel antialiasing and rasterizer noise while still catching real layout, font,
and colour divergence.

## Status

The end-to-end run is **blocked** until two things exist:

1. The vendored wasm engine at `apps/web/public/vendor/asciidoctor-pdf/asciidoctor-pdf.wasm` (produced
   by `pnpm --filter @asciidocollab/asciidoc-pdf build:wasm`, a heavy step that is authored but not
   yet run in this repo).
2. At least one fixture below with a committed reference PDF.

Until then the spec **skips with a clear message** rather than failing, so CI stays green. Adding a
fixture with a reference PDF (and building the engine) activates it with no harness changes.

## Directory layout

```
fixtures/
  <fixture-name>/
    manifest.json      # declares the fixture and its recorded tolerance
    source/            # the AsciiDoc project (main file + includes + theme + fonts + images)
      main.adoc
      ...
    reference.pdf      # committed reference, produced by the external Asciidoctor-PDF build
```

A fixture is any immediate sub-directory that contains a `manifest.json`. The `reference.pdf` may be
added later — the fixture is discovered as soon as the manifest exists, and its test skips until the
reference PDF is committed.

### Fixtures whose reference is built from a different document

Some fixtures cannot have their reference rendered from `source/`, because the external toolchain
cannot consume `source/` as written. Those carry an extra directory holding the input the reference
was actually built from:

| Fixture | Directory | Why `source/` will not do |
| --- | --- | --- |
| `citations` | `reference-src/` | The reference keeps asciidoctor-bibtex macro syntax, not our shim syntax. |
| `math`, `diagrams` | `reference-build/` | Figures are already rasterised to committed `.gen/*.svg` (producing them needs a browser). |
| `theme-fonts-woff2` | `reference-build/` | Prawn embeds TTF/OTF only and cannot read WOFF2 at all, so the fonts are decoded to `.ttf`. |

A `reference-build/` is **self-contained**: every render option is a document attribute in its own
`main.adoc`, so it is rebuilt with one flag-free command and the committed directory is the whole
auditable input.

Build these with `node tools/build-references.mjs [<fixture> ...]`, **not** with
`generate-reference.mjs` — which refuses them by name, because rendering `source/` for one of these
overwrites a committed reference with a plausible PDF of the wrong document. That is not
hypothetical; it happened to `math`, and only a SHA-256 comparison against the previous corpus caught
it.

### Fixtures that enable more than one extension

A fixture listing two or more ids in `render.enabledExtensions` is also an input to
`node tools/check-extension-order.mjs`, which renders it **twice** — once in the order the app loads
its extensions, once reversed — and requires the two PDFs to be byte-identical. `scripts/ci/pdf-parity.sh`
runs it after the suite.

It exists because the suite cannot see this class of defect. Extensions customise the converter by
`prepend`ing a module, so two that override the same hook wrap each other, and which one ends up
outermost is fixed by whichever was `require`d **first** — in a warm VM, by whichever project rendered
first in that worker rather than by what the current render selected. A fixture renders one order and
compares it against a reference rendered the same way, so it agrees with itself whichever order that
is; only rendering both can tell you the extension does not care.

Worth knowing before dismissing a failure as cosmetic: when this was introduced it found a real
divergence in `theme-editing-all-extensions` whose committed `reference.pdf` was **completely
unchanged** by the fix. The forward order happened to be the correct one, so the bug was only ever
visible from the other side.

## Manifest format (`manifest.json`)

| Field | Type | Meaning |
|-------|------|---------|
| `name` | string | Human-readable fixture name (used in the test title). |
| `description` | string | What this fixture exercises (theme, includes, diagrams, citations, …). |
| `mainFile` | string | Entry AsciiDoc file, relative to `source/`. |
| `scale` | number | Render scale used to rasterize both PDFs before diffing (e.g. `2`). Applied identically to actual and reference. |
| `tolerance.pixelThreshold` | number 0–1 | Per-pixel colour-distance sensitivity. Smaller is stricter; larger ignores bigger colour differences (absorbs antialiasing). |
| `tolerance.maxMismatchRatio` | number 0–1 | Maximum fraction of mismatched pixels a page may contain before it is judged out of parity. |

Every fixture **records its own tolerance** so the accepted divergence is explicit and reviewable —
the harness applies no hidden global fudge factor. Choose the tightest tolerance the fixture can hold:
start strict, and only loosen `maxMismatchRatio` (or, sparingly, `pixelThreshold`) with a comment in
the fixture's `description` explaining what noise it is absorbing.

Example:

```json
{
  "name": "theme-fonts",
  "description": "Custom theme + branded fonts + embedded images; branded page background.",
  "mainFile": "main.adoc",
  "scale": 2,
  "tolerance": { "pixelThreshold": 0.1, "maxMismatchRatio": 0.005 },
  "referencePdf": "reference.pdf"
}
```

## Adding a fixture

1. Create `fixtures/<fixture-name>/source/` and add the AsciiDoc project (main file, includes, theme
   YAML, fonts, images) — exactly what a user would export.
2. Produce the reference PDF with the **external** Asciidoctor-PDF toolchain (the canonical CLI /
   Maven build — never the in-app export), using the same theme/fonts/attributes, and commit it as
   `reference.pdf`. Normalize its date/ID metadata so the corpus is reproducible.
3. Write `manifest.json` per the table above, recording a tolerance.
4. Run the parity spec (once the wasm engine is vendored):
   `pnpm --filter @asciidocollab/web e2e -- pdf-parity`.

## Comparison seam

The browser suite (`../pdf-parity-render.spec.ts`) drives the wasm engine + rendering shims directly
in a Playwright page and compares structurally via the poppler-backed helpers under `../harness/`
(text extraction, page-count, ink-map). The Node integration test additionally checks print-readiness
(embedded fonts, page geometry) against the reference. Neither depends on the removed in-app pixel
differ; parity is asserted at each fixture's recorded element-level tolerance.
