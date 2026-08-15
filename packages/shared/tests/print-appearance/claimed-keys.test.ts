import { stringify } from 'yaml';
import {
  CLAIMED_THEME_KEYS,
  RENDERER_TEXT_ALIGN_KEYS,
  resolveAppearance,
  UNREAD_TEXT_ALIGN_KEYS,
} from '../../src/print-appearance';

/**
 * One theme key, the value a probe theme writes for it, and where that value must arrive in the
 * appearance model.
 *
 * This table IS the breadth oracle. Every key the resolver claims to support has a row here, a test
 * asserts the table and the claimed set are the same set, and each row asserts the value reached the
 * model — so a key can neither be claimed without an assertion nor asserted without being claimed.
 */
interface Probe {
  /** The flat key, as the resolver names it. */
  readonly key: string;
  /** The dotted path a theme author writes. */
  readonly wrote: string;
  /** The value the probe theme writes. */
  readonly value: unknown;
  /** Dotted path into the appearance model. */
  readonly at: string;
  /** What the model must carry once resolved. */
  readonly expected: unknown;
}

/** How one construct is seeded. `align` is present only where the renderer reads one. */
interface TypographySeed {
  readonly family: string;
  readonly size: number;
  readonly colour: string;
  readonly style: string;
  readonly lineHeight: number;
}

/**
 * Typography probes for one construct: the five keys EVERY category has.
 *
 * Alignment is not one of them. The converter reads a `text_align` for ten categories and no others
 * — `RENDERER_TEXT_ALIGN_KEYS` is that list, taken off the gem — so the six keys these probes used to
 * carry claimed one for seven categories the renderer never asks. Those seven are asserted absent by
 * their own test below rather than probed here.
 */
function typographyProbes(
  wrotePrefix: string,
  keyPrefix: string,
  modelPath: string,
  seed: TypographySeed,
): Probe[] {
  return [
    { key: `${keyPrefix}_font_family`, wrote: `${wrotePrefix}.font-family`, value: seed.family, at: `${modelPath}.fontFamily`, expected: seed.family },
    { key: `${keyPrefix}_font_size`, wrote: `${wrotePrefix}.font-size`, value: seed.size, at: `${modelPath}.fontSizePt`, expected: seed.size },
    { key: `${keyPrefix}_font_color`, wrote: `${wrotePrefix}.font-color`, value: seed.colour, at: `${modelPath}.fontColor`, expected: seed.colour },
    { key: `${keyPrefix}_font_style`, wrote: `${wrotePrefix}.font-style`, value: seed.style, at: `${modelPath}.fontStyle`, expected: seed.style },
    { key: `${keyPrefix}_line_height`, wrote: `${wrotePrefix}.line-height`, value: seed.lineHeight, at: `${modelPath}.lineHeight`, expected: seed.lineHeight },
  ];
}

/** The same five, plus the alignment, for a construct the converter reads one for. */
function alignedTypographyProbes(
  wrotePrefix: string,
  keyPrefix: string,
  modelPath: string,
  seed: TypographySeed & { align: string },
): Probe[] {
  return [
    ...typographyProbes(wrotePrefix, keyPrefix, modelPath, seed),
    { key: `${keyPrefix}_text_align`, wrote: `${wrotePrefix}.text-align`, value: seed.align, at: `${modelPath}.textAlign`, expected: seed.align },
  ];
}

