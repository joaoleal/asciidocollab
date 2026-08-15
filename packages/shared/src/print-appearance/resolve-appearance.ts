/**
 * @file Resolved theme values → the appearance model.
 *
 * This is where the closed enumeration of what the Print style reproduces actually lives. Every
 * theme key the model reads is named in {@link CLAIMED_THEME_KEYS}, and the builder below reads only
 * those — so "claimed as supported" is a list a test can iterate rather than a claim in prose. A key
 * outside the list is neither applied nor reported; it is simply not part of this style's contract.
 *
 * A value that does not match what its key accepts costs that key alone: it is reported, and the
 * renderer's own default for that one key is used instead. That is what keeps one typo in a theme
 * from emptying a page.
 */

import { GENERATED_THEME_DESCRIPTORS } from '../render-config/theme-descriptors.generated';
import type { AppearanceDiagnostic, AppearanceDiagnosticCode } from './appearance-diagnostic';
import type {
  AdmonitionAppearance,
  AdmonitionIconAppearance,
  AdmonitionType,
  AppearanceModel,
  BlockFrame,
  ButtonAppearance,
  CalloutListAppearance,
  CaptionAppearance,
  CodeAppearance,
  CodespanAppearance,
  ConumAppearance,
  ExampleAppearance,
  FontFacePaths,
  FontRequirement,
  HeadingAppearance,
  InlineBox,
  KbdAppearance,
  MarkAppearance,
  MenuAppearance,
  PageAppearance,
  QuoteAppearance,
  SidebarAppearance,
  SpacingAppearance,
  TableAppearance,
  ThematicBreakAppearance,
  TocAppearance,
  Typography,
  UnalignedTypography,
  VerseAppearance,
} from './appearance-model';
import { ADMONITION_TYPES, HEADING_LEVELS } from './appearance-model';
import { FALLBACK_PAGE_SIZE_NAME, NAMED_PAGE_SIZES_PT } from './page-sizes.generated';
import type { ThemeFontFamily } from './parse-theme';
import { flatThemeKey } from './parse-theme';
import type { Colour, MeasurementBox, MeasurementContext } from './units';
import {
  isSideColourList,
  numberValue,
  parseColour,
  parseFontFamily,
  parseKeyword,
  parseMeasurement,
  parseMeasurementBox,
  parseNumber,
  parseSideColour,
  readColour,
  readsColoursPerElement,
} from './units';

/** Each key's permitted keywords, in the flat key space, from the generated descriptor catalogue. */
const PERMITTED_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map(
  GENERATED_THEME_DESCRIPTORS.filter((descriptor) => descriptor.permittedValues !== undefined).map(
    (descriptor) => [flatThemeKey(descriptor.key), descriptor.permittedValues ?? []],
  ),
);

/** Font-style keywords, used for the handful of keys the descriptor catalogue does not enumerate. */
const FONT_STYLES: readonly string[] = ['normal', 'bold', 'italic', 'bold_italic', 'normal_italic'];

/** Text alignments. */
const TEXT_ALIGNS: readonly string[] = ['left', 'center', 'right', 'justify'];

/** Where a block sits in the text column. A block has no justified position, so there are three. */
const BLOCK_ALIGNS: readonly string[] = ['left', 'center', 'right'];

/** What one key read produced, so the caller can tell "unset" from "rejected". */
type ReadOutcome<T> = { readonly value?: T; readonly rejected: boolean };

/**
 * The context every length that is NOT a font size is read in.
 *
 * The renderer resolves `em`, `rem` and `%` only where the value is a font size. Every other length
 * reaches the page through `str_to_pt` (`measurements.rb:20`), whose unit list is
 * `in|mm|cm|pt|px|pc` and whose fallback is `String#to_f` — so `page: margin: 10%` is ten points and
 * `page: margin: 1em` is one point. Reading them against body text instead, which is what this did,
 * put a 1 em margin at 10.5 points against an export that gives it 1.
 */
const LENGTH: MeasurementContext = { literalPoints: true };

/** A length written relative to the size of the text it appears in, which is not always knowable. */
const RELATIVE_TO_ENCLOSING = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:em|%)$/i;

/** How a font size whose enclosing size cannot be known reads in a rejection message. */
const UNKNOWABLE_ENCLOSING_SIZE =
  'a size this preview can resolve — `em` and `%` on this key are relative to the size of whatever text the construct appears in, which varies from one occurrence to the next';

/** Everything one resolution needs to read a key and account for what it found. */
export interface AppearanceReaderInput {
  /** Flat key → resolved value, project theme layered over the renderer's default. */
  readonly values: ReadonlyMap<string, unknown>;
  /** Flat key → the renderer's own default value, for a key that has to fall back. */
  readonly defaults: ReadonlyMap<string, unknown>;
  /** Flat keys the project's theme set, so only its own values are ever reported as rejected. */
  readonly projectKeys: ReadonlySet<string>;
  /** Flat key → the line of the project theme it was written on. */
  readonly lines: ReadonlyMap<string, number>;
  /** The project theme's path, used to attribute diagnostics to a document. */
  readonly themePath?: string;
  /** Families the effective font catalogue declares. */
  readonly fontFamilies: readonly ThemeFontFamily[];
  /** Families the theme's `font.fallbacks` names, which the renderer loads and nothing else names. */
  readonly fontFallbacks?: readonly string[];
  /** Flat keys the project's theme wrote as a mapping — see {@link ParsedTheme.mappingKeys}. */
  readonly mappingKeys?: ReadonlySet<string>;
}

/**
 * Reads typed values out of a resolved theme, accounting for every rejection.
 *
 * A rejection is only ever reported for a key the *project's* theme set. The renderer's own default
 * theme carries keys this preview does not model — reporting those would fill an author's
 * diagnostics list with problems in a document they did not write and cannot edit.
 */
class AppearanceReader {
  /** Problems found while reading, in the order they were met. */
  readonly diagnostics: AppearanceDiagnostic[] = [];

  /**
   * Keys already reported. One theme key is one mistake however many times the builder happens to
   * read it — `base.font-size` is read both for its own field and to fix what `em` is relative to,
   * and an author should not be told twice about one typo because of how the builder is arranged.
   */
  private readonly reported = new Set<string>();

  /** @param input - The resolved values and the bookkeeping needed to attribute a rejection. */
  constructor(private readonly input: AppearanceReaderInput) {}

