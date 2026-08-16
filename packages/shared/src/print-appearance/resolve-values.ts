/**
 * @file `$variable` expansion and the arithmetic the renderer's own theme cascade performs.
 *
 * The renderer's default theme is not a table of literals. It is full of `round($base_font_size *
 * 1.25)`, `$base_line_height_length / 10.5`, `[$vertical_rhythm / 3.0, $horizontal_rhythm, …]` and
 * bare `$refs`. A resolver that read keys literally would return the string `$base_font_size_large`
 * as a font size and look like it worked until a real theme was loaded.
 *
 * Only the forms the renderer's own theme and this repository's fixtures actually use are supported:
 * `+ - * / ^`, `round()`/`floor()`/`ceil()`, and the unit suffixes its `to_pt` knows. Anything else
 * is left exactly as written, which makes it an unparseable value downstream — rejected and reported
 * rather than guessed at. Guessing is how a preview comes to disagree with the document it previews.
 */

import { DEPRECATED_THEME_CATEGORIES, DEPRECATED_THEME_KEYS } from './deprecated-keys.generated';
import {
  colourRefusedAtLoad,
  loadedColourList,
  numberValue,
  readsColoursPerElement,
  RubyNumber,
  rubySpelling,
} from './units';

/** A variable reference the document made that named no setting. */
export interface UnresolvedReference {
  /** The flat key whose value holds the dangling reference. */
  readonly key: string;
  /** The reference exactly as the document wrote it, `$like_this`. */
  readonly reference: string;
}

/** A value whose `$reference` expansion grew past what this resolver will build. */
export interface OversizedValue {
  /** The flat key whose value could not be expanded. */
  readonly key: string;
}

/**
 * A whole value that is one variable reference and nothing else.
 *
 * Case-SENSITIVE, because `LoneVariableRx` is `/^\$([a-z0-9_-]+)$/` (`theme_loader.rb:22`) and carries
 * no `i`. See {@link VARIABLE}.
 */
const LONE_VARIABLE = /^\$([\da-z_-]+)$/;

/**
 * Any variable reference inside a larger expression.
 *
 * `VariableRx` is `/\$([a-z0-9_-]+)/` (`theme_loader.rb:21`), and the missing `i` is not an oversight
 * in the gem — it is what an upper-case reference MEANS there. `$Brand` matches nothing, so `gsub`
 * leaves the six characters where they are and `resolve_var` is never reached, which is also why
 * nothing warns about it. Measured against the vendored gem under ruby 3.3.3,
 * `brand: 2A5DB0` with `font_color: $Brand` exports the literal `"$BRAND"` — `to_color` upper-casing
 * the text it could not read — while the preview, matching case-insensitively, painted `2A5DB0`.
 */
const VARIABLE = /\$([\da-z_-]+)/g;

/** A length with a unit, bounded so only a whole term is converted — not a digit inside a word. */
const INSET_MEASUREMENT = /(?<=^| |\()(-?\d+(?:\.\d+)?)(in|mm|cm|pt|px|pc)(?=$| |\))/g;

/** Cheap test for whether a string holds any unit at all, mirroring the renderer's own guard. */
const HAS_MEASUREMENT = /\d(?:in|mm|cm|pt|px|pc)/;

/** A number at exactly this position — sticky, so it scans forward and never backtracks. */
const NUMBER_AT = /-?\d+(?:\.\d+)?/y;

/** The higher-precedence operators, reduced before the additive ones. */
const MULTIPLICATIVE = '*/^';

/** The additive operators. */
const ADDITIVE = '+-';

/** A whole expression wrapped in one of the renderer's three rounding functions. */
const PRECISION_FUNCTION = /^(round|floor|ceil)\((.*)\)$/s;

/** Points per unit, matching the renderer's `to_pt`. */
const POINTS_PER_UNIT: Readonly<Record<string, number>> = {
  pt: 1,
  in: 72,
  mm: 72 / 25.4,
  cm: 720 / 25.4,
  px: 0.75,
  pc: 12,
};

/**
 * The settings whose padding the renderer rewrites for themes written before it had smart margins:
 * a zero or negative bottom edge under a non-negative top edge is replaced by the top edge.
 */
const PADDING_BOTTOM_HACK_KEYS = new Set([
  'example_padding',
  'quote_padding',
  'sidebar_padding',
  'verse_padding',
]);

/**
 * The most one setting's value may grow to as its `$references` are expanded.
 *
 * `$a $a` doubles a string per level of indirection, so twenty-six such levels — under 400 bytes of
 * theme text — reach the platform's own maximum string length and THROW, on the thread that renders
 * the preview. The renderer has the same shape (`expand_vars` is a `gsub` too) and simply gets slower;
 * this resolver has to stay total, so the growth is bounded and the key is reported instead.
 *
 * Four kilobytes is orders of magnitude above any real theme value — the longest the renderer's own
 * default theme resolves to is a running-content template of a few dozen characters — so nothing an
 * author would write can reach it.
 *
 * The bound is on the ENTRY, not on each string inside it. A value may be an array, and an array
 * whose every element expands to the cap is a value the cap did not bound.
 */
const MAX_EXPANDED_VALUE_LENGTH = 4096;

/**
 * The most one cascade may expand in total, across every value it resolves.
 *
 * The per-value bound alone is not enough: a theme document may hold tens of thousands of settings,
 * and bounding each of them individually still leaves their sum unbounded. This is what makes the
 * work the whole cascade can be made to do a function of the document's size rather than of what it
 * says. Sixteen times the largest theme document that is read at all.
 */
const MAX_EXPANSION_BUDGET = 8 * 1024 * 1024;

/**
 * How deeply a theme value may nest before the cascade refuses to carry it.
 *
 * Length is not the only way a small document denotes a large structure. A flow sequence nests one
 * level per character, and a chain of `k1: [$k0]` lines nests one level per LINE — and a nested array
 * costs almost nothing to measure while costing a stack frame per level to print, because
 * `String(array)` is `join` calling `toString` calling `join`. A value 4,000 deep therefore passed a
 * bound counted in characters and then overflowed the stack on the way to text.
 *
 * A theme value is a scalar or a flat list of them — `padding: [12, 24, 12, 24]` is the deepest shape
 * the renderer's own default theme contains. Thirty-two is far past anything an author writes and far
 * short of anything a stack notices.
 */
const MAX_VALUE_DEPTH = 32;

/**
 * The most distinct dangling references one cascade collects before it stops writing them down.
 *
 * The expansion budget is counted in CHARACTERS OF VALUE, and a dangling reference is not paid for in
 * that currency. `$q ` is three characters of theme and buys a `{ key, reference }` record of about
 * seventy bytes — a twenty-fivefold amplification of a resource nothing was counting — so the eight
 * megabytes of expansion a resolution may perform bought roughly 2.8 million records. One anchored
 * 4 KB value packed with `$q` and aliased from two thousand settings is 22,993 bytes of theme and
 * measured 1,229 ms and 304 MB of heap, against 373 ms and 11 MB for the identical document with `$q`
 * defined. The list saturates, so it was bounded — by a bound four orders of magnitude above anything
 * that reads it, on the thread that renders the preview, per keystroke.
 *
 * What reads it wants fifty rows and a count of the rest (`MAX_REPORTED_SETTINGS`), so this is an
 * order of magnitude above what any caller can show. It is a cap on DISTINCT records, deduplicated as
 * they are collected, which is the same equivalence the consumer deduplicates by — so for every
 * document below the cap the reported list is exactly what it was, and only a document naming five
 * hundred distinct dangling references in five hundred distinct settings sees the count saturate.
 */
const MAX_COLLECTED_UNRESOLVED = 512;

/** What an expansion that would exceed its bound produces, so the caller can account for it. */
const OVERSIZED = Symbol('oversized-theme-value');

/**
 * What a `-$reference` the loader cannot negate produces, so the caller can refuse the document.
 *
 * `Numeric === (val = resolve_var vars, negated_expr, $1) ? -val : '-' + val`
 * (`theme_loader.rb:207`). The false branch is `String#+`, which takes a String and NOTHING else: a
 * value that is neither Numeric nor String raises `TypeError: no implicit conversion of … into
 * String` out of `expand_vars`, out of `ThemeLoader.load`, and into `load_theme`'s bare rescue
 * (`converter.rb:556`) — so the export logs *could not locate or load the pdf theme …* and prints the
 * whole document with the DEFAULT theme.
 *
 * It is a different currency from {@link OVERSIZED}, and that is why it is a second sentinel rather
 * than a widening of the first. `OVERSIZED` means *this resolver declined to build a value the export
 * builds*, and costs the key its own setting. This means *the export built nothing at all*, and costs
 * the document.
 *
 * Measured against the vendored gem under ruby 3.3.3, over every value shape a reference can name and
 * every position a value can be written in. `-$v` raises for `nil`, `true`, `false` and an Array —
 * empty, flat or nested — and does not raise for an Integer, a Float, a String, or a name nothing
 * defines (`resolve_var` hands back the reference TEXT, which is a String). The gsub path never
 * raises at all, because its block result is `to_s`'d: `--$v`, `a-$v` and `-$v b` all load, since
 * `expand_vars` reaches the negation branch only when the `$` is at index 1 under a leading `-` and
 * the remainder is a whole lone reference.
 *
 * The position does not narrow it either. It raises under an ordinary key, under a key this module
 * claims, under a `_color` key, under a `_content` key (whose `val.to_s` converts the value HOLDING
 * the reference, not the value it names), inside a padding list, inside any array element, under a
 * deprecated key, inside an admonition icon's sub-mapping, in a `font.catalog` path — including the
 * `'*'` spelling — and in a `font.fallbacks` name. All measured. The preview applied every one of
 * them and reported nothing.
 */
