/**
 * @file The engine-neutral appearance a theme resolves to.
 *
 * Plain data, in one unit. Every length is in PDF points and every colour is six upper-case
 * hexadecimal digits (or the `transparent` keyword) — no CSS appears anywhere in this file, because
 * the projection onto CSS custom properties belongs to the delivery layer and keeping it there is
 * what leaves exactly one place where untrusted theme content could reach a stylesheet.
 *
 * The tree's shape is load-bearing beyond documentation: each CSS custom property's name is derived
 * mechanically from the path of the field it carries, so adding a field determines its property name
 * without anybody deciding one. `page.marginPt.top` is `--print-page-margin-top`, and
 * `headings[2].fontColor` is `--print-heading-2-font-color`.
 *
 * The set of constructs here is closed, and matches the specification's own closed enumeration. A
 * theme key with no field here is neither applied nor reported: it is simply not part of what this
 * preview claims to reproduce.
 *
 * ## Two constructs deliberately left out, and why
 *
 * Both are real: the renderer themes them, and a reader of the gem will find them.
 *
 * `abstract.*` — `convert_abstract` sets an `[abstract]` block in its own type at its own leading,
 * with a first line the theme may style separately and a title of its own (`abstract_font_size`,
 * `abstract_line_height`, `abstract_padding`, `abstract_first_line_font_style`, `abstract_title_*`).
 * Asciidoctor's HTML gives it the QUOTATION's markup — `<div class="quoteblock abstract">` — so the
 * preview currently dresses one as a quotation, left rule and all, which is not what the export
 * draws. It is a closed key set and it could be modelled the way every construct here is.
 *
 * `role.lead` — `theme_font_cascade` applies `role_<name>_font_*` for EVERY role an author writes,
 * and `convert_preamble` writes one itself: it sets `role: lead` on a preamble's first block when
 * that block is a paragraph and the document has sections, which the gem's own base theme then sets
 * a quarter larger (`role_lead_font_size`).
 *
 * What keeps both out for now is not their size but their evidence. Every value in this model is
 * held to a reference PDF by the Print fidelity suite, and no anchor fixture contains an abstract or
 * a lead paragraph — so modelling them would add a whole vocabulary that nothing measures, which is
 * the shape of defect this preview has already shipped once. Adding them means adding the fixture
 * first. Note also that the bundled demo's preamble is NOT lead-inflated in either renderer: its
 * first child is a page break rather than a paragraph, so `convert_preamble` leaves it alone.
 */

import type { Colour, MeasurementBox } from './units';

/** How a construct's text is set: family, size, weight/slant, colour, line height, alignment. */
export interface Typography {
  /** Catalogue family name, as the theme's font catalogue spells it. */
  readonly fontFamily?: string;
  /** Font size in points. */
  readonly fontSizePt?: number;
  /** Text colour. */
  readonly fontColor?: Colour;
  /** One of the renderer's font-style keywords: `normal`, `bold`, `italic`, `bold_italic`, `normal_italic`. */
  readonly fontStyle?: string;
  /** Line height as a multiplier of the font size. */
  readonly lineHeight?: number;
  /** One of `left`, `center`, `right`, `justify`. */
  readonly textAlign?: string;
}

/** How a block is framed: its fill, its rule, and the space between rule and content. */
export interface BlockFrame {
  /** Fill behind the block. */
  readonly backgroundColor?: Colour;
  /** Rule colour. */
  readonly borderColor?: Colour;
  /** Rule width in points. */
  readonly borderWidthPt?: number;
  /** Corner radius in points. */
  readonly borderRadiusPt?: number;
  /** Inset between rule and content, in points. */
  readonly paddingPt?: MeasurementBox;
}

/** The page itself: how large it is, how much of it is margin, and what colour the paper is. */
export interface PageAppearance {
  /** Page width in points, after the theme's orientation has been applied. */
  readonly widthPt: number;
  /** Page height in points, after the theme's orientation has been applied. */
  readonly heightPt: number;
  /** Margins in points. */
  readonly marginPt: MeasurementBox;
  /** Paper colour. */
  readonly backgroundColor: Colour;
}