  /**
   * Say one thing about one NAMED key, attributed to the line the theme wrote it on.
   *
   * The key is named from {@link NAMED_THEME_KEYS} and the sentence is this module's own — see the
   * source rule on {@link AppearanceDiagnostic}. One key is one mistake, so a second sentence about a
   * key already spoken for is dropped rather than queued.
   *
   * @param key - The flat theme key.
   * @param message - The whole sentence, already built.
   * @param code - What kind of problem it is. Defaults to the rejection every other caller reports.
   */
  note(key: string, message: string, code: AppearanceDiagnosticCode = 'theme-value-rejected'): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    const line = this.input.lines.get(key);
    this.diagnostics.push({
      severity: 'warning',
      code,
      message,
      themeKey: key,
      resource: this.input.themePath ?? 'theme',
      ...(this.input.themePath === undefined
        ? {}
        : { location: { path: this.input.themePath, ...(line === undefined ? {} : { line }) } }),
    });
  }

  /** Record that one key's value could not be used, naming the key and where it was written. */
  private reject(key: string, expectation: string): void {
    this.note(
      key,
      `The theme's ${key.replaceAll('_', '.')} is not ${expectation}, so its default is used instead.`,
    );
  }

  /**
   * Read one key through a parser, reporting and falling back when the project's value fails.
   *
   * @param key - The flat theme key.
   * @param expectation - How the key's accepted form reads in a message, e.g. "a colour".
   * @param parse - The parser for this key's value kind.
   * @returns What the key produced, and whether the project's own value was rejected.
   */
  private read<T>(key: string, expectation: string, parse: (value: unknown) => T | undefined): ReadOutcome<T> {
    const raw = this.input.values.get(key);
    if (raw === undefined || raw === null) return { rejected: false };
    const parsed = parse(raw);
    if (parsed !== undefined) return { value: parsed, rejected: false };
    if (!this.input.projectKeys.has(key)) return { rejected: false };
    this.reject(key, expectation);
    const fallback = parse(this.input.defaults.get(key));
    return { ...(fallback === undefined ? {} : { value: fallback }), rejected: true };
  }

  /**
   * A colour, saying so when the renderer applied one that is not the whole of what was written.
   *
   * The only key kind with anything to say about a value it ACCEPTS. `to_color` sizes anything to six
   * characters, so `font-color: "FF0000 /* x"` is pure red in the exported page — measured,
   * `1.0 0.0 0.0 scn` from a converted PDF, identical to the same key set to `FF0000` — and the rest
   * of the value is discarded without a word. Refusing it instead would show a page the export does
   * not print, which is the trade this module makes nowhere else and will not make here; saying what
   * was cut is the answer that is true to the export and useful to the author.
   *
   * Only ever about a value the project's own theme wrote, like every other diagnostic here, and only
   * about a CUT: padding loses nothing, and a value cut to something that is not a colour is refused
   * and reported as a rejection rather than twice.
   *
   * @param key - The flat theme key.
   * @returns The colour, or undefined when the key carries none.
   */
  colour(key: string): Colour | undefined {
    // Two keys can hold a LIST of colours rather than one — see {@link readsColoursPerElement} — and
    // the one this style paints is its first. Nothing is said about the sides it does not paint:
    // they are not a value cut short, they are the rest of a shorthand the export draws in full.
    //
    // A list is a shorthand only where the loader read it as one, which is not something its shape
    // can say: see {@link isSideColourList}. And only under the key that read it — a converted list
    // travels, because `$table_border_color` resolves to the very value the table key holds, and
    // under the key that borrowed it the loader converts the whole list over again. Measured against
    // the vendored gem under ruby 3.3.3: `table: border_color: [null, 2]` with
    // `thematic_break: border_color: $table_border_color` leaves the thematic break `"000002"`, the
    // joined list — not the `transparent` its first side draws on the table.
    const written = this.input.values.get(key);
    if (isSideColourList(written) && readsColoursPerElement(key, written)) {
      return this.read(key, 'a colour', parseSideColour).value;
    }
    const outcome = this.read(key, 'a colour', parseColour);
    if (outcome.rejected || outcome.value === undefined || !this.input.projectKeys.has(key)) {
      return outcome.value;
    }
    if (readColour(this.input.values.get(key)).truncated) {
      this.note(
        key,
        `The theme's ${key.replaceAll('_', '.')} is longer than a colour, so only its first six characters are used — which is what the exported page is painted with.`,
        'theme-value-truncated',
      );
    }
    return outcome.value;
  }

  /** A length in points. */
  measurement(key: string, context: MeasurementContext = {}): number | undefined {
    return this.read(key, 'a length', (value) => parseMeasurement(value, context)).value;
  }

  /**
   * A font size, which is the one kind of value the renderer resolves a relative unit for.
   *
   * @param key - The flat theme key.
   * @param context - The root size `rem` is measured against, and the enclosing size `em` and `%`
   *   are, where the model knows what encloses this construct.
   * @returns The size in points, or undefined when the key carries none.
   */
  fontSize(key: string, context: MeasurementContext): number | undefined {
    const raw = this.input.values.get(key);
    if (
      context.enclosingPt === undefined &&
      typeof raw === 'string' &&
      RELATIVE_TO_ENCLOSING.test(raw.trim())
    ) {
      // The value is one the renderer resolves and this preview cannot, which is a different thing
      // from a value neither of them can read — so it is said rather than reported as malformed.
      if (!this.input.projectKeys.has(key)) return parseMeasurement(this.input.defaults.get(key), context);
      this.reject(key, UNKNOWABLE_ENCLOSING_SIZE);
      return parseMeasurement(this.input.defaults.get(key), context);
    }
    return this.read(key, 'a length', (value) => parseMeasurement(value, context)).value;
  }

  /** Four edge lengths in points. */
  box(key: string, context: MeasurementContext = {}): MeasurementBox | undefined {
    return this.read(key, 'a set of edge lengths', (value) => parseMeasurementBox(value, context)).value;
  }

  /** A plain number, for the ratios that are not lengths. */
  number(key: string): number | undefined {
    return this.read(key, 'a number', parseNumber).value;
  }

  /** One of the words the renderer accepts for this key. */
  keyword(key: string, fallbackPermitted: readonly string[]): string | undefined {
    const permitted = PERMITTED_KEYWORDS.get(key) ?? fallbackPermitted;
    return this.read(key, `one of ${permitted.join(', ')}`, (value) => parseKeyword(value, permitted)).value;
  }

  /** A font family name. */
  family(key: string): string | undefined {
    return this.read(key, 'a font family name', parseFontFamily).value;
  }

  /** The raw resolved value, for the two keys whose form is not one of the kinds above. */
  raw(key: string): unknown {
    return this.input.values.get(key);
  }

  /** Whether the project's own theme set this key. */
  isProjectKey(key: string): boolean {
    return this.input.projectKeys.has(key);
  }

  /** Whether the project's own theme wrote this key as a group of settings rather than a value. */
  isMappingKey(key: string): boolean {
    return this.input.mappingKeys?.has(key) ?? false;
  }

  /** Problems already reported about the font catalogue, which has no theme key of its own. */
  private readonly reportedCatalogue = new Set<string>();

  /**
   * Report a problem with the theme's font catalogue.
   *
   * The catalogue is not a setting — it is a mapping of author-chosen names onto files — so a problem
   * in it has no key to attribute and is reported against the document instead.
   *
   * @param message - What could not be used, and what happens as a result.
   */
  reportCatalogue(message: string): void {
    if (this.reportedCatalogue.has(message)) return;
    this.reportedCatalogue.add(message);
    this.diagnostics.push({
      severity: 'warning',
      code: 'theme-font-unavailable',
      message,
      resource: this.input.themePath ?? 'theme',
      ...(this.input.themePath === undefined ? {} : { location: { path: this.input.themePath } }),
    });
  }

  /** Report a problem the builder found that is not a single key's value. */
  report(diagnostic: AppearanceDiagnostic): void {
    if (diagnostic.themeKey !== undefined) {
      if (this.reported.has(diagnostic.themeKey)) return;
      this.reported.add(diagnostic.themeKey);
    }
    this.diagnostics.push(diagnostic);
  }

  /** Where a diagnostic about the theme document as a whole points. */
  get themePath(): string | undefined {
    return this.input.themePath;
  }

  /** The effective font catalogue. */
  get fontFamilies(): readonly ThemeFontFamily[] {
    return this.input.fontFamilies;
  }

  /**
   * Every family the theme NAMES, including through settings this model does not read.
   *
   * The model reads about twenty `font-family` keys; a theme may name a face through any of them —
   * `role_<name>_font_family` is the open-ended one, since role names are the author's own and no
   * enumeration can cover them. Scanning the cascade for the suffix is what makes "a family the
   * theme uses" mean the same thing here as it does in the export, without the model having to grow
   * a field for every place a family can be named.
   *
   * @returns The family names, parsed the same way a `font-family` setting is.
   */
  namedFamilies(): string[] {
    const names: string[] = [];
    for (const [key, value] of this.input.values) {
      if (!key.endsWith('_font_family')) continue;
      const name = parseFontFamily(value);
      if (name !== undefined) names.push(name);
    }
    // `font.fallbacks` names families for glyphs the primary face lacks. The renderer loads them, and
    // they are named nowhere else, so a catalogue entry that exists only to be a fallback is used.
    for (const fallback of this.input.fontFallbacks ?? []) {
      const name = parseFontFamily(fallback);
      if (name !== undefined) names.push(name);
    }
    return names;
  }
}

/**
 * Drop the keys whose value came back undefined, so an absent value is absent rather than empty.
 *
 * This matters beyond tidiness: the delivery layer writes a CSS custom property only for a value the
 * model actually carries, and an explicitly-undefined key would write an empty property that beats
 * the stylesheet's own fallback with nothing.
 */
function compact<T extends object>(record: T): T {
  const out = { ...record };
  for (const key of Object.keys(out)) {
    if (Reflect.get(out, key) === undefined) Reflect.deleteProperty(out, key);
  }
  return out;
}