export const NEGATION_REFUSED = Symbol('negated-theme-value-the-loader-refuses');

/** How much expansion one cascade has left. */
export interface ExpansionBudget {
  /** Characters still available across the whole cascade. */
  remaining: number;
  /** Characters still available for the one entry being resolved. Reset per entry. */
  perEntry: number;
}

/**
 * One resolution's whole allowance, to be threaded through everything that resolution expands.
 *
 * A budget is a property of the RESOLUTION, not of any one call, and minting one inside a function
 * that a loop calls is the same as having no global bound at all — which is exactly what
 * {@link expandThemeVariables} did, once per style path and once per fallback. Handing it out from
 * here, and requiring it as an argument, is what makes forgetting to thread it a type error rather
 * than a silent return to the unbounded sum {@link MAX_EXPANSION_BUDGET} exists to prevent.
 *
 * @returns A fresh allowance for one resolution.
 */
export function createExpansionBudget(): ExpansionBudget {
  return { remaining: MAX_EXPANSION_BUDGET, perEntry: MAX_EXPANDED_VALUE_LENGTH };
}

/**
 * Charge a materialisation against both bounds.
 *
 * @param budget - The cascade's remaining allowance.
 * @param amount - Characters about to be materialised.
 * @returns Whether the allowance covered it.
 */
function charge(budget: ExpansionBudget, amount: number): boolean {
  budget.remaining -= amount;
  budget.perEntry -= amount;
  return budget.remaining >= 0 && budget.perEntry >= 0;
}

/**
 * How many characters a resolved value would occupy as text, giving up once it passes `limit`.
 *
 * This is what has to exist for the bound to mean anything, and its absence is what made a 512-byte
 * theme document throw. A value the cascade has already resolved may be an ARRAY, and a lone `$ref`
 * to one used to be handed back by reference: `k2: [$k1, $k1]` is then not a copy of `k1` but two
 * pointers to it, so a chain of such lines is a DAG with 2^n leaves and only n lines of text. The
 * budget was charged for the text it was written from, and nothing was charged for what it denoted —
 * so the first thing that turned it into a string (`String(value)`, an `Array#join` over the whole
 * DAG) did 2^n characters of work and then threw `RangeError: Invalid string length`.
 *
 * Measuring first is what makes the bound apply BEFORE the string exists. It is affordable because
 * every element costs at least one character, so a walk that stops at `limit` takes at most `limit`
 * steps whatever the structure behind it — including a shared one.
 *
 * @param value - A resolved value.
 * @param limit - Stop as soon as the count passes this.
 * @param depth - How far inside the value this call is.
 * @returns The count, or a value greater than `limit` when it was not reached.
 */
function measureValue(value: unknown, limit: number, depth = 0): number {
  if (!Array.isArray(value)) return String(value).length;
  // Too deep to print at all, whatever it would print as — see {@link MAX_VALUE_DEPTH}. Reported as
  // over budget, because from the caller's side it is the same answer: this cannot be materialised.
  if (depth >= MAX_VALUE_DEPTH) return limit + 1;
  // One separator per element — `join` writes one fewer, so this is an upper bound on the text.
  let total = value.length;
  for (const entry of value) {
    if (total > limit) return total;
    total += measureValue(entry, limit - total, depth + 1);
  }
  return total;
}

/**
 * Charge for a value's text and hand it back, or refuse when it does not fit.
 *
 * @param value - The resolved value a reference named.
 * @param budget - The cascade's remaining allowance.
 * @returns The value, or {@link OVERSIZED} when materialising it would exceed the bound.
 */
function chargeResolved(value: unknown, budget: ExpansionBudget): unknown {
  const allowance = Math.min(budget.perEntry, budget.remaining);
  if (allowance < 0) return OVERSIZED;
  const size = measureValue(value, allowance);
  return charge(budget, size) ? value : OVERSIZED;
}

/**
 * Ruby's `String#to_f`: the numeric prefix, or zero when there is none.
 *
 * @param text - The string to read.
 * @returns The leading number, or zero.
 */
function rubyToFloat(text: string): number {
  const match = /^\s*[+-]?(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)/i.exec(text);
  return match === null ? 0 : Number(match[0]);
}

/**
 * Ruby's `String#to_i`: the leading integer, or zero when there is none.
 *
 * @param text - The string to read.
 * @returns The leading integer, or zero.
 */
function rubyToInteger(text: string): number {
  const match = /^\s*[+-]?\d+/.exec(text);
  return match === null ? 0 : Number.parseInt(match[0], 10);
}

/**
 * Round half away from zero, which is what the renderer's `Float#round` does.
 *
 * The platform's own rounding breaks ties toward positive infinity, so `-0.5` differs. Negative
 * lengths are real here — `callout_list.margin-top-after-code` is one — so the difference is not
 * hypothetical.
 */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * `-val` over a `::Numeric`, keeping the spelling the negated number would carry.
 *
 * `Numeric === (val = resolve_var …) ? -val : '-' + val` (`theme_loader.rb:213`) negates the NUMBER,
 * so what comes back is a Float where a Float went in — and a Float that reaches `to_color` is worth
 * its spelling rather than its magnitude, so the spelling has to survive the negation. Ruby's own is
 * the sign flipped and nothing else, `-0.0` included: `-(-0.0)` is `0.0`.
 *
 * @param value - The value the reference resolved to, which is a number of one of the two kinds.
 * @param magnitude - Its magnitude, already read.
 * @returns The negated value, spelled as the export spells it.
 */
function negatedNumber(value: unknown, magnitude: number): number | RubyNumber {
  if (!(value instanceof RubyNumber)) return -magnitude;
  const { spelling } = value;
  return new RubyNumber(-magnitude, spelling.startsWith('-') ? spelling.slice(1) : `-${spelling}`);
}

/** Substitute every `<number><unit>` term in an expression with its point value. */
function resolveMeasurementTerms(expression: string): string {
  if (!HAS_MEASUREMENT.test(expression)) return expression;
  return expression.replaceAll(INSET_MEASUREMENT, (_match, numeric: string, unit: string) =>
    String(Number(numeric) * POINTS_PER_UNIT[unit.toLowerCase()]),
  );
}

/** Apply one operator, matching the renderer's mapping of `^` onto exponentiation. */
function applyOperator(left: number, operator: string, right: number): number {
  switch (operator) {
    case '*': {
      return left * right;
    }
    case '/': {
      return left / right;
    }
    case '^': {
      return left ** right;
    }
    case '+': {
      return left + right;
    }
    default: {
      return left - right;
    }
  }
}

/** One piece of a scanned expression. */
type Token =
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'space'; readonly text: string }
  | { readonly kind: 'other'; readonly text: string };

/**
 * Split an expression into numbers, runs of spaces, and everything else, in one forward pass.
 *
 * Scanning rather than matching is what makes this safe on untrusted input: the renderer's own
 * expression grammar is `number space operator space number`, and expressing that as an unanchored
 * regular expression puts an unbounded quantifier on both sides of the operator — which a crafted
 * theme value turns into quadratic backtracking on every keystroke. A single left-to-right scan
 * cannot backtrack at all, and it takes the same greedy leftmost decisions the engine would.
 */
function tokenise(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    NUMBER_AT.lastIndex = index;
    const number = NUMBER_AT.exec(expression);
    if (number !== null) {
      tokens.push({ kind: 'number', text: number[0] });
      index += number[0].length;
      continue;
    }
    if (expression[index] === ' ') {
      let end = index;
      while (end < expression.length && expression[end] === ' ') end++;
      tokens.push({ kind: 'space', text: expression.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: 'other', text: expression[index] });
    index++;
  }
  return tokens;
}

/**
 * Fold every NON-OVERLAPPING `number space operator space number` triple, once, left to right.
 *
 * This is the pass, and the whole of the fidelity question lives in it. The renderer reduces with
 * `expr.gsub(MultiplyDivideOpRx) { … }` (`theme_loader.rb:238`), and `gsub` replaces every
 * non-overlapping match in ONE sweep: the right operand of a fold is consumed, so it cannot become
 * the left operand of the next one until the following pass. `10 - 3 - 2 - 1` therefore folds to
 * `7 - 1` and then to `6`, not to `4`; `100 / 5 / 2 / 2` folds to `20 / 1` and then to `20`, not to
 * `5`. Folding strictly one operation at a time — which reads like left-associativity and is what
 * this did — disagrees with the export on every chain of four or more non-associative terms.
 *
 * It is also what makes the reducer cheap. Each pass consumes at least half the foldable terms, so a
 * chain of n terms costs O(n log n) rather than the O(n²) that rebuilding the token array per single
 * fold cost: a 120 KB `1 + 1 + …` theme value — well inside the 512 KB a theme document may be —
 * took over twenty-seven seconds on the thread the preview renders on.
 *
 * @param tokens - The scanned expression.
 * @param operators - The operator characters this pass folds.
 * @returns The rewritten expression, and whether anything folded.
 */
