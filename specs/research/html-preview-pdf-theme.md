# Can the HTML preview be styled from the project's PDF theme?

Read-only investigation. No application code was changed. Every claim below is grounded in a file that
was read; `file:line` citations are given for the load-bearing ones. Where something could not be
determined from the repository it is stated as an open question rather than guessed at.

---

## Answer

**Yes, but only in one of the two forms people mean by it.** A pure translator can read the project's
own theme YAML and emit CSS for the existing HTML preview, and the *styling* half of the theme
transfers with very little loss: the theme's measurement model is already CSS's (points, and `px` at
exactly 96 dpi — `measurements.rb:27-50` in the vendored gem), colours are hex or CMYK and the repo
already has a colour→CSS converter, the ~315 recognised theme keys are already enumerated
machine-readably in `packages/shared/src/render-config/theme-descriptors.generated.ts`, and the same
font *bytes* the PDF embeds can be handed to the browser as `@font-face` faces. What does **not**
transfer is everything that exists because the PDF has *pages*: pagination itself, running
headers/footers and their `{page-number}` templates, the title page's `top: 55%` positioning,
recto/verso margins, chapter/part breaks, `min-height-after`/keep-together, and the dry-run-driven
layout the engine performs to honour them. So the honest deliverable is **"the project's typography
and palette, live, at web-preview cost"** — not "the PDF, cheaply". Anything sold as the latter will
be found out the first time a reviewer asks where page 3 ends.

---

## Evidence base

The claims below come from reading, in the working tree at branch `043-preview-responsiveness`:

| Area | Files |
| --- | --- |
| Theme identity & discovery | `packages/asciidoc-core/src/theme-file.ts`, `apps/web/src/lib/pdf/build-project-snapshot.ts` |
| Theme key schema | `packages/shared/src/render-config/theme-descriptors.generated.ts`, `theme-descriptor-types.ts`, `theme-catalogue.ts`, `packages/shared/scripts/generate-theme-descriptors.mjs` |
| The default theme, verbatim | `packages/shared/src/render-config/default-theme.generated.ts` |
| A real project theme | `apps/api/data/demo-project/theme/showcase-theme.yml` (210 lines), plus 13 fixture themes under `apps/web/e2e/pdf-parity/fixtures/` |
| Theme semantics (upstream) | `packages/asciidoc-pdf/ruby/.wasm-build/…/asciidoctor-pdf-2.3.24/lib/asciidoctor/pdf/theme_loader.rb` (327 lines), `…/measurements.rb` |
| Theme editing in the app | `apps/web/src/components/theme-editor/use-theme-preview.ts`, `apps/web/src/lib/codemirror/theme/{theme-yaml,theme-value-widgets,theme-diagnostics}.ts` |
| Fonts | `apps/web/src/hooks/use-project-asset-cache.ts`, `apps/web/src/lib/pdf/collect-referenced-assets.ts`, `apps/web/src/lib/pdf/fetch-project-asset.ts`, `packages/asciidoc-pdf/src/pipeline/stages/mount-assets.ts` |
| Web preview surface | `apps/web/src/components/asciidoc-preview.tsx`, `apps/web/src/components/preview-style-control.tsx`, `apps/web/src/styles/asciidoctor-style.generated.css` |
| Cost | `specs/043-preview-responsiveness/baseline.md`, `packages/asciidoc-pdf/src/vm/ruby-pdf-vm.ts`, `apps/web/src/lib/editor-config.ts` |
| Layering | `onion.config.json`, `scripts/ci/architecture-guard.mjs` |
| Deployment policy | `docker/Caddyfile` |

---

## 1. What the PDF theme actually provides

### How a theme is found

A theme is any project file whose name matches `*-theme.{yml,yaml}`, decided by **filename alone** —
contents are never sniffed (`packages/asciidoc-core/src/theme-file.ts:39`). Which theme a project
renders with is `resolveThemePath(declared, textPaths)` — an explicit `:pdf-theme:` if the project set
one, otherwise the first matching file in sorted order
(`packages/asciidoc-core/src/theme-file.ts:68`). This rule lives in the zero-dependency
`asciidoc-core` leaf precisely so the browser ring and the server ring cannot disagree about it, and
it is re-exported from `@asciidocollab/shared` (`packages/shared/src/render-config/index.ts:23`). A
translator would call exactly this function, so an HTML preview and the PDF could never style
themselves from different files.

