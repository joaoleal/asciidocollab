# Feature Specification: Page-Formatted Render Performance

**Feature Branch**: `044-pdf-render-performance`

**Created**: 2026-07-30

**Status**: Draft

**Input**: Gap review of an incremental-PDF-rendering proposal against `043-preview-responsiveness`.
The proposal's premise is that page-formatted layout is a single forward pass, so a preview cannot
render "just the visible pages" — it can only skip the head, stop early, or make chunks independent.
That premise is sound and its consequences are recorded in Out of Scope. What the review found,
however, is that the page-formatted path repeats a large amount of work it has already done, on every
single refresh: every project file and every image is re-copied into the render environment, every
font is re-decoded, every diagram is re-rendered before its content hash is even consulted, and every
page of the resulting document is re-rasterised. None of that is inherent to the single forward pass.
It is waste that exists independently of the layout model, and it is removable without touching
layout at all.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The preview stops repeating work it has already done (Priority: P1)

As an author editing a document with images, diagrams and a custom theme, I want each refresh to redo
only what my edit actually affected, so the preview keeps up with me instead of rebuilding its whole
world every time I type.

**Why this priority**: it is the largest measured waste on the path and the cheapest to remove — in
two of the three cases the mechanism that would avoid the work already exists in the codebase and is
simply not used. It is also the only part of this feature that is unaffected by the outcome of the
page-format render VM question in `043` (FR-028), because none of it depends on state surviving
inside that VM.

**Independent Test**: edit one paragraph of prose in a project containing several images, a custom
theme with embedded fonts, and several diagrams. Confirm that the refresh re-renders no diagram,
re-copies no image, and re-decodes no font, while producing the same document as a first render.

**Acceptance Scenarios**:

1. **Given** a document containing diagrams, **When** the author edits prose that is not part of any
   diagram, **Then** no diagram is re-rendered and the previously generated output is reused.
2. **Given** a project containing images, **When** a refresh occurs after an edit that touched only
   one text file, **Then** the unchanged images are not re-copied into the render environment.
3. **Given** a theme carrying embedded fonts, **When** successive refreshes occur, **Then** each font
   is decoded once rather than once per refresh.
4. **Given** any of the above reuse, **When** the underlying source genuinely changes, **Then** the
   affected item is regenerated — reuse never outlives the thing it was derived from.
5. **Given** a file deleted from the project, **When** the next refresh occurs, **Then** the deleted
   file is no longer visible to the render, rather than persisting because only additions were
   applied.
6. **Given** a render that reuses previous work, **When** its output is compared against a render
   performed from a cold state on the same source, **Then** the two documents are identical.

---

### User Story 2 - Long documents stop redrawing every page on every refresh (Priority: P1)

As an author working on a document of a hundred pages or more, I want the preview to draw the pages I
am looking at rather than all of them, so that scrolling and editing stay responsive as the document
grows.

**Why this priority**: it is the single largest cost on a long document and it is entirely
independent of how the document is generated — it is display work, not layout work. It was
previously believed to be solved; it is not (see Diagnostic Evidence, row 4).

**Independent Test**: open a document of at least a hundred pages, refresh it, and confirm that the
work performed on refresh is proportional to the pages on screen rather than to the document's
length, and that scrolling to a page not yet drawn produces that page.

**Acceptance Scenarios**:

1. **Given** a document far longer than one screen, **When** a refresh commits a new rendering,
   **Then** the work performed is proportional to the visible region, not to the total page count.
2. **Given** such a document, **When** the author scrolls to a region not yet drawn, **Then** that
   region is drawn, without the author having to wait for the whole document.
3. **Given** a refresh, **When** the new rendering replaces the old, **Then** the panel does not blank
   — the behaviour that the current all-at-once swap achieves MUST be preserved by whatever replaces
   it.
4. **Given** a page the author can see or interact with, **When** it is drawn, **Then** its selectable
   text and its internal links work as they do today.
5. **Given** the editor scrolls the preview to a source line, **When** the target page has not been
   drawn, **Then** it is drawn and scrolled to — existing scroll synchronisation MUST NOT regress.