function foldPass(tokens: readonly Token[], operators: string): { text: string; changed: boolean } {
  const out: string[] = [];
  let changed = false;
  let index = 0;
  while (index < tokens.length) {
    const left = tokens[index];
    const gapLeft = tokens[index + 1];
    const operator = tokens[index + 2];
    const gapRight = tokens[index + 3];
    const right = tokens[index + 4];
    if (
      left.kind === 'number' &&
      gapLeft?.kind === 'space' &&
      operator?.kind === 'other' &&
      operators.includes(operator.text) &&
      gapRight?.kind === 'space' &&
      right?.kind === 'number'
    ) {
      out.push(String(applyOperator(Number(left.text), operator.text, Number(right.text))));
      index += 5;
      changed = true;
    } else {
      out.push(left.text);
      index += 1;
    }
  }
  return { text: out.join(''), changed };
}

/**
 * Reduce every operation in `operators`, in as many passes as the renderer takes.
 *
 * The loop is the renderer's own: while the expression still holds one of these operator characters,
 * sweep it; stop as soon as a sweep changes nothing, so an expression whose operators can never fold
 * (`a * b`) costs one pass rather than looping.
 *
 * @param expression - The expression to reduce.
 * @param operators - The operator characters this pass folds.
 * @returns The expression with those operations carried out.
 */
function reduceOperators(expression: string, operators: string): string {
  let current = expression;
  while ([...operators].some((operator) => current.includes(operator))) {
    const pass = foldPass(tokenise(current), operators);
    if (!pass.changed) break;
    current = pass.text;
  }
  return current;
}

/** Apply the rounding function a wrapping `round`/`floor`/`ceil` names. */
function applyPrecision(name: string, value: number): number {
  if (name === 'round') return roundHalfAwayFromZero(value);
  return name === 'floor' ? Math.floor(value) : Math.ceil(value);
}

/**
 * Evaluate the arithmetic in an expression, exactly as the renderer's theme loader does.
 *
 * Multiplication, division and exponentiation are reduced first, then addition and subtraction, then
 * a wrapping `round`/`floor`/`ceil`. An expression that nothing changed comes back as it went in, so
 * a value that is genuinely a word stays a word rather than becoming `NaN`.
 *
 * An expression that something DID change comes back as a number, whatever is left of it. That is
 * not tidiness — it is `evaluate_math`'s own last two lines (`theme_loader.rb:260-264`), which read
 * the reduced text through `String#to_i` and `String#to_f` and keep whichever they agree on. Both
 * take a leading numeric prefix and discard the rest, so the renderer turns `12pt Display` into the
 * Integer `12` rather than into a string with a unit stripped out of it. A resolver that returned the
 * string would hand a value downstream that the export never sees.
 *
 * @param expression - The value after variable expansion.
 * @returns A number when the expression evaluated to one, otherwise the string unchanged.
 */
export function evaluateExpression(expression: string): string | number {
  const original = expression;
  let current = resolveMeasurementTerms(expression);
  current = reduceOperators(current, MULTIPLICATIVE);
  current = reduceOperators(current, ADDITIVE);

  // The renderer reads the argument with `to_f` rather than checking it is a number, so a rounding
  // function wrapped around something unreadable is zero rather than left as written.
  const precision = PRECISION_FUNCTION.exec(current);
  if (precision !== null) return applyPrecision(precision[1], rubyToFloat(precision[2]));

  if (current === original) return original;
  const integer = rubyToInteger(current);
  const float = rubyToFloat(current);
  return integer === float ? integer : float;
}

/**
 * What one `$reference` contributes to the text it sits inside, which is Ruby's `to_s` of its value.
 *
 * `expr.gsub(VariableRx) { resolve_var vars, $&, $1 }` (`theme_loader.rb:214`) — `gsub` converts
 * whatever the block answers with `to_s`, so the reference's value is written out in place. The
 * conversions the two languages agree about are left to `String`: a String is itself, `true` and
 * `false` are their words, and a number carries its own spelling through
 * {@link ../print-appearance/units.RubyNumber}.
 *
 * `nil` is the one they disagree about, and the disagreement is a whole colour wide. `nil.to_s` is
 * the empty string EXACTLY — there is nothing to reproduce and nothing to approximate — where
 * `String(null)` is the four characters `null`. Measured against the vendored gem under ruby 3.3.3,
 * with `v:` written empty above each: `base: font_color: 00$v` is `"000000"` in the theme table and
 * was `00null` here, six characters that are not six hexadecimal digits, so the preview showed the
 * default while the export inked black; `kbd: separator: +$v` is `"+"` there and was `"+null"` here;
 * `menu: caret_content: x$v` is `"x"` and was `"xnull"`; and `base: font_color: [1$v, 0, 0]` is the
 * RGB triple `[1, 0, 0]`, which loads and inks `010000`, where `1null` is a channel `sprintf '%02X'`
 * cannot convert and so threw the WHOLE document away.
 *
 * A COLLECTION is deliberately not converted here. Ruby's `Array#to_s` is `inspect` — `[1, 2]` writes
 * itself `"[1, 2]"`, quoting its strings — where `String` joins with commas, so the two disagree; but
 * unlike `nil` that is a spelling this module would have to INVENT rather than reproduce, and it is
 * the same value {@link contentText} declines for the same reason.
 *
 * @param value - The value the reference named.
 * @returns The characters it writes into the expansion.
 */
function substitutedText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Substitute every `$reference` inside a larger expression, building the result under a bound.
 *
 * Built by accumulation rather than by `replaceAll` so the bound can be applied as the string grows.
 * `replaceAll` produces the whole result before anything can look at it, which is why a chain of
 * `$a $a` references could reach the platform's maximum string length and throw.
 *
 * @param expression - The value the document wrote.
 * @param lookup - How to resolve one name.
 * @param onUnresolved - Called with each reference that named no setting.
 * @param budget - How much expansion the cascade has left.
 * @returns The expanded string, or {@link OVERSIZED} when it grew past what will be built.
 */
function substituteReferences(
  expression: string,
  lookup: (name: string) => { found: boolean; value: unknown },
  onUnresolved: (reference: string) => void,
  budget: ExpansionBudget,
): string | typeof OVERSIZED {
  let out = '';
  let last = 0;
  VARIABLE.lastIndex = 0;
  let match = VARIABLE.exec(expression);
  while (match !== null) {
    const resolved = lookup(match[1]);
    const literal = expression.slice(last, match.index);
    if (!charge(budget, literal.length)) return OVERSIZED;
    if (resolved.found) {
      // Charged BEFORE the substitution is built, because building it is the expensive part: a
      // reference may name an array the cascade resolved, and `String` over one is a join over
      // everything it points at, however little text it was written from.
      if (chargeResolved(resolved.value, budget) === OVERSIZED) return OVERSIZED;
      out += literal + substitutedText(resolved.value);
    } else {
      if (!charge(budget, match[0].length)) return OVERSIZED;
      // Reported only once the charge for it has been taken, which is the same rule every other
      // materialisation here follows and the one this call was outside of. It used to fire first, so
      // a reference the budget was about to refuse still bought its record — and a record costs more
      // than the reference does: `$q ` is three characters of theme and about seventy bytes of
      // `{ key, reference }`, a twenty-fivefold amplification, in the currency the budget does not
      // count. See {@link MAX_COLLECTED_UNRESOLVED} for the bound that makes the list finite.
      onUnresolved(match[0]);
      out += literal + match[0];
    }
    last = match.index + match[0].length;
    match = VARIABLE.exec(expression);
  }
  if (!charge(budget, expression.length - last)) return OVERSIZED;
  out += expression.slice(last);
  return out;
}

/**
 * The key a `$reference` names, following the spellings the renderer still honours.
 *
 * `resolve_var` (`theme_loader.rb:219-229`) tries the name as written, then the same name with a
 * deprecated CATEGORY prefix replaced, then the deprecated-key table — and only warns after all
 * three miss. `$blockquote_font_size` therefore resolves in the export and would resolve to nothing
 * here, which is a value silently absent from the preview rather than a value it disagrees about.
 *
 * The written spelling is tried first, and that ordering matters: a document may set a deprecated
 * name as a FLAT top-level key, in which case the loader stores it under that name (nothing renames
 * a leaf that is not in the key table) and a reference to it finds it.
 *
 * @param name - The reference's name, lower-cased with hyphens folded.
 * @param values - Everything resolved so far.
 * @returns The key holding its value, or undefined when nothing does.
 */
function resolvedVariableKey(name: string, values: ReadonlyMap<string, unknown>): string | undefined {
  if (values.has(name)) return name;
  for (const [deprecated, current] of Object.entries(DEPRECATED_THEME_CATEGORIES)) {
    if (name.startsWith(`${deprecated}_`)) {
      const replaced = current + name.slice(deprecated.length);
      if (values.has(replaced)) return replaced;
    }
  }
  const renamed = Object.hasOwn(DEPRECATED_THEME_KEYS, name) ? DEPRECATED_THEME_KEYS[name] : undefined;
  return renamed !== undefined && values.has(renamed) ? renamed : undefined;
}

