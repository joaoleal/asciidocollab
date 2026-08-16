/**
 * @file Parsing of the four value kinds an Asciidoctor-PDF theme carries, into typed values.
 *
 * This is the boundary Principle IX names: a theme document is untrusted text, and nothing beyond
 * this file ever sees a raw theme string. Every function here either returns a typed value —
 * a number of points, a six-hex-digit colour, a permitted keyword — or `undefined`, which the caller
 * turns into a rejection diagnostic and a fall back to the key's default. There is deliberately no
 * "pass it through unchanged" path, because that is the path a CSS injection would travel.
 *
 * Every length resolves to PDF points. No CSS unit is produced here: the model stays unit-free in
 * points and `apps/web` converts once, at its own boundary. Doing it per key instead would round in
 * dozens of places and drift from the PDF.
 */

/**
 * Points per unit, mirroring the converter's own `to_pt`. `em` is deliberately absent — it is
 * relative to a context font size rather than a fixed ratio, so it is handled separately.
 */
const POINTS_PER_UNIT: Readonly<Record<string, number>> = {
  pt: 1,
  in: 72,
  mm: 72 / 25.4,
  cm: 720 / 25.4,
  // The converter assumes a 96 dpi canvas for px, so a CSS pixel is three quarters of a point.
  px: 0.75,
  pc: 12,
};

/**
 * A number with an optional unit suffix, which is every literal length a theme may write.
 *
 * Digit runs are bounded and the input is trimmed before matching rather than absorbing surrounding
 * whitespace here: an unbounded quantifier either side of an alternation is what turns a hostile
 * theme value into quadratic backtracking, and a theme document is untrusted input.
 */
const MEASUREMENT_LITERAL = /^(-?(?:\d{1,20}(?:\.\d{1,20})?|\.\d{1,20}))(pt|in|mm|cm|px|pc|em|rem|%)?$/i;

/**
 * Six hexadecimal digits, which is the only shape a resolved colour ever takes.
 *
 * There is no `#` here on purpose. The loader strips one BEFORE the value is ever typed: its
 * pre-parse line substitution rewrites `font-color: "#1a4e8a"` to `font-color: '1a4e8a'`
 * (`theme_loader.rb:102`, ported in `parse-theme.ts`), so `to_color` sees six digits and never a
 * hash. A `#` that survives to here is one the substitution did NOT match — `v: &v "#1a4e8a"`
 * reached through an alias, say — and the renderer keeps it, truncating to `#1A4E8`, which prawn
 * then refuses outright. Measured against the vendored gem under ruby 3.3.3.
 */
const SIX_HEX_DIGITS = /^[\da-f]{6}$/i;

/** The one colour keyword the renderer recognises by name, tested exactly as it tests it. */
const TRANSPARENT = 'transparent';

/** A resolved colour: six upper-case hexadecimal digits, or the transparent keyword. */
export type Colour = string;

/** Four resolved edge lengths in points, in the renderer's top-right-bottom-left order. */
export interface MeasurementBox {
  /** Top edge, in points. */
  readonly top: number;
  /** Right edge, in points. */
  readonly right: number;
  /** Bottom edge, in points. */
  readonly bottom: number;
  /** Left edge, in points. */
  readonly left: number;
}

/**
 * What a relative length is measured against, when the theme writes one.
 *
 * The renderer resolves `em`, `rem` and `%` in exactly ONE place — `resolve_font_size`
 * (`converter.rb:4896-4907`) and prawn's `font_size` (`ext/prawn/extensions.rb:363-375`), both of
 * which take a FONT SIZE. Every other length reaches the page through `str_to_pt`
 * (`measurements.rb:20`) or through `expand_padding_value` (`ext/prawn/extensions.rb:614`), neither
 * of which knows those units at all: `str_to_pt` matches only `in|mm|cm|pt|px|pc` and falls through
 * to `String#to_f` otherwise, which takes the number and drops the suffix. `page: margin: 10%` is ten
 * points in the export, not a tenth of anything.
 *
 * So the two are different contexts rather than one, and a length key that is not a font size gets
 * neither field — its relative units are reproduced by dropping the suffix, which is what the
 * renderer does with them.
 */
export interface MeasurementContext {
  /**
   * The root font size, in points, that `rem` is relative to — the theme's `base.font-size`.
   *
   * Only ever set for a key whose value IS a font size. When absent, `rem` is unresolvable rather
   * than assumed.
   */
  readonly rootPt?: number;
  /**
   * The ENCLOSING font size, in points, that `em` and `%` are relative to.
   *
   * `resolve_font_size` measures `em` against `font_size` — whatever size the text being set is
   * already at — and only `rem` against the root. They are the same number for a construct the
   * renderer inks at body size and different for one it inks inside another, so a resolver that
   * treated `em` and `rem` alike would put `quote.cite.font-size: 0.8em` at eight tenths of the wrong
   * size. When absent, `em` and `%` are unresolvable: the enclosing size of an inline construct is
   * the size of whatever text it appears in, and guessing a base would produce a plausible wrong
   * number.
   */
  readonly enclosingPt?: number;
  /**
   * Whether the renderer reaches this key through `str_to_pt` rather than through a font-size path.
   *
   * Set for every length that is not a font size. A relative unit then resolves to its bare number
   * as points, reproducing `String#to_f`, rather than being rejected — the export accepts the value
   * and lays the page out with it, and a preview that rejected it would show a different page.
   */
  readonly literalPoints?: boolean;
}

/**
 * Convert a number and a unit suffix to points.
 *
 * @param value - The numeric part.
 * @param unit - The lower-cased unit suffix, or undefined for a bare number (already points).
 * @param context - What a relative unit is measured against.
 * @returns The length in points, or undefined when the unit is relative and has no base.
 */
function toPoints(value: number, unit: string | undefined, context: MeasurementContext): number | undefined {
  if (unit === undefined) return value;
  if (unit === 'em' || unit === 'rem' || unit === '%') {
    // `str_to_pt` never matches these, so `to_f` takes the number and the suffix is simply gone.
    if (context.literalPoints === true) return value;
    if (unit === 'rem') return context.rootPt === undefined ? undefined : value * context.rootPt;
    if (context.enclosingPt === undefined) return undefined;
    return unit === 'em' ? value * context.enclosingPt : (value / 100) * context.enclosingPt;
  }
  return POINTS_PER_UNIT[unit] === undefined ? undefined : value * POINTS_PER_UNIT[unit];
}

