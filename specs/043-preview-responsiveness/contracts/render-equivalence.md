# Contract: Render Equivalence Gates

**Feature**: `043-preview-responsiveness` | Modules: `apps/web/e2e/render-equivalence/` (new)

Added after the architecture-guard scan found that the gate the plan originally named — the existing
page-format reference-parity suite — **does not exercise the engine User Story 6 changes**. It would
have passed regardless of whether the upgrade was correct.

Requirements: FR-024, FR-024a, FR-025, FR-025a, FR-025b, FR-023c. Criteria: SC-010, SC-010a, SC-010b,
SC-010c.

---

## Why the existing suite cannot serve

| | Existing page-format parity suite | What User Story 6 changes |
|---|---|---|
| Engine | `@asciidocollab/asciidoc-pdf` (ruby.wasm, Asciidoctor 2.0.26 vendored) | the JS `asciidoctor` npm package |
| Importers | `apps/web/e2e/pdf-parity/**` | `apps/web/src/workers/asciidoc-render.worker.ts:1` — **the only non-build importer in the repo** |
| Compares | in-app PDF vs external reference PDF (text layer, page count) | — |
| Would detect a v4 regression? | **No.** It never loads the JS engine | — |

A matching `getCoreVersion()` (2.0.26) is a reason to *expect* agreement. Principle XI forbids
treating it as evidence: parity "MUST be verified against reference output, never assumed from code
inspection".

---

## G0. Canonical web-format reference build (FR-025c, FR-025d) — the gate that discharges Principle XV

**The web-formatted preview has never had an external fidelity oracle.** The page-formatted path has
one (an external reference build); the web path has only ever been comparable against its own previous
output. A rendering defect present in every version we have shipped is invisible to G1 by construction
— G1 can only answer "did this change?", never "is this right?".

### Design

```text
corpus/*.adoc ──> reference Asciidoctor toolchain (HTML backend) ──> fixtures/reference-toolchain/
              └─> in-app web-format render ─────────────────────┐
                                                                 ▼
                                              normalise + enumerate intended divergences
                                                                 ▼
                                                      compare → pass / fail
```

### The toolchain must be pinned (FR-025c-i)

"The reference Asciidoctor toolchain" is not a specification. An oracle that resolves to a different
version on a different machine cannot answer "does this match the reference?", and Principle XII's
determinism requirement is a precondition for Principle XI's parity requirement — an unpinned oracle
breaks both at once.

The page-formatted path already solved this, and the mechanism is reused rather than re-derived
(Principle IV):

| Concern | Existing mechanism | Location |
|---|---|---|
| Base image drift | Digest-pinned `ruby@sha256:…`, never a moving tag | `e2e/pdf-parity/tools/Dockerfile.reference` |
| Gem drift | `Gemfile` + `Gemfile.lock`, installed `--frozen` so a disagreeing lock fails the build | `e2e/pdf-parity/tools/` |
| Stale image reuse | Tag is a **hash of the definition files**, so an existing image is a sound cache hit rather than "whatever someone built once" | `tools/reference-image.mjs` › `referenceImageTag()` |
| Wall-clock in output | Fixed `SOURCE_DATE_EPOCH` | `tools/reference-image.mjs` |
| Locale / TZ | Set explicitly in the image, not inherited | `Dockerfile.reference` |

**Constraint on the reuse**: the page-format toolchain's identity MUST NOT change. `referenceImageTag()`
hashes `DEFINITION_FILES`, so adding the HTML backend's gems to the *shared* `Gemfile.lock` would
re-tag the PDF image and put the committed page-format reference corpus in question — and SC-010c
depends on that corpus staying valid. The HTML oracle therefore gets its **own** definition set
(`Dockerfile`, `Gemfile`, `Gemfile.lock`) under `e2e/render-equivalence/harness/`, and
`reference-image.mjs` is generalised to build *a* definition set rather than only its own, with the
PDF set remaining the default so its tag is byte-identical to today's.

### Intended divergences (FR-025d)

The in-app render deliberately differs from raw reference output. Each difference is **named and
accounted for**, never absorbed by loosening the comparison until it passes:

| Divergence | Origin | Treatment |
|---|---|---|
| `data-source-line` / `data-source-file` | worker's scroll-sync pass | stripped before comparison; asserted separately by G1 |
| Synthetic `__src_<context>_<line>` ids | worker, for blocks with no author id | stripped; real ids compared exactly |
| Image `src` rewritten to the project endpoint | `rewriteImageSources` | rewritten back to project-relative before comparison |
| `hljs-*` token spans inside code blocks | worker's highlighting pass | code block compared on text content only |
| `.adc-diagram` placeholders | worker's diagram swap | both sides reduced to a canonical node (see below) |
| Assembled `include::` bodies | include assembler | reference run with the same assembled source, so this is not a divergence at all |
| `showtitle` / seeded attributes | worker's API attributes | reference run with the same attributes |

**Anything not on this list that differs is a failure.** Adding a row is a deliberate act that should
be justified in review — that is what stops this gate from decaying into a tautology.

**Each row must carry a rule, not an intention.** The diagram row previously read "the reference's own
rendering of those blocks is normalised to match", which states a goal and leaves the method to
whoever runs the suite — and this is the row most likely to be widened until the comparison passes,
because it is the one where the two sides legitimately differ most. Its concrete rule:

> The reference toolchain renders a diagram block with no diagram extension loaded as an ordinary
> listing block carrying the diagram source. The in-app render emits a `.adc-diagram` placeholder
> carrying the same source as escaped text (`buildDiagramPlaceholder`,
> `asciidoc-render.worker.ts:212-214`). **Both sides are replaced by a single canonical element
> `<adc-diagram type="TYPE">SOURCE</adc-diagram>`**, where `TYPE` is the block's declared diagram name
> and `SOURCE` is its source text with trailing whitespace stripped per line. The comparison then runs
> on those canonical nodes: a changed diagram type or changed source fails, a difference in how either
> toolchain chose to wrap it does not.

The rendered *image* is out of scope for this gate — G0 compares conversion output, and diagrams are
drawn after conversion on the main thread.

**Expect the first run to fail.** It is comparing against external truth for the first time, so
long-standing divergences will surface. A clean first run is more likely evidence that the
normalisation is too permissive than that the renderer is perfect.

**Assertion — SC-010d**: zero unexplained differences across the corpus.

---

## G1. Web-format render-equivalence corpus (FR-025a) — regression gate

Exercises the changed component, and answers a question G0 does not: *did this upgrade change
anything relative to the previous version?* G0 could pass both before and after while the upgrade
silently altered something the enumerated normalisation happens to cover.

**This gate does NOT discharge Principle XV.** The principle excludes "a snapshot of the in-app output
against itself", which is exactly what this is. It is necessary, not sufficient; G0 is what makes the
pair complete.

### Corpus

A fixed set of documents chosen to cover what a major engine version is most likely to disturb:

| Coverage | Why |
|---|---|
| Headings at every level, with and without `sectnums` | auto-generated identifiers and numbering |
| Explicit `[[anchors]]` and internal `xref`s | FR-024a exact-identifier matching |
| Source blocks with and without a declared language | interacts with the worker's highlighting pass |
| Tables, lists, admonitions, footnotes, callouts | counters and numbering |
| Attribute entries, `ifdef`/`ifeval` conditionals | resolution order |
| An `include::` tree with `leveloffset` | assembly + offset composition |
| Diagram and stem blocks | placeholder emission (not the rendering itself) |
| Images, both `imagesdir`-relative and absolute | the image-source rewrite pass |

### Reference capture — timing is the whole point

```text
US3 baseline pass (BEFORE any change)
   └─ render corpus with the CURRENT engine
      └─ write apps/web/e2e/render-equivalence/fixtures/<case>.html
```

This is **FR-023c**, and it is the reason the capture lives in User Story 3 rather than User Story 6.
Reference output must come from the unmodified engine, and there is exactly one moment when that is
available. Miss it and the reference has to be reconstructed from a reverted build — which in practice
does not happen.

### Comparison (FR-024, FR-024a)

| Aspect | Treatment |
|---|---|
| Inter-element whitespace | normalised away |
| Attribute **ordering** | normalised away |
| Attribute **values** | compared |
| Element structure, hierarchy, text | compared |
| `id` attributes | **compared exactly** — never normalised (FR-024a) |
| `data-source-line` / `data-source-file` | **compared exactly** — the editor navigates by them |

Identifiers and provenance sit outside normalisation because, unlike whitespace, they carry behaviour:
a changed heading id silently breaks every cross-reference to it and every click-to-source jump, while
leaving the visible text identical. That is the failure a normalised comparison must still catch.

