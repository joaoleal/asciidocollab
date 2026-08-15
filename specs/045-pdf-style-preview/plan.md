# Implementation Plan: PDF-Look HTML Preview Style ("Print")

**Branch**: `045-pdf-style-preview` | **Date**: 2026-08-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/045-pdf-style-preview/spec.md`

## Summary

Add a third live-preview style, **Print**, that dresses the existing HTML preview in the appearance
the PDF export produces — page geometry, typography, colours and block treatments — driven by the
same theme document the PDF export resolves for the project.

The technical approach is a clean split: a **pure resolver** in `packages/shared` turns theme YAML
into an engine-neutral appearance model (the Asciidoctor-PDF cascade — `extends`, `$variable`
interpolation, arithmetic and units — implemented in TypeScript against the already-generated key
descriptors), and a **thin applier** in `apps/web` projects that model onto CSS custom properties
on the preview container, read by one new stylesheet scoped exactly as the two existing styles are.
The preview renders text with the *same font files* the PDF uses: the project's own WOFF2 fonts
directly, and the gem's built-in catalogue converted to WOFF2 at build time. Fidelity is proven by
comparing the preview against the **reference-build PDF** on measured properties for a small anchor
set, with per-key assertions giving breadth.

Everything else is reuse: the theme is read through the preview's existing `getFiles()` snapshot,
problems are reported through the existing `PdfDiagnostics` surface, and the zoom model is extracted
from the existing PDF preview panel so both panels share one definition.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 22, React 19 / Next.js 15 (App Router)

**Primary Dependencies**: `yaml` (already used by the theme editor) for theme parsing;
`@asciidocollab/shared` (theme descriptors, default theme, render config);
`@asciidocollab/asciidoc-core` (`resolveThemePath`); existing `@asciidocollab/asciidoc-pdf` types for
the diagnostic shape. Build-time: a TTF→WOFF2 conversion step for the gem's font catalogue.

**Storage**: No schema change. `User.previewStyle` is already `String @default("asciidocollab")` in
`packages/db/prisma/schema.prisma` and accepts the new `print` token as-is.

**Testing**: Jest (unit — `packages/shared`, `packages/domain`, `apps/web`), Playwright (e2e), and
the existing `apps/web/e2e/pdf-parity/` reference harness for the fidelity comparison.

**Target Platform**: Browser (the preview is client-side); the API change is limited to accepting a
third token on the existing editor-preferences route.

**Project Type**: Web application in a modular monolith (`apps/` + `packages/`).

**Performance Goals**: No regression against the existing preview styles' typing-to-repaint budget
(SC-006). The budget is not invented here — it is the one
`apps/web/e2e/preview-adaptive-delay.spec.ts` already enforces: keystroke-to-refresh over 5 samples
per document, a 100-line document at ≤ `SMALL_DOCUMENT_TARGET_MS` (200 ms) against a recorded
509 ms baseline, and a 15 000-line document at ≤ its recorded 1059 ms baseline, with the adaptive
delay clamped to `[PREVIEW_ADAPTIVE_MIN_MS, PREVIEW_DEBOUNCE_MS]`. Print must meet those same
thresholds with the same constants; raising one to accommodate Print is a regression, not a pass.
Theme resolution runs once per theme change, not per keystroke — memoised on theme text identity,
the same coalescing the theme editor's preview already uses.

**Constraints**: No outbound network access of any kind, including fonts (Principle X, FR-029). No
wasm VM boot and no PDF render on the Print path (FR-038). Theme content is untrusted input
(Principle IX). Rendered-document styles must not escape the preview container (Principle VI).

**Scale/Scope**: ~336 generated theme keys exist; FR-020 names roughly 50 as in scope. One new
preview style token, one new stylesheet, one new shared module, one extracted zoom control, one
added font family.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — see the second column.*

| Principle | Gate for this feature | Pre-Phase-0 | Post-Phase-1 |
|-----------|----------------------|-------------|--------------|
| I. Clean Code | Resolver and applier are separate, named, documented seams; no copy of the token list beyond the two that already exist | PASS | PASS |
| II. TDD (NON-NEGOTIABLE) | Every task uses the `/tdd` skill; no task splits test from implementation | PASS | PASS |
| III. Seam testing with in-memory fakes | Resolver is pure data-in/data-out — no DOM, no VM, no fixtures on disk needed to unit-test it | PASS | PASS |
| IV. Reuse before rebuild | Theme read via existing `getFiles()`; diagnostics via existing `PdfDiagnostics`; zoom **extracted** from `pdf-preview-panel`, not reimplemented; theme path via existing `resolveThemePath` | PASS | PASS |
| V. Theming via design tokens | The page is deliberately mode-independent (FR-030) — permitted only when *explicitly specified* and *confined* per VI. Both hold. Chrome around the page stays token-driven (FR-031) | PASS | PASS |
| VI. Style isolation | New stylesheet scoped to `.asciidoc-preview-content[data-preview-style="print"]`, identical construction to the existing two; dynamic values arrive as validated custom properties, never as injected CSS text | PASS | PASS |
| VII. Per-user preferences | `print` is a per-user preview-style token; no shared content mutated; no effect on a collaborator's view | PASS | PASS |
| VIII. Editor pipeline integrity | Scroll-sync, sanitization and selection seams are untouched — the style changes presentation only (FR-004) | PASS | PASS |
| IX. Untrusted input (NON-NEGOTIABLE) | Every theme value is parsed to a typed value against its descriptor `valueKind` before reaching CSS; unparseable → rejected + reported | PASS | PASS |
| X. Client-side, no egress (NON-NEGOTIABLE) | Fonts come from the project or the app's own origin only; no CDN, no fetch (FR-029); a theme likewise cannot reach the network (FR-026) | PASS | PASS |
| XI. Reference-build parity (NON-NEGOTIABLE) | Anchor comparison targets the **reference-build PDF**, not the in-app PDF — see research R4. Bar scope argued below | PASS | PASS |
| XII. Deterministic output | Resolution is a pure function of theme text + descriptor table; no clock, no ordering nondeterminism; tolerances stated once and shared by the comparison tests | PASS | PASS |
| XIII. Non-blocking responsiveness | No VM, no render on this path; resolution memoised on theme-text identity so a keystroke burst schedules no work (FR-038) | PASS | PASS |
| XIV. Sandbox-safe dependencies | Only `yaml`, already in use; the font conversion is a build-time step, not a runtime dependency | PASS | PASS |
| XV. Fidelity verified before done | Theme application and fonts are both named as fidelity-critical; both are covered by the anchor comparison against reference output before the feature can be called done | PASS | PASS |

**Gate result**: PASS, no violations to justify. Complexity Tracking is therefore empty and has been
removed.

This table was re-evaluated after an architecture-guard violation scan, which found two P0
cross-package type duplications (blocking rule 4) in the first draft of this plan. Both are resolved
in the design above rather than deferred — see "Type ownership" and the two structure
justifications.

Four constitution points shaped the design rather than merely being satisfied by it:

- **Principle XI — target.** The anchor comparison targets the reference-build PDF rather than the
  in-app one. Comparing against in-app output would chain fidelity through a second artefact and
  edges toward treating in-app output as a baseline, which XI forbids.
- **Principle XI — bar scope.** XI fixes the bar at *element-level style parity* and permits a spec
  to make it only **stricter**, never looser. FR-037 excludes page breaks, running headers and
  footers, page numbering and cross-page placement — so it must be shown that this is not a
  relaxation. It is not: XI's bar is "fonts, spacing, colors, and layout of **each rendered block**",
  which is a per-block measure and does not encompass pagination. The Print style is held to exactly
  that per-block bar, with no per-block property exempted. FR-037 excludes a dimension the bar never
  covered rather than lowering the bar it does. This is recorded here because an unstated judgment on
  a non-waivable principle is how a relaxation later gets adopted by default.
- **Principle V** is why FR-030's mode-independence is stated explicitly in the spec: the principle
  permits a light-only rendered-document surface *only when explicitly specified*, so the spec had to
  say it before the plan could rely on it.
- **Blocking rule 4 (cross-package type duplication)** determined two structural decisions: the
  resolver defines its **own** diagnostic type rather than restating `RenderDiagnostic` (which cannot
  be unified, because `asciidoc-pdf` may depend inward only on `asciidoc-core`), and the preview-style
  token moves to a new zero-dep leaf, `packages/primitives`, that `domain`, `shared` and
  `apps/web` can all reach — the only arrangement in which one definition serves all three. See
  "Type ownership" and the structure justification below.

### Type ownership

| Type | Single home | Consumers | Note |
|------|-------------|-----------|------|
| `AppearanceModel` | `packages/shared/src/print-appearance/` | `apps/web` | New; no prior definition anywhere |
| `AppearanceDiagnostic` | `packages/shared/src/print-appearance/` | `apps/web` (adapter) | Own code union incl. `themeKey`; deliberately **not** `RenderDiagnostic`'s shape |
| `RenderDiagnostic` | `packages/asciidoc-pdf/src/protocol.ts` | `apps/web` | Unchanged — it is that package's wire protocol |
| `PdfDiagnostics` props | `apps/web` | both of the above | Widened to the structural minimum so the component depends on neither package's concrete type |
| Preview-style token | `packages/primitives/src/preview-style.ts` | `domain`, `shared`, `apps/web`, `apps/api` | Consolidated from three copies into a new zero-dep leaf; justified below |
| Preview-style **labels** | `apps/web` | `apps/web` | Presentation, correctly app-owned; deliberately not moved |

### Structure justification — the new `packages/primitives` leaf

A new package is a real cost, so it is justified rather than assumed.

**No existing package can hold the token.** `domain` may depend on nothing but `asciidoc-core`;
`apps/web` does not depend on `domain`; `shared` and `domain` are siblings importing neither. The one
pre-existing package all three reach is `asciidoc-core` — the AsciiDoc **language** kernel, which a
preview-style UI token is not. Placing it there would make it the second non-language rule in that
package and leave its charter describing something it no longer is.

**The package is not for one union.** The same duplication exists today, unfixed, for three closed
value sets both rings must agree on — preview style, editor theme (`editor-theme.ts:5` /
`editor-preferences.dto.ts:6` / `use-editor-preferences.ts:18`), and spellcheck language, whose DTO
comment already admits it "mirrors the domain's `SPELLCHECK_LANGUAGES`". `primitives` is the
home for all three.

**This feature moves only the preview-style token.** The other two are unrelated to 045 and moving
them would balloon the diff; they are recorded in
[contracts/preview-style-token.md](./contracts/preview-style-token.md) as the next tenants so the
package's purpose is legible.

**Charter**: *primitive types and closed value sets that more than one ring must agree on, with no
behaviour attached.* The name is generic because the need is — any leaf type both rings must share
lands in the same bind. Three testable rules keep a generic name from becoming a junk drawer:
**(P1)** zero dependencies, permanently — no `dependencies` block in its `package.json`;
**(P2)** no behaviour — type aliases, `as const` lists and type guards only, so `Result`, classes,
validation and I/O are all excluded; **(P3)** two rings or it does not belong. Under P2 the
`PreviewStyle` value object stays in `domain`; only the union, the list and the guard move.

**Wiring**: added as a `workspace:*` dependency *and* a tsconfig project reference in `domain`,
`shared`, `apps/web` and `apps/api`.

**Enforcement — no new check.** `scripts/ci/architecture-guard.mjs` already checks imports, declared
`dependencies`/`peerDependencies` *and* tsconfig `references` per layer, and already runs in the
quality gate (`scripts/ci/quality.sh:81`). Registering `primitives` in `onion.config.json` with
`"allowedImports": []` makes rule **P1 machine-enforced** by the same mechanism that already holds
`asciidoc-core` at zero dependencies — any workspace dep, project reference or import added later
fails the gate. The exact config diff, what it catches, and the one thing it does not (external npm
dependencies, which the guard skips for *every* layer) are in
[contracts/preview-style-token.md](./contracts/preview-style-token.md). The config change must land
in the same commit as the package: the guard throws on a layer pointing at a missing directory.

### Structure justification — the resolver in `packages/shared`

`shared`'s charter is "DTOs, error types, value objects crossing package boundaries", and the
resolver is larger than anything currently in it. It is placed there deliberately, not by default:

- the data it resolves against (`theme-descriptors.generated.ts`, `default-theme.generated.ts`)
  already lives in `shared`, and separating a resolver from the table it resolves against is exactly
  how the two come to disagree after a gem bump;
- `render-config/resolve.ts` is existing precedent for resolution logic in this package;
- the alternatives are worse: `asciidoc-core` is the AsciiDoc *language* kernel and PDF theme
  semantics are not language; `apps/web` would put ~336 keys of logic in the delivery layer with no
  unit-test seam; `asciidoc-pdf` carries the wasm dependency and `shared` may not import it.

Recorded here so that a future reviewer sees a decision rather than drift.

## Project Structure

### Documentation (this feature)

```text
specs/045-pdf-style-preview/
├── plan.md              # This file
├── research.md          # Phase 0 output — R1..R9 decisions
├── data-model.md        # Phase 1 output — appearance model, token, diagnostics
├── quickstart.md        # Phase 1 output — how to run and verify
├── contracts/           # Phase 1 output — module contracts
│   ├── print-appearance.md
│   ├── preview-style-token.md
│   ├── font-sources.md
│   └── fidelity-oracle.md
├── checklists/
│   └── requirements.md  # Spec quality checklist (complete)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/shared/src/print-appearance/          # NEW — pure resolver (R1, R2, R8)
├── index.ts                                   # public surface
├── parse-theme.ts                             # YAML → raw key map, extends chain
├── resolve-values.ts                          # $var interpolation + arithmetic
├── units.ts                                   # measurements → points; page-size table
├── appearance-model.ts                        # the engine-neutral output type
├── appearance-diagnostic.ts                   # OWN type + code union — NOT a copy of RenderDiagnostic
└── page-sizes.generated.ts                    # NEW generated, alongside theme descriptors

