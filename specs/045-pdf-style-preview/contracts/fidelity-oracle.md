# Contract: the fidelity oracle

How "the Print style looks like the PDF" is proven. Under Principle XV this is not optional — a
fidelity-critical deliverable with no passing comparison against **reference** output is not done.

## Two oracles

### A. Anchor comparison (depth) — SC-002, SC-003

For each anchor fixture: render the preview, take the **reference-build PDF** produced by the
canonical gem (`apps/web/e2e/pdf-parity/generate-reference.mjs`), and compare measured properties.

| Property | Compared as | Tolerance |
|----------|-------------|-----------|
| Font family per construct | exact match on resolved family name | none — exact |
| Font size per construct | points, after converting the preview's CSS pixels at 72/96 | ±0.25 pt |
| Text colour per construct | RGB distance | ±2 per channel |
| Page content width and insets | points | ±0.5 pt |
| Body line break position | character index at which a full line breaks | ±1 character |

Tolerances are declared **once**, in the harness, and shared by every comparison (Principle XII).

**Why the reference PDF and not the in-app PDF**: Principle XI names the canonical toolchain as the
single source of truth for appearance and forbids adopting in-app output as a baseline. Comparing
against the in-app PDF would chain fidelity through a second artefact that is itself only as good as
the existing parity suite.

**Extraction**: `harness/pdftools.ts` already wraps pdf.js and poppler. Font family and size come
from pdf.js `getTextContent()` with styles. Text colour requires the fill colour from the operator
list — the one genuinely new extraction. If it proves unreliable, the documented fallback is to
assert colour through the existing ink-map comparison at a coarse tolerance and keep font, size and
geometry exact; that fallback must be recorded in the harness, not silently taken.

### B. Theme-key assertions (breadth) — SC-004

For every key listed in FR-020, a unit-level assertion that the resolver produces the expected
effective value and the applier surfaces it. Zero keys may be claimed as supported without one.

**Why both**: A alone does not scale to the key count; B alone cannot catch a mapping that is wrong
in both the code and the expectation. Neither is sufficient, which is what the spec's Q2 settled.

## Anchor set

Small and chosen for construct coverage, not exhaustiveness. It must between its documents exercise
every construct in FR-005's closed list, and must include:

- a project with **no** theme (default appearance and default page geometry — FR-022). This fixture
  is also the only one that exercises the default theme's own body face, so it is what proves the
  catalogue conversion covers it (font-sources F7);
- a project with a rich custom theme (`showcase-theme.yml` already exists and covers most of FR-020);
- a theme with a non-default page size and margins (proves FR-011 and SC-003 rather than assuming
  A4);
- a theme using a **project-supplied** font (proves FR-027's project-font path, not just the
  catalogue path).

## Explicitly not the oracle

- **Pixel or screenshot diffing of preview against PDF.** The preview is unpaginated and the two
  rasterisers differ; this produces noise, not signal.
- **Snapshotting the preview against itself.** Principle XV states in terms that a self-snapshot is
  not a comparison test. It may be used as a regression guard *in addition*, never instead.

## Done criteria

The feature cannot be marked complete until:

1. Every anchor fixture passes A within the stated tolerances.
2. Every FR-020 key has a passing B assertion.
3. Any tolerance widened during implementation is recorded with its reason — a widened tolerance is
   a design decision, not a test fix.