/** Expand every `$reference` in one string against the values resolved so far. */
function expandVariables(
  expression: string,
  values: ReadonlyMap<string, unknown>,
  onUnresolved: (reference: string) => void,
  budget: ExpansionBudget,
): unknown {
  if (!expression.includes('$')) return expression;

  const lookup = (name: string): { found: boolean; value: unknown } => {
    // `var.tr '-', '_'` and nothing else (`theme_loader.rb:220`): hyphens fold, case does not.
    const key = resolvedVariableKey(name.replaceAll('-', '_'), values);
    return key === undefined ? { found: false, value: undefined } : { found: true, value: values.get(key) };
  };

  const lone = LONE_VARIABLE.exec(expression);
  if (lone !== null) {
    const resolved = lookup(lone[1]);
    if (!resolved.found) {
      onUnresolved(expression);
      return expression;
    }
    // A lone reference hands back the value ITSELF, which is what keeps `$base_font_size` a number
    // rather than the string of one — and what let a chain of them build a DAG that no bound saw,
    // because none of it was ever charged for. It is charged for here, at the point the cascade
    // takes it on, whether or not anything downstream turns it into text.
    return chargeResolved(resolved.value, budget) === OVERSIZED ? OVERSIZED : resolved.value;
  }

  // `-$var` negates a numeric value; the renderer treats it specially rather than as arithmetic,
  // because there is no left-hand operand for its space-separated grammar to match.
  if (expression.startsWith('-')) {
    const negated = LONE_VARIABLE.exec(expression.slice(1));
    if (negated !== null) {
      const resolved = lookup(negated[1]);
      if (!resolved.found) {
        onUnresolved(expression.slice(1));
        return expression;
      }
      // Refused BEFORE the charge, because there is nothing to charge for: the export builds no
      // string here either — `'-' + val` raises on the argument rather than converting it, and a
      // value the loader threw the document away over is not a value this cascade materialises. The
      // two accepted shapes are charged exactly as they were, so the allowance a document spends is
      // unchanged for every document that still loads. See {@link NEGATION_REFUSED}.
      const magnitude = numberValue(resolved.value);
      if (magnitude !== undefined) {
        if (chargeResolved(resolved.value, budget) === OVERSIZED) return OVERSIZED;
        return negatedNumber(resolved.value, magnitude);
      }
      if (typeof resolved.value !== 'string') return NEGATION_REFUSED;
      if (chargeResolved(resolved.value, budget) === OVERSIZED) return OVERSIZED;
      return `-${resolved.value}`;
    }
  }

  return substituteReferences(expression, lookup, onUnresolved, budget);
}

/** Expand and, unless the key forbids it, evaluate one value — descending into an array. */
function evaluateValue(
  value: unknown,
  values: ReadonlyMap<string, unknown>,
  math: boolean,
  onUnresolved: (reference: string) => void,
  budget: ExpansionBudget,
  depth = 0,
): unknown {
  if (Array.isArray(value)) {
    // Refused rather than descended, so nothing the cascade STORES is deeper than anything reading
    // it can walk. Every later reader — the projection, the value parsers, `String` itself — then
    // holds for free, instead of each of them needing a bound of its own.
    if (depth >= MAX_VALUE_DEPTH) return OVERSIZED;
    const entries = value.map((entry) =>
      evaluateValue(entry, values, math, onUnresolved, budget, depth + 1),
    );
    // A refusal outranks a bound, and the order is the whole of the reason. `OVERSIZED` says this
    // resolver stopped where the export carried on; `NEGATION_REFUSED` says the export stopped. A
    // list holding one of each is a list the export never finished reading, so answering with the
    // bound would report a rejected setting for a document that has no settings at all.
    if (entries.includes(NEGATION_REFUSED)) return NEGATION_REFUSED;
    return entries.includes(OVERSIZED) ? OVERSIZED : entries;
  }
  if (typeof value !== 'string') return value;
  const expanded = expandVariables(value, values, onUnresolved, budget);
  if (expanded === NEGATION_REFUSED) return NEGATION_REFUSED;
  if (expanded === OVERSIZED) return OVERSIZED;
  if (!math || typeof expanded !== 'string') return expanded;
  return evaluateExpression(expanded);
}

/**
 * Expand the `$references` in a string the renderer expands but never evaluates.
 *
 * The font catalogue's paths are the case this exists for: `process_entry` runs `expand_vars` over
 * each of them (`theme_loader.rb:144`) without the arithmetic it applies to a setting, so
 * `$fonts_dir/brand.ttf` names a real file in the export. They are not settings, so they are not part
 * of the cascade and cannot be resolved by it.
 *
 * The budget is the RESOLUTION's, passed in rather than minted here, and that is the whole of the
 * bound. A fresh `MAX_EXPANDED_VALUE_LENGTH` per call is not a per-value bound with a global one
 * beside it; it is a per-value bound and nothing else, over a call the caller makes once per style
 * path and once per fallback. `MAX_EXPANSION_BUDGET`'s own note says why that is not enough —
 * bounding each of tens of thousands of values individually leaves their sum unbounded — and a
 * catalogue is where a document buys the most calls per byte: `f0: $x` declares four style paths in
 * nine characters.
 *
 * Measured on two 502,919-byte documents differing in ONE character, `$x` against `Yx`, where the
 * reference names a resolved ARRAY (a lone reference to one hands back the array itself, and `String`
 * over it materialises a flat string where a scalar reference is a cons string): the literal resolved
 * in 430 ms and 86 MB of heap, the reference in 542 ms and 540 MB of heap and 710 MB resident — all
 * of it in the render-phase `useMemo` that reads the theme, per keystroke, and all of it accepted
 * with `themeApplied` true and no diagnostic.
 *
 * `perEntry` is reset per call because a catalogue path is its own value in the loader's eyes, and
 * the per-value bound is what says how large one may grow. What is shared is `remaining`, which is
 * what says how much one resolution may build in total.
 *
 * ## Why this returns a refusal at all
 *
 * A catalogue path and a fallback name go through the SAME `expand_vars` a setting does, so
 * `normal: -$v` above a `v:` raises `TypeError` and throws the document away exactly as
 * `base: font_size: -$v` does — measured, in both positions and under the `'*'` spelling. This
 * function had no channel to say so: it answered a string whatever happened, so the one shape that
 * costs the whole document arrived here and left as text. A cascade-only fix would have closed the
 * settings and left the catalogue open, which is a claim of exhaustiveness the fix would not have.
 *
 * @param text - The path exactly as the catalogue wrote it.
 * @param values - The values resolved before the catalogue was reached, in document order.
 * @param budget - The resolution's remaining allowance, shared with every other expansion in it.
 * @returns The path with its references substituted, {@link NEGATION_REFUSED} when expanding
 *   it would have refused the whole document, or the text unchanged when a reference cannot be
 *   followed for a reason that costs only this value.
 */
export function expandThemeVariables(
  text: string,
  values: ReadonlyMap<string, unknown>,
  budget: ExpansionBudget,
): string | typeof NEGATION_REFUSED {
  budget.perEntry = MAX_EXPANDED_VALUE_LENGTH;
  const expanded = expandVariables(text, values, () => undefined, budget);
  if (expanded === NEGATION_REFUSED) return NEGATION_REFUSED;
  if (expanded === OVERSIZED || expanded === null || expanded === undefined) return text;
  return typeof expanded === 'string' ? expanded : String(expanded);
}

/**
 * Ruby's `to_f` for a padding edge, or undefined where Ruby has no `to_f` to call.
 *
 * `nil.to_f` is zero, which is the whole reason the rewrite below GROWS a short array: a missing edge
 * reads as zero and satisfies the test. A `true` or a nested list has no `to_f` at all and raises
 * `NoMethodError` out of the export, so there is no behaviour to reproduce for one — the array is left
 * alone rather than coerced, since `Number(true)` is 1 and `Number([1])` is 1 and neither is anything
 * the renderer ever computes.
 *
 * @param edge - One element of a padding array, or undefined where the array is shorter than three.
 * @returns The number Ruby would compare, or undefined where Ruby would raise instead.
 */
function paddingEdgeToFloat(edge: unknown): number | undefined {
  const magnitude = numberValue(edge);
  if (magnitude !== undefined) return magnitude;
  if (typeof edge === 'string') return rubyToFloat(edge);
  return edge === null || edge === undefined ? 0 : undefined;
}

/**
 * The renderer's padding rewrite for themes predating its smart margins.
 *
 * `val[2] = val[0] if ::Array === val && val[0].to_f >= 0 && val[2].to_f <= 0` (`theme_loader.rb:180`)
 * INDEXES OFF THE END, and that is the case this used to skip. For `[12]`, `val[2]` is `nil`, whose
 * `to_f` is zero, so the test holds and the assignment extends the array to `[12, nil, 12]` —
 * `expand_padding_value` (`ext/prawn/extensions.rb:614-622`) then reads that as `[12, 0, 12, 0]`.
 * Returning early below three elements left `[12]` alone, which the same expansion reads as
 * `[12, 12, 12, 12]`: measured against the vendored gem under ruby 3.3.3, `example: padding: [12]`
 * exported with left and right insets of 0 and previewed with 12, so every line in the block wrapped
 * differently. It applies to all four {@link PADDING_BOTTOM_HACK_KEYS}.
 *
 * Every length short of three grows, not just one: the gem returns `[nil, nil, nil]` for `[]` and
 * `[12, 4, 12]` for `[12, 4]`. The two-element case reaches the same four edges either way, and is
 * reproduced anyway because what is stored is what a reference to the key hands on.
 *
 * @param value - The resolved value of a padding key.
 * @returns The value with the rewrite applied, or unchanged where the renderer's test does not hold.
 */
