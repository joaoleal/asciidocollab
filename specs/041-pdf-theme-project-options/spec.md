# Feature Specification: PDF Theme Editing & Sectioned Project Options

**Feature Branch**: `041-pdf-theme-project-options`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Add improvements to PDF support: add support for PDF theme editing with live preview with a pre-defined example that display the impact of the theme; add support for selecting ruby extensions in the project options; improve project options page by spliting it into selectable sections instead of having everything in the same page"

## Clarifications

### Session 2026-07-18

- Q: Where does the theme editor live, and who may use it? → A: Outside project options entirely. A
  theme file is opened from the file tree like any other document; when one is selected, the YAML
  theme editor and its sample PDF preview appear as that file type's editor. Access follows ordinary
  file permissions. Project options retains only the choice of which theme file the project uses.
- Q: How is a file recognised as a PDF theme? → A: By filename convention alone — a file named
  `*-theme.yml` or `*-theme.yaml` is a theme. This is exactly the rule the renderer already uses to
  discover themes, so what the editor opens can never diverge from what the PDF actually applies.
  Other YAML files open in the ordinary editor regardless of their contents.
- Q: Is theme editing collaborative? → A: Yes — fully collaborative, exactly like any other project
  document: shared editing session, presence and live cursors, with each participant's preview
  reflecting the shared state. The theme editor inherits the project's existing co-editing behaviour
  rather than defining its own.
- Q: Does a theme have an explicit save, or persist continuously? → A: Continuous, exactly like
  documents — no save or publish step, edits are live immediately, and exports use whatever the theme
  file currently contains. Consistency with every other project file was preferred over shielding
  exports from a colleague's in-progress edit.
- Q: What does the shipped extension catalogue contain? → A: The catalogue ships with a small set of
  useful extensions, so this feature also adds pure-Ruby, sandbox-safe extensions to the bundled
  renderer rather than only surfacing what is already there. Each addition needs bundle-size
  justification and its own reference-parity coverage.
- Q: Should a bibliography extension be among them? → A: No. Bibliography support already exists as a
  complete CSL implementation outside the renderer, is wired into the pipeline, and is verified
  against the canonical bibliography gem's own output. Bundling that gem would duplicate working
  behaviour (barred by FR-032d) and its BibTeX parser is generated rather than plain Ruby, which the
  sandbox rules out. Bibliography is therefore out of scope for the catalogue.
- Q: Can a project supply its own extension code? → A: No — removed after a security finding. The
  renderer's Ruby VM includes the JavaScript host bridge, which exposes the browser's global scope to
  any Ruby that asks for it. Project-supplied code could therefore reach the network through
  JavaScript regardless of the renderer's own sandboxing, breaking the non-waivable no-egress rule,
  and would run in *other members'* browsers carrying their session. Extensions may now come only from
  the deployment: the shipped set, plus a folder the administrator controls. An administrator who can
  write to that folder already controls the application, so the same code carries no new privilege
  there — which is precisely why the folder is acceptable and the project file tree was not.
- Q: Is the full 13-extension catalogue in scope for this feature? → A: Yes. All three tiers ship in
  this feature; none is deferred to a follow-up. The tiers order the work and keep it incrementally
  releasable, but the feature is not complete until all thirteen are delivered, each with the
  reference-parity coverage and size measurement every shipped extension requires.
- Q: What do change bars compare against? → A: Nothing yet — change bars are postponed. Marking
  changed content is only worthwhile diffed against a real revision history, which does not exist in
  the project today. Rather than ship a markup-driven version that asks authors to mark their own
  changes and would later be replaced, the extension waits until version history is available. Tier 1
  therefore ships four extensions, and the catalogue twelve.
- Q: Are paragraph numbers stable across re-exports? → A: No, and deliberately so. Numbers run
  sequentially in document order, are assigned before rendering begins, and are not persisted — which
  is exactly what the reference implementation does. Structural or persistent identifiers were
  rejected: either would make output diverge from the canonical toolchain running the same extension,
  which the parity requirement forbids. Only paragraphs that are direct children of the document or a
  section are numbered. The catalogue entry must warn that numbers shift when content is inserted, so
  nobody cites them across revisions.
- Q: Does the theme editor's sample preview run the project's enabled extensions? → A: Yes, and it
  offers a comparison toggle: the member selects one of the project's enabled extensions and switches
  the preview between rendering with it and without it, so its effect is visible by direct comparison
  rather than left to be inferred from a single rendering. For the toggle to mean anything the sample
  document must contain content each shipped extension acts on, so the sample grows alongside the
  catalogue.
- Q: Where does an extension's configuration live, given a theme cannot say "this section here"? → A:
  Split by concern. How an extension *looks* — bar colour and width, column gap, number format — is
  theme settings, keeping the theme the single description of appearance. What an extension *acts on*
  — which section is multi-column, which image floats, where the license page goes — is expressed in
  the document as block attributes and roles the author writes, which is how AsciiDoc already targets
  behaviour. Inventing a selector vocabulary in the theme was rejected: the reference toolchain has
  no such concept, so it would put parity at risk.