The snapshot builder already does the sandbox-validated version of this and puts the resolved path on
the render snapshot (`apps/web/src/lib/pdf/build-project-snapshot.ts`, `discoverThemePath`), and the
theme's *text* is already in the browser — it is an editor-live text file in the snapshot's `files`
map. **No new fetch is needed to obtain the theme.**

### What is in it

A theme is a nested YAML mapping. The repo already carries a machine-readable schema for it:
`GENERATED_THEME_DESCRIPTORS` holds **315 keys**, each with a `valueKind` and, where the gem's own
theme sets one, a `defaultValue`. Counted by kind:

| kind | count |
| --- | --- |
| `measurement` | 132 |
| `string` | 69 |
| `colour` | 56 |
| `keyword` | 45 |
| `font` | 11 |
| `number` | 2 |

Grouped by category the largest are `title-page` (42), `table` (24), `heading` (19), `base` (16),
`abstract` (14), `code` (13), `page` (12), `admonition` (11). Two more keys come from
`extension-theme-keys.ts` for enabled converter extensions, and `extends` is added by hand
(`theme-catalogue.ts:43`) because neither of the gem's own themes uses it.

This catalogue is *derived*, not hand-written: `generate-theme-descriptors.mjs` reads the gem's
`base-theme.yml`, `default-theme.yml`, **and** every `@theme.<key>` the converter's Ruby actually
reads — the third source added 138 keys that appear in no YAML file at all. That matters for a
translator: it means the list of things a theme *can* say is already known to TypeScript, and a
mapping table can be checked against it by a test (the descriptions table already is).

`canonicalThemeKey` (`theme-catalogue.ts:27`) reduces any spelling — nested, dotted, hyphenated,
underscored — to the flat lowercase form the renderer compares on. Themes in this repo mix all of
them: the demo theme writes `heading: { h2: { font-size: 20 } }`, the default theme writes
`heading: { h2_font_size: … }`, and both are the same key.

### The theme *language*, which is the hard part

A theme file is not a flat bag of values. From `default-theme.generated.ts` and the gem's
`theme_loader.rb`:

- **`extends`** — a theme normally opens with `extends: default` (all 13 parity fixtures and the demo
  theme do). It accepts a scalar or a list, names may carry a `!`/`-` prefix, and it also accepts a
  **path** to another theme file (`theme-catalogue.ts:38-41` documents exactly this, which is why
  `extends` is typed `string` and not a keyword).
- **Variable references** — `$base_font_size`, `$vertical_rhythm`, `$heading_font_color`.
  `VariableRx = /\$([a-z0-9_-]+)/` (`theme_loader.rb:21`).
- **Arithmetic** — `$base_font_size * 1.25`, `$vertical_rhythm / 3.0`,
  `$horizontal_rhythm + $quote_border_left_width / 2`, and `^` for exponentiation
  (`theme_loader.rb:24-25`).
- **Precision functions** — `round(…)`, `floor(…)`, `ceil(…)` (`theme_loader.rb:26`).
- **Inset arrays** — `padding: [8, 10, 8, 10]`, `margin: [0.85in, 0.8in, 0.9in, 0.8in]`.
- **Units** — `in`, `mm`, `cm`, `pt`, `px`, `pc`; bare numbers are points; and **`px` is exactly
  `× 0.75`, "assuming canvas of 96 dpi"** (`measurements.rb:41-43`). This is the same conversion CSS
  uses, which is the single most encouraging fact in this investigation.
- **Colours** — bare `RRGGBB`, `#RRGGBB`, 3/4/8-digit hex, `transparent`, and CMYK arrays. The
  loader has a quoting hack for hex entries (`HexColorEntryRx`, `theme_loader.rb:23`) because
  unquoted `#000000` is a YAML comment.
- **Font catalogue** — `font.catalog.<Family>.{normal,bold,italic,bold_italic}` → file names,
  optionally with `merge: true`. See `apps/web/e2e/pdf-parity/fixtures/theme-fonts/source/theme/brand-theme.yml`.
- **Markup in string values** — `menu.caret-content` is
  `" <font size=\"1.15em\" color=\"#B12146\">›</font> "`; `button.content` is `"[ %s ]"` with thin
  spaces. These are prawn inline markup and `%s` templates, not CSS.

