/**
 * @file The document the theme editor renders to show a theme's effect.
 *
 * A theme setting an author cannot see is a setting they cannot judge, so this document's job is to
 * exercise EVERY part of a theme at once: title page, all six heading levels (`=` through `======`,
 * which is what `heading.h1` through `heading.h6` style), body prose, both list
 * kinds, a table with header and footer, a figure, admonitions, a block quote, a verse, a source
 * block with callouts, a footnote, and the page furniture. Change `heading.h3.font-color` and
 * something on this page moves.
 *
 * It is also a real document rather than a grid of specimens. A theme is judged by how a document
 * reads under it — line spacing against heading margins, quote indentation against body measure — and
 * a specimen sheet shows every element while showing none of those relationships (FR-011b). So the
 * sample reads as a short guide that happens to use everything.
 *
 * The extension markup below is here whether or not any extension is enabled (T058, FR-011a).
 *
 * The sample also carries the targeting markup of every shipped extension — the attributes and roles
 * each one acts on — so that enabling any single extension produces a VISIBLE difference in this
 * preview and the author can see what they just switched on (SC-014b).
 *
 * That markup is inert when its extension is disabled: each attribute is one nothing else reads, and
 * each role is one no stylesheet defines, so the renderer ignores them and the document reads as an
 * ordinary book (FR-031a2). This is not merely asserted — the `theme-editing` parity fixture renders
 * this exact text with NO extensions enabled and compares it against the canonical toolchain, so
 * markup that stopped being inert would fail there.
 */

/** The project-relative path the sample is mounted at for the preview render. */
export const THEME_PREVIEW_SAMPLE_PATH = 'theme-preview-sample.adoc';

/** The project-relative path the sample's one figure is mounted at. */
export const THEME_PREVIEW_FIGURE_PATH = 'theme-preview-figure.svg';

/**
 * The sample's figure, as SVG source.
 *
 * Carried here as text rather than referenced as a project file so the preview stays self-contained:
 * the snapshot the theme editor renders is built entirely from constants in this module, and cannot
 * be perturbed by what a project happens to contain.
 *
 * Deliberately wordless. Text inside an SVG would be drawn with whatever face the renderer resolves
 * for it, which is neither the theme's body font nor something the theme can influence — so it would
 * be the one thing on the page that does not respond to the theme being edited.
 */
export const THEME_PREVIEW_FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120" viewBox="0 0 360 120">
  <rect x="1" y="1" width="358" height="118" fill="#ffffff" stroke="#cccccc" stroke-width="1"/>
  <rect x="20" y="35" width="90" height="50" fill="#e8eef7" stroke="#4a6fa5" stroke-width="2"/>
  <rect x="135" y="35" width="90" height="50" fill="#e8eef7" stroke="#4a6fa5" stroke-width="2"/>
  <rect x="250" y="35" width="90" height="50" fill="#e8eef7" stroke="#4a6fa5" stroke-width="2"/>
  <line x1="110" y1="60" x2="128" y2="60" stroke="#4a6fa5" stroke-width="2"/>
  <polygon points="135,60 127,56 127,64" fill="#4a6fa5"/>
  <line x1="225" y1="60" x2="243" y2="60" stroke="#4a6fa5" stroke-width="2"/>
  <polygon points="250,60 242,56 242,64" fill="#4a6fa5"/>
</svg>
`;

/**
 * The sample document's AsciiDoc source.
 *
 * Deliberately self-contained: no includes and no reference to anything outside this module. The
 * preview must render identically for every project, and anything reaching outside these constants
 * would make the sample depend on what the project happens to contain.
 */
export const THEME_PREVIEW_SAMPLE = `= Theme Preview
Sample Author <author@example.com>
v1.0, 2026-01-01
:doctype: book
:toc:
:sectnums:
:icons: font
// Metadata a formal book carries. Read by the auto-license-page and title-block-document-details
// extensions when those are enabled; ignored by the renderer otherwise.
:publisher: Example Press
:edition: First edition
:isbn: 978-0-000000-00-0
:copyright: 2026 Sample Author
:license: This sample document is placed in the public domain.
// Each attribute below switches on one shipped extension's contribution to this preview, so that
// enabling that extension visibly changes the page. Each is inert while its extension is disabled.
:title-block-details: Edition=edition, Publisher=publisher
:per-chapter-toc:
:list-of-figures:
:list-of-tables:

[.lead]
This document exists to show what your theme does. It uses every element a theme can style, so a
change to almost any setting will visibly alter something on these pages.

== Headings and prose

Body text sets the measure everything else is judged against. This paragraph runs long enough to
wrap several times, so that line height, text alignment and the page margins can be seen working
together rather than in isolation. A theme that looks correct on a single line often does not.

=== Third-level heading

Text beneath a third-level heading. The spacing above and below a heading is as much a part of the
theme as its size and colour.

==== Fourth-level heading

Deeper headings are rarer, but a theme still has to say something sensible about them.

===== Fifth-level heading

By this depth a heading is often no larger than the body text around it, so what distinguishes it is
the weight, the colour and the space above it rather than the size.

====== Sixth-level heading

The deepest heading AsciiDoc offers, and the one a theme most often forgets: its default size is
smaller than body text, not equal to it. A theme that leaves it undistinguished reads as a paragraph
that lost its break.

== Lists

An unordered list:

* First item
* Second item, which is long enough to wrap and show how a continued list line is indented relative
  to its marker
* Third item
** A nested item
** Another nested item

An ordered list:

. Prepare the document
. Apply the theme
. Read the result

A description list:

Theme:: A YAML file describing how a document is rendered.
Preview:: This document, rendered with that theme.

== Tables

.Quarterly totals
[cols="3,1,1", options="header,footer"]
|===
| Region | Units | Share

| Northern
| 1,204
| 41%

| Southern
| 986
| 34%

| Eastern
| 733
| 25%

| Total
| 2,923
| 100%
|===

A table with more columns than the measure comfortably holds is marked as wide. It reads normally
here, and the large-table-page-size extension moves it onto a landscape page of its own.

.Regional detail by quarter
[.wide-page, cols="2,1,1,1,1,1", options="header"]
|===
| Region | Q1 | Q2 | Q3 | Q4 | Year

| Northern | 284 | 301 | 296 | 323 | 1,204
| Southern | 240 | 248 | 244 | 254 | 986
| Eastern | 179 | 184 | 181 | 189 | 733
|===

.Units by channel
[cols="2,1,1", options="header"]
|===
| Channel | Units | Share

| Direct | 1,608 | 55%
| Partner | 877 | 30%
| Retail | 438 | 15%
|===

== Figures

A captioned figure is styled by its own caption settings, and its alignment and border are separate
theme settings again.

.A three-stage process
image::theme-preview-figure.svg[A diagram of three linked stages, 360, 120]

Several figures show how consecutive captions sit against one another, and give the list of figures
enough entries to judge its own line spacing by.

.The same process at a smaller scale
image::theme-preview-figure.svg[A diagram of three linked stages, 240, 80]

.A deliberately long caption, because a caption that wraps onto a second line in the list of figures is where an entry and its page number are most likely to drift out of alignment
image::theme-preview-figure.svg[A diagram of three linked stages, 300, 100]

== Columns

Prose at the full measure of the page, so that a region set in columns is visibly narrower than the
text around it rather than merely being different.

[.multi-column]
--
A region marked for columns reads as ordinary prose until the multi-column-sections extension is
enabled, at which point it is laid out in two columns while the surrounding text keeps the full
measure. Reference material — a glossary, a long enumeration, a table of symbols — is what this is
for, because a narrow measure suits short entries and wastes space on long paragraphs.

The region runs on for several paragraphs precisely so that the column boundary is somewhere a
reader can see it, rather than being inferred from a single line of text that happens to stop early.
A boundary you can point at is what makes the column gap and the column width worth judging.

Several numbered paragraphs are set here rather than one because paragraph numbering places its
numbers per column: the leftmost column takes them in the left page margin, the rightmost in the
right margin. One number can only ever demonstrate half of that rule, and it is the half that looks
the same as ordinary marginal numbering at the full measure.

Where a column is interior — which a three-column region has and this one does not — the only room
left for a number is the gutter, and that is usually too narrow to hold one. Those paragraphs number
inline instead, so the fallback is visible beside the margin placement rather than only described.

A region this long is deliberate. The numbers on the first column prove only that a number can sit in
the left page margin, which is what marginal numbering does at the full measure too; the rule worth
seeing is the one that sends the rightmost column's numbers the other way.

So the text continues past the point where the columns divide. Everything from here begins inside the
second column, and each of these paragraphs takes its number in the RIGHT page margin — outward,
away from the gutter, mirroring the first column rather than repeating it.

Read the two columns together and the arrangement is legible at a glance: numbers down the outside
edges, nothing in the gutter between them, and the prose keeping a straight measure on both sides
because a marginal number is drawn outside the text rather than inserted into it.

That is the whole of the placement rule for two columns. A three-column region adds one more case,
the interior column, whose numbers fall back inline because a gutter cannot hold them.
--

Full-measure prose resumes after the region.

== Admonitions

NOTE: An informational aside. Admonition padding, label styling and the rule beside it are all
theme settings.

TIP: A suggestion the reader can act on.

WARNING: Something that could go wrong.

CAUTION: Proceed carefully.

IMPORTANT: Do not skip this.

== Quotations

[quote, Ada Lovelace, Notes on the Analytical Engine]
____
The Analytical Engine has no pretensions whatever to originate anything. It can do whatever we know
how to order it to perform.
____

[verse, Emily Dickinson]
____
Tell all the truth but tell it slant —
Success in Circuit lies
____

== Source code

A source block, with callouts:

[source,ruby]
----
require 'asciidoctor-pdf' # <1>

Asciidoctor.convert_file 'document.adoc',
  backend: 'pdf',                          # <2>
  attributes: { 'pdf-theme' => 'my-theme' } # <3>
----
<1> Loads the converter.
<2> Selects the PDF backend.
<3> Applies this theme.

Inline \`monospaced text\` is styled separately from a source block.

== Sidebars and examples

.A sidebar
****
Sidebars carry material that supports the main text without interrupting it. Their background,
border and padding are all theme settings.
****

.An example block
====
Example blocks are styled independently of sidebars, and often differently.
====

== Text styles

*Bold*, _italic_, \`monospace\`, #highlighted#, [.underline]#underlined# and
[.line-through]#struck through# text. A [.big]#larger# and a [.small]#smaller# run. A footnote sits
at the foot of its page.footnote:[Footnotes are styled by their own theme settings.]

A link to https://asciidoctor.org[the Asciidoctor site] shows the link colour.

'''

A thematic break sits above this line.

[colophon]
== Colophon

This sample was set in the theme's own body font. The colophon-placement extension moves a section
marked this way to the back of the book and leaves it out of the contents list.
`;
