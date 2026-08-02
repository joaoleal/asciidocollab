# Feature Specification: Live Preview Responsiveness

**Feature Branch**: `043-preview-responsiveness`

**Created**: 2026-07-26

**Status**: Draft

**Input**: User description: "Make the live preview feel as fast as it actually is. Measurement shows document conversion costs 6–540 ms depending on document size, while the preview's own scheduling and panel lifecycle add far more delay than the conversion itself. Fix the waste: a preview that only refreshes when typing stops, a preview engine that is thrown away and rebuilt every time the author switches file or preview mode, and a commit step that re-does every diagram and every equation on each keystroke. Add the measurement needed to prove it, and take the faster conversion engine once the scheduling no longer dominates."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The preview keeps refreshing while I keep typing (Priority: P1)

As an author writing a long passage without pausing, I want the preview to keep refreshing at a
predictable rhythm, so I can see my work take shape without deliberately stopping to trigger it.
Today the preview updates only when I stop typing; if I write continuously for a minute, the
preview sits frozen for that entire minute.

**Why this priority**: This is the largest gap between promised and actual behaviour, it affects
every author on every document, and it is the smallest slice in the feature. The product already
documents a guaranteed maximum staleness; it is simply not honoured.

**Independent Test**: Type continuously into a document for longer than the guaranteed refresh
interval without ever pausing. The preview updates at least once during that stretch, showing text
entered after the previous update. Fully testable on its own with no other story delivered.

**Acceptance Scenarios**:

1. **Given** an author typing continuously with no pause longer than the trailing delay, **When**
   the guaranteed maximum staleness interval elapses, **Then** the preview refreshes with the
   content entered so far.
2. **Given** an author who stops typing, **When** the trailing delay elapses, **Then** the preview
   refreshes exactly once and does not refresh again until further edits are made.
3. **Given** an author typing continuously for several times the maximum staleness interval,
   **When** the author finally stops, **Then** the preview has refreshed repeatedly during the
   burst, not only at the end.
4. **Given** the same continuous typing with the page-formatted preview shown instead of the
   web-formatted one, **When** the maximum staleness interval elapses, **Then** that preview also
   refreshes rather than waiting for a pause.
5. **Given** a document slow enough that a refresh takes longer than the guaranteed interval, **When**
   the interval elapses while that refresh is still running, **Then** no second refresh is started
   alongside it.
6. **Given** that suppressed case, **When** the running refresh finishes and edits made during it are
   still unreflected, **Then** a further refresh follows — the guarantee resumes rather than lapsing
   for the rest of the session.

---

### User Story 2 - Switching file or preview format shows the new content straight away (Priority: P1)

As an author moving between files in a project, I want the preview to show the newly opened file
promptly and without visible breakage, so navigating a multi-file document does not feel like
reloading the application. Today, opening a different file makes the preview show a
"not available for this file type" message, then a blank panel, before the new content appears
roughly a second later — and switching between the web-formatted and page-formatted preview costs
the same penalty.

**Why this priority**: File switching is the single most frequent navigation action in a multi-file
project, and it currently carries the worst-felt delay in the whole editor. The wasted work is
entirely self-inflicted: the rendering engine is discarded and rebuilt from scratch each time.

**Independent Test**: Open a project with several AsciiDoc files, click between them repeatedly,
and observe that each switch shows the new file's rendered content without an intervening error
message or blank panel, and noticeably faster than a full application reload.

**Acceptance Scenarios**:

1. **Given** two AsciiDoc files in a project, **When** the author switches from one to the other,
   **Then** no "preview not available" message and no empty preview panel appears at any point
   during the switch.
2. **Given** a file switch, **When** the new file's preview is still being produced, **Then** the
   panel shows a rendering indicator while the previous content remains visible, and never shows a
   blank area.
3. **Given** a file switch, **When** the new file's preview appears, **Then** it appears without
   waiting for the full trailing typing delay — the switch is treated as an immediate request, not
   as an edit.
4. **Given** the preview scrolled part-way down one file, **When** the author opens a different
   file, **Then** the preview is positioned at the top of the new file rather than retaining the
   previous file's scroll offset.
5. **Given** the author switches from the web-formatted preview to the page-formatted one and back,
   **When** the web-formatted preview returns, **Then** it renders without paying the full
   engine-startup cost again.
6. **Given** the author opens a file the preview cannot render, **When** the switch completes,
   **Then** the "preview not available" message is shown deliberately for that file — the message
   remains correct where it genuinely applies.
7. **Given** the long-lived rendering engine terminates unexpectedly, **When** the author continues
   editing or switches file, **Then** the engine is rebuilt automatically and the preview resumes
   updating without the author reloading the application.
8. **Given** an engine that terminates repeatedly, **When** the bounded number of automatic rebuilds
   is exhausted, **Then** the preview stops restarting on its own and shows a persistent error with a
   manual retry, and taking that retry attempts a fresh engine.
9. **Given** the author closes the preview panel entirely and later reopens it, **When** the preview
   returns, **Then** it renders without paying the engine-startup cost again — the same guarantee as
   the format switch, and the same underlying reason.

---

### User Story 3 - Render cost is measurable (Priority: P1 — delivered first)

As a developer working on the editor, I want each preview render to report how long its stages took,
so performance decisions rest on measurement instead of argument and regressions are visible rather
than inferred. Today the web-formatted preview reports no timings at all, and the page-formatted
preview computes timings that are then discarded without ever being read.

**Why this priority**: It is not directly user-facing, but it is delivered **first**, ahead of every
behavioural change in this feature. Three of the success criteria are stated as improvements against
current behaviour, and the only moment the current behaviour can be measured is before it is changed.
User Story 4 additionally cannot be built at all without a measured render duration. It is small,
cheap, and blocks everything that claims a number.

**Independent Test**: Render a document in a development build and confirm the per-render stage
timings are visible; render a much larger document and confirm the reported timings grow
accordingly.

**Acceptance Scenarios**:

1. **Given** a development build, **When** a web-formatted preview render completes, **Then** the
   time spent parsing the document and the time spent producing output are each reported separately.
2. **Given** a development build, **When** a page-formatted preview render completes, **Then** its
   timing and cache counters are surfaced rather than discarded, **and** its cost is reported broken
   down by stage rather than as a single whole-render total.
3. **Given** a production build, **When** any preview render completes, **Then** no timing overlay
   is shown to the author.
