# Phase 0 Research: PDF-Look HTML Preview Style ("Print")

**Feature**: 045-pdf-style-preview | **Date**: 2026-08-09

Every unknown in the plan's Technical Context is resolved below. Each entry states the decision, why
it was chosen, and what was rejected.

---

## R1. Where the theme→appearance mapping lives

**Decision**: A new pure module `packages/shared/src/print-appearance/` that turns theme YAML into a
resolved, engine-neutral **appearance model** (plain data). `apps/web` owns the separate step of
turning that model into CSS custom properties on the preview container.

**Rationale**:

- `packages/shared` already owns everything about themes that both rings need — the generated
  descriptors, the verbatim default theme, and the render-config resolver. Putting the resolution
  next to `theme-descriptors.generated.ts` and `default-theme.generated.ts` means the resolver and
  the key catalogue it resolves against cannot drift.
- The resolution is pure data-in/data-out, so it is unit-testable without a DOM, a browser, or the
  wasm VM — which is what makes R4's breadth assertions cheap.
- Splitting *resolve* (shared, pure) from *apply* (web, CSS) keeps the CSS-injection boundary
  (R6) in exactly one place instead of smeared through the resolver.

**Alternatives rejected**:

- *`packages/asciidoc-core`* — it is the zero-dependency AsciiDoc **language** kernel. Asciidoctor-PDF
  theme semantics are a renderer concern, not language, and the package's charter is narrow.
- *`apps/web` only* — would put ~336 theme keys of logic in the delivery layer with no unit-test seam
  and no way to share it if the HTML export later adopts the style (the deferred Out-of-Scope item).
- *`packages/asciidoc-pdf`* — it is a browser-only capability package wrapping the wasm VM; the
  resolver must not carry that dependency, and `shared` may not depend on it.

---

## R2. Resolving a theme to effective values

**Decision**: Implement the Asciidoctor-PDF theme cascade in TypeScript, over four stages:
`extends` chain → key flattening → `$variable` interpolation → value parsing (units, colours,
arithmetic). The gem's own `default-theme.yml` (already vendored verbatim as `DEFAULT_THEME_YAML`)
is the base of the chain.

**Rationale**:

- The vendored default theme proves the cascade is non-trivial and cannot be skipped. Real values in
  it include `$base_line_height_length / 10.5`, `round($base_font_size * 1.25)`, `$base_font_size *
  0.75`, `$codespan_font_family`, `0.5in`, `1.2em`, `[0.5in, 0.67in, 0.67in, 0.67in]`. A naive
  "read the key" lookup returns the literal string `$base_font_size_large` for `role.lead.font_size`
  and would silently produce nonsense.
- The generated descriptors already record each key's `valueKind` (`colour`, `measurement`,
  `keyword`, `string`) and its `defaultValue` — including the `$…` forms. That is exactly the table
  a resolver needs, and it regenerates with the gem, so a gem bump cannot leave the resolver behind.
- Both `snake_case` (theme file, e.g. `font_color`) and `dash-case` (descriptor keys, e.g.
  `base.font-color`) appear; the resolver normalises to one form, and which one is a contract
  decision recorded in `contracts/`.

**Scope bound**: the resolver implements only the arithmetic and unit forms the gem's own default
theme and the project's fixtures actually use (`+ - * /`, `round()`, `in`/`mm`/`pt`/`em`/bare
number, array measurements). Anything else is an unresolvable value → the key is rejected per FR-025
and reported per FR-032, never silently guessed.

**Alternatives rejected**:

- *Ask the Ruby VM to resolve the theme* — the gem would give a perfect answer, but it means booting
  the wasm VM for an HTML preview. That contradicts FR-038 (no PDF render), risks Principle XIII
  (the VM is heavy and, per prior findings, must never be run concurrently with another render), and
  makes the preview's first paint depend on a multi-second warm-up.
- *Only support literal values, ignore `$refs`* — would break `role.lead`, `kbd`, `vertical_rhythm`
  and every key whose default is derived, i.e. most of the theme.

