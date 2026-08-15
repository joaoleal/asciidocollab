# Phase 1 Data Model: PDF-Look HTML Preview Style ("Print")

**Feature**: 045-pdf-style-preview | **Date**: 2026-08-09

Three of the spec's Key Entities are derived, in-memory values; one is persisted. Nothing here
requires a database migration.

---

## 1. Preview style token (persisted)

The only persisted change in the feature.

| Field | Type | Notes |
|-------|------|-------|
| `User.previewStyle` | `String` | Already `@default("asciidocollab")` in `packages/db/prisma/schema.prisma:342`. Gains a third admissible value. |

**Values**: `asciidocollab` | `asciidoctor` | `print` *(new)*

**Validation rules**

- FR-002: `print` MUST be accepted everywhere a preview style is validated or persisted — the domain
  value object (`PreviewStyle.parse`), the API route schema, the DTO, and the web-side guard.
- FR-009: an unrecognised stored value resolves to the default, unchanged behaviour
  (`PreviewStyle.parseOrDefault` already does this).
- FR-007/FR-008: a selection is remembered across sessions and documents, and existing stored values
  keep resolving to the style they name.

**No migration**: the column is a free `String`, so the new token is admissible without a schema
change. The default is unchanged, so no existing row is touched.

**Single definition**: the union previously existed in three places, two of them packages — a P0
blocking violation (rule 4). It is consolidated into a new zero-dependency leaf package,
`packages/primitives`, which `domain`, `shared`, `apps/web` and `apps/api` can all depend on —
the only arrangement in which one definition serves every consumer. This happens before `print` is
added. See [contracts/preview-style-token.md](./contracts/preview-style-token.md). Tests asserting
"exactly two styles" will fail; the expectation is what gets updated, never the assertion.

---

## 2. Effective appearance (derived, never stored)

The resolver's output: the theme's values layered over the gem's defaults, fully interpolated, in
one internal unit (PDF points).

```
AppearanceModel
├── page
│   ├── widthPt, heightPt          number   — from size + layout (portrait/landscape)
│   ├── marginPt                   { top, right, bottom, left }
│   └── backgroundColor            Colour
├── base
│   ├── fontFamily                 string   — a catalogue family name
│   ├── fontSizePt, lineHeight     number
│   ├── fontColor, borderColor     Colour
│   └── textAlign                  'left' | 'center' | 'right' | 'justify'
├── headings[1..6]                 { fontFamily?, fontSizePt?, fontColor?, fontStyle?, … }
├── link, codespan, code, list, quote, sidebar, example,
│   admonition, table, caption, thematicBreak, kbd, button, footnotes
│                                  — one record per FR-020 construct
└── fonts                          FontRequirement[]  — see §3
```

**Value types**

| Type | Shape | Parsed from |
|------|-------|-------------|
| `Colour` | 6-hex-digit RGB, normalised uppercase | `1A4E8A`, `'FFFFFF'`, or a `$ref` to one |
| `Measurement` | number, in points | `10.5`, `0.85in`, `12pt`, `4mm`, `1.2em` (relative to its context), `round($base_font_size * 1.25)` |
| `MeasurementBox` | 4 numbers, in points | `[0.85in, 0.8in, 0.9in, 0.8in]`, CSS-style shorthand expansion |
| `Keyword` | one of the descriptor's `permittedValues` | `bold`, `italic`, `center` |

**Derivation rules**

- FR-019: values are resolved **after** the `extends` chain, so a child theme's `extends: default`
  contributes every key it does not override.
- FR-020/FR-021: only the keys enumerated in FR-020 are claimed — that list is closed. A key outside
  it is neither applied nor reported; it is simply not part of this style's contract.
- FR-022: with no theme document, the model is the gem's default theme resolved with no overlay.
- FR-025: a value that cannot be parsed to its descriptor's `valueKind` is dropped, the default for
  that key alone is used, and an `AppearanceDiagnostic` is produced.
- FR-023: when the whole document cannot be parsed, the previous model for this project in this
  session is retained; if there was none, the default model is used.
- Principle XII: the model is a pure function of (theme text, descriptor table). No clock, no
  ordering nondeterminism, no ambient state.

**Lifecycle**: recomputed whenever the theme text changes (FR-024), memoised on theme-text identity
so a keystroke burst that ends where it started schedules no work.

---

## 3. Font requirement (derived)

One entry per family the model references, resolved to a source.