4. **Given** two documents of very different sizes, **When** each is rendered, **Then** the reported
   timings differ in a way consistent with the document sizes.
5. **Given** the measurement is in place and no behavioural change has yet been made, **When** the
   baseline document set is exercised, **Then** the current figures are captured and recorded — time
   to first render after a file switch, refresh delay after the last keystroke, and conversion time
   per document size — so every later comparative claim has something to compare against.
6. **Given** that same pre-change state, **When** the baseline pass runs, **Then** the current
   engine's rendered output for the equivalence corpus is captured as reference fixtures, and the
   recorded figures are committed to a named artifact rather than left in a terminal scrollback.
7. **Given** a page-formatted render reporting a per-stage breakdown, **When** the reported stages are
   added up, **Then** they account for the reported total, and every counter reported alongside them
   reflects a value the render actually observed rather than a fixed constant.
8. **Given** the page-formatted path's execution environment is later changed, **When** that change
   lands, **Then** the recorded per-stage figures are taken again, because a breakdown describing an
   arrangement the product no longer uses cannot inform a decision about the one it does.

---

### User Story 4 - Small documents feel near-live (Priority: P2)

As an author working on a short document, I want the preview to follow my typing closely, because a
short document converts in a few milliseconds and there is no reason to wait as long as a very large
one requires. Today every document waits the same fixed delay after the last keystroke, sized for the
worst case.

**Why this priority**: This is the largest real-time-feel improvement for the documents people
actually spend most of their time in, and it costs far less than the remaining stories. It depends
on User Story 3 for its input.

**Independent Test**: Type into a small document and into a very large one, and confirm the small
document's preview follows the typing visibly more closely while the large document's preview is no
slower than it is today.

**Acceptance Scenarios**:

1. **Given** a document of roughly 100 lines, **When** the author stops typing, **Then** the preview
   refreshes within 200 ms — well inside the fixed 500 ms delay applied to every document today.
2. **Given** a document that renders slowly, **When** the author stops typing, **Then** the wait
   before refreshing is no longer than the fixed 500 ms delay applied today.
3. **Given** a document whose render time changes substantially as it grows, **When** the author
   continues editing, **Then** the wait adapts to the observed render cost rather than staying fixed.
4. **Given** the very first edit of a session, before any render time has been observed, **When** the
   author stops typing, **Then** the preview still refreshes within the established maximum delay.

---

### User Story 5 - Diagrams, equations and reading position survive an edit (Priority: P3)

As an author editing prose in a document that also contains diagrams and mathematical notation, I
want the diagrams and equations to stay put and stay drawn while I type, and I want my reading
position in the preview to be preserved, so the preview is usable as a reading surface while I work.
Today every keystroke redraws every diagram and re-typesets every equation, and the preview jumps
away from wherever I was reading.

**Why this priority**: It is the most valuable structural improvement and the one that most affects
heavy documents, but it carries the largest change surface in the feature, so it follows the cheaper
wins that address the delay most authors feel.

**Independent Test**: Open a document containing several diagrams and equations, scroll part-way
down, edit a paragraph of prose that is not part of any diagram, and confirm the diagrams are not
redrawn, the equations are not re-typeset, and the scroll position is retained.

**Acceptance Scenarios**:

1. **Given** a document containing diagrams, **When** the author edits prose that is not part of any
   diagram, **Then** the existing diagrams remain drawn and are not regenerated.
2. **Given** a document containing mathematical notation, **When** the author edits unrelated prose,
   **Then** the already-typeset notation is not re-typeset and never reverts to raw markup.
3. **Given** the author has changed a diagram's own source, **When** the preview refreshes, **Then**
   that diagram is redrawn from its new source.
4. **Given** the preview scrolled part-way down a document containing images or diagrams, **When**
   an edit causes a refresh, **Then** the reading position is preserved rather than jumping.
5. **Given** any refresh, **When** the rendered output is committed to the page, **Then** it has
   passed the same sanitisation applied today — no content reaches the page unsanitised.
6. **Given** an author inserts a paragraph in the middle of a document, **When** the preview
   refreshes, **Then** the blocks after the insertion point are not needlessly rebuilt.
7. **Given** a keyboard user has focused a link or an include placeholder inside the preview, **When**
   a refresh occurs and that element still exists, **Then** it retains focus and can still be
   activated from the keyboard.
8. **Given** a focused element whose source has been deleted, **When** the refresh removes it,
   **Then** focus falls back to the preview container rather than being lost to the document body.

---

### User Story 6 - Documents convert faster (Priority: P4)

As an author working on a large document, I want the underlying conversion itself to be faster and
the application to download less code to do it, so the biggest documents stay comfortable to edit.

**Why this priority**: Genuinely valuable and measured — roughly two and a half times faster
end-to-end and about half the download — but it is a substantial engine migration, and once the
earlier stories land the conversion is no longer what an author feels on a typical document. It is
sequenced last so its payoff can be confirmed against the measurements from User Story 3.

**Independent Test**: Render the equivalence corpus with the upgraded engine and compare it against
(a) the fixtures captured from the previous engine and (b) the canonical reference toolchain's HTML
output; compare measured conversion time and downloaded code size against the recorded baseline; and
confirm the two preview formats still agree via a comparison that reads both outputs.

**Acceptance Scenarios**:

1. **Given** the reference fixtures captured from the current engine before any change (FR-023c),
   **When** the upgraded engine renders the same corpus and the outputs are compared after normalising
   insignificant whitespace and attribute ordering, **Then** they are equivalent.
2. **Given** the same comparison, **When** generated identifiers are compared, **Then** they match
   exactly — a changed identifier fails the comparison even where the visible text is identical.
3. **Given** a document containing internal cross-references, **When** it is rendered after the
   engine change, **Then** every cross-reference still resolves to its intended target and every
   rendered block still carries its source-line provenance.
4. **Given** the engine change, **When** conversion time is measured on the same documents, **Then**
   it is materially faster than the recorded baseline — "materially" quantified by SC-009 as at least
   a factor of two, with the downloaded conversion code at least a third smaller.
5. **Given** the engine change, **When** the web-formatted preview and the page-formatted export
   render the same document, **Then** a comparison that reads BOTH outputs confirms they agree on
   block text sequence, heading hierarchy and numbering, and cross-reference targets (FR-025b) — the
   pre-existing page-format parity suite does not exercise the web-format engine and cannot serve as
   this gate.