**Risk**: this is the largest and least certain piece of the feature. Mitigation is R4's breadth
oracle — every key claimed as supported is asserted — plus fixture-level resolution tests against
themes already in the repo (`showcase-theme.yml`, `brand-theme.yml`, the parity fixtures' themes).

---

## R3. Typefaces

**Decision**: Three sources, in priority order.

1. **Project fonts** — the project's own `.woff2` files, served to the preview from project storage
   and declared as `@font-face` under the family name the theme's font catalogue gives them. No
   conversion: they are already WOFF2, which is what the browser wants. (The PDF pipeline converts
   the other way, WOFF2→TTF, because prawn cannot read WOFF2.)
2. **Built-in catalogue** — the gem's own subsetted faces, converted to WOFF2 and **published by
   `packages/asciidoc-pdf` as committed assets** (see below), served from the application's own
   origin. **Every catalogue family the gem's default theme references is converted**, including
   `Noto Serif` — see the note below on why the app's existing `next/font` copy does not count.

**Why `next/font`'s Noto Serif is not the catalogue font**: `apps/web/src/app/layout.tsx:14` loads
`Noto_Serif` from `next/font/google`. That is self-hosted at build time, so it raises no egress
concern — but it is a *different build of the family* from the gem's subsetted face, and this
feature's whole claim rests on metrics. Reusing it would be exactly the alternative rejected at the
bottom of this section ("pulling full Google families instead of the gem's subsets"), admitted
through the side door because the app happens to have one already. It also puts the fidelity of the
**default** theme — the appearance every project with no theme of its own gets — on the one font
path never compared against the gem's own file. The existing `next/font` copy keeps serving the
`asciidoctor` preview style, which is what it was added for; the Print style reads the catalogue.

The families to convert are therefore whichever the gem's default theme names, determined by reading
`default-theme.generated.ts`'s font catalogue rather than by guessing — `M+ 1mn` (4 faces, ~227 KB
as TTF, materially less as WOFF2) and `Noto Serif` at minimum. A family is dropped from the set only
by showing the default theme cannot reference it, never by a fixture failing to exercise it: the
anchor set is small by design (R4), so "no fixture reached it" is not evidence of unreachability.
3. **Fallback** — a same-classification stack, reported per FR-032. Exception path only.

**Rationale**: same glyphs and same metrics is the only way FR-011's page geometry and SC-003's
one-character line-length bound mean anything. Converting the gem's *subsets* (rather than pulling
full families) also guarantees the browser and the PDF have identical glyph coverage, so a glyph
missing in the PDF is missing in the preview too, rather than the preview flattering the output.

**Where the catalogue fonts come from, and why not straight from the gem**: the gem's font directory
lives at `packages/asciidoc-pdf/ruby/.wasm-build/vendor/bundle/…/data/fonts/`, which is **gitignored**
(`packages/asciidoc-pdf/ruby/.gitignore:9`). It is build output, not a published surface. An
`apps/web` build step reading it would (a) reach into another package's internals rather than a
public interface, and (b) produce nothing at all on a clean checkout where the wasm build has not
run — a silent, environment-dependent difference in what the preview looks like.

So the conversion is owned by `packages/asciidoc-pdf`, which already owns the gem:

- a generator script in that package converts the gem's TTF subsets to WOFF2 **into a committed
  directory it publishes** (`packages/asciidoc-pdf/assets/fonts/`), run on a gem bump exactly as
  `generate:theme-descriptors` is;
- alongside them a committed `manifest.json` recording the **gem version** and a **content hash per
  face**, so the assets are content-addressed and a stale or hand-edited font is detectable;
- a CI check regenerates and compares, so the committed assets cannot drift from the gem;
- `apps/web` consumes the package's published path. It never reads `.wasm-build`.

This keeps Principle XII (deterministic, content-addressed generated assets) true rather than
assumed, and keeps the dependency pointing at a public surface.

**Licensing**: the gem's font directory carries `LICENSE-noto`, `LICENSE-mplus` and per-family
`ABOUT-*` files. These MUST be committed alongside the converted WOFF2s in the published directory.