/** Body text, and the border colour every construct inherits from it. */
export interface BaseAppearance extends Typography {
  /** Body family — always present, because the renderer always resolves one. */
  readonly fontFamily: string;
  /** Body size in points — always present. */
  readonly fontSizePt: number;
  /** Body colour — always present. */
  readonly fontColor: Colour;
  /** Body line height as a multiplier — always present. */
  readonly lineHeight: number;
  /** The colour constructs inherit for their rules. */
  readonly borderColor?: Colour;
  /** The rule width constructs inherit, in points. */
  readonly borderWidthPt?: number;
  /** The corner radius constructs inherit, in points. */
  readonly borderRadiusPt?: number;
}

/** A section heading at one level. */
export type HeadingAppearance = Typography & {
  /** Space above the heading, in points. */
  readonly marginTopPt?: number;
  /** Space below the heading, in points. */
  readonly marginBottomPt?: number;
};

/**
 * The vertical rhythm the renderer spaces blocks with.
 *
 * Two values rather than one, because the renderer keeps two: a paragraph — and the constructs it
 * spaces like one, such as a list or a description list — is followed by `prose.margin-bottom`, while
 * every other block is followed by `block.margin-bottom`. A theme that changes only one of them
 * changes only one of the two rhythms, so collapsing them here would silently apply the wrong number
 * to half the document.
 */
export interface SpacingAppearance {
  /** Space beneath a paragraph, in points. */
  readonly proseMarginBottomPt?: number;
  /** Space beneath any other block, in points. */
  readonly blockMarginBottomPt?: number;
}

/** A cross-reference or external link. Only its colour is in scope. */
export interface LinkAppearance {
  /** Link colour. */
  readonly fontColor?: Colour;
}

/**
 * The box the renderer paints behind and around an inline span.
 *
 * Inline code, a key cap and a button are all the same construction in the renderer: a fill, an
 * optional rule, and an offset that grows the box past the glyphs it encloses. The offset matters
 * more than it looks — it is the only thing that decides whether the box takes horizontal room in the
 * line, and inventing one where the theme has none moves every character after it.
 */
export interface InlineBox {
  /** Fill behind the span. */
  readonly backgroundColor?: Colour;
  /** Rule around the span. */
  readonly borderColor?: Colour;
  /** That rule's width in points. */
  readonly borderWidthPt?: number;
  /** Corner radius in points. */
  readonly borderRadiusPt?: number;
  /** How far the box is grown past the glyphs, in points. */
  readonly borderOffsetPt?: number;
}

/**
 * How a construct is set where the renderer reads no alignment for it.
 *
 * `text_align` is not a key every category has. The converter reads one for exactly ten categories —
 * `heading[_hN]`, `base`, `abstract[_title]`, `admonition_label`, `sidebar_title`, `toc_title`,
 * `list`, `caption`, `title_page` and `role_<n>` — plus the `<category>_caption_text_align` a block
 * caption may carry (`converter.rb:653, 700, 1379, 3166, 3950, 4459` and `@theme.list_text_align`,
 * `@theme.title_page_text_align`, `@theme.abstract_text_align`, `@theme.admonition_label_text_align`).
 * Everywhere else the text is inked at whatever alignment is already in force, or at one the call
 * site passes outright.
 *
 * So a codespan, a key cap, a button, a code block, a callout number, a footnote entry and a
 * quotation carry no alignment here. Claiming one would be a promise this preview cannot keep: the
 * key reaches no reader in the gem, and a stylesheet reading it would move every line break inside
 * the construct on the strength of a value the export ignores. See {@link UNREAD_TEXT_ALIGN_KEYS} in
 * `resolve-appearance.ts`, which is that list written down.
 */
export type UnalignedTypography = Omit<Typography, 'textAlign'>;

/** Inline monospaced text. */
export type CodespanAppearance = UnalignedTypography & InlineBox;

/** A key cap, as the keyboard macro produces. */
export type KbdAppearance = UnalignedTypography &
  InlineBox & {
    /**
     * What the renderer puts between the caps of a chord.
     *
     * A theme value like any other, and text for the same reason a button's brackets are: the
     * renderer joins the caps with this exact string — its own default is a plus sign with a narrow
     * no-break space either side — and the air around the sign is most of what a reader sees of it.
     */
    readonly separator?: string;
  };