- Q: What kind of thing is an "extension" here? → A: A customisation of the PDF converter itself —
  code that overrides how the converter renders a particular element or stage of the document, in the
  manner the PDF converter's own extension documentation describes (custom title pages, per-chapter
  contents, multi-column sections, paragraph numbering, and similar). It is
  NOT a third-party gem from the general Asciidoctor extension catalogue. Extensions are therefore
  written for this application rather than sourced, and they read their settings from the theme —
  which ties them directly to the theme editor in US2.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Navigate project options by section (Priority: P1)

A project owner opens their project's options page. Instead of one long scrolling page mixing
project identity, rendering behaviour, PDF layout, fonts, attributes and destructive actions, they
see a list of named sections (e.g. "General", "Rendering", "PDF", "Advanced", "Danger Zone"). They
select the section they care about and only that section's settings are shown. They can link
someone directly to a specific section, and returning to the page later takes them back to a
predictable place.

**Why this priority**: The options page already carries 15+ settings across four unrelated concerns
and is the surface that the other two stories add to. Splitting it first prevents this feature from
making an already-crowded page worse, and it delivers standalone value (faster setting discovery)
without depending on anything else in this feature.

**Independent Test**: Can be fully tested by opening project options, confirming each section is
reachable and shows only its own settings, that a direct link to a section opens that section, and
that every setting that existed before is still reachable and still saves correctly.

**Acceptance Scenarios**:

1. **Given** a project owner on the project options page, **When** the page loads, **Then** a
   section navigation is shown with a default section selected and only that section's settings
   visible.
2. **Given** the options page, **When** the owner selects a different section, **Then** the settings
   for that section replace the previous section's settings and the address of the page reflects the
   selected section.
3. **Given** a direct link to a specific section, **When** the link is opened, **Then** that section
   is selected on load.
4. **Given** unsaved edits in a section, **When** the owner navigates to a different section,
   **Then** the system does not silently discard the edits.
5. **Given** an archived project, **When** the owner opens any section, **Then** the settings in
   every section are shown as read-only, consistent with today's behaviour.
6. **Given** a non-owner project member, **When** they attempt to open project options, **Then**
   access is refused exactly as it is today.

---

### User Story 2 - Edit a PDF theme and see its impact live (Priority: P2)

A project member selects a PDF theme file in the project's file tree. Because the file is recognised
as a theme, it opens in a theme editor rather than the ordinary text or document editor: on the left,
an editor over the theme's YAML that offers completion for known theme settings and their permitted
values, and shows colours as swatches and font settings as rendered samples inline as they are typed.
On the right, a PDF preview of a built-in sample document that deliberately exercises the parts of a
document a theme affects — title page, headings at several levels, body text, lists, tables,
admonitions, quotes, source code, footnotes and page furniture. The preview re-renders automatically
as the YAML changes, so the member sees the effect of each edit without creating a throwaway document
and without exporting. Invalid YAML is reported clearly and the last valid preview remains visible.

**Why this priority**: This is the headline capability, but it is the largest of the three. It is
independent of US1 — it lives in the editing surface, not in project options — and independently
valuable: it removes the current edit-file → export → open-PDF → repeat loop.

**Independent Test**: Can be fully tested by selecting a theme file in the file tree, confirming the
theme editor and sample preview open, making a visually obvious theme change (e.g. a heading colour),
and confirming the sample preview reflects the change without any manual export; then introducing
invalid theme content and confirming an actionable error appears while the previous preview is
retained.

**Acceptance Scenarios**:

1. **Given** a theme file in the file tree, **When** the member selects it, **Then** the theme editor
   opens with that file's YAML on one side and the sample PDF preview on the other, instead of the
   ordinary text editor.
1a. **Given** a project with no theme file, **When** a member creates one, **Then** it can be seeded
    with the effective default theme rather than starting empty.
2. **Given** the theme editor, **When** the member changes a theme value, **Then** the sample preview
   updates to reflect the change without the member triggering an export.
3. **Given** the cursor at a position where a theme setting is expected, **When** the member requests
   completion, **Then** known theme settings valid at that position are offered with a description of
   what each controls.
4. **Given** a theme value that is a colour, **When** it is displayed in the editor, **Then** the
   colour is shown as a swatch beside it; **Given** a value that names a font, **Then** a rendered
   sample of that font is shown.
5. **Given** the theme editor, **When** the member types continuously, **Then** the editor stays
   responsive and preview updates are coalesced rather than queued per keystroke.
6. **Given** YAML that is malformed or contains an unrecognised setting, **When** the preview is
   attempted, **Then** a clear message identifies the problem and the line it occurs on, and the most
   recent successfully rendered preview remains on screen.
7. **Given** edited theme content, **When** the member stops typing, **Then** the edit has already
   persisted with no save step, and subsequent PDF exports and previews of real project documents use
   it.