packages/shared/src/render-config/
├── theme-descriptors.generated.ts             # (existing) key → valueKind/default — resolver input
├── default-theme.generated.ts                 # (existing) base of the extends chain
└── config.ts                                  # UNCHANGED — HTML_EXPORT_STYLES stays at two values

packages/primitives/                           # NEW zero-dep leaf package — see justification below
├── package.json                               # no dependencies block, permanently (P1)
├── tsconfig.json
└── src/
    ├── index.ts
    └── preview-style.ts                       # the ONE definition of the style token (+'print')

packages/asciidoc-pdf/
├── assets/fonts/                              # NEW committed — catalogue WOFF2 + licences + manifest.json
└── scripts/generate-catalogue-fonts.mjs       # NEW — TTF→WOFF2 from the gem, on gem bump (R3)

packages/domain/src/value-objects/editor/
└── preview-style.ts                           # value object kept; token list now imported

packages/shared/src/dtos/
└── editor-preferences.dto.ts                  # inline union replaced by the imported type

packages/db/prisma/schema.prisma               # UNCHANGED — String column already admits the token

apps/web/src/
├── styles/print-preview.css                   # NEW — scoped to [data-preview-style="print"]
├── lib/print-preview/
│   ├── appearance-to-css.ts                   # NEW — model → validated custom properties (R6)
│   ├── font-faces.ts                          # NEW — @font-face from the existing asset mechanism
│   ├── to-diagnostic-props.ts                 # NEW — adapter: AppearanceDiagnostic → component props
│   └── resolve-project-theme.ts               # NEW — getFiles snapshot → theme text (R5)
├── hooks/use-print-appearance.ts              # NEW — memoised resolution + diagnostics
├── components/
│   ├── preview-style-control.tsx              # imports the token from primitives; no local copy
│   ├── asciidoc-preview.tsx                   # page frame, zoom, diagnostics wiring
│   ├── preview-zoom-control.tsx               # NEW — extracted from pdf-preview-panel (R7)
│   ├── pdf-preview-panel.tsx                  # now consumes the extracted zoom control
│   └── pdf-diagnostics.tsx                    # props widened to the structural minimum
└── (no new public/fonts — catalogue fonts come from the asciidoc-pdf package)