/**
 * Parse a resolved theme value into a length in points.
 *
 * Accepts a number (already points, as the renderer treats a bare value) or a literal with a unit.
 * A string that still holds an unevaluated expression, a variable reference, or anything else is
 * rejected rather than coerced — `Number('12px; }')` is `NaN`, but `parseFloat` would happily
 * return 12 and carry the rest of the string nowhere useful.
 *
 * @param value - The value after variable expansion and arithmetic.
 * @param context - What a relative unit is measured against.
 * @returns The length in points, or undefined when the value is not a length.
 */
export function parseMeasurement(value: unknown, context: MeasurementContext = {}): number | undefined {
  const magnitude = numberValue(value);
  if (magnitude !== undefined) return Number.isFinite(magnitude) ? magnitude : undefined;
  if (typeof value !== 'string') return undefined;
  const match = MEASUREMENT_LITERAL.exec(value.trim());
  if (match === null) return undefined;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return undefined;
  return toPoints(numeric, match[2]?.toLowerCase(), context);
}

/**
 * Parse a resolved theme value into four edge lengths, expanding the renderer's CSS-style shorthand.
 *
 * One value applies to every edge; two are vertical then horizontal; three are top, horizontal,
 * bottom; four are top, right, bottom, left. A longer array keeps its first four, which is what the
 * renderer does. Any edge that is not a length rejects the whole box — a partially-applied inset
 * would move the page column by an amount nothing chose.
 *
 * @param value - The value after variable expansion and arithmetic.
 * @param context - What a relative unit is measured against.
 * @returns The four edges in points, or undefined when any edge is not a length.
 */
export function parseMeasurementBox(
  value: unknown,
  context: MeasurementContext = {},
): MeasurementBox | undefined {
  if (!Array.isArray(value)) {
    const all = parseMeasurement(value, context);
    return all === undefined ? undefined : { top: all, right: all, bottom: all, left: all };
  }
  const edges: number[] = [];
  for (const entry of value.slice(0, 4)) {
    const edge = parseMeasurement(entry ?? 0, context);
    if (edge === undefined) return undefined;
    edges.push(edge);
  }
  switch (edges.length) {
    case 1: {
      return { top: edges[0], right: edges[0], bottom: edges[0], left: edges[0] };
    }
    case 2: {
      return { top: edges[0], right: edges[1], bottom: edges[0], left: edges[1] };
    }
    case 3: {
      return { top: edges[0], right: edges[1], bottom: edges[2], left: edges[1] };
    }
    case 4: {
      return { top: edges[0], right: edges[1], bottom: edges[2], left: edges[3] };
    }
    default: {
      return undefined;
    }
  }
}

/**
 * Ruby's `String#to_f`, which is what the renderer normalises a non-numeric CMYK channel with.
 *
 * It reads the longest leading float it can and answers zero where JavaScript answers `NaN`, and the
 * difference is a whole colour: `[a, a, a, a]` normalises to `[0, 0, 0, 0]` in the renderer and is
 * therefore WHITE, not a rejection.
 *
 * @param text - The channel as the document wrote it.
 * @returns The leading float, or zero where there is none.
 */
