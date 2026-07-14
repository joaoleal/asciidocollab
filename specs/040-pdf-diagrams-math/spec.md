# Feature Specification: Diagrams & Math in PDF Export, Editor Diagram Highlighting, and PDF Test-Coverage Hygiene

**Feature Branch**: `040-pdf-diagrams-math`

**Created**: 2026-07-14

**Status**: Draft

**Input**: User description: "Render text-described diagrams (mermaid, graphviz, vega/vega-lite) and STEM math (stem/latexmath/asciimath, block and inline) into the in-browser PDF export and live PDF preview, so a document containing diagram or math blocks exports with those blocks rendered as images that match the reference Asciidoctor-PDF toolchain — instead of the current behaviour where such a block is dropped with a warning. The rendering must keep the feature-039 guarantee that document source never leaves the browser. The AsciiDoc editor must give diagram blocks their own syntax highlighting so a writer can tell a diagram block apart from a generic listing or source-code block at a glance. Finally, close the CI/quality-gate hygiene gaps this feature area exposed: the packages/asciidoc-pdf unit suite is not executed by any gate job or CI workflow today and must be, and there is no PDF parity fixture proving WOFF2 custom-font embedding."

## Clarifications

### Session 2026-07-14

- Q: Beyond distinguishing the block declaration, how faithful must the highlighting of the source *inside* a diagram block be? → A: Full, parser-accurate formal grammar per diagram language, nested into the editor — each language's real lexical and structural elements are highlighted (not a generic/lightweight token coloring).
- Q: Which block languages must receive this inner syntax highlighting? → A: Diagram engines only — mermaid, graphviz/DOT, and vega / vega-lite (highlighted as JSON). Math blocks (stem/latexmath/asciimath) keep their existing STEM treatment; no LaTeX/AsciiMath inner tokenizing in v1.
- Q: Mermaid is a family of diagram types, each with its own sub-syntax. How broad must mermaid's inner highlighting be? → A: All mermaid diagram types — grammar-accurate highlighting for every diagram type mermaid supports (flowchart, sequence, class, state, ER, gantt, pie, and all rarer/newer types), applying the correct sub-syntax for the type declared at the top of the block.
- Q: Should the currently-unsupported engines (PlantUML, ditaa) be brought into scope, given that only a Java→WASM runtime could render them faithfully offline? → A: No — keep them out of v1 (unsupported-offline, skipped-with-warning). No non-Java engine renders their syntax at reference parity, and server rendering is disqualified by zero-source-egress. The skipped-with-warning message should point authors at the already-supported engines (mermaid for most PlantUML diagrams, graphviz for DOT). The Java→WASM (CheerpJ) route is captured as a future item, not v1.
- Q: The HTML (on-screen) preview does not render diagrams today (math already renders there via MathJax). Must it display diagrams too, and at what fidelity? → A: Yes — the HTML preview MUST display diagrams. Render them with each engine's **native, on-screen-optimal browser output** (not the prawn-svg-constrained PDF variant), injected safely (sanitized, XSS-safe) into the preview. The HTML preview is a screen view and is NOT held to the PDF reference-parity bar; preview and PDF diagram styling may differ slightly. Client-side/zero-egress still applies. Unsupported-offline engines (PlantUML/ditaa) show the same skipped-with-warning treatment in the preview.
- Q: Under zero-source-egress, how should a diagram that references an external/remote resource (e.g. a vega/vega-lite `data.url`, or a remote image) be handled? → A: Render from inline/embedded data only; any diagram referencing a remote (http/https) resource is skipped-with-warning, consistent with feature 039's existing "remote resources unsupported, not fetched" rule. No remote fetch is attempted.
- Q: Should generated diagram/math images carry alt text for accessibility, or stay empty-alt as today? → A: Derive meaningful alt text — from the block title/caption when present, else a sensible default (e.g. the engine name, or the math expression) — applied to the generated image in both the PDF export and the HTML preview. Alt text is invisible in the PDF's normal view, so it does not affect PDF visual parity.
- Q: No well-licensed, maintained grammar covers all mermaid diagram types, and hand-authoring ~20 conflicts with Reuse-Before-Rebuild (Principle IV). How should mermaid inner highlighting be scoped? → A: Reuse the maintained `codemirror-lang-mermaid` grammar for the diagram types it covers grammar-accurately (~flowchart, sequence, class, state, ER), AND provide a generic *lexical* fallback tokenizer (diagram-type keyword, `%%` comments, quoted labels, arrows/edges, node shapes) for every other mermaid type. This amends FR-021/SC-010: "grammar-accurate where a maintained grammar exists; consistent lexical highlighting otherwise" — every mermaid type is still highlighted, just not all at full-grammar fidelity. (vega/vega-lite = JSON via the existing lang-json; DOT = a faithful StreamParser.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Diagrams appear in the exported PDF (Priority: P1)

An author's document contains one or more diagram blocks written in a supported text notation (mermaid, graphviz/DOT, or vega / vega-lite). When they click **Export to PDF** — or watch the live PDF preview — each diagram block appears in the output as a rendered picture, placed exactly where the block sits in the document, and matching what the project's reference Asciidoctor-PDF toolchain produces for the same source. Today these blocks are silently dropped with a warning instead of being drawn.

**Why this priority**: Diagrams-as-code is a headline AsciiDoc authoring capability and a primary reason authors keep diagram source in the document rather than pasting static images. An export that omits every diagram is not trustworthy as a substitute for the reference build, which is the whole promise of feature 039. This is the largest user-visible gap remaining in the PDF feature.

**Independent Test**: Open a project whose top-level document embeds a mermaid, a graphviz, and a vega/vega-lite block, export to PDF, and confirm all three diagrams render as images in the correct positions, with no diagram-dropped warnings, and that the visual result matches the reference build for the same inputs.

**Acceptance Scenarios**:

1. **Given** a document with a `[mermaid]` block, **When** the user exports to PDF, **Then** the diagram is rendered as an image at that position and no "diagram engine has no offline renderer" or "block was skipped" warning is raised for it.
2. **Given** a document with a `[graphviz]` block and a `[vega]` (or `[vega-lite]`) block, **When** the user exports, **Then** both render as images in document order.
3. **Given** the live PDF preview is open, **When** a diagram block's source is edited, **Then** the preview updates to show the re-rendered diagram without a manual export step and without freezing the editor.
4. **Given** an unchanged diagram block re-exported or re-previewed, **When** rendering runs again, **Then** the previously rendered image is reused (identical source produces an identical, stably placed image) rather than re-rendered from scratch.
5. **Given** any diagram block, **When** rendering occurs, **Then** no diagram source or referenced URL is transmitted to any server (the render happens entirely in the browser).

---

### User Story 2 - Math renders in the exported PDF (Priority: P1)

An author's document contains STEM math — block math (a `[stem]`, `[latexmath]`, or `[asciimath]` delimited block) and inline math macros (`stem:[…]`, `latexmath:[…]`, `asciimath:[…]`) in running prose. When they export or preview, each math expression appears as a properly typeset image, both for standalone block equations and for math embedded mid-sentence, matching the reference toolchain. Today math blocks are dropped with a warning.

**Why this priority**: Technical specifications (the target documents for this product, e.g. metering specifications) routinely carry equations. Math shares the exact same rendering-path limitation as diagrams and is delivered by the same mechanism, so it is P1 alongside Story 1.

**Independent Test**: Export a document containing a `[stem]` block equation and a sentence with an inline `stem:[…]` expression and confirm both appear as typeset images in the PDF at the correct positions, matching the reference build.

**Acceptance Scenarios**:

1. **Given** a document with a `[stem]` (or `[latexmath]`/`[asciimath]`) block, **When** the user exports, **Then** the equation renders as a typeset image at that position with no math-dropped warning.
2. **Given** a paragraph containing an inline `stem:[…]` macro, **When** the user exports, **Then** the inline expression renders inline within the surrounding text rather than being dropped or shown as raw source.
3. **Given** math notation that appears inside a verbatim block (listing/literal/passthrough), **When** the user exports, **Then** that text is left untouched (not interpreted as math).
4. **Given** any math expression, **When** rendering occurs, **Then** no source content is transmitted to any server.

---

### User Story 3 - Rendering failures are surfaced, never silent (Priority: P2)

When a specific diagram or math block cannot be rendered — malformed source, or an engine that has no offline renderer (e.g. PlantUML/ditaa) — the author is shown a clear, per-block warning identifying which block failed and why, while every other block in the document still renders and the export still completes. A single bad block never aborts the whole export or corrupts placement of the good blocks.

**Why this priority**: Fail-soft, transparent diagnostics are what make an offline renderer trustworthy: authors must be able to distinguish "this engine isn't supported offline" from "my syntax is wrong" from "it worked." This layers on top of the P1 rendering and reuses the existing diagnostics surface, so it is P2.

**Independent Test**: Export a document mixing one valid mermaid block, one syntactically broken mermaid block, and one PlantUML block; confirm the valid block renders, the broken block and the PlantUML block each produce a distinct, located warning, and the export still succeeds with all other content intact.

**Acceptance Scenarios**:

1. **Given** a malformed diagram or math block, **When** the user exports, **Then** a located warning names the offending block and the rest of the document still renders.
2. **Given** a diagram in an engine with no offline renderer (PlantUML, ditaa), **When** the user exports, **Then** a warning explains the engine is unsupported offline and the block is skipped (never fetched from a network service).
3. **Given** a diagram whose vector output uses a feature the PDF renderer cannot draw, **When** the user exports, **Then** the block still appears (via an image fallback) and a warning notes the fallback occurred.
4. **Given** a vega/vega-lite block whose spec references a remote data `url` (or a diagram pulling a remote image), **When** the user exports or previews, **Then** the remote resource is NOT fetched and the block is skipped-with-warning naming the unreachable resource, while every other block still renders.

---

### User Story 4 - Diagram blocks are highlighted in their own language (Priority: P2)

While writing, an author can (a) tell a diagram block (mermaid, graphviz/DOT, vega/vega-lite) apart from an ordinary listing or source-code block at a glance, and (b) read the diagram source itself with syntax highlighting native to that diagram language — mermaid keywords for the declared mermaid diagram type, DOT graph/edge/attribute structure, or JSON structure for vega/vega-lite — just as they would when editing that language in a dedicated editor. The author does not have to read a wall of uncolored text to author a diagram.

**Why this priority**: Now that diagram blocks produce visible output, authors need to recognise them and edit their source comfortably. Language-accurate inner highlighting materially improves authoring of non-trivial diagrams. Highlighting is an editor-only enhancement independent of the PDF pipeline, so it can ship and be tested on its own; it is P2 because the rendering (Stories 1–2) is the core value.

**Independent Test**: Type a `[mermaid]` flowchart block, a `[graphviz]` DOT block, and a `[vega-lite]` JSON block, plus a `[source,ruby]` listing block, into the editor; confirm each diagram block's declaration is distinct from the generic source/listing block AND the source inside each diagram block is highlighted according to that diagram language's own grammar (mermaid, DOT, and JSON respectively).

**Acceptance Scenarios**:

1. **Given** the editor with a `[mermaid]`, `[graphviz]`, or `[vega]`/`[vega-lite]` block, **When** the document is displayed, **Then** the diagram block's declaration is highlighted in a way visually distinct from a generic `[source,…]` or plain listing block.
2. **Given** a `[mermaid]` block, **When** displayed, **Then** its body is highlighted with grammar-accurate mermaid highlighting for the diagram type declared on its first content line (e.g. `flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram`, `gantt`, …), covering every mermaid diagram type.
3. **Given** a `[graphviz]` block, **When** displayed, **Then** its body is highlighted with DOT-language highlighting (graph/digraph keywords, node/edge operators, attribute lists); **and given** a `[vega]`/`[vega-lite]` block, its body is highlighted as JSON.
4. **Given** a diagram block, **When** it is highlighted, **Then** neither the declaration highlighting nor the inner-language highlighting bleeds into the surrounding AsciiDoc, and an ordinary listing/source block is still highlighted as before.
5. **Given** a math block (`[stem]`/`[latexmath]`/`[asciimath]`), **When** displayed, **Then** it keeps its existing STEM treatment (no LaTeX/AsciiMath inner tokenizing in v1) and that treatment does not regress.

---

### User Story 5 - PDF rendering package is guarded by the quality gate (Priority: P2)

The team's automated quality gate and CI run the PDF rendering package's unit suite on every change and enforce its coverage threshold, and the PDF parity suite includes a fixture proving that a custom WOFF2 web font embeds faithfully. A change that breaks PDF rendering logic or drops its coverage below threshold, or that regresses WOFF2 font embedding, is caught automatically rather than shipping unnoticed.

**Why this priority**: This work stream touches the PDF rendering package heavily, and that package's tests currently run in no gate job or CI workflow, so regressions in it are invisible to automation. Closing the gap protects Stories 1–3 going forward. It is P2 because it hardens rather than delivers user-facing behaviour.

**Independent Test**: Introduce a deliberate regression in the PDF rendering package and confirm the standard quality-gate command fails; separately, run the parity suite and confirm a WOFF2-font fixture is exercised and its output matches its committed reference.

**Acceptance Scenarios**:

1. **Given** the standard quality-gate run, **When** it executes, **Then** the PDF rendering package's unit suite runs and its coverage threshold is enforced as part of the gate.
2. **Given** the CI pipeline, **When** it runs on a change, **Then** the same PDF rendering package suite runs there too (the gate and CI stay unified).
3. **Given** the PDF parity suite, **When** it runs, **Then** a fixture whose theme uses a custom WOFF2 font is rendered and compared against a committed reference, proving WOFF2 fonts embed.
4. **Given** a regression that lowers PDF-package coverage below its threshold or breaks WOFF2 embedding, **When** the gate/CI runs, **Then** it fails and identifies the problem.

---

### User Story 6 - Diagrams appear in the HTML preview (Priority: P2)

An author with the HTML (on-screen) preview panel open sees their diagram blocks rendered as pictures in the preview, updating as they edit, just as math already renders there. They do not have to export a PDF to see whether a diagram is correct. The rendered diagram is tuned for on-screen readability (its native browser output), not the print-constrained PDF variant.

**Why this priority**: The HTML preview is the primary, always-open in-editor feedback surface, and today a diagram block shows as raw source or an empty block there. Rendering diagrams in it gives immediate authoring feedback and is independent of the PDF path, so it can ship and be tested on its own. It is P2 because the PDF export/preview (Stories 1–2) is the feature's core.

**Independent Test**: Open the HTML preview on a document containing a mermaid, a graphviz, and a vega/vega-lite block; confirm all three render as on-screen diagrams, update when their source is edited, and that a document with no diagrams is unaffected.

**Acceptance Scenarios**:

1. **Given** the HTML preview is open on a document with a `[mermaid]`, `[graphviz]`, or `[vega]`/`[vega-lite]` block, **When** the preview renders, **Then** each diagram appears as a rendered image in place of its source.
2. **Given** a diagram block's source is edited, **When** the preview updates, **Then** the rendered diagram updates to match, without a manual export step.
3. **Given** diagram source (untrusted collaborative content), **When** it is rendered into the preview, **Then** the output is sanitized/sandboxed so the diagram source cannot inject script or unsafe markup.
4. **Given** an unsupported-offline engine (PlantUML/ditaa) or a malformed block, **When** the preview renders, **Then** it shows the same skipped/failed treatment (a placeholder/warning) rather than breaking the preview, and every other block still renders.
5. **Given** any diagram in the HTML preview, **When** it renders, **Then** rendering happens entirely client-side with no diagram source or referenced URL sent to a server.

---

### Edge Cases

- **Repeated identical blocks**: two diagram blocks with identical source render once and reuse the same image (content-addressed), keeping export deterministic and fast.
- **Inline math adjacent to punctuation / multiple per line**: several inline math macros on one line each render independently and the surrounding prose (including punctuation between them) is preserved verbatim.
- **Math-like text inside verbatim blocks**: `stem:[…]`-looking text inside a listing/literal/passthrough block is copied through untouched, not rendered.
- **Diagram source that fails only in the PDF vector renderer** (e.g. uses HTML-in-SVG the PDF engine can't draw): falls back to a raster image so the diagram still appears, with a warning.
- **A block whose engine is recognised but has no offline renderer** (PlantUML, ditaa): skipped with a clear warning, never network-fetched.
- **A diagram referencing a remote resource** (vega `data.url`, remote image): not fetched; skipped-with-warning that names the unreachable resource — never a silent empty render (FR-027).
- **A generated diagram/math image's alt text**: taken from the block title/caption when present, else a sensible default; never left empty (FR-028).
- **Live preview under rapid edits to a diagram block**: the preview coalesces updates so the editor stays responsive and a superseded render does not overwrite a newer one.
- **A very large or pathological diagram** that is slow to render: must not hang the editor UI; rendering happens off the critical typing path.
- **Diagram highlighting vs. an attribute line that merely mentions a diagram word**: only a genuine diagram block declaration (attribute line immediately followed by a block delimiter) is highlighted as a diagram, not arbitrary prose containing the word "mermaid".
- **Unknown mermaid diagram type or malformed diagram source in the editor**: inner highlighting degrades gracefully (plain or partial coloring) and never breaks highlighting of the block delimiters or the surrounding document.
- **Very large diagram block body**: inner-language highlighting must not degrade editor typing responsiveness.

## Requirements *(mandatory)*

### Functional Requirements

**Diagram & math rendering in the PDF export/preview**

- **FR-001**: The in-browser PDF export MUST render supported diagram blocks — mermaid, graphviz/DOT, and vega / vega-lite — as images embedded at the block's position in the output.
- **FR-002**: The in-browser PDF export MUST render STEM math — `stem`, `latexmath`, and `asciimath` — for both delimited math blocks and inline math macros, as typeset images at their positions.
- **FR-003**: The live PDF preview MUST render diagrams and math using the same rendering path as the export, so preview and export agree for the same document state.
- **FR-004**: Rendered diagrams and math MUST match the project's reference Asciidoctor-PDF toolchain output for the same inputs, to the same fidelity bar the rest of feature 039 is held to.
- **FR-005**: All diagram and math rendering MUST happen entirely within the browser; no diagram/math source, and no URL referenced by it, may be transmitted to any server during rendering (preserving the feature-039 zero-source-egress guarantee).
- **FR-006**: Identical diagram/math source MUST render to a stable, reused image (content-addressed), so an unchanged block does not re-render across repeated exports/previews and its placement stays stable.
- **FR-007**: Rendering MUST be fail-soft per block: a malformed block or a shim/engine failure MUST record a located diagnostic and leave that block's surrounding document intact, while every other block still renders and the export/preview still completes.
- **FR-008**: A diagram engine with no offline client-side renderer (e.g. PlantUML, ditaa) MUST be skipped with a warning and MUST NOT be fetched from any network service. The warning SHOULD name the unsupported engine and point the author at the supported alternatives (mermaid for most PlantUML-style diagrams, graphviz/DOT), rather than only stating the block was skipped.
- **FR-009**: When a diagram's vector output cannot be drawn by the PDF renderer, the system MUST fall back to a raster image so the diagram still appears, and MUST warn that the fallback occurred.
- **FR-010**: Diagram/math rendering MUST NOT block the editor's typing responsiveness; the DOM-bound rendering work MUST run off the critical typing path and MUST coalesce rapid successive requests so a superseded render never overwrites a newer result.
- **FR-011**: The set of blocks eligible for rendering and the diagnostics they raise MUST be consistent between preview and export (a block that renders in preview renders in export, and one that warns in preview warns in export).
- **FR-027**: Diagrams MUST render only from inline/embedded data. A diagram that references an external/remote (http/https) resource — e.g. a vega/vega-lite `data.url`, or a remote image — MUST NOT be fetched and MUST be skipped-with-warning (consistent with feature 039's remote-resources rule). This applies to the PDF export/preview and the HTML preview alike.
- **FR-028**: Each generated diagram/math image MUST carry meaningful alt text — derived from the block's title/caption when present, else a sensible default (e.g. the engine/notation name, or the math expression) — in both the PDF export and the HTML preview. (Alt text does not affect PDF visual parity.)

**Diagrams in the HTML preview**

- **FR-023**: The HTML (on-screen) preview MUST render supported diagram blocks (mermaid, graphviz/DOT, vega, vega-lite) as images in place of their source, updating as the document is edited. (Math already renders in the HTML preview and MUST continue to.)
- **FR-024**: HTML-preview diagrams MUST render with each engine's native, on-screen-optimal output (readability-first), and are NOT required to match the PDF's prawn-svg-constrained rendering or the reference-parity bar; preview and PDF diagram styling MAY differ.
- **FR-025**: Rendering diagram source into the HTML preview MUST be XSS-safe: the source is untrusted collaborative content, so rendered output MUST be sanitized/sandboxed and MUST NOT allow script or unsafe-markup injection.
- **FR-026**: HTML-preview diagram rendering MUST be client-side only (no diagram source or referenced URL sent to a server) and MUST be fail-soft — an unsupported-offline engine (PlantUML/ditaa) or a malformed block shows a placeholder/warning without breaking the rest of the preview.

**Editor diagram highlighting**

- **FR-012**: The editor MUST visually distinguish a diagram block declaration (mermaid, graphviz, vega, vega-lite) from a generic listing or source-code block, so an author can identify diagram blocks at a glance.
- **FR-013**: Diagram highlighting MUST apply only to genuine diagram block declarations (an attribute line immediately followed by a block delimiter), and MUST NOT misclassify ordinary prose, listing blocks, or source blocks.
- **FR-014**: Adding diagram highlighting MUST NOT regress existing highlighting of listing, source, math (STEM), or other blocks.
- **FR-015**: The set of block names the editor recognises as diagrams MUST be consistent with the set the PDF pipeline renders as diagrams, so what looks like a diagram in the editor is what renders as a diagram on export.
- **FR-020**: The editor MUST highlight the source *inside* a diagram block using that diagram language's own syntax, with parser-accurate (formal-grammar) fidelity — mermaid, graphviz/DOT, and vega / vega-lite (highlighted as JSON) — so each language's lexical and structural elements are colored correctly, not merely a generic token coloring.
- **FR-021**: Mermaid inner highlighting MUST cover every mermaid diagram type: **grammar-accurate** highlighting for the types a maintained, reused grammar (`codemirror-lang-mermaid`) supports (flowchart, sequence, class, state, ER), and a **consistent lexical fallback** (diagram-type keyword, `%%` comments, quoted labels, arrows/edges, node shapes) for every other type. The diagram-type keyword on the block's first content line selects the treatment. No mermaid type is left with plain, uncolored text. (Reuse-Before-Rebuild: hand-authoring grammar-accurate parsers for all ~20+ types is out of scope — see Out of Scope.)
- **FR-022**: Inner diagram highlighting MUST be scoped to the diagram block body only: it MUST NOT bleed into the surrounding AsciiDoc, and it MUST NOT apply LaTeX/AsciiMath inner tokenizing to math blocks (`stem`/`latexmath`/`asciimath`), which keep their existing STEM treatment in v1.

**CI / quality-gate hygiene**

- **FR-016**: The PDF rendering package's unit suite MUST be executed by the standard quality-gate run, with its coverage threshold enforced there.
- **FR-017**: The CI pipeline MUST run the same PDF rendering package suite, keeping CI and the local gate unified (no gate-only or CI-only coverage of that package).
- **FR-018**: The PDF parity suite MUST include a fixture whose theme uses a custom WOFF2 font, rendered and compared against a committed reference output, proving WOFF2 fonts embed faithfully (the existing custom-font fixture ships TTF only).
- **FR-019**: A regression that breaks PDF rendering logic, lowers the PDF package's coverage below its threshold, or breaks WOFF2 font embedding MUST cause the gate/CI to fail and identify the failure.

### Key Entities

- **Diagram block**: an author-written, text-notation diagram (mermaid, graphviz/DOT, vega, vega-lite) declared in the document; rendered to an image on export/preview. Attributes: notation/engine name, source text, position in document, optional block parameters.
- **Math expression**: a STEM expression in `stem`/`latexmath`/`asciimath` notation, either a delimited block or an inline macro; rendered to a typeset image. Attributes: notation, expression source, block-vs-inline, position.
- **Generated image asset**: the rendered output of a diagram or math block, addressed by a hash of its source so identical inputs reuse the same asset; carries format (vector/raster), a raster-fallback marker, and alt text (from the block title/caption or a sensible default).
- **Render diagnostic**: a per-block warning/error surfaced to the author — unsupported-offline-engine, malformed source, raster-fallback, etc. — with the location (file + line) of the offending block.
- **WOFF2 font parity fixture**: a self-contained test project whose PDF theme references a custom WOFF2 font, plus its committed reference PDF, used to prove faithful font embedding.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A representative document containing at least one mermaid, one graphviz, and one vega/vega-lite diagram exports to a PDF in which **100% of those diagram blocks appear as rendered images** in their correct positions, with **zero** diagram-dropped warnings.
- **SC-002**: A document containing block and inline STEM math exports to a PDF in which **100% of the math expressions appear as typeset images**, inline expressions remaining inline within their prose.
- **SC-003**: For the diagram and math parity fixtures, the in-app export is **visually equivalent to the reference Asciidoctor-PDF build** at the same fidelity bar used for the rest of feature 039 (parity fixtures pass).
- **SC-004**: During any diagram/math export or preview, **no document source or referenced URL is transmitted to a server** (verifiable by network inspection): zero source-bearing requests.
- **SC-005**: Editing a diagram block's source updates the live PDF preview to the re-rendered diagram **without a manual export**, and the editor **remains interactive throughout** (typing is never blocked).
- **SC-006**: A document mixing a valid block, a malformed block, and an unsupported-offline-engine block **still exports successfully**, with each failing block producing a distinct located warning and every other block rendered — a single bad block never aborts the export.
- **SC-007**: In the editor, a diagram block declaration is rendered **visually distinct from a generic listing/source block** for all supported diagram notations, with **no regression** to existing block highlighting.
- **SC-008**: The standard quality-gate command runs the PDF rendering package's unit suite and enforces its coverage threshold; a deliberately introduced regression in that package **causes the gate to fail**.
- **SC-009**: The parity suite includes a WOFF2-font fixture that **renders and matches its committed reference**, and a break in WOFF2 embedding causes that check to fail.
- **SC-010**: Inside a diagram block, the source is highlighted per that diagram language — DOT graph/edge/attribute structure, JSON keys/strings/values for vega/vega-lite, and mermaid highlighted for **every** diagram type (grammar-accurate for the types `codemirror-lang-mermaid` covers, consistent lexical highlighting for the rest — never plain uncolored text) — with **no highlight bleed** into the surrounding AsciiDoc, verifiable across a fixture exercising each supported notation and a representative set of mermaid diagram types (both grammar-covered and fallback).
- **SC-011**: With the HTML preview open on a document containing a mermaid, a graphviz, and a vega/vega-lite block, **100% of those diagrams render on-screen** and update when their source is edited within the preview's normal responsiveness budget — updates coalesce behind the existing preview debounce and the editor stays interactive throughout (a simulated keystroke serviced within the same 100 ms interaction budget verified for the PDF pre-pass; see SC-005) — with no diagram source or referenced URL sent to a server, and no script/unsafe-markup injectable from diagram source.

## Assumptions

- The existing `diagrams-math` pipeline stage, the diagram/math render shims (mermaid, graphviz, vega, mathjax), the content-addressed asset cache, and the diagnostics surface are correct and already proven under the parity test harness; this feature makes them reachable from the real export/preview path rather than reimplementing them. The core remaining work is to run the DOM-bound renderers where a DOM exists and feed the rendered vector output into the PDF worker's pipeline.
- The supported diagram engines for v1 are exactly mermaid, graphviz/DOT, and vega / vega-lite; PlantUML and ditaa remain explicitly unsupported-offline (skipped with a warning). No new diagram engine is added by this feature.
- Fully offline operation from feature 039 continues to hold: remote resources referenced by diagrams are unsupported and skipped-with-warning, not fetched (FR-027). Diagrams render from inline/embedded data only; project-local data-file resolution for vega is out of scope for v1 (see Out of Scope).
- The HTML (on-screen) preview already renders STEM math (via MathJax, gated on in-effect `:stem:`); this feature does NOT change math in the HTML preview, only adds diagram rendering there. The HTML preview renders diagrams with the engines' native on-screen output and is not held to the PDF reference-parity bar (unlike the PDF export/preview). Diagram source is untrusted collaborative content, so preview rendering must stay XSS-safe (sanitized/sandboxed, engines in strict mode).
- Reference parity is judged with the same tooling and fidelity bar already established for feature 039's parity suite; this feature adds diagram, math, and WOFF2-font fixtures to that existing suite rather than defining a new fidelity standard.
- Editor diagram highlighting is a presentation-only change to the editor's existing highlighting mechanism; it introduces no new document syntax and does not change how diagram blocks are authored.
- "Consistent block-name set" (FR-015) is satisfied by a single shared source of truth for which notations are diagrams, referenced by both the editor and the PDF pipeline, so the two cannot drift.
- The WOFF2 parity fixture reuses the existing parity harness and comparison mechanism; only the fixture project and its committed reference output are new.
- Inner/nested highlighting of the diagram source **is in scope** (see Clarifications): each diagram language is highlighted by its own formal grammar nested into the editor — mermaid covering all its diagram types, graphviz as DOT, vega/vega-lite as JSON. Where a maintained grammar/language definition for one of these already exists, it should be reused rather than hand-authored, to bound effort. Math notations (latexmath/asciimath) are **not** inner-tokenized in v1 — math blocks keep their existing STEM treatment.
- Inner highlighting must remain compatible with the collaborative editor: it is a display concern layered on the existing editor/grammar mechanism and does not change document content, cursor sharing, or how diagram blocks are authored.
- An unrecognised mermaid diagram-type keyword, or malformed/incomplete diagram source, must degrade gracefully in the editor (fall back to plain/partial highlighting) and never break highlighting of the surrounding document.

## Out of Scope (v1)

- **PlantUML and ditaa rendering.** They remain unsupported-offline (skipped-with-warning). Faithful offline support would require running the real Java engines via a Java→WASM runtime (e.g. CheerpJ) — a multi-MB JVM+jar payload on top of the existing wasm, plus a licensing sign-off — and no non-Java engine renders their syntax at reference parity. Captured as a possible future feature; ditaa (small jar, raster output) is the more tractable of the two if revisited.
- **Grammar-accurate highlighting of mermaid diagram types beyond what `codemirror-lang-mermaid` covers.** Those types get consistent lexical highlighting instead (FR-021). Hand-authoring/porting ~20 per-type grammars conflicts with Reuse-Before-Rebuild and is deferred.
- **Inner (grammar) highlighting of math notations** (latexmath/asciimath). Math blocks keep their existing STEM treatment in v1.
- **Inner highlighting of unsupported diagram engines** (PlantUML/ditaa source) beyond generic/plain treatment.
- **Resolving vega/vega-lite (or other diagram) data references to project-local files.** v1 renders from inline/embedded data only; a diagram referencing any external data `url` is skipped-with-warning (FR-027). Project-local data-file resolution via the VFS is a possible future enhancement.

## Dependencies

- Feature 039 (In-Browser PDF Export) is the substrate: its worker, pipeline orchestrator, VFS, shim registry, parity harness, and diagnostics panel are all reused. This feature completes 039's deferred FR-007 (diagrams) and FR-008 (math).
- The editor's existing AsciiDoc grammar / syntax-highlighting mechanism (feature 030) is the substrate for the diagram-highlighting work.
- The existing quality-gate runner and CI workflow are the substrate for the coverage-hygiene work.
