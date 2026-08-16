/**
 * @file The appearance model projected onto CSS custom properties.
 *
 * This is the only place where a resolved theme value becomes CSS, and it is deliberately narrow.
 * Every value arriving here has already been parsed to a typed value by the resolver — a number of
 * points, six hexadecimal digits, one of a fixed set of keywords — and every value leaving here is
 * built by a formatter that can only produce one shape. A theme string is never concatenated into
 * CSS, which is what makes escaping the preview container structurally impossible rather than
 * filtered.
 *
 * ## The vocabulary
 *
 * The property names are a contract between two files that do not import each other: this one writes
 * them and `print-preview.css` reads them. Nothing would fail to compile if they drifted — the page
 * would simply lose a value in silence. So the whole vocabulary is declared here as data, exported as
 * {@link PRINT_CSS_PROPERTIES}, and a test asserts it equals the set the stylesheet actually reads.
 *
 * Names are derived mechanically from the model path, lower-kebab throughout: `page.marginPt.top`
 * becomes `--print-page-margin-top`, `headings[2].fontColor` becomes `--print-heading-2-font-color`,
 * `code.backgroundColor` becomes `--print-code-background-color`. The `Pt` suffix is a unit marker on
 * the model, not part of the name.
 *
 * One refinement to that rule, because CSS demands it: a model `fontStyle` field derives **two**
 * properties, `-font-weight` and `-font-style`. The renderer keeps weight and slant in one keyword
 * (`bold_italic`); CSS keeps them in separate declarations, and there is no way to switch on a custom
 * property's value in a stylesheet. Splitting here is what lets the stylesheet stay static.
 */

import { ADMONITION_TYPES, HEADING_LEVELS, MAX_FONT_FAMILY_LENGTH } from '@asciidocollab/shared';
import { metricFamilyOf } from './font-faces';
import { NO_FACE_METRICS } from './font-metrics';
import type { FaceBoxLookup } from './font-metrics';
import type {
  AppearanceModel,
  BlockFrame,
  Colour,
  HeadingAppearance,
  InlineBox,
  MeasurementBox,
  Typography,
  UnalignedTypography,
} from '@asciidocollab/shared';

/** CSS pixels per PDF point, at the 96 dpi the browser lays out in. */
const PIXELS_PER_POINT = 96 / 72;

/**
 * The characters a family name this projection will emit may be made of. Anything else is dropped
 * rather than quoted and hoped for.
 *
 * It is applied to the theme's OWN name and never to the name derived from it. That is the whole of
 * how the two used to disagree: a 51-to-64-character family emitted `--print-<construct>-font-family`
 * and NOT `--print-<construct>-metric-font-family`, because the derived name overran a length budget
 * the family had only just fitted, and the stylesheet's fallback for the missing property is the
 * catalogue's own mono face — which IS registered, so it won the stack ahead of the theme's real
 * family and inline code was measured and broken at another typeface's widths. That was patched by
 * stretching the budget by the suffix's length; it is now impossible instead, the check being made
 * once, on the one string a theme wrote. See {@link metricFamily}.
 */
const SAFE_FONT_FAMILY = /^[\w +.-]+$/;

/** One custom property, and how to read its value out of the model. */
interface PropertyDefinition {
  /** The full custom-property name, including the `--print-` prefix. */
  readonly name: string;
  /**
   * Produce the property's value, or undefined when the model does not carry it.
   *
   * @param model - The resolved appearance.
   * @param faceBox - The vertical measurements of a face, for the properties that need them.
   * @returns The CSS value, or undefined to leave the property unwritten.
   */
  readonly read: (model: AppearanceModel, faceBox: FaceBoxLookup) => string | undefined;
}

/**
 * Convert a length in PDF points to CSS pixels.
 *
 * Exported because the page frame needs the page's size as a number to work out what scale fits it
 * to the pane, and that conversion must be the same one the stylesheet's values went through — a
 * second copy of 96/72 elsewhere is a page that is a fraction of a percent off its own contents.
 *
 * @param points - A length in PDF points.
 * @returns The same length in CSS pixels.
 */
export function pointsToPixels(points: number): number {
  return Math.round(points * PIXELS_PER_POINT * 10_000) / 10_000;
}

/** Convert points to CSS pixels, rounded to a precision no display can tell apart. */
function px(points: number | undefined): string | undefined {
  if (points === undefined || !Number.isFinite(points)) return undefined;
  return `${pointsToPixels(points)}px`;
}

/** Format a resolved colour. The model guarantees six hexadecimal digits or the transparent keyword. */
function colour(value: Colour | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === 'transparent') return 'transparent';
  return /^[\dA-F]{6}$/.test(value) ? `#${value}` : undefined;
}

/**
 * Format a font family, quoted so a name with spaces is one family rather than several.
 *
 * @param value - The name to emit.
 * @returns The quoted name, or undefined for anything this projection will not emit.
 */
function family(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > MAX_FONT_FAMILY_LENGTH) {
    return undefined;
  }
  return SAFE_FONT_FAMILY.test(value) ? `"${value}"` : undefined;
}

/**
 * Format the name a family's file is registered under a second time, carrying the renderer's metrics.
 *
 * The THEME's name is what is checked, and the derived name is built from it afterwards rather than
 * checked again. That ordering is the point. `metricFamilyOf` appends a fixed suffix whose separator
 * is deliberately a character {@link SAFE_FONT_FAMILY} rejects — see the function itself for why the
 * derived name has to sit in a namespace no theme can reach — so re-running the check on the result
 * would refuse every name this is for. And the result needs no check of its own: a string that
 * passed the check, followed by a literal this file controls, cannot hold a quote, a semicolon or a
 * brace, which is the entire property the check exists to establish.
 *
 * Written whenever the family is known rather than only when the second registration succeeded: a
 * name nothing registered simply does not match, and the stylesheet's stack falls through to the
 * family itself. What it must NOT do is disagree with {@link family} about WHICH families are
 * emittable — the stylesheet reads the absence of this one as "no such registration" and falls back
 * to a face belonging to another family — and asking `family` is how the two are kept identical.
 *
 * @param value - The family the construct is set in, after the renderer's own inheritance.
 * @returns The quoted name, or undefined for a family this projection would not emit.
 */
function metricFamily(value: string | undefined): string | undefined {
  if (value === undefined || family(value) === undefined) return undefined;
  return `"${metricFamilyOf(value)}"`;
}

/**
 * Format a short piece of theme text as a CSS string, with every character escaped.
 *
 * Two of the renderer's values are genuinely text — the brackets around a button's label, the caret
 * between the parts of a menu path — and a theme may set either to something of its own. Text is the
 * one kind of value this file otherwise refuses to carry, because a theme string reaching a
 * declaration is exactly how a value would escape the container.
 *
 * Escaping EVERY code point as `\XXXXXX ` is what makes carrying it safe rather than filtered: the
 * output is a sequence of numeric escapes, so no character of the input appears in the output at all
 * and there is nothing for a quote, a brace or a semicolon to close. The result is still a formatter
 * that can produce exactly one shape.
 *
 * @param text - The theme's own text.
 * @returns A quoted CSS string, or undefined when there is nothing to say.
 */