8. **Given** a theme file left in an unparseable state, **When** a member exports a real document,
   **Then** the failure names the theme file and the problem's location rather than failing
   generically.
9. **Given** a theme that references a font not available to the project, **When** the preview
   renders, **Then** the substitution or omission is surfaced as a warning rather than failing the
   whole preview.
10. **Given** a saved theme, **When** a real project document is exported to PDF, **Then** its
    appearance is consistent with what the sample preview showed for the same theme.
11. **Given** a member without permission to modify the theme file, **When** they open it, **Then**
    they may read the theme and see the preview but cannot save changes — the same rule that governs
    any other project file.
12. **Given** a YAML file whose name does not match the theme convention, **When** the member selects
    it, **Then** it opens in the ordinary editor even if its contents look like a theme.
13. **Given** an open non-theme file, **When** it is renamed to match the theme convention, **Then**
    it becomes a theme file and is thereafter opened in the theme editor.

---

### User Story 3 - Choose which PDF extensions a project uses (Priority: P3)

A project owner opens the extensions area of project options and sees the catalogue of available PDF
extensions — customisations of how the PDF converter renders a document. Each entry has a name, a
short description of what it changes, and its current on/off state for this project. The extensions
that ship with the application cover reviewing and navigating a document (paragraph numbering,
per-chapter contents, a custom title page, orphaned-heading avoidance), its layout
(multi-column sections, oversized tables on their own page size, image float wrapping, a narrow
contents list), and its front and back matter (license page, colophon placement, extra contents
entries, title-block document details). Alongside these the catalogue lists any extensions this
deployment's administrator has added by dropping them into the deployment's extension folder — these
appear and behave identically, so the owner need not care which is which. The owner enables the ones
their documents need. Because these extensions read
their settings from the theme, enabling one typically adds new settings the theme editor from US2 can
then complete and preview.

**Why this priority**: Valuable for projects with demanding document formats, but the smallest
audience of the three and the least disruptive if deferred. It depends on the sectioned page (US1)
for a sensible home and gains most of its value once the theme editor (US2) exists to configure it,
so it should land last.

**Independent Test**: Can be fully tested by enabling an extension with a visible effect (e.g.
paragraph numbering), exporting a document that triggers it, and confirming the output changes
accordingly; then disabling it and confirming the output returns to its unextended form.

**Acceptance Scenarios**:

1. **Given** the extensions area, **When** it loads, **Then** every selectable extension is listed
   with its name, description, origin (shipped or administrator-provided) and current state.
2. **Given** an extension that is off, **When** the owner enables it and saves, **Then** subsequent
   renders and PDF exports for the project apply that extension.
3. **Given** an enabled extension, **When** the owner disables it and saves, **Then** subsequent
   renders and exports no longer apply it, and the output returns to its unextended form.
3a. **Given** an enabled extension that reads settings from the theme, **When** the member edits the
    theme, **Then** the theme editor completes that extension's settings alongside the built-in ones
    and the sample preview renders with that extension applied.
3a1. **Given** a project with extensions enabled, **When** the member selects one and toggles the
     comparison, **Then** the preview switches between rendering with and without that extension, and
     nothing else about the rendering changes.
3b. **Given** two enabled extensions that customise the same part of the document, **When** a
    document is rendered, **Then** the outcome is defined and predictable rather than dependent on
    load order.
3c. **Given** a document carrying markup that targets an extension, **When** that extension is
    disabled, **Then** the document renders exactly as it would without the markup — no error, no
    stray output.
3d. **Given** an extension's catalogue entry, **When** the owner reads it, **Then** it tells them the
    markup an author writes to direct that extension at specific content.
4. **Given** a saved selection that names an extension no longer offered, **When** the page loads,
   **Then** the stale entry is surfaced to the owner rather than silently applied or silently
   dropped.
5. **Given** any selection of extensions, **When** rendering runs, **Then** it stays within the
   browser sandbox and performs no outbound network fetch of extension code.
6. **Given** any project member, **When** they add a Ruby file to their project's file tree, **Then**
   it has no effect on rendering at all — project content can never introduce executable code.
7. **Given** an administrator, **When** they place a valid extension in the deployment's extension
   folder, **Then** it appears in every project's catalogue, disabled, without a rebuild or
   redeployment.
8. **Given** an extension file in that folder that fails to load or has a malformed manifest, **When**
   the catalogue is built, **Then** the administrator is told which file failed and why, the entry is
   excluded, and every other extension still works.
9. **Given** two extensions in the folder declaring the same identifier, **When** the catalogue is
   built, **Then** the conflict is reported rather than one silently winning.
10. **Given** an administrator adds an extension, **When** existing projects render, **Then** their
    output is unchanged, because the new extension starts disabled everywhere.

---

### Edge Cases

- What happens when two owners edit project options in different sections concurrently — does saving
  one section overwrite another section's unsaved-elsewhere values?