6. **Given** the engine change, **When** the pre-existing page-format reference-parity suite runs,
   **Then** it passes unchanged, confirming the page-formatted path was not disturbed.
7. **Given** the engine change, **When** the application loads, **Then** the code downloaded to
   perform conversion is smaller than before.

---

### User Story 7 - Large documents export without hitting a wall (Priority: P2)

As an author whose document has grown past a hundred pages, I want the page-formatted render to keep
working — or to tell me plainly where its limit is — so I discover the boundary from a message rather
than from a crash.

**Why this priority**: this is a correctness defect, not a performance one: the page-formatted path
currently has no declared upper bound on document size and simply fails past roughly 1,700 lines. It
was originally recorded as out of scope for this feature precisely because performance work should not
absorb correctness defects; it is included by explicit decision to leave nothing deferred. It is
sequenced after the latency work because it shares no code with it.

**Independent Test**: render a document past the observed failure threshold and confirm it either
completes, or fails with a message naming the limit — not with an engine crash.

**Acceptance Scenarios**:

1. **Given** a document larger than the previously observed failure threshold, **When** it is rendered
   to the page format, **Then** it either completes successfully or reports a clear limit.
2. **Given** a document beyond whatever bound is determined to be supportable, **When** the render is
   attempted, **Then** the message names the limit and what to do about it, and the application stays
   usable.
3. **Given** the reused-engine degradation report, **When** it is re-measured on an idle machine,
   **Then** the result is recorded — confirmed and acted on, or not reproduced and closed.

---

### Edge Cases

- **Rapid file switching**: an author clicks through several files faster than any render completes.
  The preview must end on the file that is actually open, never on a superseded one.
- **Switch while a render is in flight**: the in-flight render's result must not overwrite the newly
  opened file's preview.
- **Closing and reopening the preview panel**: reopening must not pay the full engine-startup cost
  (FR-007a). Note this is the same failure mode as the format switch, not a separate one: in both, the
  engine's only consumer goes away, so a lifetime tied to consumer count ends exactly when the
  guarantee is needed.
- **Rendering fails for the open file**: the error must be reported without discarding the preview
  engine, and a later successful edit must recover without a restart.
- **The rendering engine terminates**: distinct from a render failing. Because the engine is now
  long-lived, a termination is no longer masked by the next file switch rebuilding it. It must be
  detected and rebuilt automatically, with the automatic rebuilds bounded so a document that
  reproducibly kills the engine cannot cause a restart loop (FR-012a–FR-012c).
- **A render in flight when the engine terminates**: the pending request must not be left waiting
  forever; it must be re-issued against the rebuilt engine or reported as failed.
- **First render of a session**: no render time has been observed yet, so the adaptive wait has no
  input.
- **A single edit that changes render cost dramatically** (pasting thousands of lines, or deleting
  them): the adaptive wait must follow the change rather than remaining anchored to a stale measurement.
- **A document with no diagrams or equations**: skipping unchanged diagram and equation subtrees must
  not disturb ordinary content.
- **A diagram that failed to draw**: a failed diagram must be retried on a later refresh rather than
  being treated as unchanged and skipped forever.
- **Slow page-formatted renders**: page-formatted renders take seconds — longer than the guaranteed
  interval — so the guarantee must not stack a second refresh on top of a running one, and must
  resume once that one finishes (FR-004, FR-004a). The failure mode to test for is a preview stuck
  permanently in "rendering" while the author types, and its opposite: a guarantee that fires once
  and then never again.
- **Editing an included file whose parent is open**: the assembled preview must still refresh on the
  same signal it honours today.

## Requirements *(mandatory)*

### Functional Requirements

#### Refresh scheduling

- **FR-001**: The preview MUST refresh at least once per documented maximum-staleness interval while
  the author is continuously editing, without requiring a typing pause.
- **FR-002**: A burst of rapid edits MUST still collapse into a single refresh once editing stops,
  rather than producing one refresh per edit.
- **FR-003**: The wait before refreshing MUST adapt to the observed cost of rendering the current
  document, so that quick-rendering documents refresh sooner while slow-rendering documents wait no
  longer than the maximum in force today.
- **FR-004**: The guaranteed-refresh behaviour MUST apply to the page-formatted preview as well as
  the web-formatted one, under the same interval, with one qualification: the guarantee MUST NOT
  start a refresh while a refresh is already in progress. The effective guarantee is therefore "at
  least once per maximum-staleness interval, or as soon as the refresh in progress finishes,
  whichever is later" — self-limiting on slow-rendering documents and exactly the stated interval on
  fast ones. This is one rule applied to both preview formats, not a per-format setting: web-formatted
  renders complete well inside the interval, so the in-progress condition rarely arises there.
- **FR-004a**: When a refresh completes and edits made during it are still unreflected, the guarantee
  MUST re-arm so a later refresh is still guaranteed. A guarantee that fires once and then lapses for
  the rest of the session does not satisfy FR-001.
- **FR-004b**: The documented description of the refresh guarantee MUST be updated to state the
  behaviour in FR-004, so the stated contract and the shipped behaviour agree.
- **FR-005**: Opening a different file MUST bypass the typing delay entirely and request its preview
  immediately.

#### Preview engine lifecycle

- **FR-006**: The rendering engine MUST survive a change of open file — switching files MUST NOT
  discard and rebuild it.
- **FR-007**: The rendering engine MUST survive a change of preview format — switching between the
  web-formatted and page-formatted preview and back MUST NOT discard and rebuild it.
- **FR-007a**: The rendering engine MUST also survive **closing and reopening the preview panel**, and
  MUST survive any other transition that leaves the web-formatted preview with no active consumer.
  This requirement is stated separately because it is the case a consumer-counting lifetime gets
  wrong: the web-formatted preview is the engine's *only* consumer, so switching to the page format,
  closing the panel, or hiding the preview all drop the consumer count to zero simultaneously with the
  very transitions FR-007 exists to protect. A lifetime that ends the moment the last consumer goes
  away therefore satisfies FR-006 and fails FR-007. The engine MUST be retained across such a gap and
  released only on a bound that outlives it — leaving the project, or an idle period long enough that
  retention is no longer serving a switch.