function cssString(text: string | undefined): string | undefined {
  if (text === undefined || text.length === 0 || text.length > MAX_CONTENT_LENGTH) return undefined;
  const escaped = [...text].map((character) => `\\${character.codePointAt(0)?.toString(16)} `).join('');
  return `"${escaped}"`;
}

/** A bracket or a caret is a handful of characters; anything longer is not one, and is dropped. */
const MAX_CONTENT_LENGTH = 64;

/**
 * One end of the air the renderer puts around the sign between two key caps.
 *
 * The renderer joins the caps of a chord with the theme's separator — a plus sign between two
 * narrow no-break spaces, at its own default — while Asciidoctor's HTML backend writes a bare `+`
 * between them and nothing else. The sign is therefore already on the page and the air around it is
 * not — and that air is most of what a reader sees of the separator, the two spaces together being
 * more than two thirds as wide as the sign between them. So the separator is carried as its two ends
 * and the stylesheet sets them either side of the sign the markup already has.
 *
 * The one thing this cannot follow is a theme that changes the SIGN rather than the spacing around
 * it. The markup's `+` is the HTML backend's own constant, and nothing in the converted document
 * says the export would draw something else there.
 *
 * @param separator - The theme's separator, or undefined when it carries none.
 * @param end - Which end to take.
 * @returns A quoted CSS string — empty for a separator with no air at that end — or undefined.
 */
function separatorEnd(separator: string | undefined, end: 'before' | 'after'): string | undefined {
  if (separator === undefined) return undefined;
  // All air and no sign: there is nothing for the air to sit around, and putting it either side of
  // the markup's own `+` would draw a sign the export does not.
  if (separator.trim().length === 0) return undefined;
  const text =
    end === 'before'
      ? separator.slice(0, separator.length - separator.trimStart().length)
      : separator.slice(separator.trimEnd().length);
  // An empty string rather than nothing: a theme that deliberately sets a separator with no air must
  // beat the stylesheet's fallback, and an unwritten property lets that fallback through.
  return text.length === 0 ? '""' : cssString(text);
}

/** Format a plain ratio, such as a line height. */
function ratio(value: number | undefined): string | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : String(value);
}

/** Emit one of a fixed set of keywords, or nothing. */
function keyword(value: string | undefined, permitted: readonly string[]): string | undefined {
  return value !== undefined && permitted.includes(value) ? value : undefined;
}

/** The CSS `font-weight` half of the renderer's single font-style keyword. */
function fontWeightOf(style: string | undefined): string | undefined {
  if (style === undefined) return undefined;
  return style === 'bold' || style === 'bold_italic' ? '700' : '400';
}

/** The CSS `font-style` half of the renderer's single font-style keyword. */
function fontSlantOf(style: string | undefined): string | undefined {
  if (style === undefined) return undefined;
  return style === 'italic' || style === 'bold_italic' || style === 'normal_italic' ? 'italic' : 'normal';
}

/**
 * How a category's single font-style keyword becomes the two CSS declarations.
 *
 * There are two answers, because the renderer has two mechanisms.
 *
 * A BLOCK category's keyword is a prawn font selection: `theme_font :heading` calls
 * `font family, style: :bold`, and `:bold` is a face, not a modifier — it names both axes at once, so
 * `bold` means upright as much as it means heavy. Both declarations are written, and that is
 * {@link BLOCK_STYLE_AXES}.
 *
 * An INLINE category's keyword is a set of fragment styles instead. `transform.rb` builds it with
 * `to_styles theme.codespan_font_style` and MERGES it into whatever the markup around the fragment
 * contributed (`update_fragment`, transform.rb:412) — `<strong>` having put `:bold` in the set and
 * `<em>` `:italic` (transform.rb:271-276). So `bold` there adds weight and says nothing about slant:
 * a codespan inside `_…_` under a theme whose codespan is bold is drawn bold AND italic. Writing the
 * other axis as well would be the stylesheet asserting something the renderer never decided, and it
 * would override the inheritance the stylesheet sets up for exactly that case.
 *
 * The one keyword that forces both is `normal_italic`, and only because `to_styles` spells it
 * `[:normal, :italic]` and `update_fragment` reads the `:normal` as an instruction to subtract the
 * inherited bold and italic before merging. A plain `normal` produces no set at all (`to_styles`
 * has no branch for it), which `.compact` then drops from the category's settings — so it forces
 * neither axis, exactly as an absent key does.
 */
interface StyleAxes {
  /**
   * The `font-weight` value the keyword settles on.
   *
   * @param style - The category's font-style keyword, or undefined when it names none.
   * @returns The value, or undefined to leave the axis to the stylesheet.
   */
  readonly weight: (style: string | undefined) => string | undefined;
  /**
   * The `font-style` value the keyword settles on.
   *
   * @param style - The category's font-style keyword, or undefined when it names none.
   * @returns The value, or undefined to leave the axis to the stylesheet.
   */
  readonly slant: (style: string | undefined) => string | undefined;
}

/** A block category's keyword names a face, so it settles both axes. */
const BLOCK_STYLE_AXES: StyleAxes = { weight: fontWeightOf, slant: fontSlantOf };

/** An inline category's keyword is merged into the markup's own styles, so it settles only its own. */
const FRAGMENT_STYLE_AXES: StyleAxes = {
  weight: (style) => {
    if (style === 'bold' || style === 'bold_italic') return '700';
    // `normal_italic` is the subtract path: it clears an inherited bold rather than ignoring it.
    return style === 'normal_italic' ? '400' : undefined;
  },
  slant: (style) =>
    style === 'italic' || style === 'bold_italic' || style === 'normal_italic' ? 'italic' : undefined,
};

/** Text alignments that are valid CSS as written. */
const TEXT_ALIGNS: readonly string[] = ['left', 'center', 'right', 'justify'];

/** Text transforms that are valid CSS as written. */
const TEXT_TRANSFORMS: readonly string[] = ['none', 'uppercase', 'lowercase', 'capitalize'];

/**
 * Block alignments, as the `margin-inline` shorthand a block image is centred with.
 *
 * `left`/`right`/`center` are not CSS values for a block's own position, so each is projected as the
 * margin pair that produces it. Emitting the keyword and switching on it in the stylesheet is not
 * possible: a stylesheet cannot branch on a custom property's value.
 */
const BLOCK_ALIGN_MARGINS: ReadonlyMap<string, string> = new Map([
  ['left', '0 auto 0 0'],
  ['center', '0 auto'],
  ['right', '0 0 0 auto'],
]);

/**
 * The margin pair that puts a block where an alignment keyword says.
 *
 * A `Map` and not an object literal, because the keyword is author text that has been through a
 * whitelist somewhere ELSE. Indexed as an object, `constructor` and `__proto__` are keys every object
 * answers to: the first returns a function that stringifies into a `margin` declaration, and neither
 * is anything a theme wrote. Nothing reaches here with one today — the resolver admits three words —
 * but this is the only place that decides, and a lookup that can only answer for its own three keys
 * cannot stop being the place that decides.
 *
 * @param align - The theme's alignment keyword.
 * @returns The margin shorthand, or undefined for anything that is not one of the three.
 */
function blockAlignMargin(align: string | undefined): string | undefined {
  return align === undefined ? undefined : BLOCK_ALIGN_MARGINS.get(align);
}