function rubyToFloat(text: string): number {
  const numeric = Number.parseFloat(text);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * A number the export spells differently from the way JavaScript spells it.
 *
 * ## Why the value alone is not enough
 *
 * `to_color` stringifies before it measures (`value.to_s`, `theme_loader.rb:311`) and a content
 * template is `val.to_s` outright (`:190`), so what a number CONTRIBUTES to a theme is its Ruby
 * spelling and not its magnitude. The two languages disagree about that spelling in three ways, each
 * measured against ruby 3.3.3:
 *
 * - A Float always writes a fractional digit. `1.0.to_s` is `"1.0"` — THREE characters, so
 *   `font_color: 1.0` takes the hexadecimal-shorthand branch of the length rule and is `11..00`,
 *   which prawn refuses and which stops the export. `String(1)` is `"1"`, padded to `000001` and
 *   inked. Same document, opposite outcomes.
 * - They leave fixed notation at different magnitudes and spell the exponent differently. Ruby leaves
 *   it above 10¹⁵ and below 10⁻⁴ and writes a sign and at least two digits — `1.0e+20`, `3.0e-07`;
 *   JavaScript leaves it at 10²¹ and 10⁻⁷ and writes `1e+21`, `3e-7`.
 * - An Integer is exact at any size. `10000000000000000000000.to_s` is twenty-three digits, whose
 *   first six are `100000` and ARE inked; the nearest double spells itself `1e+22`, which is not a
 *   colour at all and was refused here while the export printed the page.
 *
 * A JavaScript number carries none of that. `1.0` and `1` are one value, `-0.0` and `0` are one
 * value, and the digits past 2⁵³ are gone before the parser has a number to hand back at all.
 *
 * ## What is carried, and what is reconstructed
 *
 * The spelling is worked out ONCE, where the literal is still in view, and travels with the value —
 * so a `$reference` that reaches this number a hundred lines later spells it the way the export does.
 *
 * For an Integer nothing about Ruby's formatting is reproduced: the decimal digits come out of the
 * literal through `BigInt`, which is base conversion and has no version to be out of date with. For a
 * Float the DIGITS come from `Number.prototype.toExponential()`, which ECMA-262 requires to be the
 * shortest string that reads back as the same double — the same shortest-round-trip digits Ruby's own
 * `flo_to_s` emits — and only the LAYOUT around them is Ruby's. See {@link rubyFloatSpelling}.
 *
 * Carrying the document's own TEXT instead was measured and does not answer the question: Ruby
 * respells what it reads, so `1.00` is `"1.0"`, `1e20` is `"1.0e+20"`, `.5` is `"0.5"`, `0x10` is
 * `"16"` and `1_000` is `"1000"`. The written text says what the author typed; this says what the
 * export prints.
 *
 * ## Where one exists
 *
 * Only where the two spellings DIFFER — see {@link spelledFloat} and {@link spelledInteger}. Every
 * number JavaScript already spells as Ruby does stays an ordinary `number`, which is most of them and
 * all of the ones a real theme holds, so no reader of one changes. A reader that meets one of these
 * asks {@link numberValue} for the magnitude and {@link rubySpelling} for the text.
 *
 * A class and not a tagged object: a theme document can write any mapping it likes, including one
 * carrying whatever fields a tag would use, and `instanceof` is the one test a mapping cannot
 * impersonate. `toString` is Ruby's, so a value that reaches any remaining `String(…)` — an array
 * joined by the expansion, say — spells itself the export's way rather than as `[object Object]`.
 * There is deliberately no `valueOf`: a reader that wants the magnitude should ask for it, and
 * silent coercion is how a missed reader would go on looking right.
 */
export class RubyNumber {
  /** The magnitude, which is the nearest double exactly as every other number here is. */
  readonly value: number;

  /** What Ruby's `to_s` writes for it. */
  readonly spelling: string;

  /**
   * @param value - The magnitude.
   * @param spelling - Ruby's `to_s`.
   */
  constructor(value: number, spelling: string) {
    this.value = value;
    this.spelling = spelling;
  }

  /**
   * Ruby's `to_s`, so anything that stringifies this value gets the export's characters.
   *
   * @returns The spelling.
   */
  toString(): string {
    return this.spelling;
  }
}

/**
 * Ruby's `Float#to_s`, whose digits are the language's own and whose layout is `flo_to_s`'s.
 *
 * `ruby_dtoa` in mode 0 emits the shortest digit string that reads back as the same double, which is
 * exactly what ECMA-262 requires of `toExponential()` with no argument — so no digit generation is
 * modelled here and there is nothing in that half to drift. What IS modelled is the four layout rules
 * around those digits, every one of them measured against ruby 3.3.3 over 4,897 doubles spanning
 * 10⁻³²⁴ to 10³⁰⁸ (zero disagreements; plain `String(n)` disagrees on 1,477 of them):
 *
 * - Fixed notation always carries a fractional digit: `1.0`, `100000.0`, `-0.0`.
 * - Fixed notation is used while the decimal point sits at position 15 or less — `1e14` is
 *   `"100000000000000.0"` and `1e15` is `"1.0e+15"` — and, past that, while writing it fixed would
 *   not have to PAD with zeros. That second clause has exactly one member in the whole of the double
 *   range, seventeen digits with the point after sixteen: `1234567890123456.8` is written out where
 *   `9007199254740992.0` is `"9.007199254740992e+15"`. Swept across every point/digit-count pair from
 *   10¹² to 10²¹ to find it.
 * - Below the point, fixed notation is used while the point sits at -3 or later: `0.0001` is written
 *   out, `1e-5` is `"1.0e-05"`.
 * - An exponent carries its sign and at least two digits, and its mantissa always has a fractional
 *   digit: `1.0e+20`, `3.0e-07`, `5.0e-324`, `1.7976931348623157e+308`.
 *
 * @param value - Any double.
 * @returns The characters Ruby writes for it.
 */
export function rubyFloatSpelling(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  // `-0.0` is a Float Ruby writes with its sign and JavaScript does not, and `Math.abs` is the only
  // test that tells it from `0.0` at all.
  const negative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  if (magnitude === 0) return negative ? '-0.0' : '0.0';
  const [mantissa, exponent] = magnitude.toExponential().split('e');
  const digits = mantissa.replace('.', '');
  // Where the decimal point falls, counting from the left of the digits: `value = 0.digits × 10^point`.
  const point = Number(exponent) + 1;
  let text: string;
  if (point <= -4 || (point > MAX_FIXED_POINT && point >= digits.length)) {
    const power = point - 1;
    const sign = power < 0 ? '-' : '+';
    text = `${digits[0]}.${digits.slice(1) || '0'}e${sign}${String(Math.abs(power)).padStart(2, '0')}`;
  } else if (point <= 0) text = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) text = `${digits}${'0'.repeat(point - digits.length)}.0`;
  else text = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${text}` : text;
}

/** The last decimal-point position `flo_to_s` writes out unconditionally — `DBL_DIG`, measured. */
const MAX_FIXED_POINT = 15;

/**
 * A Float, carrying its spelling where JavaScript's differs from Ruby's.
 *
 * @param value - The double Psych's `Float()` produced.
 * @returns The number, or a {@link RubyNumber} where the export writes it differently.
 */
export function spelledFloat(value: number): number | RubyNumber {
  const spelling = rubyFloatSpelling(value);
  return spelling === String(value) ? value : new RubyNumber(value, spelling);
}

/**
 * An Integer, carrying its spelling where JavaScript's differs from Ruby's.
 *
 * Two things make them differ, and `exact` answers both: JavaScript writes anything from 10²¹ up in
 * exponent notation, and the double it holds has lost the low digits of anything past 2⁵³. A caller
 * that can read the literal passes what the literal DENOTES, which is what Ruby kept.
 *
 * @param value - The double this model holds for the integer.
 * @param exact - What the literal denotes, where the caller could work it out; the double's own
 *   integer value otherwise, which is the most that can be said for an integer this model reached by
 *   arithmetic rather than by reading digits.
 * @returns The number, or a {@link RubyNumber} where the export writes it differently.
 */
export function spelledInteger(value: number, exact?: bigint): number | RubyNumber {
  if (!Number.isInteger(value)) return value;
  const spelling = (exact ?? BigInt(value)).toString();
  return spelling === String(value) ? value : new RubyNumber(value, spelling);
}

/**
 * The magnitude a value denotes, which is the question every reader but a stringifying one asks.
 *
 * @param value - A resolved theme value.
 * @returns The number, or undefined where the value is not a number at all.
 */
export function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  return value instanceof RubyNumber ? value.value : undefined;
}

/**
 * What Ruby's `to_s` writes for a value, for the two kinds of number this model holds.
 *
 * @param value - A resolved theme value.
 * @returns The characters, or undefined where the value is not a number.
 */
export function rubySpelling(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  return value instanceof RubyNumber ? value.spelling : undefined;
}

/** The one length `to_color` neither pads nor cuts, which is what makes anything longer a loss. */
const COLOUR_LENGTH = 6;

/**
 * A stringified value reduced to the two things the length rule asks of it.
 *
 * The rule reads a value's LENGTH and then at most its first six characters, and never the rest — so
 * the rest is never built. That is a bound rather than a tidiness: a value is joined from elements the
 * document controls, and an alias may put the same forty-kilobyte string under a hundred of them.
 * Measured against the previous build, which joined whole: an 86 KB document builds a 480 MB string in
 * 288 ms on the thread the preview renders on, and 512 KB buys about six times that. Keeping six
 * characters and a count makes the same document 0.4 ms and no allocation at all, with the same
 * answer.
 */
interface SizedText {
  /** The first {@link COLOUR_LENGTH} characters, which is every character the rule can read. */
  head: string;
  /** How many characters there are in ALL, which is what chooses the rule's branch. */
  length: number;
}

/** A value that is already one string, measured for {@link sizeToSixCharacters}. */
function sized(text: string): SizedText {
  return { head: text.slice(0, COLOUR_LENGTH), length: text.length };
}

/**
 * Append one part of a joined value, keeping only what the length rule will read of it.
 *
 * @param text - The value built so far, extended in place.
 * @param part - The next element's characters.
 */
function appendSized(text: SizedText, part: string): void {
  if (text.head.length < COLOUR_LENGTH) text.head = (text.head + part).slice(0, COLOUR_LENGTH);
  text.length += part.length;
}

/**
 * Size a value to the renderer's six characters, which is the whole of `to_color`'s tail.
 *
 * `case value.length` (`theme_loader.rb:313-321`): six is taken as written, THREE is the hexadecimal
 * shorthand and is doubled per character, and every other length — one, two, four, five, or twenty —
 * is truncated to its first six and left-padded with zeros. One rule, applied to a string, and the
 * renderer reaches it for a number as well because it stringifies first.
 *
 * The three-digit branch is why `font-color: 123` is `112233` in the export and not `000123`, and the
 * truncating branch is why `1234567` is `123456` rather than a rejection.
 *
 * @param text - The value, stringified as the renderer stringifies it.
 * @returns Six characters, which are not necessarily six hexadecimal digits.
 */
function sizeToSixCharacters(text: SizedText): string {
  if (text.length === COLOUR_LENGTH) return text.head;
  if (text.length === 3) return [...text.head].map((digit) => digit + digit).join('');
  return text.head.padStart(COLOUR_LENGTH, '0');
}

/**
 * Ruby's `Integer(String)` with no base given, which is what a string colour channel goes through.
 *
 * `sprintf '%02X', e` converts a String argument with `Integer()`, and `Integer()` picks the base from
 * the PREFIX: `0x`/`0X` is hexadecimal, `0b`/`0B` binary, `0o`/`0O` and a bare leading zero octal,
 * `0d`/`0D` decimal. An underscore separates digits but may not lead, trail or double, and
 * surrounding whitespace is allowed. Nothing else is: `"128.5"`, `"1 0"` and `""` all raise.
 *
 * Validated against ruby 3.3.3 over every string of length four or less across the alphabet
 * `0 1 7 8 9 a f x b o d _ + - space tab .` — 88,740 strings, zero disagreements about which of them
 * `Integer()` accepts.
 *
 * Deliberately UNBOUNDED in the digit runs, where the rest of this file bounds them. A bound would
 * turn a forty-digit channel from "a number the export reads and then cannot ink" into "a number the
 * reader raises on", and those two have different outcomes — see {@link colourRefusedAtLoad}.
 * Each alternative is prefix-disambiguated and each repetition consumes at least one character with
 * no choice about how many, so there is nothing here for a hostile value to make backtrack.
 */
const RUBY_INTEGER_LITERAL =
  /^[ \t\n\v\f\r]*[+-]?(?:0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|0[dD]\d(?:_?\d)*|0[xX][\da-fA-F](?:_?[\da-fA-F])*|0(?:_?[0-7])*|[1-9](?:_?\d)*)[ \t\n\v\f\r]*$/;

/** The bases {@link RUBY_INTEGER_LITERAL} admits, keyed by the prefix letter that selects each. */
const RUBY_INTEGER_BASES: Readonly<Record<string, number>> = { b: 2, o: 8, d: 10, x: 16 };

/**
 * What one entry of an RGB array is worth to `sprintf '%02X'`, or nothing when it RAISES.
 *
 * The three kinds it converts are an Integer, a finite Float — truncated, so `128.5` is `80` — and a
 * String it can read with `Integer()`. Everything else raises: `nil`, `true` and `false` and any
 * collection raise `TypeError`, an infinity or a NaN raises `FloatDomainError`, and an unreadable
 * String raises `ArgumentError`. All measured against ruby 3.3.3.
 *
 * @param entry - One channel, exactly as the document wrote it.
 * @returns The integer the channel denotes, or undefined where the conversion raises.
 */
function rubyChannel(entry: unknown): number | undefined {
  // A Float and an Integer are both `::Numeric` to `%02X`, which truncates the one and takes the
  // other whole — so a channel asks the magnitude and never the spelling.
  const numeric = numberValue(entry);
  if (numeric !== undefined) return Number.isFinite(numeric) ? Math.trunc(numeric) : undefined;
  if (typeof entry !== 'string' || !RUBY_INTEGER_LITERAL.test(entry)) return undefined;
  const text = entry.trim();
  const negative = text.startsWith('-');
  const digits = text.replace(/^[+-]/, '').replaceAll('_', '');
  const base = RUBY_INTEGER_BASES[digits[1]?.toLowerCase() ?? ''];
  let magnitude: number;
  if (digits.startsWith('0') && base !== undefined) magnitude = Number.parseInt(digits.slice(2), base);
  else if (digits.startsWith('0') && digits.length > 1) magnitude = Number.parseInt(digits.slice(1), 8);
  else magnitude = Number(digits);
  return negative ? -magnitude : magnitude;
}

/**
 * Whether a colour value is one the export's THEME LOADER raises on, which fails the whole document.
 *
 * The distinction this draws is the one that decides how much of a theme survives a typo, and it is
 * a distinction about WHEN the failure happens rather than about how bad the value is.
 *
 * `to_color` runs at LOAD time — `process_entry`'s `key.end_with? '_color'` branch calls it while the
 * theme is being read (`theme_loader.rb:182-188`) — so a conversion that raises propagates out of
 * `ThemeLoader.load_file` into `load_theme`'s BARE rescue (`converter.rb:556`), which logs
 * `could not locate or load the pdf theme …; reverting to default theme` and prints the document with
 * the default theme. Measured against the vendored gem under ruby 3.3.3: `base: font_color: [a, 0, 0]`
 * throws away EVERY setting in the document and not just that one, and one mistyped channel is enough
 * to do it.
 *
 * Two shapes raise. An RGB array whose channel `sprintf '%02X'` will not convert — see
 * {@link rubyChannel} — and a CMYK array holding an infinity or a NaN, where the normalisation's own
 * `e == (int_e = e.to_i)` raises `FloatDomainError` (`theme_loader.rb:281`). A CMYK channel that is
 * not numeric at all does NOT raise: it is read with `to_f`, which answers zero for anything, so
 * `[a, a, a, a]` is white and `[nil, 0, 0, 0]` is too.
 *
 * An out-of-RANGE channel is a different case and stays a per-key refusal. `[300, 0, 0]` loads — it
 * is the string `12C0000` — and it is prawn that refuses it later, so the document did read, and
 * refusing the one key with a diagnostic is the honest reproduction of what happened at load. See
 * {@link colourFromRgb}, which is where that half lives.
 *
 * @param value - A colour key's value, after `$reference` expansion, as the loader sees it.
 * @returns Whether reading this value would have refused the whole document.
 */
export function colourRefusedAtLoad(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length === 3) return value.some((entry) => rubyChannel(entry) === undefined);
  if (value.length === 4) {
    return value.some((entry) => {
      const magnitude = numberValue(entry);
      return magnitude !== undefined && !Number.isFinite(magnitude);
    });
  }
  return false;
}

/**
 * The renderer's three-element RGB array: `value.map {|e| sprintf '%02X', e }.join`.
 *
 * `%02X` is not a range check. A channel of `128.5` is truncated to `128` and inked as `80` — the
 * export prints that page — while `300` formats as `12C` and `-1` as `..F`, both of which make the
 * joined value something other than six hexadecimal digits, and prawn then raises
 * `Unknown type of color` and the export produces NO PDF at all. So the arithmetic is reproduced and
 * the out-of-range channels are refused: a preview cannot show an export that does not exist, and
 * falling back to the key's default with a diagnostic is the only honest thing left.
 *
 * A string channel goes through `Integer()` rather than `to_f`, so it is read in whatever base its
 * prefix selects: measured against the vendored gem under ruby 3.3.3, `["0x10", 0, 0]` loads as
 * `100000`, `["010", 0, 0]` as `080000`, `["0b11", 0, 0]` as `030000` and `["1_0", 0, 0]` as
 * `0A0000`, and the export inks every one of those. They were refused here — reported as values the
 * export would not print, for four colours it prints — because this branch tested for a DECIMAL
 * integer alone. See {@link rubyChannel}.
 *
 * The channels this still answers `undefined` for are the out-of-range ones only. A channel the
 * conversion RAISES on is not a colour this could not read, it is a document the export threw away —
 * see {@link colourRefusedAtLoad}, which is asked first and asked at load.
 *
 * @param channels - The three entries, exactly as the document wrote them.
 * @returns Six hexadecimal digits, or undefined where the export would not print a page.
 */
function colourFromRgb(channels: readonly unknown[]): Colour | undefined {
  const digits: string[] = [];
  for (const entry of channels) {
    const channel = rubyChannel(entry);
    if (channel === undefined || channel < 0 || channel > 255) return undefined;
    digits.push(channel.toString(16).padStart(2, '0'));
  }
  return digits.join('').toUpperCase();
}

/**
 * The renderer's four-element CMYK array, for the two members of it that are exactly a grey.
 *
 * A CMYK colour has no faithful sRGB counterpart, so applying one would put a colour on screen that
 * the PDF does not contain — but `to_color` does not convert these two, it MATCHES them
 * (`theme_loader.rb:284-288`): a normalised `[0, 0, 0, 0]` returns the string `FFFFFF` and
 * `[100, 100, 100, 100]` returns `000000`, and those are the bytes in the exported page. Reproducing
 * a literal is not approximating anything, so they are honoured and every other CMYK array is still
 * refused and reported.
 *
 * The normalisation reaches further than the two literals suggest. A numeric channel at or below one
 * is a fraction and is multiplied by a hundred, so `[1, 1, 1, 1]` is black; a channel written as text
 * is not, and is read with `to_f` after a trailing `%` is dropped, so `['0%', '0%', '0%', '0%']` is
 * white and so — because `to_f` answers zero rather than failing — is `[a, a, a, a]`. All measured
 * against the vendored gem under ruby 3.3.3.
 *
 * A COLLECTION is a channel of zero, and is the one entry whose two `to_s` spellings differ enough to
 * matter: Ruby's opens with a bracket or a brace, so `to_f` finds no leading float and answers zero,
 * where JavaScript's would hand `[1]` back as the digit `1`. Measured, `base: font_color:` of
 * `[[1], 0, 0, 0]`, `[[1, 2], 0, 0, 0]` and `[{a: 1}, 0, 0, 0]` are all `FFFFFF` in the theme table —
 * white, not a channel of one — and `[[100], 100, 100, 100]` is the array `[0, 100, 100, 100]`, which
 * is not the black that `[100, 100, 100, 100]` matches.
 *
 * @param channels - The four entries, exactly as the document wrote them.
 * @returns White, black, or undefined for a CMYK colour this preview will not approximate.
 */
function colourFromCmyk(channels: readonly unknown[]): Colour | undefined {
  const normalised: number[] = [];
  for (const entry of channels) {
    // `::Numeric === e` is the branch's own test, and a Float spelled `1.0` is as numeric as a `1`.
    const magnitude = numberValue(entry);
    if (magnitude !== undefined) {
      if (!Number.isFinite(magnitude)) return undefined;
      normalised.push(magnitude > 1 ? magnitude : magnitude * 100);
    } else if (entry !== null && typeof entry === 'object') {
      normalised.push(0);
    } else {
      normalised.push(rubyToFloat(String(entry).replace(/%$/, '')));
    }
  }
  if (normalised.every((channel) => channel === 0)) return 'FFFFFF';
  if (normalised.every((channel) => channel === 100)) return '000000';
  return undefined;
}

/**
 * What `to_color` made of a value, and whether reaching six characters DISCARDED any of it.
 *
 * The two are reported together because they are one reading. `to_color` is total — it sizes anything
 * to six characters — so "this is the colour" and "this is not the whole of what you wrote" are
 * answers to different questions about the same value, and only the sizing knows both.
 */
export interface ColourReading {
  /** Six upper-case hexadecimal digits, the `transparent` keyword, or absent. */
  readonly colour?: Colour;
  /**
   * Whether characters were CUT to reach six.
   *
   * Only ever true beside a colour: a value cut to something that is not six hexadecimal digits is
   * refused outright, and its author is told that rather than told how it was shortened. Padding is
   * not truncation and is not reported here — `to_color 0` is `000000` and loses nothing.
   */
  readonly truncated: boolean;
}

/**
 * How deep {@link joinInto} follows a nested collection before refusing the value.
 *
 * The recursion is over a value the document controls, so the depth is a resource question and not
 * only a spelling one. Nesting does not have to be WRITTEN to be deep: the parser's own recursion
 * gives out somewhere above a thousand written levels, but a chain of aliases each wrapping the last
 * multiplies depth by a link per line, and twenty links of six hundred is 24 KB that resolves today
 * and nests TWELVE THOUSAND levels. A plain recursion over that exhausts the JavaScript stack, and a
 * reader that throws is not a reader that refuses.
 *
 * A thousand is past everything the EXPORT survives, so nothing above it has an export to reproduce.
 * `Array#join` recurses too: measured against ruby 3.3.3 with an 8 MB stack it joins a thousand levels
 * and raises `SystemStackError` before fifteen hundred, and the wasm build the preview renders
 * against has a smaller stack than that. A `SystemStackError` is not a `StandardError`, so the bare
 * rescue that turns a bad theme into the default theme (`converter.rb:556`) does not catch it and the
 * export writes no PDF at all — which is why a value deeper than this is refused rather than guessed
 * at, exactly as every nested value was refused before this rule was measured.
 */
const MAX_COLOUR_JOIN_DEPTH = 1000;

/**
 * What one element of a joined value is worth, for the elements that are not collections.
 *
 * `Array#join` converts an element it cannot join with `to_s`, and the four scalars Psych can build
 * spell themselves the same way here — `nil` is empty, `true` and `false` are their words, and a
 * String is itself. Measured against the vendored gem under ruby 3.3.3, `base: font_color: [[null], 2]`
 * is `"000002"` in the theme table and `[[true], 2]` is `"0TRUE2"`.
 *
 * A MAPPING is a brace and nothing else, which is not a shortening but the whole of what one can
 * contribute. `Hash#to_s` opens with `{`, which is not a hexadecimal digit, so the brace decides the
 * reading wherever it lands inside the six characters the rule reads — and where it lands outside
 * them, none of the rest of the mapping is read either. Both halves measured: `[12, {a: 1}]` is
 * `12{"A"` in the theme table, six characters prawn cannot ink, and `[123456, {a: 1}]` is `123456`,
 * which it inks. Reproducing `Hash#to_s` in full would be inventing Ruby's `inspect` for a value
 * nothing can read.
 *
 * @param entry - One element, which is not an Array.
 * @returns The characters it contributes to the join.
 */
function joinedElement(entry: unknown): string {
  if (entry === null || entry === undefined) return '';
  // Asked before the mapping test, because a number that carries its own spelling is an object here
  // and a `1.0` joined as `{` would be the same defect this reads it to avoid. See {@link RubyNumber}.
  const spelled = rubySpelling(entry);
  if (spelled !== undefined) return spelled;
  if (typeof entry === 'object') return '{';
  return String(entry);
}

/**
 * `Array#join` with no separator, which flattens a nested collection RECURSIVELY.
 *
 * Ruby joins a nested Array by joining IT, at any depth, where the JavaScript namesake stringifies it
 * with commas — so this walks rather than delegating. Measured against the vendored gem under ruby
 * 3.3.3, `base: font_color: [[1], 2]` is `"000012"` in the theme table, `[[[1]], 2]` is the same, and
 * `[[1, 2], [3]]` is `"112233"`: three characters, so the join's result takes the hexadecimal
 * shorthand branch of the length rule like any other three-character value.
 *
 * This was refused until it was measured, on the written ground that "a colour guessed from a
 * disagreement is worse than one refused". The measurement removed the disagreement — the rule is
 * simply a recursive join — and with it the reason, so the values are read. What is still refused is
 * a nesting no export survives; see {@link MAX_COLOUR_JOIN_DEPTH}.
 *
 * Bounded in WORK as well as in depth. Every element is visited once and contributes at most six
 * characters to what is kept, and the number of elements a document can denote is the parser's
 * expansion budget — 250,000 nodes, which is also what refuses the doubling alias bomb that would
 * otherwise make one written line denote a million.
 *
 * @param list - The value being joined, or a collection nested inside it.
 * @param text - The join so far, extended in place.
 * @param depth - How many collections this one is nested inside.
 * @returns Whether the whole value was joined, false where it is nested past what any export reads.
 */
function joinInto(list: readonly unknown[], text: SizedText, depth: number): boolean {
  if (depth > MAX_COLOUR_JOIN_DEPTH) return false;
  for (const entry of list) {
    if (Array.isArray(entry)) {
      if (!joinInto(entry, text, depth + 1)) return false;
    } else {
      appendSized(text, joinedElement(entry));
    }
  }
  return true;
}

/**
 * Read a resolved theme value as a colour, saying whether the reading discarded any of it.
 *
 * See {@link parseColour}, which is this without the second answer and is what almost every caller
 * wants. Split out for the one caller that has something to say about a value the export APPLIES and
 * does not apply whole: `font-color: "FF0000 /* x"` inks pure red in the exported page — measured,
 * `1.0 0.0 0.0 scn`, against `to_color`'s `(value.slice 0, 6)` — so refusing it would show a page the
 * export does not print, and accepting it in silence leaves an author looking at a colour they did
 * not write with nothing said about the rest of what they did.
 *
 * @param value - The value after variable expansion.
 * @returns The colour, and whether getting to it cut the value short.
 */
export function readColour(value: unknown): ColourReading {
  let text: SizedText;
  // Read once, before the branches, because it is both the test for a number and the whole of what
  // one is worth to `to_s` — see {@link RubyNumber}.
  const spelled = rubySpelling(value);
  if (Array.isArray(value)) {
    // The two array branches return a colour built from the CHANNELS rather than from any text, so
    // neither can lose characters and neither reaches the sizing below.
    if (value.length === 4) return reading(colourFromCmyk(value));
    if (value.length === 3) return reading(colourFromRgb(value));
    // "Nonsense array value; flatten to string" (`theme_loader.rb:296`), which then takes the same
    // length rule as any other string — so `[]` is black in the export and `[1, 2, 3, 4, 5]` is
    // `012345`. See {@link joinInto} for what a NESTED collection joins to.
    const joined: SizedText = { head: '', length: 0 };
    if (!joinInto(value, joined, 0)) return NOT_A_COLOUR;
    text = joined;
  } else if (typeof value === 'string') {
    // The keyword is tested in the String branch ALONE, which is where `to_color` tests it
    // (`when ::String … if value == 'transparent'`, `theme_loader.rb:299-300`). A list that happens
    // to join to the same eleven characters never reaches that test: the list branch joins and falls
    // THROUGH to the length rule below. Measured against the vendored gem under ruby 3.3.3,
    // `base: border_color: [transparent]` is `"TRANSP"` in the theme table — six characters prawn
    // cannot ink — and so are `['transparent']` and `[transp, arent]`.
    if (value === TRANSPARENT) return { colour: TRANSPARENT, truncated: false };
    text = sized(value);
  } else if (spelled === undefined) {
    return NOT_A_COLOUR;
  } else {
    // `to_s` and then the same length rule as any other string, so the SPELLING is the whole of what
    // a number is worth here: `1.0` is three characters and doubles like `123`, where `1` is one and
    // pads like `000001`.
    if (!Number.isFinite(numberValue(value))) return NOT_A_COLOUR;
    text = sized(spelled);
  }
  const resolved = sizeToSixCharacters(text);
  if (!SIX_HEX_DIGITS.test(resolved)) return NOT_A_COLOUR;
  return { colour: resolved.toUpperCase(), truncated: text.length > COLOUR_LENGTH };
}

/** A value that is not a colour at all, which is therefore not a colour cut short either. */
const NOT_A_COLOUR: ColourReading = { truncated: false };

/** A colour built from channels rather than from text, which cannot have lost any of the value. */
function reading(colour: Colour | undefined): ColourReading {
  return colour === undefined ? NOT_A_COLOUR : { colour, truncated: false };
}

/**
 * Parse a resolved theme value into a colour, as the renderer's `to_color` types one.
 *
 * ## The gate, and why it is the whole safety argument
 *
 * `to_color` (`theme_loader.rb:267-322`) is total: it answers a six-character string for ANYTHING,
 * and six characters is not a colour. `red` becomes `RREEDD` and `Transparent` becomes `TRANSP`, and
 * prawn refuses both with `Unknown type of color` — the export raises and writes no PDF. So the
 * renderer's arithmetic is reproduced exactly and then GATED on six hexadecimal digits, which splits
 * every value into the two cases that actually exist: one the export prints, reproduced faithfully,
 * and one the export cannot print at all, refused and reported so the author is told.
 *
 * The gate is also what keeps this function inside the file's own rule. Nothing it returns is the
 * document's text: it is six hexadecimal digits, the `transparent` keyword, or nothing. A value that
 * would close a CSS declaration cannot survive it — `FF0000; } body { display: none` truncates to
 * `FF0000`, which is what the export inks, and there is no path by which the rest of that string
 * reaches a stylesheet.
 *
 * `transparent` is matched exactly, with no case folding and no trimming, because that is the test
 * the renderer makes (`value == 'transparent'`). `Transparent` is NOT a colour with different
 * capitals; it is a value that stops the export, and treating it as transparent would show a page
 * nobody can export while saying nothing.
 *
 * @param value - The value after variable expansion.
 * @returns Six upper-case hexadecimal digits, the `transparent` keyword, or undefined.
 */
export function parseColour(value: unknown): Colour | undefined {
  return readColour(value).colour;
}

/**
 * Whether the loader hands `to_color` this key's elements ONE AT A TIME rather than the value whole.
 *
 * The test is the loader's own — `key == 'table_border_color' ? ::Array === val : (key ==
 * 'table_grid_color' && ::Array === val && val.size == 2)` (`theme_loader.rb:184`) — and those two
 * keys are the whole of it. Every other key ending in `_color` converts its value in one piece,
 * including the ones that look like these: measured against the vendored gem under ruby 3.3.3,
 * `thematic_break: border_color: [1, 2]` is `"000012"` in the theme table and so is
 * `admonition_icon_tip: stroke_color: [1, 2]`, where `table: border_color: [1, 2]` is
 * `["000001", "000002"]`.
 *
 * It decides what a list MEANS, which is why the same shape reads two ways. Under these two keys a
 * list is a SHORTHAND — four sides for the border, two axes for the grid, expanded by
 * `expand_rect_values`/`expand_grid_values` (`ext/prawn/extensions.rb:638-679`) — so `[a, 0, 0]` is
 * three colours read separately and raises nothing, while the same value under `base: font_color` is
 * one RGB triple and throws the whole document away.
 *
 * Asked of the value the document WROTE, before any `$reference` in it is expanded. `::Array === val`
 * tests `process_entry`'s argument, and the expansion happens inside the branch it chooses — so a
 * list reached through a lone reference is not a list here at all. Measured against the vendored gem
 * under ruby 3.3.3 over `extends: default`:
 *
 * - `table: border_color: [1, 2]` is `["000001", "000002"]`, and `v: [1, 2]` with
 *   `table: border_color: $v` is `"000012"` — the same list, converted whole.
 * - `table: border_color: [a, 0, 0]` is three colours and loads; through a reference it is one RGB
 *   triple and raises `ArgumentError`, throwing the document away.
 * - `table: border_color: [[a, 0, 0], 2]` is the other way round: written out it raises, and through
 *   a reference it is `"00A002"`.
 *
 * A list of references IS a list — `[$a, $b]` is `["000001", "000002"]` — and so is one a YAML alias
 * carried in, because the alias is resolved before the loader ever sees the value.
 *
 * @param key - The flat theme key.
 * @param value - The key's value exactly as the document wrote it, before expansion.
 * @returns Whether the key's elements are colours in their own right.
 */
export function readsColoursPerElement(key: string, value: unknown): value is readonly unknown[] {
  if (key === 'table_border_color') return Array.isArray(value);
  return key === 'table_grid_color' && Array.isArray(value) && value.length === 2;
}

/**
 * What the loader STORES for one element of a {@link readsColoursPerElement} list.
 *
 * `to_color` is total and its answer goes into the theme table as it is, so the cascade a later
 * `$reference` reads — and the side an appearance shows — is the CONVERTED element, not the text the
 * document wrote. Measured against the vendored gem under ruby 3.3.3, `table: border_color: [1, 2]`
 * is `["000001", "000002"]` in the theme table: converting first and joining afterwards is the whole
 * difference between the top border being `000001` and being `000012`.
 *
 * Three answers are the export's own value and are given as such: the gem's `nil`, written `null`
 * here, for an element the document left empty; the `transparent` keyword; and six upper-case
 * hexadecimal digits. Everything else `to_color` makes is a value prawn refuses with
 * `Unknown type of color` — `RREEDD` for `red`, `00TRUE` for a boolean, `12C0000` for an
 * out-of-range RGB triple — or a CMYK array this preview will not approximate. There is no colour to
 * store for those, and no reader here accepts one, so the element is left exactly as the document
 * wrote it: the side is refused and its author told, which is what {@link parseColour} already does
 * for the same values under any other colour key.
 *
 * @param value - One element, with its `$references` already expanded.
 * @returns The colour the export stored, or the element unchanged where that colour is unpaintable.
 */
export function loadedColour(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return readColour(value).colour ?? value;
}

/**
 * The lists this module has already converted, so nothing converts one twice.
 *
 * The renderer has the same marker and keeps it for the same reason: `to_color` opens with
 * `when ColorValue # already converted` and `CMYKColorValue` exists to "prevent normalizing CMYK
 * value more than once" (`theme_loader.rb:26-46, 267-271`). The gem gets the distinction for free
 * because it converts as it reads — a `table_border_color` holding an Array in the gem's theme table
 * is ALWAYS a shorthand for four sides, since anything the whole-value branch converted is a String
 * by then. This module converts where values are read, so the two cases arrive at a reader looking
 * alike, and the marker is what tells them apart:
 *
 * - `table: border_color: [1, 2]` is a shorthand, stored `["000001", "000002"]`, and paints `000001`.
 * - `v: [1, 2]` with `table: border_color: $v` is ONE colour — measured, `"000012"` in the gem's
 *   theme table — because the loader chose its branch before the reference was expanded.
 *
 * A WeakSet rather than a wrapper, because the list has to stay an ordinary array: a later
 * `$table_border_color` joins it exactly as `Array#join` would, and a wrapper would have changed what
 * every other reader sees to serve one of them. Weak, so a resolution's lists are collected with the
 * resolution — this runs per keystroke.
 */
const CONVERTED_SIDE_COLOURS = new WeakSet<readonly unknown[]>();

/**
 * Convert a {@link readsColoursPerElement} list as the loader does, and mark it converted.
 *
 * @param list - The list the document wrote, with its `$references` already expanded.
 * @returns The colours the export stored, one per side.
 */
export function loadedColourList(list: readonly unknown[]): readonly unknown[] {
  const converted = list.map((element) => loadedColour(element));
  CONVERTED_SIDE_COLOURS.add(converted);
  return converted;
}

/**
 * Whether a stored value is a list of SIDES rather than one colour written as a list.
 *
 * See {@link CONVERTED_SIDE_COLOURS} for why the shape cannot answer this on its own.
 *
 * @param value - A value the cascade holds.
 * @returns Whether {@link parseSideColour} is the reader for it.
 */
export function isSideColourList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && CONVERTED_SIDE_COLOURS.has(value);
}