A concrete, project-authored example is `apps/api/data/demo-project/theme/showcase-theme.yml`:
`extends: default` plus `page`, `base`, `prose`, `heading` (h2/h3/h4), `link`, `list.marker`,
`codespan`, `code`, `conum`, `quote`, `sidebar`, `example`, `admonition`, `table`, `image`, `caption`,
`thematic-break`, `kbd`, `button`, `footnotes`, `title-page`, `toc`, `footer`. Overwhelmingly colours,
font sizes, paddings and borders — i.e. **the part that maps**.

---

## 2. The three-way split

### Maps cleanly

These have a direct CSS counterpart, and the Asciidoctor HTML5 DOM already carries the class needed to
target them (`.paragraph`, `.listingblock`, `.sidebarblock`, `.exampleblock`, `.admonitionblock`,
`.quoteblock`, `.verseblock`, `.literalblock`, `.imageblock`, `.tableblock`, `.olist/.ulist/.dlist`,
`.colist`, `.title`, `.attribution`, `#toc`, `.footnote` — all present in the vendored stylesheet at
`apps/web/src/styles/vendor/asciidoctor-default.css`).

| Theme key family | CSS |
| --- | --- |
| `base.font-color`, `base.font-size`, `base.line-height`, `base.font-style`, `base.text-align` | `color`, `font-size: <n>pt`, unitless `line-height`, `font-style`/`font-weight`, `text-align` |
| `base.border-color/-width/-radius` | `border-color`, `border-width`, `border-radius` |
| `heading.h1..h6-font-size`, `heading.font-color`, `heading.font-style`, `heading.line-height`, `heading.margin-top/-bottom`, `heading.text-align` | `h1…h6` rules |
| `link.font-color`, `link.text-decoration` | `a { color; text-decoration }` |
| `code.*`, `codespan.*` (colour, family, size, line-height, padding, background, border, radius) | `.listingblock pre`, `code` |
| `quote.*`, `verse.*` incl. `border-left-width`, `cite.*` | `.quoteblock`, `.attribution` |
| `sidebar.*`, `example.*`, `admonition.column-rule-*`, `admonition.label.*` | matching block classes |
| `table.*` — border/grid colour+width, `cell.padding`, `head.background-color`, `head.font-style`, `body.stripe-background-color`, `foot.background-color` | `table`, `th`, `td`, `tr:nth-child(even)` |
| `list.indent`, `list.item-spacing`, `list.marker.font-color`, `description-list.*` | `ul/ol/dl` padding + `::marker` |
| `thematic-break.border-*` | `hr` |
| `caption.font-size/-style/-align`, `footnotes.font-size` | `.title`, `#footnotes` |
| `role.<name>.*` (`lead`, `big`, `small`, `underline`, `line-through`, `subtitle`) | `.lead`, `.big`, … — AsciiDoc roles become HTML classes verbatim |
| `page.background-color` | the preview container's `background-color` |
| `image.align` | `.imageblock` alignment |
| `base.text-transform` / `*.text-transform` | `text-transform` |
| `font.catalog.<Family>.*` | `@font-face` — see §4 |

Roughly 55–65% of the keys a real theme *sets* (as opposed to the 315 it *could*) fall here. Every
key the demo theme sets except `page.margin`, `page.size`, `title-page.*` and `footer.*` is in this
column.

The measurement story is why this column is as large as it is: bare numbers are points, CSS accepts
`pt`, and `px` means the same thing on both sides (`measurements.rb:43`, and CSS's own 1px = 0.75pt at
96 dpi). No fudge factor is needed.

### Maps approximately — usable, but say so