- What happens when the theme editor is open and the project is archived in another tab?
- What happens when a file is renamed so that it starts, or stops, being recognised as a theme while
  it is open in an editor?
- What happens when theme content is valid but produces an unrenderable result (e.g. a page margin
  larger than the page)?
- What happens when the sample preview cannot render at all (rendering engine unavailable or fails
  to start)?
- What happens when a saved theme is very large, or contains content far beyond what a theme should
  carry?
- What happens to an in-flight preview render when the member closes the theme editor or the tab?
- What happens when a member leaves the theme unparseable and logs off — how does the next member to
  attempt an export find out why it broke?
- What happens to the comparison toggle when the selected extension is disabled in project options
  while the theme editor is open?
- How long may the comparison toggle take to switch — is the alternate rendering prepared in advance
  or produced on demand?
- What happens when the theme file is deleted, renamed or moved by another member while the theme
  editor is open?
- What happens when one member's in-progress edit leaves the theme momentarily invalid while another
  member is watching the preview?
- What happens to a project that has an extension enabled when the administrator removes that
  extension from the deployment folder?
- What happens when an administrator replaces an extension file with a changed version while members
  are rendering?
- What happens when a member cites a paragraph number in a review comment and the document is then
  edited above it — is the now-stale citation detectable?
- What happens when two enabled extensions compete for the same page — for example a large table
  demanding an alternate page size inside a multi-column section?
- What happens when a document carries targeting markup for an extension that is enabled, then the
  owner disables that extension while members are working?
- What happens when the custom title page extension is enabled but the project supplies no logo?
- What happens when an administrator's extension is incompatible with the renderer version after an
  application upgrade — is the breakage attributable to that extension?
- How does the section navigation behave on a narrow/mobile viewport where a side navigation does not
  fit?
- What happens when an owner links to a section identifier that does not exist?

## Requirements *(mandatory)*

### Functional Requirements

#### Sectioned project options

- **FR-001**: The project options page MUST present its settings grouped into named sections, with
  only the selected section's settings displayed at a time.
- **FR-002**: Every setting reachable on the project options page before this feature MUST remain
  reachable within exactly one section after it.
- **FR-003**: The selected section MUST be addressable, so that a link opens the page with that
  section selected.
- **FR-004**: The system MUST select a sensible default section when none is specified, and MUST
  fall back to that default when an unknown section is requested.
- **FR-005**: Changing sections MUST NOT silently discard unsaved edits in the section being left.
- **FR-006**: Saving within one section MUST NOT overwrite or reset settings belonging to other
  sections.
- **FR-007**: Existing access control and archived-project read-only behaviour MUST apply uniformly
  to every section.
- **FR-008**: The section navigation MUST remain usable on small viewports.

#### PDF theme editing and preview

- **FR-009**: Selecting a theme file in the project's file tree MUST open it in a theme editor — a
  two-pane workspace with the theme text on one side and the rendered sample preview on the other —
  in place of the editor that file would otherwise open in.
- **FR-009a**: A project file MUST be recognised as a PDF theme by its filename alone, using the same
  `*-theme.yml` / `*-theme.yaml` convention the renderer already uses to discover themes. Only such
  files MUST open in the theme editor; every other file, including other YAML files, MUST open as it
  does today regardless of its contents.
- **FR-009b**: The rule that decides which files the theme editor opens and the rule that decides
  which theme the renderer applies MUST be the same rule, so the two can never disagree.
- **FR-009c**: Files recognised as themes MUST be distinguishable as such in the file tree.
- **FR-010**: When a member creates a file whose name marks it as a theme, the system MUST offer to
  seed it with the effective default theme rather than leaving it empty.
- **FR-010a**: The theme editor MUST offer completion for theme settings that are valid at the
  cursor's position, together with a description of what each setting controls and, where a setting
  accepts a fixed set of values, those values.
- **FR-010b**: The editor MUST render recognised colour values as colour swatches and recognised font
  values as samples of that font, inline, as the theme is edited.
- **FR-010c**: The editor MUST report structural errors in the theme text against the line on which
  they occur.
- **FR-011**: The system MUST provide a built-in sample document that exercises the document
  elements a theme affects — at minimum: title page, multiple heading levels, body paragraphs,
  ordered and unordered lists, a table, admonitions, a block quote, a source code block, a footnote,
  and running page furniture (header/footer/page numbers).
- **FR-011a**: The sample document MUST also contain the content and targeting markup that every
  shipped extension acts on, so that toggling any one of them produces a visible difference. An
  extension whose effect the sample cannot demonstrate MUST NOT ship without the sample being
  extended to cover it.
- **FR-011b**: The sample document MUST remain a coherent, readable document rather than a catalogue
  of disconnected fragments, so that it also serves its primary purpose of judging the theme itself.
- **FR-012**: The system MUST render the sample document with the theme currently in the editor and
  display the result alongside the editor.