/** Border styles that are valid CSS as written. */
const BORDER_STYLES: readonly string[] = ['solid', 'dashed', 'dotted', 'double'];

/** The four edge properties one `MeasurementBox` field derives. */
function edgeProperties(
  prefix: string,
  read: (model: AppearanceModel) => MeasurementBox | undefined,
): PropertyDefinition[] {
  return [
    { name: `${prefix}-top`, read: (model) => px(read(model)?.top) },
    { name: `${prefix}-right`, read: (model) => px(read(model)?.right) },
    { name: `${prefix}-bottom`, read: (model) => px(read(model)?.bottom) },
    { name: `${prefix}-left`, read: (model) => px(read(model)?.left) },
  ];
}

/** How a construct is set, after its own inheritance step, for the two line-box readers below. */
interface LineBoxText {
  /** The family the construct's text is set in, or undefined to take the body's. */
  readonly fontFamily: string | undefined;
  /** The size in points, or undefined to take the body's. */
  readonly fontSizePt: number | undefined;
  /** The renderer's font-style keyword, which selects the face the line is measured against. */
  readonly fontStyle: string | undefined;
  /** The construct's own line height, or undefined to take the body's. */
  readonly lineHeight: number | undefined;
}

/**
 * The line box the renderer would build for one construct, as a CSS LENGTH or not at all.
 *
 * A theme's line height is not the height of a line. The renderer advances a baseline by the FACE's
 * own built-in height plus `(line-height - 1) x font-size` — `calc_line_metrics` computes the second
 * term as the leading and prawn adds it to `Font#height` — whereas CSS `line-height` IS the whole
 * box. Writing the theme's number straight into CSS therefore sets lines about a fifth too close on
 * the renderer's own default theme, which is not a rounding difference but a different page.
 *
 * The face is resolved the same way the stylesheet resolves it, because it has to be the face the
 * text is actually drawn in: a bold heading is measured against the bold file, and a construct that
 * names no family of its own is measured against the body's.
 *
 * Undefined when the face's metrics are unknown — a family that fell back to a local approximation,
 * or a project file this preview could not read. This is the reader for the one property that is
 * consumed as a length rather than applied as a `line-height`, and for that one a ratio is not a
 * degraded answer but a broken declaration; see the conum's entry below.
 *
 * @param model - The resolved appearance, for the values a construct inherits from body text.
 * @param faceBox - The vertical measurements of a face.
 * @param text - How the construct is set, after its own inheritance step.
 * @returns The line box as a CSS length, or undefined when the face is unknown.
 */
function lineBoxLength(
  model: AppearanceModel,
  faceBox: FaceBoxLookup,
  text: LineBoxText,
): string | undefined {
  const sizePt = text.fontSizePt ?? model.base.fontSizePt;
  // `theme_font` swaps in the construct's own line height only when it has one; every other
  // construct is typeset at the body's, at its OWN size and in its OWN face.
  const multiple = text.lineHeight ?? model.base.lineHeight;
  const built = faceBox(text.fontFamily ?? model.base.fontFamily, text.fontStyle)?.lineHeight;
  if (built === undefined || !Number.isFinite(sizePt) || !Number.isFinite(multiple)) return undefined;
  return px(sizePt * (built + multiple - 1));
}

/**
 * The same line box, degrading to the theme's ratio when the face is unknown.
 *
 * This is what every property APPLIED as a `line-height` uses: a bare number is a valid line height,
 * so a preview with no metrics for the face still sets its lines at the theme's own multiple. That is
 * the appearance before the arithmetic above existed rather than a guess at the face's height, and
 * the substituted-font diagnostic is what tells a reader the page is approximate.
 *
 * @param model - The resolved appearance, for the values a construct inherits from body text.
 * @param faceBox - The vertical measurements of a face.
 * @param text - How the construct is set, after its own inheritance step.
 * @returns The line box as a CSS length, the theme's ratio when the face is unknown, or undefined.
 */
function lineBox(
  model: AppearanceModel,
  faceBox: FaceBoxLookup,
  text: LineBoxText,
): string | undefined {
  return lineBoxLength(model, faceBox, text) ?? ratio(text.lineHeight);
}

/**
 * One of the two paddings the renderer builds a block's text with, as a CSS LENGTH.
 *
 * `calc_line_metrics` (asciidoctor-pdf's `ext/prawn/extensions.rb`) splits a block's leading in two
 * and puts the FACE's line gap entirely on top of the upper half.
 *
 * ```text
 * leading = line_height x font_size - font_size
 * padding_top    = leading / 2 + font.line_gap
 * padding_bottom = leading / 2
 * ```
 *
 * The converter then passes `padding_top` as the text box's `initial_gap` and moves down by
 * `padding_bottom` after it, so a block's FIRST baseline sits `padding_top + ascender` below its top
 * and its bottom sits `descender + padding_bottom` below its LAST baseline. Neither is symmetric,
 * and CSS's own line box is: it splits the leading evenly and puts no gap anywhere. That asymmetry
 * is why these are read out as lengths rather than left to the browser — see the strut on a codespan
 * and the trimmed end edge in `print-preview.css`, which are what consume them.
 *
 * The `bottom` edge carries the descender as well as the half-leading, because the thing under a
 * block's last line is the face's descent and then the padding, and CSS measures a trimmed end edge
 * from the baseline rather than from the descent.
 *
 * @param model - The resolved appearance, for the values a construct inherits from body text.
 * @param faceBox - The vertical measurements of a face.
 * @param text - How the construct is set, after its own inheritance step.
 * @param edge - Which of the two to compute.
 * @returns The padding as a CSS length, or undefined when the face's metrics are unknown.
 */
function linePadding(
  model: AppearanceModel,
  faceBox: FaceBoxLookup,
  text: LineBoxText,
  edge: 'top' | 'bottom',
): string | undefined {
  const sizePt = text.fontSizePt ?? model.base.fontSizePt;
  const multiple = text.lineHeight ?? model.base.lineHeight;
  const box = faceBox(text.fontFamily ?? model.base.fontFamily, text.fontStyle);
  if (box === undefined || !Number.isFinite(sizePt) || !Number.isFinite(multiple)) return undefined;
  const halfLeading = (sizePt * (multiple - 1)) / 2;
  return px(halfLeading + sizePt * (edge === 'top' ? box.lineGap : box.descender));
}

/**
 * The renderer's two block paddings for one typography group.
 *
 * Spread EXPLICITLY at the call sites that need them rather than folded into
 * {@link typographyProperties}, and that is the point: they belong to a group only when the
 * stylesheet has a block to spend them on. A codespan and a key cap are fragments inside someone
 * else's line box — they take their block's gaps and must not declare their own — so deriving these
 * for every group would write a name with no reader, which the vocabulary test in
 * `appearance-to-css.test.ts` fails on. The list of call sites below IS the list of contexts that
 * lay out a block of text in a face of their own.
 *
 * @param prefix - The property-name prefix, including `--print-`.
 * @param read - The construct's own typography.
 * @param inherit - What it falls back to for family and size before body text.
 * @returns One definition per edge.
 */
