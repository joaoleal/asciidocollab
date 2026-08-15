---

description: "Task list for 045-pdf-style-preview — PDF-look HTML preview style (\"Print\")"
---

# Tasks: PDF-Look HTML Preview Style ("Print")

**Input**: Design documents from `/specs/045-pdf-style-preview/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Implementation**: Every task MUST be executed via the `/tdd` skill (Constitution §Implementation
Discipline). Tasks describe WHAT to implement; the skill owns red-green-refactor. No task is split
into a separate "write test" and "write implementation" pair.

**Organization**: Grouped by user story. Both stories are P1, and per plan §Phase Sequencing they are
**not independent in build order** — US2's theme application needs the resolver US1's page geometry
already depends on. The resolver is therefore Foundational rather than owned by either story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: `[US1]` or `[US2]`; Setup, Foundational and Polish tasks carry no story label

## Path Conventions

Tests live in a dedicated `tests/` directory at the package or app root, mirroring the source tree.
**Never** `__tests__/`, never co-located.

| Package / App | Source root | Test root |
|---------------|-------------|-----------|
| `packages/primitives` | `packages/primitives/src/` | `packages/primitives/tests/` |
| `packages/shared` | `packages/shared/src/` | `packages/shared/tests/` |
| `packages/domain` | `packages/domain/src/` | `packages/domain/tests/` |
| `packages/asciidoc-pdf` | `packages/asciidoc-pdf/src/` | `packages/asciidoc-pdf/tests/` |
| `apps/api` | `apps/api/src/` | `apps/api/tests/` |
| `apps/web` | `apps/web/src/` | `apps/web/tests/` |

Playwright specs live in `apps/web/e2e/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Remove the P0 cross-package type duplication before the feature widens it.

- [X] T001 Create the zero-dependency leaf package `packages/primitives` (`package.json` with **no**
  `dependencies` block, `tsconfig.json`, `src/index.ts`, `src/preview-style.ts`) holding the single
  definition of `PreviewStyleValue`, `PREVIEW_STYLE_VALUES` and `isPreviewStyleValue`; delete the
  three existing definitions in `packages/domain/src/value-objects/editor/preview-style.ts`,
  `packages/shared/src/dtos/editor-preferences.dto.ts` and
  `apps/web/src/components/preview-style-control.tsx` and import from the package instead; add the
  `workspace:*` dependency **and** the tsconfig project reference in `packages/domain`,
  `packages/shared`, `apps/web` and `apps/api`; register the layer in `onion.config.json` with
  `"allowedImports": []` and grant `primitives` to the four consumers' rules. **The
  `onion.config.json` change MUST land in the same commit** — `loadConfig` throws on a layer pointing
  at a directory that does not exist. Pure refactor, no behaviour change; the `PreviewStyle` value
  object with `parse`/`parseOrDefault`/`default()` stays in `domain` (rule P2). Verify with
  `pnpm run architecture`. See [contracts/preview-style-token.md](./contracts/preview-style-token.md).

**Checkpoint**: one definition of the token; `pnpm run architecture` green; no behaviour changed.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The pure theme resolver. Both user stories consume it — US1 for page geometry (FR-011)
even with no project theme, US2 for everything else.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

**Contract**: [contracts/print-appearance.md](./contracts/print-appearance.md) rules C1–C10.

- [X] T002 [P] Extend `packages/shared/scripts/generate-theme-descriptors.mjs` to also emit
  `packages/shared/src/print-appearance/page-sizes.generated.ts` — the gem's named page-size table in
  points — so a gem bump cannot leave the table stale (research R8, Principle XII).
- [X] T003 [P] Implement `packages/shared/src/print-appearance/units.ts`: parse `Colour` (6-hex RGB,
  normalised uppercase), `Measurement` (`in`/`mm`/`pt`/`em`/bare → points), `MeasurementBox`
  (CSS-style shorthand expansion of array measurements) and `Keyword` (against a descriptor's
  permitted values). All measurements resolve to PDF points; no CSS unit is produced here (C8, R8).
- [X] T004 [P] Implement `packages/shared/src/print-appearance/parse-theme.ts`: YAML text → flat key
  map, resolving the `extends` chain with `DEFAULT_THEME_YAML` at its base, and normalising
  `snake_case` theme keys against `dash-case` descriptor keys onto one form (FR-019, R2).