- **FR-008**: The preview MUST NOT display the "preview not available for this file type" message
  during a switch between two files that can both be previewed; that message MUST remain reserved for
  files that genuinely cannot be previewed.
- **FR-009**: While a switch is rendering, the previously rendered content MUST remain visible with a
  rendering indicator shown, rather than the panel being blanked.
- **FR-010**: The preview scroll position MUST be reset to the top when the open file changes.
- **FR-011**: A render result MUST be discarded when it is superseded — by a newer edit, by a
  different file having been opened, or by the preview having been closed.
- **FR-012**: A failed render MUST NOT tear down the rendering engine; a subsequent edit MUST be able
  to render successfully without a restart.
- **FR-012a**: Termination of the rendering engine itself — an uncaught internal error, or the browser
  reclaiming it — MUST be detected, and the engine MUST be rebuilt automatically and the most recent
  request re-issued, so the author sees a delayed preview rather than a permanently dead one. This
  requirement exists because FR-006 and FR-007 remove the per-switch rebuild that currently masks such
  a termination by accident; without it, one termination would disable the preview for the rest of the
  session.
- **FR-012b**: Automatic rebuilds MUST be bounded per session, so a reproducibly crashing document
  cannot cause an unbounded restart loop. Once the bound is reached, the preview MUST surface a
  persistent error offering the author a manual retry, and MUST NOT keep restarting on its own.
- **FR-012c**: A manual retry offered under FR-012b MUST reset the bound and attempt a fresh engine,
  so an author who has fixed the offending content can recover without reloading the application.

#### Committing the rendered output

- **FR-013**: A refresh MUST update only the parts of the displayed output that actually changed,
  rather than replacing the whole rendered document.
- **FR-014**: Diagrams whose source is unchanged MUST NOT be redrawn on a refresh.
- **FR-015**: Mathematical notation that is already typeset and whose source is unchanged MUST NOT be
  re-typeset on a refresh.
- **FR-016**: A diagram or equation whose source HAS changed MUST be regenerated on the next refresh.
- **FR-016a**: A diagram that failed to draw MUST NOT be treated as up-to-date by the skip rule in
  FR-014. "Unchanged source" and "successfully drawn" are different conditions, and conflating them
  would leave a transient failure permanently on screen with no way to recover short of reloading.
- **FR-017**: The author's scroll position in the preview MUST be preserved across a refresh,
  including in documents containing images and diagrams.
- **FR-018**: Every path that commits rendered output to the page MUST apply the same sanitisation
  applied today; no path may commit unsanitised content.
- **FR-019**: Click-to-navigate from a rendered block to its source, and scroll-to-line from the
  editor to the preview, MUST continue to work after a partial refresh.
- **FR-020**: Interactions attached to rendered content — following internal cross-references,
  opening external links, and opening an included file from its placeholder — MUST continue to work
  after a partial refresh.
- **FR-020a**: An element focused inside the preview MUST retain keyboard focus across a refresh,
  provided that element still exists afterwards. The preview contains focusable links and
  keyboard-activatable include placeholders; today's wholesale replacement destroys them on every
  refresh, so focus inside the preview is lost on every keystroke. Partial updating makes preserving
  it possible, and this requirement makes it required rather than incidental.
- **FR-020b**: Where the focused element no longer exists after a refresh (its source was deleted),
  focus MUST NOT be left detached — it MUST fall back to the preview container rather than to the
  document body, so keyboard navigation continues from a sensible place.
- **FR-020c**: The preview container MUST be marked as busy while a refresh is in progress, and
  unmarked when it completes.
- **FR-020d**: No announcement or live-region behaviour is required of the preview by this feature.
  Announcing on every refresh would be worse than silence for a surface that updates while the author
  types. This is a deliberate deferral, not an oversight — see Out of Scope.

#### Measurement

- **FR-021**: Each web-formatted preview render MUST report the time spent parsing the document and
  the time spent producing output as separate values.
- **FR-022**: The page-formatted preview's existing render timings and cache counters MUST be
  surfaced to the application rather than discarded.
- **FR-022a**: That report MUST break the cost down by stage — at minimum the page-format render VM's
  boot, the document parse, the converter walk, **the layout dry runs**, font parsing and subsetting,
  and the output-serialisation step — rather than
  reporting only a cold-start figure and one whole-render total. Two numbers say how long a render
  took and nothing about where the time went; they can rank documents against one another and support
  no decision beyond that. This **supersedes the no-shape-change constraint** previously recorded
  against FR-022: the report's shape must grow. The additions are additive, so no existing consumer of
  the report is affected.
- **FR-022b**: Where a stage's cost is observable only inside the page-format render VM — the layout
  dry runs, font parsing and subsetting, and document serialisation — that measurement MUST cross the
  boundary by the mechanism that path already uses to return its other results, not by a second
  mechanism invented for it. This is stated separately because it is the part that makes FR-022a more
  than an afternoon's work, and because an implementation reporting only the stages observable from
  outside the VM would satisfy the letter of FR-022a while leaving the largest suspected cost — the
  dry runs, which lay content out twice — unmeasured.
- **FR-022c**: Every counter the page-formatted path reports MUST carry an observed value. At least
  one is a hardcoded constant today, which is worse than reporting nothing: a reader cannot tell
  "measured zero" from "never wired up", and the figure has already been repeated as though it were a
  measurement.
- **FR-023**: Render timings MUST be observable in development builds and MUST NOT be presented to
  authors in production builds.
- **FR-023a**: A baseline of current behaviour MUST be captured and recorded using this measurement
  BEFORE any behavioural change in this feature is made, covering at minimum: time to first render
  after a file switch, delay from last keystroke to refresh, conversion time across the document size
  range, the downloaded size of the conversion code, **main-thread work during sustained typing**, and
  the **page-formatted path's per-stage render cost** (FR-022a).
  The comparative success criteria (SC-003, SC-005, SC-009) are judged against these recorded figures,
  not against recollection. The main-thread figure exists because the partial-refresh work in User
  Story 5 moves a commit step onto the main thread while removing a larger one; that this is a net
  reduction is a hypothesis, and without a pre-change figure it can only ever be asserted.
- **FR-023b**: The baseline MUST be written to a named, committed artifact —
  `specs/043-preview-responsiveness/baseline.md` — recording for each figure: the document used and
  its line count, the measured value, how it was obtained, and the date. An unlocated baseline is one
  that gets skipped; naming the file is what makes FR-023a auditable rather than aspirational.