/**
 * Read the five typography keys every category has, under one prefix.
 *
 * Alignment is NOT among them, because it is not a key every category has: see
 * {@link UNREAD_TEXT_ALIGN_KEYS}. The categories the converter really does read one for use
 * {@link readAlignedTypography} instead.
 *
 * @param reader - The value reader.
 * @param prefix - The construct's flat key prefix.
 * @param size - What a relative font size on this construct is measured against.
 * @returns The construct's typography.
 */
function readTypography(
  reader: AppearanceReader,
  prefix: string,
  size: MeasurementContext,
): UnalignedTypography {
  return compact({
    fontFamily: reader.family(`${prefix}_font_family`),
    fontSizePt: reader.fontSize(`${prefix}_font_size`, size),
    fontColor: reader.colour(`${prefix}_font_color`),
    fontStyle: reader.keyword(`${prefix}_font_style`, FONT_STYLES),
    lineHeight: reader.number(`${prefix}_line_height`),
  });
}

/**
 * The same five keys plus the alignment, for a category the converter reads one for.
 *
 * @param reader - The value reader.
 * @param prefix - The construct's flat key prefix.
 * @param size - What a relative font size on this construct is measured against.
 * @returns The construct's typography.
 */
function readAlignedTypography(
  reader: AppearanceReader,
  prefix: string,
  size: MeasurementContext,
): Typography {
  return compact({
    ...readTypography(reader, prefix, size),
    textAlign: reader.keyword(`${prefix}_text_align`, TEXT_ALIGNS),
  });
}

/** Read the shared inline-box keys under one prefix. */
function readInlineBox(reader: AppearanceReader, prefix: string): InlineBox {
  return compact({
    backgroundColor: reader.colour(`${prefix}_background_color`),
    borderColor: reader.colour(`${prefix}_border_color`),
    borderWidthPt: reader.measurement(`${prefix}_border_width`, LENGTH),
    borderRadiusPt: reader.measurement(`${prefix}_border_radius`, LENGTH),
    borderOffsetPt: reader.measurement(`${prefix}_border_offset`, LENGTH),
  });
}

/**
 * The colour inside the caret's own markup, e.g. `<font color="#B12146">`.
 *
 * The renderer has no key for it: the caret is a template string carrying its own markup, and the
 * colour is an attribute inside it. Extracting it as a typed colour is what keeps the template itself
 * out of the projection — the string never leaves this function, only six hexadecimal digits do.
 */
const CARET_COLOUR = /color="#?([\da-f]{6})"/i;

/** Markup inside a template, which the renderer interprets and this preview's markup carries instead. */
const TEMPLATE_MARKUP = /<[^<>]{0,64}>/g;

/** A template no longer than this is a bracket or a caret; anything longer is not one, and is ignored. */
const MAX_TEMPLATE_LENGTH = 64;

/** Read one of the renderer's short text templates, with its inline markup removed. */
function readTemplate(reader: AppearanceReader, key: string): string | undefined {
  const raw = reader.raw(key);
  if (typeof raw !== 'string' || raw.length > MAX_TEMPLATE_LENGTH) return undefined;
  return raw.replaceAll(TEMPLATE_MARKUP, '');
}

/** Read the menu caret's colour out of the caret template, if it carries one. */
function readCaretColour(reader: AppearanceReader): Colour | undefined {
  const content = reader.raw('menu_caret_content');
  if (typeof content !== 'string') return undefined;
  return parseColour(CARET_COLOUR.exec(content)?.[1]);
}

/** The renderer's placeholder for a button's own label inside its content template. */
const LABEL_PLACEHOLDER = '%s';

/** Read the button's content template, split around where the label goes. */
function readButtonContent(reader: AppearanceReader): { before: string; after: string } | undefined {
  const template = readTemplate(reader, 'button_content');
  if (template === undefined) return undefined;
  const at = template.indexOf(LABEL_PLACEHOLDER);
  if (at === -1) return undefined;
  return { before: template.slice(0, at), after: template.slice(at + LABEL_PLACEHOLDER.length) };
}

/**
 * Read one admonition kind's icon.
 *
 * The renderer's own defaults for these — which glyph, in what colour, at what size — live in its
 * source rather than in any theme, so a kind the theme says nothing about arrives empty here and is
 * drawn from the renderer's table by the stylesheet.
 *
 * @param reader - The value reader.
 * @param type - The admonition kind.
 * @returns Whatever the theme carries for that kind's icon.
 */
function readAdmonitionIcon(reader: AppearanceReader, type: AdmonitionType): AdmonitionIconAppearance {
  return compact({
    fontColor: reader.colour(`admonition_icon_${type}_stroke_color`),
    sizePt: reader.number(`admonition_icon_${type}_size`),
  });
}

/** Read the shared block-frame keys under one prefix. */
function readFrame(reader: AppearanceReader, prefix: string): BlockFrame {
  return compact({
    backgroundColor: reader.colour(`${prefix}_background_color`),
    borderColor: reader.colour(`${prefix}_border_color`),
    borderWidthPt: reader.measurement(`${prefix}_border_width`, LENGTH),
    borderRadiusPt: reader.measurement(`${prefix}_border_radius`, LENGTH),
    paddingPt: reader.box(`${prefix}_padding`, LENGTH),
  });
}

/**
 * The frame and left rule the renderer really draws around a quotation or a verse.
 *
 * The two marks are very nearly exclusive, and the renderer says so itself: `# NOTE: b_width and
 * b_left_width are mutually exclusive` (`converter.rb:1311`). A left rule wider than zero takes the
 * first branch, which never assigns `b_width` at all, and the frame is then asked for with
 * `border_width: nil` — an explicitly PASSED nil, which `theme_fill_and_stroke_block` keeps
 * (`opts.key? :border_width`) rather than replacing with the theme's own
 * (`converter.rb:4537-4548`). With no fill to paint either, that method returns before it strokes
 * anything.
 *
 * So a theme that gives a quotation both a rule and a frame gets the rule ONLY, and the preview drew
 * both: a hairline across the top and bottom of every quotation, in the rule's own colour, that the
 * export does not print. The stylesheet is what draws each mark, and it cannot make this choice —
 * `--print-quote-border-width` is the only thing it has to go on — so the choice is made here, where
 * the whole theme is in hand, and the frame's width is reported as the zero the export inks.
 *
 * The exception is the one case the NOTE overstates: a background. It is the fill, not the border,
 * that carries the method past its early return, and what it then strokes the bounds with is
 * `@theme[…_border_width]` read afresh — not the nil it was handed (`converter.rb:4562-4566`). A
 * quotation with a background colour therefore does carry both marks, and the width stands.
 *
 * Nothing here touches the rule itself. Whether the rule is drawn also depends on a colour resolving
 * (`resolve_theme_color …, base_border_color, nil`), which is the stylesheet's fallback chain and
 * stays there.
 *
 * @param reader - The value reader.
 * @param prefix - `quote` or `verse` — the category the node chose, not the pair.
 * @returns The frame, with the rule's width beside it.
 */
function readRuledFrame(
  reader: AppearanceReader,
  prefix: string,
): BlockFrame & { readonly borderLeftWidthPt?: number } {
  const frame = readFrame(reader, prefix);
  const borderLeftWidthPt = reader.measurement(`${prefix}_border_left_width`, LENGTH);
  // `(b_left_width = @theme[…]) && b_left_width > 0` — an absent or non-positive rule leaves the
  // frame to be read the ordinary way.
  const ruled = borderLeftWidthPt !== undefined && borderLeftWidthPt > 0;
  // `(bg_color = … ) == 'transparent'` clears it, so the keyword is no background at all.
  const filled = frame.backgroundColor !== undefined && frame.backgroundColor !== 'transparent';
  return compact({
    ...frame,
    ...(ruled && !filled ? { borderWidthPt: 0 } : {}),
    borderLeftWidthPt,
  });
}

/**
 * A page dimension, as `MeasurementPartsRx` spells one: `/^(\d+(?:\.\d+)?)(in|mm|cm|p[txc])?$/`
 * (`converter.rb:108`).
 *
 * Narrower than a length anywhere else in a theme, and narrower on purpose. `build_pdf_options`
 * (`converter.rb:480-487`) does not send a page dimension through `str_to_pt`; it matches this
 * pattern and `break`s out of the whole size otherwise — so no sign, no leading `.`, no exponent, and
 * none of `em`, `rem` or `%`. A dimension it refuses does not become a smaller page, it discards BOTH
 * dimensions and the export prints A4.
 */