const PROBES: readonly Probe[] = [
  // Page. A5 in landscape must arrive with its dimensions swapped, which is the one place two keys
  // decide one pair of numbers.
  { key: 'page_size', wrote: 'page.size', value: 'A5', at: 'page.heightPt', expected: 419.53 },
  { key: 'page_layout', wrote: 'page.layout', value: 'landscape', at: 'page.widthPt', expected: 595.28 },
  { key: 'page_margin', wrote: 'page.margin', value: [10, 20, 30, 40], at: 'page.marginPt', expected: { top: 10, right: 20, bottom: 30, left: 40 } },
  { key: 'page_background_color', wrote: 'page.background-color', value: 'FAFAFA', at: 'page.backgroundColor', expected: 'FAFAFA' },

  ...alignedTypographyProbes('base', 'base', 'base', {
    family: 'Brand Serif',
    size: 11,
    colour: '111111',
    style: 'italic',
    lineHeight: 1.5,
    align: 'center',
  }),
  { key: 'base_border_color', wrote: 'base.border-color', value: '222222', at: 'base.borderColor', expected: '222222' },
  { key: 'base_border_width', wrote: 'base.border-width', value: 1.5, at: 'base.borderWidthPt', expected: 1.5 },
  { key: 'base_border_radius', wrote: 'base.border-radius', value: 6, at: 'base.borderRadiusPt', expected: 6 },

  // Two rhythms, not one: a paragraph is followed by the first, every other block by the second.
  { key: 'prose_margin_bottom', wrote: 'prose.margin-bottom', value: 9, at: 'spacing.proseMarginBottomPt', expected: 9 },
  { key: 'block_margin_bottom', wrote: 'block.margin-bottom', value: 13, at: 'spacing.blockMarginBottomPt', expected: 13 },

  // Shared heading keys reach every level that does not override them; level 6 is left un-overridden
  // below precisely so these can be asserted through it.
  ...alignedTypographyProbes('heading', 'heading', 'headings.6', {
    family: 'Brand Sans',
    size: 20,
    colour: '330033',
    style: 'bold_italic',
    lineHeight: 1.1,
    align: 'right',
  }),
  // The same key again, at the second place it has to arrive. A level-1 SECTION heading — a part, in
  // book doctype — takes `heading.h1.text-align || heading.text-align || base.text-align`
  // (`converter.rb:653`), while the DOCUMENT TITLE takes the h1 key alone and centres without it
  // (`converter.rb:194`). `headings[1].textAlign` is the second of those, so the middle step of the
  // first has nowhere else to live.
  { key: 'heading_text_align', wrote: 'heading.text-align', value: 'right', at: 'headingTextAlign', expected: 'right' },
  { key: 'heading_margin_top', wrote: 'heading.margin-top', value: 5, at: 'headings.6.marginTopPt', expected: 5 },
  { key: 'heading_margin_bottom', wrote: 'heading.margin-bottom', value: 7, at: 'headings.6.marginBottomPt', expected: 7 },

  ...[1, 2, 3, 4, 5].flatMap((level) => [
    ...alignedTypographyProbes(`heading.h${level}`, `heading_h${level}`, `headings.${level}`, {
      family: `Level ${level} Face`,
      size: 30 + level,
      colour: `${level}${level}00${level}${level}`,
      style: 'normal',
      lineHeight: 1 + level / 10,
      align: 'justify',
    }),
    { key: `heading_h${level}_margin_top`, wrote: `heading.h${level}.margin-top`, value: 40 + level, at: `headings.${level}.marginTopPt`, expected: 40 + level },
    { key: `heading_h${level}_margin_bottom`, wrote: `heading.h${level}.margin-bottom`, value: 50 + level, at: `headings.${level}.marginBottomPt`, expected: 50 + level },
  ]),
  ...alignedTypographyProbes('heading.h6', 'heading_h6', 'headings.6', {
    family: 'Brand Sans',
    size: 20,
    colour: '330033',
    style: 'bold_italic',
    lineHeight: 1.1,
    align: 'right',
  })
    .filter((probe) => probe.key !== 'heading_h6_font_size')
    .map((probe) => ({ ...probe, value: undefined })),
  // The renderer's default theme sets a font size for all six levels, so the shared `heading.font-size`
  // is shadowed everywhere until a level clears its own. Writing null is how a theme does that, and
  // it is the only arrangement in which the shared key's effect is observable at all.
  { key: 'heading_h6_font_size', wrote: 'heading.h6.font-size', value: null, at: 'headings.6.fontSizePt', expected: 20 },
  { key: 'heading_h6_margin_top', wrote: 'heading.h6.margin-top', value: undefined, at: 'headings.6.marginTopPt', expected: 5 },
  { key: 'heading_h6_margin_bottom', wrote: 'heading.h6.margin-bottom', value: undefined, at: 'headings.6.marginBottomPt', expected: 7 },

  { key: 'link_font_color', wrote: 'link.font-color', value: '0000AA', at: 'link.fontColor', expected: '0000AA' },

  ...typographyProbes('codespan', 'codespan', 'codespan', {
    family: 'Mono One',
    size: 9,
    colour: 'AA0000',
    style: 'bold',
    lineHeight: 1.05,
  }),
  { key: 'codespan_background_color', wrote: 'codespan.background-color', value: 'EFEFEF', at: 'codespan.backgroundColor', expected: 'EFEFEF' },
  { key: 'codespan_border_color', wrote: 'codespan.border-color', value: 'D0D0D0', at: 'codespan.borderColor', expected: 'D0D0D0' },
  { key: 'codespan_border_width', wrote: 'codespan.border-width', value: 0.45, at: 'codespan.borderWidthPt', expected: 0.45 },
  { key: 'codespan_border_radius', wrote: 'codespan.border-radius', value: 1.5, at: 'codespan.borderRadiusPt', expected: 1.5 },
  { key: 'codespan_border_offset', wrote: 'codespan.border-offset', value: 1.25, at: 'codespan.borderOffsetPt', expected: 1.25 },

  ...typographyProbes('kbd', 'kbd', 'kbd', {
    family: 'Key Face',
    size: 8.25,
    colour: '121212',
    style: 'normal',
    lineHeight: 1.1,
  }),
  { key: 'kbd_background_color', wrote: 'kbd.background-color', value: 'F4F4F4', at: 'kbd.backgroundColor', expected: 'F4F4F4' },
  { key: 'kbd_border_color', wrote: 'kbd.border-color', value: 'C4C4C4', at: 'kbd.borderColor', expected: 'C4C4C4' },
  { key: 'kbd_border_width', wrote: 'kbd.border-width', value: 0.55, at: 'kbd.borderWidthPt', expected: 0.55 },
  { key: 'kbd_border_radius', wrote: 'kbd.border-radius', value: 2.5, at: 'kbd.borderRadiusPt', expected: 2.5 },
  { key: 'kbd_border_offset', wrote: 'kbd.border-offset', value: 2.25, at: 'kbd.borderOffsetPt', expected: 2.25 },
  { key: 'kbd_separator', wrote: 'kbd.separator', value: ' / ', at: 'kbd.separator', expected: ' / ' },

  ...typographyProbes('button', 'button', 'button', {
    family: 'Button Face',
    size: 10.25,
    colour: '131313',
    style: 'bold',
    lineHeight: 1.15,
  }),
  { key: 'button_background_color', wrote: 'button.background-color', value: '1A4E8A', at: 'button.backgroundColor', expected: '1A4E8A' },
  { key: 'button_border_color', wrote: 'button.border-color', value: 'B4B4B4', at: 'button.borderColor', expected: 'B4B4B4' },
  { key: 'button_border_width', wrote: 'button.border-width', value: 0.65, at: 'button.borderWidthPt', expected: 0.65 },
  { key: 'button_border_radius', wrote: 'button.border-radius', value: 3.5, at: 'button.borderRadiusPt', expected: 3.5 },
  { key: 'button_border_offset', wrote: 'button.border-offset', value: 1.75, at: 'button.borderOffsetPt', expected: 1.75 },
  // A template is split around where the label goes, which is what the two halves are for.
  { key: 'button_content', wrote: 'button.content', value: '(%s)', at: 'button.content', expected: { before: '(', after: ')' } },

  { key: 'menu_font_style', wrote: 'menu.font-style', value: 'italic', at: 'menu.fontStyle', expected: 'italic' },
  // The caret's colour has no key of its own: the renderer carries it inside the caret's own markup,
  // and the markup is stripped from what the preview draws.
  { key: 'menu_caret_content', wrote: 'menu.caret-content', value: ' <font color="#B12146">›</font> ', at: 'menu.caretFontColor', expected: 'B12146' },

  { key: 'mark_background_color', wrote: 'mark.background-color', value: 'FFEE00', at: 'mark.backgroundColor', expected: 'FFEE00' },
  { key: 'mark_border_offset', wrote: 'mark.border-offset', value: 1.5, at: 'mark.borderOffsetPt', expected: 1.5 },

  ...typographyProbes('code', 'code', 'code', {
    family: 'Mono Two',
    size: 8.5,
    colour: 'BB0000',
    style: 'normal',
    lineHeight: 1.3,
  }),
  { key: 'code_background_color', wrote: 'code.background-color', value: 'F0F0F0', at: 'code.backgroundColor', expected: 'F0F0F0' },
  { key: 'code_border_color', wrote: 'code.border-color', value: 'C0C0C0', at: 'code.borderColor', expected: 'C0C0C0' },
  { key: 'code_border_width', wrote: 'code.border-width', value: 0.9, at: 'code.borderWidthPt', expected: 0.9 },
  { key: 'code_border_radius', wrote: 'code.border-radius', value: 5, at: 'code.borderRadiusPt', expected: 5 },
  { key: 'code_padding', wrote: 'code.padding', value: [1, 2, 3, 4], at: 'code.paddingPt', expected: { top: 1, right: 2, bottom: 3, left: 4 } },

  ...typographyProbes('conum', 'conum', 'conum', {
    family: 'Conum Face',
    size: 10.75,
    colour: '141414',
    style: 'bold',
    lineHeight: 1.33,
  }),

  ...typographyProbes('footnotes', 'footnotes', 'footnotes', {
    family: 'Footnote Face',
    size: 8.75,
    colour: '151515',
    style: 'normal',
    lineHeight: 1.25,
  }),
  { key: 'footnotes_item_spacing', wrote: 'footnotes.item-spacing', value: 4.5, at: 'footnotes.itemSpacingPt', expected: 4.5 },

  { key: 'list_marker_font_color', wrote: 'list.marker-font-color', value: '404040', at: 'list.markerFontColor', expected: '404040' },
  { key: 'list_indent', wrote: 'list.indent', value: 27, at: 'list.indentPt', expected: 27 },
  { key: 'list_item_spacing', wrote: 'list.item-spacing', value: 6.5, at: 'list.itemSpacingPt', expected: 6.5 },

  // Negative on purpose: a callout list is pulled up under the code block it explains.
  { key: 'callout_list_margin_top_after_code', wrote: 'callout-list.margin-top-after-code', value: -7, at: 'calloutList.marginTopAfterCodePt', expected: -7 },

  { key: 'description_list_term_font_style', wrote: 'description-list.term-font-style', value: 'bold', at: 'descriptionList.termFontStyle', expected: 'bold' },
  { key: 'description_list_term_spacing', wrote: 'description-list.term-spacing', value: 3.25, at: 'descriptionList.termSpacingPt', expected: 3.25 },
  { key: 'description_list_description_indent', wrote: 'description-list.description-indent', value: 15.5, at: 'descriptionList.descriptionIndentPt', expected: 15.5 },

  ...typographyProbes('quote', 'quote', 'quote', {
    family: 'Quote Face',
    size: 12.5,
    colour: 'CC0000',
    style: 'italic',
    lineHeight: 1.35,
  }),
  { key: 'quote_background_color', wrote: 'quote.background-color', value: 'FFFEEE', at: 'quote.backgroundColor', expected: 'FFFEEE' },
  { key: 'quote_border_color', wrote: 'quote.border-color', value: 'BBBBBB', at: 'quote.borderColor', expected: 'BBBBBB' },
  { key: 'quote_border_width', wrote: 'quote.border-width', value: 0.25, at: 'quote.borderWidthPt', expected: 0.25 },
  { key: 'quote_border_radius', wrote: 'quote.border-radius', value: 3, at: 'quote.borderRadiusPt', expected: 3 },
  { key: 'quote_border_left_width', wrote: 'quote.border-left-width', value: 5, at: 'quote.borderLeftWidthPt', expected: 5 },
  { key: 'quote_padding', wrote: 'quote.padding', value: [5, 6, 7, 8], at: 'quote.paddingPt', expected: { top: 5, right: 6, bottom: 7, left: 8 } },
  // The attribution beneath a quotation. No alignment: the renderer inks it left-aligned outright.
  { key: 'quote_cite_font_family', wrote: 'quote.cite.font-family', value: 'Cite Face', at: 'quote.cite.fontFamily', expected: 'Cite Face' },
  { key: 'quote_cite_font_size', wrote: 'quote.cite.font-size', value: 8.25, at: 'quote.cite.fontSizePt', expected: 8.25 },
  { key: 'quote_cite_font_color', wrote: 'quote.cite.font-color', value: '5C6672', at: 'quote.cite.fontColor', expected: '5C6672' },
  { key: 'quote_cite_font_style', wrote: 'quote.cite.font-style', value: 'italic', at: 'quote.cite.fontStyle', expected: 'italic' },
  { key: 'quote_cite_line_height', wrote: 'quote.cite.line-height', value: 1.05, at: 'quote.cite.lineHeight', expected: 1.05 },

  // A verse is its own category and reads the same key list under the other prefix. Every value here
  // differs from the quotation's above, which is the only way this table can tell the two apart: the
  // gem's default theme spells the `verse` defaults `$quote_*`, and those resolve against the DEFAULT
  // theme's quote as that file loads — so a resolver that read a verse out of the project's quote
  // group would agree with the renderer on nothing a project ever sets.
  //
  // No `verse.text-align`: `convert_quote_or_verse` hands `ink_prose` the alignment outright
  // (`converter.rb:1350`), so the key cannot reach the page and is not claimed.
  { key: 'verse_font_family', wrote: 'verse.font-family', value: 'Verse Face', at: 'verse.fontFamily', expected: 'Verse Face' },
  { key: 'verse_font_size', wrote: 'verse.font-size', value: 14.5, at: 'verse.fontSizePt', expected: 14.5 },
  { key: 'verse_font_color', wrote: 'verse.font-color', value: '00AA55', at: 'verse.fontColor', expected: '00AA55' },
  { key: 'verse_font_style', wrote: 'verse.font-style', value: 'bold', at: 'verse.fontStyle', expected: 'bold' },
  { key: 'verse_line_height', wrote: 'verse.line-height', value: 1.65, at: 'verse.lineHeight', expected: 1.65 },
  { key: 'verse_background_color', wrote: 'verse.background-color', value: 'F0FFF0', at: 'verse.backgroundColor', expected: 'F0FFF0' },
  { key: 'verse_border_color', wrote: 'verse.border-color', value: 'A0A0A0', at: 'verse.borderColor', expected: 'A0A0A0' },
  { key: 'verse_border_width', wrote: 'verse.border-width', value: 0.75, at: 'verse.borderWidthPt', expected: 0.75 },
  { key: 'verse_border_radius', wrote: 'verse.border-radius', value: 2, at: 'verse.borderRadiusPt', expected: 2 },
  { key: 'verse_border_left_width', wrote: 'verse.border-left-width', value: 6, at: 'verse.borderLeftWidthPt', expected: 6 },
  { key: 'verse_padding', wrote: 'verse.padding', value: [1, 2, 3, 4], at: 'verse.paddingPt', expected: { top: 1, right: 2, bottom: 3, left: 4 } },
  { key: 'verse_cite_font_family', wrote: 'verse.cite.font-family', value: 'Verse Cite Face', at: 'verse.cite.fontFamily', expected: 'Verse Cite Face' },
  { key: 'verse_cite_font_size', wrote: 'verse.cite.font-size', value: 7.5, at: 'verse.cite.fontSizePt', expected: 7.5 },
  { key: 'verse_cite_font_color', wrote: 'verse.cite.font-color', value: '2E7D32', at: 'verse.cite.fontColor', expected: '2E7D32' },
  { key: 'verse_cite_font_style', wrote: 'verse.cite.font-style', value: 'bold_italic', at: 'verse.cite.fontStyle', expected: 'bold_italic' },
  { key: 'verse_cite_line_height', wrote: 'verse.cite.line-height', value: 1.45, at: 'verse.cite.lineHeight', expected: 1.45 },

  { key: 'sidebar_background_color', wrote: 'sidebar.background-color', value: 'EEEEDD', at: 'sidebar.backgroundColor', expected: 'EEEEDD' },
  { key: 'sidebar_border_color', wrote: 'sidebar.border-color', value: 'E1E1D1', at: 'sidebar.borderColor', expected: 'E1E1D1' },
  { key: 'sidebar_border_width', wrote: 'sidebar.border-width', value: 0.6, at: 'sidebar.borderWidthPt', expected: 0.6 },
  { key: 'sidebar_border_radius', wrote: 'sidebar.border-radius', value: 7, at: 'sidebar.borderRadiusPt', expected: 7 },
  { key: 'sidebar_padding', wrote: 'sidebar.padding', value: [9, 10, 11, 12], at: 'sidebar.paddingPt', expected: { top: 9, right: 10, bottom: 11, left: 12 } },
  // `sidebar.title.line-height` is absent on purpose, and is the one place a construct's group is
  // narrower than the renderer's own key list: `convert_sidebar` hands `ink_prose` the HEADING
  // category's leading explicitly, and that argument always wins, so the sidebar's own key never
  // reaches the page. It is not claimed, and `sidebar.title.line-height` below is what the heading
  // category put there.
  ...alignedTypographyProbes('sidebar.title', 'sidebar_title', 'sidebar.title', {
    family: 'Sidebar Title Face',
    size: 14,
    colour: 'DD0000',
    style: 'bold',
    lineHeight: 1.2,
    align: 'center',
  }).filter((probe) => probe.key !== 'sidebar_title_line_height'),

  { key: 'example_background_color', wrote: 'example.background-color', value: 'FDFDFD', at: 'example.backgroundColor', expected: 'FDFDFD' },
  { key: 'example_border_color', wrote: 'example.border-color', value: 'ABABAB', at: 'example.borderColor', expected: 'ABABAB' },
  { key: 'example_border_width', wrote: 'example.border-width', value: 0.8, at: 'example.borderWidthPt', expected: 0.8 },
  { key: 'example_border_radius', wrote: 'example.border-radius', value: 2, at: 'example.borderRadiusPt', expected: 2 },
  { key: 'example_padding', wrote: 'example.padding', value: [13, 14, 15, 16], at: 'example.paddingPt', expected: { top: 13, right: 14, bottom: 15, left: 16 } },

  { key: 'admonition_background_color', wrote: 'admonition.background-color', value: 'F7F7F7', at: 'admonition.backgroundColor', expected: 'F7F7F7' },
  { key: 'admonition_column_rule_color', wrote: 'admonition.column-rule-color', value: '9A9A9A', at: 'admonition.columnRuleColor', expected: '9A9A9A' },
  { key: 'admonition_column_rule_width', wrote: 'admonition.column-rule-width', value: 1.25, at: 'admonition.columnRuleWidthPt', expected: 1.25 },
  { key: 'admonition_padding', wrote: 'admonition.padding', value: [17, 18, 19, 20], at: 'admonition.paddingPt', expected: { top: 17, right: 18, bottom: 19, left: 20 } },
  { key: 'admonition_label_font_style', wrote: 'admonition.label.font-style', value: 'italic', at: 'admonition.label.fontStyle', expected: 'italic' },
  { key: 'admonition_label_text_transform', wrote: 'admonition.label.text-transform', value: 'capitalize', at: 'admonition.label.textTransform', expected: 'capitalize' },
  { key: 'admonition_label_min_width', wrote: 'admonition.label.min-width', value: 42, at: 'admonition.label.minWidthPt', expected: 42 },
  { key: 'admonition_icon_note_stroke_color', wrote: 'admonition.icon.note.stroke-color', value: '19407C', at: 'admonition.icons.note.fontColor', expected: '19407C' },
  { key: 'admonition_icon_note_size', wrote: 'admonition.icon.note.size', value: 26, at: 'admonition.icons.note.sizePt', expected: 26 },
  { key: 'admonition_icon_tip_stroke_color', wrote: 'admonition.icon.tip.stroke-color', value: '111111', at: 'admonition.icons.tip.fontColor', expected: '111111' },
  { key: 'admonition_icon_tip_size', wrote: 'admonition.icon.tip.size', value: 27, at: 'admonition.icons.tip.sizePt', expected: 27 },
  { key: 'admonition_icon_important_stroke_color', wrote: 'admonition.icon.important.stroke-color', value: 'BF0000', at: 'admonition.icons.important.fontColor', expected: 'BF0000' },
  { key: 'admonition_icon_important_size', wrote: 'admonition.icon.important.size', value: 28, at: 'admonition.icons.important.sizePt', expected: 28 },
  { key: 'admonition_icon_warning_stroke_color', wrote: 'admonition.icon.warning.stroke-color', value: 'BF6900', at: 'admonition.icons.warning.fontColor', expected: 'BF6900' },
  { key: 'admonition_icon_warning_size', wrote: 'admonition.icon.warning.size', value: 29, at: 'admonition.icons.warning.sizePt', expected: 29 },
  { key: 'admonition_icon_caution_stroke_color', wrote: 'admonition.icon.caution.stroke-color', value: 'BF3400', at: 'admonition.icons.caution.fontColor', expected: 'BF3400' },
  { key: 'admonition_icon_caution_size', wrote: 'admonition.icon.caution.size', value: 30, at: 'admonition.icons.caution.sizePt', expected: 30 },

  { key: 'image_align', wrote: 'image.align', value: 'center', at: 'image.align', expected: 'center' },

  { key: 'table_align', wrote: 'table.align', value: 'center', at: 'table.align', expected: 'center' },
  { key: 'table_background_color', wrote: 'table.background-color', value: 'FCFCFC', at: 'table.backgroundColor', expected: 'FCFCFC' },
  { key: 'table_border_color', wrote: 'table.border-color', value: 'D5D5D5', at: 'table.borderColor', expected: 'D5D5D5' },
  { key: 'table_border_width', wrote: 'table.border-width', value: 0.7, at: 'table.borderWidthPt', expected: 0.7 },
  { key: 'table_grid_color', wrote: 'table.grid-color', value: 'C5C5C5', at: 'table.gridColor', expected: 'C5C5C5' },
  { key: 'table_grid_width', wrote: 'table.grid-width', value: 0.4, at: 'table.gridWidthPt', expected: 0.4 },
  { key: 'table_cell_padding', wrote: 'table.cell-padding', value: [2, 4], at: 'table.cellPaddingPt', expected: { top: 2, right: 4, bottom: 2, left: 4 } },
  { key: 'table_head_background_color', wrote: 'table.head.background-color', value: 'E8E8E8', at: 'table.head.backgroundColor', expected: 'E8E8E8' },
  { key: 'table_head_font_style', wrote: 'table.head.font-style', value: 'bold_italic', at: 'table.head.fontStyle', expected: 'bold_italic' },
  { key: 'table_head_border_bottom_width', wrote: 'table.head.border-bottom-width', value: 1.75, at: 'table.head.borderBottomWidthPt', expected: 1.75 },
  { key: 'table_foot_background_color', wrote: 'table.foot.background-color', value: 'EFEFEF', at: 'table.foot.backgroundColor', expected: 'EFEFEF' },
  { key: 'table_foot_font_color', wrote: 'table.foot.font-color', value: '203040', at: 'table.foot.fontColor', expected: '203040' },
  { key: 'table_foot_font_family', wrote: 'table.foot.font-family', value: 'Footer Face', at: 'table.foot.fontFamily', expected: 'Footer Face' },
  { key: 'table_foot_font_size', wrote: 'table.foot.font-size', value: 9.25, at: 'table.foot.fontSizePt', expected: 9.25 },
  { key: 'table_foot_font_style', wrote: 'table.foot.font-style', value: 'italic', at: 'table.foot.fontStyle', expected: 'italic' },
  { key: 'table_body_stripe_background_color', wrote: 'table.body.stripe-background-color', value: 'F9F9F0', at: 'table.body.stripeBackgroundColor', expected: 'F9F9F0' },

  // The contents entries carry no alignment of their own and the contents title no line height —
  // the renderer reads neither — so both groups are narrower than a full typography group.
  { key: 'toc_font_family', wrote: 'toc.font-family', value: 'Contents Face', at: 'toc.fontFamily', expected: 'Contents Face' },
  { key: 'toc_font_size', wrote: 'toc.font-size', value: 10.25, at: 'toc.fontSizePt', expected: 10.25 },
  { key: 'toc_font_color', wrote: 'toc.font-color', value: '223344', at: 'toc.fontColor', expected: '223344' },
  { key: 'toc_font_style', wrote: 'toc.font-style', value: 'normal', at: 'toc.fontStyle', expected: 'normal' },
  { key: 'toc_line_height', wrote: 'toc.line-height', value: 1.55, at: 'toc.lineHeight', expected: 1.55 },
  { key: 'toc_indent', wrote: 'toc.indent', value: 19, at: 'toc.indentPt', expected: 19 },
  { key: 'toc_title_font_family', wrote: 'toc.title.font-family', value: 'Contents Title Face', at: 'toc.title.fontFamily', expected: 'Contents Title Face' },
  { key: 'toc_title_font_size', wrote: 'toc.title.font-size', value: 18.5, at: 'toc.title.fontSizePt', expected: 18.5 },
  { key: 'toc_title_font_color', wrote: 'toc.title.font-color', value: '334455', at: 'toc.title.fontColor', expected: '334455' },
  { key: 'toc_title_font_style', wrote: 'toc.title.font-style', value: 'bold', at: 'toc.title.fontStyle', expected: 'bold' },
  { key: 'toc_title_text_align', wrote: 'toc.title.text-align', value: 'center', at: 'toc.title.textAlign', expected: 'center' },

  ...alignedTypographyProbes('caption', 'caption', 'caption', {
    family: 'Caption Face',
    size: 9.5,
    colour: '556677',
    style: 'italic',
    lineHeight: 1.15,
    align: 'right',
  }),
  { key: 'caption_margin_inside', wrote: 'caption.margin-inside', value: 4.5, at: 'caption.marginInsidePt', expected: 4.5 },
  { key: 'caption_margin_outside', wrote: 'caption.margin-outside', value: 1.5, at: 'caption.marginOutsidePt', expected: 1.5 },

  { key: 'thematic_break_border_color', wrote: 'thematic-break.border-color', value: '778899', at: 'thematicBreak.borderColor', expected: '778899' },
  { key: 'thematic_break_border_style', wrote: 'thematic-break.border-style', value: 'dashed', at: 'thematicBreak.borderStyle', expected: 'dashed' },
  { key: 'thematic_break_border_width', wrote: 'thematic-break.border-width', value: 1.1, at: 'thematicBreak.borderWidthPt', expected: 1.1 },
  { key: 'thematic_break_padding', wrote: 'thematic-break.padding', value: [21, 22], at: 'thematicBreak.paddingPt', expected: { top: 21, right: 22, bottom: 21, left: 22 } },
];