/**
 * The one colour an appearance shows for a {@link readsColoursPerElement} list, which is its FIRST.
 *
 * A list under these keys is a shorthand for four sides or two axes, and this style paints one
 * border. `expand_rect_values` puts element 0 at the TOP whatever the list's length
 * (`ext/prawn/extensions.rb:659-678`) and `expand_grid_values` puts it on the horizontal rules, so
 * the first element is the one a reader that shows a single colour should show. Measured against the
 * vendored gem under ruby 3.3.3: `table: border_color: [1, 2]` inks the top border `000001`.
 *
 * An element written as `null` is not a missing colour but a REQUEST for the expansion's own
 * default, which the converter passes as `transparent` (`converter.rb:2244`) — so
 * `[null, 2]` draws no top border rather than the `000002` a join would have found there.
 *
 * The elements have already been through {@link loadedColour}, so what is accepted here is what
 * `to_color` produced and NOT what `to_color` would make of it a second time: the length rule must
 * not run again. `12C0000` is seven characters and prawn refuses it; sizing it to six here would
 * paint a border the export never draws.
 *
 * An EMPTY list is not a shorthand for anything — `[].slice(0, 4).map` expands to no sides at all,
 * and prawn-table's own `['000000'] * 4` stands (`prawn-table/cell.rb:216`) — so it is left to
 * {@link parseColour}, whose join answers that same black. A value that is not a list at all reaches
 * this only as a default the cascade fell back to, and is read the ordinary way.
 *
 * @param value - The key's stored value, after {@link loadedColour} converted its elements.
 * @returns The first side's colour, or undefined where the export paints no page.
 */