const PAGE_DIMENSION = /^(\d+(?:\.\d+)?)(in|mm|cm|pt|px|pc)?$/;

/**
 * One dimension of an explicit page size, as the converter reads one.
 *
 * @param dimension - The entry, after variable expansion.
 * @returns The dimension in points, or undefined — which discards the whole size.
 */
function pageDimensionPt(dimension: unknown): number | undefined {
  const magnitude = numberValue(dimension);
  if (magnitude !== undefined) {
    // "dimension cannot be less than 0" (`converter.rb:482`), which is a test for `> 0`.
    return Number.isFinite(magnitude) && magnitude > 0 ? magnitude : undefined;
  }
  if (typeof dimension !== 'string') return undefined;
  const match = PAGE_DIMENSION.exec(dimension);
  if (match === null) return undefined;
  const points = parseMeasurement(match[0], LENGTH);
  return points !== undefined && points > 0 ? points : undefined;
}

/** Resolve the page's geometry, applying the theme's orientation to the named or explicit size. */
function readPage(reader: AppearanceReader): PageAppearance {
  const size = reader.raw('page_size');
  let widthPt: number | undefined;
  let heightPt: number | undefined;

  if (Array.isArray(size)) {
    const width = pageDimensionPt(size[0]);
    // `page_size[1] ||= page_size[0]` (`converter.rb:479`) fills a MISSING second dimension only.
    const height = pageDimensionPt(size[1] ?? size[0]);
    if (width !== undefined && height !== undefined) {
      widthPt = width;
      heightPt = height;
    }
  } else if (typeof size === 'string' || numberValue(size) !== undefined) {
    // `page_size.to_s` in the converter, so a number is looked up by the characters the EXPORT writes
    // for it — none of which names a page size, but the reading is the same one everywhere else.
    const named = NAMED_PAGE_SIZES_PT[String(size).trim().toUpperCase()];
    if (named !== undefined) {
      [widthPt, heightPt] = named;
    }
  }

  if (widthPt === undefined || heightPt === undefined) {
    if (size !== undefined && size !== null && reader.isProjectKey('page_size')) {
      reader.report({
        severity: 'warning',
        code: 'theme-value-rejected',
        message:
          "The theme's page.size is not a page size the renderer recognises, so A4 is used instead.",
        themeKey: 'page_size',
        resource: reader.themePath ?? 'theme',
        ...(reader.themePath === undefined ? {} : { location: { path: reader.themePath } }),
      });
    }
    [widthPt, heightPt] = NAMED_PAGE_SIZES_PT[FALLBACK_PAGE_SIZE_NAME];
  }

  const layout = reader.keyword('page_layout', ['portrait', 'landscape']);
  const landscape = layout === 'landscape';

  return {
    widthPt: landscape ? heightPt : widthPt,
    heightPt: landscape ? widthPt : heightPt,
    marginPt: reader.box('page_margin', LENGTH) ?? { top: 36, right: 36, bottom: 36, left: 36 },
    backgroundColor: reader.colour('page_background_color') ?? 'FFFFFF',
  };
}

/** Resolve one heading level, layering its own keys over the shared `heading.*` ones. */
function readHeading(
  reader: AppearanceReader,
  level: number,
  shared: HeadingAppearance,
  size: MeasurementContext,
): HeadingAppearance {
  const own = compact<HeadingAppearance>({
    ...readAlignedTypography(reader, `heading_h${level}`, size),
    marginTopPt: reader.measurement(`heading_h${level}_margin_top`, LENGTH),
    marginBottomPt: reader.measurement(`heading_h${level}_margin_bottom`, LENGTH),
  });
  // Level 1 is the document title, and the renderer decides where that sits from `heading.h1`
  // ALONE — centring it when the key is unset, without ever consulting the shared
  // `heading.text-align` that positions section headings. Layering the shared value in here would
  // left-align a title the export centres, which is the first thing an author sees.
  const inherited =
    level === 1 ? compact<HeadingAppearance>({ ...shared, textAlign: undefined }) : shared;
  return { ...inherited, ...own };
}

/**
 * The longest face path this preview will carry.
 *
 * A catalogue path is author text that reaches the delivery layer as an asset request. The value is
 * bounded here so the model's own guarantee holds at the model's boundary rather than only at the
 * boundary of whoever happens to consume it — the same reason a family name is bounded.
 */
const MAX_FACE_PATH_LENGTH = 256;

/**
 * Characters a face path may carry: a project-relative path to a font file, and nothing else.
 *
 * Deliberately narrower than what a file system accepts. A path that would need a quotation mark, a
 * semicolon, a backslash or a control character is not a path to a font in this repository's project
 * storage; it is a value that would have to be escaped by every layer downstream instead of being
 * refused once, here.
 */
const SAFE_FACE_PATH = /^[\w ./+-]+$/;

/**
 * A path that leaves the project: rooted at `/`, or climbing through a `..` segment.
 *
 * The character class above admits both, because `.` and `/` are characters a font path genuinely
 * needs — so "project-relative" was a claim the pattern did not check, and
 * `font: catalog: X: normal: ../../etc/passwd` reached the model as a face path and the delivery
 * layer as a request for a file two directories above the project. The renderer resolves that path
 * against the theme's own directory and really does try to read it: measured against the vendored gem
 * under ruby 3.3.3, that catalogue makes the export open `/etc/passwd` and die with
 * `Prawn::Errors::UnknownFont`. The export failing is not a reason for the preview to make the
 * request; it is the reason the face is refused here and reported instead.
 *
 * Segments are matched whole, so a family whose file is honestly named `..bold.ttf` is still a face.
 */
const ESCAPING_FACE_PATH = /^\/|(?:^|\/)\.\.(?:\/|$)/;

/**
 * The most faces one appearance will ask the delivery layer for.
 *
 * Every requirement is a request for a file, issued from one effect. A theme sets a font family per
 * role, and role names are the author's own, so the number of families a THEME can name is bounded
 * only by the theme's size — which is a bound on bytes, not on requests. The model itself names
 * about twenty; a project with a face per construct and a handful of roles is comfortably inside
 * this, and a document naming more than this is not describing a page anyone typeset.
 */
const MAX_FONT_REQUIREMENTS = 64;

/**
 * Every font family the appearance references, paired with what the catalogue declares for it.
 *
 * A catalogue name is the ONE model string with no parser behind it: `font.catalog`'s keys are
 * whatever the author wrote, and promoting them into `FontRequirement.family` unchanged put a value
 * into the model that the file header's own rule — nothing leaves this boundary but a typed value —
 * does not cover. They go through the same parser a `font-family` setting does, and a name that fails
 * it is reported rather than carried, because a name the projection will refuse to emit is a face
 * that silently never loads.
 *
 * A requirement is a FETCH: the delivery layer asks the project's storage for every face listed here
 * before it can lay a page out. So the list is what the theme USES, not what it mentions. Promoting
 * the whole catalogue meant a document declaring thirteen thousand families — which fits inside the
 * theme-size bound with room to spare — asked for thirteen thousand files from one effect.
 *
 * @param reader - The value reader, for the catalogue and for reporting.
 * @param referenced - Every family the appearance's own keys name.
 * @returns One requirement per family, in a fixed order.
 */