/** A button, as the button macro produces. */
export type ButtonAppearance = UnalignedTypography &
  InlineBox & {
    /**
     * What the renderer wraps a button's label in, split around the label's own place in the theme's
     * template. Carried as text because it *is* text: the renderer's default is a bracket and a thin
     * space either side, and a theme may say something else entirely.
     */
    readonly content?: {
      /** What precedes the label. */
      readonly before: string;
      /** What follows it. */
      readonly after: string;
    };
  };

/** A menu path, and the caret drawn between its parts. */
export interface MenuAppearance {
  /** Font style keyword for the menu's own words. */
  readonly fontStyle?: string;
  /** The caret's colour, which the renderer carries inside the caret's markup rather than as a key. */
  readonly caretFontColor?: Colour;
  /** The caret itself, with the markup the renderer's template wraps it in removed. */
  readonly caretContent?: string;
}

/** Highlighted text. */
export interface MarkAppearance {
  /** Fill behind the highlighted run. */
  readonly backgroundColor?: Colour;
  /** How far that fill is grown past the glyphs, in points. */
  readonly borderOffsetPt?: number;
}

/** A literal, listing or source block. */
export type CodeAppearance = UnalignedTypography & BlockFrame;

/** A list: its marker, how far its items are indented, and the space between them. */
export interface ListAppearance {
  /** Marker colour. */
  readonly markerFontColor?: Colour;
  /** How far an item's text is indented from the list's own left edge, in points. */
  readonly indentPt?: number;
  /** Space between one item and the next, in points. */
  readonly itemSpacingPt?: number;
}

/**
 * The list of explanations beneath a code block's callout numbers.
 *
 * One value, and a negative one: the renderer pulls the list back up under the block it explains, so
 * a callout list sits closer to its code than any other block would. Without it the explanations
 * float away from the lines they annotate.
 */
export interface CalloutListAppearance {
  /** Space above the list when it follows a code block, in points — normally negative. */
  readonly marginTopAfterCodePt?: number;
}

/**
 * A quote block, whose left rule the renderer sets separately from its other edges.
 *
 * No alignment. `theme_font :quote` reads no `text_align` — the category is not among the ten the
 * converter reads one for — and the paragraphs inside a quotation go through `convert_paragraph`,
 * which inks them at `@base_text_align`. See {@link UnalignedTypography}.
 */
export type QuoteAppearance = UnalignedTypography &
  BlockFrame & {
    /** Left rule width in points, which the renderer themes separately. */
    readonly borderLeftWidthPt?: number;
    /**
     * The attribution line beneath the quotation.
     *
     * No alignment: the renderer inks the attribution left-aligned outright, so a `quote.cite`
     * alignment would be a key it never reads.
     */
    readonly cite?: Typography;
  };

/**
 * A verse block, which is NOT a quotation set differently.
 *
 * `convert_quote_or_verse` picks its category from the node — `node.context == :quote ? :quote :
 * :verse` (`converter.rb:1310`) — and reads `verse.*` for every value it then draws with. The gem's
 * own default theme gives that category defaults spelled `$quote_font_size`, `$quote_border_color`
 * and so on (`data/themes/default-theme.yml:153-161`), and a `$reference` in a theme document is
 * expanded WHEN THE ENTRY IS READ: they resolve against the default theme's own quote as that file
 * loads, and are literals by the time a project theme is layered over it. So a project that restyles
 * `quote` restyles quotations and nothing else, and a verse keeps the renderer's own values unless
 * the project names `verse` itself. Reading a verse out of the quote group — which is what this
 * preview did — showed the project's rule colour, padding and size on a block the export draws in
 * none of them.
 *
 * The same shape as a quotation's, because the renderer reads the same key list under the other
 * prefix. Neither group carries an alignment, and for two DIFFERENT reasons: a quotation's
 * paragraphs are inked at `@base_text_align` because no `quote.text-align` exists to read, while a
 * verse is inked at an alignment the call site passes outright — `ink_prose … align:
 * (resolve_text_align_from_role node.roles) || :left` (`converter.rb:1350`), and an explicit
 * argument is what `ink_prose` uses. So a verse is flush left however the page is set, which is the
 * stylesheet's business rather than this model's.
 */