- **FR-013**: The preview MUST update in response to theme edits without the member performing an
  export, and updates MUST be coalesced so that continuous typing does not produce one render per
  keystroke.
- **FR-014**: Theme editing and preview rendering MUST NOT block typing, scrolling or navigation in
  the page.
- **FR-015**: The system MUST validate theme content and report problems with enough detail to
  locate them, without discarding the most recently rendered valid preview.
- **FR-016**: The system MUST warn — rather than fail the whole preview — when a theme references a
  resource (such as a font) that cannot be resolved for the project.
- **FR-017**: Theme edits MUST persist continuously as part of the co-editing session, on the same
  terms as the project's other files. The theme editor MUST NOT introduce a save, publish or apply
  step that no other file has.
- **FR-017a**: Because there is no save step, edits MUST take effect immediately: the project's PDF
  exports and document previews MUST use the theme file's current contents.
- **FR-017b**: When the theme file cannot be parsed, an export or document preview that depends on it
  MUST fail with a message naming the theme file and the problem's location — never with an
  unattributed or generic failure.
- **FR-018**: The theme a project resolves to MUST be applied to that project's PDF exports and to
  PDF previews of the project's real documents.
- **FR-019**: The appearance produced for the sample preview and the appearance produced by a full
  PDF export MUST be consistent for the same theme.
- **FR-020**: Rendering the same theme and the same sample document repeatedly MUST produce the same
  visual result.
- **FR-021**: Theme content MUST be treated as untrusted input; it MUST NOT be able to cause reading
  of resources outside the project, execution outside the rendering sandbox, or any outbound network
  request.
- **FR-022**: The system MUST enforce a documented upper bound on theme file size, consistent with
  the limits applied to the project's other files, and report exceeding it clearly.
- **FR-023**: Saving a theme MUST be recorded in the project's audit trail, consistent with how the
  project records changes to its other files.
- **FR-024**: The theme MUST be stored as a file within the project's own file tree, so that it is
  the same artefact the existing theme-selection setting already resolves; the feature MUST NOT
  introduce a second, competing place a theme can come from.
- **FR-025**: The system MUST make clear which theme file the project currently resolves to, and
  MUST allow the owner to change that selection from project options.
- **FR-026**: Opening, reading and saving a theme file MUST follow the project's existing file
  permissions, exactly as for any other project file; a member who may not modify the file MUST still
  be able to read it and see the preview. The theme editor MUST NOT introduce an access rule of its
  own.
- **FR-026a**: Theme files MUST be co-editable in real time on the same terms as the project's other
  documents, including presence and live cursors. Concurrent edits MUST merge rather than overwrite,
  and no participant's edits may be silently lost.
- **FR-026b**: Each participant's sample preview MUST reflect the shared state of the theme, so that
  members editing together see the same rendered result.

#### PDF extension selection

- **FR-026c**: A *PDF extension* means code that customises how the PDF converter renders a document
  — overriding the treatment of an element, a stage, or a piece of page furniture. The catalogue MUST
  NOT be used to distribute general-purpose third-party processing gems.
- **FR-027**: The system MUST present a catalogue of selectable PDF extensions, each with a name, a
  description of what it changes about the output, and whether it ships with the application or was
  added by this deployment's administrator.
- **FR-028**: Project owners MUST be able to enable or disable each catalogued extension for their
  project and persist that selection.
- **FR-029**: The project's enabled extension selection MUST be applied when rendering and exporting
  that project's documents.
- **FR-030**: A persisted selection referencing an extension that is no longer offered MUST be
  surfaced to the owner rather than silently applied or silently dropped.
- **FR-031**: Extensions MUST run entirely inside the rendering sandbox; the system MUST NOT fetch or
  install extension code from the network at runtime.
- **FR-031a**: An extension's *appearance* — colours, widths, spacing, numbering format and the like —
  MUST be expressed as theme settings rather than as a separate configuration mechanism, so the theme
  remains the single description of how a document looks.
- **FR-031a1**: An extension's *targets* — which section, block or image it acts on, and where
  inserted matter goes — MUST be expressed in the document using block attributes and roles, the
  means AsciiDoc already provides for directing behaviour at specific content. Targeting MUST NOT be
  expressed in the theme.
- **FR-031a2**: Targeting markup MUST be inert when its extension is disabled: a document carrying it
  MUST render exactly as it would without the markup, with no error and no stray output.
- **FR-031a3**: Each extension MUST document the markup that targets it, and that markup MUST be
  discoverable from the extension's catalogue entry.
- **FR-031b**: The theme editor MUST complete and describe the theme settings contributed by the
  project's enabled extensions on the same terms as built-in ones, and the sample preview MUST render
  with those extensions applied.
- **FR-031b1**: The sample preview MUST offer a comparison toggle: the member selects one of the
  project's enabled extensions and switches the preview between rendering with that extension and
  rendering without it, so its effect is seen by direct comparison rather than inferred.