- [X] T005 Implement `packages/shared/src/print-appearance/resolve-values.ts`: `$variable`
  interpolation and the arithmetic the gem's own default theme uses (`+ - * /`, `round()`), scoped to
  those forms only — anything else is an unresolvable value that gets rejected and reported, never
  guessed (R2). Depends on T003, T004.
- [X] T006 [P] Define `packages/shared/src/print-appearance/appearance-model.ts` and
  `appearance-diagnostic.ts`: the `AppearanceModel` tree per data-model §2 and the resolver's **own**
  `AppearanceDiagnostic` with its own code union (`theme-unparseable` | `theme-value-rejected` |
  `theme-font-unavailable`) plus `themeKey`. It MUST NOT restate `RenderDiagnostic` from
  `packages/asciidoc-pdf` (C10, blocking rule 4).
- [X] T007 Implement the public surface in `packages/shared/src/print-appearance/index.ts` —
  `resolveAppearance()` and `defaultAppearance()` — covering the `page` and `base` sections and
  contract rules C1, C2, C5, C7, C8. Totality (C1) and determinism (C7) are assertions, not prose.
  Depends on T002–T006.
- [X] T008 Resolve the remaining FR-020 constructs into the model — headings 1–6, link, codespan,
  code, list, quote, sidebar, example, admonition, table, caption, thematic break — with a per-key
  assertion for **every** key named in FR-020 and zero keys claimed but unasserted (SC-004; oracle B
  in [contracts/fidelity-oracle.md](./contracts/fidelity-oracle.md)). Keys outside FR-020 are neither
  applied nor reported (C6). Depends on T007.
- [X] T009 Harden the resolver against untrusted theme text in
  `packages/shared/tests/print-appearance/`: malformed YAML, absurd sizes, non-colours, and a value
  attempting to close a CSS declaration each yield a usable appearance plus exactly one diagnostic —
  a single bad value costing only its own key (FR-025), an uninterpretable document costing only the
  document (FR-023) — and **no value in the model is a raw substring of the input** (C4, C5, C9;
  Principle IX). Also
  assert the repo's existing themes (`apps/api/data/demo-project/theme/showcase-theme.yml` and the
  `apps/web/e2e/pdf-parity/fixtures/**` themes) resolve with no diagnostics. Depends on T008.

**Checkpoint**: theme YAML → appearance model, unit-tested with no DOM, no browser and no wasm VM.

---

## Implementation status (as of the last `/speckit-implement` run)

Phases 1–4 (both user stories) are complete, and the fidelity gate (T030–T032) passes: 28
comparisons across four anchors against reference PDFs rendered by the external, canonical
Asciidoctor-PDF toolchain — typeface, size, colour, page geometry, column width and line-break
position, the last within ±1 character.

**Done**: T001–T036, plus a second pass (below) driven by side-by-side comparison against the PDF.
**Remaining**: T037 — the full `pnpm gate` (its e2e leg needs the dev stack running).

### Second pass: what side-by-side comparison found that the anchors did not

The four fidelity anchors measure typography, colour and geometry, and they measure those exactly.
They say nothing about the constructs that have no counterpart in a plain paragraph, and every one of
those was wrong when the style was first put next to the export on a real document:

- **Admonition icons** were the application's own brand glyphs in the application's own palette,
  pinned to the top of the block. The renderer draws Font Awesome glyphs from a table in its own
  source, vertically centred, in a label column one-and-a-half icons wide.
  `packages/asciidoc-pdf/scripts/generate-admonition-icons.mjs` now extracts those five glyphs from
  the gem and commits them with the colours and sizes the converter's `AdmonitionIcons` table gives
  them; the theme's own `admonition.icon.<kind>.stroke-color`/`.size` override both.
- **The experimental inline macros** (`kbd:`, `btn:`, `menu:`) were unstyled: the vendored Asciidoctor
  sheet carries them only under the Asciidoctor style, so a key chord rendered as bare text and a
  menu path lost its caret entirely.
- **Callout numbers** showed the raw `(1)` fallback rather than a circled number.
- **Source blocks were not highlighted at all**, although the export always highlights them.
- **Inline code** was given a border and padding no theme had asked for, which moved every character
  after it along the line.