export type VerseAppearance = QuoteAppearance;

/** A sidebar, and the title it may carry. */
export type SidebarAppearance = BlockFrame & {
  /**
   * The sidebar title's own typography, and the space it leaves under itself.
   *
   * Two of these values are not the sidebar's at all. `convert_sidebar` inks the title with
   * `line_height: heading.line-height || base.line-height` and `margin_bottom: heading.margin-bottom`
   * — the HEADING category's, with no sidebar key of its own to override either — so a resolver that
   * left them to the sidebar's own group would set the title at body leading and give it whatever
   * space a stylesheet invented. They are resolved into this group because this is the construct they
   * describe; where a value comes FROM is the resolver's business, and what a construct is set in is
   * the model's.
   */
  readonly title?: Typography & {
    /** Space under the title, in points. */
    readonly marginBottomPt?: number;
  };
};

/** An example block. */
export type ExampleAppearance = BlockFrame;

/** The admonition kinds the renderer draws an icon for. */
export const ADMONITION_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;

/** One admonition kind. */
export type AdmonitionType = (typeof ADMONITION_TYPES)[number];

/** One admonition kind's icon. */
export interface AdmonitionIconAppearance {
  /** The colour the glyph is drawn in. */
  readonly fontColor?: Colour;
  /** The glyph's size in points, which also sets the label column's width. */
  readonly sizePt?: number;
}

/** An admonition, whose rule is a column rule rather than a border, plus its label. */
export interface AdmonitionAppearance {
  /** Fill behind the admonition. */
  readonly backgroundColor?: Colour;
  /** The rule separating the label column from the content. */
  readonly columnRuleColor?: Colour;
  /** That rule's width in points. */
  readonly columnRuleWidthPt?: number;
  /** Inset between rule and content, in points. */
  readonly paddingPt?: MeasurementBox;
  /** The label column's own treatment. */
  readonly label?: {
    /** Label font style keyword. */
    readonly fontStyle?: string;
    /** One of `none`, `uppercase`, `lowercase`, `capitalize`. */
    readonly textTransform?: string;
    /** A floor on the label column's width, in points, when the theme sets one. */
    readonly minWidthPt?: number;
  };
  /** Each kind's icon, keyed by kind. */
  readonly icons: Readonly<Record<AdmonitionType, AdmonitionIconAppearance>>;
}

/** A table: its outer border, its interior grid, its header row, its footer row, and its striping. */
export interface TableAppearance {
  /** Where a table narrower than the text column sits: one of `left`, `center`, `right`. */
  readonly align?: string;
  /** Fill behind the table. */
  readonly backgroundColor?: Colour;
  /** Outer border colour. */
  readonly borderColor?: Colour;
  /** Outer border width in points. */
  readonly borderWidthPt?: number;
  /** Interior grid colour, which the renderer themes separately from the outer border. */
  readonly gridColor?: Colour;
  /** Interior grid width in points. */
  readonly gridWidthPt?: number;
  /** Inset inside each cell, in points. */
  readonly cellPaddingPt?: MeasurementBox;
  /** The header row. */
  readonly head?: {
    /** Header fill. */
    readonly backgroundColor?: Colour;
    /** Header font style keyword. */
    readonly fontStyle?: string;
    /** Rule beneath the header, in points. */
    readonly borderBottomWidthPt?: number;
  };
  /**
   * The footer row.
   *
   * The renderer restyles it after the cells are built rather than while they are built
   * (`convert_table`, converter.rb:2382-2389): the row's fill, colour, family, size and style are
   * each assigned to the last row once it exists. That is why the five settings sit together here —
   * they are one statement about one row, not five independent keys — and why a foot cell's LINE BOX
   * is not simply this group's own: the leading was fixed from the body's metrics before the size
   * and the family were changed.
   */
  readonly foot?: {
    /** Footer fill; the table's own background when the theme sets none. */
    readonly backgroundColor?: Colour;
    /** Footer text colour, or undefined to keep the body's. */
    readonly fontColor?: Colour;
    /** Footer catalogue family, or undefined to keep the body's. */
    readonly fontFamily?: string;
    /** Footer font size in points, or undefined to keep the body's. */
    readonly fontSizePt?: number;
    /** Footer font style keyword, or undefined to keep the body's. */
    readonly fontStyle?: string;
  };
  /** The body's alternating stripe. */
  readonly body?: {
    /** Fill of every other body row. */
    readonly stripeBackgroundColor?: Colour;
  };
}

