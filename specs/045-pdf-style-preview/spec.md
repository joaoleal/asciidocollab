# Feature Specification: PDF-Look HTML Preview Style

**Feature Branch**: `045-pdf-style-preview`

**Created**: 2026-08-09

**Status**: Draft

**Input**: User description: "create a new HTML preview style (a third style) which has the same look as the PDF generation, including using the custom theme configurations"

## Overview

The live preview today offers two visual styles — the application's own "Asciidocollab" look and the
vendored "Asciidoctor" default look. Neither resembles the PDF a reader will eventually receive, so
an author writing for print has to leave the preview and produce a PDF to answer the question "what
will this actually look like?" That round trip is slow, and it is the only way to see the effect of
the project's custom PDF theme on real content.

This feature adds a **third preview style** that dresses the same live HTML preview in the
appearance the PDF export produces — its page geometry, typography, colour palette, spacing and
block treatments — driven by the very same theme document the PDF export applies. Authors get the
PDF's *look* at the speed and interactivity of the HTML preview: instant updates while typing,
scroll sync with the editor, browser text search and selection.

It is explicitly **not** a replacement for the existing PDF preview, which shows the genuine,
paginated, rendered document. The new style is a fast visual approximation for everyday authoring;
the PDF preview and the PDF export remain the authority on the final artefact.

## Clarifications

### Session 2026-08-09

- Q: Does the PDF-look style present the document as one continuous flow, or simulate discrete
  pages? → A: A **page-like frame** — the content sits in a fixed paper-width column on a page
  background, with the column's width and inset taken from the theme's page size and margins, but
  the content flows continuously and is never broken into discrete pages. This is what makes line
  lengths match the real PDF, which is the strongest cue that the author is looking at the print
  look. Genuine pagination was rejected: the existing PDF preview already does it correctly, and
  reimplementing it in the browser would put the responsiveness requirement at risk.
- Q: Which surfaces gain the Print style? → A: **The live preview only.** The project's HTML export
  style setting is deliberately left at its two existing options in this feature. This is a known,
  accepted inconsistency between two settings that are meant to mirror each other, recorded in Out
  of Scope below; extending the export is a candidate follow-up, not part of this work.
- Q: How does the style behave under the application's dark theme? → A: It **always shows the
  theme's own colours**, regardless of whether the application is in light or dark mode. The style's
  single claim is "this is what your PDF looks like", and adapting the palette would show colours
  the PDF will never produce. A light document panel inside dark application chrome is deliberate —
  it is exactly what the genuine PDF preview already does.
- Q: Which typefaces does the preview render with? → A: **The same font files the PDF renders with.**
  A project's custom fonts are already stored as WOFF2 — the form a browser wants — so the preview
  serves them directly rather than substituting. The renderer's built-in catalogue is made available
  to the browser from the application's own origin. Substitution by classification as the normal
  path was rejected:
  without the PDF's own font metrics, line lengths and vertical rhythm cannot match, which would
  make FR-011's page geometry and SC-003's line-length measure meaningless. Fallback (FR-028)
  remains, but as an exception for a genuinely missing font rather than the normal path.
- Q: How is "the same look as the PDF" verified? → A: **Two complementary oracles.** A small anchor
  set of documents is compared against the *genuinely rendered PDF* on measured properties —
  resolved typeface, size and colour per construct, page-column geometry, and where a line of body
  text breaks — which is what actually establishes fidelity. Alongside it, every theme value the
  style claims to support is asserted individually against the preview, giving breadth cheaply.
  Neither alone suffices: comparing every fixture against a PDF does not scale to the theme's key
  count, and asserting against the theme alone cannot catch a mapping that is wrong in both the
  preview and the expectation. Pixel comparison was rejected outright — the preview is unpaginated
  and the two rasterisers differ, so it could only ever produce noise.
- Q: Where are appearance problems reported to the author? → A: **The same way the PDF reports its
  own.** The style reuses the existing render-diagnostics surface rather than inventing one: nothing
  is shown when there is nothing wrong; when there is, a collapsible panel summarises the counts by
  severity, lists errors before warnings, names the resource each concerns, and offers to jump to a
  problem's source location where it has one. An uninterpretable theme, a rejected theme value and a
  substituted font are all reported through it, under the same severity model the PDF pipeline
  already uses. A banner above the page was rejected because it would displace the page column whose
  geometry FR-011 pins down; a transient notification was rejected because an author arriving after
  the fact would see a degraded page with no explanation.