- **FR-023c**: The same baseline pass MUST capture the web-format render-equivalence reference
  fixtures required by FR-025a. Both captures need the unmodified current behaviour, so they share the
  one moment before any change lands — a second opportunity does not exist.

#### Conversion engine

- **FR-024**: The conversion engine upgrade MUST preserve rendered output equivalence — the same
  document MUST render equivalently before and after. Equivalence is judged after normalisation:
  insignificant whitespace and the ordering of element attributes are ignored, because they are
  serialisation details no reader perceives and no specification pins down. Everything that reaches
  the reader — element structure, hierarchy, text content, and the presence of every rendered block —
  MUST match.
- **FR-024a**: Generated identifiers MUST match exactly and MUST NOT be normalised away. Automatic
  heading identifiers are what internal cross-references resolve against, and the source-line
  provenance the editor navigates by is attached by matching those identifiers. An identifier that
  changed shape would break cross-references and editor↔preview navigation silently, while leaving
  the visible text identical — precisely the failure a normalised comparison must still catch.
- **FR-025**: The web-formatted preview and the page-formatted export MUST continue to agree on
  rendered output, as they do today, judged by the same normalised standard.
- **FR-025a**: The conversion-engine upgrade MUST be gated by a comparison that actually exercises the
  changed engine. The existing render-parity suite compares page-formatted output against an external
  reference build and does not load the web-formatted preview's conversion engine at all, so it cannot
  detect a regression introduced by this upgrade. A **web-format render-equivalence corpus** MUST
  therefore be established: the current engine's output for a fixed document corpus is captured as
  reference fixtures during the baseline pass (FR-023a), and the upgraded engine's output is compared
  against those fixtures under the FR-024/FR-024a standard. This is a REGRESSION gate — it proves the
  upgrade changed nothing relative to the previous version. It is necessary but not sufficient on its
  own, because a defect present in BOTH versions would pass it; FR-025c supplies the external truth.
- **FR-025b**: Agreement between the two preview formats (FR-025) MUST be checked by a comparison that
  reads both outputs. Because the two formats are different media, agreement is judged on what both
  can express: the sequence of rendered block text, the heading hierarchy and its numbering, and the
  set of cross-reference targets. No such comparison exists today; asserting agreement without one is
  the failure this requirement prevents.
- **FR-025c**: A **canonical web-format reference build** MUST be established, mirroring what already
  exists for the page-formatted path: the same corpus rendered by the reference Asciidoctor toolchain
  to HTML, and the in-app web-format output compared against it. Until this exists the web-formatted
  preview has no external oracle at all — its output can only be compared against its own previous
  output, so a rendering defect that has always been present is invisible by construction. This is the
  comparison that satisfies the fidelity-verification standard; a self-comparison does not, because a
  snapshot of in-app output against itself is not evidence of correctness.
- **FR-025c-i**: The reference toolchain required by FR-025c MUST be **pinned and content-addressed**
  to the same standard as the page-formatted one — a specific Asciidoctor version in a locked gem
  closure, on a digest-pinned base image, tagged by a hash of that definition so a stale toolchain
  cannot be silently reused. An unpinned oracle is not an oracle: it makes "does the output match the
  reference?" answerable differently on two machines, which defeats both the fidelity standard and the
  determinism standard it depends on. The existing pinned-reference mechanism MUST be reused rather
  than re-derived, and reusing it MUST NOT alter the page-formatted toolchain's own identity — the
  committed page-format reference corpus must remain valid and unregenerated.
- **FR-025d**: The comparison in FR-025c MUST account for the app's own post-conversion passes rather
  than pretending they do not exist. The in-app render deliberately adds source-line provenance,
  synthetic block identifiers, endpoint-mapped image targets, syntax-highlighting markup, diagram
  placeholders, and assembled includes. Each is an intended difference from raw reference output, and
  each MUST be either normalised before comparison or asserted as a deliberate, enumerated divergence.
  An unexplained difference MUST fail; a difference explained by an enumerated pass MUST NOT. Each
  enumerated divergence MUST carry a **concrete normalisation rule**, not a statement of intent — a
  divergence described only as "normalised to match" is the row that will be loosened until the suite
  passes.
- **FR-025e**: Extracting the cross-reference target set from page-formatted output requires reading
  its internal link destinations, which the existing comparison tooling cannot do — it exposes page
  counts, a text layer, and ink maps only. That extraction MUST be built as part of this work.
  Without it, one third of FR-025b is unimplementable and would quietly degrade to a two-dimension
  check while still being reported as satisfying the requirement.

#### Page-formatted path robustness

- **FR-027**: The page-formatted render MUST NOT fail with an out-of-memory error on documents within
  the supported size range. The failure was observed at roughly 1,700 lines / 80 pages, meaning the
  path currently has **no upper bound on document size** — a document simply stops rendering past a
  threshold nobody declared. The supported bound MUST be determined by measurement and either raised
  to cover it or stated explicitly.
- **FR-027a**: Where a document genuinely exceeds the supported bound, the render MUST fail with a
  clear, actionable message naming the limit — never an opaque engine crash. An unbounded silent
  failure and a declared limit are different products; only the second is honest.
- **FR-028**: The reported degradation of repeated renders in a reused **page-format render VM**
  (roughly 3 s rising to 11 s over eight consecutive renders, against 2.9–3.4 s for a fresh VM each
  time) MUST be re-measured on an otherwise idle machine before any action is taken on it. The
  original figures were taken while the end-to-end suite occupied the same machine, so they may
  measure contention rather than degradation. "VM" here is the page-formatted path's embedded
  execution environment — a third distinct thing from the *rendering engine* of FR-006/FR-012a (the
  preview's off-main-thread worker) and the *conversion engine* of FR-024 (the web-formatted preview's
  conversion library). The three are named apart deliberately.
- **FR-028a**: If re-measurement confirms the degradation, page-format render-VM reuse MUST be changed
  to whatever the measurement supports. If it does not reproduce, that MUST be recorded in the baseline
  artifact so the claim stops circulating as received wisdom. Either outcome closes the question;
  leaving it open is what this requirement forbids. Because any change here touches the page-formatted
  path, SC-010c MUST be re-verified after it — a check made before this change does not cover it.