- **Lists, description lists, footnotes and block image alignment** took hard-coded values where the
  theme had something to say.

The claimed key list (FR-020) widened accordingly, from 110 keys to 176. Each new key has a probe in
`packages/shared/tests/print-appearance/claimed-keys.test.ts`, which asserts the claimed set and the
asserted set are the same set — so none of this could have been claimed without being proven.

Two of the renderer's values are genuinely **text** rather than a colour, a length or a keyword: a
button's bracket template and the menu caret. They are carried as CSS strings with every code point
escaped as `\XXXXXX `, so a theme that changes its brackets changes the page while not one character
of the theme's text appears verbatim in the output.

The "not paginated" notice over the page was removed as too intrusive; FR-037's statement now lives
in the style option's own description, where a pointer and a screen reader both reach it.

Everything the gate covers that does NOT need a live stack has been run and is clean:
`eslint .` (0 errors), every package's `tsc --noEmit -p tsconfig.eslint.json` (tests included),
`node scripts/ci/architecture-guard.mjs`, the unit suites for primitives / asciidoc-core / domain /
shared / asciidoc-pdf / web (5 967 web tests, branch coverage 90.12% against its 90% threshold), the
API editor-preferences suite, and the fidelity gate (28/28 against reference PDFs).

Things the plan did not anticipate, recorded here rather than discovered again:

- `apps/web/src/styles/asciidoc-preview.css` scopes the brand style by **exclusion**
  (`:not([data-preview-style="asciidoctor"])`), not by a positive match, so a newly added style
  inherits all of it. T010 had to widen that exclusion to cover `print` across 150 selectors, and
  regenerate `apps/web/src/lib/html-export/export-css.generated.ts` from it. The same file also
  carries a region of bare-container rules that apply to every style on purpose (the include
  placeholder, the admonition icons); the page-break rule was in that region and had to be excluded
  from Print, because a dashed rule across the page is the one mark on it the export does not draw.
  `apps/web/tests/styles/print-style-isolation.test.ts` now holds that allowlist explicitly.
- `apps/web/tests/styles/asciidoctor-list-and-table.test.ts` extracts selectors with a greedy regex
  that also matches prose in the file's header comment; it passed only because the greedy match ran
  on into a real selector. The new isolation test parses selectors properly instead, and the
  vocabulary-agreement test strips comments before scanning — the same trap caught it once.
- T019's named risk did **not** materialise, but not for the reason the task expected: the preview
  does not need `filesVersion` widened, because a theme's live content already arrives through
  `useProjectAuxiliaryTextCache` (seeded from the file tree, driven by the UNFILTERED
  `content-changed` stream, precisely because a theme is never include-reachable). The Print theme
  memo names `auxiliaryVersion` and `liveOverlayContent` as dependencies for that reason.
- T023 reads the gem's own `data/themes/default-theme.yml` rather than `packages/shared`'s committed
  copy of it. The task named the copy; the copy lives in an OUTER package, and a generator inside
  `packages/asciidoc-pdf` reaching out to it would point an inner package at an outer one. The two
  cannot disagree — one is a verbatim copy of the other — so the derivation is the same and the
  direction of the dependency is right.
- T027's module is `to-diagnostic-properties.ts`, not `to-diagnostic-props.ts`: the repository's
  `unicorn/prevent-abbreviations` rule rejects `props` in a file or symbol name.
- `useProjectAssetCache` gained one accessor, `getAssetBytes(path)`. The font loader wants one named
  face and would otherwise scan the whole snapshot list for it. Same cache, same fetch, same
  validated path — a narrower read of the existing mechanism rather than a second one (F1).

---

## Phase 3: User Story 1 - Preview the document in the PDF's look (Priority: P1) 🎯 MVP

**Goal**: A third selectable style that presents the live preview as a paper-width page column with
the PDF's default appearance, keeping every behaviour the existing styles provide.

**Independent Test**: Open a document in a project with **no** custom theme, select Print, and
confirm (a) the content is a paper-width page rather than either existing style, (b) typing still
updates live, (c) scroll sync, selection and browser find still work, (d) the selection survives a
reload and applies to other documents.