- Q: What happens when the preview pane is too narrow for the page at full size? → A: **The same
  zoom model the PDF preview uses.** The page fits the pane's width by default and offers the same
  zoom control — the same presets and the same clamps — so an author who has learned one preview
  already knows the other. Horizontal scrolling therefore never happens on its own; it happens only
  as a consequence of the author choosing to zoom in past the pane's width. Scaling without a floor
  was rejected as it hands the author unreadable text with no way out, and reflowing below a
  threshold was rejected because it silently discards the page geometry that is the point of the
  style.
- Q: What is the style called, and what is stored for it? → A: **"Print"**, stored as the token
  `print` alongside the existing `asciidocollab` and `asciidoctor`. Naming it "PDF" was rejected
  because the editor already has a PDF preview panel that renders a genuine PDF; two different
  things under one word in the same editor would lead authors to expect a PDF from a style that
  deliberately is not one. "Print" also stays honest about the boundary in FR-037 — it describes the
  look, not a paginated artefact. The token is persisted per user and so is treated as a stable
  identifier from the outset rather than a label that can be revised freely.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preview the document in the PDF's look (Priority: P1)

An author is writing a document that will be delivered as a PDF. From the preview's style control
they pick the Print style. The preview keeps showing their live document — updating as they type,
scrolling in step with the editor, searchable with the browser's find — but now it appears as a
page: a paper-width column, inset by the theme's margins, on a page background, with the body text,
headings, code blocks, admonitions, tables and quotes all presented the way the PDF renders them.
Their choice is remembered, so the next time they open a document the preview is still in that
style.

**Why this priority**: This is the feature. Everything else refines it. Even with no custom theme in
play, an author who writes for print gains the ability to judge their document's real appearance —
including its real line lengths — without leaving the editor, which is the entire reason the request
was made.

**Independent Test**: Can be fully tested by opening any document in a project with no custom theme,
selecting the Print style, and confirming (a) the content is presented as a paper-width page rather
than in either existing style, (b) typing still updates the preview live, (c) scroll sync, text
selection and browser find still work, and (d) the selection survives a reload and applies to other
documents.

**Acceptance Scenarios**:

1. **Given** an author viewing a document in the live preview, **When** they open the preview style
   control, **Then** three styles are offered and the currently active one is indicated.
2. **Given** the author selects the Print style, **When** the preview re-renders, **Then** the same
   document content is shown as a paper-width page column on a page background, dressed in the PDF's
   appearance, with no loss of content compared with the other styles.
3. **Given** the Print style is active, **When** the author edits the document, **Then** the preview
   updates live at the same responsiveness the other styles provide.
4. **Given** the Print style is active, **When** the author scrolls the editor, **Then** the preview
   follows in step exactly as it does in the other styles.
5. **Given** the Print style is active in a preview pane wider than the page column, **When** the
   author reads the document, **Then** the column stays at its paper width and does not stretch to
   fill the pane.
6. **Given** the Print style is active at its default fit-to-width, **When** the author narrows the
   preview pane below the page column's width, **Then** the page scales down proportionally to fit
   and the preview pane does not scroll horizontally.
7. **Given** the Print style is active, **When** the author uses the zoom control, **Then** it
   offers the same default, presets and limits as the PDF preview's, and the page is redrawn at the
   chosen zoom.
8. **Given** the author has zoomed in past the pane's width, **When** they read the document,
   **Then** the pane scrolls horizontally — the only circumstance in which it does.
9. **Given** the author has selected the Print style, **When** they reload the application or open a
   different document, **Then** the Print style is still the active preview style.
10. **Given** an existing user whose stored preference is one of the two original styles, **When**
    they open the preview, **Then** their stored style is unchanged and continues to render as before.

---

### User Story 2 - See the project's custom PDF theme applied (Priority: P1)