| Theme key | What CSS can do | What is lost |
| --- | --- | --- |
| `page.size`, `page.margin` | a fixed-width centred column of width `page_width − left − right`, with matching horizontal padding | the *measure* (line length) is right, so line breaks land near where the PDF's do; **the page boundaries do not exist** |
| `base.text-align: justify` | `text-align: justify` | the browser's justification and prawn's are different algorithms; word spacing will differ visibly on short lines |
| `base.hyphens` | `hyphens: auto` | different dictionaries, different break points |
| `base.font-size-min`, `base.line-height-length` | usable to compute derived sizes | these exist to feed the engine's auto-fit/scaling logic, which has no CSS analogue |
| `block.margin-bottom`, `prose.margin-bottom`, `vertical_rhythm` | `margin-bottom` | CSS margin collapsing changes the resulting rhythm; prawn does not collapse |
| `code.line-gap`, `codespan.background-color` | inline `background-color` | prawn's inline background uses `line_gap` to control how the box is drawn across lines; CSS inline backgrounds break at line ends differently |
| `toc.dot-leader.*`, `toc.indent`, `toc.line-height` | leader dots via a border/gradient trick | the leaders align to page-number columns that do not exist |
| `admonition.icon.*` | an icon column | the PDF draws glyphs from an icon font it embeds; the HTML preview has its own admonition presentation |
| `conum.glyphs`, `conum.font-*` | styled callout numbers | the circled digits come from the embedded M+ 1mn subset (see §4); the browser needs that face or a different glyph source |
| `page.columns`, `page.column-gap`, `index.columns` | CSS multi-column | CSS columns are viewport-bound, not page-bound; balancing differs |
| `image.width`, `admonition.image-width` in pt | `width: <n>pt` | fine in isolation; interacts with the missing page box |
| `caption.align` / `caption.text-align` | `text-align` | caption *placement* (above/below) is a converter decision, not a theme one, and the two converters differ |

### Cannot map — it would be a lie to promise these

- **Pagination.** There are no pages in an HTML flow. `@page` affects printing only, and even then a
  browser's print pagination is not asciidoctor-pdf's.
- **Running content.** `footer.recto.right.content: '{page-number}'`, `footer.verso.left.content`,
  `header.*`, `running-content.start-at`, `page.numbering.start-at`. These are per-page templates
  evaluated against a page number. Nothing to bind them to.
- **Recto/verso.** `page.margin-inner`, `page.margin-outer` (prepress media) — meaningless without a
  spread.
- **Page furniture and modes.** `page.layout`, `page.mode`, `page.initial-zoom`, `page.margin-rotated`.
- **Structural breaks.** `heading.chapter-break-before`, `heading.part-break-before/-after`,
  `heading.margin-page-top`, `heading.min-height-after`, `block.anchor-top`. These are
  keep-together/orphan-control instructions; they are the reason the engine performs **dry runs**,
  which are 12% of a small render and 19% of a large one (`specs/043-preview-responsiveness/baseline.md`
  §"dry runs": 168 ms of 1,356 ms at 100 lines, 1,263 ms of 6,505 ms at 1,500).
- **The title page.** `title-page.*` is 42 of the 315 keys and is positioned in *page percentages* —
  `title.top: 55%`, `logo.top: 10%`. Without a page, 55% of what? The HTML preview does not emit a
  title page at all.
- **Footnote placement.** In the PDF footnotes sit at the bottom of the page or the end of the
  chapter; the HTML converter emits a single `#footnotes` block at the end of the document.
- **Font subsetting and fallbacks.** `font.fallbacks`, `base.font-kerning`, and the engine's
  subsetting behaviour. A browser applies its own fallback chain and its own kerning defaults.
- **Exact line breaking.** Even with byte-identical fonts (§4), prawn and the browser break lines
  differently. Same glyphs and advance widths, different algorithm. A paragraph will occupy about the
  same space; it will not break in the same places.
- **`extends: <path>`** to a theme file outside the project, and gem-bundled variants other than
  `default`/`base` (`default-for-print`, `default-sans`, `default-with-font-fallbacks`, plus four
  `extends`-only variants) — these are inside the gitignored wasm build, not in the repository (see
  §3, "the `extends` gap").

There is also a **document-model** difference underneath all of this that no theme mapping can close:
the HTML backend and the PDF backend do not produce the same document. Different converters, different
caption placement, no title page, a different TOC. This branch already carries a
`render-equivalence` contract (`specs/043-preview-responsiveness/contracts/render-equivalence.md`)
and a `pdf-parity` harness that compares *structurally* rather than byte- or pixel-identically —
which is the right posture and the one this feature would have to adopt too.

---

## 3. Where the mapping would live

### What the guard permits

`onion.config.json` declares the layers and their allowed imports:

```
asciidoc-core → (nothing)
shared        → asciidoc-core
asciidoc-pdf  → asciidoc-core
web           → shared, asciidoc-core, asciidoc-pdf
```

`scripts/ci/architecture-guard.mjs` enforces this on imports **and** on declared `dependencies` /
`peerDependencies` / tsconfig `references` (`checkDeclarations`, line 228 onwards). Third-party
packages are not restricted by the guard at all — only workspace packages are mapped to layers.

### Recommendation: `packages/shared/src/render-config/theme-to-css.ts`

Signature roughly:

```ts
export function themeToCss(theme: unknown, options: ThemeCssOptions): string;
```

taking an **already-parsed** YAML object, not text. Reasons:

1. **It belongs next to the catalogue it must agree with.** The mapping table has to stay in step with
   `GENERATED_THEME_DESCRIPTORS`; the same "every entry names a key the gem actually has" test that
   already guards `theme-descriptions.ts` extends to it for free. Put the translator anywhere else and
   that check becomes a cross-package import or is silently dropped.
2. **`shared` is already the theme-knowledge layer.** `DEFAULT_THEME_YAML`, `canonicalThemeKey`,
   `THEME_SETTINGS`, `extensionThemeSettings` and the re-exported `resolveThemePath` are all here.
3. **Taking a parsed object keeps `shared` free of a runtime YAML dependency.** `yaml` is currently a
   **devDependency** of `shared` (`packages/shared/package.json:20`, used only by the generator
   script), while `apps/web` has it as a **runtime** dependency (`apps/web/package.json:100`) and
   already parses theme YAML in the browser (`use-theme-preview.ts:27`). Promoting `yaml` to a
   `shared` runtime dependency would ship a YAML parser into the `api`, `infrastructure` and `collab`
   bundles, which have no use for it. The guard would not stop that — it does not police third-party
   deps — which is exactly why the choice should be made deliberately.
4. **`asciidoc-core` is the wrong home.** Its purpose is the rules *both rings* need
   (`theme-file.ts` explains this at length). The server has no use for theme→CSS, and core is
   zero-dependency by design.
5. **`apps/web` is the wrong home** for the same reason as (1), plus a local hazard: `apps/web`'s Jest
   is transpile-only and `tsc` excludes `tests/`, so type errors in web tests do not fail the build.
   `packages/shared` type-checks its tests.

`themeColourToCss` (`apps/web/src/lib/codemirror/theme/theme-value-widgets.ts:42`) — which already
handles bare hex, `#RGB`, `#RRGGBB`, `transparent` and CMYK — should move to `shared` alongside the
translator, and the CodeMirror swatch widget should import it from there. That keeps one colour rule
rather than two.

### What the translator has to contain

1. A **theme resolver**: apply `extends`, then expand `$vars`, then evaluate arithmetic and
   `round`/`floor`/`ceil`, in the same order the gem does. `theme_loader.rb` is 327 lines and roughly
   half of it is this. This is the largest single piece of work and the one most likely to disagree
   with the engine in edge cases.
2. A **unit normaliser**: `in|mm|cm|pt|px|pc` → pt, per `measurements.rb:27-50`, then emit `pt` in
   CSS. Trivial once (1) is done.
3. A **key→CSS mapping table**, keyed by `canonicalThemeKey`, covering the "maps cleanly" set and
   explicitly marking the other two sets as `approximate` / `unmapped` so the UI can *tell the author*
   which of their settings the preview is honouring. That disclosure is the feature's honesty
   mechanism and should not be optional.
4. A **`@font-face` emitter** (§4).

### Where it plugs in on the web side

`PreviewStyleValue` is already a two-value union `'asciidocollab' | 'asciidoctor'`
(`apps/web/src/components/preview-style-control.tsx:6`), persisted in editor preferences
(`use-editor-preferences.ts:79`) and applied as `data-preview-style` on the preview container
(`asciidoc-preview.tsx:536`). Adding a third value is the natural seam. The generated CSS would be
injected as a `<style>` scoped to
`.asciidoc-preview-content[data-preview-style="pdf-theme"]` — mirroring the scoping
`scripts/build-asciidoctor-style.mjs` already performs on the vendored Asciidoctor stylesheet — and
the production CSP permits it (`style-src 'self' 'unsafe-inline'`, `docker/Caddyfile:88`).