- **FR-028b**: If FR-028a changes render-VM reuse, the per-stage figures recorded under FR-022a and
  FR-023a MUST be measured again and the artifact updated. Those figures were taken with reuse in
  force, and the VM's boot cost is one of the stages they break out, so changing reuse changes the
  very profile they describe. Without this, the recorded breakdown would describe an arrangement the
  product no longer uses while continuing to be cited as though it described the current one — and it
  is the input the follow-up work named in Out of Scope is gated on.

#### Correctness cleanup

- **FR-026**: The shared attribute utility that documents itself as returning a copy MUST either
  return a copy as documented, or state the mutation it actually performs. All existing callers MUST
  be audited first, because the in-place behaviour has been in effect long enough that callers may
  depend on it.

### Key Entities

- **Render request**: one request to convert a document, carrying the source, the open file's
  identity, and the resolution context. Superseded requests are discarded.
- **Render result**: the outcome of one request — the rendered output, whether diagrams or
  mathematical notation are present, any error, and (new) its stage timings.
- **Render timing record**: the measured cost of a completed render, used both to inform the adaptive
  wait and to be displayed in development.
- **Refresh schedule**: the policy deciding when a pending edit becomes a render — a trailing wait,
  a guaranteed maximum staleness, and an immediate path for file switches.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: During continuous typing with no pause, the preview refreshes at least once every
  guaranteed-staleness interval — or, where a single refresh takes longer than that interval, as soon
  as each refresh finishes. Today it refreshes zero times until typing stops, on both preview formats.
- **SC-001a**: During sustained typing on a slow-rendering document, at most one refresh is in
  progress at any moment, and refreshes continue for as long as the typing does.
- **SC-002**: Switching between two previewable files never shows an error message or a blank preview
  panel — zero occurrences across repeated switching.
- **SC-003**: The delay from opening a different file to seeing that file's rendered content is
  reduced by at least half against the baseline recorded under FR-023a.
- **SC-004**: Switching preview format and back does not repeat the engine-startup cost — startup
  occurs once per editing session rather than once per switch, **absent a supervised rebuild under
  FR-012a**. A rebuild after a termination is itself a startup, so the criterion counts startups
  attributable to switching, closing the panel, or opening a different file; it does not count
  recovery from a dead engine, which FR-012a requires.
- **SC-004a**: An engine termination is recovered from automatically, with the preview updating again
  without the author reloading the application; repeated terminations stop after the bounded number of
  attempts rather than looping indefinitely.
- **SC-005**: On a document of roughly 100 lines, the preview refreshes within 200 ms of the last
  keystroke; on a document of roughly 15,000 lines it refreshes no later than the baseline recorded
  under FR-023a.
- **SC-006**: Editing prose in a document containing diagrams triggers zero diagram redraws and zero
  equation re-typesets, measured across a sustained editing session.
- **SC-006a**: Main-thread work during that same sustained editing session is no greater than the
  figure recorded under FR-023a. The partial refresh replaces a whole-document re-parse with a patch
  and removes the per-keystroke diagram and equation rework, so a reduction is expected — but expected
  is not measured, and this criterion is what turns the expectation into evidence.
- **SC-007**: The preview's scroll position after a refresh is unchanged from before it, in documents
  containing images and diagrams.
- **SC-007a**: A keyboard user's focus inside the preview survives a refresh in every case where the
  focused element still exists — today it survives none.
- **SC-008**: Per-render stage timings are available for both preview formats in development builds,
  and absent from production builds.
- **SC-008a**: The page-formatted preview reports a per-stage breakdown whose stages account for the
  reported total, covering at minimum VM boot, parse, converter walk and serialisation; and every
  counter it reports reflects an observed value rather than a constant (FR-022a–FR-022c).
- **SC-009**: Measured conversion time on the benchmark document set improves by at least a factor of
  two against the baseline recorded under FR-023a, and the code downloaded to perform conversion is at
  least a third smaller.
- **SC-010**: The upgraded conversion engine produces output equivalent to the current engine for
  every document in the **web-format render-equivalence corpus** (FR-025a) — judged after normalising
  insignificant whitespace and attribute ordering, with generated identifiers required to match
  exactly. This corpus is established by this feature; the pre-existing page-format parity suite does
  not exercise the web-format engine and cannot stand in for it.
- **SC-010a**: Zero cross-references and zero source-line provenance markers are broken by the engine
  upgrade, across that corpus.
- **SC-010b**: The two preview formats agree on rendered block text sequence, heading hierarchy and
  numbering, and cross-reference target set (FR-025b), for every document in the shared fixture set —
  measured, not assumed.
- **SC-010c**: The pre-existing page-format reference-parity suite continues to pass unchanged
  throughout this feature, confirming the page-formatted path is unaffected.
- **SC-010d**: Web-format output matches the canonical reference toolchain's HTML for every document
  in the corpus, with every difference either normalised or listed as a deliberate, enumerated
  divergence produced by a named post-conversion pass (FR-025c, FR-025d). Zero unexplained differences.
- **SC-010e**: The cross-reference target set is extracted from page-formatted output and compared,
  so all three dimensions of FR-025b are actually checked rather than two (FR-025e).
- **SC-011**: A document at least twice the size of the previously observed failure threshold either
  renders to the page format successfully, or fails with a message naming the supported limit — zero
  opaque engine crashes (FR-027, FR-027a).
- **SC-012**: The reused-engine degradation question is closed by measurement on an idle machine and
  the result recorded in the baseline artifact, whichever way it goes (FR-028, FR-028a); and where
  that outcome changes render-VM reuse, the recorded per-stage figures are measured again and the
  artifact updated, so no figure in it describes an arrangement the product no longer uses (FR-028b).

## Assumptions

- The measured conversion costs quoted as motivation (6 ms at 93 lines rising to 540 ms at 14,577
  lines) were taken on the same engine the browser uses, and are treated as representative. They will
  be re-confirmed by the measurement delivered in User Story 3.
- "Guaranteed maximum staleness" and "trailing delay" keep their currently configured values (2000 ms
  and 500 ms) unless the adaptive policy in FR-003 computes a shorter trailing wait. The adaptive wait
  is bounded below at roughly 120 ms so it can never become a per-keystroke render.