The project has a custom PDF theme — brand colours, a chosen body font, a particular page size and
margin, tighter spacing, a styled sidebar. With the Print style active, the author's preview
reflects that theme: the page is the theme's paper size with the theme's margins, headings appear in
the brand colour, links in the theme's link colour, code blocks on the theme's panel background.
When a colleague edits the theme file, the author's preview picks up the change without any manual
step. If the project has no theme, or the theme is momentarily unparseable while someone is typing
in it, the preview still shows the document — dressed in the last good theme, or in the PDF's
default appearance — and never goes blank.

**Why this priority**: The request names the theme explicitly, and it is what separates this style
from "a print-ish stylesheet". Without it, the preview shows a generic PDF look that no project's
actual export produces, which would be actively misleading. It is P1 alongside US1 because a style
that ignored the theme would have to be revisited immediately.

**Independent Test**: Can be fully tested by opening a project that has a custom theme, activating
the Print style, and confirming the previewed document carries the theme's distinguishing values
(for example its page size, heading colour, body font and code-block background) rather than the
defaults; then changing one of those values in the theme and confirming the preview follows.

**Acceptance Scenarios**:

1. **Given** a project whose theme sets a distinctive page size and margin, heading colour, body
   font and code-block background, **When** the author previews a document in the Print style,
   **Then** all of those values are visibly applied to the previewed page.
2. **Given** a project that supplies its own font files and a theme that uses them, **When** the
   author previews a document in the Print style, **Then** the text is rendered in those very
   fonts, not in a substitute.
3. **Given** a theme that uses the renderer's built-in fonts, **When** the author previews a
   document in the Print style, **Then** the text is rendered in those same fonts, so a line of body
   text breaks in the same place it breaks in the PDF.
4. **Given** the Print style is active, **When** the project's theme document is changed (by this
   author or a collaborator), **Then** the preview reflects the new theme without the author
   reloading or re-selecting the style.
5. **Given** a project with no theme document at all, **When** the author previews in the Print
   style, **Then** the preview uses the PDF export's default appearance and page geometry, and
   reports no error.
6. **Given** a project whose theme document is currently invalid, **When** the author previews in
   the Print style, **Then** the preview still shows the document content, does not blank out, and
   reports that the theme could not be applied through the same diagnostics surface the PDF uses —
   without the page column moving or resizing.
7. **Given** a project that declares which of several theme documents it uses, **When** the author
   previews in the Print style, **Then** the appearance comes from the same theme document the PDF
   export would apply, not a different one.
8. **Given** a theme that sets values with no counterpart in an unpaginated preview, **When** the
   author previews in the Print style, **Then** those values are ignored without error and the rest
   of the theme is still applied.
9. **Given** a theme naming a font that neither the project nor the catalogue provides, **When** the
   author previews in the Print style, **Then** the affected text is rendered in a comparable
   available font and the preview indicates that its appearance is approximate.
10. **Given** the application is in dark mode, **When** the author previews in the Print style,
    **Then** the page and its content are shown in the theme's own colours, unchanged from light
    mode.
11. **Given** a project whose theme is valid and whose fonts are all available, **When** the author
    previews in the Print style, **Then** no diagnostics surface is shown at all.
12. **Given** a reported problem that has a known source location, **When** the author acts on it in
    the diagnostics surface, **Then** the editor reveals that location, as it does for the PDF's
    diagnostics.

---

### Edge Cases

- **Preview pane narrower than the page column**: at the default fit-to-width the page scales down
  proportionally to fit and the pane does not scroll horizontally. An author who wants the text
  larger reaches for the zoom control, exactly as they would in the PDF preview, and accepts the
  horizontal scrolling that follows.
- **Theme sets a landscape or unusually large page**: the page column takes that aspect and is
  scaled to fit as above, rather than overflowing.
- **Author zooms, then resizes the pane**: the zoom the author chose is respected; fit-to-width
  re-fits on resize. The two do not fight, matching the PDF preview's behaviour.
- **Project has no theme document**: the preview presents the PDF export's default appearance and
  default page geometry. No error, no empty preview.
- **Theme document is being typed into and is momentarily invalid**: the preview holds the last
  appearance that was valid and surfaces the problem beside the content rather than replacing it —
  matching how the existing theme editor's own preview behaves.