6. **Given** the author changes the zoom level, **When** the pages are redrawn at the new scale,
   **Then** the same visible-region proportionality applies.

---

### User Story 3 - What comes next is decided by measurement (Priority: P2)

As a developer, I want every optimisation beyond the two stories above to name the measured cost it
targets, so that expensive work is undertaken on evidence rather than on a plausible account of where
the time goes.

**Why this priority**: it is a governance requirement rather than a user-facing one, but it is what
keeps this feature from growing into the months-long project its Out of Scope section declines. The
per-stage measurement it consumes is delivered by `043` (FR-022a–FR-022c) and recorded in that
feature's baseline artifact.

**Independent Test**: attempt to justify any gated requirement below without citing a recorded stage
figure, and confirm the requirement's own wording forbids it.

**Acceptance Scenarios**:

1. **Given** the per-stage baseline recorded by `043`, **When** a gated requirement in this feature is
   taken up, **Then** the stage it targets and the figure justifying it are named.
2. **Given** a gated requirement whose target stage proves immaterial, **When** the baseline is
   consulted, **Then** the requirement is closed as unnecessary and that outcome is recorded, rather
   than being left open indefinitely.

---

### Edge Cases

- **A change set that is incomplete**: reusing state across renders is only safe if every change is
  reported. A file that changed but was omitted from the change set renders stale content that looks
  correct — the worst possible failure, because nothing signals it.
- **A file removed from the project**: additions and modifications are the obvious cases; removal is
  the one a naive delta misses, and the render environment currently never prunes.
- **A diagram that failed to render**: a failure must not be cached as though it were a result, or a
  transient failure becomes permanent.
- **A cache outliving the thing it describes**: a theme change alters font handling and diagram
  parameters without altering the document source, so a cache keyed on source alone would serve stale
  output after a theme edit.
- **Rapid edits during a long render**: the render environment cannot be interrupted mid-convert
  (Diagnostic Evidence row 5), so caching must not assume a render can be abandoned partway.
- **The page-format render VM's reuse policy changing underneath this work**: `043` FR-028a may remove
  VM reuse entirely. Anything cached inside that VM would then be void.
- **Zoom or resize during a partial draw**: pages drawn at the previous scale must not be left mixed
  with pages drawn at the new one.
- **A document shorter than one screen**: visible-region drawing must not add overhead or complexity
  where the whole document is already visible.

## Requirements *(mandatory)*

### Reuse between renders

- **FR-001**: A diagram whose source and rendering parameters are unchanged since a previous render
  MUST NOT be re-rendered. The identifying hash for this decision is already computed today, but only
  *after* the rendering has been performed, so it can record what was produced and can never prevent
  producing it. Computing it first is the requirement.
- **FR-002**: Project content unchanged since the previous render MUST NOT be re-written into the
  render environment. A delta mechanism for this already exists and is deliberately not used by the
  application; this requirement is satisfied by using it, not by building a second one.
- **FR-002a**: The set of changes reported to the render environment MUST be complete, and MUST
  include removals. A render that reuses environment state is only as correct as its change set: an
  omitted modification renders stale content indistinguishable from fresh, and an omitted removal
  leaves deleted content resolvable by includes and image references. The render environment does not
  prune today, so removal is the case that must be added rather than merely preserved.
- **FR-003**: A font whose bytes are unchanged MUST NOT be decoded again on a later render. Only the
  decoder's own initialisation is reused today; the decoded result is discarded and recomputed per
  render, per font.
- **FR-004**: Every cache introduced by this feature MUST be content-addressed and bounded, consistent
  with the existing generated-asset cache rather than introducing a second caching discipline
  (Principle IV, Principle XII).
- **FR-004a**: A failed generation MUST NOT be cached as a result. "Unchanged source" and
  "successfully produced" are different conditions, and conflating them makes a transient failure
  permanent.
- **FR-004b**: Reuse MUST be keyed on everything that affects the output, not on document source
  alone — a theme change alters both font handling and diagram rendering parameters without changing
  a single character of the document.
