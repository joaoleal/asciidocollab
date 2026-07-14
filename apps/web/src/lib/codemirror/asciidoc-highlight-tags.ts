import { styleTags, tags as t, Tag } from '@lezer/highlight';

/** Custom AsciiDoc-specific highlight tags (named `ad.*` to avoid collisions). */
export const ad = {
  markup:        Tag.define(),
  descTerm:      Tag.define(),
  blockTitle:    Tag.define(),
  checkDone:     Tag.define(),
  checkTodo:     Tag.define(),
  attrRef:       Tag.define(),
  callout:       Tag.define(),
  stem:          Tag.define(),
  inlineStem:    Tag.define(),
  xrefLabel:     Tag.define(),
  admonNote:     Tag.define(),
  admonTip:      Tag.define(),
  admonWarning:  Tag.define(),
  admonImportant:Tag.define(),
  admonCaution:  Tag.define(),
  docInfo:       Tag.define(),
  diagramDecl:   Tag.define(),
} as const;

/**
 * Maps AsciiDoc Lezer node types to highlight tags.
 *
 * Only PascalCase grammar rules create named nodes in the parse tree;
 * lowercase external tokens are anonymous leaves that styleTags cannot target
 * individually.  The grammar wraps every token that needs independent styling
 * in a thin PascalCase rule (ExampleFence, AdmonNotePfx, CheckDoneMark, …)
 * so the highlight system has a handle on each range.
 *
 * Kept in its own module — free of any generated-parser import — so it is a
 * single source of truth shared by the configured language (`asciidoc-language.ts`)
 * and the highlight-consistency tests.
 */