/**
 * Whether reading a padding value would refuse the whole document, as `to_color` does for a colour.
 *
 * `val[2] = val[0] if ::Array === val && val[0].to_f >= 0 && val[2].to_f <= 0`
 * (`theme_loader.rb:180`) calls `to_f` on two of the array's elements, and `true`, `false`, a list and
 * a mapping have none — so the rewrite raises `NoMethodError` out of `ThemeLoader.load` and
 * `converter.rb:556`'s bare rescue prints the document with the DEFAULT theme, every other setting in
 * it thrown away. It is the same shape as {@link colourRefusedAtLoad}: a conversion the loader
 * performs while READING, not a value a later reader rejects. The preview reported the one padding
 * key and applied the rest of the theme, so a document the export prints at 10.5 pt previewed at 20.
 *
 * The `&&` SHORT-CIRCUITS, and reproducing that is the whole reason this is not simply "an element
 * has no `to_f`". A negative top edge means `val[2].to_f` is never called, so
 * `padding: [-5, 0, {a: 1}, 0]` loads and prints — measured against the vendored gem under ruby
 * 3.3.3, it comes back `[-5, 0, {"a"=>1}, 0]`. The second element is never read at either test, so
 * `[5, {a: 1}]` loads too. Refusing those would be refusing documents the export prints.
 *
 * `nil` is not one of these: `NilClass#to_f` is zero, which is what makes the rewrite GROW a short
 * array rather than raise on it — see {@link normalisePaddingHack} — so a missing edge and an empty
 * one both load. Measured, along with all four of {@link PADDING_BOTTOM_HACK_KEYS} and both the
 * nested and flat spellings of each.
 *
 * Asked of the RESOLVED value, because that is what the loader has by then. A padding array's element
 * can be a mapping only by way of a `$reference`, and one road reaches it: an admonition icon is the
 * one setting the loader stores a Hash under, so `padding: [$admonition_icon_tip, 0, 0]` above an
 * `admonition_icon_tip` mapping raises — measured.
 *
 * @param value - The padding key's value, after `$reference` expansion, as the loader sees it.
 * @returns Whether reading this value would have refused the whole document.
 */
function paddingRefusedAtLoad(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const top = paddingEdgeToFloat(value[0]);
  if (top === undefined) return true;
  // `NaN >= 0` is false in both languages, so `.nan` short-circuits the third element exactly as a
  // negative edge does.
  if (!(top >= 0)) return false;
  return paddingEdgeToFloat(value[2]) === undefined;
}

function normalisePaddingHack(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const top = paddingEdgeToFloat(value[0]);
  const bottom = paddingEdgeToFloat(value[2]);
  if (top === undefined || bottom === undefined || !(top >= 0) || !(bottom <= 0)) return value;
  // Grown to three before the write, because `val[2] =` on a shorter array is what grows it in Ruby.
  // The gap it opens holds `nil` there and `undefined` here, and every reader of a padding value
  // already reads a missing edge as zero — which is what `expand_padding_value` does with the `nil`.
  const grown: unknown[] = [...value];
  while (grown.length < 3) grown.push(undefined);
  grown[2] = grown[0];
  return grown;
}

/** One theme setting to resolve, in the flat key space. */
export interface ResolvableEntry {
  /** Flat, underscore-joined key. */
  readonly key: string;
  /** The raw value the document wrote. */
  readonly value: unknown;
  /**
   * Whether arithmetic is evaluated in this value, when the key alone does not decide it.
   *
   * Only the loader's deprecated-key branch sets this: it stores with `math: false`
   * (`theme_loader.rb:176`) whatever the key's suffix would otherwise imply.
   *
   * It also decides whether `to_color` runs on the value at all, because the deprecated branch is
   * reached FIRST and does not call it — see {@link colourLoadedByTheLoader}.
   */
  readonly math?: boolean;
  /** The line the document wrote this setting on, for attributing a failure to it. */
  readonly line?: number;
}

/** Everything one cascade produced. */
export interface ResolvedValues {
  /** Flat key → resolved value: a number, a string, or an array of those. */
  readonly values: ReadonlyMap<string, unknown>;
  /** Every variable reference that named no setting, in the order they were met. */
  readonly unresolved: readonly UnresolvedReference[];
  /** Every value whose expansion grew past what this resolver will build, in the order they were met. */
  readonly oversized: readonly OversizedValue[];
  /**
   * The FIRST colour the loader would have raised converting, when the document holds one.
   *
   * A whole-document answer rather than a per-key one, and it sits beside two per-key lists because
   * it is found in the same pass they are: `to_color` runs while the theme is being read, so a value
   * it raises on is a theme that never loaded at all. See {@link colourRefusedAtLoad}.
   */
  readonly refusedColour?: { readonly key: string; readonly line?: number };
  /**
   * The FIRST padding the loader would have raised rewriting, when the document holds one.
   *
   * Beside {@link refusedColour} and for the same reason — the rewrite runs while the theme is being
   * read — and mutually exclusive with it and with {@link refusedNegation}:
   * {@link resolveThemeValues} keeps only the first refusal it meets of ANY of the three kinds, so
   * which field is set is which one the loader reaches first. See {@link paddingRefusedAtLoad}.
   */
  readonly refusedPadding?: { readonly key: string; readonly line?: number };
  /**
   * The FIRST `-$reference` the loader would have raised negating, when the document holds one.
   *
   * The third of the three, and the earliest of them WITHIN a setting: expansion runs before
   * `to_color` and before the padding rewrite, both of which read what it produced. So a value that
   * negates a list under a `_color` key is refused for the negation and not for the colour, which is
   * the line an author has to change. See {@link NEGATION_REFUSED}.
   */
  readonly refusedNegation?: { readonly key: string; readonly line?: number };
}

/**
 * The renderer's `to_s` on a content template, for the values this model can spell as Ruby does.
 *
 * A number and a boolean are converted; nothing else is. A BOOLEAN is the only one of them whose two
 * spellings agree outright — `true` and `false` are the same four and five characters in both. A
 * NUMBER's do not: measured against the vendored gem under ruby 3.3.3, `caret_content: 1.0` is
 * `"1.0"` in the export where JavaScript writes `"1"`, `-0.0` is `"-0.0"` where it writes `"0"`,
 * `3.0e-7` is `"3.0e-07"` where it writes `"3e-7"`, and `10000000000000000000000` keeps all
 * twenty-three of its digits where it writes `"1e+22"`. That is why a number carries its spelling
 * from the parser rather than being converted here — see {@link ../print-appearance/units.RubyNumber}.
 * This comment claimed the number and the boolean agreed "exactly", which was true of one of them and
 * is how six shapes of caret went out spelled wrong.
 *
 * A COLLECTION is left alone because converting it would mean INVENTING the export's text rather than
 * reproducing it: `caret_content: [1, 2]` is `"[1, 2]"` in the export and would be `"1,2"` here.
 *
 * `nil` IS converted, and it is the one value whose conversion needs no spelling reproduced at all:
 * `nil.to_s` is the empty string exactly. Measured against the vendored gem under ruby 3.3.3,
 * `menu: caret_content:` written empty stores `""` and draws an empty caret, and so does
 * `caret_content: $v` above a `v:` written empty — the loader's `val.to_s` runs BEFORE the expansion
 * and its second `to_s` runs after it, so a nil is emptied whichever end it arrives from. This
 * declined both, and the key fell back to the default theme's `" › "` against an export that drew
 * nothing. The comment here used to argue the value away, first as an agreement it did not have and
 * then as a divergence left open beside the `$reference` one; both are closed together, and the
 * interpolated half lives with the substitution — see {@link substitutedText}.
 *
 * @param value - A template's value, before or after expansion.
 * @returns The string the renderer would store, or the value unchanged where this cannot spell it.
 */
function contentText(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  return rubySpelling(value) ?? (typeof value === 'boolean' ? String(value) : value);
}

/**
 * A content template's value, which the renderer reads as TEXT whatever the document wrote.
 *
 * `(expand_vars val.to_s, data).to_s` (`theme_loader.rb:190`) — the `_content` branch converts
 * BEFORE it expands, so `menu_caret_content: 123456` is the six-character string `123456` in the
 * export rather than a number. Nothing downstream of here reads a template that is not a string, so
 * without this the setting would simply be dropped and the key fall back to its default — a caret the
 * export draws and the preview does not.
 *
 * @param entry - The entry about to be resolved.
 * @returns The value to expand, converted where the renderer converts it.
 */
function contentValue(entry: ResolvableEntry): unknown {
  return entry.key.endsWith('_content') ? contentText(entry.value) : entry.value;
}

/**
 * Whether the loader hands this entry's value to `expand_vars` as ONE string it built itself.
 *
 * `(expand_vars val.to_s, data).to_s` — `to_s` runs over the WHOLE value, so a list under a content
 * key reaches the expansion as `[1, "-$v", 2]`, punctuation and all, and nothing inside it is a lone
 * reference any more. `LoneVariableRx` is anchored, and it is the lone form alone that reaches
 * `'-' + val` and raises: measured against the vendored gem under ruby 3.3.3,
 * `v: []\nzzz:\n  content: [1, -$v, 2]` LOADS, storing `zzz_content => "[1, \"-[]\", 2]"`, while the
 * same negation written as the whole value (`content: -$v`) raises `TypeError` and so does the same
 * list under any key that is not a content key.
 *
 * This resolver descends a list instead, element by element, and met the negation the export never
 * sees — so it refused the whole document, and an author got the default page for a theme the export
 * prints. Which is what this answers: a value the loader stringified whole can hold no lone
 * reference, so no refusal can come out of it.
 *
 * Only where the content branch is the branch that runs. `process_entry` tries its branches in order,
 * and a renamed key takes the deprecated branch above it with no `to_s` at all — the case
 * {@link ResolvableEntry.math} already marks — so a renamed key is excluded here by that same flag.
 * A MAPPING never arrives here either: the Hash branch runs first, and this walk has already
 * descended into it, so what is left under a content key is a list, a nil, or text.
 *
 * @param entry - The entry, before its value is expanded.
 * @returns Whether the loader read it as one string of its own making.
 */