- **FR-004c**: For any document, a render that reuses prior work MUST produce output identical to a
  render of the same source from a cold state. This is the correctness gate for the entire story:
  caching that changes output is not an optimisation.

### Drawing only what is on screen

- **FR-005**: The page-formatted preview MUST draw pages in proportion to what is visible rather than
  drawing every page of the document on every refresh. This is display work, independent of how the
  document was generated, and it is the only part of this feature that the single-forward-pass layout
  constraint does not touch.
- **FR-005a**: Pages not yet drawn MUST be drawn when the reader reaches them, without requiring a
  further edit or refresh.
- **FR-005b**: The absence of a blank panel during a refresh MUST be preserved. This is currently
  achieved by drawing everything off-screen and swapping it in atomically — an approach that is
  incompatible with drawing progressively, so the guarantee must be re-established by other means
  rather than assumed to survive.
- **FR-005c**: Selectable text and working internal links MUST remain available on every page the
  reader can see or interact with.
- **FR-005d**: Editor-driven scroll synchronisation MUST continue to work, including where its target
  page has not yet been drawn.
- **FR-005e**: A change of zoom level MUST NOT leave pages drawn at different scales visible
  simultaneously.

### Measurement gating

- **FR-006**: No optimisation beyond FR-001–FR-005e MAY be undertaken in this feature until the
  per-stage render cost required by `043` FR-022a is recorded in that feature's baseline artifact.
  Each such optimisation MUST name the stage it targets and the recorded figure that justifies it.
  This requirement exists because the remaining candidates are individually expensive and their
  relative cost is currently unknown; every ranking of them so far has been an argument rather than a
  measurement.
- **FR-007**: Any cache this feature introduces MUST remain correct under whichever page-format render
  VM reuse policy `043` FR-028a settles on. Where a proposed cache can only live inside that VM, it
  MUST NOT be built until that policy is settled — if VM reuse is removed, such a cache has no
  lifetime to occupy and the work would be discarded.

#### Gated requirements

Each of the following is conditional on FR-006. They are recorded rather than omitted so that the
reasoning survives, and so that a decision not to do them is visible as a decision.

- **FR-008** *(gated)*: Font parsing and glyph metrics MUST be reused across renders within the render
  environment, **if** the recorded per-stage figures show font parsing and subsetting to be a material
  share of render cost. Any such reuse MUST preserve the order-stability that the determinism standard
  already requires of font subsetting.
- **FR-009** *(gated)*: Decoded image data MUST be reused across renders within the render
  environment, **if** the recorded per-stage figures show image decoding and embedding to be a
  material share of render cost. FR-002 removes the cost of *transporting* images into the environment
  on every render; this requirement concerns the separate cost of *decoding* them, whose registry is
  scoped per document and therefore discards its work between renders.

### Key Entities

- **Change set**: the description of what differs between the current render and the previous one —
  additions, modifications and removals. Correctness of every reuse decision depends on its
  completeness.
- **Reuse key**: the content-derived identity under which a generated artifact is stored and matched.
  Covers the artifact's source and every parameter affecting its production.
- **Stage cost record**: the per-stage breakdown of one page-formatted render, produced by `043`
  FR-022a and consumed here as the gate on further work.
- **Visible region**: the part of the rendered document currently on screen, which determines how much
  drawing a refresh performs.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Editing prose in a project containing diagrams triggers zero diagram re-renderings,
  measured across a sustained editing session.
- **SC-002**: A refresh following an edit to a single text file re-transports zero unchanged files and
  zero unchanged images into the render environment.
- **SC-003**: Each embedded font is decoded once per session rather than once per render.
- **SC-004**: For every document in the shared fixture set, output produced with reuse in effect is
  identical to output produced from a cold state (FR-004c).
- **SC-005**: A file deleted from the project is not resolvable by the next render — zero occurrences
  of a removed file being included or referenced successfully.
- **SC-006**: On a document of at least a hundred pages, the drawing work performed by a refresh is
  proportional to the visible region rather than to the page count, measured against the figure
  recorded before this feature.