### The `extends` gap

`DEFAULT_THEME_YAML` is committed verbatim (`default-theme.generated.ts`), so `extends: default`
resolves offline today. **`base-theme.yml` is not committed** — the generator reads it from
`packages/asciidoc-pdf/ruby/.wasm-build/…`, which `packages/asciidoc-pdf/ruby/.gitignore:9` excludes.
So does every other gem-bundled variant (`default-for-print`, `default-sans`,
`default-with-font-fallbacks`, and four `extends`-only aliases). A faithful translator would need
those vendored the same way `DEFAULT_THEME_YAML` is. That is a small, mechanical addition to
`generate-theme-descriptors.mjs`, but it is a *prerequisite*, not a detail — a theme extending `base`
that the translator resolved as "nothing" would render nothing like its PDF.

---

## 4. Fonts

### The mechanism

A theme's font catalogue names four files per family:

```yaml
font:
  catalog:
    merge: true
    Brand Mono:
      normal:      mplus1mn-regular-subset.ttf
      bold:        mplus1mn-bold-subset.ttf
      italic:      mplus1mn-italic-subset.ttf
      bold_italic: mplus1mn-bold_italic-subset.ttf
```
(`apps/web/e2e/pdf-parity/fixtures/theme-fonts/source/theme/brand-theme.yml`)

That is a one-to-one match with four `@font-face` rules differing only in `font-weight`/`font-style`.

The bytes are already in the browser. `collectReferencedAssetPaths` scans the theme YAML for
`.ttf|.otf|.woff|.woff2` tokens and resolves them relative to the theme file's own directory
(`apps/web/src/lib/pdf/collect-referenced-assets.ts:44`, `collectFontPaths`); `useProjectAssetCache`
fetches and holds them as `Uint8Array` keyed by project-relative path
(`apps/web/src/hooks/use-project-asset-cache.ts`); `useReferencedAssets` already feeds exactly this
set into the theme editor's preview. **A theme→CSS preview would reuse that cache unchanged and add
no new network traffic** — the fonts are fetched once per project and shared with the PDF preview and
the export.

The browser side is in fact *easier* than the PDF side. asciidoctor-pdf embeds only TTF/OTF, so
`mount-assets.ts` has to decode WOFF2 back to TTF before every render
(`packages/asciidoc-pdf/src/pipeline/stages/mount-assets.ts:150`). A browser loads TTF, OTF and WOFF2
natively; no conversion is needed.

### Constraint 1 — `blob:` is blocked; use `data:`

The production CSP is `font-src 'self' data:` (`docker/Caddyfile:88`). **`blob:` is not in that
list**, though it *is* allowed for `img-src`, `worker-src`, `child-src`, `connect-src` and
`media-src`. So the obvious implementation — `URL.createObjectURL(new Blob([bytes]))` in the
`@font-face src` — would work in local development and be silently blocked behind the production
proxy. The reliable mechanisms are:

- **base64 `data:` URI** embedded in the generated CSS. Explicitly permitted, no extra request, works
  identically in dev and prod. Costs ~33% inflation and a base64 encode per font; both should be
  cached per asset path, not recomputed on every keystroke.
- **A same-origin URL.** Caddy proxies `/api*` and `/projects*` to the API on the same origin
  (`docker/Caddyfile:102-113`), so `'self'` would formally allow it. But `@font-face` fetches are
  CORS-anonymous — the browser does not send cookies — while `fetchProjectAsset` relies on the
  session's credentials (`apps/web/src/lib/pdf/fetch-project-asset.ts` header comment: "same origin,
  same session credentials"). **I did not test the asset endpoint's response to a credential-less
  request**; this is reasoning from the fetch path, not a measurement. If it 401s, this route is out.

Recommendation: `data:` URIs. Adding `blob:` to `font-src` is also possible but is a security-policy
change to justify, and the CSP comment block in the Caddyfile makes clear each directive there was
derived deliberately.

### Constraint 2 — the default catalogue has no browser-reachable bytes