function readFonts(reader: AppearanceReader, referenced: readonly (string | undefined)[]): FontRequirement[] {
  const declared = new Map<string, ThemeFontFamily>();
  for (const family of reader.fontFamilies) {
    const name = parseFontFamily(family.name);
    if (name === undefined) {
      reader.reportCatalogue(
        'The theme declares a font family whose name is not one this preview can set text in, so it is not loaded.',
      );
      continue;
    }
    declared.set(name, family);
  }
  // The families the MODEL names, first and in full: whatever else is asked for, the faces the page
  // is actually set in are the ones that must survive the bound below.
  const modelled = new Set<string>();
  for (const family of referenced) {
    if (family !== undefined) modelled.add(family);
  }
  // Then the families the theme names through settings the model does not read — a role's own
  // `font-family`, a fallback list. A catalogue entry that NOTHING names is deliberately not here:
  // the export never inks text in it either, so requesting the file would be work no page needs.
  const alsoNamed = new Set<string>();
  for (const family of reader.namedFamilies()) {
    if (!modelled.has(family)) alsoNamed.add(family);
  }
  const wanted = [...[...modelled].toSorted(), ...[...alsoNamed].toSorted()];
  if (wanted.length > MAX_FONT_REQUIREMENTS) {
    reader.reportCatalogue(
      `The theme names more font families than this preview will load, so only the first ${MAX_FONT_REQUIREMENTS} are requested.`,
    );
  }

  /** One declared face path, or undefined when it is not a path this preview will request. */
  const facePath = (path: string | undefined): string | undefined => {
    if (path === undefined) return undefined;
    if (
      path.length <= MAX_FACE_PATH_LENGTH &&
      SAFE_FACE_PATH.test(path) &&
      !ESCAPING_FACE_PATH.test(path)
    ) {
      return path;
    }
    reader.reportCatalogue(
      'The theme declares a font file at a path this preview will not request, so that face is not loaded.',
    );
    return undefined;
  };

  return wanted.slice(0, MAX_FONT_REQUIREMENTS).map((family) => {
    const entry = declared.get(family);
    const faces: FontFacePaths = compact({
      normal: facePath(entry?.styles['normal']),
      bold: facePath(entry?.styles['bold']),
      italic: facePath(entry?.styles['italic']),
      boldItalic: facePath(entry?.styles['bold_italic']),
    });
    return { family, declaredFaces: faces, declaredByTheme: entry !== undefined };
  });
}

/**
 * The keys that paint a whole page from a file, none of which this style reproduces.
 *
 * Every one is a real setting the export reads — `resolve_background_image` is called for each at
 * `converter.rb:4474-5019` — and the preview has no field for any of them, so a theme that dresses
 * its pages in an image gets a blank page here and, until now, no word about it. That is the widest
 * silent gap in the style: not one value off, a whole layer of the page absent.
 *
 * They are not modelled rather than not noticed. An image is fetched, decoded, scaled to the page box
 * and composited under the text, and a preview that guessed at any of that would be showing a page
 * nobody exported. Saying so is what an author can act on.
 */
const PAGE_IMAGE_KEYS: readonly string[] = [
  'page_background_image',
  'page_background_image_recto',
  'page_background_image_verso',
  'page_foreground_image',
  'title_page_background_image',
];

/**
 * Say what the theme asked for that the page cannot show, for the two shapes nothing else reports.
 *
 * Both are settings an author WROTE and the page then does not carry, and both were silent: the
 * value parsers never see them, so no rejection is raised, and the model has no field for them, so
 * nothing downstream notices either. A preview that ignores what an author typed and says nothing is
 * the failure this whole diagnostic surface exists to prevent.
 *
 * @param reader - The value reader, for the project's keys and for reporting.
 */
function reportUnreproduced(reader: AppearanceReader): void {
  for (const key of PAGE_IMAGE_KEYS) {
    if (!reader.isProjectKey(key)) continue;
    reader.note(
      key,
      `The theme's ${key.replaceAll('_', '.')} paints the page from an image file, which this preview does not show — the exported page carries it and this one does not.`,
    );
  }
  // A key the model READS, written as a group of settings. The loader descends into a mapping and
  // never sets the key itself (`theme_loader.rb:171-173`), so the export ignores it too and the
  // preview is faithful — what is missing is any word to the author that the line they indented one
  // level too far does nothing at all. Walked over the claimed keys rather than over the document's,
  // because a theme may write forty thousand mappings and only these have anything to be wrong about.
  for (const key of CLAIMED_THEME_KEYS) {
    if (!reader.isMappingKey(key)) continue;
    reader.note(
      key,
      `The theme's ${key.replaceAll('_', '.')} is written as a group of settings rather than as a value, so it sets nothing and its default is used instead.`,
    );
  }
}

/**
 * Build the appearance model from one cascade's resolved values.
 *
 * @param input - The resolved values and the bookkeeping needed to attribute a rejection.
 * @returns The model, and every problem found while reading it.
 */