**Alternatives rejected**: substitution by classification (line lengths cannot match — this is the
question the spec's Q1 settled); pulling the families from a CDN (Principle X, no egress); pulling
full Google families instead of the gem's subsets (different glyph coverage, so preview and PDF
would disagree about which characters render) — **including via the app's existing `next/font`
Noto Serif**, which is the same rejected alternative wearing a local URL; and scoping the conversion
to whichever families a fixture happens to exercise (the anchor set is deliberately small, so that
would let an unconverted family ship undetected behind a passing suite).

**Open risk**: WOFF2 is a lossless repackaging of the same sfnt, so metrics are preserved — but the
browser's shaping and the PDF's are different engines. SC-003's "within one character" is the
tolerance that absorbs this, and R4's anchor comparison is where it gets proven rather than assumed.

---

## R4. The fidelity oracle

**Decision**: Two oracles, per the spec's Q2, with one refinement.

- **Anchor comparison (depth)** — for a small fixture set, compare the preview against the
  **reference-build PDF** (the one `generate-reference.mjs` produces from the canonical gem), not
  against the in-app PDF. Compared properties: resolved font family, font size and colour per
  construct; page-column content width and insets; and the character position at which a full line
  of body text breaks.
- **Theme-key assertions (breadth)** — for every key listed in FR-020, a unit-level assertion that
  the resolver produces the expected effective value and the applier surfaces it.

**Rationale**: Principle XI names the canonical toolchain as the single source of truth for
appearance and forbids treating in-app output as a baseline. Comparing the preview against the
in-app PDF would chain fidelity through a second artefact; comparing against the reference PDF is
both stricter and a direct reading of the principle. The reference PDFs and their generator already
exist in `apps/web/e2e/pdf-parity/`, so this reuses machinery rather than building it.

**Extraction approach**: `harness/pdftools.ts` already wraps pdf.js and poppler for the existing ink
comparison. Per-run font name and size come from pdf.js `getTextContent()` with styles; text colour
requires reading the fill colour from the operator list. Colour extraction is the one genuinely new
piece — if it proves unreliable, the fallback is to assert colour through the existing ink-map
comparison at a coarse tolerance and keep font/size/geometry exact.

**Alternatives rejected**: pixel/screenshot diffing of preview against PDF (the preview is
unpaginated and the rasterisers differ — noise, not signal); snapshotting the preview against itself
(explicitly not a comparison test under Principle XV).

---

## R5. Where the theme comes from, and how it stays live

**Decision**: Reuse the preview's existing `getFiles()` / `filesVersion` seam. `resolveThemePath()`
from `@asciidocollab/asciidoc-core` picks the theme path from the snapshot's text paths (honouring
an explicit project selection); the theme text is read from the same snapshot; `filesVersion` is
already bumped when a reachable file changes under a collaborator's edit.

**Rationale**: this is the reuse the constitution asks for (Principle IV) and it is the *same*
resolution rule the PDF export uses, which is precisely what FR-018 requires. No new subscription,
no new server call, and FR-024's live update falls out of a signal that already exists.

**To verify during implementation**: `filesVersion` currently bumps for *reachable included* files.
The theme is not an include, so the first task in this area must confirm the theme file is covered
by that signal and, if not, widen it — this is a known, named risk rather than an assumption.

---

## R6. Applying the appearance without breaking style isolation

**Decision**: A static stylesheet scoped to `.asciidoc-preview-content[data-preview-style="print"]`
that reads **CSS custom properties**, plus a per-render inline `style` attribute on that container
carrying the resolved values. Every value is validated against its descriptor `valueKind` before it
is written, and anything that fails validation is dropped and reported (FR-025, FR-032).

**Rationale**:

- Matches the two existing styles' scoping model exactly (`data-preview-style` attribute), so
  Principle VI holds by the same construction that already holds for them, and switching styles
  cannot leave residue.
- Custom properties on the container are the only mechanism that lets ~50 dynamic values reach a
  static stylesheet without generating or injecting a stylesheet per keystroke.
- Theme content is untrusted (Principle IX). A colour is emitted only after parsing to a
  colour; a measurement only after parsing to a number plus a known unit. A raw theme string is
  never concatenated into CSS. This is what stops `font-color: red; } body { …` from escaping the
  container.

**Also required by Principle V**: the page and its content are deliberately mode-independent
(FR-030), which the principle permits *only* when explicitly specified and confined per Principle
VI — both conditions are met. The chrome around the page stays token-driven (FR-031).