- **FR-031b2**: The comparison toggle MUST change only whether the selected extension applies.
  Everything else — the theme, the sample document, and the project's other enabled extensions — MUST
  be identical between the two renderings, so any difference is attributable to that extension alone.
- **FR-031b3**: When a project has no extensions enabled, the comparison toggle MUST be absent or
  plainly unavailable rather than present and inert.
- **FR-031c**: When several enabled extensions customise the same aspect of the output, the result
  MUST be defined and repeatable rather than dependent on the order in which they happen to load.
- **FR-032**: Changing the extension selection MUST be recorded in the project's audit trail,
  including who changed it and which extensions were affected.

##### Shipped extensions

- **FR-032a**: The application MUST ship with a set of PDF extensions available to every project,
  each appearing in the catalogue with its name and a description of what it changes. The shipped set
  MUST comprise the following twelve, grouped by delivery tier:

  *Tier 1 — review and navigation*

  - **Paragraph numbering** — prints a number beside each paragraph, so a specification can be
    reviewed and discussed paragraph by paragraph rather than by page. Numbers run sequentially in
    document order and cover only paragraphs that are direct children of the document or a section.
  - **Per-chapter contents** — adds a contents list at the start of each chapter, so a long document
    can be navigated from where the reader is rather than only from the front.
  - **Custom title page** — composes the title page from the project's own logo and decorative
    elements rather than the default arrangement.
  - **Orphaned-heading avoidance** — pushes a heading to the next page when too little of its content
    would follow it, so no section begins at the foot of a page.

  *Tier 2 — layout*

  - **Multi-column sections** — sets a nominated section in multiple columns.
  - **Alternate page size for large tables** — renders a table that would not otherwise fit on a
    larger or differently-oriented page.
  - **Image float wrapping** — wraps text and code blocks around a floated image.
  - **Narrow contents** — renders the table of contents in a narrower measure than the body.

  *Tier 3 — front and back matter*

  - **Automatic license page** — inserts a license page at a defined position without the author
    placing it.
  - **Colophon placement** — positions a colophon ahead of the table of contents.
  - **Additional contents entries** — admits entries to the table of contents beyond section
    headings.
  - **Title-block document details** — prints author, date and revision beneath the document title.

- **FR-032a1**: Every shipped extension MUST be independently enableable; none may depend on another
  being enabled, within or across tiers.
- **FR-032a2**: The tiers define delivery order only. All three are in scope for this feature and it
  is not complete until every extension listed above ships. Each tier MUST nonetheless be
  independently releasable and independently valuable, so the work can land incrementally; a later
  tier MUST NOT alter the behaviour of an earlier one.
- **FR-032a3**: A customisation that is achievable through theme settings alone MUST be delivered as
  theme settings and MUST NOT be added to the catalogue, per FR-032d. This test MUST be applied to
  every extension above before it ships, and any that fails it MUST be dropped from the catalogue and
  delivered as theme settings instead.
- **FR-032a4**: The shipped set is a floor, not a ceiling — further extensions MAY be added later
  under the same rules, and adding one MUST NOT alter the behaviour of an already-shipped extension.
- **FR-032a4a**: Paragraph numbers MUST be assigned sequentially in document order, before rendering
  begins, so that a paragraph's number never depends on where it falls on a page. They MUST NOT be
  persisted between exports.
- **FR-032a4b**: Paragraph numbering MUST cover only paragraphs that are direct children of the
  document or a section, excluding those nested within lists, tables, admonitions and similar blocks.
- **FR-032a4c**: Because numbers shift when content is inserted, the extension's catalogue entry MUST
  say so plainly, so that members do not cite a paragraph number across revisions.
- **FR-032a5**: Change bars — marking content that changed with a rule in the margin — are explicitly
  OUT of scope for this feature. Marking changes is only worth doing against a real revision history,
  which the project does not yet have; a markup-driven substitute that relies on authors marking
  their own changes would be less useful and would have to be replaced. This extension MUST wait
  until version history exists.
- **FR-032b**: Shipped extensions MUST be written for this application and bundled into the renderer
  when the application is built; they MUST NOT be fetched or assembled at runtime.
- **FR-032c**: Only extensions that are sandbox-safe — requiring no native code, no subprocess, and
  no host access — MAY ship. An extension that cannot meet this MUST NOT ship.
- **FR-032d**: A shipped extension MUST NOT duplicate or conflict with a capability the renderer
  already provides through a setting or the pipeline already provides through a stage; where one
  already serves the need, it remains the single way to reach it.
- **FR-032e**: Each shipped extension MUST have reference-parity coverage demonstrating that enabling
  it produces output matching the canonical toolchain running the same extension over the same input.
- **FR-032f**: Shipped extensions MUST be loadable by the canonical command-line toolchain as well as
  by the in-application renderer, so that the reference build required by FR-032e is possible at all.
- **FR-032g**: Shipped extensions MUST default to disabled for existing projects, so that adding one
  never changes how an existing project's documents render.