function linePaddingProperties(
  prefix: string,
  read: (model: AppearanceModel) => UnalignedTypography | undefined,
  inherit: (model: AppearanceModel) => UnalignedTypography | undefined = () => undefined,
): PropertyDefinition[] {
  return (
    [
      ['top', 'line-top-gap'],
      ['bottom', 'line-bottom-gap'],
    ] as const
  ).map(([edge, suffix]) => ({
    name: `${prefix}-${suffix}`,
    read: (model: AppearanceModel, faceBox: FaceBoxLookup) => {
      const own = read(model);
      const from = inherit(model);
      return linePadding(
        model,
        faceBox,
        {
          fontFamily: own?.fontFamily ?? from?.fontFamily,
          fontSizePt: own?.fontSizePt ?? from?.fontSizePt,
          fontStyle: own?.fontStyle ?? from?.fontStyle,
          lineHeight: own?.lineHeight ?? from?.lineHeight,
        },
        edge,
      );
    },
  }));
}

/**
 * The properties one typography group derives, WITHOUT an alignment.
 *
 * Alignment is not a setting every category has. The converter reads a `text_align` for ten of them
 * and no others (`RENDERED_TEXT_ALIGN_KEYS` in `packages/shared`, taken off the gem), so a group that
 * is not one of the ten derives no `-text-align` at all: writing one would put a name in this
 * vocabulary that the stylesheet has no honest rule to read it with, which is the same determination
 * a verse's absent alignment already carries below.
 *
 * @param prefix - The property-name prefix, including `--print-`.
 * @param read - The construct's own typography.
 * @param inherit - What the construct falls back to for family and size before body text, where the
 *   renderer has such a step — a key cap takes the codespan's family, an attribution the quote's.
 * @param axes - Which of the renderer's two font-style mechanisms this category goes through; see
 *   {@link StyleAxes}. Blocks by default, because most of these groups are blocks.
 * @returns One definition per property the group derives.
 */
function typographyProperties(
  prefix: string,
  read: (model: AppearanceModel) => UnalignedTypography | undefined,
  inherit: (model: AppearanceModel) => UnalignedTypography | undefined = () => undefined,
  axes: StyleAxes = BLOCK_STYLE_AXES,
): PropertyDefinition[] {
  return [
    { name: `${prefix}-font-family`, read: (model) => family(read(model)?.fontFamily) },
    { name: `${prefix}-font-size`, read: (model) => px(read(model)?.fontSizePt) },
    { name: `${prefix}-font-color`, read: (model) => colour(read(model)?.fontColor) },
    { name: `${prefix}-font-weight`, read: (model) => axes.weight(read(model)?.fontStyle) },
    { name: `${prefix}-font-style`, read: (model) => axes.slant(read(model)?.fontStyle) },
    {
      name: `${prefix}-line-height`,
      read: (model, faceBox) => {
        const own = read(model);
        const from = inherit(model);
        return lineBox(model, faceBox, {
          fontFamily: own?.fontFamily ?? from?.fontFamily,
          fontSizePt: own?.fontSizePt ?? from?.fontSizePt,
          fontStyle: own?.fontStyle ?? from?.fontStyle,
          lineHeight: own?.lineHeight ?? from?.lineHeight,
        });
      },
    },
    // The face's own reach above and below the baseline, as multiples of the font size. They are here and not only on body text because the renderer
    // measures them off whatever face the text it is drawing is set in: a superscript inside a
    // heading is raised by the HEADING face's ascender, and the tint behind a codespan is as deep as
    // the MONO face descends. The stylesheet funnels each group's pair into one inherited pair, so a
    // construct that changes face changes them with it.

    { name: `${prefix}-face-ascender`, read: (model, faceBox) => faceRatio(model, faceBox, read, inherit, 'ascender') },
    { name: `${prefix}-face-descender`, read: (model, faceBox) => faceRatio(model, faceBox, read, inherit, 'descender') },
    // The name the same file is registered a second time under, resolved down the same chain as the
    // pair above, and relayed by the stylesheet in the same way — see {@link metricFamily} for what
    // the second registration is and `--metric-font-family` in `print-preview.css` for the relay.
    //
    // Per GROUP rather than only on the constructs that name a family of their own, because the one
    // construct that needs it names none: a highlight is set in whatever surrounds it, so the only
    // way for its tint to be measured against the face it is drawn in is for every context that
    // establishes a face to say what that face's metric registration is called. Written whenever the
    // family is known, exactly as `-face-ascender` is, so a group that inherits its family inherits
    // the right name with it rather than falling through to the stylesheet's literal.
    {
      name: `${prefix}-metric-font-family`,
      read: (model) =>
        metricFamily(read(model)?.fontFamily ?? inherit(model)?.fontFamily ?? model.base.fontFamily),
    },
  ];
}

/**
 * The same properties plus the alignment, for one of the categories the converter reads one for.
 *
 * @param prefix - The property-name prefix, including `--print-`.
 * @param read - The construct's own typography.
 * @returns One definition per property the group derives.
 */
function alignedTypographyProperties(
  prefix: string,
  read: (model: AppearanceModel) => Typography | undefined,
): PropertyDefinition[] {
  return [
    ...typographyProperties(prefix, read),
    { name: `${prefix}-text-align`, read: (model) => keyword(read(model)?.textAlign, TEXT_ALIGNS) },
  ];
}

/**
 * One of a face's two baseline-relative measurements, for the face a typography group resolves to.
 *
 * The face is resolved exactly the way {@link lineBox} resolves it, and for the same reason: it has
 * to be the face the text is actually drawn in, or the number describes some other typeface.
 *
 * @param model - The resolved appearance, for the family body text falls back to.
 * @param faceBox - The vertical measurements of a face.
 * @param read - The construct's own typography.
 * @param inherit - What it falls back to for family and style before body text.
 * @param which - Which of the two measurements to take.
 * @returns The ratio, or undefined when this preview has no metrics for that face.
 */
function faceRatio(
  model: AppearanceModel,
  faceBox: FaceBoxLookup,
  read: (model: AppearanceModel) => Typography | undefined,
  inherit: (model: AppearanceModel) => Typography | undefined,
  which: 'ascender' | 'descender' | 'lineGap' | 'xAdvance',
): string | undefined {
  const own = read(model);
  const from = inherit(model);
  const box = faceBox(
    own?.fontFamily ?? from?.fontFamily ?? model.base.fontFamily,
    own?.fontStyle ?? from?.fontStyle,
  );
  const value = box?.[which];
  return value === undefined ? undefined : ratio(Number(value.toFixed(6)));
}

/** The properties one `InlineBox` group derives. */
function inlineBoxProperties(
  prefix: string,
  read: (model: AppearanceModel) => InlineBox | undefined,
): PropertyDefinition[] {
  return [
    { name: `${prefix}-background-color`, read: (model) => colour(read(model)?.backgroundColor) },
    { name: `${prefix}-border-color`, read: (model) => colour(read(model)?.borderColor) },
    { name: `${prefix}-border-width`, read: (model) => px(read(model)?.borderWidthPt) },
    { name: `${prefix}-border-radius`, read: (model) => px(read(model)?.borderRadiusPt) },
    { name: `${prefix}-border-offset`, read: (model) => px(read(model)?.borderOffsetPt) },
  ];
}