**Alternatives rejected**: Shadow DOM (would sever the existing scroll-sync, selection, review-rail
and browser-find behaviours FR-004 requires preserving); generating a `<style>` element per render
(re-parse cost per keystroke, and a string-concatenation injection surface).

---

## R7. Zoom

**Decision**: Extract the zoom model already implemented in `pdf-preview-panel.tsx` — fit-to-width
default, presets 75/100/125/150/200%, clamps 0.25×–4× — into a shared control/hook and use it from
both panels.

**Rationale**: FR-015 requires "the same default, the same presets and the same limits", which a
second implementation would immediately start drifting from. Extraction (rather than copy) is
Principle IV, and it makes the requirement structurally true rather than merely tested.

**Note**: the PDF panel re-renders pages at the settled scale after a debounce because pdf.js
rasterises; the Print style has no such need — CSS scaling of live DOM is exact at any zoom. Only
the *state model and control* are shared, not the repaint machinery.

---

## R8. Units and page geometry

**Decision**: Resolve all measurements to PDF points, then convert once, at the boundary, at
96/72 = 4/3 px per pt. Named page sizes come from a table generated alongside the theme descriptors
so a gem bump cannot leave it stale.

**Rationale**: keeping one internal unit (pt) means the resolver's arithmetic matches the gem's
arithmetic exactly, and only the applier deals in CSS pixels. Doing the conversion per-key instead
would round in dozens of places and drift from the PDF.

---

## R9. Preview-style token

**Decision**: Consolidate the token union into a **new zero-dependency package**,
`packages/primitives`, then add `print` there. The Prisma column is already a free `String` with
a default, so **no migration is required**. `HTML_EXPORT_STYLES` in
`packages/shared/src/render-config/config.ts` is deliberately left at two values (Out of Scope).

**Rationale**: the union is currently defined three times — `domain`'s value object, `shared`'s DTO,
and the web control — two of them in packages, which the Architecture Constitution blocks at P0
(rule 4, cross-package type duplication). Adding a third value to three hand-maintained lists would
widen a violation this repo has already been bitten by once (the theme-filename rule that
`asciidoc-core/src/theme-file.ts` exists to de-duplicate).

No existing package can hold one definition: `domain` may depend on nothing but `asciidoc-core`,
`apps/web` does not depend on `domain`, and `shared`/`domain` are siblings importing neither. The one
package all three reach is `asciidoc-core` — the AsciiDoc *language* kernel, which a UI preference
token is not.

The package is not for one union: the identical duplication exists today for the editor theme and
the spellcheck language, the latter with a DTO comment admitting it "mirrors the domain's
`SPELLCHECK_LANGUAGES`". `primitives` is the home for all three; **this feature moves only the
preview-style token**, the one it touches.

Principle VII is satisfied unchanged — this stays a per-user preference and touches no shared
content.

**Alternatives rejected**: *token in `asciidoc-core`* (would make it the second non-language rule in
a package chartered as a language kernel); *`shared` imports `domain`* (one definition, but drags the
domain package into the browser bundle, which `apps/web` deliberately avoids); *two copies plus an
equivalence test* (catches drift, but rule 4 is about definition, so the violation would stand).

**Watch-out**: the new package needs a `workspace:*` dependency **and** a tsconfig project reference
in every consumer — this repo's first-party architecture guard checks declared deps and tsconfig
references, not just import specifiers. Existing tests asserting "exactly two styles" will fail until
updated; that is the correct signal, not a test to weaken.

---

## Summary of residual risk

| Risk | Where it bites | Mitigation |
|------|----------------|------------|
| Theme cascade (`$refs`, arithmetic) is larger than estimated | R2 | Breadth assertions per key; scope bound to forms the gem's own theme uses; unresolvable → reject + report |
| Text colour extraction from the reference PDF | R4 | Fall back to coarse ink comparison for colour; keep font/size/geometry exact |
| `filesVersion` may not cover the theme file | R5 | First task in that area verifies and widens if needed |
| Browser vs PDF shaping differences | R3 | SC-003's one-character tolerance; proven by anchor comparison, not assumed |