- **Theme names a font the project does not supply and the catalogue does not contain**: the preview
  falls back to a comparable available font and reports that the appearance is approximate for that
  text, rather than silently substituting something visually distant.
- **Project font file is missing, corrupt, or not a font**: it is treated as an unavailable font —
  fallback and an approximation notice — and never prevents the rest of the page from rendering.
- **Typefaces have not finished loading when the page first appears**: the content is readable
  throughout, and the page settles into its final typefaces without the author losing their place.
- **Theme sets values with no on-screen counterpart** (running headers and footers, page-break
  behaviour, page numbering, table-of-contents leader dots, title-page geometry): they are ignored
  without error; the style makes no claim to reproduce them.
- **Theme inherits from another theme**: the effective appearance is the one the PDF export would
  compute after inheritance, not the literal keys of the child document.
- **Theme sets a hostile or nonsensical value** (an absurd font size, a page size that is not a size,
  a value that is not a colour): it is rejected for that key and the corresponding default is used;
  a theme document can never break the preview's layout or reach outside the previewed content.
- **Dark application theme**: the page keeps the theme's own colours; only the area around the page
  belongs to the application's palette.
- **Very long or asset-heavy document**: the Print style is no slower to render than the existing
  two beyond the cost of resolving the theme once.
- **Theme changed by a collaborator mid-session**: the preview updates for every member viewing in
  this style, without a reload.
- **Switching styles repeatedly**: each switch reflects the new style completely, with no residual
  styling or page framing from the previous one.
- **Printing the preview** from the browser: the content prints legibly; this feature does not
  promise page-for-page correspondence with the PDF.
- **A user's stored preference names a style that no longer exists**: the preview falls back to the
  default style rather than failing.

## Requirements *(mandatory)*

### Functional Requirements

#### The style itself

- **FR-001**: The system MUST offer a third preview style, labelled **Print**, alongside the two
  existing ones, presented in the same style control and selectable in the same way.
- **FR-002**: The Print style MUST be stored as the token `print`, alongside the existing
  `asciidocollab` and `asciidoctor` tokens, and that token MUST be accepted everywhere a preview
  style is validated or persisted.
- **FR-003**: The Print style MUST present the live preview's content with the appearance the PDF
  export produces for that content — its typography, colour palette, spacing rhythm and block
  treatments — rather than either existing style's appearance.
- **FR-004**: The Print style MUST preserve every behaviour the existing preview styles provide:
  live update while typing, scroll synchronisation with the editor, text selection, browser text
  search, in-preview navigation between sections, and any preview affordances tied to review or
  cross-reference features.
- **FR-005**: The Print style MUST cover the following AsciiDoc constructs: document and section
  titles, paragraphs, ordered/unordered/description lists, links and cross-references, inline and
  block code with callouts, block quotes and verses, sidebars, example blocks, admonitions of every
  kind, tables (including header rows and stripes), images and figure captions, thematic breaks,
  footnotes, and the document header's author/revision details. **This enumeration is closed**: it is
  exactly what the style claims and exactly what SC-002's anchor set must exercise. A construct
  outside it still renders — the preview's markup is unchanged (FR-006) — but the style makes no
  appearance claim about it.
- **FR-006**: The Print style MUST NOT alter the content the preview shows — the same document
  produces the same text, in the same order, under all three styles.
- **FR-007**: Selecting the Print style MUST be remembered for the user across sessions and
  documents, on the same terms as the existing two styles.
- **FR-008**: Existing stored style preferences MUST continue to resolve to the style they named;
  this feature MUST NOT change any user's current style.
- **FR-009**: The system MUST fall back to the default style when a stored preference names an
  unrecognised style.

#### Page presentation

- **FR-010**: The Print style MUST present the content in a fixed page-width column on a visually
  distinct page background, so that the page is legible as a page against the surrounding pane.
- **FR-011**: The page column's width, aspect and content inset MUST be derived from the effective
  theme's page size, orientation and margins, so that the preview's line lengths correspond to the
  PDF's.
- **FR-012**: Content MUST flow continuously within the page column. The Print style MUST NOT break
  content into discrete pages, and MUST NOT render page breaks, running headers or footers, or page
  numbers.