export function parseSideColour(value: unknown): Colour | undefined {
  if (!Array.isArray(value) || value.length === 0) return parseColour(value);
  const side: unknown = value[0];
  if (side === null || side === undefined) return TRANSPARENT;
  if (side === TRANSPARENT) return TRANSPARENT;
  return typeof side === 'string' && SIX_HEX_DIGITS.test(side) ? side.toUpperCase() : undefined;
}

/** Fold a keyword onto one spelling, since the renderer's own sets mix `_` and `-`. */
function normaliseKeyword(word: string): string {
  return word.trim().toLowerCase().replaceAll('_', '-');
}

/**
 * Parse a resolved theme value into one of a descriptor's permitted keywords.
 *
 * Compared case-insensitively and with `_`/`-` treated alike, because the renderer's own keyword
 * sets mix the two (`bold_italic` beside `line-through`) and a theme may write either.
 *
 * @param value - The value after variable expansion.
 * @param permitted - The words the renderer accepts for this key.
 * @returns The matching permitted word, exactly as the descriptor spells it, or undefined.
 */
export function parseKeyword(value: unknown, permitted: readonly string[]): string | undefined {
  if (typeof value !== 'string') return undefined;
  const wanted = normaliseKeyword(value);
  return permitted.find((word) => normaliseKeyword(word) === wanted);
}

