import { DEFAULT_THEME_YAML } from '../../src/render-config/default-theme.generated';
import { parseThemeDocument } from '../../src/print-appearance/parse-theme';
import { CLAIMED_THEME_KEYS } from '../../src/print-appearance/resolve-appearance';
import type { ResolvableEntry } from '../../src/print-appearance/resolve-values';
import {
  createExpansionBudget,
  deriveLoaderSettings,
  derivePreparedSettings,
  evaluateExpression,
  fontStyleRefusedAtPrepare,
  PREPARE_THEME_UNMODELLED_KEYS,
  resolveThemeValues,
} from '../../src/print-appearance/resolve-values';
import { parseColour } from '../../src/print-appearance/units';

/** Resolve a list of `key: value` pairs and return the resulting flat value map as a plain object. */
function resolve(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const { values } = resolveThemeValues(entries.map(([key, value]) => ({ key, value })));
  return Object.fromEntries(values);
}

describe('evaluateExpression', () => {
  it.each([
    ['10.5 * 1.25', 13.125],
    ['12 / 10.5', 12 / 10.5],
    ['12 - 4', 8],
    ['12 + 4', 16],
    ['2 ^ 3', 8],
  ])('evaluates %s', (expression, expected) => {
    expect(evaluateExpression(expression)).toBeCloseTo(expected, 10);
  });

  it('reduces multiplication before addition, as the renderer does', () => {
    // `$horizontal_rhythm + $quote_border_left_width / 2` with 12 and 4 must be 14, not 8.
    expect(evaluateExpression('12 + 4 / 2')).toBe(14);
  });

  it.each([
    ['10 - 3 - 2 - 1', 6],
    ['100 / 5 / 2 / 2', 20],
    ['20 - 1 - 2 - 3 - 4', 20 - 1 - (2 - 3) - 4],
    ['2 ^ 3 ^ 2', (2 ** 3) ** 2],
  ])('folds %s in non-overlapping pairs per pass, as gsub does', (expression, expected) => {
    // The renderer reduces with `expr.gsub(AddSubtractOpRx) { … }` (theme_loader.rb:248), and `gsub`
    // replaces every NON-OVERLAPPING match in one sweep: the right operand of a fold is consumed and
    // cannot become the left operand of the next until the following pass. `10 - 3 - 2 - 1` is
    // therefore `7 - 1` and then 6. Folding one operation at a time, left to right — which reads like
    // left-associativity — gives 4, and disagrees with the export on every chain of four or more
    // non-associative terms.
    expect(evaluateExpression(expression)).toBeCloseTo(expected, 10);
  });

  it.each([
    ['round(13.125)', 13],
    ['floor(27.3)', 27],
    ['ceil(10.5)', 11],
    ['round(10.5 * 1.25)', 13],
    ['floor(10.5 * 2.6)', 27],
  ])('applies %s', (expression, expected) => {
    expect(evaluateExpression(expression)).toBe(expected);
  });

  it('rounds a half away from zero, which differs from the platform default below zero', () => {
    expect(evaluateExpression('round(-0.5)')).toBe(-1);
    expect(evaluateExpression('round(0.5)')).toBe(1);
  });

  it('converts a unit term to points before evaluating around it', () => {
    expect(evaluateExpression('0.5in')).toBe(36);
    expect(evaluateExpression('0.67in')).toBeCloseTo(48.24, 10);
    expect(evaluateExpression('1in + 36')).toBe(108);
  });

  it('converts a unit term only at a term boundary, not a digit-and-unit inside a word', () => {
    // The renderer bounds the substitution by start-of-string, space or `(` on the left and
    // end-of-string, space or `)` on the right — so a space-delimited `12pt` IS a term wherever it
    // appears, while `Grade12pt` is one word and stays one word.
    expect(evaluateExpression('Grade12pt Display')).toBe('Grade12pt Display');
  });

  it('reads a changed expression as a number, keeping only its leading digits', () => {
    // CHANGED EXPECTATION: this asserted the string `'12 Display'`. `evaluate_math` ends with
    // `(int_val = expr.to_i) == (flt_val = expr.to_f) ? int_val : flt_val`
    // (theme_loader.rb:263), and BOTH of Ruby's conversions take a leading numeric prefix and discard
    // the rest — so once the substitution has changed anything, the renderer returns the Integer 12
    // rather than a string with the unit taken out of it. The old expectation encoded a value the
    // export never produces.
    expect(evaluateExpression('12pt Display')).toBe(12);
    expect(evaluateExpression('Display 12pt')).toBe(0);
  });

  it('leaves an expression it cannot evaluate exactly as written', () => {
    expect(evaluateExpression('bold')).toBe('bold');
    expect(evaluateExpression('$unknown_thing')).toBe('$unknown_thing');
    expect(evaluateExpression('10.5*1.25')).toBe('10.5*1.25');
  });

  it('leaves a hexadecimal colour alone rather than reading it as a number', () => {
    expect(evaluateExpression('000000')).toBe('000000');
    expect(evaluateExpression('FF0000')).toBe('FF0000');
  });
});