- **FR-013**: The page MUST fit the available preview width by default, scaled proportionally,
  however narrow the pane. At this default the preview pane MUST NOT scroll horizontally.
- **FR-014**: When the available preview width exceeds the page column at 100%, the column MUST
  retain its page width rather than stretching to fill the pane.
- **FR-015**: The Print style MUST offer the same zoom control the PDF preview offers — the same
  default, the same presets and the same limits — so that the two previews behave alike.
- **FR-016**: Horizontal scrolling MUST occur only as a consequence of the author zooming in past
  the pane's width, never on its own.
- **FR-017**: The effective theme's page background colour MUST be applied to the page column.

#### Theme application

- **FR-018**: When the Print style is active, the system MUST apply the same theme document the PDF
  export would apply for that project, resolved by the same rule (explicit project selection when
  one exists, otherwise the project's automatically resolved theme).
- **FR-019**: The system MUST apply the theme's effective values after inheritance from any theme it
  extends, so that the preview matches what the export computes rather than the child document's
  literal keys.
- **FR-020**: The system MUST apply the theme's page size/orientation/margins/background, body
  typography and colour, heading typography and colours per level, link colour, inline-code and
  code-block typography, colours, background and border, key-cap, button and menu-caret treatment,
  highlighted-text treatment, callout-number treatment, list marker colour, indent and item spacing,
  description-list term and indent treatment, quote, sidebar and example block treatments,
  admonition treatment including its per-kind icon colour and size and its label column,
  block image alignment, table borders/grid/header/stripe treatment, caption treatment, footnote
  treatment, and thematic break treatment. **This enumeration is closed**: keys outside it are
  neither applied nor reported (FR-021), so "claimed as supported" in SC-004 means precisely this
  list and nothing wider.
- **FR-020a**: Where the renderer draws a mark rather than setting a property — an admonition's icon,
  a callout's circled number, the brackets around a button, the caret between the parts of a menu
  path — the system MUST draw the renderer's own mark, taken from the renderer itself rather than
  approximated, and MUST colour and size it from the theme where the theme carries those values.
- **FR-020b**: The system MUST highlight source blocks, since the export always does; the palette is
  the renderer's own highlighting theme. The renderer's highlighting theme is chosen by a document
  attribute rather than by the PDF theme, so a project that overrides that attribute is a documented
  divergence rather than a theme value this style fails to apply.
- **FR-021**: The system MUST ignore, without error, theme values that have no meaning for an
  unpaginated on-screen preview, and MUST NOT let their absence prevent the rest of the theme from
  applying.
- **FR-022**: When the project has no theme document, the system MUST present the PDF export's
  default appearance and default page geometry.
- **FR-023**: When the theme document cannot be interpreted, the system MUST continue to show the
  document content — using the last interpretable theme for this project in this session, or the
  default appearance if there was none — and MUST report the problem per FR-032.
- **FR-024**: When the theme document changes, the preview MUST reflect the change without the
  author reloading the application or re-selecting the style.
- **FR-025**: The system MUST reject individual theme values it cannot interpret and use the
  corresponding default for those keys alone, leaving the rest of the theme applied, and MUST report
  each rejection per FR-032.
- **FR-026**: A theme document MUST NOT be able to affect anything outside the previewed page — it
  MUST NOT alter the surrounding application interface, and MUST NOT cause the preview to reach out
  to any network location. Theme content is untrusted input and is treated as such.

#### Typefaces

- **FR-027**: The Print style MUST render text with the same typefaces the PDF export renders it
  with — the project's own font files for fonts the project supplies, and the renderer's built-in
  font catalogue for the rest — so that glyph shapes, weights and metrics correspond.
- **FR-028**: When a theme requests a typeface that is genuinely unavailable, the system MUST fall
  back to the closest available typeface of the same classification and MUST report the substitution
  per FR-032, naming the font it could not obtain. This is an exception path, not the normal one.
- **FR-029**: Every typeface the preview uses MUST be obtained from the project or from the
  application's own origin. The preview MUST NOT fetch a typeface from any external location.

#### Colour fidelity

- **FR-030**: The Print style MUST present the page and its content in the effective theme's own
  colours, identically under the application's light and dark modes.
- **FR-031**: The application interface surrounding the preview — including the area around the page
  column — MUST continue to follow the application's own light/dark palette, and MUST NOT be
  restyled by the theme.

#### Reporting appearance problems

- **FR-032**: Appearance problems MUST be reported through the same render-diagnostics surface the
  PDF already uses, under the same severity model, rather than through a surface invented for this
  style. An uninterpretable theme, a rejected theme value and a substituted typeface are all
  reported through it.
- **FR-033**: When there are no appearance problems, no diagnostics surface MUST be shown — the
  preview presents the page and nothing else.
- **FR-034**: When there are problems, the surface MUST summarise them by severity, present errors
  before warnings, name the resource each concerns, and be collapsible and height-bounded so that a
  long list cannot push the surrounding editor chrome off screen.
- **FR-035**: Where a reported problem has a known source location, the surface MUST offer to reveal
  that location in the editor, exactly as the PDF's diagnostics do.
- **FR-036**: The diagnostics surface MUST NOT displace or resize the page column — reporting a
  problem MUST NOT change the page geometry the author is being shown.

#### Boundaries

- **FR-037**: The Print style MUST NOT claim to reproduce page-level behaviour of the PDF — page
  breaks, running headers and footers, page numbering, and the placement of content across pages are
  out of its scope, and the interface MUST make clear that the genuine PDF preview and export remain
  the authority on the final document. This is carried by the style option's own name and
  description rather than by a notice standing over the page: a banner that is permanently present is
  read once and thereafter only occupies the page it is describing.
- **FR-038**: Selecting the Print style MUST NOT trigger a PDF render, and MUST NOT make the preview
  slower to update than the existing styles beyond the one-off cost of resolving the project's theme
  and loading the typefaces it names.

#### Accessibility

- **FR-039**: The Print option MUST carry over the accessibility expectations already in force for
  the preview: the style control and the zoom control MUST be keyboard-operable, the third option
  MUST be labelled for screen readers on the same terms as the existing two, reduced-motion
  preferences MUST be respected, and scaling the page to fit a narrow pane MUST NOT defeat the
  browser's own text zoom.

### Key Entities *(include if data involved)*

- **Preview style**: the named visual presentation a user's live preview uses. Previously a
  two-value choice (`asciidocollab`, `asciidoctor`); this feature adds a third value, `print`,
  labelled "Print". Stored per user, applies to every document they open. The token is a stable
  identifier — once users have it saved, changing it would silently reset their preference.
- **Preview zoom**: how large the page is drawn, fit-to-width by default. Belongs to the viewing
  session rather than the document, and mirrors the PDF preview's zoom in default, presets and
  limits.
- **Appearance diagnostic**: a reported problem with the page's appearance — an uninterpretable
  theme, a rejected theme value, a substituted typeface — carrying a severity, a message, the
  resource it concerns and, where known, a source location. The same kind of thing the PDF's own
  render diagnostics are, reported through the same surface.
- **Theme document**: the project file that describes the PDF's appearance. Already resolved and
  applied by the PDF export; this feature reads the same document for the preview. It has an
  effective form after inheriting from the theme it extends.
- **Effective appearance**: the resolved set of appearance values — theme values layered over the
  PDF's defaults — that the Print style presents, including the page geometry that sizes the page
  column. It is derived, never stored, and is recomputed whenever the theme changes.

## Out of Scope

- **The project's HTML export style setting.** It keeps its two existing options. This leaves it
  naming a smaller set of styles than the preview offers — an accepted, deliberate inconsistency for
  this feature, and the obvious follow-up if the new style proves useful.
- **Genuine pagination.** Page breaks, running headers and footers, page numbers and the placement
  of content across pages remain the existing PDF preview's job — stated as behaviour in FR-012 and
  as interface messaging in FR-037; this entry adds no further exclusion of its own.
- **Any change to how a theme is chosen or configured.** This feature reads the theme the project
  already resolves; it adds no new theme selection, no new theme keys, and no new theme editor
  behaviour.
- **Restyling anything but the previewed page** — the editor, outline, review rail and surrounding
  chrome are untouched.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An author can switch the preview into the PDF-look style in a single interaction from
  the preview itself, with the restyled page visible within one second.
- **SC-002**: For an anchor set of documents that together exercise every construct listed in
  FR-005, each construct's resolved typeface, size and colour in the preview matches the same
  construct in the genuinely rendered PDF of the same document, within a stated tolerance for size
  and colour and exactly for typeface.
- **SC-003**: For the same anchor set, the page column's content width and insets match the PDF's
  page geometry within a stated tolerance, and the number of characters on a full line of body text
  matches the same line in the rendered PDF within one character.
- **SC-004**: Every theme value listed in FR-020 is covered by an assertion that the preview applies
  it, with zero values claimed as supported but unasserted.
- **SC-005**: Changing any of a theme's page size, margin, body colour, heading colour, link colour,
  body font or code-block background is visible in the preview within two seconds of the change,
  with no reload and no re-selection of the style.
- **SC-006**: With the PDF-look style active, typing in the editor updates the preview within the
  same measured budget the existing preview styles are already held to, using the same measurement
  the project's existing preview-timing check applies (same documents, same sample count, same
  keystroke-to-refresh timing) and the same pass thresholds. The Print style must meet those
  thresholds unchanged; a threshold raised to accommodate it is a regression, not a passing result.