- [X] T010 [US1] Add `print` to `packages/primitives/src/preview-style.ts`, its label "Print" to
  `PREVIEW_STYLE_LABELS` in `apps/web/src/components/preview-style-control.tsx` (labels stay
  app-owned), and accept the token in the API schema at
  `apps/api/src/routes/auth/me/editor-preferences.ts`. Covers contract rules T1–T7 in
  [contracts/preview-style-token.md](./contracts/preview-style-token.md): `parse('print')` succeeds,
  `parseOrDefault` is unchanged, the two existing tokens resolve exactly as before, the default stays
  `asciidocollab`, the control offers three options, and selection persists per user. No migration —
  `User.previewStyle` is already a free `String`. Existing tests asserting a two-element list must
  have their **expectation** corrected, never their assertion weakened. (FR-001, FR-002, FR-007–FR-009,
  SC-010)
- [X] T011 [P] [US1] Extract the zoom model out of `apps/web/src/components/pdf-preview-panel.tsx`
  into `apps/web/src/components/preview-zoom-control.tsx` — fit-to-width default, the 75/100/125/150/200%
  presets, the 0.25×–4× clamps and the `{mode:'fit'} | {mode:'custom',scale}` state — and have the PDF
  panel consume it with no behaviour change. Only the state model and control move; the panel's pdf.js
  repaint debounce stays where it is (research R7, FR-015).
- [X] T012 [P] [US1] Add `apps/web/src/styles/print-preview.css`, scoped to
  `.asciidoc-preview-content[data-preview-style="print"]` by the same construction the two existing
  styles use, covering every construct in FR-005's closed list and reading its dynamic values from
  the CSS custom properties fixed in
  [contracts/print-appearance.md](./contracts/print-appearance.md) §CSS custom-property vocabulary —
  the names are **not** invented here, and each is read through a `var(--print-x, <default>)`
  fallback so an absent value degrades to the default rather than to nothing (V1–V4)
  (FR-003, FR-005, FR-006, Principle VI).
- [X] T013 [US1] Implement `apps/web/src/lib/print-preview/appearance-to-css.ts` — `AppearanceModel`
  → validated CSS custom properties under the same vocabulary contract (V1–V4), converting points to
  pixels once at the boundary at 96/72. A value is written only after it has been parsed to a typed
  value; a raw theme string is never concatenated into CSS (research R6, R8; Principle IX). Include
  the **V5 agreement test**: the set of properties this file writes and the set
  `print-preview.css` reads are equal. T012 and T013 touch different files and share no import, so
  this test is the only thing that stops the two halves of the vocabulary from drifting apart.
  Depends on T007, T012.
- [X] T014 [US1] Implement `apps/web/src/hooks/use-print-appearance.ts`: resolution memoised on
  theme-text identity so a keystroke burst schedules no work, returning the default appearance when
  the project has no theme. **No wasm VM boot and no PDF render on this path** (FR-022, FR-038,
  Principle XIII). Depends on T013.
- [X] T015 [US1] Present the page frame in `apps/web/src/components/asciidoc-preview.tsx`: a fixed
  page-width column on a visually distinct page background, width/aspect/inset derived from the
  model's page geometry, the theme's page background applied to the column, fit-to-width by default
  with no horizontal scrolling, the column holding its page width in a wider pane, and the extracted
  zoom control wired in — horizontal scrolling occurring only above 100% in a narrower pane
  (FR-010–FR-017, SC-007). **Assert FR-012 explicitly**: content flows continuously inside the one
  column, and the style emits no page break, no running header or footer and no page number. It is a
  MUST NOT that nothing else in this feature would fail on, which is exactly why it needs its own
  assertion rather than being left to follow from the design. Depends on T011, T014.
- [X] T016 [US1] Preserve every existing preview behaviour under the page frame and its scale
  transform: scroll synchronisation with the editor, text selection, browser find, in-preview section
  navigation, and the review/cross-reference affordances. The scale transform changes element offsets,
  so scroll sync is the one most likely to need real work rather than only a test (FR-004, FR-006).
  Depends on T015.
- [X] T017 [US1] Assert style isolation in `apps/web/tests/styles/`: switching between the three
  styles leaves no residual styling or page framing from the previous one, and nothing in
  `print-preview.css` escapes `[data-preview-style="print"]` (Principle VI, spec Edge Cases).
  Depends on T015 — "no residual **page framing**" cannot be asserted before the page frame exists.
