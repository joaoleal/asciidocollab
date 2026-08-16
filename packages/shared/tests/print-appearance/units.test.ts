import {
  colourRefusedAtLoad,
  isSideColourList,
  loadedColour,
  loadedColourList,
  parseColour,
  parseFontFamily,
  parseKeyword,
  parseMeasurement,
  parseMeasurementBox,
  parseNumber,
  parseSideColour,
  readColour,
  readsColoursPerElement,
  rubyFloatSpelling,
  RubyNumber,
  spelledFloat,
  spelledInteger,
} from '../../src/print-appearance/units';

describe('parseMeasurement', () => {
  it('treats a bare number as points, which is how the renderer reads one', () => {
    expect(parseMeasurement(10.5)).toBe(10.5);
    expect(parseMeasurement('12')).toBe(12);
  });

  it.each([
    ['0.5in', 36],
    ['1in', 72],
    ['12pt', 12],
    ['25.4mm', 72],
    ['2.54cm', 72],
    ['96px', 72],
    ['1pc', 12],
  ])('converts %s to %s points', (literal, points) => {
    expect(parseMeasurement(literal)).toBeCloseTo(points, 6);
  });

  it('accepts a negative length, which the renderer uses for pull-up margins', () => {
    expect(parseMeasurement('-6')).toBe(-6);
    expect(parseMeasurement('-0.5in')).toBe(-36);
  });

  it('measures em and per cent against the ENCLOSING size, and rem against the root', () => {
    // `resolve_font_size` (converter.rb:4896-4907) and prawn's `font_size`
    // (ext/prawn/extensions.rb:363-375) both send `rem` to `@root_font_size` and `em`/`%` to
    // `font_size`, the size of the text being set. Treating the two alike put an attribution written
    // `0.8em` at eight tenths of body text rather than of the quotation it sits under.
    const context = { rootPt: 10, enclosingPt: 20 };
    expect(parseMeasurement('1.2em', context)).toBeCloseTo(24, 6);
    expect(parseMeasurement('80%', context)).toBeCloseTo(16, 6);
    expect(parseMeasurement('1.2rem', context)).toBeCloseTo(12, 6);
  });

  it('rejects a relative length with no base rather than assuming one', () => {
    expect(parseMeasurement('1.2em')).toBeUndefined();
    expect(parseMeasurement('80%')).toBeUndefined();
    expect(parseMeasurement('1.2rem')).toBeUndefined();
  });

  it('rejects em and per cent when only the root is known, since neither is measured against it', () => {
    expect(parseMeasurement('1.2em', { rootPt: 10 })).toBeUndefined();
    expect(parseMeasurement('80%', { rootPt: 10 })).toBeUndefined();
    expect(parseMeasurement('1.2rem', { rootPt: 10 })).toBeCloseTo(12, 6);
  });

  it('takes a relative unit as its bare number for a length that is not a font size', () => {
    // `str_to_pt` (measurements.rb:20) matches `in|mm|cm|pt|px|pc` and falls through to
    // `String#to_f`, which drops any other suffix — so `page.margin: 10%` is ten POINTS in the
    // export, and `page.margin: 1em` is one. The preview reproduces that rather than resolving a
    // relationship the renderer never had.
    expect(parseMeasurement('10%', { literalPoints: true })).toBe(10);
    expect(parseMeasurement('1em', { literalPoints: true })).toBe(1);
    expect(parseMeasurement('1.5rem', { literalPoints: true })).toBe(1.5);
    expect(parseMeasurement('0.5in', { literalPoints: true })).toBe(36);
  });

  it('rejects an expression that survived evaluation instead of half-reading it', () => {
    expect(parseMeasurement('$base_font_size')).toBeUndefined();
    expect(parseMeasurement('round(10.5 * 1.25)')).toBeUndefined();
    expect(parseMeasurement('10.5 * 1.25')).toBeUndefined();
  });

  it('rejects a length carrying anything after the number, however plausible the prefix', () => {
    expect(parseMeasurement('12px; } body {')).toBeUndefined();
    expect(parseMeasurement('12 red')).toBeUndefined();
  });

  it('rejects a unit the renderer does not know', () => {
    expect(parseMeasurement('12furlongs')).toBeUndefined();
  });

  it('rejects a non-finite number', () => {
    expect(parseMeasurement(Number.NaN)).toBeUndefined();
    expect(parseMeasurement(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('rejects a value that is neither a number nor a string', () => {
    expect(parseMeasurement(null)).toBeUndefined();
    expect(parseMeasurement({ length: 12 })).toBeUndefined();
    expect(parseMeasurement(true)).toBeUndefined();
  });
});

describe('parseMeasurementBox', () => {
  it('applies a single value to every edge', () => {
    expect(parseMeasurementBox(12)).toEqual({ top: 12, right: 12, bottom: 12, left: 12 });
    expect(parseMeasurementBox([12])).toEqual({ top: 12, right: 12, bottom: 12, left: 12 });
  });

  it('reads two values as vertical then horizontal', () => {
    expect(parseMeasurementBox([4, 12])).toEqual({ top: 4, right: 12, bottom: 4, left: 12 });
  });

  it('reads three values as top, horizontal, bottom', () => {
    expect(parseMeasurementBox([4, 12, 8])).toEqual({ top: 4, right: 12, bottom: 8, left: 12 });
  });

  it('reads four values as top, right, bottom, left', () => {
    expect(parseMeasurementBox(['0.5in', '0.67in', '0.67in', '0.67in'])).toEqual({
      top: 36,
      right: 48.24,
      bottom: 48.24,
      left: 48.24,
    });
  });

  it('keeps the first four of a longer array, as the renderer does', () => {
    expect(parseMeasurementBox([1, 2, 3, 4, 5])).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
  });

  it('reads a null edge as zero, which is the renderer’s own substitution', () => {
    expect(parseMeasurementBox([4, null, 8, 12])).toEqual({ top: 4, right: 0, bottom: 8, left: 12 });
  });

  it('rejects the whole box when one edge is not a length, rather than moving the page by a guess', () => {
    expect(parseMeasurementBox([4, 'wide', 8, 12])).toBeUndefined();
  });

  it('rejects an empty array, which names no edge at all', () => {
    expect(parseMeasurementBox([])).toBeUndefined();
  });
});

/**
 * A value nested inside `depth` collections, which is what a join has to follow to reach it.
 *
 * @param depth - How many collections to wrap it in.
 * @returns The nested value.
 */
function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < depth; level += 1) value = [value];
  return value;
}

/**
 * Every expectation below was measured by DRIVING the renderer's own `ThemeLoader.load_theme`
 * against the vendored `asciidoctor-pdf` 2.3.24 under native ruby 3.3.3, and — where the answer is a
 * colour the export cannot print — by running a full conversion and reading what came back.
 *
 * The distinction that shapes the whole set: `to_color` is TOTAL, so it answers six characters for
 * anything, and six characters is not a colour. `red` becomes `RREEDD` and prawn then raises
 * `Prawn::Errors::UnknownFont`'s sibling, `ArgumentError: Unknown type of color`, and the export
 * writes no PDF at all. So each case here is one of exactly two kinds — a value the export INKS,
 * reproduced digit for digit, or a value that stops the export, refused so the author is told —
 * and the case is named for which.
 */
describe('parseColour', () => {
  it('normalises six hexadecimal digits to upper case', () => {
    expect(parseColour('1a4e8a')).toBe('1A4E8A');
  });

  it('expands the three-digit shorthand the renderer accepts', () => {
    expect(parseColour('f00')).toBe('FF0000');
    expect(parseColour('abc')).toBe('AABBCC');
  });

  it('refuses a hash the loader would already have stripped, because a surviving one is refused too', () => {
    // The loader's pre-parse substitution rewrites `font-color: "#1a4e8a"` to `'1a4e8a'` before the
    // value is ever typed, so `to_color` never sees a `#`. One that DOES reach it — through an
    // alias, `v: &v "#1a4e8a"` / `font_color: *v`, which the line pattern does not match — is
    // truncated to `#1A4E8`, and prawn refuses that outright. Accepting it here showed a colour on a
    // page the export cannot produce at all.
    expect(parseColour('#1a4e8a')).toBeUndefined();
    expect(parseColour('#abc')).toBeUndefined();
  });

  it('doubles a three-digit number rather than padding it, as the shorthand branch does', () => {
    // `to_color` stringifies before it measures, so a number takes the same length rule a string
    // does: `999999` is already six digits, and `123` is the THREE-digit shorthand — `112233`, a
    // navy the export inks, not the near-black `000123` that padding would invent.
    expect(parseColour(999_999)).toBe('999999');
    expect(parseColour(123)).toBe('112233');
    expect(parseColour(990)).toBe('999900');
    // Fewer than three digits has no shorthand to expand and is padded.
    expect(parseColour(12)).toBe('000012');
  });

  it('truncates a value longer than six characters to its first six, as the renderer does', () => {
    expect(parseColour(1_234_567)).toBe('123456');
    expect(parseColour('abcdefg')).toBe('ABCDEF');
  });

  it.each([
    ['a string longer than a colour', 'FF0000 /* x', 'FF0000'],
    ['one carrying a whole declaration', 'FF0000; } body { display: none', 'FF0000'],
    ['a number longer than a colour', 1_234_567, '123456'],
    ['a nonsense array that joins to more than six', [1, 2, 3, 4, 5, 6, 7], '123456'],
    ['a nested collection that joins to more than six', [[1_234_567], [8]], '123456'],
    ['a mapping past the six characters that are read', [123_456, { a: 1 }], '123456'],
  ])('says a colour was cut short: %s', (_label, value, expected) => {
    // The whole reason {@link readColour} exists. `to_color`'s `(value.slice 0, 6)` is a LOSS, and it
    // is the one thing this module accepts a value for while some of what the author wrote is gone.
    // Measured through a real conversion: `base: font_color: "FF0000 /* x"` inks `1.0 0.0 0.0 scn`,
    // the same operator the same key set to `FF0000` produces, and the default theme emits no red at
    // all — so the page really is painted with the first six characters.
    expect(readColour(value)).toEqual({ colour: expected, truncated: true });
  });

  it.each([
    ['exactly six characters', '1a4e8a', '1A4E8A'],
    ['the three-digit shorthand, which is doubled rather than cut', 'f00', 'FF0000'],
    ['a short value, which is padded rather than cut', 12, '000012'],
    ['an empty list, which is all padding', [], '000000'],
    ['an RGB array, which is built from its channels', [255, 0, 128], 'FF0080'],
    ['a CMYK array the renderer maps to a literal grey', [0, 0, 0, 0], 'FFFFFF'],
    ['the transparent keyword', 'transparent', 'transparent'],
  ])('says a colour was NOT cut short: %s', (_label, value, expected) => {
    // Padding is not truncation: `to_color 12` is `000012` and nothing the author wrote is missing
    // from it, so there is nothing to tell them. Drawing the line at "six characters were produced"
    // rather than at "the value was not six characters" would report every short colour in every
    // theme, which is a diagnostics list nobody reads.
    expect(readColour(value)).toEqual({ colour: expected, truncated: false });
  });

  it('says nothing about a value that is not a colour at all, which is reported as a rejection', () => {
    // One value, one sentence. A value cut to something that is not six hexadecimal digits has no
    // page to preview — prawn refuses it and the export writes no PDF — so what its author needs to
    // be told is that it was refused, not how it was shortened on the way to being refused.
    expect(readColour('not a colour at all')).toEqual({ truncated: false });
    expect(readColour('#1a4e8a')).toEqual({ truncated: false });
    expect(readColour(null)).toEqual({ truncated: false });
  });

  it('converts a three-element RGB array', () => {
    expect(parseColour([255, 0, 128])).toBe('FF0080');
  });

  it('truncates a fractional RGB channel, which is a page the export prints', () => {
    // `sprintf '%02X', 128.5` is `80`. The export renders `[255, 128.5, 0]` as `FF8000` and writes
    // a PDF; rejecting it showed the key's default instead of the colour on the page.
    expect(parseColour([255, 128.5, 0])).toBe('FF8000');
    expect(parseColour([1.5, 0, 0])).toBe('010000');
  });

  it('refuses an RGB channel outside a byte, which is a page the export does not print', () => {
    // `sprintf '%02X'` is not a range check: `300` formats as `12C` and `-1` as `..F`, so the joined
    // value is not six hexadecimal digits and prawn raises `Unknown type of color`. There is no
    // export to preview, so the key falls back and is reported.
    expect(parseColour([256, 0, 0])).toBeUndefined();
    expect(parseColour([255, 300, 0])).toBeUndefined();
    expect(parseColour([255, -1, 0])).toBeUndefined();
  });

  it('takes an RGB channel in every spelling `Integer()` reads, and in no other', () => {
    // A string channel reaches `Integer()`, not `to_f` — and `Integer()` picks its base from the
    // PREFIX, so four spellings besides decimal are channels the export inks. Each of the five below
    // was loaded through the vendored gem under ruby 3.3.3: `base_font_color` comes back as
    // `FF8000`, `100000`, `080000`, `030000` and `0A0000` in turn. Refusing the last four — which is
    // what testing for a decimal integer alone did — reported four colours the export prints as
    // colours it would not print, and showed the key's default in their place.
    expect(parseColour(['255', '128', '0'])).toBe('FF8000');
    expect(parseColour(['0x10', '0', '0'])).toBe('100000');
    expect(parseColour(['010', '0', '0'])).toBe('080000');
    expect(parseColour(['0b11', '0', '0'])).toBe('030000');
    expect(parseColour(['1_0', '0', '0'])).toBe('0A0000');
    // The other three bases `Integer()` names, and the whitespace it tolerates around any of them.
    expect(parseColour(['0o17', '0', '0'])).toBe('0F0000');
    expect(parseColour(['0d10', '0', '0'])).toBe('0A0000');
    expect(parseColour([' 10 ', '0', '0'])).toBe('0A0000');
    // And the spellings it does not read, which stay values this cannot make a colour of. That they
    // are also values the export refuses the whole DOCUMENT over is a separate question, asked at
    // load and answered by `colourRefusedAtLoad`.
    expect(parseColour(['128.5', '0', '0'])).toBeUndefined();
    expect(parseColour(['a', '0', '0'])).toBeUndefined();
    expect(parseColour(['1__0', '0', '0'])).toBeUndefined();
    expect(parseColour(['_10', '0', '0'])).toBeUndefined();
    expect(parseColour(['10_', '0', '0'])).toBeUndefined();
    expect(parseColour(['08', '0', '0'])).toBeUndefined();
    expect(parseColour(['', '0', '0'])).toBeUndefined();
  });

  it('honours the two CMYK arrays the renderer maps to a literal grey', () => {
    // Not a conversion — a match. `to_color` returns the STRING `FFFFFF` for a normalised
    // `[0, 0, 0, 0]` and `000000` for `[100, 100, 100, 100]`, and those are the bytes in the file.
    expect(parseColour([0, 0, 0, 0])).toBe('FFFFFF');
    expect(parseColour([100, 100, 100, 100])).toBe('000000');
    // The normalisation reaches further than the two literals: a numeric channel at or below one is
    // a fraction and is multiplied by a hundred, while a channel written as text is not and is read
    // with `to_f` after a trailing `%` — which answers zero for text that is not a number at all.
    expect(parseColour([1, 1, 1, 1])).toBe('000000');
    expect(parseColour(['0%', '0%', '0%', '0%'])).toBe('FFFFFF');
    expect(parseColour(['100%', '100%', '100%', '100%'])).toBe('000000');
    expect(parseColour(['a', 'a', 'a', 'a'])).toBe('FFFFFF');
  });

  it('refuses every other CMYK array rather than approximating a colour the PDF does not contain', () => {
    expect(parseColour([0, 100, 100, 0])).toBeUndefined();
    expect(parseColour([0, 0, 0, 50])).toBeUndefined();
  });

  it('reads a CMYK channel that is a collection as zero, which is the only channel whose two spellings differ', () => {
    // The normalisation reads a non-numeric channel as `(e.to_s.chomp '%').to_f`, and Ruby's `to_s`
    // for a collection opens with a bracket or a brace — so `to_f` finds no leading float and answers
    // zero, where JavaScript's `String([1])` would hand back the digit `1` and make it a channel of
    // one. Measured against the vendored gem under ruby 3.3.3 as `base: font_color:`, all three of
    // these are `"FFFFFF"` in the theme table: white, not a colour refused for having a channel in it.
    expect(parseColour([[1], 0, 0, 0])).toBe('FFFFFF');
    expect(parseColour([[1, 2], 0, 0, 0])).toBe('FFFFFF');
    expect(parseColour([{ a: 1 }, 0, 0, 0])).toBe('FFFFFF');
    // And the same channel is why the black is NOT matched: measured, `[[100], 100, 100, 100]` is the
    // array `[0, 100, 100, 100]`, which `to_color` leaves as a CMYK colour rather than the `000000`
    // that `[100, 100, 100, 100]` returns.
    expect(parseColour([[100], 100, 100, 100])).toBeUndefined();
  });

  it('flattens an array of any other length, which the renderer calls a nonsense value', () => {
    expect(parseColour([1, 2, 3, 4, 5])).toBe('012345');
    // An empty list is six characters of padding, which is black — in the export as well as here.
    expect(parseColour([])).toBe('000000');
    // `Array#join` writes an empty string for a nil, so `[null, 1, 2, 3, 4]` is `001234`. In a
    // THREE-element array the same nil reaches `sprintf` instead and raises, so it is refused.
    expect(parseColour([null, 1, 2, 3, 4])).toBe('001234');
    expect(parseColour([1, null, 2])).toBeUndefined();
  });

  it.each([
    ['a one-element collection', [[1], 2], '000012'],
    ['one nested twice, which is followed just as far', [[[1]], 2], '000012'],
    ['two of them, joining to three characters and taking the shorthand', [[1, 2], [3]], '112233'],
    ['the same with a hexadecimal digit in it', [['f', 0], [0]], 'FF0000'],
    ['an empty one, which contributes nothing at all', [[], 2], '000002'],
    ['nothing but an empty one, which is the black an empty value is', [[]], '000000'],
    ['a nil inside one, which contributes nothing either', [[null], 2], '000002'],
    ['a four-element one, which is joined and NOT read as a CMYK colour', [[0, 0, 0, 0], 2], '000002'],
    ['another four-element one, which a CMYK reading would call half black', [[0, 0, 0, 50], 2], '000502'],
    ['a three-element one, which is joined and NOT read as an RGB triple', [[1, 2, 3], 2], '001232'],
    ['one whose channels are not numbers, which the join does not mind', [['a', 0, 0], 2], '00A002'],
  ])('joins %s recursively, which is what Ruby’s join does and JavaScript’s does not', (_label, written, expected) => {
    // `Array#join` joins a nested Array by joining IT, at any depth, where the JavaScript namesake
    // stringifies it with commas. Measured against the vendored gem under ruby 3.3.3 over
    // `extends: default`, each as `base: font_color:` — `[[1], 2]` and `[[[1]], 2]` are both
    // `"000012"` in the theme table, `[[1, 2], [3]]` and `[[f, 0], [0]]` join to three characters and
    // come back doubled as `"112233"` and `"FF0000"`, `[[], 2]` and `[[null], 2]` are `"000002"`,
    // `[[]]` is `"000000"`, `[[0, 0, 0, 0], 2]` is `"000002"`, `[[1, 2, 3], 2]` is `"001232"` and
    // `[[a, 0, 0], 2]` is `"00A002"` and `[[0, 0, 0, 50], 2]` is `"000502"` — five characters from the
    // nested list and one from the 2, and not the half-black a CMYK reading would have found.
    //
    // Every one of these was refused, on the written ground that a colour guessed from a disagreement
    // is worse than one refused. There was no disagreement to guess at: the rule is a recursive join,
    // and refusing it showed the key's default for ten colours the export inks.
    expect(parseColour(written)).toBe(expected);
  });

  it.each([
    ['a keyword spelled inside one', [['transparent']]],
    ['a boolean inside one, which joins to 0TRUE2', [[true], 2]],
    ['a colour name inside one, which joins to RREEDD', [['red']]],
    ['a fractional channel, which puts a point among the digits', [[0, 0, 0, 0.5], 2]],
  ])('refuses %s, which the join makes into something prawn cannot ink', (_label, written) => {
    // The join is reproduced, and then gated on six hexadecimal digits like every other value.
    // Measured, as `base: font_color:`: `"TRANSP"`, `"0TRUE2"`, `"RREEDD"` and `"0000.5"`, each of
    // which prawn refuses with `Unknown type of color` — so the export writes no PDF and the key falls
    // back with a diagnostic. The keyword is tested inside `when ::String` alone, which a list never
    // reaches, and the three-character join is doubled on its way to `RREEDD` exactly as a bare `red`
    // is.
    expect(readColour(written)).toEqual({ truncated: false });
  });

  it('follows a nesting no deeper than any export survives, and refuses what is deeper', () => {
    // `Array#join` recurses in C and gives out: measured against ruby 3.3.3 with an 8 MB stack it
    // joins a thousand levels and raises `SystemStackError` before fifteen hundred, and the wasm build
    // the preview renders against has a smaller stack still. A `SystemStackError` is not a
    // `StandardError`, so the rescue that turns a bad theme into the default theme does not catch it
    // and the export writes no PDF at all — there is nothing above the bound to reproduce.
    expect(parseColour([nested(1000), 2])).toBe('000012');
    expect(parseColour([nested(1001), 2])).toBeUndefined();
    // Total whatever it is handed. A chain of aliases each wrapping the last builds nesting out of
    // flat lines, and the deepest structure the parser's expansion budget admits that way is about
    // twenty thousand levels — a depth a plain recursion does not return from at all.
    expect(parseColour([nested(20_000), 2])).toBeUndefined();
  });

  it.each([
    ['one on its own', [{ a: 1 }, 2], undefined],
    ['one written empty, which is still a brace', [{}, 2], undefined],
    ['one after two characters, still inside the six that are read', [12, { a: 1 }], undefined],
    ['one after six, which no reading reaches', [123_456, { a: 1 }], '123456'],
    ['one after a colour of six characters', ['FF0000', { a: 1 }], 'FF0000'],
    ['one nested inside a collection', [[{ a: 1 }], 2], undefined],
  ])('reads a mapping among the elements as the brace it opens with: %s', (_label, written, expected) => {
    // `Hash#to_s` opens with `{`, which is not a hexadecimal digit — so wherever the brace lands
    // inside the six characters the length rule reads, the value is refused whatever the rest of the
    // mapping says, and wherever it lands outside them, none of the rest is read either. Both halves
    // measured against the vendored gem under ruby 3.3.3 as `base: font_color:`: `[{a: 1}, 2]` is
    // `{"A"=>`, `[{}, 2]` is `{{}}22`, `[12, {a: 1}]` is `12{"A"`, and `[123456, {a: 1}]` is `123456`
    // — the last of which the export inks, and the rest of which it refuses.
    expect(parseColour(written)).toBe(expected);
  });

  it('keeps the transparent keyword only where the renderer tests for it, which is exactly', () => {
    expect(parseColour('transparent')).toBe('transparent');
    // `value == 'transparent'` is case-sensitive and does not trim. `Transparent` is not the keyword
    // with different capitals: it takes the truncating branch, becomes `TRANSP`, and the export dies
    // on it. Treating it as transparent showed a page nobody can export and said nothing.
    expect(parseColour('Transparent')).toBeUndefined();
    expect(parseColour('TRANSPARENT')).toBeUndefined();
    expect(parseColour(' transparent ')).toBeUndefined();
  });

  it.each([
    ['a one-element list', ['transparent']],
    ['a list that spells it across two elements', ['transp', 'arent']],
    ['a list with an empty element before it', [null, 'transparent']],
  ])('refuses %s, which the renderer never tests for the keyword', (_label, written) => {
    // `to_color` tests the keyword inside `when ::String` alone (`theme_loader.rb:299-300`). The list
    // branch joins and falls THROUGH to the length rule, which never looks at it — so the value in
    // the theme table is the six characters `TRANSP`, which prawn refuses with `Unknown type of
    // color`. Measured against the vendored gem under ruby 3.3.3 over `extends: default`: each of
    // these is `"TRANSP"` in `base_border_color`, exactly as `TRANSPARENT` is.
    //
    // Answering `transparent` here drew no border at all for a theme whose export draws one — or
    // rather, whose export draws nothing, having refused the value.
    expect(readColour(written)).toEqual({ truncated: false });
    expect(parseColour(written)).toBeUndefined();
  });

  it('refuses a colour name, which the renderer derives a value from and prawn then rejects', () => {
    expect(parseColour('red')).toBeUndefined();
    expect(parseColour('rebeccapurple')).toBeUndefined();
  });

  it('lets nothing of a value escape, whatever the value was trying to do', () => {
    // The guarantee is the SHAPE of the answer, not a blocklist: whatever comes back is six
    // hexadecimal digits or nothing, so there is never anything for a brace to open or a quote to
    // close. A value that begins with six hexadecimal digits keeps exactly those and loses the rest,
    // which is what the export inks — `FF0000; } body { display: none` is red in the PDF.
    for (const value of [
      'FF0000; } body { display: none',
      'url(https://example.invalid/x)',
      '#FF0000 !important',
      '</style><script>alert(1)</script>',
      'javascript:alert(1)',
      'FFFFFF; } html { display: none',
    ]) {
      const parsed = parseColour(value);
      expect({ value, parsed }).toEqual({
        value,
        parsed: parsed === undefined ? undefined : expect.stringMatching(/^[\dA-F]{6}$/) as unknown,
      });
    }
    expect(parseColour('FF0000; } body { display: none')).toBe('FF0000');
    expect(parseColour('url(https://example.invalid/x)')).toBeUndefined();
    expect(parseColour('#FF0000 !important')).toBeUndefined();
  });

  it('rejects a value that is neither a string, number nor array', () => {
    expect(parseColour(null)).toBeUndefined();
    expect(parseColour({ r: 1 })).toBeUndefined();
    expect(parseColour(true)).toBeUndefined();
    expect(parseColour(Number.NaN)).toBeUndefined();
  });
});

describe('readsColoursPerElement', () => {
  it('names the two keys the loader hands its elements to one at a time', () => {
    // `key == 'table_border_color' ? ::Array === val : (key == 'table_grid_color' && ::Array === val
    // && val.size == 2)` (`theme_loader.rb:184`). The border takes a list of ANY length; the grid
    // takes one of exactly two, because a four-element grid colour is a CMYK colour and not a
    // shorthand for two axes.
    expect(readsColoursPerElement('table_border_color', [1])).toBe(true);
    expect(readsColoursPerElement('table_border_color', [1, 2])).toBe(true);
    expect(readsColoursPerElement('table_border_color', [1, 2, 3])).toBe(true);
    expect(readsColoursPerElement('table_border_color', [1, 2, 3, 4])).toBe(true);
    expect(readsColoursPerElement('table_border_color', [])).toBe(true);
    expect(readsColoursPerElement('table_grid_color', [1, 2])).toBe(true);
    expect(readsColoursPerElement('table_grid_color', [1])).toBe(false);
    expect(readsColoursPerElement('table_grid_color', [1, 2, 3])).toBe(false);
    expect(readsColoursPerElement('table_grid_color', [1, 2, 3, 4])).toBe(false);
  });

  it('names no other colour key, however alike the value looks', () => {
    // Measured against the vendored gem under ruby 3.3.3 over `extends: default`, each written as
    // `[1, 2]`: `thematic_break_border_color` is `"000012"` in the theme table and so is
    // `admonition_icon_tip`'s `stroke_color`, where `table_border_color` is `["000001", "000002"]`.
    // The suffix is not the test — the KEY is.
    expect(readsColoursPerElement('thematic_break_border_color', [1, 2])).toBe(false);
    expect(readsColoursPerElement('base_border_color', [1, 2])).toBe(false);
    expect(readsColoursPerElement('base_font_color', [1, 2])).toBe(false);
    expect(readsColoursPerElement('table_head_background_color', [1, 2])).toBe(false);
    expect(readsColoursPerElement('table_border_width', [1, 2])).toBe(false);
  });

  it('names neither key for a value that is not a list at all', () => {
    // Which is what a list reached through a LONE reference is at this point: `::Array === val`
    // tests `process_entry`'s argument, and the expansion runs inside the branch it chooses.
    // Measured against the vendored gem under ruby 3.3.3 over `extends: default`, `v: [1, 2]` with
    // `table: border_color: $v` is `"000012"` in the theme table — the same list the key would have
    // read as two sides had the document written it out.
    expect(readsColoursPerElement('table_border_color', '$v')).toBe(false);
    expect(readsColoursPerElement('table_border_color', 'DDDDDD')).toBe(false);
    expect(readsColoursPerElement('table_border_color', null)).toBe(false);
    expect(readsColoursPerElement('table_grid_color', '$v')).toBe(false);
    expect(readsColoursPerElement('table_grid_color', 'DDDDDD')).toBe(false);
  });
});

describe('isSideColourList', () => {
  it('tells a shorthand for four sides from one colour that happens to be a list', () => {
    // The gem gets this from its own `ColorValue` marker: anything its whole-value branch converted
    // is a String by the time it reaches the theme table, so an Array under `table_border_color` is
    // always a shorthand. This module converts where values are read, so both arrive at a reader
    // looking alike and the mark is what separates them.
    const sides = loadedColourList([1, 2]);
    expect(isSideColourList(sides)).toBe(true);
    expect(isSideColourList([...sides])).toBe(false);
    expect(isSideColourList([1, 2])).toBe(false);
    expect(isSideColourList(['000001', '000002'])).toBe(false);
    expect(isSideColourList('DDDDDD')).toBe(false);
    expect(isSideColourList(null)).toBe(false);
  });

  it('leaves the list an ordinary array, because a later reference joins it', () => {
    // A wrapper would have changed what every other reader sees to serve one of them. Measured
    // against the vendored gem under ruby 3.3.3: `table: border_color: [1, 2]` with
    // `thematic_break: border_color: $table_border_color` leaves the thematic break `"000001"` —
    // the converted elements joined and cut to six, which is what `parseColour` makes of this list.
    const sides = loadedColourList([1, 2]);
    expect(Array.isArray(sides)).toBe(true);
    expect([...sides]).toEqual(['000001', '000002']);
    expect(parseColour(sides)).toBe('000001');
  });
});

describe('loadedColour', () => {
  it.each([
    ['a number, padded to six digits', 1, '000001'],
    ['a bigger number', 30, '000030'],
    ['text of one character', 'a', '00000A'],
    ['text of six characters, upper-cased', 'ff0000', 'FF0000'],
    ['the three-digit shorthand', 'f00', 'FF0000'],
    ['the transparent keyword, which an element DOES reach', 'transparent', 'transparent'],
    ['a nested one-element list, which the join flattens', [1], '000001'],
    ['a nested RGB triple', [1, 2, 3], '010203'],
    ['a nested CMYK literal', [0, 0, 0, 0], 'FFFFFF'],
    ['a list nested inside the element, joined recursively', [[1, 2], [3]], '112233'],
    ['an empty list, which is the black an empty value is', [], '000000'],
  ])('stores what the loader stored for %s', (_label, element, expected) => {
    // `data[key] = val.map {|it| to_color evaluate it, data, math: false }` (`theme_loader.rb:185`):
    // each element goes through `to_color` on its own, and its answer is what the theme table holds.
    // Measured against the vendored gem under ruby 3.3.3 over `extends: default`, each as the first
    // element of `table: border_color:` — `[1, 2]` is `["000001", "000002"]`, `[a, 0, 0]` is
    // `["00000A", "000000", "000000"]`, `[[1], 2]` is `["000001", "000002"]`, `[[1, 2, 3], 2]` is
    // `["010203", "000002"]`, `[[0, 0, 0, 0], 2]` is `["FFFFFF", "000002"]`, `[[[1, 2], [3]], 2]` is
    // `["112233", "000002"]` and `[[], 2]` is `["000000", "000002"]`.
    expect(loadedColour(element)).toBe(expected);
  });

  it('stores the gem’s nil for an element the document left empty', () => {
    // `to_color nil` returns nothing, and the list keeps the hole: measured, `table: border_color:
    // [null, 2]` is `[nil, "000002"]` in the theme table. The hole is not the same as the element
    // being absent — see {@link parseSideColour}, where it asks for the expansion's own default.
    expect(loadedColour(null)).toBeNull();
    expect(loadedColour(undefined)).toBeNull();
  });

  it.each([
    ['a colour name, which becomes RREEDD', 'red'],
    ['a boolean, which becomes 00TRUE', true],
    ['an out-of-range RGB triple, which becomes seven characters', [300, 0, 0]],
    ['a CMYK colour this preview will not approximate', [0, 0, 0, 0.5]],
  ])('leaves %s exactly as the document wrote it', (_label, element) => {
    // What `to_color` made of the first three is a value prawn refuses with `Unknown type of color`,
    // and of the fourth a CMYK array with no faithful sRGB counterpart. Measured against the vendored
    // gem under ruby 3.3.3, each as the first element of `table: border_color:`: `["RREEDD",
    // "00FF00"]`, `["00TRUE", "000002"]`, `["12C0000", "000002"]`, `[[0, 0, 0, 50], "000002"]`. There
    // is no colour to store and no reader here accepts one, so the element is kept as written and the
    // side is refused with a diagnostic — the same outcome those values get under every other colour
    // key.
    //
    // It is a cost, and the fourth is where it is visible: what the gem keeps for that element is the
    // NORMALISED `[0, 0, 0, 50]`, so a later `$table_border_color` joins `00050` where this joins the
    // `0000.5` the document wrote, and the two disagree about a key neither of them paints the border
    // from. Storing a value no reader here accepts is the change that would close it.
    expect(loadedColour(element)).toBe(element);
  });
});

describe('parseSideColour', () => {
  it('shows the FIRST element, which is the side this style paints', () => {
    // `expand_rect_values` puts element 0 at the top for every list length
    // (`ext/prawn/extensions.rb:659-678`) and `expand_grid_values` puts it on the horizontal rules.
    // Measured against the vendored gem under ruby 3.3.3: `table: border_color: [1, 2]` is
    // `["000001", "000002"]` in the theme table and inks the top border `000001`.
    expect(parseSideColour(['000001', '000002'])).toBe('000001');
    expect(parseSideColour(['000010', '000020', '000030'])).toBe('000010');
    expect(parseSideColour(['FFFFFF'])).toBe('FFFFFF');
    expect(parseSideColour(['ff0000', '00ff00'])).toBe('FF0000');
  });

  it('reads the transparent keyword an element carries', () => {
    expect(parseSideColour(['transparent', '00FF00'])).toBe('transparent');
  });

  it('asks for the expansion’s own default where the first element is empty', () => {
    // `shorthand[0] || default` with the converter's `'transparent'` (`converter.rb:2244`), so an
    // element written as `null` draws NO top border. Joining the list instead found the next
    // element's colour there: measured, `table: border_color: [null, 2]` inks `transparent`, where
    // a join answered `000002`.
    expect(parseSideColour([null, '000002'])).toBe('transparent');
    expect(parseSideColour([null])).toBe('transparent');
  });

  it('does NOT size an already-converted element a second time', () => {
    // The elements have been through `to_color` once. `[300, 0, 0]` is the seven characters
    // `12C0000` in the theme table and prawn refuses it, so the export writes no PDF; running the
    // length rule again would cut it to `12C000` and paint a border no page contains.
    expect(parseSideColour(['12C0000', '000002'])).toBeUndefined();
    expect(parseSideColour(['RREEDD'])).toBeUndefined();
    expect(parseSideColour(['00TRUE'])).toBeUndefined();
    expect(parseSideColour([[0, 0, 0, 50]])).toBeUndefined();
  });

  it('leaves an empty list to the ordinary reading, which is the black prawn defaults to', () => {
    // `[].slice(0, 4).map` expands to no sides at all, so prawn-table's own `['000000'] * 4` stands
    // (`prawn-table/cell.rb:216`). `to_color`'s join answers that same black for `[]`.
    expect(parseSideColour([])).toBe('000000');
  });

  it('reads a value that is not a list the ordinary way, which is how a default arrives', () => {
    // The key falls back to the default theme's own value when the project's is refused, and that
    // value was never a shorthand.
    expect(parseSideColour('DDDDDD')).toBe('DDDDDD');
    expect(parseSideColour('f00')).toBe('FF0000');
    expect(parseSideColour(null)).toBeUndefined();
  });
});

describe('parseKeyword', () => {
  const alignments = ['left', 'center', 'right', 'justify'];

  it('accepts a permitted word', () => {
    expect(parseKeyword('center', alignments)).toBe('center');
  });

  it('accepts either spelling of a compound keyword and returns the descriptor’s own', () => {
    expect(parseKeyword('bold-italic', ['normal', 'bold_italic'])).toBe('bold_italic');
    expect(parseKeyword('BOLD_ITALIC', ['normal', 'bold_italic'])).toBe('bold_italic');
  });

  it('rejects a word the renderer does not accept for this key', () => {
    expect(parseKeyword('middle', alignments)).toBeUndefined();
    expect(parseKeyword('', alignments)).toBeUndefined();
  });

  it('rejects a non-string', () => {
    expect(parseKeyword(3, alignments)).toBeUndefined();
    expect(parseKeyword(null, alignments)).toBeUndefined();
  });
});

describe('parseNumber', () => {
  it('accepts a ratio, which is what line height is', () => {
    expect(parseNumber(1.25)).toBe(1.25);
    expect(parseNumber('1.4')).toBe(1.4);
    expect(parseNumber('-6')).toBe(-6);
  });

  it('rejects a length with a unit, which would silently become a bare ratio', () => {
    expect(parseNumber('12pt')).toBeUndefined();
    expect(parseNumber('1.2em')).toBeUndefined();
  });

  it('rejects an unevaluated expression and a non-number', () => {
    expect(parseNumber('$base_line_height')).toBeUndefined();
    expect(parseNumber(Number.NaN)).toBeUndefined();
    expect(parseNumber(null)).toBeUndefined();
  });
});

describe('parseFontFamily', () => {
  it('accepts the catalogue family names the renderer ships', () => {
    expect(parseFontFamily('Noto Serif')).toBe('Noto Serif');
    expect(parseFontFamily('M+ 1mn')).toBe('M+ 1mn');
    expect(parseFontFamily(' DejaVu Sans Mono ')).toBe('DejaVu Sans Mono');
  });

  it('rejects a name carrying a character that would end a CSS declaration', () => {
    expect(parseFontFamily('Noto Serif"; } body {')).toBeUndefined();
    expect(parseFontFamily("Noto', sans-serif; color: red")).toBeUndefined();
    expect(parseFontFamily(String.raw`Noto\0000`)).toBeUndefined();
  });

  it('rejects an empty or absurdly long name', () => {
    expect(parseFontFamily('   ')).toBeUndefined();
    expect(parseFontFamily('A'.repeat(65))).toBeUndefined();
  });

  it('rejects a non-string', () => {
    expect(parseFontFamily(12)).toBeUndefined();
  });
});

describe('colourRefusedAtLoad', () => {
  it.each([
    ['a channel that is not a number', ['a', 0, 0]],
    ['a channel that is a boolean', [true, 0, 0]],
    ['a channel that is nothing at all', [null, 0, 0]],
    ['a fractional channel written as text', ['128.5', 0, 0]],
    ['a channel written as text with an inner space', ['1 0', 0, 0]],
    ['an empty channel', ['', 0, 0]],
    ['an infinite channel', [Number.POSITIVE_INFINITY, 0, 0]],
    ['a NaN channel', [Number.NaN, 0, 0]],
    ['a channel that is a list', [[1], 0, 0]],
    ['an infinite CMYK channel', [Number.POSITIVE_INFINITY, 0, 0, 0]],
    ['a NaN CMYK channel', [0, Number.NaN, 0, 0]],
  ])('says the loader raises on %s', (_label, value) => {
    // Each of these was loaded through the vendored gem under ruby 3.3.3 under `base: font_color`,
    // and each raises out of `ThemeLoader.load_file`: `ArgumentError` from `Integer()`, `TypeError`
    // from a nil, a boolean or a collection, `FloatDomainError` from an infinity or a NaN — the last
    // of those from the CMYK normalisation's own `e.to_i` rather than from `sprintf`.
    expect(colourRefusedAtLoad(value)).toBe(true);
  });

  it.each([
    ['an out-of-range channel, which loads as 12C0000', [300, 0, 0]],
    ['a negative channel, which loads as ..F0000', [-1, 0, 0]],
    ['a fractional channel, which truncates', [255, 128.5, 0]],
    ['a channel written as text in another base', ['0x10', 0, 0]],
    ['a channel written as text with surrounding space', [' 10 ', 0, 0]],
    ['a CMYK array of text, which to_f reads as zero', ['a', 'a', 'a', 'a']],
    ['a CMYK array with a nil, which to_f reads as zero too', [null, 0, 0, 0]],
    ['an array of any other length, which is joined into a string', [1, 2, 3, 4, 5]],
    ['a plain string', 'FF0000'],
    ['a number', 123_456],
    ['nothing', undefined],
  ])('says the loader reads %s', (_label, value) => {
    // The other side, and the one that decides how much of a theme a typo costs: every value here
    // LOADS in the gem, so whatever happens to it afterwards — prawn refusing `12C0000`, this module
    // refusing to make a colour of it — is a question about one key and not about the document.
    expect(colourRefusedAtLoad(value)).toBe(false);
  });
});

describe('rubyFloatSpelling', () => {
  it.each([
    // Fixed notation always carries a fraction, which is the whole of the `1.0` defect.
    ['an integral float', 1, '1.0'],
    ['a negative integral float', -1, '-1.0'],
    ['negative zero, which JavaScript writes without its sign', -0, '-0.0'],
    ['positive zero', 0, '0.0'],
    ['six integral digits', 123_456, '123456.0'],
    ['a fractional float, where the two already agree', 0.5, '0.5'],
    ['the float that is not a clean decimal', 0.1 + 0.2, '0.30000000000000004'],
    // Where fixed notation ends going up: the point at 15 is written out, at 16 it is not.
    ['a point at fifteen', 1e14, '100000000000000.0'],
    ['a point at sixteen', 1e15, '1.0e+15'],
    ['a point at sixteen with seventeen digits, which is written out', 1.234_567_890_123_456_8e15, '1234567890123456.8'],
    ['a point at sixteen with sixteen digits, which is not', 2 ** 53, '9.007199254740992e+15'],
    // …and going down.
    ['a point at minus three', 0.0001, '0.0001'],
    ['a point at minus four', 0.000_01, '1.0e-05'],
    // The exponent: a sign, at least two digits, and a mantissa with a fraction.
    ['a large exponent', 1e20, '1.0e+20'],
    ['a small exponent', 3e-7, '3.0e-07'],
    ['a three-digit exponent', 5e-324, '5.0e-324'],
    ['the largest double', 1.797_693_134_862_315_7e308, '1.7976931348623157e+308'],
    ['a mantissa with two digits', 2.5e-5, '2.5e-05'],
    // The three that are not decimal at all, and which the two languages already agree on.
    ['an infinity', Number.POSITIVE_INFINITY, 'Infinity'],
    ['a negative infinity', Number.NEGATIVE_INFINITY, '-Infinity'],
    ['a NaN', Number.NaN, 'NaN'],
  ])('spells %s as ruby 3.3.3 does', (_label, value, expected) => {
    // Every expectation is `to_s` under ruby 3.3.3, read back through a bit-exact transport so both
    // sides are talking about the same double. The whole table was measured across 4,897 doubles from
    // 1e-324 to 1e308 with zero disagreements, and plain `String(n)` disagrees on 1,477 of them.
    expect(rubyFloatSpelling(value)).toBe(expected);
  });
});

describe('spelledFloat and spelledInteger', () => {
  it('leaves a number JavaScript already spells as Ruby does alone', () => {
    // The value space is unchanged for these, which is why no reader of one had to change.
    expect(spelledFloat(0.5)).toBe(0.5);
    expect(spelledFloat(1.5)).toBe(1.5);
    expect(spelledInteger(12, 12n)).toBe(12);
    expect(spelledInteger(1e20, 100_000_000_000_000_000_000n)).toBe(1e20);
  });

  it('carries the spelling of a float whose two spellings differ', () => {
    expect(spelledFloat(1)).toStrictEqual(new RubyNumber(1, '1.0'));
    expect(spelledFloat(-0)).toStrictEqual(new RubyNumber(-0, '-0.0'));
    expect(spelledFloat(3e-7)).toStrictEqual(new RubyNumber(3e-7, '3.0e-07'));
  });

  it('carries the exact digits of an integer the double has lost, or written past 10^21', () => {
    // `10000000000000000000000` is 1e22, which JavaScript writes `1e+22`; Ruby keeps every digit, and
    // the export inks the first six of them.
    expect(spelledInteger(1e22, 10_000_000_000_000_000_000_000n)).toStrictEqual(
      new RubyNumber(1e22, '10000000000000000000000'),
    );
    // Past 2^53 the double is not the integer any more, and only the literal knows which one it was.
    expect(
      spelledInteger(Number('12345678901234567890'), 12_345_678_901_234_567_890n).toString(),
    ).toBe('12345678901234567890');
  });

  it('spells an integer from its own value where no literal was read, and never from a fraction', () => {
    // The base-60 branches sum rather than read, so there is no literal to be exact about.
    expect(spelledInteger(1e22)).toStrictEqual(new RubyNumber(1e22, '10000000000000000000000'));
    expect(spelledInteger(1.5)).toBe(1.5);
  });
});