| Field | Type | Notes |
|-------|------|-------|
| `family` | string | The catalogue name the theme uses, e.g. `Noto Serif`, `M+ 1mn` |
| `faces` | `{ normal?, bold?, italic?, boldItalic? }` | Each a resolved source |
| `source` | `'project'` \| `'catalogue'` \| `'fallback'` | Priority order per research R3 |
| `approximate` | boolean | True for `fallback`; drives the FR-028 report |

**Rules**

- FR-027: `project` and `catalogue` sources render with the same font files the PDF uses. The
  `catalogue` source is the gem's converted subset — never another build of the same family that the
  app happens to load for other purposes (research R3).
- FR-028: a family resolving to `fallback` produces an `AppearanceDiagnostic` naming the font that
  could not be obtained.
- FR-029: a source is only ever the project's storage or the application's own origin. There is no
  code path that fetches a font from anywhere else.

---

## 4. Appearance diagnostic (derived)

A type **owned by the resolver**, with its own code vocabulary. It is deliberately *not* a restated
copy of the PDF pipeline's `RenderDiagnostic`.

| Field | Type | Notes |
|-------|------|-------|
| `severity` | `'error'` \| `'warning'` | Errors sort first |
| `code` | `AppearanceDiagnosticCode` | `theme-unparseable` \| `theme-value-rejected` \| `theme-font-unavailable` — resolution codes, distinct from the render-pipeline's code union |
| `message` | string | Human-readable |
| `themeKey?` | string | The rejected key, for `theme-value-rejected` — has no counterpart in the render pipeline |
| `resource` | string | The theme path, or the font family name for a substitution |
| `location?` | `{ path, line? }` | Present where known; drives the FR-035 reveal-in-editor control |

### Why it is not `RenderDiagnostic`

`RenderDiagnostic` is defined in `packages/asciidoc-pdf/src/protocol.ts:186` — it is that package's
**wire protocol** with the wasm worker. Restating its shape in `packages/shared` would be the same
type defined in two packages, which the Architecture Constitution blocks at P0 (rule 4).

Unifying it is not available either: `packages/asciidoc-pdf` declares only `asciidoc-core` and the
wasm runtime as dependencies and, per the Module Boundaries rule for browser-only capability
packages, **may depend inward only on `asciidoc-core`** — so it cannot import a type from `shared`.

The two types therefore stay distinct and genuinely differ (`themeKey`, a different code union, no
render-pipeline codes). They meet in `apps/web`, which already imports from both packages, via an
explicit adapter:

```
packages/shared          AppearanceDiagnostic   ─┐
                                                 ├─→ apps/web/src/lib/print-preview/
packages/asciidoc-pdf    RenderDiagnostic       ─┘      to-diagnostic-props.ts  → PdfDiagnostics
```

`PdfDiagnostics` props are widened to the **structural minimum** both satisfy
(`severity`/`message`/`resource`/`location?`), so the component depends on neither package's
concrete type. That widening is a small change to an existing component and is what makes the reuse
in FR-032 legitimate rather than a duplication in disguise.

**Rules**

- FR-033: an empty list renders nothing at all.
- FR-034: the surface summarises by severity, orders errors before warnings, and is collapsible and
  height-bounded — all behaviour the existing component already provides.
- FR-036: the surface sits outside the page column and must not displace or resize it.

---

## 5. Preview zoom (session state, not persisted)

| Field | Type | Notes |
|-------|------|-------|
| `mode` | `'fit'` \| `'custom'` | `fit` scales the page to the pane width |
| `scale` | number | Present when `mode` is `custom` |

**Rules**: FR-015 requires the same default, presets and limits as the PDF preview panel — satisfied
structurally by extracting that panel's model rather than restating the numbers here. FR-013: at
`fit` the pane never scrolls horizontally. FR-016: horizontal scrolling occurs only under a `custom`
scale wider than the pane.

---

## Entity relationships

```
User ──1:1──> previewStyle token        (persisted, per-user, Principle VII)

Project files ──resolveThemePath()──> Theme document (text)
                                          │
                                          ▼
                            AppearanceModel + AppearanceDiagnostic[]
                                          │
                        ┌─────────────────┴─────────────────┐
                        ▼                                   ▼
              CSS custom properties                  FontRequirement[]
              on the preview container               → @font-face declarations
```

The theme document is project-scoped and shared; the preview style is user-scoped. They meet only in
the derived model, which is per-viewer and never written back — which is what keeps Principle VII
intact while a project-wide theme drives a personal preference's appearance.