- **SC-007**: Zero blank-panel occurrences across repeated refreshes of a long document (FR-005b).
- **SC-008**: Editor-to-preview scroll synchronisation succeeds for targets on pages not yet drawn —
  zero failures.
- **SC-009**: Every optimisation undertaken beyond FR-005e cites a recorded stage figure; zero are
  undertaken without one.
- **SC-010**: Each gated requirement is closed by the baseline either being taken up or being recorded
  as unnecessary — zero remain open and unaddressed at feature completion.

## Assumptions

- The per-stage measurement required by `043` FR-022a is delivered and recorded before this feature's
  gated requirements are considered. Without it FR-006 cannot be satisfied and the gated requirements
  stay closed.
- The page-format render VM's reuse policy is settled by `043` FR-028a before any in-VM cache is
  built. The two possible outcomes lead to different work, and building for one before it is chosen
  risks discarding it.
- The change set available to the application is derivable from the editor's own knowledge of what
  changed. Where it is not derivable with certainty, the safe fallback is a full repopulation, which
  is today's unconditional behaviour — so an incomplete implementation degrades to current cost rather
  than to incorrect output.
- Drawing only the visible region is a display concern and does not alter generated output, so it is
  outside the reference-parity comparison the page-formatted path is held to.
- The preview and the export continue to produce the same document for the same source. Nothing in
  this feature changes what is generated; it changes only what is recomputed and what is drawn.

## Dependencies

**Delivery order**: User Story 1 → User Story 2 → User Story 3.

- User Stories 1 and 2 have no dependency on `043`'s outcome and may proceed as soon as this feature
  starts. Neither depends on state surviving inside the page-format render VM.
- User Story 3, and every gated requirement, depends on `043` FR-022a's per-stage measurement being
  recorded, and FR-007 additionally depends on `043` FR-028a's VM reuse decision.
- This feature MUST NOT begin before `043` has captured its baseline. `043`'s baseline is a
  one-shot capture of pre-change behaviour, and a performance change landing on the page-formatted
  path beforehand would invalidate figures that cannot be re-taken.
- The page-format reference-parity suite MUST continue to pass throughout, unchanged. FR-004c is the
  stronger local gate, but the external comparison is what catches a reuse defect that is consistent
  between the two renders being compared.

## Out of Scope

The proposal that prompted this feature also described a windowed, chunked and resumable rendering
model. None of it is taken up here. The reasoning is recorded rather than summarised away, because
each exclusion rests on a different ground and two of them conflict with requirements already
committed elsewhere.

- **Truncating the render at a page limit, and surfacing that truncation.** A truncated document has a
  wrong page count, an incomplete table of contents, unresolved cross-reference page targets and
  missing footnotes past the cut. **This conflicts with a committed requirement**: `040` FR-003
  requires the live preview to render "using the same rendering path as the export, so preview and
  export agree for the same document state", and FR-011 extends that agreement to eligible blocks and
  diagnostics. Deliberately making the preview a different document is exactly what those forbid.
  Taking this up requires amending `040` first, not working around it. Note also that the requirement
  most often cited in its favour — that the reader only waits for pages they can see — is largely
  served by FR-005 at a fraction of the cost and with none of the divergence.
- **Chunked rendering**: splitting at section boundaries, rendering chunks independently, merging the
  results, hashing subtrees for reuse, scheduling by proximity to the viewport, and running a pool of
  render environments. Excluded on the same conflict as truncation — forced page breaks at chunk
  boundaries and the loss of cross-chunk keep-together make the preview paginate differently from the
  export — and additionally on cost: it is weeks of work whose benefit is unmeasured. Worth noting
  that the memory budget it is usually costed against is already being paid: three separate render
  environments exist today, one each for preview, export and theme preview, sharing nothing (see
  Diagnostic Evidence row 6). Consolidating those is a cheaper first move than adding a pool.