- One guaranteed-refresh interval serves both preview formats. The page-formatted preview needs no
  interval of its own because FR-004's in-progress condition makes the guarantee self-limiting: its
  effective cadence becomes the render's own duration whenever that exceeds the interval. Whether a
  refresh is in progress is already known to both preview paths, so this needs no new measurement and
  keeps User Story 1 independent of User Story 3.
- The adaptive wait derives from the most recently observed render duration; before any render has
  been observed, the existing fixed delay applies.
- The rendered output carries per-block source-line and source-file provenance, but that provenance is
  **position-derived and therefore NOT usable as a block identity key**. Blocks without an author id
  receive a synthetic id containing their line number, and `data-source-line` is a line number, so
  inserting a line renumbers everything below it. Identifying blocks by either would rebuild the whole
  document on exactly the edit FR-013 exists to optimise. Block identity is therefore layered:
  content-addressed comparison for diagram and mathematical subtrees, stable author-supplied and
  auto-generated identifiers where present, and no key at all for synthetic ids (falling back to
  structural matching). This corrects an earlier assumption that provenance alone was sufficient.
- Development-only measurement means a build-time distinction, not a user-facing setting.
- The conversion engine upgrade is expected to preserve output equivalence because the underlying
  document semantics version is unchanged; SC-010 verifies this rather than assuming it.
- Equivalence is judged after normalisation rather than byte-for-byte. This is not a relaxation
  invented for this feature: the existing render-parity suite already compares normalised output —
  trimmed, with internal whitespace collapsed — and records in writing that exact equality would fail
  on differences that are not fidelity defects. FR-024a keeps generated identifiers outside that
  normalisation, because unlike whitespace they carry behaviour.
- The preview and the page-formatted export continue to share one attribute-resolution model; nothing
  in this feature changes how attributes, includes or level offsets resolve.

## Dependencies

**Delivery order**: User Story 3 → 1 → 2 → 4 → 5 → 6 → 7. Note this differs from priority order: User
Story 3 is not the most valuable story, but it must be delivered first because it is the only way to
record what "today" was before the other stories change it. User Story 7 was added to this ordering
when it was pulled into scope; an earlier revision of this section stopped at User Story 6 and left
its position implicit.

- User Story 3 (measurement) is delivered FIRST, and the baseline required by FR-023a is captured
  before any behavioural change. Three comparative success criteria (SC-003, SC-005, SC-009) are
  otherwise unevaluable, because the behaviour they compare against no longer exists once the work
  they judge has been done.
- User Story 4 (adaptive wait) depends on User Story 3 for its input signal, not merely for
  measurement.
- User Story 6 (engine upgrade) depends on User Story 3 for before/after comparison, and is
  deliberately sequenced last.
- User Story 5 changes how rendered output is handed to the display layer; existing automated tests
  assert against the current arrangement and will need revision.
- User Stories 1 and 2 have no dependency on each other and may be delivered in either order once
  User Story 3 has landed.
- User Story 7 shares no code with User Stories 1–6 and is sequenced last so it can be dropped without
  disturbing them. It has one dependency: FR-028a records its outcome in the baseline artifact, which
  User Story 3 creates, so that artifact must exist first. It also has one obligation *towards* the
  other stories — changing page-format render-VM reuse (FR-028a) touches the page-formatted path, so
  SC-010c must be re-verified after User Story 7, not only during User Story 6.

## Out of Scope

- **Converting only the changed part of a document instead of the whole document.** Unsound as a
  replacement: attribute entries, conditional inclusion, section renumbering, automatic heading
  identifier collisions, cross-reference text derived from target titles (which can change references
  *earlier* in the document), footnote numbering, caption counters, block delimiters, and blank-line
  changes that merge or split blocks all make a block's rendering depend on the rest of the document.
  Viable only as an optimistic layer that self-heals within one refresh, and revisited only if this
  feature proves insufficient.
- **Changes to the upstream conversion library to support incremental conversion.** Confirmed
  architecturally impossible and gated on the document-language working group, not achievable by
  contribution.
- **Page-scoped output from the page-formatted export engine**, and **snapshotting the export engine's
  virtual machine**. Both refused or unsupported upstream.
- ~~**The page-formatted export running out of memory beyond roughly 1,700 lines.**~~ **Moved INTO
  scope** as User Story 7 / FR-027–FR-027a by explicit decision. The original exclusion — that a
  performance feature should not absorb a correctness defect on a different path — still stands as
  reasoning; it was overridden deliberately so that nothing is left deferred. Recorded rather than
  silently deleted, so the trade-off remains visible to anyone reviewing the feature's size.
- **Announcement / live-region behaviour for the preview.** Deliberately deferred to a separate
  accessibility pass (FR-020d). A surface that updates while the author types would announce
  constantly, which is worse than silence, and specifying the correct behaviour needs
  assistive-technology testing capability this feature does not assume. Focus preservation
  (FR-020a–FR-020c) is in scope because it is testable with what already runs here.
- **Reducing the page-formatted path's own render cost** — caching what it recomputes each render,
  rasterising only the pages on screen, truncating or chunking the layout. Specified separately as
  `044-pdf-render-performance`. That feature depends on the per-stage measurement FR-022a delivers
  here and, more sharply, on FR-028's outcome: every cache such work would add lives in the
  page-format render VM, and FR-028a may remove that VM's reuse entirely. Sequencing it after this
  feature is therefore not a preference but a precondition. **The dependency runs one way only** —
  this feature contributes the measurement and waits on nothing; the name is recorded so the
  measurement's purpose is traceable, not because anything here is blocked by it.
- ~~**Removing engine reuse in the page-formatted export path.**~~ **Moved INTO scope** as FR-028–
  FR-028a. The caution that produced the original exclusion is unchanged and is now written into the
  requirement itself: the ~3 s → ~11 s degradation was measured on a machine simultaneously running
  the end-to-end suite, so it is re-measured on an idle machine BEFORE any action. What changed is
  that the question now gets closed either way rather than left circulating.

## Clarifications

### Session 2026-07-26