/** Whether a value is a plain object we can descend into while building the probe document. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The child mapping at `segment`, creating it when the path does not exist yet. */
function childOf(node: Record<string, unknown>, segment: string): Record<string, unknown> {
  const existing = node[segment];
  if (isRecord(existing)) return existing;
  const created: Record<string, unknown> = {};
  node[segment] = created;
  return created;
}

/** Build the probe theme document from the table, so the written keys cannot drift from the asserted ones. */
function probeThemeText(): string {
  const document: Record<string, unknown> = { extends: 'default' };
  for (const probe of PROBES) {
    if (probe.value === undefined) continue;
    const segments = probe.wrote.split('.');
    let node = document;
    for (const segment of segments.slice(0, -1)) node = childOf(node, segment);
    node[segments.at(-1) ?? ''] = probe.value;
  }
  return stringify(document);
}

/** Follow a dotted path into the resolved model. */
function at(model: unknown, path: string): unknown {
  let node: unknown = model;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = Reflect.get(node, segment);
  }
  return node;
}

const resolved = resolveAppearance({ themeText: probeThemeText(), themePath: 'theme/probe-theme.yml' });

describe('the closed set of theme keys the Print style applies', () => {
  it('claims exactly the keys this table asserts, so nothing is claimed unasserted', () => {
    const asserted = [...new Set(PROBES.map((probe) => probe.key))].toSorted();
    // `caption.align` is a SEPARATE setting that `caption.text-align` falls back to, not another
    // spelling of it, so the two cannot be probed from one document: writing both would assert only
    // the winner. It is claimed and asserted by its own tests below.
    const claimed = CLAIMED_THEME_KEYS.filter((key) => key !== 'caption_align').toSorted();
    expect(asserted).toEqual(claimed);
  });

  it('applies every claimed key without reporting a single problem', () => {
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.themeApplied).toBe(true);
  });

  it.each(PROBES.map((probe) => [probe.key, probe.at, probe.expected] as const))(
    'carries %s to %s',
    (_key, path, expected) => {
      expect(at(resolved.appearance, path)).toEqual(expected);
    },
  );

  // `ink_caption` (converter.rb:3161-3170) reads TWO settings, not one key under two names:
  //
  //   align      = caption_align      || base_text_align     the caption BLOCK's own position
  //   text_align = caption_text_align || align               the alignment of the text inside it
  //
  // and `caption_align` is absent from `ThemeLoader::DeprecatedKeys` (theme_loader.rb:18), where
  // every genuine `*_align` → `*_text_align` rename is listed. So the fallback below is real, but it
  // is a fallback between two settings rather than a spelling the loader rewrites.
  it('falls the caption’s text alignment back to the caption block’s own alignment', () => {
    const result = resolveAppearance({ themeText: 'extends: default\ncaption:\n  align: center\n' });
    expect(result.appearance.caption.textAlign).toBe('center');
    expect(result.diagnostics).toEqual([]);
  });

  it('prefers the caption’s own text alignment when a theme writes both', () => {
    const result = resolveAppearance({
      themeText: 'extends: default\ncaption:\n  align: center\n  text-align: right\n',
    });
    expect(result.appearance.caption.textAlign).toBe('right');
  });
});

