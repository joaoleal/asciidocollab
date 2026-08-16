# Render-equivalence suite

Gates for the **web-formatted** preview — the HTML the editor shows, produced by the JS Asciidoctor
engine in `apps/web/src/workers/asciidoc-render.worker.ts`.

Until this directory existed, that engine had no comparison gate of any kind. The suite that *looked*
like one — the PDF reference-parity suite — renders through a completely different engine and would
have passed whether a web-format change was correct or catastrophic. See
[Why the page-format parity suite cannot serve](#why-the-page-format-parity-suite-cannot-serve).

Everything here is stack-free: no app server, no database, no auth. The specs drive the render worker
directly in Node and compare its output against committed fixtures. A failure is therefore
unambiguously a rendering difference, never a broken environment.

---

## The four gates, and what each one actually proves

Read this table before adding, weakening or "fixing" any check here. The gates are not
interchangeable, and three of them cannot answer the question the fourth answers.

| Gate | Compares | Proves | Cannot prove |
|---|---|---|---|
| **Canonical reference build** (`web-format-reference.spec.ts`) | in-app web-format render **vs a pinned external Asciidoctor toolchain** | the render is *right* — the only external fidelity oracle the web format has ever had | that a change did nothing; its enumerated divergence list can absorb a real change |
| **Previous-engine regression** (`web-format-equivalence.spec.ts`) | in-app render **vs output captured from the engine before it was changed** | the change altered *nothing* — including ids and provenance | that the render is right: it is the app compared with its own earlier self |
| **Cross-format agreement** (`cross-format-agreement.spec.ts`) | web-format render **vs page-format (PDF) render** of the same source | the two previews say the same thing | anything about either format's fidelity — both could be wrong identically |
| **Page-format parity** (`../pdf-parity/`, pre-existing, unchanged) | in-app PDF **vs an external reference PDF** | the page-formatted path was **not disturbed** by work done here | anything at all about the web-format engine |

The division of labour that matters:

- **Fidelity is discharged only by the canonical reference build.** A snapshot of the app's output
  against itself is not reference output, so the regression gate cannot discharge it no matter how
  thorough it is. The two are necessary together and neither is sufficient alone.
- **The regression gate is what fails when an engine upgrade changes output.** The reference build can
  pass both before and after a change that moved something its normalisation happens to cover.
- **The page-format parity suite is evidence about the *other* path**, retained so that changes here
  can be shown not to have disturbed it. It is not, and never was, a gate on this one. It has to be
  re-run after *any* change to page-format rendering, not just once — and a **skipped run is not a
  passing run**: `scripts/ci/gate.sh` reports the PDF-parity job as `SKIPPED` when poppler-utils or the
  built wasm engine are absent, so a green `pnpm gate` can have compared nothing. Provision the
  prerequisites or invoke `scripts/ci/pdf-parity.sh` directly, which refuses to skip.

### Why the page-format parity suite cannot serve

It is the obvious candidate — it is a real reference-parity suite, it already runs in CI, and it
covers AsciiDoc rendering. It still cannot be the web-format gate, for a reason no amount of extra
fixtures would fix:

| | Page-format parity suite | Web-format preview |
|---|---|---|
| Engine | `@asciidocollab/asciidoc-pdf` — Asciidoctor vendored into ruby.wasm | the `asciidoctor` npm package (JS) |
| Loads the JS engine? | **Never** | it *is* the JS engine |
| Compares | in-app PDF vs external reference PDF | — |

The two engines share no code. A change to the JS engine cannot make the PDF suite fail, so its green
result carries no information about the web format whatsoever. Matching reported core versions between
the two are a reason to *expect* agreement, not evidence of it: parity is verified against reference
output, never inferred from code inspection.

### Why the HTML oracle has its own pinned toolchain definition

The canonical reference build reuses the page-format toolchain's *mechanism* — a digest-pinned base
image, `Gemfile` + `Gemfile.lock` installed frozen, a fixed `SOURCE_DATE_EPOCH`, explicit locale and
timezone — but **not its definition files**. It carries its own `Dockerfile`, `Gemfile` and
`Gemfile.lock` under `harness/`.

That separation is deliberate and must be preserved. `reference-image.mjs` names the built image after
a **hash of the definition files** (`<name>:<digest>`), which is what makes an existing image a sound
cache hit rather than "whatever someone built once". The consequence: adding the HTML backend's gems to
the *shared* `Gemfile`/`Gemfile.lock` would re-tag the PDF reference image, and every committed
page-format reference PDF would then have been produced by a toolchain that no longer has a name —
putting the whole page-format reference corpus in question, and with it the evidence that the
page-formatted path was undisturbed. Two definition sets, one mechanism: `referenceImageTag()` and
`ensureReferenceImage()` take a definition, the page-format one is the default, and passing a tag that
does not belong to the definition being built is an error rather than a silent stale reuse.

The HTML set's definition is `harness/Dockerfile.reference`, `harness/Gemfile`, `harness/Gemfile.lock`
and `harness/reference-render.rb` — the conversion script is in the hash because it chooses the load
options, which decide the output bytes as surely as the gem version does. It pins the digest of the same
Ruby base image the page-format set uses, `asciidoctor` at the core version the in-app JS engine reports
(`getCoreVersion()`), `LANG`/`LC_ALL`/`TZ`, and a fixed `SOURCE_DATE_EPOCH`.

**Pinning the gem to the JS engine's own core version is the point, not a coincidence.** The oracle is
there to answer "does the app render this the way Asciidoctor renders it". An oracle running a
*different* Asciidoctor answers "do two versions of Asciidoctor agree", and every release-note change
would surface as a fidelity failure, drowning the differences that are really the app's. Upgrading the
`asciidoctor` npm package is therefore a change to `harness/Gemfile` too: bump both in the same commit
and re-run this gate, which is the moment it is supposed to speak.

---

## Layout

```
corpus/                        the documents every gate renders (top-level *.adoc are the documents;
                               includes/ holds files that are part of a document, not documents)
fixtures/previous-engine/      HTML captured from the engine BEFORE it was changed — write-once
fixtures/reference-toolchain/  what the pinned external toolchain produced, per document: the HTML
                               conversion and the parsed verbatim blocks it reports beside it.
                               REWRITTEN on every reference run, and re-derivable from the pinned
                               image at any time — the opposite of the write-once fixtures above
harness/capture.ts             drives the real render worker; corpus + fixture I/O
harness/dom-equivalence.ts     the canonical reduction and the difference reports, shared by the
                               regression gate and the canonical reference build
harness/Dockerfile.reference   the HTML oracle's definition set: digest-pinned base, frozen gem
harness/Gemfile                closure, explicit locale/TZ, and the conversion script. Their bytes
harness/Gemfile.lock           are the image's tag
harness/reference-render.rb
harness/reference-build.ts     builds and runs the oracle, and holds the named normalisation passes
harness/cross-format.ts        reduces both preview formats to the three dimensions they can both
                               express, and holds the named reconciliations between them
capture-previous-engine.spec.ts  the one-shot capture tool (not a check — self-skips by default)
web-format-equivalence.spec.ts   the previous-engine regression gate
web-format-reference.spec.ts     the canonical reference build (needs docker; self-skips without it)
cross-format-agreement.spec.ts   web format vs page format (needs the built wasm engine; self-skips
                                 without it)
```

The corpus is chosen for what a major engine version is most likely to disturb: headings at every
level with and without section numbering, explicit anchors and cross-references, source blocks with
and without a declared language, tables/lists/admonitions/footnotes/callouts, attribute entries and
conditionals, an include tree with `leveloffset`, diagram and stem blocks, and images both
`imagesdir`-relative and absolute.

---

## Running the gates

All of them use the standalone config `apps/web/playwright.render-equivalence.config.ts`, which needs
no running stack. Two have a prerequisite of their own and skip cleanly without it: the canonical
reference build needs Docker, and cross-format agreement needs the built page-format engine
(`pnpm wasm`). It needs no poppler, unlike the page-format parity suite — it reads the PDF with
`pdfjs-dist`, which is already this app's PDF reader. From the repository root:

```bash
# The regression gate — in-app render vs the captured previous-engine fixtures
pnpm --filter @asciidocollab/web exec playwright test web-format-equivalence \
  --config playwright.render-equivalence.config.ts

# The canonical reference build — in-app render vs the pinned external toolchain (needs docker)
pnpm --filter @asciidocollab/web exec playwright test web-format-reference \
  --config playwright.render-equivalence.config.ts

# Cross-format agreement — web-format render vs page-format render
pnpm --filter @asciidocollab/web exec playwright test cross-format-agreement \
  --config playwright.render-equivalence.config.ts

# Everything in this directory
pnpm --filter @asciidocollab/web render-equivalence
```

The page-format parity suite lives elsewhere and has its own config and prerequisites (poppler-utils
and a built wasm engine, `pnpm wasm`):

```bash
scripts/ci/pdf-parity.sh          # fails rather than skipping when a prerequisite is missing
```

Each gate also has a package script: `render-equivalence:regression`, `render-equivalence:reference`,
`render-equivalence:cross-format`, `render-equivalence:capture`.

---

## The previous-engine fixtures: captured once, on purpose

`fixtures/previous-engine/*.html` is the entire basis of the regression gate, and it records how the
engine behaved **before** it was changed. There is exactly one moment when that output is available.

The capture is a dev tool, not a check. It is gated twice so it cannot happen by accident:

1. `capture-previous-engine.spec.ts` skips unless `CAPTURE_PREVIOUS_ENGINE=1`;
2. `writeFixture` **refuses to overwrite an existing fixture**, even with the gate open.

```bash
pnpm --filter @asciidocollab/web render-equivalence:capture
```

The second gate is the important one. A re-capture after the engine changed would replace the
reference with the very output it exists to judge, and the gate would then pass by definition —
silently, and for good. Deleting a fixture is a visible act that shows up in review; overwriting one
in a routine run is not. **If a fixture is missing, it cannot be re-derived from today's build.** It
has to come from a reverted checkout of the engine as it was, which in practice means the coverage is
gone.

> **Two fixtures have been deliberately re-captured, and no longer carry the property above.**
> `source-blocks.html` and `tables-lists.html` were regenerated during the Print-preview work
> (feature 045). Two intended engine changes had made them stale: a callout-bearing Ruby listing that
> should have been syntax-highlighted and was not, and a footnote separator that had to be wrapped in
> `<span class="footnote-separator">` so a stylesheet could reach it — a bare text node cannot be
> selected. Both files were diffed hunk by hunk before and after, and the deltas are exactly those two
> changes and nothing else. For these two documents the "before" property is spent: they are now a
> regression gate against the *current* engine rather than a record of the previous one. The other
> fixtures are untouched and still carry it.



Two properties of the capture are worth knowing before reading a fixture:

- It goes through the **real render worker**, not raw Asciidoctor conversion. What the app displays is
  conversion *plus* the worker's own passes — diagram placeholders, image-source rewriting, syntax
  highlighting, source-line provenance. A fixture taken from raw conversion would be a reference for
  a render the product never performs.
- Includes are captured **expanded**, and the image base is a fixed fictional host
  (`https://render-equivalence.invalid/…`). A real image base carries a project id, so capturing with
  one would bake an environment-specific value into a committed fixture.

---

## What the regression comparison normalises — and what it refuses to

Both sides are parsed by a **real browser HTML parser** (the spec hands
`canonicaliseRenderedHtml` to `page.evaluate`), so the verdict is about what the markup *means*, not
how either side happened to be serialised. Each document is reduced to three sequences — the element
tree, every `id`, and every source-provenance marker — and compared entry by entry.

A rendered preview is a document *fragment*, and the parser does not put all of a fragment in the
body: a `<style>`, `<meta>` or `<link>` written by a leading `+++` passthrough is hoisted into
`<head>`. Both are read, here and in the canonical reference build, so nothing the render emitted
falls outside the comparison. Their position relative to the body is the parser's decision rather than
the render's, so they are compared as a group at the front.

| Aspect | Treatment |
|---|---|
| Inter-element whitespace and indentation | normalised away |
| Attribute **order** | normalised away |
| Character-entity spelling (`&#8217;` vs the literal character) | normalised away (the parser decodes both) |
| Attribute **values** | compared |
| Element names, structure, hierarchy, text | compared |
| `id` attributes | **compared exactly — never normalised** |
| `data-source-line` / `data-source-file` | **compared exactly** |
| Whitespace inside `<pre>`, `<code>` and `.adc-diagram` | **compared exactly** — there it is content |

Identifiers and provenance sit outside normalisation because, unlike whitespace, **they carry
behaviour**. A changed heading id leaves the visible text identical while silently breaking every
cross-reference that pointed at it; a changed `data-source-line` breaks click-to-source and scroll-sync
the same way. That is precisely the failure a normalised comparison must still catch, so ids and
provenance are additionally extracted into sequences of their own — not because the element-tree
comparison would miss them, but so that a rename is *reported as a rename* instead of being buried in
two nearly identical lines of markup.

Note the contrast with the canonical reference build, which does the opposite on purpose: there the
synthetic `__src_…` ids and the `data-source-*` attributes are stripped before comparison, because they
are additions the app makes to the external toolchain's output. They are named, enumerated divergences
there; here they are the thing under test.

`web-format-equivalence.spec.ts` pins these rules directly, in a test that checks reflowed markup and
reordered attributes compare *equal* while a renamed id, a moved source line, a changed attribute
value, changed text and re-indented code all compare *unequal*. That test exists because a
normalisation quietly widened until the corpus passes looks exactly like one that works.

---

## What the canonical reference build normalises — and what it refuses to

The app's render is conversion **plus** the worker's own passes, so its output cannot be compared with
raw Asciidoctor output as it stands. Each difference is either an *input* the reference is given too,
or a *named pass* in `harness/reference-build.ts`. Nothing else is forgiven, and a difference that is
not on this list is a failure — either an unaccounted-for difference or a rendering defect.

Reproduced as inputs, so they are not divergences at all:

| Input | How |
|---|---|
| Assembled `include::` bodies | the reference converts the same assembled source, produced by the app's own include assembler with the app's seed attributes |
| Seeded attributes (`showtitle`, `icons`, `stem`) | passed to the reference conversion unchanged. A corpus request that ever grew a project root — which would make the worker seed an inherited attribute scope this harness does not reproduce — fails loudly rather than silently converting with fewer attributes |

Normalised, one named pass each:

| Pass | Exists for | Gives up |
|---|---|---|
| **strip source provenance** | `data-source-line` / `data-source-file`, added by the worker for scroll-sync | nothing here — they are asserted exactly by the regression gate, which is the gate that owns them |
| **strip synthetic identifiers** | the `__src_…` ids the worker mints for blocks the author left unidentified | nothing — the prefix is reserved, so an author's anchor and an engine-derived id are untouched and compared exactly |
| **unmap image endpoint targets** | the worker rewrites project-relative image targets onto the authenticated image endpoint | the base only. An app-side target that was never mapped is an **error**, not a match — the pass undoes the rewrite, so without that its absence would look like agreement |
| **reduce highlighted source blocks to their code** | the app colours source blocks with highlight.js after conversion, and the two engines disagree about which highlighter is even in effect (the corpus declares `rouge`, which the reference engine has an adapter for and the JS engine has not) | the token spans and the highlighter's name. The code's exact characters and indentation, its `data-lang`, and everything in the block that is not a token — callout markers especially — are kept and compared |
| **canonicalise diagram blocks** | the app emits an inert `.adc-diagram` placeholder for the main thread to draw; the reference, with no diagram extension, renders a listing block | the wrapper each toolchain chose. Both sides become `<adc-diagram type="TYPE">SOURCE</adc-diagram>`, so a changed type or a changed source still fails. The declared type does not survive conversion, so the reference reports its parsed block styles alongside its HTML rather than either side inventing the type |

The reference toolchain is deliberately built **without** `rouge`: the app has no rouge either, so
installing it would make the reference emit Ruby-side token markup the app never produces, and the
highlighting pass would have to grow from "the app adds token spans" to "the two sides tokenise
differently" — a strictly weaker comparison bought for nothing.

`web-format-reference.spec.ts` pins these passes directly, the way the regression gate pins its own
rules, in a test that checks each pass forgives what it exists for and still refuses a changed code
character, re-indented code or diagram source, a changed `data-lang`, an extra class on a highlighted
block, a renamed author anchor, a changed or unmapped image target, a changed diagram type, a diagram
left as a listing, changed prose and a lost element. **A passing corpus proves nothing on its own** —
a normalisation widened until nothing can fail looks exactly like one that works.

---

## What cross-format agreement compares — and what it refuses to

The two formats are different media, so there is no byte- or DOM-level comparison between them.
Agreement is judged on the three things **both** can express, and on nothing else:

| Dimension | Web format | Page format |
|---|---|---|
| Rendered text, in document order | the rendered markup's text content | the extracted text layer, read in content-stream order and normalised the way the page-format parity suite normalises it (trimmed, internal whitespace collapsed, empty lines dropped) |
| Heading hierarchy and numbering | `<h1>`…`<h6>` levels, and the section number, which the engine puts in the heading's text | the document outline — the page format's own statement of its section tree — with its titles and depths |
| Cross-reference target set | every `href="#…"`, and whether the id it names exists | every internal link annotation's named destination, and whether it resolves to a page |

Everything else is out: **fonts, spacing, colour, page breaks and layout**. Those are page-format
concerns with no web-format counterpart, and the page-format parity suite is the right oracle for
them. That exclusion is load-bearing rather than a convenience — it is why the text dimension
compares **whitespace-free** text. The same paragraph wraps at a column width on one side and at
whatever width the reader's pane happens to be on the other, so any comparison that kept line breaks
would be comparing layout.

Two extraction choices follow from the same reasoning and are worth knowing before reading the code:

- **The text layer is read in content-stream order, not in visual columns.** The page-format parity
  suite reads the layout-preserving form, which is correct for its own job — a PDF against another
  PDF, where padded columns line up. Here it is wrong: a paragraph flowed beside a second table cell
  comes back interleaved with it, and a footnote marker raised above its line comes back before the
  sentence it belongs to. The reading order the comparison rests on is gone.
- **Heading levels come from the outline, not from the text layer.** The text layer records what a
  heading *says*, never what level it sits at — the level is drawn as a font size, which is exactly
  the kind of presentation this gate does not compare. The outline is asked for the full heading
  depth (`outlinelevels`), because it is truncated at two levels by default and a document would
  otherwise express only part of its own structure. Bookmarks are not drawn on a page, so nothing
  rendered changes.

Each way the two media draw the *same* content differently is a named reconciliation, never a
comparison loosened until the corpus passes. Four rewrite the web side, four the page side:

| Reconciliation | Side | Exists for | Gives up |
|---|---|---|---|
| **ordered-list markers** | web | the page format writes `1.` / `a.` into its text layer; the browser draws them from CSS counters, so the markup has no text there | nothing — the marker is reconstructed from the list's numbering style and the item's position, so a renumbered or re-styled list still fails. Dropping the page format's markers instead would stop comparing list counting altogether |
| **callout numbers** | both | written `(1)` beside the code and `1` in the callout list by the web format, and as a circled digit by the page format | the shape only. Both become `(1)`, so a changed or misnumbered callout still fails |
| **footnote definition labels** | web | the web format labels a definition `1.`, the page format `[1]` | the shape only; the number is kept and compared |
| **quote attribution** | web | the page format writes an attribution as one line, `— author, citation`; the web format breaks the line | the line break, which is layout. The author and the citation are both kept |
| **list marker glyphs** | page | a bullet (`•`, `◦`, `▪`) or a checkbox (`☐`, `☑`) drawn in the marker position, where the web format has no text at all | the glyphs, and with them the checkbox *state*: the web preview draws no checkbox (`asciidoc-preview.css` paints admonition icons but not `fa-square-o`), so a checked and an unchecked task are indistinguishable there. Ordered markers are **not** in this rule — the numbering counts something |
| **admonition type** | both | with `icons=font` — the app's default for every project, so every run of this gate — neither side writes the word NOTE anywhere: the web format draws an empty `<i class="fa icon-note">` from CSS, the page format draws a glyph that lands in the text layer at its icon font's private-use slot | nothing. Both are reduced to `[NOTE]` — from the marker's class on the web side, from the slot on the page side — so a note that became a caution fails. Without it the six admonitions in the corpus are indistinguishable from one another |
| **other icon-font glyphs** | page | any remaining private-use code point is an icon that names nothing this gate compares | those code points only, so ordinary text — including an admonition's spelled-out label, which is what either side emits when `icons` is unset — is untouched |
| **running footer** | page | the page number the engine draws in the bottom margin; page breaks are not compared, and the number is a statement about where one fell | the page number, and only that. The rule is narrow on purpose — it drops a line only when it is the last on its page, its text is exactly that page's number, **and** it was drawn in the half-inch margin band where no body content can be, so a table cell or a list item that happens to read `2` on page 2 is kept |

Two corpus documents are deliberately **not** in the shared set, and the reason is recorded in
`EXCLUDED_FROM_CROSS_FORMAT` so that dropping one is a visible decision:

- `images` — the document exists for the web format's image-source rewrite, a web-only pass. Its
  targets are fictional, so the web format emits `<img>` elements (no text at all) while the page
  format draws a missing-image placeholder naming the alt text and the target.
- `diagrams-stem` — diagram and equation blocks are drawn *after* conversion by different machinery
  on each side. Comparing them would compare the two shim stacks, not the two previews.

`cross-format-agreement.spec.ts` pins every reconciliation directly, the way the other gates pin
theirs, in a test that checks each one forgives what it exists for and still refuses changed prose, a
lost list item, a renumbered or re-styled ordered list, a changed callout number in either position, a
changed footnote number, a note drawn as a caution, a lost citation, a changed attribution, reordered
blocks and a lost code character. The pinning goes through **the same function the corpus comparison
goes through** (`reducePageFormatText`), line assembly and footer rule included — a pinning test with
its own copy of the reduction pins a second implementation, and the two drift apart at the first
change to either. It also checks that the corpus still contains the documents that carry cross-references —
without them the run would report three dimensions while comparing two, which is the specific way this
gate would decay.

---

## If you touch this directory

- **Adding a corpus document** means it has no previous-engine fixture and never can — the regression
  gate fails on the missing fixture rather than passing over it. New corpus documents are covered by
  the canonical reference build, which can be regenerated at any time; the regression gate covers the
  documents that existed when the engine was captured. Both are correct; do not "fix" the failure by
  capturing a fixture from the current engine, which would assert only that today equals today.
- **Widening a normalisation rule to make a failure go away** removes the gate's ability to see the
  class of change it just absorbed. If the difference is intended, say so in review and record why;
  the reference build's divergence list is a list of *named* differences precisely so that adding a
  row is a deliberate act rather than a silent loosening.
- **The gates are not substitutes for one another.** If one is inconvenient to run, run it anyway: the
  only gate whose green result says the render is correct is the canonical reference build, and the
  only gate whose red result says an upgrade changed something is the regression gate.