function stringifiedWhole(entry: ResolvableEntry): boolean {
  if (entry.math !== undefined || !entry.key.endsWith('_content')) return false;
  return typeof contentValue(entry) !== 'string';
}

/**
 * Whether the loader would run `to_color` over this entry's value as it read the document.
 *
 * `process_entry`'s branches are tried in ORDER and only one runs, so the suffix is not the whole
 * test. The deprecated-key branch (`theme_loader.rb:174-176`) is reached first and stores its value
 * with no conversion at all, which is exactly the case {@link ResolvableEntry.math} already marks —
 * so a renamed key is excluded here by the same flag that says its arithmetic was skipped.
 *
 * @param entry - The entry, before its value is expanded.
 * @returns Whether `to_color` is applied to it at load.
 */
function colourLoadedByTheLoader(entry: ResolvableEntry): boolean {
  return entry.math === undefined && entry.key.endsWith('_color');
}

/**
 * Whether the loader's `to_color` would RAISE reading this setting, and so refuse the whole document.
 *
 * Two keys hand `to_color` their elements one at a time rather than the value whole — see
 * {@link readsColoursPerElement}. It matters here because it decides what an array MEANS:
 * `table: border_color: [a, 0, 0]` is three colours read separately and raises nothing, where the
 * same value under `base: font_color` is one RGB triple and throws the document away. An ELEMENT can
 * still raise, and raises the same way: `table: border_color: [[a, 0, 0], 2]` is a triple after all,
 * and measured against the vendored gem under ruby 3.3.3 it refuses the document.
 *
 * Which branch runs is decided by the value the DOCUMENT wrote, and what raises by the value the
 * expansion produced — asked separately, because a reference moves a list from one branch to the
 * other. Measured: `table: border_color: [a, 0, 0]` loads and stores three colours, while
 * `v: [a, 0, 0]` with `table: border_color: $v` raises `ArgumentError` over one RGB triple; and
 * `[[a, 0, 0], 2]` is the same pair the other way round.
 *
 * @param entry - The entry, whose `value` is still exactly as the document wrote it.
 * @param value - The expanded value.
 * @returns Whether reading it refuses the document.
 */
function colourRaisesAtLoad(entry: ResolvableEntry, value: unknown): boolean {
  if (readsColoursPerElement(entry.key, entry.value) && Array.isArray(value)) {
    return value.some((item) => colourRefusedAtLoad(item));
  }
  return colourRefusedAtLoad(value);
}

/**
 * Resolve a list of theme entries over an existing set of values.
 *
 * Entries are applied in order, and each is expanded against everything resolved before it — which
 * is what makes `extends` work: the parent's entries come first, so a child's `$base_font_size`
 * finds the parent's value, and a child that overrides `base_font_size` changes what every *later*
 * reference sees without retroactively changing earlier ones. The renderer resolves eagerly in the
 * same order, so a preview that resolved lazily would compute values the export never produces.
 *
 * @param entries - Settings in document order, parents first.
 * @param inherited - Values already resolved by earlier documents in the chain.
 * @param budget - The allowance to spend, shared with every other expansion in the same resolution.
 *   Defaults to one of its own, which is right for a cascade resolved on its own and wrong for one
 *   of several passes over a single document — see {@link createExpansionBudget}.
 * @returns The resolved values and any dangling variable references.
 */
export function resolveThemeValues(
  entries: readonly ResolvableEntry[],
  inherited: ReadonlyMap<string, unknown> = new Map(),
  budget: ExpansionBudget = createExpansionBudget(),
): ResolvedValues {
  const values = new Map(inherited);
  const unresolved: UnresolvedReference[] = [];
  const oversized: OversizedValue[] = [];
  let refusedColour: ResolvedValues['refusedColour'];
  let refusedPadding: ResolvedValues['refusedPadding'];
  let refusedNegation: ResolvedValues['refusedNegation'];
  // Deduplicated as records are collected rather than after, so the SET is bounded too — a list held
  // down by a cap while the structure deciding what goes in it grows without one would be the same
  // defect one level along. The separator is a NUL, which neither a flat key nor a `$reference`
  // can hold, so the two halves of the identity cannot run together into a collision.
  const seenUnresolved = new Set<string>();

  for (const entry of entries) {
    budget.perEntry = MAX_EXPANDED_VALUE_LENGTH;
    // Colours and content strings are expanded but never evaluated: `+`/`-` inside them are text,
    // and running arithmetic over a colour is how `000000` would become the number zero.
    const math = entry.math ?? (!entry.key.endsWith('_color') && !entry.key.endsWith('_content'));
    const resolved = evaluateValue(
      contentValue(entry),
      values,
      math,
      (reference) => {
        if (unresolved.length >= MAX_COLLECTED_UNRESOLVED) return;
        const identity = `${entry.key}\u0000${reference}`;
        if (seenUnresolved.has(identity)) return;
        seenUnresolved.add(identity);
        unresolved.push({ key: entry.key, reference });
      },
      budget,
    );
    // Checked before the bound, because the two answers are about different things and only one of
    // them is about this setting: the export refused the DOCUMENT here, so there is no value to
    // store and no default for the key to fall back to. Nothing is written down — whatever the
    // cascade inherited stands, and the caller replaces the whole appearance anyway.
    if (resolved === NEGATION_REFUSED) {
      // …unless the export never met the negation, because it had already turned the value into one
      // string. See {@link stringifiedWhole}. The value stored is the document's own, unexpanded:
      // what the export holds is text this module deliberately does not invent — see
      // {@link contentText} — and inventing half of it here, with the references substituted and the
      // punctuation missing, would be neither the export's text nor the document's.
      if (stringifiedWhole(entry)) {
        values.set(entry.key, entry.value);
        continue;
      }
      if (refusedColour === undefined && refusedPadding === undefined && refusedNegation === undefined) {
        refusedNegation = { key: entry.key, ...(entry.line === undefined ? {} : { line: entry.line }) };
      }
      continue;
    }
    if (resolved === OVERSIZED) {
      oversized.push({ key: entry.key });
      // The value the document wrote, references and all, so nothing downstream reads a half-built
      // string. It will not parse as anything the model accepts, which is the honest outcome: the
      // key falls back to its default and the diagnostic below says why.
      //
      // Only when the raw value is itself something a reader can hold, though. What could not be
      // expanded is sometimes the raw value's own shape — a sequence nested past what anything can
      // print — and storing one of those would hand every later reader a structure no bound had
      // looked at. The key then carries nothing at all, which is the same outcome by a shorter road:
      // whatever the cascade inherited stands, and the diagnostic still says why.
      if (measureValue(entry.value, MAX_EXPANDED_VALUE_LENGTH) <= MAX_EXPANDED_VALUE_LENGTH) {
        values.set(entry.key, entry.value);
      }
      continue;
    }
    // Recorded rather than returned, because the loader does not stop either: it goes on writing
    // entries until the raise, and the caller reverts the whole document afterwards. The FIRST one is
    // kept, which is the one the export would have raised on.
    //
    // First across ALL THREE kinds, not first of each: a negation, a colour and a padding raise at
    // the same place, out of `process_entry` and into the same bare rescue, so a document holding
    // more than one is refused over whichever the loader folds first. Keeping a first-of-each would
    // have let a padding written below a bad colour decide the sentence, which is the wrong line to
    // send an author to. A colour and a padding cannot be the same entry — no key ends in `_color`
    // and is one of {@link PADDING_BOTTOM_HACK_KEYS} — but a negation shares its entry with either,
    // and it is checked in the branch above precisely because expansion runs FIRST.
    //
    // The record is built inside each branch rather than once above them, because the branch is not
    // taken: this loop runs once per setting and a 512 KB document holds forty thousand of them, on
    // the thread that renders the preview, per keystroke. Hoisting it minted an object per setting
    // for the one it keeps.
    const alreadyRefused =
      refusedColour !== undefined || refusedPadding !== undefined || refusedNegation !== undefined;
    if (!alreadyRefused && colourLoadedByTheLoader(entry) && colourRaisesAtLoad(entry, resolved)) {
      refusedColour = { key: entry.key, ...(entry.line === undefined ? {} : { line: entry.line }) };
    }
    if (PADDING_BOTTOM_HACK_KEYS.has(entry.key)) {
      if (!alreadyRefused && paddingRefusedAtLoad(resolved)) {
        refusedPadding = { key: entry.key, ...(entry.line === undefined ? {} : { line: entry.line }) };
      }
      values.set(entry.key, normalisePaddingHack(resolved));
    } else if (entry.key.endsWith('_content')) {
      // `(expand_vars val.to_s, data).to_s` converts TWICE, and the second conversion is over the
      // expansion's result. Only the first was reproduced, so a template that is one lone reference
      // came back as whatever the reference named: `menu: caret-content: $base_font_size` resolved to
      // the Number 12, `readTemplate` requires a string, and `appearance.menu.caretContent` was
      // undefined while the export drew `12`. The same for `button.content`.
      values.set(entry.key, contentText(resolved));
    } else if (
      colourLoadedByTheLoader(entry) &&
      readsColoursPerElement(entry.key, entry.value) &&
      Array.isArray(resolved)
    ) {
      // `data[key] = val.map {|it| to_color evaluate it, data, math: false }` (`theme_loader.rb:185`)
      // — the conversion happens per ELEMENT and BEFORE anything joins, which is the whole of what
      // separates a shorthand for four sides from one nonsense value flattened to a string. The
      // cascade holds what the gem's theme table holds, so a later `$table_border_color` finds the
      // converted list and a reader finds the side it paints. See {@link loadedColourList}.
      //
      // The branch is chosen by the value the DOCUMENT wrote, which is what `::Array === val` tests;
      // the expansion has run by the time the elements are converted, and a list of references
      // expands to a list of the same length.
      //
      // The last test is what tells the type system so. It cannot fail today — `evaluateValue`
      // answers a list for a list, and the two sentinels it answers instead are both handled above —
      // and it is kept rather than cast away because the arm it falls to is the right answer if that
      // ever stops being true: a value that is not a list is a value the whole-value branch reads.
      values.set(entry.key, loadedColourList(resolved));
    } else {
      values.set(entry.key, resolved);
    }
  }

  return {
    values,
    unresolved,
    oversized,
    ...(refusedColour === undefined ? {} : { refusedColour }),
    ...(refusedPadding === undefined ? {} : { refusedPadding }),
    ...(refusedNegation === undefined ? {} : { refusedNegation }),
  };
}