- [X] T018 [US1] Add `apps/web/e2e/print-preview.spec.ts` covering US1 acceptance scenarios 1–10:
  three styles offered with the active one indicated, restyled page visible within one second, live
  typing, scroll sync, column not stretching in a wide pane, fit-to-width in a narrow pane with no
  horizontal scroll, zoom presets matching the PDF preview's, horizontal scroll only after zooming in,
  and the selection surviving reload and document switch (SC-001, SC-007). Depends on T016.

**Checkpoint**: Print is selectable, remembered, and renders the document as a page in the PDF's
default appearance. Demonstrable on a project with no theme.

---

## Phase 4: User Story 2 - See the project's custom PDF theme applied (Priority: P1)

**Goal**: The previewed page carries the project's own theme — geometry, typography, colours, block
treatments — with the PDF's own fonts, updating live, and reporting appearance problems through the
existing diagnostics surface.

**Independent Test**: Open a project with a custom theme, activate Print, and confirm the page
carries the theme's page size, heading colour, body font and code-block background rather than the
defaults; change one of those values in the theme and confirm the preview follows without a reload.

- [X] T019 [US2] Implement `apps/web/src/lib/print-preview/resolve-project-theme.ts`: pick the theme
  from the preview's existing `getFiles()` snapshot using `resolveThemePath()` from
  `@asciidocollab/asciidoc-core`, so the preview applies the **same** theme document the PDF export
  would (FR-018). **Verify first** that `filesVersion` bumps when the theme file changes — it
  currently bumps for reachable *included* files and the theme is not an include — and widen the
  signal if it does not (research R5, named risk).
- [X] T020 [US2] Wire the resolved theme through `use-print-appearance`: effective values after the
  `extends` chain, live update on theme change with no reload and no re-selection, and **hold the last
  interpretable appearance** for this project in this session when the theme is momentarily
  unparseable — never a blank preview, never a moved page column (FR-019, FR-022, FR-023, FR-024,
  SC-005). Holding last-good is the caller's job, not the resolver's (C5). Depends on T019.
- [X] T021 [US2] Carry every FR-020 construct value from the model through
  `appearance-to-css.ts` and `print-preview.css` to the page — page geometry and background, body and
  heading typography and colours per level, link colour, inline-code and code-block treatment, list
  marker colour, quote, sidebar, example, admonition, table borders/grid/header/stripe, caption and
  thematic break — while values with no on-screen counterpart are ignored without error (FR-019,
  FR-020, FR-021, SC-004 applier half). Depends on T020.
- [X] T022 [US2] Assert colour fidelity: the page and its content render in the theme's own colours
  **identically** under the application's light and dark modes, while the chrome around the page
  column stays token-driven and is never restyled by the theme (FR-030, FR-031, SC-009; Principle V's
  explicit-and-confined exception). Depends on T021.
- [X] T023 [P] [US2] Add `packages/asciidoc-pdf/scripts/generate-catalogue-fonts.mjs` converting the
  gem's subsetted TTF faces to WOFF2 into the **committed** `packages/asciidoc-pdf/assets/fonts/`,
  with a `manifest.json` recording the gem version and a content hash per face, and the gem's
  `LICENSE-noto`, `LICENSE-mplus` and `ABOUT-*` files carried alongside. Register the script in that
  package's `package.json` the way `generate:theme-descriptors` is, and publish the directory through
  the package's exports. **Convert every family the gem's default theme references** — read the list
  from `default-theme.generated.ts`'s font catalogue rather than guessing; `M+ 1mn` and `Noto Serif`
  at minimum. The app's existing `next/font/google` `Noto Serif`
  (`apps/web/src/app/layout.tsx:14`) does **not** satisfy this: it is a different build of the family,
  so its metrics are not the PDF's, and it is the default theme's body face — reusing it would leave
  the appearance every theme-less project gets riding on the one font path never compared against the
  gem's own file. Scope the set by what the default theme can reference, never by what a fixture
  happens to exercise (the anchor set is small by design). **Never read
  `packages/asciidoc-pdf/ruby/.wasm-build/` from any other package** — it is gitignored build output
  (research R3, contract rules F5 and F7).