- **SC-007**: Across the full range of preview pane widths the application supports, the preview at
  its default zoom never scrolls horizontally and the page column is fully visible; the zoom control
  offers the same default, presets and limits as the PDF preview's.
- **SC-008**: 100% of the malformed, incomplete and hostile theme documents in the test set leave
  the preview showing the document content, with zero occurrences of a blank preview, an application
  error, or any styling escaping the previewed page.
- **SC-009**: The previewed page's colours are identical under the application's light and dark
  modes, for every theme in the test set.
- **SC-010**: Every user whose preference predates this feature sees the identical preview
  appearance they saw before it.
- **SC-011**: The interface itself states which preview shows the PDF's appearance, rather than
  leaving an author to infer it: the Print option carries a label and a description that names both
  its purpose and its boundary — that it is not paginated, and that the genuine PDF preview and
  export remain the authority on the final document (FR-037). Verified by review against those two
  conditions.
- **SC-012**: Every appearance problem the style can detect is reported through the PDF's existing
  diagnostics surface, with zero problem classes reported anywhere else and zero cases of the
  surface appearing when nothing is wrong.

## Assumptions

- The Print style is an *approximation* of the PDF's appearance suited to on-screen reading: page
  geometry and typography are faithful, pagination is not. The existing PDF preview remains the
  authority on page breaks and final layout, and this feature does not change it.