/** A callout number, in a code block and beside its explanation. */
export type ConumAppearance = UnalignedTypography;

/** The footnote list at the end of the document. */
export type FootnotesAppearance = UnalignedTypography & {
  /** Space between one footnote and the next, in points. */
  readonly itemSpacingPt?: number;
};

/** A description list, whose term the renderer styles separately from its description. */
export interface DescriptionListAppearance {
  /** The term's font style keyword. */
  readonly termFontStyle?: string;
  /** Space above each term, in points. */
  readonly termSpacingPt?: number;
  /** How far a description is indented from its term, in points. */
  readonly descriptionIndentPt?: number;
}

/** A block image. */
export interface ImageAppearance {
  /** Where the image sits in the text column: one of `left`, `center`, `right`. */
  readonly align?: string;
}

/** A block title or figure caption. */
export type CaptionAppearance = Typography & {
  /** Space between the caption and the block it belongs to, in points. */
  readonly marginInsidePt?: number;
  /** Space on the caption's other side, in points. */
  readonly marginOutsidePt?: number;
};

/**
 * The generated table of contents.
 *
 * Only what a single unpaginated column can show. The renderer's dot leaders and page numbers are
 * left out on purpose: a leader exists to carry the eye to a page number, and this preview has no
 * pages to number.
 */
export interface TocAppearance {
  /** Entry family. */
  readonly fontFamily?: string;
  /** Entry size in points. */
  readonly fontSizePt?: number;
  /** Entry colour — the renderer inks an entry in this rather than in the link colour. */
  readonly fontColor?: Colour;
  /** Entry font style keyword. */
  readonly fontStyle?: string;
  /** Entry line height as a multiplier of the entry size. */
  readonly lineHeight?: number;
  /** How far one level is indented past the level above it, in points. */
  readonly indentPt?: number;
  /**
   * The contents title's own typography, layered over the level-2 heading it is inked as.
   *
   * No line height: the renderer inks the title through its heading path, which takes the heading's
   * line height and never the title's own.
   */
  readonly title?: Omit<Typography, 'lineHeight'>;
}

/** A thematic break. */
export interface ThematicBreakAppearance {
  /** Rule colour. */
  readonly borderColor?: Colour;
  /** One of `solid`, `dashed`, `dotted`, `double`. */
  readonly borderStyle?: string;
  /** Rule width in points. */
  readonly borderWidthPt?: number;
  /** Space above and below the rule, in points. */
  readonly paddingPt?: MeasurementBox;
}

/**
 * Where a font face may come from, in the priority order the preview resolves them.
 *
 * `substitute` is kept apart from `catalogue` because the two make different claims. A catalogue face
 * is the renderer's OWN file, repackaged — same outlines, same metrics, same everything. A substitute
 * stands in for one of the PDF base-14 core fonts, which have no file anywhere: prawn ships their
 * metrics and embeds no font program, because a viewer supplies those fourteen itself. So a
 * substitute carries the export's advance widths and the export's line box, and draws them in
 * somebody else's outlines. Anything that resolves a face to a file has to know which of the two it
 * is holding, and a single kind covering both is how it would stop knowing.
 */
export type FontSourceKind = 'project' | 'catalogue' | 'substitute' | 'fallback';

/** The file a theme's catalogue names for each style of one family. */
export interface FontFacePaths {
  /** Upright regular face. */
  readonly normal?: string;
  /** Bold face. */
  readonly bold?: string;
  /** Italic face. */
  readonly italic?: string;
  /** Bold italic face. */
  readonly boldItalic?: string;
}