- [X] T024 [US2] Add a CI check that regenerates the catalogue fonts and compares against the
  committed assets and manifest, so they cannot drift from the gem (Principle XII). Depends on T023.
- [X] T025 [US2] Implement `apps/web/src/lib/print-preview/font-faces.ts`: `@font-face` declarations
  from the three sources in priority order — the project's own WOFF2 files **through the existing
  project-asset mechanism** (`use-project-asset-cache.ts` / `use-referenced-assets.ts`, contract rule
  F1 — no new route, no new storage reader, no path join at the call site), the catalogue assets from
  the application's own origin, and a same-classification fallback. A missing, unreadable or
  non-decodable font resolves to `fallback` with a `theme-font-unavailable` diagnostic naming the
  font, never a broken page and never a silent blank. Every family the gem's default theme references
  must resolve to `catalogue` rather than `fallback`, asserted against that theme's own family list
  (F7) — a family missing from T023's conversion fails here instead of quietly degrading the default
  appearance. Font bytes are handed to the browser's font loader as opaque bytes and are never parsed
  by application code. Extend the existing no-egress guard
  (`apps/web/tests/workers/pdf-no-egress.test.ts` is the precedent) so the assertion is static, not
  behavioural, and cover **both** outbound paths in it — no font fetched from an external location
  (FR-029) and no theme value able to make the preview reach the network (FR-026), which are one rule
  stated twice in the spec and should have one enforcement point (FR-027, FR-028, FR-029, FR-026;
  contract rules F1–F7; Principle X). Depends on T023.
- [X] T026 [US2] Widen the props of `apps/web/src/components/pdf-diagnostics.tsx` to the structural
  minimum both diagnostic types satisfy — `severity`, `message`, `resource`, optional `location` — so
  the component depends on neither `packages/shared`'s nor `packages/asciidoc-pdf`'s concrete type,
  with the PDF panel's existing behaviour unchanged (blocking rule 4; the widening is what makes
  FR-032's reuse legitimate rather than duplication in disguise).
- [X] T027 [US2] Implement `apps/web/src/lib/print-preview/to-diagnostic-props.ts` (adapter:
  `AppearanceDiagnostic` → the widened props) and report all three problem classes — uninterpretable
  theme, rejected theme value, substituted typeface — through that one surface: nothing rendered when
  the list is empty, errors before warnings, resource named, collapsible and height-bounded, source
  location revealed in the editor where known, and the surface placed **outside** the page column so
  it can never displace or resize it (FR-032–FR-036, SC-012). Depends on T025, T026.
- [X] T028 [US2] Prove the hostile-theme path end to end in `apps/web/tests/`: for every malformed,
  incomplete and hostile theme in the test set the preview keeps showing the document content, with
  zero blank previews, zero application errors and zero styling escaping the previewed page (SC-008,
  FR-026). The existing `apps/web/tests/lib/pdf/theme-untrusted-input.test.ts` is the precedent to
  follow. Depends on T027.
- [X] T029 [US2] Add `apps/web/e2e/print-preview-theme.spec.ts` covering US2 acceptance scenarios
  1–12: theme values visibly applied, project-supplied fonts rendered rather than substituted,
  catalogue fonts rendered, live theme update from a collaborator's edit, no-theme default with no
  error, invalid theme keeping content and reporting through the diagnostics surface without moving
  the page column, the declared theme document chosen, unpaginated-only values ignored, missing font
  falling back with an approximation notice, dark mode unchanged, no surface when nothing is wrong,
  and reveal-in-editor from a diagnostic (SC-005, SC-009, SC-012). Depends on T028.

**Checkpoint**: both stories functional. The Print style shows the project's real theme, with the
PDF's real fonts, and reports its own problems the way the PDF does.

---

## Phase 5: Fidelity Gate & Polish

**⚠️ T030–T032 are not optional polish.** Under Principle XV a fidelity-critical deliverable with no
passing comparison against **reference** output is **not done**.

- [X] T030 Assemble the anchor set under `apps/web/e2e/pdf-parity/print-fidelity/fixtures/` and
  generate its reference PDFs with the existing `apps/web/e2e/pdf-parity/generate-reference.mjs`.
  Small and chosen for construct coverage, between them exercising every construct in FR-005, and
  including: a project with **no** theme; a project with a rich custom theme; a theme with a
  non-default page size and margins (so SC-003 is not proven only against A4); and a theme using a
  **project-supplied** font (`fixtures/theme-fonts-woff2` is existing precedent).
