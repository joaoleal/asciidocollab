# T074 — Theme-settings test for each catalogue entry

FR-032a3 / FR-032d: *a customisation achievable through theme settings alone MUST ship as theme
settings and be dropped from the catalogue.* T074 requires the verdict be recorded per entry so the
decision is auditable rather than implicit.

Each verdict below was reached by rendering with the canonical Asciidoctor-PDF toolchain, not by
reading documentation — an entry is only "achievable through theme settings" if a theme actually
achieves it.

| Entry | Verdict | Evidence |
|---|---|---|
| `paragraph-numbering` | **Ships** | No theme key numbers paragraphs. Requires a converter hook that counts document-order paragraphs and prepends the number. Verified working against the CLI; parity fixture committed. |
| `orphaned-heading-avoidance` | **Dropped** | The strongest verdict in this table. The base converter's `arrange_heading` **already contains the exact algorithm T047 specifies** — `dry_run single_page: true` around the heading and its next block, then `advance_page if orphaned` — gated on `heading.min-height-after == 'auto'`. The default theme sets that key to `$base_line_height_length * 1.5`, which takes the cheaper fixed-measure branch; setting it to `auto` in the theme activates the identical code. So this is not merely *achievable* through theme settings, it is the *same implementation* reached by one theme key. Confirmed empirically too: a render with and without the extension is identical, and across a swept range of documents no case was found where the default theme orphans a heading and `auto` does not fix it. |
| `custom-title-page` | **Dropped** | The built-in title page already draws `:title-logo-image:` and positions every element from `title-page.*` theme keys — `logo.top`, `title.top`, `title.font-size`, `title.font-color`, `subtitle.*`, `authors.*`, `text-align`. Rendering a document with a logo through the stock toolchain produces the layout this entry was to provide. The attempted implementation reduced to calling `super` in both branches, which is the clearest possible evidence that the theme already expresses it. The no-logo edge case tasks.md assigned here dissolves with it: the built-in layout already collapses the logo's space when there is none. |
| `title-block-document-details` | **Ships, narrowly** *(built, T055)* | The clearest split in this table between what the theme already does and what it cannot. Pulling ANY document attribute into the title block is native: `title-page.authors.content.*` is passed through `apply_subs_discretely` with `drop_lines_with_unresolved_attributes`, so `'{author} — {organization}, {document-id}'` in a theme works today and unset attributes vanish cleanly. Verified. What is NOT reachable is layout: `ink_prose` is called with `normalize: true`, so a multi-line template collapses onto one line — a YAML block scalar with real newlines, an AsciiDoc ` +` hard break, and an inline `<br>` were each tried and each produced one run-on line, the latter two rendering their markup literally. The extension therefore ships with the narrow scope of the labelled multi-line block ONLY, and its manifest tells authors to use the theme key instead when a single line will do. |
| `colophon-placement` | **Ships** *(built, T053)* | Partly native, and the boundary matters. `[colophon]` is a standard AsciiDoc section style that Asciidoctor-PDF already renders — as an ordinary numbered chapter, wherever it was written, listed in the contents. Reordering the source moves it but leaves it numbered and listed; no theme key controls section placement or excludes a section from the contents. Being back matter — after the body, unnumbered, unlisted — is the whole content of the entry and is not otherwise reachable. Kept separate from `auto-license-page` because it places an author's section rather than generating a page from metadata, and a project wanting a colophon usually does not want a generated licence page. |
| `additional-contents-entries` | **Ships** *(built, T054)* | No native equivalent: `get_entries_for_toc` returns `node.sections` and nothing else, and there is no `list_of` anything in the converter. Scope was genuinely open — `data-model.md` left the Notes cell empty — and was settled as separate List of Figures / List of Tables pages rather than figures interleaved into the main contents. The design turns on `ink_toc` being called twice: once in `allocate_toc`'s dry run (which reserves the pages) and once for real AFTER `traverse doc`, when every figure's page is known. That makes the reserve-then-backfill machinery `per-chapter-contents` needs unnecessary here. Verified across a 120-figure document that the lists overflow onto reserved pages without shifting the body or invalidating the main contents' page numbers. |
| `auto-license-page` | **Ships** *(built, T052)* | No native equivalent — the string `license` does not appear anywhere in the converter, and no theme key generates a page; a theme can only style what something else decides to draw. Placement was constrained rather than chosen: `ink_title_page` runs inside `perform_on_single_page` (adding a page there trips the converter's truncation warning), and appending after `convert_document` is too late because `ink_cover_page doc, :back` is one of its last acts. Intercepting the `:back` call is the one point both after the body and before the cover. Verified inert without `:license:` (byte-identical to an unextended control). |
| `narrow-contents` | **Ships** *(built, T051)* | The entry tasks.md predicted would dissolve, and the prediction was wrong. `toc.indent` is applied by `ink_toc_level` around nested levels only, so raising it pushes subsections right while top-level entries keep the full measure and the right edge never moves. Verified by rendering with `toc.indent: 72`. No theme key narrows the list as a whole, so the extension contributes the two that were missing and applies them to `ink_toc` itself — which means the dry run inside `allocate_toc` measures the same narrowed list later inked into the space it reserved. |
| `image-float-wrapping` | **Dropped** | Already native. Asciidoctor-PDF 2.3.24 carries a full float-box implementation — `convert_image` honours a `float` attribute (`BlockFloatNames`), calls `init_float_box` when `supports_float_wrapping?` says the next block can wrap, and `ink_paragraph_in_float_box` lays the prose beside it; a `float-group` role closes the box early. Verified with no extension loaded: prose wraps beside a floated image for its height and returns to the full measure below it. Nothing to build. |
| `large-table-page-size` | **Ships** *(built, T049)* | `page.size` and `page.layout` are document-wide; no theme key gives one block a different page geometry. Worth recording a nuance: the converter is not empty-handed — `convert_page_break` already honours a `[landscape]` role on an explicit page break, so a landscape table is reachable by hand today. What the extension adds is marking the TABLE (which survives the table moving) rather than fencing it between two manual breaks, and a genuine page SIZE change, which `advance_page` supports but no markup exposes. Verified against the CLI; parity fixture committed. |
| `multi-column-sections` | **Ships** *(built, T048)* | The theme has exactly one column setting, `page.columns`, and it applies to the whole document — no theme key columnises one region and leaves the rest of the page full width. Built as a block-attribute target (`[.multi-column]`) rather than whole sections, so a section heading keeps the full measure while its body columnises. Verified against the CLI; parity fixture `extension-multi-column-sections` committed. |
| `per-chapter-contents` | **Ships** *(built, T045)* | Verified absent: a `:toc:` book renders exactly one document-level contents list, and no `toc.*` key produces a per-chapter one — `toclevels` changes the DEPTH of the single list, not the number of lists. Requires the converter's reserve-then-backfill approach. Built and verified against the CLI; parity fixture `extension-per-chapter-contents` committed. |

## Outcome

All twelve entries in `data-model.md` have been assessed. **Nine ship, three were dropped.**

The one prediction the spec itself made was wrong: tasks.md flagged `narrow-contents` as the entry
most likely to dissolve, on the grounds that `toc.indent` and the `toc.*` family already exist. It
survived — `toc.indent` governs nested levels only and never moves the right edge.

Nothing was dropped for the reason T074 is written to catch. FR-032a3 asks whether a customisation is
achievable *through theme settings*; all three drops were instead cases where the CONVERTER already
implements the feature natively (`heading.min-height-after: auto`, the built-in title page,
`init_float_box`). The nearest thing to a theme-settings drop is `title-block-document-details`, which
was not dropped but narrowed: its content half is native and ships as a theme key, and only its layout
half became code.

Worth carrying into any future catalogue: the test that actually earned its keep here was
*"does the stock toolchain already do this?"*, applied by rendering rather than by reading
documentation.

## How the test was applied

1. Render a document that exercises the entry's effect with the stock toolchain and default theme.
2. Render it again with a theme that sets the closest existing key(s).
3. If (2) achieves the effect, the entry is dropped and the theme keys are documented instead.

The `orphaned-heading-avoidance` verdict came out of step 1 alone: the unextended control already
produced the desired output, which is the strongest possible form of this evidence.

## What the results so far suggest

Two of the first three entries assessed do not survive the test. The twelve-entry catalogue in
`data-model.md` was drawn up before this test was applied to any of it, and FR-032a3 exists precisely
because a converter extension is the expensive way to express something a theme key already covers:
it needs code review, a parity fixture, a download-size budget and per-project state, where a theme
key needs none of those and is already completable in the theme editor.

The expectation for the remaining entries should therefore be that several more dissolve — in
particular `narrow-contents` (the `toc.*` family already exists, and tasks.md flags it), and plausibly
`colophon-placement` and `title-block-document-details`, whose effects look expressible through
`title-page.*` and page-furniture keys. Each still gets the render-and-compare test rather than an
assumption.

## Note on what "verified" cost for `per-chapter-contents`

Recorded because it sets the bar for the remaining entries. The extension passed a plain "does the
document render" check while being wrong in three separate ways, each of which produced output that
looked entirely plausible:

1. **Chapters drawn on top of one another.** The backfill returned to the chapter's opening page via
   `go_to_page`, which resets the cursor to the page top. `start_new_chapter` is
   `start_new_page unless at_page_top?`, so the next chapter believed it was already on a fresh page.
   The document-level contents list reported every entry as page 1.
2. **An empty gap where the list should be.** `ink_toc_level` compares its `num_levels` against each
   entry's ABSOLUTE level, but the value being passed was a depth relative to the chapter, so every
   entry hit the skip guard. Space was reserved and nothing was drawn into it — no error, no warning.
3. **Physical page numbers where the footer shows virtual ones.** A chapter whose footer read "1" was
   listed as being on page 3, because the cover and contents pages were counted.

None of these is visible to a unit test, and none raises. Every extension in this catalogue is
therefore verified by rendering against an unextended control and reading the resulting document, not
by asserting that conversion succeeded.

## A defect this catalogue's own composition produced

`colophon-placement` and `auto-license-page` both draw a page from the `:back` call to
`ink_cover_page` — necessarily, because it is the only hook that is after all body content and before
the back cover. Each was correct alone. Enabled together, the page order depended on which was
`prepend`ed last, and therefore on the order the registry loaded them: the same source produced two
different documents. SC-015b forbids exactly this.

The fix separates drawing from ordering. Each participating extension registers a RANKED drawing
callback during `convert_document` — which runs before any body content and before any cover hook, so
every participant has registered by the time the first `:back` hook fires. That hook flushes the
whole queue in rank order and consumes it, so whichever extension's hook happens to run first draws
everyone's pages in an order none of them can influence.

Two things worth carrying forward:

* **Per-extension verification cannot find this class of defect.** Both extensions passed their own
  control-render comparison. Only rendering the same document with both enabled, in both load orders,
  exposed it. Any future extension that draws a back-matter page must join the queue rather than
  drawing from the hook directly.
* **The callbacks are stored as method NAMES, not `Method` objects.** `dry_run` builds its scratch
  document with `Marshal`, and a `Method` cannot be dumped — the first version failed every render
  with "no _dump_data is defined for class Method".

## A second composition defect, found by the all-extensions sample (T058)

Rendering the theme-editor sample with all nine enabled put the colophon and licence pages at the
FRONT of the book, immediately after the contents — not at the back, where each fixture proves they
land when it is the only extension enabled.

The cause is not ordering this time but the CURSOR. Every back-matter page is drawn with
`start_new_page`, which inserts after the *current* page rather than appending, so where back matter
lands depends on where the cursor was left. Nothing guaranteed that was the last page:
`additional-contents-entries` finishes its lists by walking the cursor onto reserved pages near the
front of the book (`go_to_page page_number + 1`), and the flush then inserted straight after them.

The fix is one line at the top of the shared flush — `go_to_page page_count` — and it belongs there
rather than in either drawing method for the same reason the ranked queue does: no participant can
know what the others left the cursor on.

This is the second time composing this catalogue produced a defect that per-extension verification
could not see, and the second time the fix was to move a decision OUT of the individual extensions
and into the shared protocol. The pattern is worth naming: a hook shared by several extensions is a
shared resource, and any state it leaves behind — page order, cursor position, page geometry — is a
coupling between extensions that none of them can observe on its own. The `theme-editing` /
`theme-editing-all-extensions` fixture PAIR exists to make that class of defect visible: same source,
same theme, extensions the only variable.