apps/api/src/routes/auth/me/editor-preferences.ts   # accepts the third token

apps/web/e2e/
├── print-preview.spec.ts                      # NEW — style, zoom, diagnostics, isolation
└── pdf-parity/print-fidelity/                 # NEW — anchor comparison vs reference PDF (R4)
```

**Structure Decision**: The existing modular-monolith layout is used unchanged in shape. The resolver
(`packages/shared/src/print-appearance/`) sits in `shared` because that is where the theme descriptor
table and the vendored default theme already live, and because it must stay importable by both rings
without carrying a browser dependency. **One new package is created** — the zero-dependency leaf
`packages/primitives`, justified above — because it is the only arrangement in which one definition
of the preview-style token serves `domain`, `shared`, `apps/web` and `apps/api`. No existing layer
boundary is crossed: the new leaf sits below everything, `shared` gains a pure module, `apps/web`
gains presentation, and `domain` gives up a duplicated token while keeping its value object.

## Phase Sequencing

The user stories are both P1, but they are not independent in build order — US2 (theme application)
needs the resolver that US1's page frame already depends on for its geometry. The sequence below
delivers a demonstrable slice at each step.

0. **Token consolidation** — create `packages/primitives`, move the style union into it, delete the
   three existing definitions, wire the dependency and tsconfig reference in `domain`, `shared`,
   `apps/web` and `apps/api`, and register the layer in `onion.config.json` (same commit) so the
   existing architecture guard enforces its zero-dependency rule. A pure refactor with no behaviour
   change, done first so step 1 adds `print` in one place instead of three. Verified by
   `pnpm run architecture` alongside the usual gates. (Blocking rule 4)
1. **Token and control** — `print` accepted end to end, style selectable and remembered. Renders
   with default appearance only. (FR-001–FR-009)
2. **Resolver** — theme YAML → appearance model, with the breadth assertions. No UI. (FR-018–FR-025)
3. **Page frame and zoom** — geometry from the model, extracted zoom control. (FR-010–FR-017)
4. **Appearance application** — the ~50 keys of FR-020 reaching the page. (FR-019–FR-021, FR-026,
   FR-030–FR-031)
5. **Fonts** — catalogue conversion, project fonts, fallback. (FR-027–FR-029)
6. **Diagnostics** — the three problem classes through the existing surface. (FR-032–FR-036)
7. **Fidelity gate** — anchor comparison against reference PDFs. (SC-002, SC-003; Principles XI/XV)

Step 7 is not optional polish: under Principle XV the feature is **not done** without it.