export const asciidocHighlightTags = styleTags({
  // ── Headings ────────────────────────────────────────────────────────────────
  DocumentTitle:      t.heading1,
  Heading1:           t.heading2,
  Heading2:           t.heading3,
  Heading3:           t.heading4,
  Heading4:           t.heading5,
  Heading5:           t.heading6,

  // ── Inline emphasis ──────────────────────────────────────────────────────
  Bold:               t.strong,
  Italic:             t.emphasis,
  Monospace:          t.monospace,

  // ── Block wrappers — body is foreground; fences and annotations recede ────
  // Named `XxxFence` wrapper rules allow fence tokens to carry ad.markup
  // independently of the parent block's t.content.
  ExampleBlock:       t.content,
  SidebarBlock:       t.content,
  QuoteBlock:         t.content,
  OpenBlock:          t.content,
  TableBlock:         t.content,
  CsvTableBlock:      t.content,
  DsvTableBlock:      t.content,
  ListingBlock:       t.content,
  LiteralBlock:       t.content,
  PassthroughBlock:   t.content,
  // Stem: body colored with stem tag; the `[stem]` annotation reads as a block-attribute line
  // (amber, like `[source,ruby]`) rather than receding to grey; the `++++` fence still recedes.
  StemBlock:          ad.stem,
  StemAnnotation:     t.meta,

  // Block fence delimiters (named wrappers from grammar)
  ExampleFence:       ad.markup,
  SidebarFence:       ad.markup,
  QuoteFence:         ad.markup,
  OpenFence:          ad.markup,
  ListingFence:       ad.markup,
  LiteralFence:       ad.markup,
  PassthroughFence:   ad.markup,
  CsvTableFence:      ad.markup,
  DsvTableFence:      ad.markup,
  TableFence:         ad.markup,

  // ── Table internals ──────────────────────────────────────────────────────
  // `[cols="…"]` reads as a block-attribute line (amber), consistent with `[stem]`/`[source]`.
  TableCols:          t.meta,
  // `|` cell separators recede to muted markup so the cell content leads.
  TableCellMark:      ad.markup,

  // ── Admonitions — label-only chip; body is foreground ────────────────────
  // Generic fallback (whole paragraph/block → foreground)
  AdmonitionParagraph:    t.content,
  AdmonitionContinuation: t.content,
  AdmonitionBlock:        t.content,
  AdmonAnnotation:        ad.markup,

  // Inline-form label prefix wrappers (NOTE: , TIP: , etc.)
  AdmonNotePfx:        ad.admonNote,
  AdmonTipPfx:         ad.admonTip,
  AdmonWarningPfx:     ad.admonWarning,
  AdmonImportantPfx:   ad.admonImportant,
  AdmonCautionPfx:     ad.admonCaution,

  // Block-attribute annotation wrappers ([NOTE], [TIP], etc.)
  AdmonNoteAnnotation:      ad.admonNote,
  AdmonTipAnnotation:       ad.admonTip,
  AdmonWarningAnnotation:   ad.admonWarning,
  AdmonImportantAnnotation: ad.admonImportant,
  AdmonCautionAnnotation:   ad.admonCaution,

  // Per-severity paragraph nodes — body inherits foreground (overridden at prefix level)
  AdmonitionNoteParagraph:      t.content,
  AdmonitionTipParagraph:       t.content,
  AdmonitionWarningParagraph:   t.content,
  AdmonitionImportantParagraph: t.content,
  AdmonitionCautionParagraph:   t.content,

  // Per-severity block nodes — body inherits foreground (overridden at annotation level)
  AdmonitionNoteBlock:      t.content,
  AdmonitionTipBlock:       t.content,
  AdmonitionWarningBlock:   t.content,
  AdmonitionImportantBlock: t.content,
  AdmonitionCautionBlock:   t.content,

  // ── Lists — marker wrappers recede; body is foreground ───────────────────
  // Named marker wrappers carry the chip/muted color independently.
  UnorderedMark:      ad.markup,
  OrderedMark:        ad.markup,
  CheckDoneMark:      ad.checkDone,
  CheckTodoMark:      ad.checkTodo,
  // Parent list-item nodes → body inherits foreground
  OrderedListItem:    t.content,
  UnorderedListItem:  t.content,
  CheckDoneItem:      t.content,
  CheckTodoItem:      t.content,
  Continuation:       t.content,
  // The DescriptionList wrapper is body text; only its DescTerm child (term + `::` separator)
  // carries the term colour, so the DEFINITION text and any wrapped continuation line read as
  // ordinary foreground body — the same colour, first line and continuation alike.
  DescriptionList:    t.content,
  DescTerm:           ad.descTerm,
  DescriptionContinuation: t.content,

  // ── Inline references & special constructs ────────────────────────────────
  Link:               t.link,
  InlineMacro:        t.link,
  CrossReference:     t.link,
  XrefTarget:         t.link,
  XrefLabel:          ad.xrefLabel,
  AttributeReference: ad.attrRef,
  AttributeEntry:     t.meta,
  InlineSet:          t.meta,
  Callout:            ad.callout,
  // Inline `stem:[…]` carries its own tag so it can show a math chip (block stem body uses ad.stem).
  InlineStem:         ad.inlineStem,
  SmartQuote:         t.quote,
  HardBreak:          t.escape,

  // ── Document structure ────────────────────────────────────────────────────
  Highlight:          t.special(t.string),
  Subscript:          t.number,
  Superscript:        t.special(t.number),
  RoleSpan:           t.special(t.string),
  CommentLine:        t.lineComment,
  CommentBlock:       t.blockComment,
  BlockMacro:         t.macroName,
  BlockTitle:         ad.blockTitle,
  BlockAttributeLine: t.meta,
  // A diagram block declaration line (`[mermaid]` etc.) — its own tag so it reads distinctly from a
  // generic `[source,ruby]` block-attribute line (which stays `t.meta`).
  DiagramBlockDeclaration: ad.diagramDecl,
  Conditional:        t.keyword,
  ThematicBreak:      t.contentSeparator,
  PageBreak:          t.special(t.contentSeparator),
  Passthrough:        t.special(t.string),
  InlineAnchor:       t.labelName,
  BiblioAnchor:       t.special(t.labelName),
  Replacement:        t.character,
  Entity:             t.special(t.character),
  UiMacro:            t.macroName,
  Footnote:           t.string,

  // ── Document header metadata ──────────────────────────────────────────────
  AuthorLine:         ad.docInfo,
  RevisionLine:       ad.docInfo,
});