- [X] T031 Extend `apps/web/e2e/pdf-parity/harness/pdftools.ts` to extract, per construct, the
  resolved font family and size from pdf.js `getTextContent()` with styles and the text fill colour
  from the operator list, plus page content width and insets. Declare the tolerance table **once** in
  the harness (family exact, size ±0.25 pt, colour ±2 per channel, geometry ±0.5 pt, body line break
  ±1 character) and share it across every comparison (Principle XII). Colour extraction is the one
  genuinely new piece; if it proves unreliable the documented fallback is a coarse ink-map comparison
  for colour with font, size and geometry kept exact — **recorded in the harness, not silently
  taken**. Depends on T030.
- [X] T032 Add the anchor comparison spec under `apps/web/e2e/pdf-parity/print-fidelity/`: for each
  fixture, compare the Print preview against the **reference-build** PDF (never the in-app PDF —
  Principle XI forbids adopting in-app output as a baseline) on family, size, colour, page geometry
  and body line-break position, within T031's tolerances (SC-002, SC-003; Principles XI and XV). Any
  tolerance widened during implementation is recorded with its reason — a widened tolerance is a
  design decision, not a test fix. Depends on T031.
- [X] T033 [P] Confirm SC-006 and FR-038: with Print active, typing updates the preview within the
  budget the existing styles are already held to, and no wasm VM is booted and no PDF rendered on
  this path. The budget is not a new number — extend `apps/web/e2e/preview-adaptive-delay.spec.ts`
  to cover the Print style with **its** existing constants: the 100-line document at
  ≤ `SMALL_DOCUMENT_TARGET_MS` (200 ms) against the recorded 509 ms baseline, the 15 000-line
  document at ≤ its recorded 1059 ms baseline, 5 samples per document, delay clamped to
  `[PREVIEW_ADAPTIVE_MIN_MS, PREVIEW_DEBOUNCE_MS]`. **Raising a threshold to make Print pass is a
  regression, not a pass** — it is the one outcome this task exists to catch. That spec runs last and
  alone; keep it that way. Depends on T029.
- [X] T034 [P] Confirm FR-039: keyboard operability of the style control and the zoom control,
  screen-reader labelling of the third option on the same terms as the existing two, reduced-motion
  respected, and the page's fit-to-width scaling not defeating the browser's own text zoom.
  Depends on T018.
- [X] T035 [P] Confirm SC-011 by review, against its two stated conditions: the Print option carries
  a label and description naming its purpose, and while it is active the interface states that the
  genuine PDF preview and export remain the authority on the final document — Print reproducing no
  page-level behaviour (page breaks, running headers and footers, page numbering, cross-page
  placement). This is the *messaging* half; FR-012's behavioural half is asserted in T015 (FR-037,
  SC-011).
- [X] T036 Run `quickstart.md` end to end as written — every verification command in it, including
  `pnpm run architecture` — and correct the document where reality differs. Depends on T032.
- [ ] T037 Full quality-gate sweep (`pnpm gate` — lint, typecheck, unit, integration, security scan,
  e2e) and `/code-review` in a loop until zero findings (Constitution §End-of-Feature Verification).
  Cap jest workers and wrap long unit runs in a memory scope — this repo's jest defaults to 23 workers
  here and the API suites each start a Postgres container. Depends on all prior tasks.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001)**: no dependencies — start immediately.
- **Foundational (T002–T009)**: depends on nothing in Setup technically, but T001 lands first so
  `print` is added in one place instead of three. **Blocks both user stories.**
- **US1 (T010–T018)**: depends on Foundational.
- **US2 (T019–T029)**: depends on Foundational **and** on US1's applier seam (T013) and page frame
  (T015) — see below.
- **Fidelity gate & polish (T030–T037)**: depends on both stories.

### User Story Dependencies

The two stories are **not** independent in build order, and the plan says so explicitly. US2's theme
application flows through the same `appearance-to-css.ts` (T013) and page frame (T015) US1 builds.
US1 is nonetheless independently demonstrable and testable on a project with no custom theme, which
is what makes it a real MVP rather than a slice that cannot be shown.