/**
 * Alignment, which is the one typography setting that is NOT a key every category has.
 *
 * Seven of them were claimed anyway — `codespan`, `kbd`, `button`, `code`, `conum`, `footnotes` and
 * `quote` — because each sits beside five keys that ARE read and the group looks incomplete without
 * one. None of the seven appears anywhere in the gem, so a theme setting `quote.text-align: left`
 * re-broke every line of every quotation in the preview against an export that justifies them.
 */
describe('the alignments the renderer actually reads', () => {
  it('claims no text alignment the converter has no reader for', () => {
    const claimedAlignments = CLAIMED_THEME_KEYS.filter((key) => key.endsWith('_text_align'));
    expect(claimedAlignments.filter((key) => !RENDERER_TEXT_ALIGN_KEYS.includes(key))).toEqual([]);
    // Both directions, so the recorded list cannot quietly grow to cover a new claim.
    expect(claimedAlignments.filter((key) => UNREAD_TEXT_ALIGN_KEYS.includes(key))).toEqual([]);
  });

  it('names every construct whose group looks as though it should carry one', () => {
    // The seven that were claimed, plus `verse`, whose alignment the call site passes outright. If a
    // construct leaves this list its keys must have gained a reader in the gem, which is a gem bump
    // rather than an edit here.
    expect([...UNREAD_TEXT_ALIGN_KEYS].toSorted()).toEqual([
      'button_text_align',
      'code_text_align',
      'codespan_text_align',
      'conum_text_align',
      'footnotes_text_align',
      'kbd_text_align',
      'quote_text_align',
      'verse_text_align',
    ]);
  });

  it.each(UNREAD_TEXT_ALIGN_KEYS)('reads nothing from a theme that writes %s', (key) => {
    // Every one of the eight is a single category, so the flat key is the category's own name and the
    // author writes it as `<category>: {text-align: …}` — which is also its path in the model.
    const [category] = key.split('_text_align');
    const result = resolveAppearance({
      themeText: `extends: default\n${category}:\n  text-align: right\n`,
    });
    // Silence rather than a complaint, because silence is what the renderer answers with: the key
    // reaches the theme table and no reader ever asks for it. What must not happen is the value
    // arriving in the model, which is where the stylesheet would have found it.
    expect(result.diagnostics).toEqual([]);
    expect(result.themeApplied).toBe(true);
    const group = at(result.appearance, category);
    expect(group).toBeDefined();
    expect(Reflect.get(group as object, 'textAlign')).toBeUndefined();
  });
});