export function buildAppearance(input: AppearanceReaderInput): {
  readonly appearance: AppearanceModel;
  readonly diagnostics: readonly AppearanceDiagnostic[];
} {
  const reader = new AppearanceReader(input);
  // Before anything is read, so a key that is claimed by BOTH — one written as a mapping and read for
  // its own field — is spoken about once, in the terms that explain it.
  reportUnreproduced(reader);

  // `base.font-size` is the root every `rem` is measured against, so it is read with neither field:
  // a size defined in terms of itself is not one the renderer resolves either.
  const baseFontSizePt = reader.measurement('base_font_size') ?? 12;

  /**
   * A font size inked at body size, which is where the renderer inks every block this model covers.
   *
   * `theme_font` hands the theme's size to prawn's `font_size`, which measures `em` and `%` against
   * whatever size is current at that moment. For a block construct that is the document's body text:
   * `convert_sidebar` opens `theme_font :sidebar_title` from the page's own flow, and a quotation's
   * attribution is inked at `converter.rb:1358` — OUTSIDE the `theme_font :quote` block that closed a
   * line earlier — so both are enclosed by the body rather than by anything of their own.
   */
  const atBodySize: MeasurementContext = { rootPt: baseFontSizePt, enclosingPt: baseFontSizePt };

  /**
   * A font size whose enclosing size is not knowable.
   *
   * A codespan, a key cap and a button are inline: their size reaches prawn as a fragment size
   * (`formatted_text/transform.rb:37,50,63`) resolved against the size of the run they sit in, so one
   * theme value is a different number in body text than it is in a heading. A conum is inked at body
   * size in a callout list (`converter.rb:1417`) and at the code block's size inside a listing. There
   * is no single number to resolve these against, so `rem` resolves and `em`/`%` are reported.
   */
  const atUnknownSize: MeasurementContext = { rootPt: baseFontSizePt };

  // The size read above is the authority for the body: reading it a second time under a context that
  // is itself derived from it would make `base.font-size: 1.2em` mean two different numbers.
  const baseTypography = { ...readAlignedTypography(reader, 'base', {}), fontSizePt: baseFontSizePt };
  const base = {
    ...baseTypography,
    fontFamily: baseTypography.fontFamily ?? 'Helvetica',
    fontSizePt: baseFontSizePt,
    fontColor: baseTypography.fontColor ?? '000000',
    lineHeight: baseTypography.lineHeight ?? 1.15,
    ...compact({
      borderColor: reader.colour('base_border_color'),
      borderWidthPt: reader.measurement('base_border_width', LENGTH),
      borderRadiusPt: reader.measurement('base_border_radius', LENGTH),
    }),
  };

  const sharedHeading = compact<HeadingAppearance>({
    ...readAlignedTypography(reader, 'heading', atBodySize),
    marginTopPt: reader.measurement('heading_margin_top', LENGTH),
    marginBottomPt: reader.measurement('heading_margin_bottom', LENGTH),
  });
  const headings = {
    1: readHeading(reader, 1, sharedHeading, atBodySize),
    2: readHeading(reader, 2, sharedHeading, atBodySize),
    3: readHeading(reader, 3, sharedHeading, atBodySize),
    4: readHeading(reader, 4, sharedHeading, atBodySize),
    5: readHeading(reader, 5, sharedHeading, atBodySize),
    6: readHeading(reader, 6, sharedHeading, atBodySize),
  };

  const codespan: CodespanAppearance = compact({
    ...readTypography(reader, 'codespan', atUnknownSize),
    ...readInlineBox(reader, 'codespan'),
  });

  const kbd: KbdAppearance = compact({
    ...readTypography(reader, 'kbd', atUnknownSize),
    ...readInlineBox(reader, 'kbd'),
    separator: readTemplate(reader, 'kbd_separator'),
  });

  const button: ButtonAppearance = compact({
    ...readTypography(reader, 'button', atUnknownSize),
    ...readInlineBox(reader, 'button'),
    content: readButtonContent(reader),
  });

  const menu: MenuAppearance = compact({
    fontStyle: reader.keyword('menu_font_style', FONT_STYLES),
    caretFontColor: readCaretColour(reader),
    caretContent: readTemplate(reader, 'menu_caret_content'),
  });

  const mark: MarkAppearance = compact({
    backgroundColor: reader.colour('mark_background_color'),
    borderOffsetPt: reader.measurement('mark_border_offset', LENGTH),
  });

  const code: CodeAppearance = compact({
    ...readTypography(reader, 'code', atBodySize),
    ...readFrame(reader, 'code'),
  });

  const conum: ConumAppearance = readTypography(reader, 'conum', atUnknownSize);

  // The attribution takes the renderer's `quote.cite` group, which carries no alignment: the
  // attribution is inked left-aligned outright, whatever the quotation itself is set to.
  const quoteCite: Typography = compact({
    fontFamily: reader.family('quote_cite_font_family'),
    fontSizePt: reader.fontSize('quote_cite_font_size', atBodySize),
    fontColor: reader.colour('quote_cite_font_color'),
    fontStyle: reader.keyword('quote_cite_font_style', FONT_STYLES),
    lineHeight: reader.number('quote_cite_line_height'),
  });
  const quote: QuoteAppearance = compact({
    ...readTypography(reader, 'quote', atBodySize),
    ...readRuledFrame(reader, 'quote'),
    ...(Object.keys(quoteCite).length === 0 ? {} : { cite: quoteCite }),
  });

  // A verse is its OWN category, not a quotation read again. See `VerseAppearance` for why the
  // renderer's `$quote_*` defaults on those keys are frozen at the DEFAULT theme's quote values and
  // therefore say nothing about a project's, and why there is no alignment among them.
  const verseCite: Typography = compact({
    fontFamily: reader.family('verse_cite_font_family'),
    fontSizePt: reader.fontSize('verse_cite_font_size', atBodySize),
    fontColor: reader.colour('verse_cite_font_color'),
    fontStyle: reader.keyword('verse_cite_font_style', FONT_STYLES),
    lineHeight: reader.number('verse_cite_line_height'),
  });
  const verse: VerseAppearance = compact({
    fontFamily: reader.family('verse_font_family'),
    fontSizePt: reader.fontSize('verse_font_size', atBodySize),
    fontColor: reader.colour('verse_font_color'),
    fontStyle: reader.keyword('verse_font_style', FONT_STYLES),
    lineHeight: reader.number('verse_line_height'),
    ...readRuledFrame(reader, 'verse'),
    ...(Object.keys(verseCite).length === 0 ? {} : { cite: verseCite }),
  });

  // A sidebar's title is inked by ONE call, and three of its arguments are settled at the call site
  // rather than by the `sidebar.title` group (`converter.rb:1379`):
  //
  //   ink_prose node.title,
  //     align: (sidebar_title_text_align || heading_text_align || base_text_align),
  //     margin_bottom: heading_margin_bottom,
  //     line_height: (heading_line_height || base_line_height)
  //
  // The leading is the one that reads backwards. `theme_font :sidebar_title` does put
  // `sidebar.title.line-height` into `@base_line_height`, but `ink_prose` resolves
  // `(opts.delete :line_height) || @base_line_height` (`converter.rb:3384`) — and the explicit
  // argument is only nil when the theme sets NEITHER heading nor base leading, which no theme can:
  // the loader forces `base_line_height ||= 1` onto every project theme (`theme_loader.rb:84`) and
  // every bundled theme sets it outright. So `sidebar.title.line-height` never reaches the page, and
  // letting it win here — which is what this did — set the title at a leading the export does not use.
  //
  // `sidebar.title.line-height` is therefore not read at all, and is not among the claimed keys:
  // claiming a key the renderer cannot reach would be a promise this style cannot keep.
  const sidebarTitle = compact({
    fontFamily: reader.family('sidebar_title_font_family'),
    fontSizePt: reader.fontSize('sidebar_title_font_size', atBodySize),
    fontColor: reader.colour('sidebar_title_font_color'),
    fontStyle: reader.keyword('sidebar_title_font_style', FONT_STYLES),
    lineHeight: sharedHeading.lineHeight ?? baseTypography.lineHeight,
    marginBottomPt: sharedHeading.marginBottomPt,
    textAlign: reader.keyword('sidebar_title_text_align', TEXT_ALIGNS) ?? sharedHeading.textAlign,
  });
  const sidebar: SidebarAppearance = compact({
    ...readFrame(reader, 'sidebar'),
    ...(Object.keys(sidebarTitle).length === 0 ? {} : { title: sidebarTitle }),
  });

  const example: ExampleAppearance = readFrame(reader, 'example');

  const admonitionLabel = compact({
    fontStyle: reader.keyword('admonition_label_font_style', FONT_STYLES),
    textTransform: reader.keyword('admonition_label_text_transform', [
      'none',
      'uppercase',
      'lowercase',
      'capitalize',
    ]),
    minWidthPt: reader.measurement('admonition_label_min_width', LENGTH),
  });
  const admonition: AdmonitionAppearance = compact({
    backgroundColor: reader.colour('admonition_background_color'),
    columnRuleColor: reader.colour('admonition_column_rule_color'),
    columnRuleWidthPt: reader.measurement('admonition_column_rule_width', LENGTH),
    paddingPt: reader.box('admonition_padding', LENGTH),
    ...(Object.keys(admonitionLabel).length === 0 ? {} : { label: admonitionLabel }),
    icons: {
      note: readAdmonitionIcon(reader, 'note'),
      tip: readAdmonitionIcon(reader, 'tip'),
      important: readAdmonitionIcon(reader, 'important'),
      warning: readAdmonitionIcon(reader, 'warning'),
      caution: readAdmonitionIcon(reader, 'caution'),
    },
  });

  const tableHead = compact({
    backgroundColor: reader.colour('table_head_background_color'),
    fontStyle: reader.keyword('table_head_font_style', FONT_STYLES),
    borderBottomWidthPt: reader.measurement('table_head_border_bottom_width', LENGTH),
  });
  // The footer row's five settings, which `convert_table` assigns to the last row after the cells are
  // built (converter.rb:2382-2389). Its size is read at body size because that is what encloses it:
  // the row is restyled from the page's own flow, not from inside a `theme_font` block of its own.
  const tableFoot = compact({
    backgroundColor: reader.colour('table_foot_background_color'),
    fontColor: reader.colour('table_foot_font_color'),
    fontFamily: reader.family('table_foot_font_family'),
    fontSizePt: reader.fontSize('table_foot_font_size', atBodySize),
    fontStyle: reader.keyword('table_foot_font_style', FONT_STYLES),
  });
  const tableBody = compact({
    stripeBackgroundColor: reader.colour('table_body_stripe_background_color'),
  });
  const table: TableAppearance = compact({
    align: reader.keyword('table_align', BLOCK_ALIGNS),
    backgroundColor: reader.colour('table_background_color'),
    borderColor: reader.colour('table_border_color'),
    borderWidthPt: reader.measurement('table_border_width', LENGTH),
    gridColor: reader.colour('table_grid_color'),
    gridWidthPt: reader.measurement('table_grid_width', LENGTH),
    cellPaddingPt: reader.box('table_cell_padding', LENGTH),
    ...(Object.keys(tableHead).length === 0 ? {} : { head: tableHead }),
    ...(Object.keys(tableFoot).length === 0 ? {} : { foot: tableFoot }),
    ...(Object.keys(tableBody).length === 0 ? {} : { body: tableBody }),
  });

  // `caption.align` and `caption.text-align` are TWO settings, not one key and its older spelling.
  // `ink_caption` (`converter.rb:3161-3170`) reads them apart: `align` positions the caption BLOCK
  // and falls back to `base.text-align`, while `text_align` sets the text inside it and falls back to
  // `align`. Nor is `caption_align` among the loader's `DeprecatedKeys` (`theme_loader.rb:18`), which
  // is where every genuine `*_align` → `*_text_align` rename is listed.
  //
  // The chain below is still the right one for TEXT alignment, because `align` is what `text_align`
  // falls back to. The block half is deliberately not modelled: `align` only moves the caption when
  // `ink_caption` is given a `max_width` — a table's caption sized to its table, an image's to its
  // image — and this style lays every caption across the full text column, so there is no width delta
  // for a position to distribute. Modelling the keyword without the widths it divides would draw
  // captions somewhere neither this preview nor the export puts them.
  const caption: CaptionAppearance = compact({
    ...readAlignedTypography(reader, 'caption', atBodySize),
    textAlign:
      reader.keyword('caption_text_align', TEXT_ALIGNS) ?? reader.keyword('caption_align', TEXT_ALIGNS),
    marginInsidePt: reader.measurement('caption_margin_inside', LENGTH),
    marginOutsidePt: reader.measurement('caption_margin_outside', LENGTH),
  });

  // The contents title is inked through the level-2 heading path, which decides its line height, so
  // only the four keys the renderer really reads for it are taken here. That path is also what its
  // own `em` is measured against: `theme_font_cascade [[:heading, level: 2], :toc_title]`
  // (`converter.rb:3949`) opens the heading's font before the title's, so the enclosing size is the
  // level-2 heading's rather than the body's.
  const tocTitleSize: MeasurementContext = {
    rootPt: baseFontSizePt,
    enclosingPt: headings[2].fontSizePt ?? baseFontSizePt,
  };
  const tocTitle = compact({
    fontFamily: reader.family('toc_title_font_family'),
    fontSizePt: reader.fontSize('toc_title_font_size', tocTitleSize),
    fontColor: reader.colour('toc_title_font_color'),
    fontStyle: reader.keyword('toc_title_font_style', FONT_STYLES),
    textAlign: reader.keyword('toc_title_text_align', TEXT_ALIGNS),
  });
  const toc: TocAppearance = compact({
    fontFamily: reader.family('toc_font_family'),
    fontSizePt: reader.fontSize('toc_font_size', atBodySize),
    fontColor: reader.colour('toc_font_color'),
    fontStyle: reader.keyword('toc_font_style', FONT_STYLES),
    lineHeight: reader.number('toc_line_height'),
    indentPt: reader.measurement('toc_indent', LENGTH),
    ...(Object.keys(tocTitle).length === 0 ? {} : { title: tocTitle }),
  });

  const thematicBreak: ThematicBreakAppearance = compact({
    borderColor: reader.colour('thematic_break_border_color'),
    borderStyle: reader.keyword('thematic_break_border_style', ['solid', 'dashed', 'dotted', 'double']),
    borderWidthPt: reader.measurement('thematic_break_border_width', LENGTH),
    paddingPt: reader.box('thematic_break_padding', LENGTH),
  });

  const spacing: SpacingAppearance = compact({
    proseMarginBottomPt: reader.measurement('prose_margin_bottom', LENGTH),
    blockMarginBottomPt: reader.measurement('block_margin_bottom', LENGTH),
  });

  const appearance: AppearanceModel = {
    page: readPage(reader),
    base,
    spacing,
    headings,
    // The middle step of the chain a level-1 SECTION heading takes, which the six levels above
    // cannot carry: `headings[1].textAlign` is `heading.h1.text-align` alone, because that is all the
    // DOCUMENT TITLE reads. See `AppearanceModel.headingTextAlign`.
    ...compact({ headingTextAlign: sharedHeading.textAlign }),
    link: compact({ fontColor: reader.colour('link_font_color') }),
    codespan,
    kbd,
    button,
    menu,
    mark,
    code,
    conum,
    footnotes: compact({
      ...readTypography(reader, 'footnotes', atBodySize),
      itemSpacingPt: reader.measurement('footnotes_item_spacing', LENGTH),
    }),
    list: compact({
      markerFontColor: reader.colour('list_marker_font_color'),
      indentPt: reader.measurement('list_indent', LENGTH),
      itemSpacingPt: reader.measurement('list_item_spacing', LENGTH),
    }),
    calloutList: compact<CalloutListAppearance>({
      marginTopAfterCodePt: reader.measurement('callout_list_margin_top_after_code', LENGTH),
    }),
    descriptionList: compact({
      termFontStyle: reader.keyword('description_list_term_font_style', FONT_STYLES),
      termSpacingPt: reader.measurement('description_list_term_spacing', LENGTH),
      descriptionIndentPt: reader.measurement('description_list_description_indent', LENGTH),
    }),
    quote,
    verse,
    sidebar,
    example,
    admonition,
    image: compact({ align: reader.keyword('image_align', BLOCK_ALIGNS) }),
    table,
    toc,
    caption,
    thematicBreak,
    fonts: readFonts(reader, [
      base.fontFamily,
      codespan.fontFamily,
      // The renderer falls back to the codespan family for a key cap, so a theme that names one only
      // for `kbd` still needs it loaded.
      kbd.fontFamily,
      button.fontFamily,
      code.fontFamily,
      // A footer row is the one part of a table the renderer sets in a family of its own, so a theme
      // that names one only there still needs that face loaded.
      table.foot?.fontFamily,
      conum.fontFamily,
      sharedHeading.fontFamily,
      sidebarTitle.fontFamily,
      caption.fontFamily,
      quote.fontFamily,
      quoteCite.fontFamily,
      verse.fontFamily,
      verseCite.fontFamily,
      toc.fontFamily,
      tocTitle.fontFamily,
      ...HEADING_LEVELS.map((level) => headings[level].fontFamily),
    ]),
  };

  return { appearance, diagnostics: reader.diagnostics };
}

