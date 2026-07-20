# Phase 1 Data Model: PDF Theme Editing & Sectioned Project Options

**Feature**: 041-pdf-theme-project-options
**Date**: 2026-07-18

**Headline**: this feature adds **no database migration**. The theme is an ordinary project file, and
extension selection is a new key inside the existing `project_render_configs.config` JSON blob.

---

## 1. PDF Theme (existing file, no new entity)

A theme is a project file. It has no table, no DTO and no lifecycle of its own.

| Aspect | Value |
|---|---|
| Identity | Its path in the project file tree |
| Recognition | Filename matches `*-theme.yml` / `*-theme.yaml` (FR-009a) |
| Storage | Project file store + Yjs state, exactly like a `.adoc` file |
| Permissions | Existing file permissions (FR-026) |
| Concurrency | Existing co-editing (FR-026a) — `Y.Text` on key `codemirror` |
| Persistence | `onStoreDocument` in `apps/collab/src/extensions/persistence.ts` |
| Audit | Whatever the project already records for file changes (FR-023) |
| Size bound | The project's existing per-file limit (FR-022) |

**Validation rules**

- Recognition is by filename alone; contents are never sniffed (FR-009a).
- A project resolves to at most one theme at a time, via the existing `pdfTheme` render-config setting
  and `discoverThemePath` (FR-024, FR-025).
- The recognition rule and the renderer's discovery rule MUST be one shared function (FR-009b) — this
  is the single most important invariant in the model, because two copies would silently diverge.

**State transitions**: none. A file becomes a theme, or stops being one, purely by rename (FR-009a),
which is why US2 scenario 13 and the corresponding edge case exist.

---

## 2. Theme Setting Descriptor (generated, build-time)

The catalogue that drives completion (FR-010a), inline swatches and font samples (FR-010b).

```
ThemeSettingDescriptor
  key            string    dotted path, e.g. "heading.h2.font-color"
  category       string    top-level category, e.g. "heading"
  valueKind      enum      colour | font | measurement | keyword | number | boolean | string
  permittedValues string[] present only when valueKind = keyword
  description    string    prose: what this setting controls
  defaultValue   string?   from the default theme, shown in completion detail
  contributedBy  string?   extension identifier; absent for renderer built-ins (FR-031b)
```

**Derivation** (Principle IV — see research R3):

- `key`, `category`, `valueKind`, `defaultValue` are **generated** from the gem's own
  `base-theme.yml` + `default-theme.yml`, already vendored at
  `packages/asciidoc-pdf/ruby/.wasm-build/vendor/bundle/.../asciidoctor-pdf-2.3.24/data/themes/`.
- `description` and `permittedValues` refinements come from a hand-maintained table keyed by `key`,
  because no machine-readable schema exists upstream.
- `contributedBy` is declared by each extension's manifest (see §4).

**Validation rules**

- Every generated key MUST resolve to exactly one descriptor; duplicates are a build error.
- A descriptor whose `key` no longer exists in the gem's theme files after a version bump MUST fail the
  build rather than silently linger — this is what keeps the catalogue from drifting (FR-009b's
  discipline applied to descriptors).
- No descriptor may be offered that the renderer does not recognise (SC-011).

---

## 3. Project Options Section (UI-only)

```
ProjectOptionsSection
  id            string   URL-addressable slug, e.g. "general" | "rendering" | "pdf" | "extensions" | "danger"
  label         string   display name
  settings      —        the controls it owns
```

**Validation rules**

- Every pre-existing setting appears in exactly one section (FR-002).
- An unknown `id` falls back to the default section rather than erroring (FR-004).
- Sections are a view concern only. **All sections share one `RenderConfig` draft**, and every save
  PUTs the merged whole (FR-006, research R11) — the API is a full replace with no merge path, so
  per-section partial payloads would wipe sibling sections.

---

## 4. Extension Catalogue Entry

```
ExtensionCatalogueEntry
**Defined once, in `packages/shared/src/pdf-extensions/`.** This shape crosses four boundaries —
domain (use case), api (route), web (catalogue UI + theme editor) and asciidoc-pdf (loader) — so
`packages/shared` MUST own it and no other package may redeclare it.

`PdfExtensionManifest` is what an extension file declares; `PdfExtensionCatalogueEntry` is that
manifest plus the state the server resolves. One derives from the other — they are not two shapes.

```
PdfExtensionManifest              // declared by the extension itself
  id             string           stable identifier, e.g. "paragraph-numbering"
  displayName    string
  description    string           what it changes about the output (FR-027)
  targeting      string           block attributes/roles that direct it; empty if document-wide (FR-031a3)
  themeKeys      ThemeKeyDecl[]   { key, valueKind, description, default? } (FR-031b)
  sampleContent  string           AsciiDoc the preview sample must contain (FR-011a)

PdfExtensionCatalogueEntry        // manifest + server-resolved state
  manifest       PdfExtensionManifest
  origin         enum             shipped | administrator-provided
  available      boolean          false when a persisted selection references something no longer offered (FR-030)
```
```

**The shipped twelve** (FR-032a), by delivery tier:

| Tier | id | Notes |
|---|---|---|
| 1 | `paragraph-numbering` | Sequential, pre-render, not persisted; document/section-level paragraphs only (FR-032a4a/b) |
| 1 | `per-chapter-contents` | |
| 1 | `custom-title-page` | Needs a no-logo fallback (open edge case) |
| 1 | `orphaned-heading-avoidance` | Uses `dry_run single_page: true` |
| 2 | `multi-column-sections` | Targeted by block attribute |
| 2 | `large-table-page-size` | May conflict with multi-column (open edge case) |
| 2 | `image-float-wrapping` | |
| 2 | `narrow-contents` | Verify against FR-032a3 — may be theme-only |
| 3 | `auto-license-page` | |
| 3 | `colophon-placement` | |
| 3 | `additional-contents-entries` | |
| 3 | `title-block-document-details` | |

Change bars are deliberately absent (FR-032a5) pending version history — roadmap Phase 12.

**Validation rules**

- `id` is stable and immutable; it is what a persisted selection stores.
- The catalogue is assembled by `GetPdfExtensionCatalogueUseCase` (domain), which reads
  administrator entries through `PdfExtensionSourcePort` (`packages/domain/src/ports/pdf-extensions/`)
  and merges them with the shipped set. The Fastify route delegates and holds no assembly logic.
- A manifest arriving from the administrator's folder is **external input** and MUST be validated at
  the boundary before reaching the use case; a malformed one is reported and excluded (FR-033d).
- Shipped entries MUST be loadable by the canonical CLI toolchain (FR-032f) — plain `-r`-able Ruby, not
  code embedded in the eval'd convert string. Without this the reference build cannot load them and no
  parity test is possible.
- An entry whose effect the sample document cannot demonstrate MUST NOT ship (FR-011a, SC-014b).

---

## 5. Project Extension Selection (new key, existing blob)

Stored inside `project_render_configs.config` — **no migration**.

```
extensions
  enabled  string[]   catalogue entry ids
```

Identifiers only. No code, no paths, no digests — every extension comes from the deployment, so a
project's selection is a list of names and nothing more. This is what makes the stored selection
harmless: it cannot carry anything executable.

**Validation rules**

- Extends the existing `renderConfigSchema`, which is `.strict()` — the new key must be declared there
  or every save fails validation.
- Ordering MUST be deterministic when resolved, so output never depends on load order (FR-031c,
  Principle XII).
- A selection naming an unavailable entry is surfaced, never silently applied or dropped (FR-030) —
  which is the case when an administrator removes an extension a project still has enabled.
- The blocklist discipline of `PINNED_ATTRIBUTE_KEYS` applies unchanged — extensions must not become a
  route to setting pinned attributes.

**State transitions**

```
present in deployment ──owner enables──▶ enabled ──owner disables──▶ disabled
        │                                    │
        └── administrator removes it ────────┴──▶ unavailable (surfaced, not silently dropped)
```

A newly added extension always starts disabled for every project (FR-036), so a deployment change can
never alter an existing project's output on its own.

---

## 5a. PDF Extension Source Port (new domain port)

```
PdfExtensionSourcePort            // packages/domain/src/ports/pdf-extensions/
  list()          → Result<PdfExtensionManifest[], PdfExtensionSourceError>
  readSource(id)  → Result<string, PdfExtensionSourceError>
```

Implemented by a filesystem adapter in
`packages/infrastructure/src/persistence/pdf-extensions/`, reading the administrator's bind-mounted
folder. An in-memory fake lives at `packages/domain/tests/ports/pdf-extensions/`.

**Validation rules**

- The port is the **only** route to that folder; no delivery-layer code reads it directly.
- `list()` never throws on a bad entry — a malformed manifest is excluded and reported (FR-033d), and
  a duplicate id is reported as a conflict rather than resolved silently (FR-033e).
- Errors are typed `Result` values, per the constitution's fallible-operation rule.

---

## 6. Theme Preview Sample (system-provided)

```
ThemePreviewSample
  content   AsciiDoc   fixed, system-authored
```

**Validation rules**

- Never part of the project's file tree; not counted against project storage.
- Exercises everything a theme affects (FR-011) **and** carries content plus targeting markup for every
  shipped extension (FR-011a), so the comparison toggle produces a visible difference for each.
- Must remain a coherent, readable document rather than a fragment catalogue (FR-011b) — it doubles as
  the surface for judging the theme itself.
- Grows whenever the catalogue grows; an extension whose effect it cannot show blocks that extension
  from shipping.

---

## 7. Auxiliary Text Cache (new, client-side — fixes R6)

Not a persisted entity; a client-side cache that closes a live defect.

```
AuxiliaryTextCache
  paths     string[]   theme and .bib paths from the file tree
  contents  Map<path, string>
```

**Why it exists**: `buildSnapshot` sources content from the symbol-index cache, which is populated by
walking the `include::` graph from the main file. **A theme is never reachable that way**, so today a
fresh page load exports with no theme at all, and a collaborator's theme edits never invalidate the
cache (research R6).

**Validation rules**

- Seeded from the file tree, not from include reachability.
- Subscribes to the **unfiltered** `content-changed` stream, so a collaborator's edit invalidates it
  (the `renameRefreshNonce` pattern in `project-editor-layout.tsx` lines 325–338 is the precedent).
- Must be populated before `discoverThemePath` runs, since that function filters paths derived from the
  same map — otherwise the theme's path is invisible regardless of its content.