/**
 * Whether Ruby would treat this value as true, which is what decides whether `||=` fires.
 *
 * `nil` and `false` are the whole of what Ruby calls false, so `0` and `''` KEEP a setting where
 * JavaScript's own rule would replace it. Measured against the vendored gem under ruby 3.3.3, each
 * over `extends: default`: `heading: font_family: 0` leaves `sidebar_title_font_family` as `0` and
 * `font_family: ''` leaves it as `''`, while `font_family: false` and `font_family: null` leave it
 * unset — the derivation does not run at all for those two, because its own guard reads the same way.
 *
 * @param value - A resolved setting, or undefined where the cascade holds none.
 * @returns Whether `||=` would leave it as it is.
 */
function setInRuby(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/**
 * The settings the loader derives once the whole document has been read.
 *
 * `theme_loader.rb:82-92`, and the stage is the point of them. They run after `load_file` has
 * returned, so they see the MERGE of the document and everything its `extends` chain contributed: a
 * value inherited from `default-theme.yml` is a value that is set, and the derivation stays quiet.
 * That is why they were missed here for so long — for a theme that extends the default and writes
 * ordinary values, six of the seven never fire. What reaches them is the seventh, and the two
 * documents in the corpus that write a `null`:
 *
 * - `heading: font_family: Courier` over `extends: default`. The default theme sets no heading face,
 *   so the derivation carries Courier into `abstract_title_font_family` and
 *   `sidebar_title_font_family`. Measured: both are `"Courier"` in the gem, and this module left the
 *   sidebar title to fall back to the stylesheet's own face — one construct in the preview set in a
 *   different typeface from the exported page, in a theme anybody might write.
 * - `code: font_family: null` over `extends: default`. Measured: `"M+ 1mn"` in the gem, by way of
 *   `codespan_font_family`; nothing at all here.
 *
 * The guard is `unless (::File.dirname theme_path) == ThemesDir` — a theme the gem SHIPS is loaded
 * without any of this. That is exactly the cascade's own base layer, so the default values every
 * resolution starts from are deliberately not put through here: the gem reads `default-theme.yml`
 * the same way, and running the derivations over it would invent settings that neither renderer
 * holds. Called from one place, on one map, for that reason.
 *
 * Nothing here reads a key anything here writes, so the order is the loader's for fidelity's sake
 * rather than for correctness: `code_font_family` and `conum_font_family` both read
 * `codespan_font_family`, which no derivation sets, and the title faces read `heading_font_family`,
 * which no derivation sets either.
 *
 * The copy is paid only by a document that actually reaches a derivation. A cascade holds every key
 * the default theme sets plus every key the document invents — up to tens of thousands of them in a
 * document this module still accepts — and copying that map on every keystroke to write at most
 * seven entries would be work charged to documents that need none of it.
 *
 * @param values - The cascade as the document left it, after both passes.
 * @returns The cascade with the derived settings written in, or the same map when none fired.
 */
export function deriveLoaderSettings(
  values: ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  let derived: Map<string, unknown> | undefined;
  const derive = (key: string, value: unknown): void => {
    if (setInRuby(values.get(key))) return;
    (derived ??= new Map(values)).set(key, value);
  };

  derive('base_text_align', 'left');
  derive('base_line_height', 1);
  // The one of the seven whose key was already CONVERTED before `||=` reads it, which moves the
  // condition. `to_color` answers nil for nil and a six-character string for everything else
  // (`theme_loader.rb:267-322`), so the only falsy thing it can leave behind is nil: a colour
  // written as `false` is `"0FALSE"` in the gem's own table — measured — and keeps the setting
  // rather than defaulting it. This module stores colours unconverted and converts them as they are
  // read, so asking `setInRuby` about what it stores would default a setting the loader does not.
  //
  // `"0FALSE"` is not six hexadecimal digits, so it is a value the export cannot print at all: the
  // model refuses it and tells the author, which is what the colour reader's six-digit gate is for.
  // Leaving the derivation out of its way is what keeps that sentence.
  //
  // What it assigns is a plain string and not a converted colour — `||=` runs past `to_color` — so
  // the export holds these six characters as written. They read as a colour anyway, which is why
  // this derivation agrees with the fallback the model already applies for the converter's own
  // `theme.base_font_color ||= '000000'` (`converter.rb:571`): the same value by two roads.
  const baseFontColour = values.get('base_font_color');
  if (baseFontColour === undefined || baseFontColour === null) {
    (derived ??= new Map(values)).set('base_font_color', '000000');
  }

  // `theme_data.code_font_family ||= (theme_data.codespan_font_family || 'Courier')`, and the same
  // line again for `conum`. The inner `||` is Ruby's too, so a `codespan` face written as `false`
  // sends both of them to Courier while a face written as `0` sends both of them to `0`.
  const monospaced = values.get('codespan_font_family');
  const fallbackMonospaced = setInRuby(monospaced) ? monospaced : 'Courier';
  derive('code_font_family', fallbackMonospaced);
  derive('conum_font_family', fallbackMonospaced);

  // The pair sits inside `if (heading_font_family = theme_data.heading_font_family)`, so a heading
  // face of `nil` or `false` derives nothing at all rather than deriving that value onward.
  const headingFamily = values.get('heading_font_family');
  if (setInRuby(headingFamily)) {
    // Inert, and deliberately written anyway. `abstract.*` is not a construct this model carries —
    // see the file header of `appearance-model.ts` — and the one other reader of the raw cascade,
    // `AppearanceReader.namedFamilies`, cannot see a new face here either: what this writes is the
    // heading's own family, which that scan already found under `heading_font_family`. It is the
    // half of one `if` in the gem, and leaving it out would mean the next reader of this function
    // had to re-derive from the source that it does not matter. Its inertness is pinned by a test
    // rather than by this comment.
    derive('abstract_title_font_family', headingFamily);
    derive('sidebar_title_font_family', headingFamily);
  }

  return derived ?? values;
}

/**
 * Whether Ruby would treat a COLOUR setting as true, which is not the same question as elsewhere.
 *
 * Every key ending in `_color` reaches the theme table through `to_color` (`theme_loader.rb:144`),
 * and `to_color` answers nil for nil and something truthy for everything else — a String for a
 * String, a number or a boolean, a HexColorValue for a three- or four-element list, and the joined
 * text of any other list (`theme_loader.rb:267-322`). So a `||=` over a colour fires on nil ALONE,
 * where the same operator over any other kind of setting fires on `false` as well.
 *
 * Measured against the vendored gem under ruby 3.3.3, each over `extends: default`:
 * `base: border_color: false` is `"0FALSE"` in the theme table and `table: border_color: []` is `[]`
 * — both of them values `||=` keeps, and both of them values {@link setInRuby} would have replaced.
 *
 * This module stores colours as the document wrote them and converts them where they are read, so
 * the question has to be asked of the value BEFORE conversion — which is why it is a rule of its own
 * rather than a call to `parseColour`. See the note on `base_font_color` in
 * {@link deriveLoaderSettings}, which is the same trap one stage earlier.
 *
 * @param value - A resolved colour setting, or undefined where the cascade holds none.
 * @returns Whether `||=` would leave it as it is.
 */
function colourSetInRuby(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** The colour `to_color` answers for the one input it does not answer with hexadecimal digits. */
const TRANSPARENT_KEYWORD = 'transparent';

/**
 * The `prepare_theme` settings whose keys this module does not read, recorded so nobody claims one blind.
 *
 * Seventeen of the thirty-six assignments in `prepare_theme` (`converter.rb:569-611`) write a key
 * outside {@link CLAIMED_THEME_KEYS}, so not one of them can reach this preview today and modelling
 * them would be a derivation nothing reads. They are written down rather than left out because the
 * FIRST person to claim one of these keys inherits a live divergence: sixteen of the seventeen fire
 * for every theme there is, including `extends: default` and the gem's own bundled default —
 * measured, by diffing the gem's theme table across `prepare_theme` — so a model that reads
 * `image_border_width` from the cascade alone would find nothing where the export has `0`, and one
 * that reads `index_column_gap` would find nothing where the export has the body font size.
 *
 * `index_column_gap` is the seventeenth and the exception: `default-theme.yml` sets `index:
 * column_gap: $vertical_rhythm`, so it fires only for a theme that writes an explicit `null` or
 * `false` — the same shape as the claimed keys {@link derivePreparedSettings} models.
 *
 * `quotes` is on the list for a second reason as well as being unclaimed: it is the one assignment
 * in `prepare_theme` that is not a whole-value default. It fills the FOUR typographic quotation
 * characters slot by slot when the theme wrote a list (`quotes[idx] ||= char`), and replaces the
 * value outright when it wrote anything else, so claiming it would need a derivation shaped like no
 * other one here.
 *
 * Held by a test that asserts none of these is claimed, which is what turns claiming one into a
 * failure that points here rather than into a silent wrong default.
 */
export const PREPARE_THEME_UNMODELLED_KEYS: readonly string[] = [
  'page_numbering_start_at',
  'running_content_start_at',
  'heading_chapter_break_before',
  'heading_part_break_before',
  'heading_margin_page_top',
  'prose_text_indent',
  'prose_text_indent_inner',
  'image_border_width',
  'code_linenum_font_color',
  'role_unresolved_font_color',
  'footnotes_margin_top',
  'index_columns',
  'index_column_gap',
  'title_page_authors_delimiter',
  'title_page_revision_delimiter',
  'toc_hanging_indent',
  'quotes',
];

/**
 * Whether the converter throws the whole theme away while preparing it, over `base.font-style`.
 *
 * `theme.base_font_style = theme.base_font_style&.to_sym || :normal` (`converter.rb:573`) is the one
 * line in `prepare_theme` that can raise. `&.` guards nil and nothing else, and `to_sym` belongs to
 * String alone — so a `base: font_style:` written as a number, a boolean or a list raises
 * `NoMethodError` out of `prepare_theme`, into the bare rescue at `converter.rb:575`, and the export
 * prints the DEFAULT theme. Not the theme minus that setting: the whole document, down to the
 * settings above and below it.
 *
 * Measured against the vendored gem under ruby 3.3.3, driving `Converter#load_theme` over a project
 * theme reading `extends: default`, `zzz: 9`, `base: font_family: Courier`, `font_style: 7`:
 * `base_font_family` comes back `"Noto Serif"` and `zzz` comes back nil, with
 * `could not locate or load the pdf theme … because of NoMethodError undefined method 'to_sym' for
 * an instance of Integer; reverting to default theme` on the error log. Written as `false` it is the
 * same outcome, and written as `Courier`-style text there is no error at all.
 *
 * The value is read AFTER the loader's own conversions, which is what makes this a rule about the
 * resolved value rather than about the document's text: `base: font_style: 1 + 1` is the Integer 2
 * by the time `prepare_theme` sees it — measured, it raises — and `base: font_style: '0'` is the
 * String `"0"` and does not. A mapping cannot reach it at all, because `process_entry` recurses into
 * a Hash and writes `base_font_style_*` keys instead.
 *
 * @param values - The cascade as the loader left it.
 * @returns Whether the export discards the document over this setting.
 */
export function fontStyleRefusedAtPrepare(values: ReadonlyMap<string, unknown>): boolean {
  const style = values.get('base_font_style');
  return style !== undefined && style !== null && typeof style !== 'string';
}

/**
 * The settings the CONVERTER derives, once the loader has handed it a theme.
 *
 * `prepare_theme` (`converter.rb:569-611`), one stage after {@link deriveLoaderSettings} and the same
 * shape: assignments that fire on what Ruby calls unset, over the finished cascade. Two things make
 * it a different stage rather than more of the same one.
 *
 * The first is WHICH themes reach it. The loader's derivations are guarded by
 * `unless (::File.dirname theme_path) == ThemesDir` — a theme the gem ships skips them — while
 * `prepare_theme` runs over every theme the converter is handed, bundled or not. It makes no
 * difference here, and the reason is worth stating rather than rediscovering: of the nineteen keys
 * below, `default-theme.yml` sets eighteen, and the nineteenth (`base_font_style`) it sets to
 * `normal`. So over the gem's own default theme this derives nothing at all — measured, by diffing
 * the gem's theme table across `prepare_theme`, the only claimed key it touches there is
 * `base_font_style`, and only to turn the String `"normal"` into the Symbol `:normal`, which is the
 * same word in this module's key space. That is why the appearance shown for a project with NO theme
 * needs no pass of its own, and it is pinned by a test rather than by this paragraph.
 *
 * The second is what it means for a project theme. Because the default theme sets those eighteen
 * keys and this module always layers the default theme underneath, every one of these is reachable
 * only through a value the author wrote as `null` or `false` — and that is exactly where the preview
 * used to disagree with the export, in both directions:
 *
 * - `list: indent: null` — the field went ABSENT from the appearance, so the preview fell back to
 *   whatever the stylesheet's own rule said, against an export that indents by 0. Measured: `0` in
 *   the gem, nothing here.
 * - `list: indent: false` — the value was rejected as "not a length", the default theme's `18` was
 *   used instead, AND the author was told off for a setting the export replaces before it reads it.
 *   Measured: `0` in the gem, `18` here plus a diagnostic.
 *
 * Every one of the nineteen behaved that way; `kbd: separator: null` showed the default theme's
 * `" + "` against the export's `"+"`, and `table: border_color: null` showed `"DDDDDD"` against an
 * export that inherits `base.border-color`.
 *
 * The order is the gem's, and here it is load-bearing rather than decorative: the `transparent`
 * rewrite on the first line changes what the two border colours below inherit, and both of them read
 * `base_border_color` after it.
 *
 * Nothing here writes `base_font_style` for a value that is not text — see
 * {@link fontStyleRefusedAtPrepare}, which is the same line of the gem and has to be asked first,
 * because for those values there is no prepared theme at all.
 *
 * The copy is paid only by a document that actually reaches a derivation, for the reason given on
 * {@link deriveLoaderSettings}: a cascade holds every key the default theme sets plus every key the
 * document invented, and a theme that writes ordinary values reaches none of these.
 *
 * @param values - The cascade the loader finished with, after its own derivations.
 * @returns The cascade with the converter's settings written in, or the same map when none fired.
 */
export function derivePreparedSettings(
  values: ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  let derived: Map<string, unknown> | undefined;
  const write = (key: string, value: unknown): void => {
    (derived ??= new Map(values)).set(key, value);
  };
  const derive = (key: string, value: unknown): void => {
    if (setInRuby(values.get(key))) return;
    write(key, value);
  };
  const deriveColour = (key: string, value: unknown): void => {
    if (colourSetInRuby(values.get(key))) return;
    write(key, value);
  };

  // `theme.base_border_color = nil if theme.base_border_color == 'transparent'` — a rewrite rather
  // than a default, and the only one of the thirty-six that takes a value AWAY.
  //
  // The comparison is against the CONVERTED colour, and `to_color` answers the transparent keyword
  // for exactly one input: a String reading `transparent`. Everything else that looks like it does
  // not — measured, `[transparent]` is `"TRANSP"` in the gem's theme table (the list branch joins
  // and then falls through to the length rule, which never tests for the keyword) and `TRANSPARENT`
  // is `"TRANSP"` too, because the keyword test is case-sensitive and eleven characters long.
  //
  // So the test here is on the document's own String, not on what this module's colour reader makes
  // of it. `readColour` answers `transparent` for `[transparent]` as well — a disagreement with the
  // gem that predates this function and is recorded rather than relied on — and asking it instead
  // would have taken a border colour away from a theme whose export keeps one.
  const writtenBorderColour = values.get('base_border_color');
  const baseBorderColour = writtenBorderColour === TRANSPARENT_KEYWORD ? null : writtenBorderColour;
  if (baseBorderColour !== writtenBorderColour) write('base_border_color', null);

  // Inert twice over, and written for the reason the inert half of `deriveLoaderSettings` is: the
  // loader has already defaulted this for every project theme (nil-only, and for the same reason —
  // the value it reads has been through `to_color`), and `default-theme.yml` sets it for every theme
  // that has no project document at all. It is one line of the stage this function models, and a
  // reader who found it missing would have to re-derive from the gem that it cannot matter. Its
  // inertness is pinned by a test.
  deriveColour('base_font_color', '000000');
  derive('base_font_family', 'Helvetica');
  // The Symbol `:normal` in the gem, which is the word `normal` in this module's key space — the
  // model reads this key as one of the renderer's font-style words. Reached only for nil: every
  // other unset-looking value raises instead, and has been refused before this runs.
  derive('base_font_style', 'normal');
  derive('heading_margin_top', 0);
  derive('heading_margin_bottom', 0);
  derive('prose_margin_bottom', 0);
  derive('block_margin_bottom', 0);
  derive('list_indent', 0);
  derive('list_item_spacing', 0);
  derive('description_list_term_spacing', 0);
  derive('description_list_description_indent', 0);
  // `theme.table_border_color ||= (theme.base_border_color || '000000')`, and the same line again for
  // the thematic break. The inner `||` is Ruby's over a colour too, so it inherits whatever
  // `base.border-color` holds — including the `"0FALSE"` a colour written as `false` becomes, which
  // is a value the model then refuses and says so about, exactly as it does for `base.font-color`.
  const inheritedBorderColour = colourSetInRuby(baseBorderColour) ? baseBorderColour : '000000';
  deriveColour('table_border_color', inheritedBorderColour);
  derive('table_border_width', 0.5);
  deriveColour('thematic_break_border_color', inheritedBorderColour);
  derive('callout_list_margin_top_after_code', 0);
  derive('footnotes_item_spacing', 0);
  derive('kbd_separator', '+');
  derive('toc_indent', 0);

  return derived ?? values;
}