describe('resolveThemeValues', () => {
  it('expands a lone reference to the value itself, keeping its type', () => {
    expect(resolve([['base_font_size', 10.5], ['heading_h5_font_size', '$base_font_size']])).toEqual({
      base_font_size: 10.5,
      heading_h5_font_size: 10.5,
    });
  });

  it('expands a reference inside a larger expression and evaluates the result', () => {
    expect(
      resolve([
        ['base_font_size', 10.5],
        ['base_font_size_large', 'round($base_font_size * 1.25)'],
        ['role_lead_font_size', '$base_font_size_large'],
      ]),
    ).toEqual({ base_font_size: 10.5, base_font_size_large: 13, role_lead_font_size: 13 });
  });

  it('resolves a reference whose name is written with hyphens', () => {
    expect(resolve([['base_font_size', 11], ['x_size', '$base-font-size']])).toEqual({
      base_font_size: 11,
      x_size: 11,
    });
  });

  it('negates a leading-minus reference', () => {
    expect(
      resolve([['block_margin_bottom', 12], ['callout_list_margin_top_after_code', '-$block_margin_bottom / 2']]),
    ).toEqual({ block_margin_bottom: 12, callout_list_margin_top_after_code: -6 });
  });

  it('resolves each element of an inset array independently', () => {
    expect(
      resolve([
        ['vertical_rhythm', 12],
        ['horizontal_rhythm', 12],
        ['admonition_padding', ['$vertical_rhythm / 3.0', '$horizontal_rhythm', '$vertical_rhythm / 3.0', '$horizontal_rhythm']],
      ]).admonition_padding,
    ).toEqual([4, 12, 4, 12]);
  });

  it('carries a whole array through a lone reference, as verse padding does from quote', () => {
    expect(resolve([['quote_padding', [3, 12, 3, 14]], ['verse_padding', '$quote_padding']]).verse_padding).toEqual([
      3, 12, 3, 14,
    ]);
  });

  it('resolves only against values already loaded, so a forward reference stays unresolved', () => {
    // The renderer expands eagerly in document order; resolving forward would make the preview more
    // capable than the export, which is a worse failure than leaving the reference visible.
    const { values, unresolved } = resolveThemeValues([
      { key: 'a_size', value: '$b_size' },
      { key: 'b_size', value: 12 },
    ]);
    expect(values.get('a_size')).toBe('$b_size');
    expect(unresolved).toEqual([{ key: 'a_size', reference: '$b_size' }]);
  });

  it('reports a reference that names no setting and leaves it visible in the value', () => {
    const { values, unresolved } = resolveThemeValues([{ key: 'code_font_size', value: '$no_such_key * 2' }]);
    expect(values.get('code_font_size')).toBe('$no_such_key * 2');
    expect(unresolved).toEqual([{ key: 'code_font_size', reference: '$no_such_key' }]);
  });

  it('does not run arithmetic over a colour', () => {
    // `000000` is a colour, not zero, and a hyphenated colour word is text rather than subtraction.
    expect(resolve([['base_font_color', '000000'], ['heading_font_color', '$base_font_color']])).toEqual({
      base_font_color: '000000',
      heading_font_color: '000000',
    });
  });

  it('does not run arithmetic over a content string', () => {
    expect(resolve([['footer_recto_right_content', '{page-number} - 1']]).footer_recto_right_content).toBe(
      '{page-number} - 1',
    );
  });

  it('reads a content template as text, however the document happened to write it', () => {
    // `(expand_vars val.to_s, data).to_s` (theme_loader.rb:190). The loader quotes a bare hexadecimal
    // run only on a key ending in `color`, so `menu_caret_content: 123456` reaches this cascade as a
    // NUMBER — and every reader of a template takes a string, so without the conversion the setting
    // would be dropped and the key fall back to a default the export never used.
    expect(resolve([['menu_caret_content', 123_456]]).menu_caret_content).toBe('123456');
    expect(resolve([['button_content', true]]).button_content).toBe('true');
    // A list has no shared spelling between the two sides, so it is left as it was written.
    expect(resolve([['button_content', [1, 2]]]).button_content).toEqual([1, 2]);
  });

  it('applies inherited values as the base of the cascade', () => {
    const parent = resolveThemeValues([{ key: 'base_font_size', value: 10.5 }]);
    const child = resolveThemeValues([{ key: 'heading_h4_font_size', value: '$base_font_size * 2' }], parent.values);
    expect(child.values.get('heading_h4_font_size')).toBe(21);
  });

  it('lets a child override a value without changing what earlier entries already resolved to', () => {
    const parent = resolveThemeValues([
      { key: 'base_font_size', value: 10 },
      { key: 'heading_h5_font_size', value: '$base_font_size' },
    ]);
    const child = resolveThemeValues([{ key: 'base_font_size', value: 20 }], parent.values);
    expect(child.values.get('heading_h5_font_size')).toBe(10);
    expect(child.values.get('base_font_size')).toBe(20);
  });

  it('rewrites a zero bottom padding to match its top, as the renderer does for legacy themes', () => {
    expect(resolve([['sidebar_padding', [12, 12, 0, 12]]]).sidebar_padding).toEqual([12, 12, 12, 12]);
  });

  it('leaves a padding whose bottom edge is genuinely set', () => {
    expect(resolve([['sidebar_padding', [12, 12, 6, 12]]]).sidebar_padding).toEqual([12, 12, 6, 12]);
  });

  it.each([
    ['one element', [12], [12, undefined, 12]],
    ['no elements', [], [undefined, undefined, undefined]],
    ['two elements', [12, 4], [12, 4, 12]],
  ])('GROWS a padding written with %s, as the renderer does by indexing off the end', (_label, wrote, expected) => {
    // `val[2] = val[0] if ::Array === val && val[0].to_f >= 0 && val[2].to_f <= 0` indexes past the
    // end: for `[12]`, `val[2]` is `nil`, `nil.to_f` is zero, the test holds, and the assignment
    // EXTENDS the array. Returning early below three elements left it alone. Run against the vendored
    // gem under ruby 3.3.3, `example: padding: [12]` comes back `[12, nil, 12]` — which
    // `expand_padding_value` reads as `[12, 0, 12, 0]` — against `[12, 12, 12, 12]` for the array left
    // as written. Left and right insets differing by 12 pt wraps every line in the block differently.
    for (const key of ['example_padding', 'quote_padding', 'sidebar_padding', 'verse_padding']) {
      expect({ key, padding: resolve([[key, wrote]])[key] }).toEqual({ key, padding: expected });
    }
  });

  it('leaves a padding alone where the renderer would raise rather than rewrite', () => {
    // `true.to_f` and `[1].to_f` are both `NoMethodError`, so there is no export behaviour to
    // reproduce — and coercing instead would invent one, since `Number(true)` is 1.
    expect(resolve([['verse_padding', [true, 1]]]).verse_padding).toEqual([true, 1]);
    expect(resolve([['verse_padding', [[1], 1]]]).verse_padding).toEqual([[1], 1]);
  });

  it('reads a content template as text AFTER expanding it, not only before', () => {
    // `(expand_vars val.to_s, data).to_s` (`theme_loader.rb:190`) converts twice. Only the first
    // conversion was reproduced, so a template that is one lone reference came back as whatever the
    // reference named — the Number 12 — and every reader downstream requires a string, so the setting
    // vanished while the export drew `12`. Verified against the vendored gem under ruby 3.3.3:
    // `menu_caret_content` and `button_content` both come back `"12"`.
    const values = resolve([
      ['base_font_size', 12],
      ['menu_caret_content', '$base_font_size'],
      ['button_content', '$base_font_size'],
    ]);
    expect(values.menu_caret_content).toBe('12');
    expect(values.button_content).toBe('12');
  });

  it('still declines to invent the export’s text for a template Ruby spells differently', () => {
    // The other half of the same rule, and the reason the conversion is not simply `String`. A
    // COLLECTION is the value the two languages have no shared spelling for: measured against the gem,
    // a list is `"[1, 2]"` there — `inspect`, punctuation and quotes and all — and would be `"1,2"`
    // here, so it is left as it was written and the key falls back to its default rather than to a
    // string this side made up. An empty value used to be asserted here beside it and did not belong:
    // `nil.to_s` is the empty string EXACTLY, so there is nothing to invent. See the test below.
    expect(resolve([['button_content', [1, 2]]]).button_content).toEqual([1, 2]);
    expect(resolve([['x', [7, 8]], ['menu_caret_content', '$x']]).menu_caret_content).toEqual([7, 8]);
  });

  it('converts an empty template to the empty string the export stores', () => {
    // `(expand_vars val.to_s, data).to_s` (`theme_loader.rb:190`) converts a nil at BOTH ends — before
    // the expansion and again after it — so a template written empty and a template that is one lone
    // reference to an empty value are both `""` in the gem's theme table, measured under ruby 3.3.3.
    // This left them as nil; every reader of a template requires a string, so the setting was dropped
    // and the key fell back to a default caret the export never drew.
    expect(resolve([['button_content', null]]).button_content).toBe('');
    expect(resolve([['v', null], ['menu_caret_content', '$v']]).menu_caret_content).toBe('');
    // And nothing else is emptied with it. Ruby has no falsiness for this branch to follow: measured,
    // `caret_content: false` is `"false"` in the theme table and `caret_content: 0` is `"0"`, so a
    // conversion written as a truthiness test would draw an empty caret over both.
    expect(resolve([['button_content', false]]).button_content).toBe('false');
    expect(resolve([['button_content', 0]]).button_content).toBe('0');
  });

  it.each([
    ['a template, whose own to_s runs either side of the expansion', 'menu_caret_content', 'x$v', 'x'],
    ['a plain setting, where the substitution is the only conversion', 'kbd_separator', '+$v', '+'],
    ['a colour, which the length rule then pads out to six', 'base_font_color', '00$v', '00'],
  ])('writes nothing where an empty value is interpolated into %s', (_label, key, wrote, stored) => {
    // `expr.gsub(VariableRx) { resolve_var vars, $&, $1 }` (`theme_loader.rb:214`) — `gsub` writes the
    // block's answer out with `to_s`, so the reference contributes nothing and the text closes up over
    // it. What the cascade holds is the expansion, before any key's own reading of it: `"x"`, `"+"`
    // and `"00"`, against the `"xnull"`, `"+null"` and `"00null"` `String(null)` built. `to_color`
    // pads that last one to the black the export inks — see the appearance tests.
    expect(resolve([['v', null], [key, wrote]])[key]).toBe(stored);
  });

  it.each([
    ['false, whose word both languages write out', false, '+false'],
    ['zero, which is empty to neither of them', 0, '+0'],
    ['an empty string, which is empty because it already IS one', '', '+'],
  ])('interpolates %s rather than emptying it', (_label, value, stored) => {
    // `nil` is emptied because `nil.to_s` IS the empty string, and for no other reason — Ruby has no
    // falsiness here to follow. Measured against the gem: `"+false"`, `"+0"` and `"+"`. A substitution
    // written as a truthiness test would pass every assertion above and lose all three of these.
    expect(resolve([['v', value], ['kbd_separator', '+$v']]).kbd_separator).toBe(stored);
  });

  it('empties a reference inside an element without stringifying the list around it', () => {
    // The substitution runs per ELEMENT, so a channel is emptied while the list is still a list:
    // measured, `[1$v, 0, 0]` is the RGB triple `["1", 0, 0]` in the theme table, which `sprintf
    // '%02X'` reads as `010000`, where `1null` is a channel it raises `ArgumentError` on and the whole
    // document was thrown away.
    expect(resolve([['v', null], ['base_font_color', ['1$v', 0, 0]]]).base_font_color).toEqual(['1', 0, 0]);
  });

  it('leaves a lone reference to an empty value as the nil the export stores', () => {
    // A lone reference hands back the VALUE, never its text — `resolve_var` is returned directly and
    // no `to_s` runs — so the gem's theme table holds `nil` and the key is unset. Emptying it to `""`
    // instead would be a font size of zero and a border colour of black, neither of which is written.
    expect(resolve([['v', null], ['base_font_size', '$v']]).base_font_size).toBeNull();
    expect(resolve([['v', null], ['base_font_color', '$v']]).base_font_color).toBeNull();
  });

  it.each([
    ['nothing on its left', '$v * 2', ' * 2'],
    ['nothing on its right', '2 * $v', '2 * '],
    ['nothing on the right of an addition', '2 + $v', '2 + '],
    ['nothing at all', '$v$v', ''],
  ])('leaves arithmetic with %s as the text the export keeps', (_label, wrote, stored) => {
    // Emptying a reference does not make an expression evaluate. `evaluate_math` needs an operand on
    // each side of its operator and finds none, so it hands back the reduced TEXT and the converter
    // draws its own default — measured, each of these strings is what the gem's theme table holds.
    expect(resolve([['v', null], ['base_font_size', wrote]]).base_font_size).toBe(stored);
  });

  it('reads an emptied rounding argument as the zero Ruby’s to_f gives it', () => {
    // The one arithmetic shape that does reduce: `round()` reads its argument with `to_f` and
    // `"".to_f` is `0.0`, so the gem's theme table holds the Integer `0`.
    expect(resolve([['v', null], ['base_font_size', 'round($v)']]).base_font_size).toBe(0);
  });

  it('leaves a non-string value untouched', () => {
    expect(resolve([['table_cell_padding', 3], ['page_layout', true]])).toEqual({
      table_cell_padding: 3,
      page_layout: true,
    });
  });

  it('terminates on an expression whose operator characters never reduce', () => {
    expect(evaluateExpression('a * b')).toBe('a * b');
    expect(evaluateExpression('1 * ')).toBe('1 * ');
  });

  it('stays fast on the shapes a crafted theme value would use to stall the parser', () => {
    // Theme text is untrusted and this runs behind a keystroke, so each of these is sized to what a
    // theme document may ACTUALLY hold — `parseThemeDocument` reads up to 512 KB, and one setting may
    // be all of it. The old fixture used `'1 + '.repeat(5000)`, twenty kilobytes, which the quadratic
    // reducer finished in 347 ms against a two-second bar while the reachable 120 KB took 27 seconds
    // and 512 KB was minutes; the comment claiming "none of these is more than linear work" was
    // false. Tokenising is a single forward scan, and each reducing pass consumes at least half the
    // foldable terms, so the reducer is linearithmic and this fixture finishes in a few tens of
    // milliseconds.
    const pathological = [
      `${'9'.repeat(120_000)} * 2`,
      `${'1 + '.repeat(120_000)}1`,
      `${'1 - '.repeat(120_000)}1`,
      `${'2 * '.repeat(60_000)}2`,
      `${' '.repeat(200_000)}* `,
      `round(${'('.repeat(100_000)}`,
      `${'9'.repeat(200_000)} * `,
    ];
    for (const expression of pathological) {
      expect(expression.length).toBeLessThanOrEqual(512 * 1024);
    }
    const started = process.hrtime.bigint();
    for (const expression of pathological) evaluateExpression(expression);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('reports a value whose references expand without bound rather than throwing', () => {
    // `$a $a` doubles a string at every level of indirection: twenty-six levels is under 400 bytes of
    // theme text and reaches the platform's own maximum string length, which `String#replaceAll`
    // signals by THROWING — on the thread that renders the preview, from a `useMemo`, with nothing
    // between it and the user. The expansion is bounded and the key is reported instead.
    const chain = ['a0: xxxxxxxx'];
    for (let level = 1; level <= 30; level++) chain.push(`a${level}: $a${level - 1} $a${level - 1}`);
    const started = process.hrtime.bigint();
    const { values, oversized } = resolveThemeValues(
      chain.map((line) => {
        const [key, value] = line.split(': ');
        return { key, value };
      }),
    );
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // Every level that could not be followed is named, and no value the cascade carries is anywhere
    // near the four gigabytes the unbounded doubling reaches by level thirty.
    expect(oversized.length).toBeGreaterThan(0);
    for (const [key, value] of values) {
      expect({ key, bounded: typeof value !== 'string' || value.length < 10_000 }).toEqual({
        key,
        bounded: true,
      });
    }
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('spends a bounded total on expansion however many values ask for one', () => {
    // The per-value bound alone leaves the SUM unbounded: a 512 KB document holds tens of thousands
    // of settings, and each of them may expand to the per-value cap.
    const entries: { key: string; value: unknown }[] = [{ key: 'seed', value: 'x'.repeat(2000) }];
    for (let index = 0; index < 20_000; index++) {
      entries.push({ key: `k${index}`, value: '$seed $seed' });
    }
    const started = process.hrtime.bigint();
    const { oversized } = resolveThemeValues(entries);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(oversized.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('spends ONE allowance across the passes of a single resolution', () => {
    // The bound is a property of the resolution, and a resolution is several passes: two over the
    // entries, split where the font catalogue sits, plus one expansion per catalogue path and per
    // fallback. Each of those used to mint an allowance of its own, so what reads as a global cap
    // capped nothing above a single value. Threading one budget is what makes the second pass see
    // what the first spent.
    //
    // Fails with a budget per call: the second pass starts full, resolves everything, and reports
    // nothing oversized.
    const budget = createExpansionBudget();
    const seed: ResolvableEntry[] = [{ key: 'seed', value: 'x'.repeat(2000) }];
    // Each of these expands to 4,001 characters, so 1,500 of them spend about six of the eight
    // megabytes one resolution may build: under the bound alone, over it between them.
    const many = (from: number): ResolvableEntry[] =>
      Array.from({ length: 1500 }, (_unused, index) => ({
        key: `k${from + index}`,
        value: '$seed $seed',
      }));

    const first = resolveThemeValues([...seed, ...many(0)], new Map(), budget);
    const second = resolveThemeValues(many(1500), first.values, budget);
    // The first pass alone does not exhaust it — otherwise the second would be over budget whether or
    // not the two share one, and the assertion below would hold for the wrong reason.
    expect(first.oversized.length).toBe(0);
    expect(second.oversized.length).toBeGreaterThan(0);
  });

  it('keeps the dangling-reference log to what a caller can read, not to what a theme can name', () => {
    // The expansion budget is counted in characters of VALUE, and a dangling reference is not paid
    // for in that currency: `$q ` is three characters of theme and buys a seventy-byte record, so the
    // eight megabytes of expansion one resolution may perform bought about 2.8 million of them — to
    // build a list the caller truncates to fifty rows. Measured end to end, one anchored 4 KB value
    // packed with `$q` and aliased from two thousand settings took 1,229 ms and 304 MB of heap,
    // against 373 ms and 11 MB for the identical document with `$q` defined.
    //
    // Fails with the collection uncapped: `unresolved.length` is 2000 × 1365.
    const references = Math.floor(4095 / 3);
    const packed = `$q `.repeat(references).trimEnd();
    const entries: ResolvableEntry[] = Array.from({ length: 2000 }, (_unused, index) => ({
      key: `k${index}`,
      value: packed,
    }));
    // What the document ASKS for, so the bound below is not being asserted against a small number.
    // Deliberately not a timing bar: the expansion these entries buy is charged and legitimate, so a
    // wall-clock assertion would be measuring the budget rather than the log, and it sat close enough
    // to two seconds to turn coverage instrumentation into a failure.
    expect(entries.length * references).toBeGreaterThan(2_700_000);

    const { unresolved } = resolveThemeValues(entries);
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.length).toBeLessThanOrEqual(512);
  });

  it('still reports every dangling reference a theme anyone writes has', () => {
    // The cap has to be above what a caller shows, or it would be a second defect wearing the first
    // one's clothes — a document whose problems stop being reported because an earlier document could
    // be made to report too many. Each record is kept once, by the same identity the caller
    // deduplicates by, so a document below the cap is reported exactly as it was.
    const entries: ResolvableEntry[] = Array.from({ length: 60 }, (_unused, index) => ({
      key: `k${index}`,
      value: `$missing${index} $missing${index}`,
    }));
    const { unresolved } = resolveThemeValues(entries);
    // Sixty settings, each naming one absent variable twice: sixty DISTINCT records.
    expect(unresolved).toEqual(
      Array.from({ length: 60 }, (_unused, index) => ({
        key: `k${index}`,
        reference: `$missing${index}`,
      })),
    );
  });
});

describe('resolveThemeValues over a colour list the loader reads element by element', () => {
  it('converts each element BEFORE anything joins it, for the two keys that take a list', () => {
    // `data[key] = val.map {|it| to_color evaluate it, data, math: false }` (`theme_loader.rb:185`).
    // Measured against the vendored gem under ruby 3.3.3 over `extends: default`:
    // `table: border_color: [1, 2]` is `["000001", "000002"]` in the theme table and
    // `table: grid_color: [1, 2]` is the same — where joining the raw list first made `"000012"`,
    // one colour out of two and not either of the ones written.
    expect(resolve([['table_border_color', [1, 2]]])['table_border_color']).toEqual([
      '000001',
      '000002',
    ]);
    expect(resolve([['table_grid_color', [1, 2]]])['table_grid_color']).toEqual(['000001', '000002']);
  });

  it.each([
    ['a list of one', [1], ['000001']],
    ['a list of three', [10, 20, 30], ['000010', '000020', '000030']],
    ['a list of four, which is four SIDES and not a CMYK colour', [1, 2, 3, 4], ['000001', '000002', '000003', '000004']],
    ['an element the document left empty', [null, 2], [null, '000002']],
    ['an element that is itself a list', [[1], 2], ['000001', '000002']],
    ['an element that is itself an RGB triple', [[1, 2, 3], 2], ['010203', '000002']],
    ['an element that is itself a CMYK literal', [[0, 0, 0, 0], 2], ['FFFFFF', '000002']],
    ['an empty list, which stays one', [], []],
  ])('reads the border list as colours in their own right: %s', (_label, written, expected) => {
    // Every row measured against the vendored gem under ruby 3.3.3 over `extends: default`, reading
    // `table_border_color` out of the theme table. The four-element row is the one worth naming: a
    // four-element list under any OTHER colour key is a CMYK colour, and under this key it is four
    // sides.
    expect(resolve([['table_border_color', written]])['table_border_color']).toEqual(expected);
  });

  it('reads a grid list of any other length as ONE colour, which is the loader’s own test', () => {
    // `key == 'table_grid_color' && ::Array === val && val.size == 2`. Measured against the vendored
    // gem under ruby 3.3.3 over `extends: default`: `[1, 2, 3]` is `"010203"` in the theme table —
    // one RGB triple — `[1]` is `"000001"`, the joined value, and `[0, 0, 0, 0]` is `"FFFFFF"`, a
    // CMYK literal. None of the three is a list, so none of them is a shorthand for two axes.
    //
    // This module converts a value it did NOT read per element where the value is read, so what the
    // cascade holds for those three is the document's own text — and `parseColour` makes the gem's
    // answer of each.
    for (const written of [[1, 2, 3], [1], [0, 0, 0, 0]]) {
      expect(resolve([['table_grid_color', written]])['table_grid_color']).toEqual(written);
    }
    expect(parseColour(resolve([['table_grid_color', [1, 2, 3]]])['table_grid_color'])).toBe('010203');
    expect(parseColour(resolve([['table_grid_color', [1]]])['table_grid_color'])).toBe('000001');
    expect(parseColour(resolve([['table_grid_color', [0, 0, 0, 0]]])['table_grid_color'])).toBe(
      'FFFFFF',
    );
  });

  it('leaves every other colour key’s list to be joined whole', () => {
    // The suffix is not the test. Measured against the vendored gem under ruby 3.3.3 over
    // `extends: default`, each written `[1, 2]`: `thematic_break_border_color` is `"000012"` and so
    // is `base_border_color`. Converting those per element would have made a colour the export does
    // not hold and a shorthand the export does not expand.
    expect(resolve([['thematic_break_border_color', [1, 2]]])['thematic_break_border_color']).toEqual([
      1, 2,
    ]);
    expect(resolve([['base_border_color', [1, 2]]])['base_border_color']).toEqual([1, 2]);
  });

  it('hands a later $reference the CONVERTED list, which is what the theme table holds', () => {
    // The reason this belongs at load rather than at read. `resolve_var` answers with whatever the
    // table holds, so a key referring to the border list gets the converted elements and joins
    // THOSE. Measured against the vendored gem under ruby 3.3.3:
    // `table: border_color: [1, 2]` with `thematic_break: border_color: $table_border_color` leaves
    // `thematic_break_border_color` as `"000001"` — the twelve joined characters cut to six — where
    // a cascade holding the raw list would have found `"000012"`.
    const values = resolve([
      ['table_border_color', [1, 2]],
      ['thematic_break_border_color', '$table_border_color'],
    ]);
    expect(values['thematic_break_border_color']).toEqual(['000001', '000002']);
    expect(parseColour(values['thematic_break_border_color'])).toBe('000001');
  });

  it('reads a list a LONE reference carried in as one colour, which is the branch the gem took', () => {
    // `::Array === val` tests `process_entry`'s argument, and the expansion happens inside the
    // branch it chooses — so the shape that decides this is the one the DOCUMENT wrote. Measured
    // against the vendored gem under ruby 3.3.3 over `extends: default`: `v: [1, 2]` with
    // `table: border_color: $v` is `"000012"` in the theme table, where the same list written out is
    // `["000001", "000002"]`. Reading the expanded value instead made the reference a shorthand for
    // two sides and painted `000001`, a colour the export does not hold.
    const referenced = resolve([
      ['v', [1, 2]],
      ['table_border_color', '$v'],
    ]);
    expect(referenced['table_border_color']).toEqual([1, 2]);
    expect(parseColour(referenced['table_border_color'])).toBe('000012');

    // A list OF references is still a list, and so is one a YAML alias carried in — the alias is
    // resolved before the loader sees the value. Measured, both are `["000001", "000002"]`.
    const references = resolve([
      ['a', 1],
      ['b', 2],
      ['table_border_color', ['$a', '$b']],
    ]);
    expect(references['table_border_color']).toEqual(['000001', '000002']);
  });

  it('refuses the document over a reference that turned a list INTO an RGB triple', () => {
    // The pair that shows the branch is decided before the expansion and the raise after it.
    // Measured against the vendored gem under ruby 3.3.3 over `extends: default`:
    // `table: border_color: [a, 0, 0]` loads and stores three colours, while `v: [a, 0, 0]` with
    // `table: border_color: $v` raises `ArgumentError: invalid value for Integer(): "a"` — one RGB
    // triple, and the document is thrown away. `[[a, 0, 0], 2]` is the same pair the other way
    // round: written out it raises, and through a reference it is the joined `"00A002"`.
    expect(
      resolveThemeValues([
        { key: 'v', value: ['a', 0, 0] },
        { key: 'table_border_color', value: '$v', line: 3 },
      ]).refusedColour,
    ).toEqual({ key: 'table_border_color', line: 3 });
    expect(
      resolveThemeValues([
        { key: 'v', value: [['a', 0, 0], 2] },
        { key: 'table_border_color', value: '$v', line: 3 },
      ]).refusedColour,
    ).toBeUndefined();
  });

  it('does not convert a renamed key, which never reaches the colour branch at all', () => {
    // `process_entry` tries its branches in ORDER and the deprecated-key branch is reached first,
    // storing its value with no conversion — the case `math: false` already marks everywhere else in
    // this module.
    const { values } = resolveThemeValues([
      { key: 'table_border_color', value: [1, 2], math: false },
    ]);
    expect(values.get('table_border_color')).toEqual([1, 2]);
  });

  it('still refuses the document over an ELEMENT that raises', () => {
    // A list read element by element raises nothing for `[a, 0, 0]` — three colours, none of which
    // is an RGB triple — but an element that is ITSELF a triple is one, and `sprintf '%02X', 'a'`
    // raises out of `process_entry` into `load_theme`'s bare rescue exactly as it does anywhere
    // else. Measured against the vendored gem under ruby 3.3.3:
    // `table: border_color: [[a, 0, 0], 2]` raises `ArgumentError: invalid value for Integer(): "a"`,
    // where `table: border_color: [a, 0, 0]` loads and stores `["00000A", "000000", "000000"]`.
    expect(
      resolveThemeValues([{ key: 'table_border_color', value: [['a', 0, 0], 2], line: 3 }])
        .refusedColour,
    ).toEqual({ key: 'table_border_color', line: 3 });
    expect(
      resolveThemeValues([{ key: 'table_border_color', value: ['a', 0, 0], line: 3 }]).refusedColour,
    ).toBeUndefined();
  });
});

describe('resolveThemeValues when the loader would refuse the whole document', () => {
  it('answers with exactly ONE refusal, whichever of the three it reaches first', () => {
    // The three kinds are three fields, and the reader chooses between them by reading which one is
    // set — which is only sound if a pass never sets two. `to_color` and the padding rewrite are
    // guarded by the same `alreadyRefused` test as each other, and the negation's own guard has to
    // count them all, or a negation followed by a bad colour records both and the invariant the
    // reader rests on quietly stops holding.
    //
    // A negation raises inside `expand_vars`, which runs before `to_color` and before the padding
    // rewrite, so the FIRST of the three in document order is the negation here — measured against
    // the vendored gem under ruby 3.3.3: `v: true\nzzz: -$v\nbase:\n  font_color: [a, 0, 0]` raises
    // `TypeError`, and the same colour on its own raises `ArgumentError`.
    const negationFirst = resolveThemeValues([
      { key: 'v', value: true },
      { key: 'zzz', value: '-$v', line: 2 },
      { key: 'base_font_color', value: ['a', 0, 0], line: 4 },
      { key: 'example_padding', value: [true, 0, 0], line: 6 },
    ]);
    expect({
      negation: negationFirst.refusedNegation,
      colour: negationFirst.refusedColour,
      padding: negationFirst.refusedPadding,
    }).toEqual({ negation: { key: 'zzz', line: 2 }, colour: undefined, padding: undefined });

    // …and the other way round, so the answer is the document's order rather than a preference
    // baked into whoever reads the three fields.
    const colourFirst = resolveThemeValues([
      { key: 'v', value: true },
      { key: 'base_font_color', value: ['a', 0, 0], line: 2 },
      { key: 'zzz', value: '-$v', line: 4 },
    ]);
    expect({
      negation: colourFirst.refusedNegation,
      colour: colourFirst.refusedColour,
      padding: colourFirst.refusedPadding,
    }).toEqual({ negation: undefined, colour: { key: 'base_font_color', line: 2 }, padding: undefined });

    // The third pair, which neither of the two above reaches: a PADDING refusal written above a
    // negation. The negation's guard names all three fields, and nothing had ever set the padding
    // one before it — so a guard that had dropped `refusedPadding` from its test would have recorded
    // both here, and the reader that chooses between three fields by asking which is set would have
    // been handed two. Measured against the vendored gem under ruby 3.3.3:
    // `v: true\nexample_padding: [true, 0, 0]\nzzz: -$v` raises
    // `NoMethodError: undefined method 'to_f' for true` — the padding, which is written first —
    // where the same document with the two lines swapped raises `TypeError` over the negation.
    const paddingFirst = resolveThemeValues([
      { key: 'v', value: true },
      { key: 'example_padding', value: [true, 0, 0], line: 2 },
      { key: 'zzz', value: '-$v', line: 4 },
    ]);
    expect({
      negation: paddingFirst.refusedNegation,
      colour: paddingFirst.refusedColour,
      padding: paddingFirst.refusedPadding,
    }).toEqual({ negation: undefined, colour: undefined, padding: { key: 'example_padding', line: 2 } });
  });

  it('keeps reading a negation the loader turned into text before it could raise', () => {
    // `(expand_vars val.to_s, data).to_s` (`theme_loader.rb:190`) converts the WHOLE value first, so
    // a list under a content key reaches the expansion as `[1, "-$v", 2]` and nothing in it is a
    // lone reference. `LoneVariableRx` is anchored and only the lone form reaches `'-' + val`.
    // Measured against the vendored gem under ruby 3.3.3: `v: []\nzzz:\n  content: [1, -$v, 2]`
    // LOADS, storing `zzz_content => "[1, \"-[]\", 2]"` — while `content: -$v` raises `TypeError`,
    // and so does the same list under a key that is not a content key.
    //
    // Descending the list found a negation the export never sees, and refused the whole document
    // over it: the default page, for a theme the export prints in full.
    const inAList = resolveThemeValues([
      { key: 'v', value: [] },
      { key: 'zzz_content', value: [1, '-$v', 2], line: 2 },
    ]);
    expect(inAList.refusedNegation).toBeUndefined();
    // The document's own value, unexpanded: the export holds text this module does not invent, and
    // half of it would be neither.
    expect(inAList.values.get('zzz_content')).toEqual([1, '-$v', 2]);

    // The two contrasts that keep the refusal where the export raises. The whole value…
    const asTheValue = resolveThemeValues([
      { key: 'v', value: [] },
      { key: 'zzz_content', value: '-$v', line: 2 },
    ]);
    expect(asTheValue.refusedNegation).toEqual({ key: 'zzz_content', line: 2 });
    // …and the same list under a key the content branch is not reached from.
    const otherKey = resolveThemeValues([
      { key: 'v', value: [] },
      { key: 'zzz_other', value: [1, '-$v', 2], line: 2 },
    ]);
    expect(otherKey.refusedNegation).toEqual({ key: 'zzz_other', line: 2 });
    // …and a renamed key, which takes the deprecated branch above the content one and is never
    // stringified: `math: false` is the flag that marks it.
    const renamed = resolveThemeValues([
      { key: 'v', value: [] },
      { key: 'zzz_content', value: [1, '-$v', 2], line: 2, math: false },
    ]);
    expect(renamed.refusedNegation).toEqual({ key: 'zzz_content', line: 2 });
  });

  it('stores nothing at all under the key it refused', () => {
    // There is no value to store: the export built none and threw the document away, so writing a
    // half-formed one down would hand a later reference something the export never had.
    const { values } = resolveThemeValues([
      { key: 'v', value: true },
      { key: 'zzz', value: '-$v' },
    ]);
    expect(values.has('zzz')).toBe(false);
    expect(values.get('v')).toBe(true);
  });
});

/** Derive over a cascade written as pairs, and hand back the whole thing as a plain object. */
function derive(cascade: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  return Object.fromEntries(deriveLoaderSettings(new Map(cascade)));
}

describe('deriveLoaderSettings', () => {
  // `load_theme` derives seven settings after `load_file` returns (`theme_loader.rb:82-92`). Every
  // expectation below is the value the vendored gem's own `ThemeLoader` puts in its theme table,
  // read under ruby 3.3.3 from a theme file written outside the gem's themes directory — which is
  // the only place these run at all.
  it('derives all seven from an empty cascade, as the gem does for a theme that sets nothing', () => {
    // Measured, from a project theme whose whole content is `zzz: 1`: base_text_align "left",
    // base_line_height 1, base_font_color "000000", code_font_family "Courier",
    // conum_font_family "Courier", and no title face at all because there is no heading face.
    expect(derive([])).toEqual({
      base_text_align: 'left',
      base_line_height: 1,
      base_font_color: '000000',
      code_font_family: 'Courier',
      conum_font_family: 'Courier',
    });
  });

  it('leaves every one of them alone when the cascade already holds it', () => {
    // What `extends: default` produces: `default-theme.yml` sets all five of the unconditional ones,
    // so a theme that extends it reaches none of them. Measured over `extends: default` with an
    // otherwise empty document — "justify", 12/10.5, "333333", "M+ 1mn", "M+ 1mn".
    const cascade = [
      ['base_text_align', 'justify'],
      ['base_line_height', 12 / 10.5],
      ['base_font_color', '333333'],
      ['code_font_family', 'M+ 1mn'],
      ['conum_font_family', 'M+ 1mn'],
    ] as const;
    expect(derive(cascade)).toEqual(Object.fromEntries(cascade));
  });

  it('hands back the very same map when nothing fired, so no keystroke pays for a copy it needs', () => {
    // The cascade a real theme leaves behind holds every key the default theme sets plus every key
    // the document invented — tens of thousands of them in a document this module still accepts —
    // and the common case derives nothing at all. Identity is the assertion because that is what the
    // saving IS: a copy taken anyway would be invisible to every other test here.
    const cascade = new Map<string, unknown>([
      ['base_text_align', 'justify'],
      ['base_line_height', 1.2],
      ['base_font_color', '333333'],
      ['code_font_family', 'M+ 1mn'],
      ['conum_font_family', 'M+ 1mn'],
    ]);
    expect(deriveLoaderSettings(cascade)).toBe(cascade);
  });

  it('copies rather than writing into the cascade it was given', () => {
    const cascade = new Map<string, unknown>();
    deriveLoaderSettings(cascade);
    expect(cascade.size).toBe(0);
  });

  it.each([
    ['null', null],
    ['false', false],
  ])('derives over a setting written as %s, which is what Ruby calls unset', (_label, written) => {
    // `||=` fires on nil and on false. Measured over `extends: default`: `base: text_align: null`
    // and `base: text_align: false` both load as "left" — NOT as the default theme's "justify" —
    // and `base: line_height: null` loads as 1 rather than as 12/10.5.
    const derived = derive([
      ['base_text_align', written],
      ['base_line_height', written],
      ['code_font_family', written],
      ['conum_font_family', written],
      ['codespan_font_family', 'M+ 1mn'],
    ]);
    expect(derived['base_text_align']).toBe('left');
    expect(derived['base_line_height']).toBe(1);
    expect(derived['code_font_family']).toBe('M+ 1mn');
    expect(derived['conum_font_family']).toBe('M+ 1mn');
  });

  it.each([
    ['0', 0],
    ['an empty string', ''],
    ['NaN', Number.NaN],
  ])('leaves a setting written as %s alone, because Ruby calls it set', (_label, written) => {
    // The rule this module would get wrong by writing `||` in JavaScript. Measured over
    // `extends: default`: `base: line_height: 0` loads as 0, and `heading: font_family: ''` derives
    // `""` onto both title faces rather than deriving nothing.
    const derived = derive([
      ['base_text_align', written],
      ['base_line_height', written],
      ['code_font_family', written],
      ['conum_font_family', written],
    ]);
    expect(derived['base_text_align']).toBe(written);
    expect(derived['base_line_height']).toBe(written);
    expect(derived['code_font_family']).toBe(written);
    expect(derived['conum_font_family']).toBe(written);
  });

  it('takes the monospaced face from codespan before falling back to Courier', () => {
    // `theme_data.code_font_family ||= (theme_data.codespan_font_family || 'Courier')`, and the same
    // line again for conum. Measured over `extends: default` with `code: font_family: null`:
    // "M+ 1mn", by way of codespan.
    expect(derive([['codespan_font_family', 'Iosevka']])).toMatchObject({
      code_font_family: 'Iosevka',
      conum_font_family: 'Iosevka',
    });
  });

  it.each([
    ['null', null],
    ['false', false],
  ])('falls back to Courier when codespan itself is %s', (_label, written) => {
    // The inner `||` is Ruby's too. Measured over `extends: default` with both
    // `code: font_family: null` and `codespan: font_family: null`: code_font_family "Courier",
    // while conum_font_family keeps the "M+ 1mn" the default theme had already given it.
    expect(derive([['codespan_font_family', written]])).toMatchObject({
      code_font_family: 'Courier',
      conum_font_family: 'Courier',
    });
  });

  it('keeps a codespan face of 0, which Ruby calls set and JavaScript would not', () => {
    expect(derive([['codespan_font_family', 0]])).toMatchObject({
      code_font_family: 0,
      conum_font_family: 0,
    });
  });

  it('carries the heading face onto both title faces', () => {
    // The divergence this whole group was found through. Measured over `extends: default` with
    // `heading: font_family: Courier`: abstract_title_font_family and sidebar_title_font_family are
    // both "Courier" in the gem, where this module left the sidebar title unset and the preview drew
    // it in the stylesheet's own face.
    expect(derive([['heading_font_family', 'Courier']])).toMatchObject({
      abstract_title_font_family: 'Courier',
      sidebar_title_font_family: 'Courier',
    });
  });

  it.each([
    ['null', null],
    ['false', false],
  ])('derives no title face at all when the heading face is %s', (_label, written) => {
    // The pair sits inside `if (heading_font_family = theme_data.heading_font_family)`, so a heading
    // face Ruby calls unset derives nothing rather than deriving that value onward. Measured over
    // `extends: default`: `heading: font_family: false` leaves both title keys unset.
    const derived = derive([['heading_font_family', written]]);
    expect(derived).not.toHaveProperty('abstract_title_font_family');
    expect(derived).not.toHaveProperty('sidebar_title_font_family');
  });

  it.each([
    ['0', 0],
    ['an empty string', ''],
  ])('derives a heading face of %s onward, because Ruby calls it set', (_label, written) => {
    expect(derive([['heading_font_family', written]])).toMatchObject({
      abstract_title_font_family: written,
      sidebar_title_font_family: written,
    });
  });

  it('leaves a title face the document wrote, and replaces one it wrote as null or false', () => {
    // Measured over `extends: default` with `heading: font_family: Courier`: an abstract title face
    // of "Times" survives, and a sidebar title face of false becomes "Courier".
    expect(
      derive([
        ['heading_font_family', 'Courier'],
        ['abstract_title_font_family', 'Times'],
        ['sidebar_title_font_family', false],
      ]),
    ).toMatchObject({
      abstract_title_font_family: 'Times',
      sidebar_title_font_family: 'Courier',
    });
  });

  it('reads the heading face rather than anything it has just derived', () => {
    // Nothing here reads a key anything here writes, and the order is the loader's for fidelity
    // rather than for correctness. A codespan face written as null does not become the heading's.
    expect(
      derive([
        ['heading_font_family', 'Courier'],
        ['codespan_font_family', null],
      ]),
    ).toMatchObject({
      code_font_family: 'Courier',
      conum_font_family: 'Courier',
      sidebar_title_font_family: 'Courier',
    });
  });

  it('defaults the base font colour only when it is nil, because to_color leaves nothing else falsy', () => {
    // The one key of the seven that `||=` reads AFTER a conversion. `to_color` answers nil for nil
    // and a six-character string for everything else (`theme_loader.rb:267-322`), so a colour
    // written as false is `"0FALSE"` in the gem's table — measured over `extends: default`, where it
    // keeps the setting instead of defaulting it. This module stores colours unconverted, so asking
    // Ruby's truthiness of what it stores would default a setting the loader does not.
    expect(derive([['base_font_color', null]])['base_font_color']).toBe('000000');
    expect(derive([['base_font_color', false]])['base_font_color']).toBe(false);
    expect(derive([['base_font_color', '333333']])['base_font_color']).toBe('333333');
  });
});

/** Prepare over a cascade written as pairs, and hand back the whole thing as a plain object. */
function prepare(cascade: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  return Object.fromEntries(derivePreparedSettings(new Map(cascade)));
}

/**
 * Every key `prepare_theme` assigns, in the gem's own order (`converter.rb:569-611`).
 *
 * Read off the source and confirmed by measurement: diffing the vendored gem's theme table across
 * `Converter#prepare_theme` under ruby 3.3.3 changes seventeen of these for a theme reading
 * `extends: default` and thirty-four for a project theme that extends nothing, and no key outside
 * this list moves in either.
 */
const PREPARE_THEME_KEYS: readonly string[] = [
  'base_border_color',
  'base_font_color',
  'base_font_family',
  'base_font_style',
  'page_numbering_start_at',
  'running_content_start_at',
  'heading_chapter_break_before',
  'heading_part_break_before',
  'heading_margin_page_top',
  'heading_margin_top',
  'heading_margin_bottom',
  'prose_text_indent',
  'prose_text_indent_inner',
  'prose_margin_bottom',
  'block_margin_bottom',
  'list_indent',
  'list_item_spacing',
  'description_list_term_spacing',
  'description_list_description_indent',
  'table_border_color',
  'table_border_width',
  'thematic_break_border_color',
  'image_border_width',
  'code_linenum_font_color',
  'callout_list_margin_top_after_code',
  'role_unresolved_font_color',
  'footnotes_margin_top',
  'footnotes_item_spacing',
  'index_columns',
  'index_column_gap',
  'kbd_separator',
  'title_page_authors_delimiter',
  'title_page_revision_delimiter',
  'toc_indent',
  'toc_hanging_indent',
  'quotes',
];

describe('the prepare_theme enumeration', () => {
  it('accounts for all thirty-six assignments, as either modelled or written down', () => {
    // The whole point of the list: a key that `prepare_theme` defaults and this module reads has to
    // be modelled, and a key it defaults and this module does NOT read has to be recorded — because
    // whoever claims that key next inherits a default the cascade has never held.
    expect(PREPARE_THEME_KEYS).toHaveLength(36);
    expect(new Set(PREPARE_THEME_KEYS).size).toBe(36);
    const claimed = PREPARE_THEME_KEYS.filter((key) => CLAIMED_THEME_KEYS.includes(key));
    const unclaimed = PREPARE_THEME_KEYS.filter((key) => !CLAIMED_THEME_KEYS.includes(key));
    expect(claimed).toHaveLength(19);
    expect(unclaimed).toEqual(
      PREPARE_THEME_UNMODELLED_KEYS.toSorted(
        (a, b) => PREPARE_THEME_KEYS.indexOf(a) - PREPARE_THEME_KEYS.indexOf(b),
      ),
    );
  });

  it('claims not one of the keys it records as unmodelled', () => {
    // The guard that turns claiming one of the seventeen into a failure pointing at
    // `PREPARE_THEME_UNMODELLED_KEYS`, rather than into a silently wrong default. Sixteen of them
    // fire for EVERY theme there is, `extends: default` included — measured — so a model that read
    // one from the cascade alone would find nothing where the export has a value.
    expect(PREPARE_THEME_UNMODELLED_KEYS.filter((key) => CLAIMED_THEME_KEYS.includes(key))).toEqual([]);
  });

  it('models every prepare_theme key the appearance model claims', () => {
    // The other half: each of the nineteen has to be written by `derivePreparedSettings` over a
    // cascade that holds nothing — except `base_border_color`, whose assignment is a rewrite that
    // fires on the transparent keyword rather than on an absent value, and is covered on its own.
    const written = new Set(Object.keys(prepare([])));
    const claimed = PREPARE_THEME_KEYS.filter((key) => CLAIMED_THEME_KEYS.includes(key));
    expect(claimed.filter((key) => !written.has(key))).toEqual(['base_border_color']);
  });
});

describe('derivePreparedSettings', () => {
  // `prepare_theme` (`converter.rb:569-611`) runs over whatever theme the converter is handed, after
  // the loader has finished with it. Every expectation below is the value the vendored gem's own
  // `Converter#prepare_theme` leaves in the theme table, read under ruby 3.3.3.
  it('derives all eighteen from an empty cascade, as the gem does for a theme that extends nothing', () => {
    // Measured, from a project theme whose whole content is `zzz: 1`: thirty-four keys change across
    // `prepare_theme`, and these are the eighteen of them the appearance model reads. The nineteenth
    // claimed key is `base_border_color`, which this leaves alone because a cascade holding nothing
    // holds no transparent keyword either.
    expect(prepare([])).toEqual({
      base_font_color: '000000',
      base_font_family: 'Helvetica',
      base_font_style: 'normal',
      heading_margin_top: 0,
      heading_margin_bottom: 0,
      prose_margin_bottom: 0,
      block_margin_bottom: 0,
      list_indent: 0,
      list_item_spacing: 0,
      description_list_term_spacing: 0,
      description_list_description_indent: 0,
      table_border_color: '000000',
      table_border_width: 0.5,
      thematic_break_border_color: '000000',
      callout_list_margin_top_after_code: 0,
      footnotes_item_spacing: 0,
      kbd_separator: '+',
      toc_indent: 0,
    });
  });

  it('derives nothing at all over the gem’s own default theme, which is why a project with no theme needs no pass', () => {
    // `prepare_theme` runs for a bundled theme as well as a project one — it has no
    // `unless … == ThemesDir` guard of its own — so the appearance shown for a project with no theme
    // is a theme that has been through it. It comes out unchanged: `default-theme.yml` sets eighteen
    // of the nineteen claimed keys and gives the nineteenth the word `normal`. Measured, by diffing
    // the gem's table across `prepare_theme` for the bundled default: the seventeen keys that move
    // are the unclaimed ones, plus `base_font_style` turning the String "normal" into the Symbol
    // `:normal` — the same word in this module's key space.
    //
    // Identity is the assertion because that IS the claim. If any of these ever fired here, the
    // default appearance would be built from a cascade this function had rewritten, and the pass
    // would have to be applied on that road too.
    const parsed = parseThemeDocument(DEFAULT_THEME_YAML, { bundled: true });
    if (!parsed.ok) throw new Error('the vendored default theme did not parse');
    const { values } = resolveThemeValues(parsed.theme.entries);
    expect(derivePreparedSettings(values)).toBe(values);
  });

  it('hands back the very same map when nothing fired, so no keystroke pays for a copy it needs', () => {
    // A theme that writes ordinary values reaches none of these, which is every theme in this
    // repository: the cascade this runs over always has the default theme underneath it, so each key
    // is already set. Identity is what the saving is — and every one of the nineteen is here, so a
    // condition written the wrong way round anywhere in the function takes the copy and fails.
    const cascade = new Map<string, unknown>([
      ['base_border_color', 'EEEEEE'],
      ['base_font_color', '333333'],
      ['base_font_family', 'Noto Serif'],
      ['base_font_style', 'normal'],
      ['heading_margin_top', 4.8],
      ['heading_margin_bottom', 10.8],
      ['prose_margin_bottom', 12],
      ['block_margin_bottom', 12],
      ['list_indent', 18],
      ['list_item_spacing', 6],
      ['description_list_term_spacing', 3],
      ['description_list_description_indent', 15],
      ['table_border_color', 'DDDDDD'],
      ['table_border_width', 0.5],
      ['thematic_break_border_color', 'EEEEEE'],
      ['callout_list_margin_top_after_code', -6],
      ['footnotes_item_spacing', 3],
      ['kbd_separator', ' + '],
      ['toc_indent', 12],
    ]);
    expect(derivePreparedSettings(cascade)).toBe(cascade);
  });

  it('copies rather than writing into the cascade it was given', () => {
    const cascade = new Map<string, unknown>();
    derivePreparedSettings(cascade);
    expect(cascade.size).toBe(0);
  });

  it.each([
    ['null', null],
    ['false', false],
  ])('replaces a setting written as %s, which is what Ruby calls unset', (_label, written) => {
    // `||=` fires on nil and on false alike. Every value below is the gem's, measured over
    // `extends: default` with that one setting written as null and again as false — the default
    // theme's own values are the ones in the third column of each pair, and not one of them survives.
    const derived = prepare([
      ['heading_margin_top', written], // gem 0, default theme 4.8
      ['heading_margin_bottom', written], // gem 0, default theme 10.8
      ['prose_margin_bottom', written], // gem 0, default theme 12
      ['block_margin_bottom', written], // gem 0, default theme 12
      ['list_indent', written], // gem 0, default theme 18
      ['list_item_spacing', written], // gem 0, default theme 6
      ['description_list_term_spacing', written], // gem 0, default theme 3
      ['description_list_description_indent', written], // gem 0, default theme 15
      ['table_border_width', written], // gem 0.5, default theme 0.5
      ['callout_list_margin_top_after_code', written], // gem 0, default theme -6
      ['footnotes_item_spacing', written], // gem 0, default theme 3
      ['kbd_separator', written], // gem "+", default theme " + "
      ['toc_indent', written], // gem 0, default theme 12
      ['base_font_family', written], // gem "Helvetica", default theme "Noto Serif"
    ]);
    // `toMatchObject` rather than `toEqual`, because a cascade this sparse reaches every OTHER
    // derivation as well — which is the subject of its own test above rather than of this one.
    expect(derived).toMatchObject({
      heading_margin_top: 0,
      heading_margin_bottom: 0,
      prose_margin_bottom: 0,
      block_margin_bottom: 0,
      list_indent: 0,
      list_item_spacing: 0,
      description_list_term_spacing: 0,
      description_list_description_indent: 0,
      table_border_width: 0.5,
      callout_list_margin_top_after_code: 0,
      footnotes_item_spacing: 0,
      kbd_separator: '+',
      toc_indent: 0,
      base_font_family: 'Helvetica',
    });
  });

  it.each([
    ['0', 0],
    ['an empty string', ''],
    ['NaN', Number.NaN],
  ])('leaves a setting written as %s alone, because Ruby calls it set', (_label, written) => {
    // Measured over `extends: default`: `list: indent: 0` loads as 0 and `list: indent: ''` loads as
    // the empty string, neither of them replaced by the derivation.
    const derived = prepare([
      ['list_indent', written],
      ['kbd_separator', written],
      ['table_border_width', written],
      ['base_font_family', written],
    ]);
    expect(derived['list_indent']).toBe(written);
    expect(derived['kbd_separator']).toBe(written);
    expect(derived['table_border_width']).toBe(written);
    expect(derived['base_font_family']).toBe(written);
  });

  it.each([
    ['base_font_color', '000000'],
    ['table_border_color', '000000'],
    ['thematic_break_border_color', '000000'],
  ])('defaults %s only when it is nil, because to_color leaves nothing else falsy', (key, expected) => {
    // The three colour assignments, and the rule that separates them from every other one here: a
    // key ending in `_color` has been through `to_color` before `||=` reads it, and `to_color`
    // answers nil for nil alone. Measured over `extends: default`: `table: border_color: false` is
    // `"0FALSE"` in the gem's table and `table: border_color: []` is `[]` — both kept, where Ruby's
    // ordinary truthiness would have replaced the first.
    expect(prepare([[key, null]])[key]).toBe(expected);
    expect(prepare([[key, false]])[key]).toBe(false);
    expect(prepare([[key, []]])[key]).toEqual([]);
    expect(prepare([[key, 'ABCDEF']])[key]).toBe('ABCDEF');
  });

  it('inherits the base border colour into the two borders that fall back to it', () => {
    // `theme.table_border_color ||= (theme.base_border_color || '000000')`, and the same line again
    // for the thematic break. Measured over `extends: default` with `base: border_color: FF0000` and
    // the other written as null: both come back "FF0000", where this module used to show the default
    // theme's own "DDDDDD" and "EEEEEE".
    expect(
      prepare([
        ['base_border_color', 'FF0000'],
        ['table_border_color', null],
        ['thematic_break_border_color', null],
      ]),
    ).toMatchObject({
      base_border_color: 'FF0000',
      table_border_color: 'FF0000',
      thematic_break_border_color: 'FF0000',
    });
  });

  it('takes the base border colour away when it is the transparent keyword, and blackens what inherits it', () => {
    // The one assignment of the thirty-six that removes a value:
    // `theme.base_border_color = nil if theme.base_border_color == 'transparent'`. Measured over
    // `extends: default` with `base: border_color: transparent` and `table: border_color: null`:
    // base_border_color is nil in the gem's table and table_border_color is "000000" — the rewrite
    // runs FIRST, so what inherits from it inherits the black, not the keyword.
    expect(
      prepare([
        ['base_border_color', 'transparent'],
        ['table_border_color', null],
        ['thematic_break_border_color', null],
      ]),
    ).toMatchObject({
      base_border_color: null,
      table_border_color: '000000',
      thematic_break_border_color: '000000',
    });
  });

  it.each([
    ['a different case', 'TRANSPARENT'],
    ['a one-element list', ['transparent']],
    ['text that merely contains it', 'transparently'],
  ])('leaves the base border colour alone when it is %s', (_label, written) => {
    // `to_color` answers the transparent keyword for one input only — a String reading exactly
    // `transparent` — so the comparison is against the document's own text rather than against what
    // this module's colour reader makes of it. Measured over `extends: default`: `TRANSPARENT` is
    // "TRANSP" in the gem's table and `[transparent]` is "TRANSP" as well, because the list branch
    // joins and then falls through to the length rule, which never tests for the keyword.
    expect(prepare([['base_border_color', written]])['base_border_color']).toEqual(written);
  });

  it('defaults the base font style to the word normal, which is the gem’s Symbol', () => {
    // `theme.base_font_style = theme.base_font_style&.to_sym || :normal`. Reached only for nil:
    // every other value Ruby calls unset raises instead, and has been refused before this runs.
    expect(prepare([['base_font_style', null]])['base_font_style']).toBe('normal');
    expect(prepare([['base_font_style', 'bold']])['base_font_style']).toBe('bold');
  });

  it('reads the border colour rather than anything it has just derived', () => {
    // The order is the gem's, and only the border rewrite is load-bearing in it. A base font colour
    // defaulted on the line above does not become a table border.
    expect(
      prepare([
        ['base_font_color', null],
        ['table_border_color', null],
      ]),
    ).toMatchObject({ base_font_color: '000000', table_border_color: '000000' });
  });
});

describe('fontStyleRefusedAtPrepare', () => {
  // `theme.base_font_style&.to_sym` is the one line in `prepare_theme` that can raise: `&.` guards
  // nil and nothing else, and `to_sym` belongs to String alone. Measured by driving
  // `Converter#load_theme` over a project theme under ruby 3.3.3 — a `font_style: 7` comes back with
  // base_font_family "Noto Serif" and every other setting in the document gone.
  it.each([
    ['an integer', 7],
    ['a float', 1.5],
    ['a boolean', true],
    ['false, which the guard does not catch', false],
    ['a list', ['bold']],
    ['an empty list', []],
  ])('refuses the whole document when the style is %s', (_label, written) => {
    expect(fontStyleRefusedAtPrepare(new Map([['base_font_style', written]]))).toBe(true);
  });

  it.each([
    ['a style word', 'bold'],
    ['a word that is not a style at all', '$nope'],
    ['the empty string, which has to_sym like any other String', ''],
    ['digits written as text', '0'],
    ['null, which the safe-navigation guard catches', null],
  ])('reads on when the style is %s', (_label, written) => {
    expect(fontStyleRefusedAtPrepare(new Map([['base_font_style', written]]))).toBe(false);
  });

  it('reads on when the cascade holds no style at all', () => {
    expect(fontStyleRefusedAtPrepare(new Map())).toBe(false);
  });
});