This is the significant one. The gem's default catalogue points at
`GEM_FONTS_DIR/notoserif-*-subset.ttf` and `GEM_FONTS_DIR/mplus1mn-*-subset.ttf`
(`default-theme.generated.ts:16-27`). `GEM_FONTS_DIR` is a renderer-internal placeholder that the app
explicitly refuses to treat as a project path (`collect-referenced-assets.ts`,
`RENDERER_FONT_DIR_PLACEHOLDERS`) — those files live inside the wasm image, not in the project and not
on any URL. A search of `apps/web/public` and the repo (excluding `node_modules` and `.wasm-build`)
found **no Noto Serif or M+ 1mn web font shipped by the app**; the only fonts under `public/` are
MathJax's.

The consequence: a project that does **not** declare its own font catalogue — which is most projects,
and by construction every project whose theme was created from `themeSeedContent()`, since the seed is
a verbatim copy of the default theme — would preview in whatever serif the browser picks. The
*palette and sizes* would be right and the *typeface* would be wrong, which is the most visible
possible discrepancy for the most common case.

Fixing it means vendoring the eight subset TTF/WOFF2 faces into `apps/web/public` and mapping
`Noto Serif` / `M+ 1mn` to them. Both families are open-licensed (SIL OFL / Apache), but **I did not
read the licence files in the gem bundle to confirm the exact terms or attribution requirements** —
that must be checked before vendoring. It also adds a few hundred KB of static assets. This is a
prerequisite for the feature to look right by default, not an optional polish.

### Constraint 3 — identical bytes still means different line breaks

Same glyphs, same advance widths, different justification, hyphenation and kerning defaults. Text will
occupy about the same width and about the same number of lines; it will not break identically. Any UI
copy must not imply otherwise.

---

## 5. The options, compared

Current costs, measured, from `specs/043-preview-responsiveness/baseline.md`:

| | ~100 lines | ~1,500 lines | ~15,000 lines |
| --- | --- | --- | --- |
| HTML preview, whole render | 45 ms | 107 ms | 421 ms |
| PDF preview, whole render | 1,465 ms | 6,627 ms | — |

and the PDF's VM cannot be reused: `RENDERS_PER_VM_INSTANCE = 1`
(`packages/asciidoc-pdf/src/vm/ruby-pdf-vm.ts:41`), because measurement showed the second render in a
reused instance costing 21.9 s against 6.7 s and the fourth failing outright on a 4 GiB address-space
exhaustion. So the PDF preview's cost is structural, not tunable; the compensation is a longer
debounce (`PDF_PREVIEW_MAX_DEBOUNCE_MS = 1500`, `apps/web/src/lib/editor-config.ts:75`).

### (a) Keep the PDF preview as-is

- **Delivers:** exact truth. Pagination, running content, title page, keep-together — everything.
- **Does not deliver:** responsiveness. Seconds per render, a fresh VM each time, and a debounce long
  enough that the preview is always behind the author.
- **Work:** zero.

### (b) "Print-like" HTML: page size + margins + `base.font-family` only

- **Delivers:** the right *measure* (line length) and the right typeface, on a white column, at
  web-preview cost. Cheap and honest.
- **Does not deliver:** the project's palette, heading ramp, block styling, table treatment — i.e.
  none of what an author actually edits a theme for. The demo theme's 210 lines are almost entirely
  things this option ignores.
- **Work:** small — a page-geometry calculation, a container width, and the `@font-face` machinery
  from §4 (which is most of the cost, and is shared with (c)).
- **The catch:** it needs the same font vendoring and the same `data:` URI mechanism as (c), so it is
  not much cheaper than (c) *in the parts that are risky*. It is only cheaper in the part that is
  mechanical.

### (c) Full theme→CSS

- **Delivers:** the project's actual visual identity in a preview that refreshes in tens of
  milliseconds. Palette, typography, block treatments, table styling, roles — the "maps cleanly"
  column of §2, which is most of what a hand-written theme contains.
- **Does not deliver:** anything in the "cannot map" column. Ever.
- **Work, in rough order of risk:**
  1. Vendor `base-theme.yml` (and ideally the other gem variants) alongside `DEFAULT_THEME_YAML` — small.
  2. Theme resolver: `extends` + `$vars` + arithmetic + precision functions + units. The upstream
     original is 327 lines and about half of it is this. **Highest risk of quiet divergence.**
  3. Key→CSS mapping table with clean/approximate/unmapped classification, checked against
     `GENERATED_THEME_DESCRIPTORS` by a test — long but mechanical, ~120 keys worth mapping.
  4. `@font-face` emitter + `data:` URI cache — small, given the asset cache already exists.
  5. Vendor the default-catalogue faces as web fonts + licence check — small but blocking.
  6. Third `PreviewStyleValue` + injection + preference plumbing — small; the seam exists.
  7. A parity story. `apps/web/e2e/pdf-parity/` is structural, not pixel-exact, and the same posture
     should apply: assert that named theme settings *reach* named CSS properties, not that two
     renderings match.