### Assertions

- **SC-010** — every corpus document is equivalent under the above.
- **SC-010a** — zero broken cross-references, zero lost provenance markers.

---

## G2. Cross-format agreement (FR-025b)

FR-025 has always required the two preview formats to agree. No vehicle existed for checking it.

### The problem

The formats are different media. There is no meaningful byte- or DOM-level comparison between an HTML
document and a PDF, so agreement must be judged on what **both** can express.

### Compared

| Dimension | Web-formatted source | Page-formatted source |
|---|---|---|
| Block text sequence | rendered text content, in document order | extracted PDF text layer, normalised as the existing suite does |
| Heading hierarchy + numbering | heading levels and any `sectnums` numbers | same, from the text layer |
| Cross-reference target set | `href="#…"` targets and the ids they resolve to | internal link destinations — **requires new extraction, FR-025e** |

### The extraction gap (FR-025e)

`apps/web/e2e/pdf-parity/harness/pdftools.ts` exports `pageCount`, `extractText`, `pageInkMaps` and
`compareInkMaps` — no link-annotation parsing. Reading internal link destinations means walking each
page's `/Annots` for `/Subtype /Link` and resolving the destination to a page and named target.

Without it, the third dimension cannot be checked, and the risk is not that the check fails — it is
that it quietly becomes a two-dimension check still reported as satisfying FR-025b. Building the
extraction is therefore part of this work, not a prerequisite to be discovered later.

### Not compared

Fonts, spacing, colour, page breaks, and layout — page-format concerns with no web-format counterpart.
Those remain the province of the existing reference-parity suite (G3), which is the right oracle for
them.

**Assertion — SC-010b**: for every document in the shared fixture set, the three dimensions agree.

---

## G3. Existing page-format parity suite — retained, re-scoped

`apps/web/e2e/pdf-parity/pdf-parity-render.spec.ts` runs **unchanged**.

Its role is corrected, not diminished: it is not the gate for the engine upgrade, but it is the
evidence that the page-formatted path was **not disturbed** by this feature (**SC-010c**).

Two cautions, both found by the post-task analysis:

1. **This feature does not, in the end, leave ruby.wasm untouched.** User Story 7 (FR-028a) may change
   page-format render-VM reuse in `packages/asciidoc-pdf`. SC-010c says "throughout this feature", so
   checking it during User Story 6 does not discharge it — it MUST be re-run after User Story 7.
2. **A skipped run is not a passing run.** `scripts/ci/pdf-parity.sh` correctly refuses to skip and
   fails when poppler-utils or the built wasm engine are missing — but `scripts/ci/gate.sh:47-53`
   wraps it in a conditional and reports `SKIPPED` locally when either is absent. `pnpm gate` can
   therefore go green having compared nothing. For this feature the job MUST actually run: provision
   the prerequisites (`pnpm wasm`, poppler-utils) or invoke `scripts/ci/pdf-parity.sh` directly, and
   treat a SKIPPED Job 6 as a failed sweep.

---

## Execution

```bash
# G0 — against the canonical reference toolchain. Discharges Principle XV
pnpm --filter @asciidocollab/web exec playwright test e2e/render-equivalence/web-format-reference

# G1 — regression against fixtures captured from the previous engine during the US3 baseline
pnpm --filter @asciidocollab/web exec playwright test e2e/render-equivalence/web-format-equivalence

# G2 — cross-format agreement (needs the FR-025e link extraction)
pnpm --filter @asciidocollab/web exec playwright test e2e/render-equivalence/cross-format-agreement

# G3 — the pre-existing page-format suite, unchanged
pnpm --filter @asciidocollab/web exec playwright test --config=playwright.pdf-parity.config.ts
```

## Definition of done for User Story 6

All five must hold. Per Principle XV, a fidelity-critical deliverable with no passing comparison
against **reference output** is not done — and G1 alone does not satisfy that, being a self-comparison:

1. **G0 passes across the corpus (SC-010d)** — every difference normalised or enumerated. This is the
   one that discharges XV.
2. G1 passes across the corpus (SC-010, SC-010a) — no regression against the previous engine.
3. G2 passes across the shared fixtures, all three dimensions (SC-010b, SC-010e).
4. G3 passes unchanged (SC-010c) — the page-formatted path was not disturbed.
5. Measured conversion time and bundle size compared against `baseline.md` (SC-009).