/**
 * One font family the appearance references, with whatever the theme's own catalogue declared for
 * it. Turning these into loadable faces is the delivery layer's job — only it knows the project's
 * storage origin — so no URL and no source decision appears here.
 */
export interface FontRequirement {
  /** The family name the appearance's `fontFamily` fields use. */
  readonly family: string;
  /** Paths the theme's font catalogue declared, exactly as written. */
  readonly declaredFaces: FontFacePaths;
  /** True when the theme's own catalogue declares this family rather than only referencing it. */
  readonly declaredByTheme: boolean;
}

/** Everything the Print preview presents, resolved from a theme document. */
export interface AppearanceModel {
  /** The page and its geometry. */
  readonly page: PageAppearance;
  /** Body text. */
  readonly base: BaseAppearance;
  /** How far one block is spaced from the next. */
  readonly spacing: SpacingAppearance;
  /** Section headings, indexed 1 through 6. */
  readonly headings: Readonly<Record<1 | 2 | 3 | 4 | 5 | 6, HeadingAppearance>>;
  /**
   * The shared `heading.text-align`, carried apart from the six levels because level 1 has TWO
   * readers that disagree about it.
   *
   * `ink_general_heading doc, doc.doctitle, align: (@theme.heading_h1_text_align&.to_sym || :center)`
   * (`converter.rb:194`) positions the DOCUMENT TITLE from `heading.h1.text-align` alone, centring
   * it when that key is unset and never consulting the shared one — which is why
   * `headings[1].textAlign` is the h1 key on its own (`readHeading`). But `convert_section` inks a
   * section at `hlevel = sect.level.next`, so a level-0 section — a PART, in book doctype — is a
   * level-1 heading too, and it takes the ordinary chain:
   * `@theme[%(heading_h1_text_align)] || @theme.heading_text_align || @base_text_align`
   * (`converter.rb:653`). The two cannot be one field, and the middle step of that chain is the only
   * part of it the six levels do not already carry.
   *
   * Undefined when the theme sets no shared alignment; the renderer then falls the chain through to
   * `base.text-align`.
   */
  readonly headingTextAlign?: string;
  /** Links. */
  readonly link: LinkAppearance;
  /** Inline monospaced text. */
  readonly codespan: CodespanAppearance;
  /** Key caps. */
  readonly kbd: KbdAppearance;
  /** Buttons. */
  readonly button: ButtonAppearance;
  /** Menu paths. */
  readonly menu: MenuAppearance;
  /** Highlighted text. */
  readonly mark: MarkAppearance;
  /** Literal, listing and source blocks. */
  readonly code: CodeAppearance;
  /** Callout numbers. */
  readonly conum: ConumAppearance;
  /** The footnote list. */
  readonly footnotes: FootnotesAppearance;
  /** Ordered and unordered lists. */
  readonly list: ListAppearance;
  /** Description lists. */
  readonly descriptionList: DescriptionListAppearance;
  /** Callout-explanation lists. */
  readonly calloutList: CalloutListAppearance;
  /** Quote blocks. */
  readonly quote: QuoteAppearance;
  /** Verse blocks, whose own category the renderer keeps apart from the quotation's. */
  readonly verse: VerseAppearance;
  /** Sidebars. */
  readonly sidebar: SidebarAppearance;
  /** Example blocks. */
  readonly example: ExampleAppearance;
  /** Admonitions. */
  readonly admonition: AdmonitionAppearance;
  /** Block images. */
  readonly image: ImageAppearance;
  /** Tables. */
  readonly table: TableAppearance;
  /** The generated table of contents. */
  readonly toc: TocAppearance;
  /** Block titles and figure captions. */
  readonly caption: CaptionAppearance;
  /** Thematic breaks. */
  readonly thematicBreak: ThematicBreakAppearance;
  /** Every font family the appearance references. */
  readonly fonts: readonly FontRequirement[];
}

/** The heading levels the model carries, for callers that need to iterate them. */
export const HEADING_LEVELS: readonly (1 | 2 | 3 | 4 | 5 | 6)[] = [1, 2, 3, 4, 5, 6];