- **FR-032h**: Every shipped extension MUST be justified against its cost to application download
  size, and that cost MUST be measured rather than estimated.

##### Administrator-provided extensions

- **FR-033**: A deployment's administrator MUST be able to add extensions by placing extension files
  in a designated folder of that deployment, without rebuilding the application and without editing
  any part of it.
- **FR-033a**: Extensions found in that folder MUST appear in the catalogue alongside the shipped ones
  and MUST be selectable per project on identical terms; a project owner MUST NOT need to know or care
  which of the two an extension came from, beyond its stated origin.
- **FR-033b**: The folder MUST be scanned so that adding, changing or removing an extension takes
  effect without a redeployment. How promptly is a deployment concern, but the administrator MUST NOT
  have to rebuild the renderer or any part of the application. The folder MUST therefore live outside
  anything baked at build time.
- **FR-033f**: Extension source and catalogue metadata MUST be readable only by authenticated members
  of a project that can use them. Placing an extension on the deployment MUST NOT make its source
  publicly downloadable.
- **FR-033c**: An administrator-provided extension MUST declare the same manifest a shipped one does —
  identifier, display name, description, contributed theme settings, and targeting markup — so it is
  indistinguishable from a shipped extension in the catalogue and in the theme editor.
- **FR-033d**: An extension file that fails to load, or whose manifest is missing or malformed, MUST be
  reported to the administrator and excluded from the catalogue, and MUST NOT prevent the other
  extensions or the application from working.
- **FR-033e**: Two extensions declaring the same identifier MUST be reported as a conflict rather than
  one silently overriding the other.
- **FR-034**: Extension code MUST be loaded only from the application's own deployment — the shipped
  set and the administrator's folder. The system MUST NOT load extension code from project content,
  from a document, or from any location a project member can write to.
- **FR-035**: A project MUST NOT be able to introduce executable extension code. Placing a Ruby file in
  a project's file tree MUST have no effect on rendering whatsoever.
- **FR-036**: Adding an extension to the deployment MUST NOT change how any existing project renders;
  every extension starts disabled for every project (as FR-032g requires of shipped ones).
- **FR-037**: Administrator-provided extensions MUST be documented as carrying the same trust as the
  application's own code, because they run in every member's browser for any project that enables
  them. The documentation MUST state this plainly rather than implying the renderer sandboxes them
  from the deployment.

### Key Entities

- **Project options section**: A named, addressable grouping of project settings; has an identifier
  used for linking, a display label, and the set of settings it owns.
- **PDF theme**: The styling definition applied when producing a PDF for a project — fonts, colours,
  spacing, page geometry, and per-element styling. Lives as a file in the project's file tree,
  identified by its `*-theme.yml` / `*-theme.yaml` name; co-edited like any other document. A project
  may hold several, but resolves to at most one at a time.
- **Theme setting descriptor**: A known theme setting the editor can complete and explain — its name,
  where it is valid, what it controls, its value kind (colour, font, measurement, keyword) and, for
  keyword settings, the permitted values. Drives both completion and the inline colour/font previews.
  Contributed either by the renderer itself or by an enabled extension.
- **Theme preview sample**: A fixed, system-provided document used solely to demonstrate a theme's
  effect. Not owned or editable by the project, and never part of the project's file tree.
- **Extension catalogue entry**: A selectable PDF converter customisation; has a stable identifier,
  display name, a description of what it changes about the output, origin (shipped or
  administrator-provided), availability state, the theme settings it contributes, and the targeting
  markup that directs it.
- **Project extension selection**: The set of catalogue entries a project has enabled; belongs to
  exactly one project. Records only identifiers — never code, since all code comes from the
  deployment.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner can locate any given project setting from the options page in under 15
  seconds, versus scrolling an undivided page today.
- **SC-002**: No setting available before this feature becomes unreachable after it — 100% of prior
  settings are present in exactly one section and still save successfully.
- **SC-003**: After changing a theme value, the member sees the updated sample preview within 3
  seconds for a typical theme change, without performing any export step.
- **SC-004**: The page remains interactive while a preview render is in progress — typing and
  scrolling stay responsive with no perceptible stall.
- **SC-005**: 100% of invalid theme submissions produce an actionable message identifying the problem
  location, and none of them leave the member with a blank preview area.
- **SC-006**: The appearance of the sample preview matches the appearance of an exported PDF using
  the same theme for the same content, within the project's established fidelity tolerance.
- **SC-007**: Rendering the same theme twice produces an identical result 100% of the time.
- **SC-008**: An owner can enable an extension and confirm its effect on their document's output
  without leaving the application or contacting support.
- **SC-009**: Theme editing produces zero outbound transmissions of project document content.
- **SC-010**: Members complete a first theme customisation (select the theme file → change a value →
  see the effect) on first attempt without external documentation in at least 90% of attempts.
- **SC-010a**: 100% of export failures caused by an unparseable theme name the theme file and the
  problem's location.