Concretely: T019–T022 and T027 depend on US1 tasks; T023–T026 do not and can start as soon as
Foundational is done.

### Within Each Story

- Each task is one `/tdd` invocation — red, green, refactor. Never split test from implementation.
- Types before resolvers; resolver before applier; applier before page frame; page frame before the
  isolation and e2e assertions that observe it.
- Commit after each task, only after green.

### Parallel Opportunities

- **Foundational**: T002, T003, T004 and T006 are four different files with no ordering between them.
  T005 needs T003+T004; T007 needs all of them.
- **US1**: T010 (token + label + API), T011 (zoom extraction) and T012 (stylesheet) touch disjoint
  files and can run at once. T013 then follows T012, because the V5 agreement test needs the
  stylesheet's property set to compare against. T017 and T018 are independent of each other but
  **both** follow the page frame (T015).
- **US2**: T023 (font generator, in `packages/asciidoc-pdf`) and T026 (props widening, an existing
  component) are independent of the theme-wiring chain T019→T020→T021→T022 and of each other.
- **Polish**: T033, T034 and T035 are independent.

## Parallel Example: Foundational Phase

```bash
# Four independent files, no ordering between them:
Task: "T002 page-sizes.generated.ts + generator extension"
Task: "T003 units.ts — colours, measurements, boxes, keywords → points"
Task: "T004 parse-theme.ts — YAML + extends chain + key normalisation"
Task: "T006 appearance-model.ts + appearance-diagnostic.ts"
```

## Parallel Example: User Story 1

```bash
# Three disjoint files, no ordering between them:
Task: "T010 print token + Print label + API schema"
Task: "T011 extract preview-zoom-control.tsx from pdf-preview-panel.tsx"
Task: "T012 print-preview.css scoped to [data-preview-style='print']"

# Then, once the page frame (T015) exists, these two are independent of each other:
Task: "T017 style-isolation assertions in apps/web/tests/styles/"
Task: "T018 print-preview.spec.ts — US1 acceptance scenarios 1-10"
```

---

## Implementation Strategy

### MVP (Setup + Foundational + US1)

1. T001 — one definition of the token, guard green.
2. T002–T009 — the resolver, unit-tested with no browser and no VM.
3. T010–T018 — Print selectable and rendering as a page in the PDF's default appearance.
4. **STOP and VALIDATE**: open a project with no theme, select Print, confirm the independent test.
5. Demoable: an author writing for print sees real line lengths without leaving the editor.

Note honestly: the MVP is not cheap. The Foundational resolver is the largest and least certain piece
of the feature (research R2 says so), and US1 cannot show a correctly-sized page without it.

### Incremental Delivery

1. Setup + Foundational → resolver proven in isolation.
2. + US1 → Print style shippable on default appearance (MVP).
3. + US2 → the project's own theme, fonts and diagnostics.
4. + T030–T032 → fidelity proven against reference output. **Only now is the feature done.**
5. + T033–T037 → performance, accessibility, quickstart, full gate.

### Parallel Team Strategy

1. Everyone through T001 and the Foundational phase together — it blocks all downstream work.
2. Then: Developer B takes T011 and T012 first, since both are leaves; Developer A takes T010, then
   the page-frame chain T013→T014→T015→T016→T018 — T013 waits on B's T012, which is the one
   hand-off between them. Developer B picks up T017 once the page frame lands. Developer C runs the
   US2 tasks that do not depend on US1 (T023→T024, T025, T026) throughout.
3. Converge on T019–T022 and T027–T029 once the page frame exists.

---

## Notes

- `[P]` means different files and no dependency on an incomplete task.
- Each task = one `/tdd` invocation; never split test and implementation into separate tasks.
- **Never weaken a test to make a failure go away.** T001 and T010 will break existing tests that
  assert exactly two preview styles — the *expectation* is what gets corrected.
- Two dev-stack traps recorded in this repo apply throughout: `next build` must not run while
  `next dev` shares `.next`, and the dev stack's rate limits make some e2e specs unrunnable against
  it. Neither is introduced by this feature.
- Principle XV: T032 is a gate, not polish. A fidelity-critical deliverable with no passing comparison
  against reference output is not done.