### Recommendation

**Build (c), restricted at first to the "maps cleanly" set, and name it for what it is.**

Reasoning:

1. (b) is not meaningfully cheaper than (c) where the risk lives. The font mechanism and the CSP
   constraint are the same in both; (b) simply declines to use the theme's other 200 lines. If the
   expensive part is being paid for anyway, pay it once.
2. The prerequisites are already in place to an unusual degree: the theme text is already in the
   browser, the fonts are already fetched and cached, the key catalogue already exists and is
   generated rather than hand-written, a colour→CSS converter already exists, and the preview already
   has a style-switcher seam. This is not a feature being started from nothing.
3. It does not replace the PDF preview and should not be presented as replacing it. It is a *third*
   preview style, and the PDF preview remains the answer to "where does page 3 end".
4. The naming matters and should be decided before the code. Call it **"Theme"** or **"Project
   style"** — not "PDF preview", not "print preview". This repo has a strong precedent for this exact
   judgement: the theme editor declines to draw a colour swatch for a `$variable` it cannot resolve,
   on the stated grounds that *"showing a wrong colour with the authority of a rendered swatch is
   worse than showing none"* (`theme-value-widgets.ts:13-15`). The same principle applies to a preview
   that implies page fidelity it does not have.
5. Ship the unmapped-key disclosure with the first version, not later. An author who sets
   `title-page.title.font-size` and sees nothing change needs to be told the preview does not model
   title pages — otherwise they will conclude the theme is broken and go looking in the PDF.

---

## Open questions, and what would settle them

1. **Does the resolver actually agree with the engine?** The riskiest claim in this document is that
   `extends` + `$vars` + arithmetic can be reimplemented faithfully. *Settled by:* porting
   `theme_loader.rb`'s evaluation half and differential-testing it — feed both the same theme and
   compare the resolved key/value maps. The engine can be asked for its resolved theme from within the
   VM; whether the existing worker protocol exposes a way to do that, I did not determine.
2. **Will the asset endpoint serve a font to a CORS-anonymous `@font-face` fetch?** *Settled by:* one
   request to `/api/projects/<id>/assets/<path>` without credentials. If it succeeds, plain
   same-origin URLs become an option and base64 inflation can be avoided.
3. **What are the exact licence terms of the gem's bundled Noto Serif and M+ 1mn subsets?**
   *Settled by:* reading `LICENSE`/`NOTICE.adoc` in the gem bundle before vendoring the faces.
4. **How large is the generated stylesheet in practice, and how often must it be regenerated?** A
   theme change is rare relative to a keystroke, so it should be memoised on the theme text exactly as
   `useThemePreview` memoises its snapshot — but I did not measure the emitted CSS size or the base64
   font payload for a real project.
5. **Does the HTML preview's DOM carry every hook the mapping needs?** I confirmed the standard
   Asciidoctor block classes are present in the vendored stylesheet, but I did not enumerate the DOM
   the app's worker actually emits after its post-processing passes (source-block re-highlighting,
   image-source rewriting, stem handling). *Settled by:* dumping the rendered HTML for the demo project
   and checking it against the mapping table.
6. **How much does the existing preview stylesheet fight back?** `asciidoctor-style.generated.css`
   (437 lines) and `asciidoc-preview.css` (649 lines) both target the same container and were written
   to a deliberate specificity ordering (`asciidoc-preview.tsx:2-5`). A third stylesheet has to win
   cleanly without `!important` sprayed everywhere. *Settled by:* prototyping the scoping on a handful
   of rules before committing to the full table.
7. **Should the theme editor's own sample preview reuse this?** It currently renders a real PDF per
   theme edit (`use-theme-preview.ts`), at seconds per render. A theme→CSS view would make theme
   editing dramatically more responsive — arguably a better first customer than the document preview.
   Not investigated; worth its own look.