/**
 * Parse a resolved theme value into a plain number, for keys that are ratios rather than lengths.
 *
 * Line height is the one that matters: `1.25` is a multiplier, and reading it as a length would
 * silently make every line 1.25 points tall.
 *
 * @param value - The value after variable expansion and arithmetic.
 * @returns The number, or undefined when the value is not one.
 */
export function parseNumber(value: unknown): number | undefined {
  const magnitude = numberValue(value);
  if (magnitude !== undefined) return Number.isFinite(magnitude) ? magnitude : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return undefined;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * The longest family name this parser admits, and therefore the longest one anything downstream of it
 * can ever be handed.
 *
 * Exported because a consumer that DERIVES a name from a family — the Print preview registers each
 * file a second time under a name of its own, to carry the renderer's metrics — has to allow for this
 * one plus whatever it adds. Two independently-written budgets disagreed by exactly that suffix: a
 * family of 51 to 64 characters was emitted as a family and dropped as a metric name, and the
 * stylesheet's fallback then set the construct in a face belonging to another family altogether.
 */
export const MAX_FONT_FAMILY_LENGTH = 64;

/**
 * Parse a resolved theme value into a font family name.
 *
 * A family name is author text that reaches CSS, so it is bounded rather than passed through:
 * letters, digits, spaces and the few punctuation marks real family names carry (`M+ 1mn`,
 * `Noto Serif`, `DejaVu Sans Mono`). Anything holding a quote, a semicolon, a brace or a backslash
 * is rejected — those are the characters that would end a CSS declaration.
 *
 * @param value - The value after variable expansion.
 * @returns The family name, or undefined when it is not one this preview will emit.
 */
export function parseFontFamily(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_FONT_FAMILY_LENGTH) return undefined;
  return /^[\w +.-]+$/.test(trimmed) ? trimmed : undefined;
}
