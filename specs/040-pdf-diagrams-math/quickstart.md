# Quickstart: 040-pdf-diagrams-math

How to build, run, and verify each workstream. Assumes the repo is set up (`pnpm install`) and the
Asciidoctor-PDF wasm engine is vendored (predev/prebuild runs `build:asciidoctor-pdf-wasm`).

## Workstream 1 — Diagrams & math in the PDF export/preview

Build the engine package and run its unit suite (now gate-enforced):

```bash
pnpm --filter @asciidocollab/asciidoc-pdf build
pnpm --filter @asciidocollab/asciidoc-pdf test:ci     # jest --coverage, 90% threshold
```

The cache-key parity test (Contract A) is the key guard — it must pass or the worker will miss the cache
and drop diagrams/math. Real-browser verification (mermaid/MathJax on the main thread → worker cache
pre-seed) runs via the e2e PDF export/preview specs.

Parity (fidelity oracle, Principles XI/XV) — the Node real-wasm suite:

```bash
# requires the built wasm engine + poppler-utils (pdftotext/pdffonts/pdfinfo)
pnpm --filter @asciidocollab/asciidoc-pdf test:integration
```

## Workstream 2 — Editor diagram highlighting

Regenerate the Lezer parser after grammar edits, then run the web unit suite:

```bash
# from apps/web (grammar → parser is a build step in lib/codemirror)
pnpm --filter @asciidocollab/web build           # regenerates asciidoc-parser.js/.terms.js
pnpm --filter @asciidocollab/web test:ci
```

Manual check: open the editor, type a `[mermaid]` flowchart block, a `[graphviz]` DOT block, a
`[vega-lite]` JSON block, and a `[source,ruby]` block — confirm each diagram declaration is distinct from
generic source, the bodies highlight per-language (mermaid grammar-accurate for covered types, lexical
for others; DOT; JSON), and nothing bleeds into surrounding AsciiDoc.

New dependency:

```bash
pnpm --filter @asciidocollab/web add codemirror-lang-mermaid
```

## Workstream 3 — Diagrams in the HTML preview

```bash
pnpm --filter @asciidocollab/web test:ci
```

Manual check: open the HTML preview beside the editor on a doc with mermaid/graphviz/vega blocks —
confirm each renders on-screen (native fidelity), updates on edit, an unsupported (`[plantuml]`) or
malformed block shows a placeholder/warning without breaking the preview, and DevTools → Network shows
no diagram source or referenced URL leaving the client.

## Workstream 4 — CI hygiene

Confirm the gate now runs the PDF package suite:

```bash
pnpm gate                 # asciidoc-pdf unit suite now runs in Job 2 (unit)
# or just the unit job:
bash scripts/ci/unit.sh
```

### Regenerate the WOFF2 parity reference PDF

```bash
# builds the reference Docker image (ruby:3.3 + asciidoctor-pdf 2.3.24) and renders the fixture
node apps/web/e2e/pdf-parity/generate-reference.mjs theme-fonts-woff2
# reproducible: uses SOURCE_DATE_EPOCH=1704067200 internally; commit the resulting reference.pdf
```

Then the parity fixture is exercised by:

```bash
pnpm --filter @asciidocollab/asciidoc-pdf test:integration    # asserts allFontsEmbedded === true
```

## Full end-of-feature gate (Principle: End-of-Feature Verification)

```bash
pnpm gate                 # quality, unit (incl. asciidoc-pdf), integration, security, e2e
RUN_WASM=1 pnpm gate      # include the opt-in wasm build job
# then the /code-review loop to zero findings
```