- **SC-011**: Completion offers a known theme setting for at least 90% of the settings the sample
  document's default theme uses, and offers no setting the renderer does not recognise.
- **SC-012**: Zero lines of project-supplied content are ever executed — a Ruby file placed anywhere in
  a project's file tree has no effect on rendering.
- **SC-012a**: Every shipped extension has reference-parity coverage before release — no extension
  ships unverified.
- **SC-012b**: Enabling no extensions leaves an existing project's rendered output byte-identical to
  what it produced before this feature.
- **SC-013**: An administrator can add a working extension to a running deployment, and see it in a
  project's catalogue, without rebuilding the application or editing any of it.
- **SC-013a**: A malformed or unloadable extension in the administrator's folder never breaks the
  catalogue or the application — 100% of such cases produce a report naming the file and leave every
  other extension working.
- **SC-014**: Every shipped extension has reference-parity coverage proving its output matches the
  canonical toolchain running the same extension — no extension ships without it.
- **SC-014a**: Every theme setting contributed by an enabled extension is completed and described by
  the theme editor, with none missing.
- **SC-014b**: Every shipped extension produces a visible difference in the sample preview when the
  comparison toggle is switched — no extension is offered whose effect the sample cannot show.
- **SC-015**: Projects that enable no extensions render and export exactly as they did before this
  feature, with no change in output.
- **SC-015a**: Every shipped extension produces a visible, verifiable change to the exported document
  when enabled, and leaves the output byte-identical to the unextended form when disabled.
- **SC-015b**: Enabling every shipped extension at once renders successfully, and no pair of them
  produces a result that depends on which loaded first.
- **SC-015c**: Each tier can be released on its own: with only the tiers before it present, the
  application renders and exports correctly and the catalogue lists exactly the extensions that
  exist.
- **SC-016**: The application's download size grows by no more than an agreed budget per shipped
  extension, measured against the pre-feature baseline.

## Assumptions

- Project options remain owner-only; choosing which theme the project uses, and enabling extensions,
  are owner actions taken there.
- Editing a theme's contents is not a project-options action at all. A theme is an ordinary project
  file, opened from the file tree, and governed by the same permissions as any other file.
- This feature introduces no new roles and no new access rules.
- The existing archived-project read-only rule applies unchanged to every new section and control.
- Section splitting is a reorganisation of the existing options surface plus the new sections
  introduced here; it does not add, remove or change the semantics of any pre-existing setting.
- The sample preview document is authored and maintained by the system, is not localised per project,
  and is not counted against any project storage or file limits.
- Theme editing targets the PDF output only; it does not affect the HTML preview's styling.
- Rendering and preview continue to run entirely in the browser, consistent with the project's
  client-side-by-default rule; no server-side rendering is introduced.
- Extension selection is per project, not per document and not per user.
- The theme is a project file; the extension selection is stored alongside the project's existing
  render configuration. No new user-visible storage concept is introduced.
- The set of shipped extensions is fixed at build time and cannot change without a new release of the
  application. This feature adds a small set of extensions to that bundle in addition to surfacing
  and toggling them.
- Capabilities already exposed as ordinary render settings (syntax highlighting, hyphenation) remain
  settings and are not restated as catalogue entries.
- Bibliography is already fully served outside the renderer and is excluded from the catalogue; this
  was investigated and settled, not deferred.
- Capabilities the renderer already provides through a document attribute (for example CJK line
  breaking) are settings, not catalogue entries, and MUST NOT be re-added as extensions.
- Change bars are deliberately absent and depend on a revision history the project does not yet have;
  they are expected to arrive once version control support exists, not as part of this feature.
- Shipped extensions are written for this application rather than sourced from the third-party
  Asciidoctor extension ecosystem. Most catalogued gems are unusable here anyway — they require
  native code, external processes or network access, or they only affect HTML output.
- Because shipped extensions are first-party code rather than gems, download-size cost is expected to
  be modest; FR-032h still requires it to be measured rather than assumed.
- Extensions configure themselves through theme settings, so US2 and US3 share one configuration
  surface and the theme remains the single description of a document's appearance.
- Extension code comes only from the deployment: the shipped set, plus whatever the administrator has
  placed in the deployment's extension folder. Project content is never executable.
- An administrator who can write to that folder already controls the deployment, so extensions they
  add carry the same trust as the application's own code. This is why the folder is safe where a
  project-supplied path was not — see the clarification for the reasoning.
- Administrator-provided extensions take the same shape and the same manifest as shipped ones, so one
  loading mechanism and one catalogue serve both.
- One owner edits a project's options at a time in practice; concurrent multi-owner editing of the
  same section is handled by last-write-wins with the conflict surfaced, not by real-time merging.
- The theme editor's knowledge of theme settings tracks the version of the PDF renderer the
  application ships; it is not user-extensible.
- Existing PDF export, PDF preview and diagram/math behaviour continue to work unchanged for projects
  that never touch these new settings.