/**
 * Every theme key the appearance model reads, in the flat key space.
 *
 * This IS the closed enumeration. It exists as data rather than prose so a test can walk it and
 * assert that each key reaches the model — "claimed as supported" then means precisely this list,
 * and a key added to the builder without an assertion fails that test rather than shipping unproven.
 */
export const CLAIMED_THEME_KEYS: readonly string[] = [
  'page_size',
  'page_layout',
  'page_margin',
  'page_background_color',

  'base_font_family',
  'base_font_size',
  'base_font_color',
  'base_font_style',
  'base_line_height',
  'base_text_align',
  'base_border_color',
  'base_border_width',
  'base_border_radius',

  'prose_margin_bottom',
  'block_margin_bottom',

  'heading_font_family',
  'heading_font_size',
  'heading_font_color',
  'heading_font_style',
  'heading_line_height',
  'heading_text_align',
  'heading_margin_top',
  'heading_margin_bottom',
  ...HEADING_LEVELS.flatMap((level) => [
    `heading_h${level}_font_family`,
    `heading_h${level}_font_size`,
    `heading_h${level}_font_color`,
    `heading_h${level}_font_style`,
    `heading_h${level}_line_height`,
    `heading_h${level}_text_align`,
    `heading_h${level}_margin_top`,
    `heading_h${level}_margin_bottom`,
  ]),

  'link_font_color',

  'codespan_font_family',
  'codespan_font_size',
  'codespan_font_color',
  'codespan_font_style',
  'codespan_line_height',
  'codespan_background_color',
  'codespan_border_color',
  'codespan_border_width',
  'codespan_border_radius',
  'codespan_border_offset',

  'kbd_font_family',
  'kbd_font_size',
  'kbd_font_color',
  'kbd_font_style',
  'kbd_line_height',
  'kbd_background_color',
  'kbd_border_color',
  'kbd_border_width',
  'kbd_border_radius',
  'kbd_border_offset',
  'kbd_separator',

  'button_font_family',
  'button_font_size',
  'button_font_color',
  'button_font_style',
  'button_line_height',
  'button_background_color',
  'button_border_color',
  'button_border_width',
  'button_border_radius',
  'button_border_offset',
  'button_content',

  'menu_font_style',
  'menu_caret_content',

  'mark_background_color',
  'mark_border_offset',

  'code_font_family',
  'code_font_size',
  'code_font_color',
  'code_font_style',
  'code_line_height',
  'code_background_color',
  'code_border_color',
  'code_border_width',
  'code_border_radius',
  'code_padding',

  'conum_font_family',
  'conum_font_size',
  'conum_font_color',
  'conum_font_style',
  'conum_line_height',

  'footnotes_font_family',
  'footnotes_font_size',
  'footnotes_font_color',
  'footnotes_font_style',
  'footnotes_line_height',
  'footnotes_item_spacing',

  'list_marker_font_color',
  'list_indent',
  'list_item_spacing',

  'callout_list_margin_top_after_code',

  'description_list_term_font_style',
  'description_list_term_spacing',
  'description_list_description_indent',

  'quote_font_family',
  'quote_font_size',
  'quote_font_color',
  'quote_font_style',
  'quote_line_height',
  'quote_background_color',
  'quote_border_color',
  'quote_border_width',
  'quote_border_radius',
  'quote_border_left_width',
  'quote_padding',
  'quote_cite_font_family',
  'quote_cite_font_size',
  'quote_cite_font_color',
  'quote_cite_font_style',
  'quote_cite_line_height',
  // No `verse_text_align`, and no alignment on the six other constructs that look as if they should
  // have one: see {@link UNREAD_TEXT_ALIGN_KEYS}, which is that whole class written down.
  'verse_font_family',
  'verse_font_size',
  'verse_font_color',
  'verse_font_style',
  'verse_line_height',
  'verse_background_color',
  'verse_border_color',
  'verse_border_width',
  'verse_border_radius',
  'verse_border_left_width',
  'verse_padding',
  'verse_cite_font_family',
  'verse_cite_font_size',
  'verse_cite_font_color',
  'verse_cite_font_style',
  'verse_cite_line_height',

  'sidebar_background_color',
  'sidebar_border_color',
  'sidebar_border_width',
  'sidebar_border_radius',
  'sidebar_padding',
  'sidebar_title_font_family',
  'sidebar_title_font_size',
  'sidebar_title_font_color',
  'sidebar_title_font_style',
  // `sidebar.title.line-height` is deliberately absent: `convert_sidebar` passes the heading's
  // leading to `ink_prose` explicitly, and that argument always wins, so the renderer never reads it.
  'sidebar_title_text_align',

  'example_background_color',
  'example_border_color',
  'example_border_width',
  'example_border_radius',
  'example_padding',

  'admonition_background_color',
  'admonition_column_rule_color',
  'admonition_column_rule_width',
  'admonition_padding',
  'admonition_label_font_style',
  'admonition_label_text_transform',
  'admonition_label_min_width',
  ...ADMONITION_TYPES.flatMap((type) => [
    `admonition_icon_${type}_stroke_color`,
    `admonition_icon_${type}_size`,
  ]),

  'image_align',

  'table_align',
  'table_background_color',
  'table_border_color',
  'table_border_width',
  'table_grid_color',
  'table_grid_width',
  'table_cell_padding',
  'table_head_background_color',
  'table_head_font_style',
  'table_head_border_bottom_width',
  'table_foot_background_color',
  'table_foot_font_color',
  'table_foot_font_family',
  'table_foot_font_size',
  'table_foot_font_style',
  'table_body_stripe_background_color',

  'toc_font_family',
  'toc_font_size',
  'toc_font_color',
  'toc_font_style',
  'toc_line_height',
  'toc_indent',
  'toc_title_font_family',
  'toc_title_font_size',
  'toc_title_font_color',
  'toc_title_font_style',
  'toc_title_text_align',

  'caption_font_family',
  'caption_font_size',
  'caption_font_color',
  'caption_font_style',
  'caption_line_height',
  'caption_text_align',
  'caption_align',
  'caption_margin_inside',
  'caption_margin_outside',

  'thematic_break_border_color',
  'thematic_break_border_style',
  'thematic_break_border_width',
  'thematic_break_padding',
];