/** The properties one `BlockFrame` group derives. */
function frameProperties(
  prefix: string,
  read: (model: AppearanceModel) => BlockFrame | undefined,
): PropertyDefinition[] {
  return [
    { name: `${prefix}-background-color`, read: (model) => colour(read(model)?.backgroundColor) },
    { name: `${prefix}-border-color`, read: (model) => colour(read(model)?.borderColor) },
    { name: `${prefix}-border-width`, read: (model) => px(read(model)?.borderWidthPt) },
    { name: `${prefix}-border-radius`, read: (model) => px(read(model)?.borderRadiusPt) },
    ...edgeProperties(`${prefix}-padding`, (model) => read(model)?.paddingPt),
  ];
}

/** The whole vocabulary, in one table so the names and the readers cannot drift apart. */
const PROPERTIES: readonly PropertyDefinition[] = [
  { name: '--print-page-width', read: (model) => px(model.page.widthPt) },
  { name: '--print-page-height', read: (model) => px(model.page.heightPt) },
  ...edgeProperties('--print-page-margin', (model) => model.page.marginPt),
  { name: '--print-page-background-color', read: (model) => colour(model.page.backgroundColor) },

  ...alignedTypographyProperties('--print-base', (model) => model.base),
  ...linePaddingProperties('--print-base', (model) => model.base),
  // The one HORIZONTAL face measurement this projection carries, and it is here because a list's
  // geometry is built out of it: `convert_list_item` sets the marker one `rendered_width_of_char 'x'`
  // clear of the text column, in whatever face is in force where the list sits.
  //
  // The BODY's face, and only the body's. Unlike the ascender and descender beside it, this is not
  // relayed per construct: it is declared once, on the container, and the sixteen rules in
  // `print-preview.css` that put a construct in a face of its own re-declare that pair and leave this
  // alone. What that costs is bounded, and the bound is why it is left alone rather than multiplied
  // into a `--print-<construct>-face-x-advance` for every group. The stylesheet spends the value as
  // `calc(1em * var(--face-x-advance) - 0.5pt)`, so the SIZE half is already the construct's own —
  // `1em` is the inherited font size — and only the RATIO can be wrong, which needs a construct that
  // changes FACE rather than size. Of the constructs that can contain a list at all, that is a
  // quotation with a `quote.font-family` of its own, and what moves is the marker: it is placed
  // `right: 100%` of the text column, outside the flow, so a wrong gutter shifts the glyph and no line
  // of text breaks anywhere else. A per-construct relay would be fifteen more names in this vocabulary
  // to place five bullets a fraction of a point better.
  {
    name: '--print-base-face-x-advance',
    read: (model, faceBox) => faceRatio(model, faceBox, (m) => m.base, () => undefined, 'xAdvance'),
  },
  { name: '--print-base-border-color', read: (model) => colour(model.base.borderColor) },
  // `base.border-width` is deliberately NOT projected, for exactly the reason `base.border-radius`
  // is not — see below. The COLOUR really does cascade: `resolve_theme_color %(#{category}_border_
  // color), @theme.base_border_color` appears at every construct the renderer strokes. The WIDTH
  // never does; `b_width = @theme[%(#{category}_border_width)]` has no second step, and where the
  // gem's own themes appear to pass one down they are resolving the `$base_border_width` VARIABLE
  // into each category's key while the theme loads. The one rule that read it here was the pale
  // hairline this style used to draw above the footnote list, which is a rule the renderer draws
  // nowhere.
  // `base.border-radius` is deliberately NOT projected. Nothing on the page is drawn with it: the
  // renderer computes a block's radius from `<category>.border-radius` alone — `b_radius ||=
  // (@theme[%(#{category}_border_radius)] || 0) + b_width`, with no step back to a broader category —
  // and an inline box's from its own key in the same way. Where the gem's default theme appears to
  // pass it down it is doing something else: `$base_border_radius` is a theme VARIABLE, resolved into
  // each category's own key while the theme loads, so what reaches the model is already the
  // category's. A property written here would be one the stylesheet could only read by inventing a
  // cascade the renderer does not have, which is how a rounded rule got onto a quotation's square end.

  { name: '--print-prose-margin-bottom', read: (model) => px(model.spacing.proseMarginBottomPt) },
  { name: '--print-block-margin-bottom', read: (model) => px(model.spacing.blockMarginBottomPt) },

  ...HEADING_LEVELS.flatMap((level): PropertyDefinition[] => {
    const at = (model: AppearanceModel): HeadingAppearance => model.headings[level];
    return [
      ...alignedTypographyProperties(`--print-heading-${level}`, at),
      ...linePaddingProperties(`--print-heading-${level}`, at),
      { name: `--print-heading-${level}-margin-top`, read: (model) => px(at(model).marginTopPt) },
      { name: `--print-heading-${level}-margin-bottom`, read: (model) => px(at(model).marginBottomPt) },
    ];
  }),

  // The shared `heading.text-align`, which is NOT `--print-heading-1-text-align` and is not any of the
  // other five either. Level 1 has two readers that disagree: the DOCUMENT TITLE takes
  // `heading.h1.text-align` alone and centres without it (`converter.rb:194`), while a level-0 section
  // — a part, in book doctype — is inked as a level-1 heading through the ordinary chain
  // `heading.h1.text-align || heading.text-align || base.text-align` (`converter.rb:653`). The model
  // carries the h1 key alone at `headings[1].textAlign` for the first reader, so the middle step of
  // the second needs a name of its own; the stylesheet spends it on `h1.sect0`, the markup
  // Asciidoctor gives a part.
  { name: '--print-heading-text-align', read: (model) => keyword(model.headingTextAlign, TEXT_ALIGNS) },

  { name: '--print-link-font-color', read: (model) => colour(model.link.fontColor) },

  // A codespan is a text FRAGMENT, so its font style merges with the markup's rather than replacing
  // it — see {@link FRAGMENT_STYLE_AXES}.
  ...typographyProperties('--print-codespan', (model) => model.codespan, undefined, FRAGMENT_STYLE_AXES),
  // A codespan is a fragment, but a MONOSPACED COLUMN is a block set in the codespan's own face and
  // size (`convert_table`'s `:monospaced` branch), and it is `p.tableblock.monospaced` in the
  // stylesheet that spends these.
  ...linePaddingProperties('--print-codespan', (model) => model.codespan),
  ...inlineBoxProperties('--print-codespan', (model) => model.codespan),

  // A key cap the theme gives no family of its own is drawn in the codespan's, which is the face its
  // line is measured against too.
  ...typographyProperties(
    '--print-kbd',
    (model) => model.kbd,
    (model) => model.codespan,
    FRAGMENT_STYLE_AXES,
  ),
  ...inlineBoxProperties('--print-kbd', (model) => model.kbd),

  {
    name: '--print-kbd-separator-before',
    read: (model) => separatorEnd(model.kbd.separator, 'before'),
  },
  { name: '--print-kbd-separator-after', read: (model) => separatorEnd(model.kbd.separator, 'after') },

  // A button is a text FRAGMENT too, and it reaches the merge through the SAME branch a codespan and
  // a key cap do: `when :button, :code, :kbd, :mark, :menu then update_fragment fragment,
  // @theme_settings[tag_name]` (transform.rb:276) is one branch for all five. So `button.font-style:
  // bold` — which the gem's own default theme sets — adds weight to whatever the markup contributed
  // and says nothing about slant, and `_press btn:[Save] to continue_` is drawn bold AND italic.
  // Projected on the block axes this wrote `--print-button-font-style: normal` outright, and the
  // stylesheet set every such button upright. See {@link FRAGMENT_STYLE_AXES}.
  ...typographyProperties('--print-button', (model) => model.button, undefined, FRAGMENT_STYLE_AXES),
  ...inlineBoxProperties('--print-button', (model) => model.button),

  { name: '--print-button-content-before', read: (model) => cssString(model.button.content?.before) },
  { name: '--print-button-content-after', read: (model) => cssString(model.button.content?.after) },

  // The fifth arm of that same branch, and the same correction: `menu.font-style: bold` is in the
  // gem's own default theme, so this used to write `--print-menu-font-style: normal` and set every
  // menu path in an emphasised sentence upright against an export that slants it.
  { name: '--print-menu-font-weight', read: (model) => FRAGMENT_STYLE_AXES.weight(model.menu.fontStyle) },
  { name: '--print-menu-font-style', read: (model) => FRAGMENT_STYLE_AXES.slant(model.menu.fontStyle) },
  { name: '--print-menu-caret-font-color', read: (model) => colour(model.menu.caretFontColor) },
  { name: '--print-menu-caret-content', read: (model) => cssString(model.menu.caretContent) },

  { name: '--print-mark-background-color', read: (model) => colour(model.mark.backgroundColor) },
  { name: '--print-mark-border-offset', read: (model) => px(model.mark.borderOffsetPt) },

  ...typographyProperties('--print-code', (model) => model.code),
  ...frameProperties('--print-code', (model) => model.code),

  // Not the whole typography group: a callout number is a ring with one digit centred in it, so its
  // text alignment is the ring's geometry rather than anything a theme can set without deforming it.
  { name: '--print-conum-font-family', read: (model) => family(model.conum.fontFamily) },
  { name: '--print-conum-font-size', read: (model) => px(model.conum.fontSizePt) },
  { name: '--print-conum-font-color', read: (model) => colour(model.conum.fontColor) },
  { name: '--print-conum-font-weight', read: (model) => fontWeightOf(model.conum.fontStyle) },
  { name: '--print-conum-font-style', read: (model) => fontSlantOf(model.conum.fontStyle) },

  // The ring's own line box and the three face measurements it is built from. Together they are the
  // only thing that says how high above its explanation's first line a ring sits: `convert_colist_item`
  // inks the marker inside `theme_font :conum`, in a box that opens at the SAME cursor as the item's
  // text, so the two are offset by exactly the difference between their line metrics — the renderer's
  // `padding_top + ascender`, which for the conum is its own `line-height` and its own face's.
  //
  // The line height is a length rather than the theme's ratio, for the reason {@link lineBoxLength}
  // gives: the renderer's line box is the face's own height plus the theme's leading. The face ratios
  // are beside it because the arithmetic that places the ring needs the two apart, not their sum.
  //
  // And it is the LENGTH-only reader, alone in this table. Every other line height is applied as a
  // `line-height`, where a bare ratio is still a valid declaration; this one is a term in a `calc()`,
  // and `calc(<number> / 2 + <length>)` is invalid at computed-value time — the whole `padding-top`
  // is thrown away and every callout ring drops to the top of its cell. A theme that names its own
  // file for the codespan or the conum reaches that on the ordinary path, because
  // `resolveFaceMetrics` skips a project face whose bytes are not held yet: the first paint of every
  // such project, and every paint of one whose file cannot be read. Leaving the property unwritten
  // lets the stylesheet's own length stand, which is a ring in the wrong place by a point rather than
  // a ring in the wrong place by a line.
  {
    name: '--print-conum-line-height',
    read: (model, faceBox) =>
      lineBoxLength(model, faceBox, {
        fontFamily: model.conum.fontFamily,
        fontSizePt: model.conum.fontSizePt,
        fontStyle: model.conum.fontStyle,
        lineHeight: model.conum.lineHeight,
      }),
  },
  {
    name: '--print-conum-face-ascender',
    read: (model, faceBox) => faceRatio(model, faceBox, (m) => m.conum, () => undefined, 'ascender'),
  },
  {
    name: '--print-conum-face-descender',
    read: (model, faceBox) => faceRatio(model, faceBox, (m) => m.conum, () => undefined, 'descender'),
  },
  {
    name: '--print-conum-face-line-gap',
    read: (model, faceBox) => faceRatio(model, faceBox, (m) => m.conum, () => undefined, 'lineGap'),
  },
  // The callout list's marker column is the ring's glyph plus one `x` of the conum's own face
  // (`marker_width = rendered_width_of_string %(#{conum_glyph index}x)`), with the ring centred in it.
  {
    name: '--print-conum-face-x-advance',
    read: (model, faceBox) => faceRatio(model, faceBox, (m) => m.conum, () => undefined, 'xAdvance'),
  },
  // The second registration of the conum's own file, for the DIGIT drawn inside the ring. The ring is
  // a box the stylesheet draws and the digit is centred in it by a line box, so where the glyph lands
  // is decided by the ascent and descent the browser was given — and the registration the page's text
  // is set in declares the face's line gap as part of its ascent, which is right for placing a line
  // and wrong for centring a glyph in a box. Measured: with the digit set in the text registration it
  // sat 2.8% of the ring's height below its centre, against a 2% allowance.
  {
    name: '--print-conum-metric-font-family',
    read: (model) => metricFamily(model.conum.fontFamily ?? model.codespan.fontFamily ?? model.base.fontFamily),
  },

  ...typographyProperties('--print-footnotes', (model) => model.footnotes),
  { name: '--print-footnotes-item-spacing', read: (model) => px(model.footnotes.itemSpacingPt) },

  { name: '--print-list-marker-font-color', read: (model) => colour(model.list.markerFontColor) },
  { name: '--print-list-indent', read: (model) => px(model.list.indentPt) },
  { name: '--print-list-item-spacing', read: (model) => px(model.list.itemSpacingPt) },

  {
    name: '--print-callout-list-margin-top-after-code',
    read: (model) => px(model.calloutList.marginTopAfterCodePt),
  },

  {
    name: '--print-description-list-term-font-weight',
    read: (model) => fontWeightOf(model.descriptionList.termFontStyle),
  },
  {
    name: '--print-description-list-term-font-style',
    read: (model) => fontSlantOf(model.descriptionList.termFontStyle),
  },
  {
    name: '--print-description-list-term-spacing',
    read: (model) => px(model.descriptionList.termSpacingPt),
  },
  {
    name: '--print-description-list-description-indent',
    read: (model) => px(model.descriptionList.descriptionIndentPt),
  },

  ...typographyProperties('--print-quote', (model) => model.quote),
  ...linePaddingProperties('--print-quote', (model) => model.quote),
  ...frameProperties('--print-quote', (model) => model.quote),
  { name: '--print-quote-border-left-width', read: (model) => px(model.quote.borderLeftWidthPt) },

  // Not the whole typography group: the renderer inks an attribution left-aligned outright, so there
  // is no alignment for a theme to set. Nor does it inherit the quotation — `convert_quote_or_verse`
  // closes the quote's `theme_font` block before opening the attribution's, so what an attribution
  // falls back to is whatever surrounded the block, which is body text.
  { name: '--print-quote-cite-font-family', read: (model) => family(model.quote.cite?.fontFamily) },
  { name: '--print-quote-cite-font-size', read: (model) => px(model.quote.cite?.fontSizePt) },
  { name: '--print-quote-cite-font-color', read: (model) => colour(model.quote.cite?.fontColor) },
  { name: '--print-quote-cite-font-weight', read: (model) => fontWeightOf(model.quote.cite?.fontStyle) },
  { name: '--print-quote-cite-font-style', read: (model) => fontSlantOf(model.quote.cite?.fontStyle) },
  {
    name: '--print-quote-cite-line-height',
    read: (model, faceBox) =>
      lineBox(model, faceBox, {
        fontFamily: model.quote.cite?.fontFamily,
        fontSizePt: model.quote.cite?.fontSizePt,
        fontStyle: model.quote.cite?.fontStyle,
        lineHeight: model.quote.cite?.lineHeight,
      }),
  },

  // A verse's own group. Not `typographyProperties`, and the difference is one property: there is no
  // `--print-verse-text-align`, because `convert_quote_or_verse` hands `ink_prose` the alignment
  // outright (`converter.rb:1350`) and no `verse.text-align` could reach the page. Writing one would
  // put a name in this vocabulary that the stylesheet has no honest rule to read it with.
  { name: '--print-verse-font-family', read: (model) => family(model.verse.fontFamily) },
  { name: '--print-verse-font-size', read: (model) => px(model.verse.fontSizePt) },
  { name: '--print-verse-font-color', read: (model) => colour(model.verse.fontColor) },
  { name: '--print-verse-font-weight', read: (model) => fontWeightOf(model.verse.fontStyle) },
  { name: '--print-verse-font-style', read: (model) => fontSlantOf(model.verse.fontStyle) },
  {
    name: '--print-verse-line-height',
    read: (model, faceBox) =>
      lineBox(model, faceBox, {
        fontFamily: model.verse.fontFamily,
        fontSizePt: model.verse.fontSizePt,
        fontStyle: model.verse.fontStyle,
        lineHeight: model.verse.lineHeight,
      }),
  },
  {
    name: '--print-verse-face-ascender',
    read: (model, faceBox) => faceRatio(model, faceBox, (m) => m.verse, () => undefined, 'ascender'),
  },
  {
    name: '--print-verse-face-descender',
    read: (model, faceBox) => faceRatio(model, faceBox, (m) => m.verse, () => undefined, 'descender'),
  },
  // The third member of the relay, resolved down the same chain as the pair above — see
  // `typographyProperties`, which writes it for every group that goes through it.
  {
    name: '--print-verse-metric-font-family',
    read: (model) => metricFamily(model.verse.fontFamily ?? model.base.fontFamily),
  },
  ...linePaddingProperties('--print-verse', (model) => model.verse),
  ...frameProperties('--print-verse', (model) => model.verse),
  { name: '--print-verse-border-left-width', read: (model) => px(model.verse.borderLeftWidthPt) },

  { name: '--print-verse-cite-font-family', read: (model) => family(model.verse.cite?.fontFamily) },
  { name: '--print-verse-cite-font-size', read: (model) => px(model.verse.cite?.fontSizePt) },
  { name: '--print-verse-cite-font-color', read: (model) => colour(model.verse.cite?.fontColor) },
  { name: '--print-verse-cite-font-weight', read: (model) => fontWeightOf(model.verse.cite?.fontStyle) },
  { name: '--print-verse-cite-font-style', read: (model) => fontSlantOf(model.verse.cite?.fontStyle) },
  {
    name: '--print-verse-cite-line-height',
    read: (model, faceBox) =>
      lineBox(model, faceBox, {
        fontFamily: model.verse.cite?.fontFamily,
        fontSizePt: model.verse.cite?.fontSizePt,
        fontStyle: model.verse.cite?.fontStyle,
        lineHeight: model.verse.cite?.lineHeight,
      }),
  },

  ...frameProperties('--print-sidebar', (model) => model.sidebar),
  ...alignedTypographyProperties('--print-sidebar-title', (model) => model.sidebar.title),
  ...linePaddingProperties('--print-sidebar-title', (model) => model.sidebar.title),
  {
    name: '--print-sidebar-title-margin-bottom',
    read: (model) => px(model.sidebar.title?.marginBottomPt),
  },

  ...frameProperties('--print-example', (model) => model.example),

  { name: '--print-admonition-background-color', read: (model) => colour(model.admonition.backgroundColor) },
  { name: '--print-admonition-column-rule-color', read: (model) => colour(model.admonition.columnRuleColor) },
  { name: '--print-admonition-column-rule-width', read: (model) => px(model.admonition.columnRuleWidthPt) },
  ...edgeProperties('--print-admonition-padding', (model) => model.admonition.paddingPt),
  { name: '--print-admonition-label-font-weight', read: (model) => fontWeightOf(model.admonition.label?.fontStyle) },
  { name: '--print-admonition-label-font-style', read: (model) => fontSlantOf(model.admonition.label?.fontStyle) },
  {
    name: '--print-admonition-label-text-transform',
    read: (model) => keyword(model.admonition.label?.textTransform, TEXT_TRANSFORMS),
  },
  { name: '--print-admonition-label-min-width', read: (model) => px(model.admonition.label?.minWidthPt) },
  // The icon's size sets the label column's width as well as the glyph's, which is why it is a length
  // the stylesheet computes with rather than a font-size it only applies.
  ...ADMONITION_TYPES.flatMap((type): PropertyDefinition[] => [
    {
      name: `--print-admonition-icon-${type}-font-color`,
      read: (model) => colour(model.admonition.icons[type].fontColor),
    },
    {
      name: `--print-admonition-icon-${type}-size`,
      read: (model) => px(model.admonition.icons[type].sizePt),
    },
  ]),

  {
    name: '--print-image-align',
    // The margin pair, not the keyword: `margin: center` is not a declaration, and a stylesheet
    // cannot branch on a custom property's value to turn one into the other.
    read: (model) => blockAlignMargin(model.image.align),
  },

  {
    name: '--print-table-align',
    // The margin pair, for the same reason a block image's alignment is one: a keyword cannot be a
    // declaration, and a stylesheet cannot branch on a custom property's value.
    read: (model) => blockAlignMargin(model.table.align),
  },
  { name: '--print-table-background-color', read: (model) => colour(model.table.backgroundColor) },
  { name: '--print-table-border-color', read: (model) => colour(model.table.borderColor) },
  { name: '--print-table-border-width', read: (model) => px(model.table.borderWidthPt) },
  { name: '--print-table-grid-color', read: (model) => colour(model.table.gridColor) },
  { name: '--print-table-grid-width', read: (model) => px(model.table.gridWidthPt) },
  ...edgeProperties('--print-table-cell-padding', (model) => model.table.cellPaddingPt),
  { name: '--print-table-head-background-color', read: (model) => colour(model.table.head?.backgroundColor) },
  { name: '--print-table-head-font-weight', read: (model) => fontWeightOf(model.table.head?.fontStyle) },
  { name: '--print-table-head-font-style', read: (model) => fontSlantOf(model.table.head?.fontStyle) },
  {
    name: '--print-table-head-border-bottom-width',
    read: (model) => px(model.table.head?.borderBottomWidthPt),
  },
  // The footer row. `convert_table` restyles the last row once the cells exist (converter.rb:2382-2389),
  // which is why the fill has a fallback of its own — `resolve_theme_color :table_foot_background_color,
  // tbl_bg_color` (converter.rb:2070) — while the four text settings simply leave the body's in place
  // when the theme sets none.
  { name: '--print-table-foot-background-color', read: (model) => colour(model.table.foot?.backgroundColor) },
  { name: '--print-table-foot-font-family', read: (model) => family(model.table.foot?.fontFamily) },
  { name: '--print-table-foot-font-size', read: (model) => px(model.table.foot?.fontSizePt) },
  { name: '--print-table-foot-font-color', read: (model) => colour(model.table.foot?.fontColor) },
  { name: '--print-table-foot-font-weight', read: (model) => fontWeightOf(model.table.foot?.fontStyle) },
  { name: '--print-table-foot-font-style', read: (model) => fontSlantOf(model.table.foot?.fontStyle) },
  {
    // The footer's line box, which is NOT this group's own line box.
    //
    // `theme_font` is never opened for a footer: the row's size and family are assigned to cells whose
    // `leading` was already fixed from the BODY's line metrics (`body_cell_line_metrics`,
    // converter.rb:2129). Prawn then advances by `font.height + leading` — the footer face at the
    // footer size, plus the body's leading. So the face term takes the footer's size and the leading
    // term takes the body's, which is what this composes; {@link lineBox}, which scales both by one
    // size, would set a smaller footer's lines too tight and a larger one's too loose.
    name: '--print-table-foot-line-height',
    read: (model, faceBox) => {
      const foot = model.table.foot;
      if (foot === undefined) return undefined;
      const sizePt = foot.fontSizePt ?? model.base.fontSizePt;
      const built = faceBox(foot.fontFamily ?? model.base.fontFamily, foot.fontStyle)?.lineHeight;
      if (built === undefined || !Number.isFinite(sizePt) || !Number.isFinite(model.base.lineHeight)) {
        return undefined;
      }
      return px(sizePt * built + model.base.fontSizePt * (model.base.lineHeight - 1));
    },
  },
  {
    name: '--print-table-foot-face-ascender',
    read: (model, faceBox) => faceRatio(model, faceBox, (m) => m.table.foot, () => undefined, 'ascender'),
  },
  {
    name: '--print-table-foot-face-descender',
    read: (model, faceBox) => faceRatio(model, faceBox, (m) => m.table.foot, () => undefined, 'descender'),
  },
  // And its metric-bearing name. `model.table.foot` is optional, so this is the one relay member that
  // can be absent for a reason other than an unknown face: a theme with no `table.foot` group at all
  // leaves the footer set in body text's, which is what the stylesheet's own fallback already says.
  {
    name: '--print-table-foot-metric-font-family',
    read: (model) =>
      model.table.foot === undefined
        ? undefined
        : metricFamily(model.table.foot.fontFamily ?? model.base.fontFamily),
  },
  ...linePaddingProperties('--print-table-foot', (model) => model.table.foot),
  {
    name: '--print-table-body-stripe-background-color',
    read: (model) => colour(model.table.body?.stripeBackgroundColor),
  },

  // The contents entries carry no alignment of their own — the renderer sets them at the body's —
  // and the contents title carries no line height, because it is inked through the heading path.
  { name: '--print-toc-font-family', read: (model) => family(model.toc.fontFamily) },
  { name: '--print-toc-font-size', read: (model) => px(model.toc.fontSizePt) },
  { name: '--print-toc-font-color', read: (model) => colour(model.toc.fontColor) },
  { name: '--print-toc-font-weight', read: (model) => fontWeightOf(model.toc.fontStyle) },
  { name: '--print-toc-font-style', read: (model) => fontSlantOf(model.toc.fontStyle) },
  {
    name: '--print-toc-line-height',
    read: (model, faceBox) =>
      lineBox(model, faceBox, {
        fontFamily: model.toc.fontFamily,
        fontSizePt: model.toc.fontSizePt,
        fontStyle: model.toc.fontStyle,
        lineHeight: model.toc.lineHeight,
      }),
  },
  { name: '--print-toc-indent', read: (model) => px(model.toc.indentPt) },
  { name: '--print-toc-title-font-family', read: (model) => family(model.toc.title?.fontFamily) },
  { name: '--print-toc-title-font-size', read: (model) => px(model.toc.title?.fontSizePt) },
  { name: '--print-toc-title-font-color', read: (model) => colour(model.toc.title?.fontColor) },
  { name: '--print-toc-title-font-weight', read: (model) => fontWeightOf(model.toc.title?.fontStyle) },
  { name: '--print-toc-title-font-style', read: (model) => fontSlantOf(model.toc.title?.fontStyle) },
  {
    name: '--print-toc-title-text-align',
    read: (model) => keyword(model.toc.title?.textAlign, TEXT_ALIGNS),
  },

  ...alignedTypographyProperties('--print-caption', (model) => model.caption),
  { name: '--print-caption-margin-inside', read: (model) => px(model.caption.marginInsidePt) },
  { name: '--print-caption-margin-outside', read: (model) => px(model.caption.marginOutsidePt) },

  { name: '--print-thematic-break-border-color', read: (model) => colour(model.thematicBreak.borderColor) },
  {
    name: '--print-thematic-break-border-style',
    read: (model) => keyword(model.thematicBreak.borderStyle, BORDER_STYLES),
  },
  { name: '--print-thematic-break-border-width', read: (model) => px(model.thematicBreak.borderWidthPt) },
  ...edgeProperties('--print-thematic-break-padding', (model) => model.thematicBreak.paddingPt),
];