- **Checkpointing and resuming layout state, form-object reuse, and separating measurement from
  placement.** Excluded on cost and risk, not on principle. Layout state is not a serialisable value;
  it is spread across the layout engine's instance state, the page collection and the object store,
  which implies holding a live object graph and deep-copying it at each checkpoint. Separating
  measurement from placement is the honest description of what any deep incremental approach signs up
  for, and it is a rewrite of the converter's central mechanism.
- **Rendering document-global values provisionally and patching them in a later pass.** Excluded as
  premature: it is only worth doing if a full layout is what the reader is waiting on, and FR-005
  changes what the reader waits on. Revisit if the measurement says otherwise.
- **Making the page-formatted preview a slower, deliberate view behind a longer delay, with the
  web-formatted preview as the keystroke-latency surface.** **This conflicts with a committed
  requirement**: `043` FR-004 applies one refresh guarantee to both preview formats under one
  interval, and its acceptance criteria assert that interval on both. The two surfaces are already
  tiered by *fidelity* — `040` records that the web-formatted preview is a screen view not held to the
  page-formatted parity bar — but no spec tiers them by *speed*, and `039` SC-004 sets the
  page-formatted path a sub-second warm re-render target, which is the opposite intent. Changing this
  is a decision to revisit `043` FR-004, not something to introduce alongside it.
- **Forking the layout library, and page-scoped output from the converter.** Already recorded as out
  of scope in `043`, with the upstream refusals. Restated here only so that this feature is not read
  as reopening them.
- **Interrupting a render in progress.** The convert runs synchronously and blocks its worker's event
  loop, so a cancellation message cannot even be received while it runs, and the platform build
  provides no shared memory through which a flag could be read instead. This is a structural
  constraint, not a missing feature; it is recorded here because any proposal to "check a cancellation
  flag between blocks" runs into it.

## Diagnostic Evidence *(non-normative — input to planning, not a requirement)*

Confirmed in the current code during the gap review that produced this specification. Recorded so
planning does not repeat the investigation. These describe the present state, not the required
solution.

| # | Observation | Confirmed detail |
|---|---|---|
| 1 | Every diagram is re-rendered on every refresh | The pre-render pass iterates every diagram block per refresh and computes the content hash only *after* rendering, so the hash records what was produced and can never prevent producing it. There is no cache on that side at all. |
| 2 | Every project file and image is re-transported per render | The population routine writes every text file and every binary asset unless a change set is supplied. The change-set parameter is implemented and the application deliberately omits it, with a comment recording that the whole environment is repopulated each render. Nothing prunes removed files. |
| 3 | Every font is re-decoded per render | Each font is decoded from its packaged form and rewritten on every render, with the theme catalogue re-pointed afterwards. Only the decoder's initialisation is memoised; the decoded bytes are not. |
| 4 | Every page is re-drawn on every new rendering | The paint routine loops the full page count and awaits a draw, a text layer and an annotation layer for each page, then swaps them all in at once. The only viewport observer present drives the page-number indicator, not drawing. The routine re-runs on every new document and on every scale change. |
| 5 | A render cannot be interrupted | The convert runs synchronously on the worker thread — deliberately, to avoid a stack overflow in the alternative — so the worker cannot dequeue a newer request while it runs. A cancellation message type exists in the protocol and is honoured by the controller, but nothing ever sends one; supersession discards stale results after the fact, having paid for them in full. |
| 6 | Three render environments exist where one would do | The export hook, the preview hook and the theme-preview hook each construct their own worker and boot their own environment. Nothing is shared between them — not the compiled module, not the generated-asset cache, not the populated environment. An export cannot benefit from the preview's warm state, or the reverse. |
| 7 | One reported counter is a constant | The raster-fallback count is hardcoded to zero while the stage that performs raster fallbacks tracks the real number. Being addressed in `043` (FR-022c), noted here because the figure has been cited as though measured. |
| 8 | Two proposed wins are already in place | The render environment is pre-booted on mount by both consuming hooks, and the output-size optimisation pass is already disabled for the preview and enabled only for the export. The latter is close to a no-op in any case: the optimiser is not bundled in the current environment build, so the pass is a capability probe and an early return. |
