/**
 * @file What each Asciidoctor-PDF theme setting means, in prose.
 *
 * This is the ONE hand-maintained half of the theme descriptor catalogue, and it exists because the
 * gem's theme files carry no documentation — a key's meaning cannot be derived from `font_size: 10.5`.
 * Everything else about a key (that it exists, what kind of value it takes, what the default is) is
 * generated from the gem itself in `theme-descriptors.generated.ts`.
 *
 * The split is load-bearing, and so is its guard: `theme-catalogue.test.ts` fails when a key described
 * here is no longer one the generated catalogue offers. Without that check a gem bump would leave
 * descriptions for settings the renderer had dropped, and this file would quietly become the
 * hand-maintained key list the generation exists to avoid. If a bump makes an entry fail, the fix is
 * to delete or re-key the entry — never to relax the check.
 *
 * Keys are the dotted, hyphenated form the generator emits. Descriptions are one line, describe the
 * EFFECT rather than restating the key, and assume an author who knows AsciiDoc but not the theming
 * guide.
 */

/** Prose descriptions keyed by theme setting. Not every key needs one; every entry must be real. */
export const THEME_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  // --- Abstract ---
  'abstract.first-line-font-color': 'Text colour of the abstract’s opening line only.',
  'abstract.first-line-font-style': 'Style applied to the abstract’s opening line only.',
  'abstract.first-line-text-transform': 'Casing applied to the abstract’s opening line only.',
  'abstract.font-color': 'Text colour of the abstract block.',
  'abstract.font-size': 'Text size of the abstract block.',
  'abstract.font-style': 'Text style of the abstract block.',
  'abstract.line-height': 'Line spacing within the abstract, as a multiple of its font size.',
  'abstract.padding': 'Space between the abstract’s text and its edges.',
  'abstract.title.align': 'Legacy alias for the abstract title’s alignment; prefer text-align.',
  'abstract.title.font-color': 'Text colour of the abstract’s title.',
  'abstract.title.font-size': 'Text size of the abstract’s title.',
  'abstract.title.font-style': 'Text style of the abstract’s title.',
  'abstract.title.text-align': 'Horizontal alignment of the abstract’s title.',
  'abstract.text-align': 'Horizontal alignment of the abstract’s text.',

  // --- Admonitions ---
  'admonition.column-rule-color': 'Colour of the vertical rule separating an admonition’s icon from its text.',
  'admonition.column-rule-style': 'Line style of that separating rule: `solid`, `dashed`, `dotted` or `double`.',
  'admonition.column-rule-width': 'Thickness of that separating rule; 0 removes it.',
  'admonition.image-width': 'Width of a custom admonition icon image.',
  'admonition.label.font-style': 'Text style of the admonition label (NOTE, TIP, …) when icons are off.',
  'admonition.label.min-width': 'Narrowest the label column may be; the label wraps rather than narrowing further.',
  'admonition.label.padding': 'Space between the admonition label and the rule beside it.',
  'admonition.label.text-align': 'Horizontal alignment of the label within its column.',
  'admonition.label.text-transform': 'Casing applied to the admonition label.',
  'admonition.label.vertical-align': 'Where the label sits against the admonition’s text: top, middle or bottom.',
  'admonition.padding': 'Space between an admonition’s text and its edges.',

  // --- Base (inherited by everything that does not override it) ---
  'base.border-color': 'Default border colour, inherited by blocks that set no colour of their own.',
  'base.border-radius': 'Default corner rounding for bordered blocks.',
  'base.border-width': 'Default border thickness for bordered blocks.',
  'base.font-color': 'Default text colour for the whole document.',
  'base.font-family': 'Default font family; must name an entry in the font catalogue.',
  'base.font-size': 'Base text size. Sizes written in `em` are relative to this.',
  'base.font-size-large': 'The size `$base-font-size-large` resolves to, for emphasised text.',
  'base.font-size-min': 'Smallest size auto-fitting content may shrink text to.',
  'base.font-size-small': 'The size `$base-font-size-small` resolves to, for de-emphasised text.',
  'base.font-style': 'Default text style for the whole document.',
  'base.line-height': 'Default line spacing, as a multiple of the font size.',
  'base.line-height-length': 'The vertical spacing unit other settings derive their rhythm from.',
  'base.text-align': 'Default paragraph alignment for the whole document.',
  'base.text-decoration-width': 'Thickness of underline and strike-through rules.',

  // --- Blocks and prose ---
  'block.anchor-top':
    'How far above a block a link to it lands, so the target is not flush with the top of the window.',
  'block.margin-bottom': 'Space below every block that sets no margin of its own.',
  'prose.margin-bottom': 'Space below each paragraph.',
  'prose.margin-inner': 'Space below a paragraph that is followed by another paragraph, in place of margin-bottom.',
  'prose.text-indent-inner': 'First-line indent of a paragraph that follows another paragraph.',
  'horizontal-rhythm': 'The horizontal spacing unit blocks derive their indentation from.',
  'vertical-rhythm': 'The vertical spacing unit blocks derive their separation from.',

  // --- UI macros ---
  'button.background-color': 'Fill colour behind btn: macro text.',
  'button.border-color': 'Border colour of btn: macro text.',
  'button.border-offset': 'How far a button’s border and fill extend beyond its text.',
  'button.border-radius': 'Corner rounding of btn: macro text.',
  'button.border-width': 'Border thickness of btn: macro text.',
  'button.content': 'Template wrapping btn: macro text; `%s` is the label.',
  'button.font-color': 'Text colour of btn: macro text.',
  'button.font-family': 'Font family for btn: macro text.',
  'button.font-size': 'Text size of btn: macro text.',
  'button.font-style': 'Text style for btn: macro text.',
  'kbd.background-color': 'Fill colour behind kbd: macro keys.',
  'kbd.border-color': 'Border colour of kbd: macro keys.',
  'kbd.border-offset': 'How far a kbd: key’s border sits from its text.',
  'kbd.border-radius': 'Corner rounding of kbd: macro keys.',
  'kbd.border-width': 'Border thickness of kbd: macro keys.',
  'kbd.font-color': 'Text colour of kbd: macro keys.',
  'kbd.font-family': 'Font family for kbd: macro text.',
  'kbd.font-size': 'Text size of kbd: macro keys.',
  'kbd.font-style': 'Text style for kbd: macro text.',
  'kbd.separator': 'Character shown between keys in a kbd: chord.',
  'menu.caret-content': 'Separator drawn between levels of a menu: path.',
  'menu.font-color': 'Text colour of menu: macro text.',
  'menu.font-family': 'Font family for menu: macro text.',
  'menu.font-size': 'Text size of menu: macro text.',
  'menu.font-style': 'Text style for menu: macro text.',
  'mark.background-color': 'Highlight colour behind marked (`#text#`) text.',
  extends:
    'The theme this one inherits from — `default` for the renderer\'s own theme (fonts included), ' +
    '`base` for a minimal one, or a path to another theme file. A theme that extends nothing ' +
    'inherits no font catalogue, so its callout numbers fall back to `¬`.',
  'mark.border-offset': 'How far the highlight extends past the marked text.',
  'mark.font-color': 'Text colour of marked (`#text#`) text.',
  'mark.font-style': 'Text style of marked (`#text#`) text.',

  // --- Captions ---
  'caption.align': 'Legacy alias for caption alignment; prefer text-align on the owning block.',
  'caption.background-color': 'Fill colour behind block captions and titles.',
  'caption.font-size': 'Text size of block captions and titles.',
  'caption.font-style': 'Text style of block captions and titles.',
  'caption.margin-inside': 'Space between a caption and the block it labels.',
  'caption.margin-outside': 'Space between a caption and the content beyond its block.',
  'caption.text-align': 'Horizontal alignment of block captions and titles.',

  // --- Source and inline code ---
  'code.background-color': 'Fill colour behind source and literal blocks.',
  'code.border-color': 'Border colour of source and literal blocks.',
  'code.caption-end': 'Which side of a code block its caption sits on: `top` or `bottom`.',
  'code.border-radius': 'Corner rounding of source and literal blocks.',
  'code.border-width': 'Border thickness of source and literal blocks.',
  'code.font-color': 'Text colour inside source and literal blocks.',
  'code.font-family': 'Monospaced font family for source and literal blocks.',
  'code.font-size': 'Text size inside source and literal blocks.',
  'code.highlight-background-color': 'Fill colour behind lines the syntax highlighter marks as highlighted.',
  'code.line-gap': 'Extra space between lines of code, on top of the line height.',
  'code.line-height': 'Line spacing inside source and literal blocks.',
  'code.linenum-font-color': 'Colour of the line numbers beside a code block.',
  'code.padding': 'Space between code text and its block’s edges.',
  'codespan.border-color': 'Border colour around inline monospaced text.',
  'codespan.border-offset': 'How far the background and border extend beyond inline monospaced text.',
  'codespan.border-radius': 'Corner rounding of the border around inline monospaced text.',
  'codespan.border-width': 'Border thickness around inline monospaced text.',
  'codespan.font-color': 'Text colour of inline monospaced (`` `code` ``) text.',
  'codespan.font-family': 'Font family of inline monospaced text.',
  'codespan.font-size': 'Text size of inline monospaced text.',
  'codespan.font-style': 'Text style of inline monospaced text.',

  // --- Callouts ---
  'conum.font-color': 'Colour of callout number bubbles.',
  'conum.font-family': 'Font family of callout number bubbles; must contain circled digits.',
  'conum.font-size': 'Size of callout number bubbles.',
  'conum.glyphs': 'Which characters are used for callout numbers.',
  'conum.line-height': 'Line spacing of callout number bubbles.',
  'callout-list.item-spacing': 'Space between consecutive callout-list items.',
  'callout-list.margin-top-after-code': 'Space between a code block and the callout list explaining it.',
  'callout-list.marker-font-color': 'Colour of the callout number beside each callout-list item.',

  // --- Lists ---
  'description-list.description-indent': 'How far a description-list definition is indented from its term.',
  'description-list.term-font-style': 'Text style of description-list terms.',
  'description-list.term-spacing': 'Space between a description-list term and its definition.',
  'list.indent': 'How far list items are indented from the surrounding text.',
  'list.item-spacing': 'Space between consecutive list items.',
  'list.marker-font-color': 'Colour of list bullets and item numbers.',
  'list.text-align': 'Horizontal alignment of list item text.',

  // --- Example and sidebar blocks ---
  'example.background-color': 'Fill colour of example blocks.',
  'example.border-color': 'Border colour of example blocks.',
  'example.caption-end': 'Which side of an example block its caption sits on: `top` or `bottom`.',
  'example.border-radius': 'Corner rounding of example blocks.',
  'example.border-width': 'Border thickness of example blocks.',
  'example.padding': 'Space between an example block’s content and its edges.',
  'sidebar.background-color': 'Fill colour of sidebar blocks.',
  'sidebar.border-color': 'Border colour of sidebar blocks.',
  'sidebar.border-radius': 'Corner rounding of sidebar blocks.',
  'sidebar.border-width': 'Border thickness of sidebar blocks.',
  'sidebar.padding': 'Space between a sidebar’s content and its edges.',
  'sidebar.title.align': 'Legacy alias for sidebar title alignment; prefer text-align.',
  'sidebar.title.font-color': 'Text colour of a sidebar’s title.',
  'sidebar.title.font-size': 'Text size of a sidebar’s title.',
  'sidebar.title.font-style': 'Text style of a sidebar’s title.',
  'sidebar.title.text-align': 'Horizontal alignment of a sidebar’s title.',

  // --- Fonts ---
  'font.catalog': 'Maps font family names to their font files. A family must be listed here to be usable.',
  'font.fallbacks': 'Font families searched, in order, for a glyph the chosen font does not carry.',

  // --- Page furniture ---
  'footer.border-color': 'Colour of the rule above the page footer.',
  'footer.border-width': 'Thickness of the rule above the page footer; 0 removes it.',
  'footer.font-size': 'Text size of the page footer.',
  'footer.height': 'Height reserved for the page footer; unset removes the footer entirely.',
  'footer.line-height': 'Line spacing within the page footer.',
  'footer.padding': 'Space between the footer’s text and its edges.',
  'footer.recto.right.content': 'Footer text on right-hand pages; supports attribute references.',
  'footer.verso.left.content': 'Footer text on left-hand pages; supports attribute references.',
  'footer.vertical-align': 'Where footer text sits within the reserved footer height.',
  'header.font-size': 'Text size of the page header.',
  'header.height': 'Height reserved for the page header; unset or 0 removes the header entirely.',
  'header.line-height': 'Line spacing within the page header.',
  'header.vertical-align': 'Where header text sits within the reserved header height.',

  // --- Footnotes and index ---
  'footnotes.font-size': 'Text size of the footnote list.',
  'footnotes.item-spacing': 'Space between consecutive footnotes.',
  'footnotes.margin-top':
    'Space above the footnote list, or `auto` to hold the list at the foot of the page.',
  'index.column-gap': 'Space between the columns of the index.',
  'index.columns': 'Number of columns the index is laid out in.',

  // --- Headings ---
  'heading.font-color': 'Text colour of all headings that set no colour of their own.',
  'heading.font-style': 'Text style of all headings.',
  'heading.h1-font-size': 'Size of level-1 headings (the document or part title).',
  'heading.h1-text-align': 'Horizontal alignment of level-1 headings.',
  'heading.h2-font-size': 'Size of level-2 headings.',
  'heading.h2-text-align': 'Horizontal alignment of level-2 headings.',
  'heading.h3-font-size': 'Size of level-3 headings.',
  'heading.h4-font-size': 'Size of level-4 headings.',
  'heading.h5-font-size': 'Size of level-5 headings.',
  'heading.h6-font-size': 'Size of level-6 headings.',
  'heading.line-height': 'Line spacing within a heading that wraps to more than one line.',
  'heading.margin-bottom': 'Space between a heading and the content below it.',
  'heading.margin-page-top': 'Extra space above a heading that falls at the top of a page.',
  'heading.margin-top': 'Space between a heading and the content above it.',
  'heading.min-height-after': 'Content that must fit below a heading, or the heading moves to the next page.',
  'heading.text-align': 'Horizontal alignment of headings.',

  // --- Images and links ---
  'image.align': 'Default horizontal alignment of block images.',
  'image.border-color': 'Border colour of block images.',
  'image.border-fit':
    'Whether the border hugs the image (`content`) or spans the full width of the text (`auto`).',
  'image.border-width': 'Border thickness of block images.',
  'image.caption-end': 'Which side of a block image its caption sits on: `top` or `bottom`.',
  'image.caption-max-width': 'Widest a figure caption may run: a length, or `fit-content` to match the image.',
  'image.float-gap': 'Space between a floated image and the text flowing around it.',
  'link.background-color': 'Fill colour behind link text.',
  'link.border-offset': 'How far a link’s background and border extend beyond its text.',
  'link.font-color': 'Text colour of links and cross-references.',
  'link.font-family': 'Font family of link text.',
  'link.font-size': 'Text size of link text.',
  'link.font-style': 'Text style of link text.',
  'link.text-decoration': 'Decoration applied to links: `none`, `underline` or `line-through`.',
  'link.text-decoration-color': 'Colour of a link’s underline, when it differs from the text colour.',
  'link.text-decoration-width': 'Thickness of a link’s underline.',

  // --- Page setup ---
  'page.background-color': 'Fill colour of every page.',
  'page.initial-zoom': 'How the reader first fits the page in the window.',
  'page.layout': 'Page orientation.',
  'page.margin': 'Page margins, as one value or `[top, right, bottom, left]`.',
  'page.margin-inner': 'Margin on the binding side, used when media is prepress.',
  'page.margin-outer': 'Margin on the outer edge, used when media is prepress.',
  'page.margin-rotated': 'Margins used on rotated (landscape) pages, when they differ from the rest.',
  'page.size': 'Named page size (A4, LETTER, …) or explicit `[width, height]`.',

  // --- Quotes and verse ---
  'quote.border-color': 'Colour of the rule beside a quote block.',
  'quote.border-left-width': 'Thickness of the rule to the left of a quote block.',
  'quote.border-width': 'Border thickness of a quote block on all sides.',
  'quote.cite.font-color': 'Text colour of a quote’s attribution line.',
  'quote.cite.font-size': 'Text size of a quote’s attribution line.',
  'quote.font-size': 'Text size inside a quote block.',
  'quote.padding': 'Space between a quote’s text and its edges.',
  'verse.border-color': 'Colour of the rule beside a verse block.',
  'verse.border-left-width': 'Thickness of the rule to the left of a verse block.',
  'verse.border-width': 'Border thickness of a verse block on all sides.',
  'verse.cite.font-color': 'Text colour of a verse’s attribution line.',
  'verse.cite.font-size': 'Text size of a verse’s attribution line.',
  'verse.font-size': 'Text size inside a verse block.',
  'verse.padding': 'Space between a verse’s text and its edges.',

  // --- Roles ---
  'role.big.font-size': 'Size of text carrying the `big` role.',
  'role.lead.font-size': 'Size of text carrying the `lead` role.',
  'role.line-through.text-decoration': 'Decoration applied to text carrying the `line-through` role.',
  'role.small.font-size': 'Size of text carrying the `small` role.',
  'role.subtitle.font-color': 'Text colour of a document or section subtitle.',
  'role.subtitle.font-size': 'Text size of a document or section subtitle.',
  'role.subtitle.font-style': 'Text style of a document or section subtitle.',
  'role.underline.text-decoration': 'Decoration applied to text carrying the `underline` role.',
  'role.unresolved-font-color':
    'Colour of the placeholder drawn in place of a cross-reference that could not be resolved.',

  // --- Tables ---
  'table.align': 'Default horizontal placement of the table on the page.',
  'table.asciidoc-cell-style':
    'How an AsciiDoc cell is styled: `initial` drops the table’s font, size and colour so the cell reads as body text.',
  'table.background-color': 'Fill colour of the table body.',
  'table.body.stripe-background-color': 'Fill colour of striped rows when row striping is on.',
  'table.border-color': 'Colour of table borders and grid lines.',
  'table.border-style': 'Line style of table borders and grid lines.',
  'table.border-width': 'Thickness of the table’s outer border.',
  'table.caption-max-width': 'Widest a table caption may run: a length, or `fit-content` to match the table.',
  'table.cell-line-height': 'Line spacing inside table cells.',
  'table.cell-padding': 'Space between a cell’s content and its edges.',
  'table.grid-width': 'Thickness of the grid lines between cells.',
  'table.foot.background-color': 'Fill colour of the table footer row.',
  'table.foot.font-color': 'Text colour of footer-row cells.',
  'table.foot.font-family': 'Font family of footer-row cells.',
  'table.foot.font-size': 'Text size of footer-row cells.',
  'table.foot.font-style': 'Text style of footer-row cells.',
  'table.head.border-bottom-color': 'Colour of the rule below the header row.',
  'table.head.border-bottom-style': 'Line style of the rule below the header row.',
  'table.head.border-bottom-width': 'Thickness of the rule below the header row.',
  'table.head.cell-padding': 'Space between a header cell’s content and its edges.',
  'table.head.font-style': 'Text style of header-row cells.',
  'table.head.line-height': 'Line spacing inside header-row cells.',

  // --- Thematic break ---
  'thematic-break.border-color': 'Colour of the horizontal rule a thematic break draws.',
  'thematic-break.border-style': 'Line style of the thematic break rule.',
  'thematic-break.border-width': 'Thickness of the thematic break rule.',
  'thematic-break.margin-top': 'Space above the thematic break rule, used when no padding is set.',
  'thematic-break.padding': 'Space above and below the thematic break rule.',

  // --- Title page ---
  //
  // Each element takes `display: none` to leave it off the page entirely, and its own margins —
  // which is how a title page is rearranged without touching the document.
  'title-page.authors.content':
    'Template for one author, used when no variant below matches. `{author}`, `{email}` and `{url}` are substituted.',
  'title-page.authors.content-name-only': 'Author template used when the author has neither an email nor a URL.',
  'title-page.authors.content-with-email': 'Author template used when the author has an email address.',
  'title-page.authors.content-with-url': 'Author template used when the author has a URL.',
  'title-page.authors.delimiter': 'Text placed between authors when the document names more than one.',
  'title-page.authors.display': 'Set to `none` to leave the author line off the title page.',
  'title-page.authors.font-color': 'Text colour of the author line on the title page.',
  'title-page.authors.font-size': 'Text size of the author line on the title page.',
  'title-page.authors.margin-bottom': 'Space below the author line on the title page.',
  'title-page.authors.margin-left': 'Space to the left of the author line on the title page.',
  'title-page.authors.margin-right': 'Space to the right of the author line on the title page.',
  'title-page.authors.margin-top': 'Space above the author line on the title page.',
  'title-page.logo.align': 'Horizontal alignment of the title-page logo.',
  'title-page.logo.display': 'Set to `none` to leave the logo off the title page.',
  'title-page.logo.image': 'The logo image, as an `image:` macro. Overridden by the `title-logo-image` attribute.',
  'title-page.logo.margin-left': 'Space to the left of the title-page logo.',
  'title-page.logo.margin-right': 'Space to the right of the title-page logo.',
  'title-page.logo.top': 'Vertical position of the title-page logo, as a percentage of page height.',
  'title-page.revision.delimiter': 'Text placed between the revision number and the revision date.',
  'title-page.revision.display': 'Set to `none` to leave the revision line off the title page.',
  'title-page.revision.margin-bottom': 'Space below the revision line on the title page.',
  'title-page.revision.margin-left': 'Space to the left of the revision line on the title page.',
  'title-page.revision.margin-right': 'Space to the right of the revision line on the title page.',
  'title-page.revision.margin-top': 'Space above the revision line on the title page.',
  'title-page.subtitle.display': 'Set to `none` to leave the subtitle off the title page.',
  'title-page.subtitle.font-size': 'Text size of the title-page subtitle.',
  'title-page.subtitle.font-style': 'Text style of the title-page subtitle.',
  'title-page.subtitle.line-height': 'Line spacing of the title-page subtitle.',
  'title-page.subtitle.margin-bottom': 'Space below the title-page subtitle.',
  'title-page.subtitle.margin-left': 'Space to the left of the title-page subtitle.',
  'title-page.subtitle.margin-right': 'Space to the right of the title-page subtitle.',
  'title-page.subtitle.margin-top': 'Space above the title-page subtitle.',
  'title-page.text-align': 'Horizontal alignment of every element on the title page.',
  'title-page.title.display': 'Set to `none` to leave the document title off the title page.',
  'title-page.title.font-color': 'Text colour of the document title on the title page.',
  'title-page.title.font-size': 'Text size of the document title on the title page.',
  'title-page.title.line-height': 'Line spacing of the document title on the title page.',
  'title-page.title.margin-bottom': 'Space below the document title on the title page.',
  'title-page.title.margin-left': 'Space to the left of the document title on the title page.',
  'title-page.title.margin-right': 'Space to the right of the document title on the title page.',
  'title-page.title.margin-top': 'Space above the document title on the title page.',
  'title-page.title.top': 'Vertical position of the title, as a percentage of page height.',

  // --- Table of contents ---
  'toc.dot-leader.font-color': 'Colour of the dotted leader between a contents entry and its page number.',
  'toc.indent': 'How far each contents level is indented from the one above it.',
  'toc.line-height': 'Line spacing within the table of contents.',
  'toc.title-text-align': 'Horizontal alignment of the contents list’s own title.',

  // --- Settings the converter reads but no shipped theme sets ---
  //
  // These reached the catalogue only once the generator started consulting the converter's own
  // source (see generate-theme-descriptors.mjs). Described from what the code does with each value,
  // not from the key's name — several read very differently from how they look.
  'running-content.start-at':
    'First page to carry the header and footer: `title`, `toc`, `after-toc`, `body`, or a page number.',
  'page.numbering.start-at':
    'First page counted as page 1: `cover`, `title`, `toc`, `after-toc`, `body`, or a page number. Earlier pages take lowercase Roman numerals.',
  'page.columns': 'Number of columns the whole document is laid out in.',
  'page.column-gap': 'Space between columns when the document is laid out in more than one.',
  'page.mode': 'How a reader opens the document: `outline`, `none`, or `fullscreen`.',
  'section.indent': 'How far a section\u2019s body is indented from the page margin.',
  'prose.text-indent': 'First-line indent of a paragraph.',
  'base.hyphens': 'Whether words may be hyphenated at a line break, and by which dictionary.',
  'base.font-kerning': 'Whether kerning pairs are applied: `normal` or `none`.',
  'heading.chapter-break-before': 'Where a chapter starts: `always` a new page, `auto`, or a recto/verso side.',
  'heading.part-break-before': 'Where a part title starts, on the same terms as a chapter.',
  'heading.part-break-after': 'Whether the page after a part title is forced to a particular side.',
  'image.width': 'Default width of a block image that does not state one.',
  'image.alt-content':
    'What is drawn in place of an image that cannot be embedded \u2014 the alt text, the target, or both.',
  'svg.font-family': 'Font used for text inside an embedded SVG.',
  'svg.fallback-font-family': 'Font used for SVG text whose own font is unavailable.',
  'table.grid-style': 'Line style of the table grid: `solid`, `dashed`, `dotted` or `double`.',
  'table.grid-color': 'Colour of the lines between table cells.',
  'codespan.background-color': 'Background colour behind inline monospaced text.',
  'toc.break-after': 'Whether the page after the contents list is forced to a particular side.',
  'toc.hanging-indent': 'How far a contents entry\u2019s wrapped lines are indented under its first line.',
  'toc.dot-leader.content': 'The text repeated to form the leader \u2014 set to an empty string to remove it.',
  'toc.dot-leader.font-size': 'Text size of the dotted leader.',
  'toc.dot-leader.font-style': 'Text style of the dotted leader.',
  'toc.dot-leader.levels': 'Which contents levels get a dot leader.',
});