/**
 * Every `*_text_align` key the CONVERTER reads, in this module's flat key space.
 *
 * Alignment is the one typography setting that is not a key every category has, and reading it as
 * though it were is a mistake that costs more than a wrong colour: it moves every line break inside
 * the construct. So the readers are enumerated from the gem rather than assumed, by walking every
 * `text_align` in `asciidoctor-pdf-2.3.24/lib` — the literal `@theme.<x>_text_align` reads and the
 * three dynamic ones. Read as a table, the chain is on the left and the line it is read at on the
 * right.
 *
 * ```
 *   `@theme[%(heading_h#{hlevel}_text_align)] || @theme.heading_text_align || @base_text_align`
 *                                                              converter.rb:653, 700 — headings
 *   `@theme[%(#{category_caption}_text_align)] || @theme.caption_text_align`
 *                                                              converter.rb:3166    — captions
 *   `@theme[%(role_#{role}_text_align)]`                       converter.rb:4459    — roles
 *   `@theme.base_text_align`                                   converter.rb:412
 *   `@theme.sidebar_title_text_align`                          converter.rb:1379
 *   `@theme.toc_title_text_align`                              converter.rb:3950
 *   `@theme.list_text_align`, `@theme.abstract_text_align`, `@theme.abstract_title_text_align`,
 *   `@theme.admonition_label_text_align`, `@theme.title_page_text_align`
 * ```
 *
 * The `<category>_caption_text_align` and `role_<n>_text_align` families are per-category and
 * per-role rather than fixed names, so they are not listed; nothing here claims one either.
 *
 * Held by a test asserting that every claimed key ending in `_text_align` is on this list, which is
 * what turns "this category surely has an alignment too" into a failure rather than a shipped one.
 */
export const RENDERER_TEXT_ALIGN_KEYS: readonly string[] = [
  'base_text_align',
  'heading_text_align',
  ...HEADING_LEVELS.map((level) => `heading_h${level}_text_align`),
  'abstract_text_align',
  'abstract_title_text_align',
  'admonition_label_text_align',
  'caption_text_align',
  'list_text_align',
  'sidebar_title_text_align',
  'title_page_text_align',
  'toc_title_text_align',
];

/**
 * The `*_text_align` keys a theme can write that reach NO reader in the renderer.
 *
 * Each of these was claimed, projected onto a `--print-<construct>-text-align` custom property and
 * applied by the Print stylesheet, and not one of them appears anywhere in the gem. That was measured
 * twice over: by grepping the whole of `asciidoctor-pdf-2.3.24/lib` for `text_align`, and by resolving
 * a theme writing `quote: {text-align: left}`, `code: {text-align: center}` and
 * `footnotes: {text-align: right}`, which came back `themeApplied: true` with no diagnostic and all
 * three values in the model. A theme adding `quote.text-align: left` therefore re-broke every line
 * of every quotation in the preview, against an export that justifies them at `@base_text_align`.
 *
 * Written down rather than merely deleted because the shape invites the mistake again: five of the
 * seven sit beside a `font_family`, a `font_size`, a `font_color`, a `font_style` and a
 * `line_height` that ARE all read, so the group looks incomplete without one. It is not. The readers
 * are named in {@link RENDERER_TEXT_ALIGN_KEYS}, and a test holds both lists against the claimed set.
 *
 * The list carries `verse_text_align` for a second reason as well: `convert_quote_or_verse` passes
 * `ink_prose` an alignment OUTRIGHT (`converter.rb:1350`), so even a key of that name could not have
 * won. The others have no reader at all.
 */
export const UNREAD_TEXT_ALIGN_KEYS: readonly string[] = [
  'button_text_align',
  'code_text_align',
  'codespan_text_align',
  'conum_text_align',
  'footnotes_text_align',
  'kbd_text_align',
  'quote_text_align',
  'verse_text_align',
];

/**
 * Keys this module NAMES in a diagnostic without reading them into the model.
 *
 * A diagnostic's `themeKey` is not "a key the model applies" — it is a word from this package's own
 * vocabulary, which is the property that lets the delivery layer print it as its own copy. Those two
 * were the same list until `extends` was reported by flat name, which put a key outside
 * {@link CLAIMED_THEME_KEYS} into the one field documented as never leaving that set: not a leak, since
 * `extends` is this module's word too, but a stated invariant with an exception in it, which is the
 * shape a real leak hides in. So the vocabulary is written down instead, and
 * {@link NAMED_THEME_KEYS} is what the invariant is now stated over.
 *
 * Nothing a DOCUMENT wrote may join this list. See `index.ts`'s `aboutKey`, which names a key only
 * when the model claims it and falls back to the location otherwise.
 */
export const UNMODELLED_NAMED_THEME_KEYS: readonly string[] = [
  // Reported when the document extends something other than the renderer's default theme.
  'extends',
  ...PAGE_IMAGE_KEYS,
];

/**
 * Every theme key this module may put in a diagnostic's `themeKey`, which is a closed set it wrote.
 *
 * Held by `hostile-theme.test.ts`, which reads back every field of every diagnostic a generated
 * corpus produces and asserts each named key is one of these.
 */
export const NAMED_THEME_KEYS: readonly string[] = [
  ...CLAIMED_THEME_KEYS,
  ...UNMODELLED_NAMED_THEME_KEYS,
];