- The theme document the preview uses is the one the PDF export already resolves for the project;
  this feature introduces no new way to select or configure a theme.
- The preview style remains a per-user preference; this feature adds a value to it and changes
  neither its scope nor its ownership.
- Theme values are treated as untrusted input, consistent with how the project already treats theme
  content reaching the renderer.
- No new outbound network access is introduced. Typefaces come from the project's own files or from
  the application's own origin; a theme naming a font neither of those provides results in a
  fallback, not a fetch.
- The renderer's built-in font catalogue must be made available to the browser. One family the PDF's
  default theme uses for code is not among the fonts the application already serves, so this feature
  is assumed to add it (a small, fixed cost, measured during planning). Custom project fonts need no
  such treatment — they are already stored in a form the browser reads directly.
- Scaling the page to fit a narrow pane is proportional — the whole page shrinks, preserving line
  lengths in characters — and the author's escape from small text is the zoom control rather than a
  scaling floor.
- The anchor set backing SC-002 and SC-003 is small and deliberately chosen for construct coverage
  rather than exhaustive; which documents compose it, and the size and colour tolerances those
  criteria refer to, are settled during planning. The existing project's reference-PDF machinery is
  assumed to supply the rendered PDF side of the comparison rather than this feature building its
  own.
- Naming of the new style in the interface is a presentation detail to be settled during design; the
  specification requires only that its purpose be unambiguous to an author.
- Accessibility expectations already in force for the preview apply unchanged to the Print option.
  They are stated as **FR-039** rather than left here, so that they are a requirement with a test
  rather than an assumption nothing gates.