- Q: When the rendering engine itself terminates (uncaught error, or reclaimed under memory pressure), what should happen? → A: Supervise and auto-restart — detect termination, rebuild the engine, re-issue the latest request; bounded attempts per session, then surface a persistent error with a manual retry.
- Q: What does "equivalent rendered output" mean for the conversion-engine upgrade? → A: Equivalent after normalisation — insignificant whitespace and attribute ordering ignored, generated identifiers required to match exactly. Matches the existing normalised-comparison discipline in the render-parity suite; byte-identical output was considered and rejected there in writing.
- Q: What accessibility behaviour is required of the partial refresh? → A: Focus preservation only — an element focused inside the preview keeps focus across a refresh when it still exists afterwards, and the preview is marked busy while rendering. No announcement/live-region requirements; those are deferred as untestable with current capability.
- Q: How is the "compared with today" baseline established for the improvement targets, given the instrumentation that would measure it is itself a deliverable? → A: Deliver measurement (User Story 3) FIRST and capture a recorded baseline before any behavioural change; all comparative criteria are judged against those recorded figures.
- Q: The web-formatted preview has no external fidelity oracle — should XI/XV be scoped to the page-formatted path, or should a canonical HTML reference build be established? → A: Establish the canonical HTML reference build (FR-025c, FR-025d). A self-comparison is a regression gate, not evidence of correctness; without external truth a defect present in every version is invisible by construction. Both gates are kept: FR-025a catches regressions, FR-025c catches long-standing defects.
- Q: Should the deferred items (page-format memory failure, reused-engine degradation) stay as follow-ups? → A: No — pulled into scope as User Story 7 / FR-027–FR-028a, so nothing is left deferred. The reasoning for the original exclusion is retained in Out of Scope rather than deleted, because it remains a fair description of the size trade-off being accepted.

### Session 2026-07-26 (post-analysis corrections)

Raised by the cross-artifact consistency analysis run after task generation. Recorded rather than
silently edited, because two of them describe requirements that were written in a form nothing could
have satisfied.

- Q: FR-007 requires the rendering engine to survive a format switch, and the design satisfies it with a consumer-counted lifetime that terminates at zero. But the web-formatted preview is the engine's only consumer, so a format switch drops that count to zero. Does FR-007 hold? → A: **No — the mechanism could not satisfy the requirement.** FR-007a is added to state the case explicitly (format switch, panel close, and any other transition leaving no active consumer), and the lifetime gains an idle-retention bound that outlives the gap. Without this the story would have shipped a green test suite and a failing requirement.
- Q: SC-004 says engine startup occurs "once per editing session", but FR-012a mandates automatic rebuilds after a termination, and a rebuild is a startup. Which wins? → A: Both — SC-004 now counts only startups attributable to switching, closing or opening a file, and explicitly excludes supervised recovery.
- Q: FR-025c requires a canonical HTML reference build but never says which toolchain, at which version, pinned how. → A: FR-025c-i added. It must be pinned and content-addressed to the standard the page-formatted path already meets, reusing that mechanism rather than re-deriving one, and without disturbing the page-format toolchain's identity or its committed corpus.
- Q: The plan states that the partial refresh's main-thread cost must be *confirmed* against the baseline rather than assumed, but nothing captured a main-thread figure. → A: FR-023a's baseline now includes main-thread work during sustained typing, and SC-006a judges the post-change figure against it.
- Q: "Engine" names three different things across the spec — the preview's render worker, the web-format conversion library, and the page-format execution VM. → A: FR-028/FR-028a now say "page-format render VM" and name the other two to keep them apart.

### Session 2026-07-30 (incremental-PDF gap review)

Raised by a gap check of an incremental-PDF-rendering proposal against this spec. Only the
measurement gap was taken into this feature; the rest is recorded in the sibling feature named under
Out of Scope.

- Q: FR-022 surfaces the page-formatted path's timings but its data model fixes the report at a cold-start figure and one whole-render total. Is that enough to rank the work that would follow? → A: **No.** Two numbers can order documents by cost and answer nothing about where the cost sits, so any later optimisation would be chosen by argument — the state FR-021/FR-022 exist to end. FR-022a–FR-022c added; the "no shape change" constraint recorded against FR-022 is superseded, because the shape is what needs to change.
- Q: The most-suspected cost on the page-formatted path (layout dry runs, which lay content out twice) is not observable from outside its VM. Does FR-022a reach it? → A: Only if stated. FR-022b requires the in-VM stages to be measured and carried out over the existing result mechanism, so an implementation cannot report the easy stages and call FR-022a met.
- Q: One reported counter is a hardcoded constant that has since been cited as a measurement. → A: FR-022c added. A hardcoded counter is worse than an absent one, because nothing distinguishes it from a real zero.
- Q: FR-022a's per-stage figures are captured with render-VM reuse in force, but FR-028a may remove that reuse later in the same feature — and VM boot is one of the stages the breakdown reports. Does the recorded profile survive that? → A: **No.** FR-028b added: any change to render-VM reuse requires the per-stage figures to be taken again. Otherwise the artifact would keep describing an arrangement the product had stopped using, while continuing to be cited as current — the same failure FR-028 exists to end, reintroduced one step downstream.

## Diagnostic Evidence *(non-normative — input to planning, not a requirement)*

The causes below were located and confirmed in the current code before this specification was
written. They are recorded so planning does not repeat the investigation. They describe the present
state, not the required solution — the requirements above are the contract.

| # | Symptom | Confirmed cause |
|---|---------|-----------------|
| 1 | Preview only refreshes on a typing pause | The per-edit cleanup cancels the pending refresh, and cancellation clears the maximum-staleness timer along with the trailing one. Because cleanup runs before each new edit is scheduled, the staleness timer is re-armed from zero on every keystroke and can never elapse. Present in both the web-formatted and page-formatted preview hooks. |
| 2 | ~0.6–0.9 s dead time and an error flash on every file switch | The preview panel is keyed on the selected file, forcing a full remount; the rendering engine is created in a mount-only effect and its warm processor is a module-level singleton inside the engine, so both are destroyed and rebuilt per switch — then the first render still waits the full trailing delay. |
| 3 | Diagrams and equations redrawn every keystroke; scroll jumps | Output is sanitised to a string and committed by replacing the whole rendered document, so the markup is new every time. The math and diagram passes are keyed on that output and therefore re-run wholesale; images lose their laid-out height, collapsing the container and clamping the scroll offset. |
| 4 | No basis for ranking further work | The web-formatted path reports no timings. The page-formatted path computes render timings and cache counters, carries them on its result, and the consumer never reads them. |
| 5 | Incidental | The shared attribute utility documented as returning a copy deletes from its argument and returns the same map. It is the single authority feeding attribute scope, reference resolution and the include graph, so callers must be audited before it is changed. |
