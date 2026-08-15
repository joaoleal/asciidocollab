# Quickstart: PDF-Look HTML Preview Style ("Print")

**Feature**: 045-pdf-style-preview

## What this feature adds

A third option in the preview's style control, labelled **Print**, that shows the document as a page
— paper-width column, theme margins, theme typography and colours, the PDF's own fonts — while
keeping everything the HTML preview already does (live typing, scroll sync, text search, selection).

It is not a PDF. Pagination, running headers/footers and page numbers stay with the existing PDF
preview.

## Seeing it

```bash
./dev.sh                      # the usual stack
```

Open a project, open a document, and pick **Print** in the preview header's style control. The demo
project ships `theme/showcase-theme.yml`, so the page picks up its navy headings, teal links, warm
sidebar and A4 geometry straight away.

To watch FR-024 (live theme updates): open `theme/showcase-theme.yml` in a second tab, change
`heading.font-color`, and the first tab's Print preview follows without a reload.

> Two dev-stack traps already recorded in this repo apply here: `next build` must not run while
> `next dev` shares `.next`, and the dev stack's rate limits make some e2e specs unrunnable against
> it. Neither is introduced by this feature.

## Verifying it

```bash
# Resolver — pure, fast, no browser
pnpm --filter @asciidocollab/shared test print-appearance

# Token across the boundaries
pnpm --filter @asciidocollab/domain test preview-style
pnpm --filter @asciidocollab/api test editor-preferences

# Web unit — appearance→CSS projection, font faces, diagnostics wiring
pnpm --filter @asciidocollab/web test print-preview

# Web unit — the page frame, the style's own isolation, the theme carried to the page
pnpm --filter @asciidocollab/web test asciidoc-preview.print
pnpm --filter @asciidocollab/web test styles/print

# End-to-end — style selection, zoom, diagnostics, style isolation. Needs the dev stack running.
pnpm --filter @asciidocollab/web exec playwright test print-preview.spec.ts

# The fidelity gate (Principle XV — the feature is not done without this). Needs NO stack: it runs
# under the parity config, which converts each fixture in Node and dresses it on a blank page.
pnpm --filter @asciidocollab/web exec playwright test \
  --config playwright.pdf-parity.config.ts pdf-parity/print-fidelity

# Regenerate the reference PDFs the gate compares against (needs Docker; only after a gem bump or a
# fixture change — the PDFs are committed).
node apps/web/e2e/pdf-parity/generate-reference.mjs \
  apps/web/e2e/pdf-parity/print-fidelity/fixtures/*

# The catalogue fonts and the admonition icons: regenerate from the gem, or check the committed ones
# still match it. Both run in the one CI job that has the gem.
pnpm --filter @asciidocollab/asciidoc-pdf generate:catalogue-fonts
pnpm --filter @asciidocollab/asciidoc-pdf check:catalogue-fonts
pnpm --filter @asciidocollab/asciidoc-pdf generate:admonition-icons
pnpm --filter @asciidocollab/asciidoc-pdf check:admonition-icons
pnpm --filter @asciidocollab/asciidoc-pdf generate:base14-fonts
pnpm --filter @asciidocollab/asciidoc-pdf check:base14-fonts

# Layer rules: primitives stays at zero deps, consumers declare what they use
pnpm run architecture
```

The API suite (`pnpm --filter @asciidocollab/api test editor-preferences`) starts a Postgres
container per suite. On this repo it also needs Prisma's AI-agent consent flag before `db push` will
run — a pre-existing condition of the repository, not of this feature.

Cap the worker count and wrap long unit runs in a memory scope — this repo's jest defaults to 23
workers on this machine and the API suites each start a Postgres container.

## Where things live

| Concern | Location |
|---------|----------|
| Theme → appearance model (pure) | `packages/shared/src/print-appearance/` |
| Appearance model → CSS custom properties | `apps/web/src/lib/print-preview/appearance-to-css.ts` |
| The stylesheet | `apps/web/src/styles/print-preview.css` |
| Fonts — wiring | `apps/web/src/lib/print-preview/font-faces.ts` (project fonts via the existing asset mechanism) |
| Fonts — catalogue assets | `packages/asciidoc-pdf/assets/fonts/` (committed, manifested) + `scripts/generate-catalogue-fonts.mjs` |
| Admonition icons | `packages/asciidoc-pdf/assets/admonition-icons/` (the gem's own glyphs, committed) + `scripts/generate-admonition-icons.mjs`; served from `/vendor/admonition-icons/` and painted as CSS masks |
| Style token (single definition) | `packages/primitives/src/preview-style.ts` |
| Zoom (shared with the PDF panel) | `apps/web/src/components/preview-zoom-control.tsx` |
| Diagnostics | the existing `apps/web/src/components/pdf-diagnostics.tsx` — reused, not replaced |
| Diagnostics adapter | `apps/web/src/lib/print-preview/to-diagnostic-properties.ts` |
| Which theme applies | `apps/web/src/lib/print-preview/resolve-project-theme.ts` |
| The fidelity gate | `apps/web/e2e/pdf-parity/print-fidelity/` (four anchors + their reference PDFs) |
| Its measurements + the one tolerance table | `apps/web/e2e/pdf-parity/harness/pdftools.ts` |

## Gotchas worth knowing before you start

1. **The theme cascade is the hard part.** The gem's own default theme uses `$variable` references
   and arithmetic (`round($base_font_size * 1.25)`, `$base_line_height_length / 10.5`) and mixed
   units. A resolver that reads keys literally returns `"$base_font_size_large"` as a font size and
   looks like it works until a real theme is loaded.
2. **Theme text is untrusted.** Every value is parsed to a typed value before it reaches CSS. No
   theme substring may ever appear verbatim in the output — that is what stops a value from closing
   a declaration and escaping the container.
3. **`filesVersion` does not cover the theme file, and does not need to.** It bumps for reachable
   *included* files, and a theme is never an include — which is exactly why
   `useProjectAuxiliaryTextCache` exists: it is seeded from the file tree and driven by the
   UNFILTERED `content-changed` stream. The Print theme memo depends on its `auxiliaryVersion` (a
   collaborator's edit) and on `liveOverlayContent` (the author's own edit to an open theme). Nothing
   here needed widening; naming the right signal was the whole job.
4. **Do not boot the wasm VM on this path.** No PDF render, no VM, no exceptions — FR-038. The
   whole point of the style is that it is as fast as the HTML preview.
5. **The style token now lives in exactly one place** — the new `packages/primitives`. It used to be
   defined three times (domain, shared DTO, web control); step 0 of the plan consolidates it before
   `print` is added. Remember the dependency **and** the tsconfig project reference in each consumer,
   and register the layer in `onion.config.json` in the same commit — the guard throws on a layer
   pointing at a directory that does not exist yet. Tests asserting exactly two styles will fail; fix
   the expectation, never the assertion.
6. **Fonts must be the gem's subsets**, not the full Google families. Same glyph coverage means a
   character missing from the PDF is missing from the preview too, instead of the preview flattering
   the output. Carry `LICENSE-noto` and `LICENSE-mplus` with them.
7. **Never read `packages/asciidoc-pdf/ruby/.wasm-build/`.** It is gitignored build output. The
   catalogue fonts are converted by a script in that package into a committed, manifested
   `assets/fonts/` directory, and `apps/web` consumes only that.
8. **Don't restate `RenderDiagnostic`.** The resolver has its own diagnostic type; the two meet in an
   adapter in `apps/web`. `asciidoc-pdf` may depend inward only on `asciidoc-core`, so the types
   cannot be unified — restating the shape would be a P0 duplication.