/**
 * Every custom property this projection can write.
 *
 * The stylesheet reads exactly this set, and a test holds the two together. Exported rather than kept
 * private because that test is the only thing standing between two `[P]`-parallel files and a page
 * that silently loses a value.
 */
export const PRINT_CSS_PROPERTIES: readonly string[] = PROPERTIES.map((property) => property.name);

/**
 * Project a resolved appearance onto the custom properties the Print stylesheet reads.
 *
 * A property is written only for a value the model actually carries. A missing value is **absent**,
 * never an empty string — an empty custom property beats the stylesheet's own `var(--x, default)`
 * fallback with nothing, so writing one would degrade the page to blank rather than to the default.
 *
 * @param model - The resolved appearance.
 * @param faceBox - The vertical measurements of the face a family and style resolve to. Every
 *   line-height property is a length built from it, because the renderer's line box is the face's own
 *   height plus the theme's leading rather than the theme's number on its own. Omitting it writes the
 *   theme's ratios instead, which is the honest degradation for a caller that has no font metrics.
 * @returns Custom property name to value, ready to set on the preview container.
 */
export function appearanceToCssProperties(
  model: AppearanceModel,
  faceBox: FaceBoxLookup = NO_FACE_METRICS,
): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const property of PROPERTIES) {
    const value = property.read(model, faceBox);
    if (value !== undefined) properties[property.name] = value;
  }
  return properties;
}
