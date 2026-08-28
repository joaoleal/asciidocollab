import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ADMONITION_TYPES,
  defaultAppearance,
  HEADING_LEVELS,
  MAX_FONT_FAMILY_LENGTH,
  resolveAppearance,
} from '../../src/print-appearance';
import type { AppearanceModel } from '../../src/print-appearance';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

/** Every string and number the model carries, flattened, for the whole-model invariants below. */
function scalarsOf(model: AppearanceModel): unknown[] {
  return scalarEntriesOf(model).map(([, value]) => value);
}

/** Every scalar the model carries, paired with the dotted path it sits at. */
function scalarEntriesOf(model: AppearanceModel): [string, unknown][] {
  const out: [string, unknown][] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (const [index, entry] of node.entries()) walk(entry, `${path}[${index}]`);
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) walk(value, path === '' ? key : `${path}.${key}`);
    } else if (node !== undefined) {
      out.push([path, node]);
    }
  };
  walk(model, '');
  return out;
}

/**
 * Resolve one theme and hand back what it produced, flattened.
 *
 * @param themeText - The theme document.
 * @returns The appearance, the keys reported, and the sentences reported.
 */
function resolved(themeText: string): {
  readonly appearance: AppearanceModel;
  readonly keys: (string | undefined)[];
  readonly messages: string[];
} {
  const result = resolveAppearance({ themeText, themePath: 'brand-theme.yml' });
  return {
    appearance: result.appearance,
    keys: result.diagnostics.map((diagnostic) => diagnostic.themeKey),
    messages: result.diagnostics.map((diagnostic) => diagnostic.message),
  };
}

describe('resolveAppearance totality', () => {
  it.each([
    ['nothing at all', ''],
    ['whitespace', '   \n\t\n'],
    ['a comment only', '# nothing here\n'],
    ['a bare scalar', 'just a string'],
    ['a list', '- one\n- two\n'],
    ['unclosed flow syntax', 'base:\n  font_size: [1, 2\n'],
    ['a tab where YAML forbids one', 'base:\n\tfont_size: 10\n'],
    ['a duplicated anchor reference', 'a: &a x\nb: *a\nc: *missing\n'],
    ['a null document', 'null\n'],
    ['deeply nested nonsense', 'a:\n b:\n  c:\n   d:\n    e: 1\n'],
  ])('returns a usable appearance for %s', (_label, text) => {
    const result = resolveAppearance({ themeText: text, themePath: 'theme/x-theme.yml' });
    expect(result.appearance.page.widthPt).toBeGreaterThan(0);
    expect(result.appearance.base.fontSizePt).toBeGreaterThan(0);
  });

  it('never throws, whatever arrives', () => {
    const hostile = [
      'page:\n  size: [1e400, 1e400]\n',
      // A CYCLE, which is harmless on its own: resolution is forward-only, so `$a` simply never
      // finds a value. It is the EXPANDING shape below that this had to be extended to cover.
      'base:\n  font_size: $a\na: $b\nb: $a\n',
      `base:\n  font_family: ${'A'.repeat(5000)}\n`,
      'base: !!js/function "function(){}"\n',
      // Twenty-six levels of `$a $a` doubles a 393-byte document past the platform's own maximum
      // string length, and `String#replaceAll` signals that by THROWING. Nothing caught it: this is
      // called from a `useMemo` on the thread that renders the preview, so the author got a thrown
      // render instead of a fallback appearance — against this module's own headline promise.
      [
        'extends: default',
        'a0: xxxxxxxx',
        ...Array.from({ length: 30 }, (_unused, level) => `a${level + 1}: $a${level} $a${level}`),
        'base:',
        '  font_size: $a30',
        '',
      ].join('\n'),
      // The same shape spread across many keys rather than down one chain.
      [
        'extends: default',
        `seed: ${'x'.repeat(2000)}`,
        ...Array.from({ length: 5000 }, (_unused, index) => `k${index}: $seed $seed`),
        '',
      ].join('\n'),
    ];
    for (const text of hostile) {
      expect(() => resolveAppearance({ themeText: text })).not.toThrow();
    }
  });

  it('reports the value whose references could not be expanded, and keeps the rest of the theme', () => {
    const result = resolveAppearance({
      themeText: [
        'extends: default',
        'a0: xxxxxxxx',
        ...Array.from({ length: 30 }, (_unused, level) => `a${level + 1}: $a${level} $a${level}`),
        'base:',
        '  font_size: $a30',
        '  font_color: 1A4E8A',
        '',
      ].join('\n'),
      themePath: 'theme/expanding-theme.yml',
    });
    expect(result.themeApplied).toBe(true);
    expect(result.appearance.base.fontColor).toBe('1A4E8A');
    expect(result.appearance.base.fontSizePt).toBe(defaultAppearance().base.fontSizePt);
    expect(result.diagnostics.map((diagnostic) => diagnostic.themeKey)).toContain('base_font_size');
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
  });
});

describe('resolveAppearance with no theme', () => {
  it('gives the export’s own default appearance and reports nothing', () => {
    const result = resolveAppearance();
    expect(result.appearance).toBe(defaultAppearance());
    expect(result.diagnostics).toEqual([]);
    expect(result.themeApplied).toBe(false);
  });

  it('treats an empty theme document the same as none', () => {
    expect(resolveAppearance({ themeText: '  \n' }).appearance).toBe(defaultAppearance());
  });

  it('gives the default page its A4 geometry and the default theme’s own body face', () => {
    const { page, base } = defaultAppearance();
    expect(page).toEqual({
      widthPt: 595.28,
      heightPt: 841.89,
      marginPt: { top: 36, right: 48.24, bottom: 48.24, left: 48.24 },
      backgroundColor: 'FFFFFF',
    });
    expect(base.fontFamily).toBe('Noto Serif');
    expect(base.fontSizePt).toBe(10.5);
    expect(base.fontColor).toBe('333333');
  });

  it('declares the catalogue families the default theme references', () => {
    expect(defaultAppearance().fonts.map((font) => font.family)).toEqual(['M+ 1mn', 'Noto Serif']);
  });
});

describe('resolveAppearance when a colour stops the document loading', () => {
  /** A setting under a category none of the documents below write, so it can only come from them. */
  const WITNESS = 'page:\n  margin: 90\n';

  it.each([
    ['a channel that is not a number at all', 'base:\n  font_color: [a, 0, 0]\n'],
    ['a channel Psych typed as a boolean', 'base:\n  font_color: [yes, 0, 0]\n'],
    ['an empty channel', 'base:\n  font_color: [~, 0, 0]\n'],
    ['a fractional channel written as text', "base:\n  font_color: ['128.5', 0, 0]\n"],
    ['an infinite channel', 'base:\n  font_color: [.inf, 0, 0]\n'],
    ['an infinite CMYK channel, where the normalisation raises instead', 'base:\n  font_color: [.inf, 0, 0, 0]\n'],
    ['a channel under a key nothing reads', 'zzz_color: [a, 0, 0]\n'],
    ['a channel under a role', 'role:\n  x:\n    font_color: [a, 0, 0]\n'],
    ['a channel reached through a variable', 'brand: a\nbase:\n  font_color: [$brand, 0, 0]\n'],
    ['an element of a table border list', 'table:\n  border_color: [[a, 0, 0], [0, 0, 0]]\n'],
  ])('shows the default page and applies NOTHING, given %s', (_label, text) => {
    // `to_color` runs at LOAD time — `process_entry` calls it while the theme is being read
    // (`theme_loader.rb:182-188`) — so a channel `sprintf '%02X'` raises on leaves
    // `ThemeLoader.load_file` through `load_theme`'s BARE rescue (`converter.rb:556`) and the export
    // prints the document with the DEFAULT theme. Every document above was loaded through the
    // vendored gem under ruby 3.3.3 and every one of them raises: `ArgumentError` for a string
    // `Integer()` will not read, `TypeError` for a nil or a boolean, `FloatDomainError` for an
    // infinity — and for the CMYK array it is the normalisation's own `e.to_i` that raises.
    //
    // Was a per-key refusal: the preview applied every other setting in the document under one
    // `theme-value-rejected` warning, for a page the export dresses with none of them.
    // The witness sits under a category none of the documents above touch, so it is a setting that
    // would plainly have applied — and `toBe` on the shared default says none of it did.
    const result = resolveAppearance({ themeText: text + WITNESS, themePath: 'theme/c.yml' });
    expect(result.appearance).toBe(defaultAppearance());
    expect(result.themeApplied).toBe(false);
    expect(result.diagnostics.map((each) => each.code)).toEqual(['theme-unparseable']);
    expect(result.appearance.page.marginPt.top).toBe(defaultAppearance().page.marginPt.top);
  });

  it('points at the line the colour was written on, and repeats none of the document', () => {
    const result = resolveAppearance({
      themeText: 'base:\n  font_size: 20\n  font_color: [</style>, 0, 0]\n',
      themePath: 'theme/c.yml',
    });
    expect(result.diagnostics).toHaveLength(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic.location).toEqual({ path: 'theme/c.yml', line: 3 });
    expect(diagnostic.message).not.toContain('</style>');
    expect(diagnostic.detail ?? '').not.toContain('</style>');
    // The key is not named either: most colour keys are the document's own text, and one sentence
    // has to hold for all of them.
    expect(diagnostic.message).not.toContain('font_color');
  });

  it.each([
    ['out of range, which loads and is prawn’s to refuse', 'base:\n  font_color: [300, 0, 0]\n'],
    ['negative, which loads the same way', 'base:\n  font_color: [-1, 0, 0]\n'],
    ['a channel written as text in another base', "base:\n  font_color: ['0x10', 0, 0]\n"],
    ['a CMYK array of text, which to_f reads as zero', "base:\n  font_color: [a, a, a, a]\n"],
    ['a table border list, whose elements are colours read one at a time', 'table:\n  border_color: [a, 0, 0]\n'],
  ])('keeps reading the rest of the document, given %s', (_label, text) => {
    // The contrast that makes the refusal above meaningful. `[300, 0, 0]` LOADS — it is the string
    // `12C0000` — and prawn raises about it much later, so the document was read and the honest
    // reproduction is a per-key fall-back. `['0x10', 0, 0]` loads as `100000` and is inked.
    // `[a, a, a, a]` is CMYK, whose channels go through `to_f` and answer zero, so it is white. And
    // `table_border_color` is the key whose ARRAY is a list of colours rather than one RGB triple
    // (`theme_loader.rb:184`), so its elements are read one at a time and `a` is the six characters
    // `00000A` — the same value under `base: font_color` throws the document away. Measured, each of
    // them, against the vendored gem under ruby 3.3.3.
    const result = resolveAppearance({ themeText: text + WITNESS, themePath: 'theme/c.yml' });
    expect(result.themeApplied).toBe(true);
    expect(result.appearance.page.marginPt.top).toBe(90);
  });
});

describe('resolveAppearance when a padding edge stops the document loading', () => {
  /** A setting under a category none of the documents below write, so it can only come from them. */
  const WITNESS = 'page:\n  margin: 90\n';

  it.each([
    ['a mapping as the top edge', 'example:\n  padding: [{a: 1}, 0, 0, 0]\n'],
    ['an empty mapping as the top edge', 'example:\n  padding: [{}, 0, 0, 0]\n'],
    ['a list as the top edge', 'example:\n  padding: [[9], 0, 0, 0]\n'],
    ['an empty list as the top edge', 'example:\n  padding: [[], 0, 0, 0]\n'],
    ['a boolean as the top edge', 'example:\n  padding: [true, 0, 0, 0]\n'],
    ['a false as the top edge', 'example:\n  padding: [false, 0, 0, 0]\n'],
    ['a mapping as the bottom edge, under a top edge that reaches it', 'example:\n  padding: [5, 0, {a: 1}, 0]\n'],
    ['a list as the bottom edge, under a zero top edge', 'example:\n  padding: [0, 0, [9], 0]\n'],
    ['a bad top edge in a list too short to have a bottom one', 'example:\n  padding: [{a: 1}]\n'],
    ['a bad top edge under quote.padding', 'quote:\n  padding: [{a: 1}, 0, 0]\n'],
    ['a bad top edge under sidebar.padding', 'sidebar:\n  padding: [{a: 1}, 0, 0]\n'],
    ['a bad top edge under verse.padding', 'verse:\n  padding: [{a: 1}, 0, 0]\n'],
    ['a bad top edge under the flat spelling of the key', 'example_padding: [{a: 1}, 0, 0]\n'],
    ['a bad top edge an alias carried in', 'z: &z {a: 1}\nexample:\n  padding: [*z, 0, 0]\n'],
    ['a bad top edge a variable resolved to', 'x: [1, 2]\nexample:\n  padding: [$x, 0, 0]\n'],
    ['a bad bottom edge a variable resolved to', 'x: true\nexample:\n  padding: [5, 0, $x]\n'],
    ['a whole value a variable resolved to', 'x: [true, 0, 0]\nexample:\n  padding: $x\n'],
  ])('shows the default page and applies NOTHING, given %s', (_label, text) => {
    // `val[2] = val[0] if ::Array === val && val[0].to_f >= 0 && val[2].to_f <= 0`
    // (`theme_loader.rb:180`) runs while the theme is being READ, so an element with no `to_f` leaves
    // `ThemeLoader.load` through `load_theme`'s BARE rescue (`converter.rb:556`) and the export prints
    // the document with the DEFAULT theme. Every document above was loaded through the vendored gem
    // under ruby 3.3.3 and every one raises `undefined method 'to_f'` — for `true`, `false`, an Array
    // and a Hash in turn — and it raises the same under all four of the keys the rewrite applies to.
    //
    // Was a per-key refusal: the preview reported `example.padding` alone and applied every other
    // setting in the document, for a page the export dresses with none of them. The witness sits
    // under a category none of the documents above touch, so it is a setting that would plainly have
    // applied, and `toBe` on the shared default says none of it did.
    const result = resolveAppearance({ themeText: text + WITNESS, themePath: 'theme/p.yml' });
    expect(result.appearance).toBe(defaultAppearance());
    expect(result.themeApplied).toBe(false);
    expect(result.diagnostics.map((each) => each.code)).toEqual(['theme-unparseable']);
  });

  it.each([
    ['a mapping under a NEGATIVE top edge, which short-circuits the test', 'example:\n  padding: [-5, 0, {a: 1}, 0]\n'],
    ['a list under a negative top edge', 'example:\n  padding: [-5, 0, [9], 0]\n'],
    ['a boolean under a top edge Psych typed as a NaN', 'example:\n  padding: [.nan, 0, true, 0]\n'],
    ['a mapping in the second position, which neither test reads', 'example:\n  padding: [5, {a: 1}]\n'],
    ['a mapping in the fourth position, which neither test reads', 'example:\n  padding: [5, 0, 0, {a: 1}]\n'],
    ['an empty top edge, because nil has a to_f', 'example:\n  padding: [~, 0, ~, 0]\n'],
    ['a top edge written as prose, whose to_f is zero', 'example:\n  padding: [abc, 0, 0, 0]\n'],
    ['a mapping under a padding key the rewrite does not apply to', 'admonition:\n  padding: [{a: 1}, 0, 0]\n'],
    ['a padding that is not a list at all', 'example:\n  padding: true\n'],
  ])('keeps reading the rest of the document, given %s', (_label, text) => {
    // The contrast that makes the refusal above meaningful, and the half of it that is easiest to get
    // wrong. The `&&` SHORT-CIRCUITS: a negative top edge means `val[2].to_f` is never called, so
    // `[-5, 0, {a: 1}, 0]` loads and comes back `[-5, 0, {"a"=>1}, 0]` — measured against the vendored
    // gem under ruby 3.3.3. `Float::NAN >= 0` is false, so a NaN short-circuits the same way. The
    // second and fourth positions are never read at either test. `nil.to_f` is zero, which is what
    // makes the rewrite GROW a short array rather than raise on it. `'abc'.to_f` is zero too. And
    // `admonition_padding` is not one of `PaddingBottomHackKeys`, so the rewrite never runs on it.
    // Refusing any of these would be refusing a document the export prints.
    const result = resolveAppearance({ themeText: text + WITNESS, themePath: 'theme/p.yml' });
    expect(result.themeApplied).toBe(true);
    expect(result.appearance.page.marginPt.top).toBe(90);
  });

  it('points at the line the padding was written on, and repeats none of the document', () => {
    const result = resolveAppearance({
      themeText: 'base:\n  font_size: 20\nexample:\n  padding: [{"</style>": 1}, 0, 0]\n',
      themePath: 'theme/p.yml',
    });
    expect(result.diagnostics).toHaveLength(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic.location).toEqual({ path: 'theme/p.yml', line: 4 });
    expect(diagnostic.message).not.toContain('</style>');
    expect(diagnostic.detail ?? '').not.toContain('</style>');
    // The key is not named either: one sentence has to hold for all four of the padding keys, and
    // three of the four can be written under a category this module does not claim.
    expect(diagnostic.message).not.toContain('example_padding');
  });

  it('reports the refusal the loader reaches FIRST, whichever kind it is', () => {
    // A colour and a padding raise at the same place, out of `process_entry` and into the same bare
    // rescue, so which sentence an author reads is decided by which one the loader folds first —
    // not by which kind it is. Held both ways round, because keeping a first-of-each let a padding
    // written below a bad colour take the sentence and send its author to the wrong line.
    const colourFirst = resolveAppearance({
      themeText: 'base:\n  font_color: [a, 0, 0]\nexample:\n  padding: [{a: 1}, 0, 0]\n',
      themePath: 'theme/p.yml',
    });
    expect(colourFirst.diagnostics[0].detail).toContain('A colour in the theme document');
    expect(colourFirst.diagnostics[0].location).toEqual({ path: 'theme/p.yml', line: 2 });
    const paddingFirst = resolveAppearance({
      themeText: 'example:\n  padding: [{a: 1}, 0, 0]\nbase:\n  font_color: [a, 0, 0]\n',
      themePath: 'theme/p.yml',
    });
    expect(paddingFirst.diagnostics[0].detail).toContain('A padding setting in the theme document');
    expect(paddingFirst.diagnostics[0].location).toEqual({ path: 'theme/p.yml', line: 2 });
  });
});

describe('resolveAppearance when a negated variable stops the document loading', () => {
  /** A setting under a category none of the documents below write, so it can only come from them. */
  const WITNESS = 'page:\n  margin: 90\n';

  it.each([
    ['an empty value', 'v:\nbase:\n  font_size: -$v\n'],
    ['an explicit null', 'v: ~\nbase:\n  font_size: -$v\n'],
    ['a true', 'v: true\nbase:\n  font_size: -$v\n'],
    ['a false', 'v: false\nbase:\n  font_size: -$v\n'],
    ['a list', 'v: [1, 2]\nbase:\n  font_size: -$v\n'],
    ['an empty list', 'v: []\nbase:\n  font_size: -$v\n'],
    ['a nested list', 'v: [[1]]\nbase:\n  font_size: -$v\n'],
    ['a list an anchor carried in', 'z: &z [1, 2]\nv: *z\nbase:\n  font_size: -$v\n'],
    // Every position a value can be written in, because the branch is in `expand_vars` and every
    // one of these goes through it.
    ['it under a colour key', 'v: true\nbase:\n  font_color: -$v\n'],
    ['it under a content key, whose to_s converts the holder and not the target', 'v: true\nmenu:\n  caret_content: -$v\n'],
    ['it inside a padding list', 'v: true\nexample:\n  padding: [-$v, 0, 0]\n'],
    ['it as an element of any list', 'v: true\nzzz: [1, -$v]\n'],
    ['it under a deprecated key, which the loader stores with no arithmetic', 'v: true\nblockquote_font_size: -$v\n'],
    ['it inside an admonition icon’s properties', 'v: true\nadmonition_icon_tip:\n  stroke_color: -$v\n'],
    ['it under a key the model does not read', 'v: true\nzzz: -$v\n'],
    ['a reference whose hyphens the loader folds', 'my-var: true\nzzz: -$my-var\n'],
    // `resolve_var` tries the deprecated CATEGORY spelling before it warns, so the reference finds
    // `quote_font_size` — and an empty one is a nil to negate. Measured: this raises, and the same
    // document with `font_size: 9` loads and stores `-9`.
    ['a reference that resolves through a deprecated category', 'blockquote:\n  font_size:\nzzz: -$blockquote_font_size\n'],
  ])('shows the default page and applies NOTHING, given %s', (_label, text) => {
    // `Numeric === (val = resolve_var vars, negated_expr, $1) ? -val : '-' + val`
    // (`theme_loader.rb:207`). The false branch is `String#+`, which takes a String and nothing else,
    // so anything that is neither Numeric nor String raises `TypeError: no implicit conversion of …
    // into String` out of `expand_vars`. That leaves `ThemeLoader.load` through `load_theme`'s BARE
    // rescue (`converter.rb:556`), and the export prints the whole document with the DEFAULT theme.
    // Every document above was loaded through the vendored gem under ruby 3.3.3 and every one raises.
    //
    // The preview applied all of them in silence — it read `-$v` as the four characters `-true`, or
    // `-1,2`, and dressed a page from a document the export dresses none of. The witness sits under a
    // category none of the documents above touch, so it is a setting that would plainly have applied,
    // and `toBe` on the shared default says none of it did.
    const result = resolveAppearance({ themeText: text + WITNESS, themePath: 'theme/n.yml' });
    expect(result.appearance).toBe(defaultAppearance());
    expect(result.themeApplied).toBe(false);
    expect(result.diagnostics.map((each) => each.code)).toEqual(['theme-unparseable']);
  });

  it.each([
    ['an integer, which is Numeric and negates', 'v: 12\nbase:\n  font_size: -$v\n', -12],
    ['a float', 'v: 12.5\nbase:\n  font_size: -$v\n', -12.5],
  ])('negates a %s and keeps reading', (_label, text, expected) => {
    const result = resolveAppearance({ themeText: text + WITNESS, themePath: 'theme/n.yml' });
    expect(result.themeApplied).toBe(true);
    expect(result.appearance.base.fontSizePt).toBe(expected);
  });

  it.each([
    // A String concatenates rather than raising, and a name nothing defines resolves to the
    // reference TEXT — which is a String, so it concatenates too.
    ['a string, which concatenates', 'v: abc\nzzz: -$v\n'],
    ['a name nothing defines', 'zzz: -$nowhere\n'],
    ['a string under a claimed key', 'v: abc\nbase:\n  font_family: -$v\n'],
    // The gsub path, whose block result is `to_s`'d and so never raises. The negation branch is
    // reached only when the `$` is at index 1, the first character is `-`, and the REMAINDER is a
    // whole lone reference.
    ['a doubled minus, which puts the $ at index 2', 'v: true\nzzz: --$v\n'],
    ['a minus with a letter in front of it', 'v: true\nzzz: a-$v\n'],
    ['a negation with anything after it', 'v: true\nzzz: -$v b\n'],
    ['a trailing character the lone pattern excludes', 'v: true\nzzz: -$v.\n'],
    // Numeric, so it negates — and the model then declines the size for a reason of its own, which
    // is not this refusal. Measured: the gem loads it and stores `base_font_size => NaN`.
    ['a NaN, which is Numeric', 'v: .nan\nbase:\n  font_size: -$v\n'],
    // `LoneVariableRx` carries no `i`, so an upper-case reference matches nothing at all and the
    // six characters stay where they are.
    ['an upper-case reference, which the pattern never matches', 'v: true\nzzz: -$V\n'],
    ['a lone reference that is not negated', 'v: true\nzzz: $v\n'],
  ])('keeps reading the rest of the document, given %s', (_label, text) => {
    // The contrast that makes the refusal above meaningful, and the half that decides whether the
    // fix over-refuses. Every document here loads in the vendored gem under ruby 3.3.3, so refusing
    // any of them would be refusing a document the export prints.
    const result = resolveAppearance({ themeText: text + WITNESS, themePath: 'theme/n.yml' });
    expect(result.themeApplied).toBe(true);
    expect(result.appearance.page.marginPt.top).toBe(90);
  });

  it('keeps reading a negation of a key it stores no value under, which the export refuses', () => {
    // Read here and REFUSED there, so this is the divergence and not the fidelity — which is why it
    // is not a row in the table above, whose whole claim is that every document in it loads.
    // `admonition_icon_tip` is stored by the loader as a Hash, and negating one raises: measured
    // against the vendored gem under ruby 3.3.3, this document raises
    // `TypeError: no implicit conversion of Hash into String` and the export prints the default page.
    //
    // Left as a divergence deliberately. The flat key space here holds no value under that name at
    // all — the icon is read one level down — so the reference dangles, and refusing on a name this
    // module has no value for would be guessing at what the export holds rather than knowing it. A
    // change that came to refuse it would be an improvement, and would fail here rather than reading
    // as a regression in the over-refusal table.
    const result = resolveAppearance({
      themeText: `admonition_icon_tip:\n  name: fa-x\nzzz: -$admonition_icon_tip\n${WITNESS}`,
      themePath: 'theme/n.yml',
    });
    expect(result.themeApplied).toBe(true);
    expect(result.appearance.page.marginPt.top).toBe(90);
  });

  it('points at the line the negation was written on, and repeats none of the document', () => {
    const result = resolveAppearance({
      // A reference's name is drawn from `[a-z0-9_-]+`, so this is as much of the document's own
      // text as one can carry — and it is the author's, addressed to whoever the theme was shared
      // with. Measured: the gem raises `TypeError` on this document.
      themeText:
        'base:\n  font_size: 20\nmrkr_contact_admin_at_evil_example: true\nzzz: -$mrkr_contact_admin_at_evil_example\n',
      themePath: 'theme/n.yml',
    });
    expect(result.diagnostics).toHaveLength(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic.message).not.toContain('evil');
    expect(diagnostic.detail ?? '').not.toContain('evil');
    expect(diagnostic.themeKey).toBeUndefined();
  });

  it('points at the setting rather than at the definition, which is the line to change', () => {
    // Both lines are needed to make the document fail and neither is wrong on its own, so the one to
    // send an author to is the one holding the minus sign.
    const result = resolveAppearance({
      themeText: 'v: true\npage:\n  margin: 90\nbase:\n  font_size: -$v\n',
      themePath: 'theme/n.yml',
    });
    expect(result.diagnostics[0].location).toEqual({ path: 'theme/n.yml', line: 5 });
    expect(result.diagnostics[0].detail).toContain('minus sign');
  });

  it('is reported ahead of a colour and a padding in the same setting', () => {
    // Expansion runs BEFORE `to_color` and before the padding rewrite — both read what it produced —
    // so a value that is wrong in two ways is refused for the one the loader reaches first. Told
    // apart by the sentence, because the two send an author to different things to fix.
    const colour = resolveAppearance({ themeText: 'v: true\nbase:\n  font_color: -$v\n' });
    expect(colour.diagnostics[0].detail).toContain('minus sign');
    const padding = resolveAppearance({ themeText: 'v: true\nexample:\n  padding: [-$v, 0, 0]\n' });
    expect(padding.diagnostics[0].detail).toContain('minus sign');
  });

  it('reports whichever refusal the loader reaches first, across all three kinds', () => {
    // The same rule the colour and the padding already hold between them, now over three. Held both
    // ways round, because keeping a first-of-each would let a negation written below a bad colour
    // take the sentence and send its author to the wrong line.
    const negationFirst = resolveAppearance({
      themeText: 'v: true\nzzz: -$v\nbase:\n  font_color: [a, 0, 0]\n',
      themePath: 'theme/n.yml',
    });
    expect(negationFirst.diagnostics[0].detail).toContain('minus sign');
    expect(negationFirst.diagnostics[0].location).toEqual({ path: 'theme/n.yml', line: 2 });
    const colourFirst = resolveAppearance({
      themeText: 'v: true\nbase:\n  font_color: [a, 0, 0]\nzzz: -$v\n',
      themePath: 'theme/n.yml',
    });
    expect(colourFirst.diagnostics[0].detail).toContain('A colour in the theme document');
    expect(colourFirst.diagnostics[0].location).toEqual({ path: 'theme/n.yml', line: 3 });
  });

  it.each([
    ['a catalogue path', 'v: true\nfont:\n  catalog:\n    Brand:\n      normal: -$v\n'],
    ['a catalogue family written as one path for every style', 'v: true\nfont:\n  catalog:\n    Brand: -$v\n'],
    ['a fallback name', 'v: true\nfont:\n  fallbacks: [-$v]\n'],
    // The FLAT spellings of the same two keys. This module does not read the faces they declare —
    // deliberately — and it still has to see the refusal, because a path nobody looked at is a
    // document the preview dresses a page from and the export does not. This was the one negation
    // the cascade fix alone still applied, found by fuzzing against the gem.
    ['a flat catalogue path', 'v: true\nfont_catalog:\n  Brand:\n    normal: -$v\n'],
    ['a flat fallback name', 'v: true\nfont_fallbacks: [-$v]\n'],
  ])('shows the default page and applies NOTHING, given %s that negates one', (_label, text) => {
    // `process_entry` runs the same `expand_vars` over every catalogue path and every fallback name
    // (`theme_loader.rb:144` and `:157`), so the same value refuses the same document from there.
    // All five raise `TypeError` in the vendored gem under ruby 3.3.3.
    const result = resolveAppearance({ themeText: text + WITNESS, themePath: 'theme/n.yml' });
    expect(result.appearance).toBe(defaultAppearance());
    expect(result.themeApplied).toBe(false);
    // A sentence of its own: a catalogue path is not a setting and has no line to point at, so
    // naming the font catalogue is what replaces the location an author would navigate by.
    expect(result.diagnostics[0].detail).toContain('font file path or fallback name');
    expect(result.diagnostics[0].location).toEqual({ path: 'theme/n.yml' });
  });

  it.each([
    ['a catalogue path naming a string', 'v: fonts\nfont:\n  catalog:\n    Brand:\n      normal: -$v/x.ttf\n'],
    ['a catalogue path whose reference dangles', 'font:\n  catalog:\n    Brand:\n      normal: -$nowhere\n'],
    ['a fallback naming a number', 'v: 3\nfont:\n  fallbacks: [-$v]\n'],
    ['a flat catalogue path naming a string', 'v: fonts\nfont_catalog:\n  Brand:\n    normal: -$v\n'],
  ])('keeps reading the rest of the document, given %s', (_label, text) => {
    const result = resolveAppearance({ themeText: text + WITNESS, themePath: 'theme/n.yml' });
    expect(result.themeApplied).toBe(true);
    expect(result.appearance.page.marginPt.top).toBe(90);
  });

  it('reports a font declaration ahead of the settings written below it', () => {
    // The catalogue sits at the split, so a refusal in one of its paths is one the loader meets
    // BEFORE every setting under it — and reporting it afterwards would send an author to a line the
    // export never reached. Measured against the vendored gem under ruby 3.3.3: the first document
    // raises `TypeError` out of the catalogue, and the same two lines the other way round raise
    // `ArgumentError` out of the colour, so the order really is the document's.
    const catalogueFirst = resolveAppearance({
      themeText: 'v: true\nfont:\n  catalog:\n    Brand:\n      normal: -$v\nbase:\n  font_color: [a, 0, 0]\n',
      themePath: 'theme/n.yml',
    });
    expect(catalogueFirst.diagnostics[0].detail).toContain('font file path or fallback name');
    const colourFirst = resolveAppearance({
      themeText: 'v: true\nbase:\n  font_color: [a, 0, 0]\nfont:\n  catalog:\n    Brand:\n      normal: -$v\n',
      themePath: 'theme/n.yml',
    });
    expect(colourFirst.diagnostics[0].detail).toContain('A colour in the theme document');
    expect(colourFirst.diagnostics[0].location).toEqual({ path: 'theme/n.yml', line: 3 });
  });

  it.each([
    ['a flat fallback list', 'font_fallbacks: [-$v]\nv: true\n'],
    ['a nested fallback list with no catalogue beside it', 'font:\n  fallbacks: [-$v]\nv: true\n'],
    ['a flat catalogue', 'font_catalog:\n  B:\n    normal: -$v\nv: true\n'],
    ['a nested catalogue', 'font:\n  catalog:\n    B:\n      normal: -$v\nv: true\n'],
  ])('expands %s against the values the loader had reached, not the finished ones', (_label, text) => {
    // The flat spellings are expanded for their refusal alone, and a refusal decided against the
    // WRONG values is a document refused for something the export never sees. A definition written
    // BELOW the declaration is not one the loader has when it reads it, so the reference dangles —
    // measured: this loads in the gem, and it would be refused by anything that resolved the whole
    // cascade first.
    const result = resolveAppearance({ themeText: text + WITNESS, themePath: 'theme/n.yml' });
    expect(result.themeApplied).toBe(true);
    expect(result.appearance.page.marginPt.top).toBe(90);
  });
});

describe('resolveAppearance when the document cannot be read', () => {
  const unreadable = resolveAppearance({
    themeText: 'base:\n  font_size: [1, 2\n',
    themePath: 'theme/broken-theme.yml',
  });

  it('falls back to the default appearance and says the theme did not apply', () => {
    expect(unreadable.appearance).toBe(defaultAppearance());
    expect(unreadable.themeApplied).toBe(false);
  });

  it('reports exactly one problem, as an error against the theme document', () => {
    expect(unreadable.diagnostics).toHaveLength(1);
    expect(unreadable.diagnostics[0]).toMatchObject({
      severity: 'error',
      code: 'theme-unparseable',
      resource: 'theme/broken-theme.yml',
      location: { path: 'theme/broken-theme.yml' },
    });
  });

  it('costs the document and nothing more — no per-key rejections pile up behind it', () => {
    expect(unreadable.diagnostics.every((diagnostic) => diagnostic.code === 'theme-unparseable')).toBe(true);
  });

  it.each([
    ['a tab used as indentation', 'a: 1\n\t</style><img src=x onerror=alert(1)>: 2\n'],
    ['an unclosed sequence', 'base:\n  size: [1, "; } html { display: none } .a {"\n'],
    ['an alias naming an anchor set after it', 'a: &a x\nb: *missing_</style>_anchor\n'],
  ])('repeats none of the document back when it could not be read at all, given %s', (_label, text) => {
    // The per-key rejection path was the only one this was ever asserted on. `theme-unparseable` —
    // the path that copies the PARSER's message into both `message` and `detail` — was never
    // exercised, and the `yaml` package appends a code frame of the offending line to that message.
    const result = resolveAppearance({ themeText: text, themePath: 'theme/broken-theme.yml' });
    expect(result.diagnostics).toHaveLength(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic.code).toBe('theme-unparseable');
    for (const fragment of ['</style>', '<img', 'onerror', 'display: none', '; }', 'missing_']) {
      for (const [field, value] of [
        ['message', diagnostic.message],
        ['detail', diagnostic.detail ?? ''],
      ] as const) {
        expect({ field, fragment, present: value.includes(fragment) }).toEqual({
          field,
          fragment,
          present: false,
        });
      }
    }
  });
});

describe('resolveAppearance when one value cannot be read', () => {
  const partial = resolveAppearance({
    themeText: [
      'extends: default',
      'base:',
      "  font_color: 'not-a-colour'",
      '  font_size: 13',
      'heading:',
      '  font_color: 1A4E8A',
      '',
    ].join('\n'),
    themePath: 'theme/partial-theme.yml',
  });

  it('keeps every other value the theme set', () => {
    expect(partial.appearance.base.fontSizePt).toBe(13);
    expect(partial.appearance.headings[2].fontColor).toBe('1A4E8A');
    expect(partial.themeApplied).toBe(true);
  });

  it('falls that one key back to the renderer’s default for it', () => {
    expect(partial.appearance.base.fontColor).toBe(defaultAppearance().base.fontColor);
  });

  it('reports exactly one problem, naming the key and where it was written', () => {
    expect(partial.diagnostics).toHaveLength(1);
    expect(partial.diagnostics[0]).toMatchObject({
      severity: 'warning',
      code: 'theme-value-rejected',
      themeKey: 'base_font_color',
      resource: 'theme/partial-theme.yml',
      location: { path: 'theme/partial-theme.yml', line: 3 },
    });
  });

  it('does not repeat the offending value back in the message', () => {
    expect(partial.diagnostics[0].message).not.toContain('not-a-colour');
  });

  it('reports a dangling variable reference once, naming what it could not find', () => {
    const result = resolveAppearance({
      themeText: 'extends: default\nbase:\n  font_size: $no_such_setting\n',
      themePath: 'theme/dangling-theme.yml',
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: 'theme-value-rejected', themeKey: 'base_font_size' });
  });

  it('reports a colour that was APPLIED and not applied whole, under its own code', () => {
    // The one thing this module says about a value it accepts. `to_color` cuts anything longer than
    // six characters to its first six, so the exported page really is painted with `FF0000` — measured
    // from a converted PDF, `1.0 0.0 0.0 scn`, the same operator as the same key set to `FF0000` — and
    // an author who wrote the rest of that value was told nothing at all about it.
    //
    // The code is what carries the difference: a rejection says the default was used instead, and
    // that would be untrue here. Fails with the truncation branch of `colour()` removed, which is how
    // this behaved until now.
    const result = resolveAppearance({
      themeText: 'extends: default\nbase:\n  font_color: "FF0000 /* x"\n',
      themePath: 'theme/cut-theme.yml',
    });
    expect(result.appearance.base.fontColor).toBe('FF0000');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'warning',
      code: 'theme-value-truncated',
      themeKey: 'base_font_color',
      resource: 'theme/cut-theme.yml',
      location: { path: 'theme/cut-theme.yml', line: 3 },
    });
    // The rule the whole diagnostic type rests on: none of the document's text travels with it.
    expect(result.diagnostics[0].message).not.toContain('/*');
    expect(result.diagnostics[0].message).not.toContain('FF0000');
  });

  it('says nothing about a colour the renderer’s OWN default theme cut, which no author can edit', () => {
    // Same gate as every other diagnostic here: a value the project's theme did not write is not the
    // project author's to fix.
    //
    // This says less than it looks like it says, and the comment it carried used to say more. It
    // claimed thirteen real themes had been read through it; they had been read, but not here — the
    // document is `extends: default` alone, which writes no project key, so the gate cannot fail this
    // assertion whatever it does, and the renderer's own default theme holds no colour longer than
    // six characters for it to have been asked about. What is left is a regression guard: a resolver
    // that manufactured a truncation out of the default cascade would fail it.
    //
    // The claim about the repository's themes now sits on `the themes already in this repository`,
    // which is where those thirteen are actually read. The GATE is checked in
    // `build-appearance.test.ts`, at the layer that takes `projectKeys` as an argument and can
    // therefore be handed a cut colour the project did not write.
    const result = resolveAppearance({ themeText: 'extends: default\n', themePath: 'theme/plain.yml' });
    expect(result.diagnostics.filter((each) => each.code === 'theme-value-truncated')).toEqual([]);
  });

  it('reports a colour cut short ONCE, not once for the cut and once for anything else', () => {
    // `note` keys on the theme key, so one key is one sentence however many readings reach it — and a
    // truncation must not become a second sentence about a key already spoken for.
    const result = resolveAppearance({
      themeText: 'extends: default\nbase:\n  font_color: 1234567\n  border_color: 7654321\n',
      themePath: 'theme/cut-twice.yml',
    });
    expect(result.diagnostics.map((each) => each.themeKey)).toEqual([
      'base_font_color',
      'base_border_color',
    ]);
    expect(result.appearance.base.fontColor).toBe('123456');
  });
});

describe('resolveAppearance and keys outside the closed set', () => {
  it('neither applies nor reports a key this style does not model', () => {
    const result = resolveAppearance({
      themeText: [
        'extends: default',
        'running-content:',
        '  start-at: toc',
        'footer:',
        '  height: 42',
        'title-page:',
        '  logo:',
        '    top: 25%',
        // A dot leader exists to carry the eye to a page number, and this style has no pages to
        // number — so its colour is a real theme key the style deliberately does not reproduce.
        'toc:',
        '  dot-leader:',
        '    font-color: AAB2BB',
        '',
      ].join('\n'),
      themePath: 'theme/unpaginated-theme.yml',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.appearance).toEqual(defaultAppearance());
  });

  it('does not report a key it does not model even when that key’s value is nonsense', () => {
    const result = resolveAppearance({
      themeText: 'extends: default\nfooter:\n  height: not-a-height\n',
    });
    expect(result.diagnostics).toEqual([]);
  });
});

describe('resolveAppearance determinism', () => {
  const text = 'extends: default\nbase:\n  font_size: 12\nheading:\n  font_color: 1A4E8A\n';

  it('gives a deeply equal result for identical input, every time', () => {
    const first = resolveAppearance({ themeText: text, themePath: 'a-theme.yml' });
    const second = resolveAppearance({ themeText: text, themePath: 'a-theme.yml' });
    expect(second).toEqual(first);
  });

  it('does not depend on what was resolved before it', () => {
    const before = resolveAppearance({ themeText: text });
    resolveAppearance({ themeText: 'extends: default\nbase:\n  font_size: 99\n' });
    resolveAppearance({ themeText: 'garbage: [' });
    expect(resolveAppearance({ themeText: text })).toEqual(before);
  });

  it('leaves the default appearance untouched after resolving a theme that overrides everything', () => {
    const snapshot = JSON.stringify(defaultAppearance());
    resolveAppearance({ themeText: 'extends: default\npage:\n  size: A3\nbase:\n  font_size: 30\n' });
    expect(JSON.stringify(defaultAppearance())).toBe(snapshot);
  });
});

describe('the model’s own invariants', () => {
  /**
   * The model fields that carry the theme's own text by design, as this style's contract intends.
   *
   * Four of the renderer's values ARE text an author chooses: the sign between two key caps, the
   * caret between the parts of a menu path, and the two halves of the bracket around a button's
   * label. Nothing can parse those into a closed vocabulary — they are the vocabulary — so they reach
   * the model as written, and the containment lives one layer down, in `appearance-to-css.ts`, which
   * escapes every code point of them as `\XXXX ` before any of it becomes CSS.
   *
   * The fixture below therefore sets all four, which the previous fixture did not: it set colours,
   * sizes, families and a page size, every one of which has a parser behind it, so the "no raw theme
   * substring" assertion below was passing on values that could not have carried one. Adding
   * `kbd.separator` alone failed it.
   */
  const AUTHOR_TEXT_PATHS: ReadonlySet<string> = new Set([
    'kbd.separator',
    'menu.caretContent',
    'button.content.before',
    'button.content.after',
  ]);

  const hostile = resolveAppearance({
    themeText: [
      'extends: default',
      'page:',
      "  background_color: 'FFFFFF; } html { display: none'",
      '  size: NotARealSize',
      '  margin: [999999in, 0, 0, 0]',
      'base:',
      "  font_family: \"Noto Serif'; background: url(https://example.invalid/x)\"",
      '  font_size: 1e9',
      "  line_height: '</style><script>alert(1)</script>'",
      'code:',
      "  background_color: 'red'",
      'heading:',
      "  font_color: 'javascript:alert(1)'",
      // The four values that carry author text by design, and the one that used to.
      'kbd:',
      '  separator: \'a; } body { display: none } .x {\'',
      'menu:',
      "  caret_content: 'b; } body { display: none } .y {'",
      'button:',
      "  content: '; } .z { (%s); } body { display: none } .z2 {'",
      'font:',
      '  catalog:',
      '    "Brand\'; } body { display: none } .w {":',
      "      normal: \"fonts/a'; } body { display: none }.ttf\"",
      '',
    ].join('\n'),
    themePath: 'theme/hostile-theme.yml',
  });

  it('carries no CSS unit anywhere — the model is unit-free points', () => {
    for (const scalar of scalarsOf(defaultAppearance())) {
      if (typeof scalar !== 'string') continue;
      expect(scalar).not.toMatch(/\d(?:px|rem|em|pt|in|mm|cm|%)\b/);
    }
  });

  /** Fragments that would end a declaration or open a rule, if any of them reached CSS unescaped. */
  const DANGEROUS = [
    '; }',
    'display: none',
    'url(',
    'https://',
    '<script',
    '</style>',
    'javascript:',
    'background:',
  ];

  it('carries no value that is a raw substring of a hostile document, outside the fields that are text', () => {
    // What this guarantees, precisely: every field with a PARSER behind it carries a value from that
    // parser's own closed vocabulary and nothing else. It does NOT guarantee the model is free of
    // theme text — four fields are theme text — and the version of this test that walked every scalar
    // implied that it did, while its fixture never set one of the four.
    for (const [path, scalar] of scalarEntriesOf(hostile.appearance)) {
      if (typeof scalar !== 'string' || AUTHOR_TEXT_PATHS.has(path)) continue;
      for (const fragment of DANGEROUS) {
        expect({ path, scalar, fragment, present: scalar.includes(fragment) }).toEqual({
          path,
          scalar,
          fragment,
          present: false,
        });
      }
    }
  });

  it('carries the theme’s own text in exactly the four fields that are text, and nowhere else', () => {
    const carrying = scalarEntriesOf(hostile.appearance)
      .filter(([, scalar]) => typeof scalar === 'string' && DANGEROUS.some((f) => scalar.includes(f)))
      .map(([path]) => path);
    expect(carrying.toSorted()).toEqual([...AUTHOR_TEXT_PATHS].toSorted());
  });

  it('puts a catalogue family name through the same parser a font-family setting goes through', () => {
    // `fonts[].family` was the one model string with no parser and no bound: `font.catalog`'s keys
    // were promoted into it as written, so the file header's rule — nothing leaves this boundary but
    // a typed value — did not hold for it, and nothing told the author their face would never load.
    for (const font of hostile.appearance.fonts) {
      expect({ family: font.family, safe: /^[\w +.-]{1,64}$/.test(font.family) }).toEqual({
        family: font.family,
        safe: true,
      });
      for (const face of Object.values(font.declaredFaces)) {
        expect({ face, safe: /^[\w ./+-]{1,256}$/.test(face) }).toEqual({ face, safe: true });
      }
    }
    expect(hostile.diagnostics.some((diagnostic) => diagnostic.code === 'theme-font-unavailable')).toBe(true);
  });

  it('still shows a usable page after every value in it was rejected', () => {
    expect(hostile.appearance.page.backgroundColor).toBe('FFFFFF');
    expect(hostile.appearance.page.widthPt).toBe(595.28);
    expect(hostile.appearance.base.fontFamily).toBe('Noto Serif');
    expect(hostile.appearance.code.backgroundColor).toBe('F5F5F5');
  });

  it('reports each rejected value once, and none of them as an error', () => {
    const keys = hostile.diagnostics.map((diagnostic) => diagnostic.themeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(hostile.diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
    expect(keys).toContain('page_size');
    expect(keys).toContain('base_font_family');
    expect(keys).toContain('heading_font_color');
    // A colour the RENDERER refuses too. `page.background-color` is deliberately not in this list
    // any more: `FFFFFF; } html { display: none` is truncated to `FFFFFF` by `to_color` and the
    // export paints the page white, so reporting it would be reporting a value that works. What
    // makes it safe is the shape of the answer, which the test below states outright.
    expect(keys).toContain('code_background_color');
  });

  it('truncates a colour the way the export does, rather than rejecting what the export inks', () => {
    // Measured against the vendored gem under ruby 3.3.3: `to_color` slices the first six characters
    // off any longer value, so this theme's page really is white in the PDF. The protection is that
    // six hexadecimal digits is the ONLY thing that can come back — there is nothing left of the
    // declaration the value was trying to close.
    expect(hostile.appearance.page.backgroundColor).toBe('FFFFFF');
    // Restated over the stronger invariant. This used to assert that nothing was SAID about the key,
    // which was a characterisation of the silence rather than a rule: the value is applied, whole and
    // faithfully, and the author was told nothing about the rest of what they wrote. Both halves are
    // now pinned — the colour is still the export's, and the cut is now reported, under a code that
    // says the value was applied rather than rejected.
    const reported = hostile.diagnostics.filter(
      (diagnostic) => diagnostic.themeKey === 'page_background_color',
    );
    expect(reported.map((diagnostic) => diagnostic.code)).toEqual(['theme-value-truncated']);
    expect(reported[0]?.message).toMatch(/first six characters/);
    // …while a value whose first six characters are NOT hexadecimal has no page to preview at all:
    // `red` becomes `RREEDD`, which prawn refuses outright, so the export writes no PDF.
    expect(hostile.appearance.code.backgroundColor).toBe('F5F5F5');
  });

  it('holds every length as a finite number', () => {
    for (const scalar of scalarsOf(defaultAppearance())) {
      if (typeof scalar === 'number') expect(Number.isFinite(scalar)).toBe(true);
    }
  });
});

/** Resolve a theme body over the default cascade, for the unit tests below. */
function resolveOverDefault(body: string): ReturnType<typeof resolveAppearance> {
  return resolveAppearance({ themeText: `extends: default\n${body}`, themePath: 'theme/units-theme.yml' });
}

describe('resolveAppearance and the case a document wrote', () => {
  it('does not read an upper-cased key, because the loader does not fold case', () => {
    // `key.tr '-', '_'` (`theme_loader.rb:132`) is the whole of the loader's key normalisation, and
    // `ThemeData` keys by `name.to_sym`, so `:BASE_FONT_SIZE` and `:base_font_size` are two settings.
    // Run against the vendored gem under ruby 3.3.3, this document loads `BASE_FONT_SIZE => 30` and
    // leaves `base_font_size` at the default theme's 10.5, so the PDF prints body text at 10.5.
    // Folding the case put the preview at 30 pt with nothing to say about it.
    const result = resolveOverDefault('BASE:\n  FONT_SIZE: 30\n');
    expect(result.appearance.base.fontSizePt).toBe(defaultAppearance().base.fontSizePt);
    expect(result.appearance.base.fontSizePt).toBe(10.5);
  });

  it('does not resolve an upper-cased $reference, because VariableRx has no `i`', () => {
    // `/\$([a-z0-9_-]+)/` (`theme_loader.rb:21`) cannot match `$Brand` at all, so `gsub` leaves the
    // text where it is and `resolve_var` never runs — which is also why the export warns about
    // nothing. Measured against the gem, `heading_font_color` comes back as the literal `"$BRAND"`.
    // Matching case-insensitively painted the heading `2A5DB0` in the preview alone.
    const result = resolveOverDefault('brand: 2A5DB0\nheading:\n  font_color: $Brand\n');
    expect(result.appearance.headings[1].fontColor).not.toBe('2A5DB0');
    expect(result.appearance.headings[1].fontColor).toBe(defaultAppearance().headings[1].fontColor);
  });

  it('still reads the lower-case spelling every real theme is written in', () => {
    // The bound on the change above: the gem's own themes, this repository's, and everything the
    // theme editor writes are lower case, so making the match exact must not cost them anything.
    const result = resolveOverDefault('brand: 2A5DB0\nheading:\n  font_color: $brand\n  font-size: 30\n');
    expect(result.appearance.headings[1].fontColor).toBe('2A5DB0');
    expect(result.diagnostics).toEqual([]);
  });

  it('does not fold a dot in a key the document wrote, which the loader leaves alone', () => {
    // `base.font_size: 30` is one key with a dot in it, and the gem stores it under that name — an
    // inert setting, since nothing reads it. Folding the dot made it `base_font_size` and applied it,
    // so a theme could reach a setting through a spelling the export has no way to read.
    const result = resolveOverDefault('base.font_size: 30\n');
    expect(result.appearance.base.fontSizePt).toBe(10.5);
  });
});

describe('resolveAppearance and the units the renderer resolves', () => {
  const resolve = resolveOverDefault;

  it('takes a relative page margin as points, because str_to_pt drops the suffix', () => {
    // `resolve_page_margin` (converter.rb:4432) sends each edge through `str_to_pt`
    // (measurements.rb:20), whose unit list is `in|mm|cm|pt|px|pc` and whose fallback is
    // `String#to_f`. So the export lays a `10%` margin at ten points; resolving it against body text
    // put it at 1.05 in the preview alone.
    expect(resolve('page:\n  margin: 10%\n').appearance.page.marginPt).toEqual({
      top: 10,
      right: 10,
      bottom: 10,
      left: 10,
    });
    expect(resolve('page:\n  margin: 1em\n').appearance.page.marginPt.top).toBe(1);
  });

  it('takes a relative padding, border width and indent as points too', () => {
    expect(resolve('sidebar:\n  padding: 2em\n').appearance.sidebar.paddingPt?.top).toBe(2);
    expect(resolve('quote:\n  border_left_width: 50%\n').appearance.quote.borderLeftWidthPt).toBe(50);
    expect(resolve('list:\n  indent: 1.5rem\n').appearance.list.indentPt).toBe(1.5);
  });

  it('reports none of those as a problem, because the export accepts them exactly as written', () => {
    expect(resolve('page:\n  margin: 10%\n').diagnostics).toEqual([]);
  });

  it('measures a heading’s em against body text, which is what encloses a heading', () => {
    const { appearance } = resolve('base:\n  font_size: 10\nheading:\n  h2:\n    font_size: 2em\n');
    expect(appearance.headings[2].fontSizePt).toBe(20);
  });

  it('measures rem against the root even where em is measured against something else', () => {
    const { appearance } = resolve(
      'base:\n  font_size: 10\nheading:\n  h2:\n    font_size: 30\ntoc:\n  title:\n    font_size: 2rem\n',
    );
    expect(appearance.toc.title?.fontSizePt).toBe(20);
  });

  it('measures the contents title’s em against the level-2 heading it is inked through', () => {
    // `theme_font_cascade [[:heading, level: 2], :toc_title]` (converter.rb:3949) opens the heading's
    // font before the title's, so `font_size` resolves the title's `em` against the heading's size.
    const { appearance } = resolve(
      'base:\n  font_size: 10\nheading:\n  h2:\n    font_size: 30\ntoc:\n  title:\n    font_size: 0.5em\n',
    );
    expect(appearance.toc.title?.fontSizePt).toBe(15);
  });

  it.each(['codespan', 'kbd', 'button', 'conum'])(
    'says it cannot resolve an em on %s, whose enclosing size is the text around it',
    (construct) => {
      // These reach prawn as fragment sizes (formatted_text/transform.rb:37,50,63) resolved against
      // the run they sit in, so one theme value is a different number in body text than in a heading.
      // There is no single size to measure them against, and guessing body text would draw a size the
      // export produces only sometimes.
      const result = resolve(`${construct}:\n  font_size: 0.8em\n`);
      expect(result.diagnostics.map((diagnostic) => diagnostic.themeKey)).toEqual([
        `${construct}_font_size`,
      ]);
      expect(result.diagnostics[0].message).toMatch(/relative to the size of whatever text/);
    },
  );

  it('still resolves rem on those, because the root is known wherever they appear', () => {
    const result = resolve('base:\n  font_size: 10\ncodespan:\n  font_size: 0.8rem\n');
    expect(result.diagnostics).toEqual([]);
    expect(result.appearance.codespan.fontSizePt).toBe(8);
  });
});

// Every number below was read out of a PDF this repository's own reference toolchain produced —
// `generate-reference.mjs` over the pinned 2.3.24 image — rather than out of `converter.rb`. The
// stroke operators are quoted where they decide a case.
describe('a quotation or a verse that asks for both a left rule and a frame', () => {
  const resolve = resolveOverDefault;
  const RULED = 'quote:\n  border_color: 1A4E8A\n  border_width: 1\n  border_left_width: 4\n';

  it('inks the rule and not the frame, which is the one the renderer draws', () => {
    // Measured. The page carries ONE mark for that block:
    //   4 w  0.10196 0.30588 0.54118 SCN  50.24 758.37 m  50.24 707.30714 l  S
    // a 4pt vertical rule in 1A4E8A, and no stroked rectangle anywhere. `convert_quote_or_verse`
    // takes the left-rule branch and never assigns `b_width`, then asks for the frame with an
    // explicit `border_width: nil` that `theme_fill_and_stroke_block` keeps and returns on.
    const { appearance } = resolve(RULED);
    expect(appearance.quote.borderLeftWidthPt).toBe(4);
    expect(appearance.quote.borderWidthPt).toBe(0);
  });

  it('says nothing about it, because the export prints the page happily', () => {
    expect(resolve(RULED).diagnostics).toEqual([]);
  });

  it('keeps the frame when the block is filled, which is what carries it past the early return', () => {
    // Measured, the same theme plus `background_color: F7F8FA`. The page carries THREE marks in
    // order — the fill, the frame, then the rule:
    //   0.96863 0.97255 0.98039 scn  48.24 758.37 m … f
    //   0.10196 0.30588 0.54118 SCN  1 w  48.24 758.37 m … S
    //   4 w  0.10196 0.30588 0.54118 SCN  50.24 758.37 m  50.24 707.30714 l  S
    // It is the fill that gets past `unless b_width || bg_color`, and what the bounds are then
    // stroked with is `@theme[quote_border_width]` read afresh — not the nil the method was handed.
    const { appearance } = resolve(`${RULED}  background_color: F7F8FA\n`);
    expect(appearance.quote.backgroundColor).toBe('F7F8FA');
    expect(appearance.quote.borderWidthPt).toBe(1);
    expect(appearance.quote.borderLeftWidthPt).toBe(4);
  });

  it('treats the transparent keyword as no fill at all, as the renderer does', () => {
    // `(bg_color = …) == 'transparent'` clears it, so a quotation painted `transparent` takes the
    // early return exactly as one with no `background_color` key does.
    const { appearance } = resolve(`${RULED}  background_color: transparent\n`);
    expect(appearance.quote.backgroundColor).toBe('transparent');
    expect(appearance.quote.borderWidthPt).toBe(0);
  });

  it('keeps the frame when there is no rule to be exclusive with', () => {
    // Measured, `verse: border_color: 8B0000, border_width: 1, border_left_width: 0`. The page
    // carries the ordinary frame and no rule:
    //   0.5451 0.0 0.0 SCN  1 w  48.24 695.30714 m  547.04 695.30714 l … S
    // A rule of zero fails `b_left_width > 0` and the else branch reads the theme's own width.
    const zeroRule = resolve('verse:\n  border_color: 8B0000\n  border_width: 1\n  border_left_width: 0\n');
    expect(zeroRule.appearance.verse.borderWidthPt).toBe(1);
  });

  it('takes the INHERITED rule into account, which is how most themes meet this', () => {
    // The whole cascade decides it, not the project's own document. `default-theme.yml` gives every
    // quotation `border_left_width: $horizontal_rhythm / 3`, so a project that writes nothing but a
    // width is already a ruled block and gets no frame.
    //
    // Measured over `extends: default` with `quote: border-width: 1` and nothing else — the page
    // carries the inherited rule alone, in the default theme's own EEEEEE:
    //   4 w  0.93333 0.93333 0.93333 SCN  50.24 758.37 m  50.24 707.30714 l  S
    // and not one stroked rectangle. This is the common shape of the defect, not the corner: a
    // hairline across the top and bottom of every quotation in the document, for one key.
    const inherited = resolve('quote:\n  border_width: 1\n');
    expect(inherited.appearance.quote.borderLeftWidthPt).toBe(4);
    expect(inherited.appearance.quote.borderWidthPt).toBe(0);
  });

  it('applies to a verse, which reaches the same code under its own prefix', () => {
    const { appearance } = resolve('verse:\n  border_color: 8B0000\n  border_width: 1\n  border_left_width: 4\n');
    expect(appearance.verse.borderLeftWidthPt).toBe(4);
    expect(appearance.verse.borderWidthPt).toBe(0);
  });

  it('leaves the renderer’s own default theme where it already was', () => {
    // `default-theme.yml` writes `border_width: 0` beside its rule, so the theme every project
    // starts from is unmoved by this and a project that sets neither key sees no change.
    expect(defaultAppearance().quote.borderWidthPt).toBe(0);
    expect(defaultAppearance().quote.borderLeftWidthPt).toBe(4);
  });
});

describe('resolveAppearance and what a theme extends', () => {
  it('says nothing about a theme extending the default, which is the cascade it is given', () => {
    expect(resolveAppearance({ themeText: 'extends: default\nbase:\n  font_size: 11\n' }).diagnostics).toEqual(
      [],
    );
  });

  it.each([
    ['the gem’s structural base theme', 'extends: base\n'],
    ['another bundled theme', 'extends: default-sans\n'],
    ['a file of the project’s own', 'extends: ./house-theme.yml\n'],
    ['a list where one target is unlayered', 'extends: [default, base]\n'],
  ])('reports that it does not layer %s', (_label, text) => {
    // `base-theme.yml` is not a smaller `default-theme.yml`: Helvetica against Noto Serif, 12 pt
    // against 10.5, `text_align: left` against `justify`. Showing the default theme's page for a
    // document that extends any of these is a different page, and it was silent about it.
    const result = resolveAppearance({ themeText: text, themePath: 'theme/x-theme.yml' });
    const extendsDiagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.themeKey === 'extends',
    );
    expect(extendsDiagnostics).toHaveLength(1);
    expect(extendsDiagnostics[0]).toMatchObject({
      severity: 'warning',
      resource: 'theme/x-theme.yml',
      location: { path: 'theme/x-theme.yml' },
    });
  });

  it('names no target, because the target is the document’s own text', () => {
    const result = resolveAppearance({ themeText: 'extends: "</style><script>alert(1)</script>"\n' });
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.message).not.toContain('</style>');
      expect(diagnostic.message).not.toContain('<script');
    }
    expect(result.diagnostics.some((diagnostic) => diagnostic.themeKey === 'extends')).toBe(true);
  });

  it('accepts the renderer’s `!important` suffix on a target it does layer', () => {
    const result = resolveAppearance({ themeText: 'extends: default !important\n' });
    expect(result.diagnostics).toEqual([]);
  });
});

describe('resolveAppearance and the font catalogue', () => {
  it('expands a variable in a catalogue path, as the renderer’s loader does', () => {
    // `expanded_path = expand_vars path, data` (theme_loader.rb:144) — a theme that keeps its font
    // directory in a setting loads a real file in the export, and loaded nothing in the preview.
    const result = resolveAppearance({
      themeText:
        'fonts_dir: theme/fonts\nbase:\n  font_family: Brand\nfont:\n  catalog:\n    Brand:\n      normal: $fonts_dir/brand.ttf\n',
    });
    expect(result.appearance.fonts).toContainEqual({
      family: 'Brand',
      declaredFaces: { normal: 'theme/fonts/brand.ttf' },
      declaredByTheme: true,
    });
  });

  it('does not expand a path against a setting written below it, as the export does not', () => {
    // The renderer expands against what it has loaded when it REACHES the catalogue, so a path can
    // only refer backwards. Resolving against the finished cascade would make the preview find a
    // setting the export leaves dangling — and load a face the export does not. The reference stays
    // in the path, which is then not a path this preview will request, and that is reported.
    const result = resolveAppearance({
      themeText:
        'base:\n  font_family: Brand\nfont:\n  catalog:\n    Brand:\n      normal: $fonts_dir/brand.ttf\nfonts_dir: theme/fonts\n',
      themePath: 'theme/late-theme.yml',
    });
    expect(result.appearance.fonts).toContainEqual({
      family: 'Brand',
      declaredFaces: {},
      declaredByTheme: true,
    });
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'theme-font-unavailable')).toBe(true);
  });

  it('keeps the built-in families for a catalogue whose merge is truthy but not `true`', () => {
    const result = resolveAppearance({
      themeText: 'extends: default\ncode:\n  font_family: Brand\nfont:\n  catalog:\n    merge: 1\n    Brand: theme/brand.ttf\n',
    });
    expect(result.appearance.fonts.map((font) => font.family)).toEqual(['Brand', 'M+ 1mn', 'Noto Serif']);
    // Names alone do not tell merge from replace — the default theme's families are named by its own
    // settings either way. Their FACES do: a replaced catalogue leaves them declared by nothing.
    expect(result.appearance.fonts).toContainEqual({
      family: 'Noto Serif',
      declaredFaces: {
        normal: 'GEM_FONTS_DIR/notoserif-regular-subset.ttf',
        bold: 'GEM_FONTS_DIR/notoserif-bold-subset.ttf',
        italic: 'GEM_FONTS_DIR/notoserif-italic-subset.ttf',
        boldItalic: 'GEM_FONTS_DIR/notoserif-bold_italic-subset.ttf',
      },
      declaredByTheme: true,
    });
  });
});

describe('what the theme asked for and the page does not carry', () => {
  it.each([
    ['page.background-image', 'page:\n  background_image: "brand/cover.png"\n', 'page_background_image'],
    ['a remote one, which is the same gap', 'page:\n  background_image: "https://example.test/x.png"\n', 'page_background_image'],
    ['page.background-image-recto', 'page:\n  background_image_recto: a.png\n', 'page_background_image_recto'],
    ['page.background-image-verso', 'page:\n  background_image_verso: a.png\n', 'page_background_image_verso'],
    ['page.foreground-image', 'page:\n  foreground_image: a.png\n', 'page_foreground_image'],
    ['title-page.background-image', 'title_page:\n  background_image: a.png\n', 'title_page_background_image'],
  ])('says that %s paints a page this preview does not show', (_label, themeText, key) => {
    // The widest silent gap in the style: the export composites a whole image under every page and
    // the preview has no field for it, so an author saw a blank page and was told nothing at all.
    // Not modelled rather than not noticed — an image is fetched, decoded, scaled to the page box
    // and composited, and a preview that guessed at any of that would show a page nobody exported.
    const { keys, messages } = resolved(themeText);
    expect(keys).toContain(key);
    // The author's own value is never in the sentence, however innocuous it looks. See the source
    // rule on `AppearanceDiagnostic`.
    expect(messages.join(' ')).not.toMatch(/brand\/cover|example\.test|a\.png/);
  });

  it('says nothing about a page image the theme does not set', () => {
    expect(resolved('extends: default\nbase:\n  font_size: 11\n').keys).toEqual([]);
  });

  it('names a setting the theme indented one level too far', () => {
    // `heading:\n  font-size:\n    h1: 24` sets NOTHING — the loader descends into a mapping and
    // never assigns the key, so the export ignores it too and the preview is faithful. What was
    // missing is any word to the author about why the size they wrote did nothing.
    const { appearance, keys, messages } = resolved('heading:\n  font_size:\n    h1: 24\n');
    expect(keys).toContain('heading_font_size');
    expect(messages.join(' ')).toContain('group of settings rather than as a value');
    expect(appearance.headings[1].fontSizePt).toBe(defaultAppearance().headings[1].fontSizePt);
  });

  it('calls an admonition icon colour written as a mapping a bad VALUE, not a missing one', () => {
    // The one claimed key an icon's properties reach, written the way that made the two readers
    // disagree. `evaluate` hands the Hash to `to_color`, which sizes `{"a"=>"FF0000"}.to_s` to six
    // characters and stores the string `{"A"=>` — measured against the vendored gem under ruby
    // 3.3.3 — so the export SETS the key, to something prawn then paints with.
    //
    // Flattening past the icon emitted `admonition_icon_tip_stroke_color_a`, a name the export has
    // no way to reach, and left the claimed key looking like a mapping the loader had descended
    // into: "is written as a group of settings rather than as a value, so it sets nothing", with no
    // line to open. Both halves of that were untrue of the export.
    const themeText = 'admonition_icon_tip:\n  stroke-color:\n    a: FF0000\n';
    const { diagnostics } = resolveAppearance({ themeText, themePath: 'brand-theme.yml' });
    expect(diagnostics.map((diagnostic) => diagnostic.themeKey)).toEqual([
      'admonition_icon_tip_stroke_color',
    ]);
    const [only] = diagnostics;
    expect(only.message).toContain('is not a colour');
    expect(only.message).not.toContain('group of settings');
    expect(only.location?.line).toBe(2);
  });

  it('says nothing about a category, which is a group of settings by design', () => {
    // `heading` and `heading.h2` are mappings in every theme ever written; only a key the MODEL
    // reads has anything to be wrong about.
    expect(resolved('extends: default\nheading:\n  h2:\n    font_size: 20\n').keys).toEqual([]);
  });

  it('refuses a font file the theme puts outside the project, and says so', () => {
    // The character class admitted `.` and `/` because a font path needs them, so
    // "project-relative" was a claim nothing checked. The renderer resolves this against the
    // theme's own directory and really does open it: measured against the vendored gem under ruby
    // 3.3.3, the export reads `/etc/passwd` and dies with `Prawn::Errors::UnknownFont`. The export
    // failing is not a reason for the preview to make the request.
    for (const path of ['../../etc/passwd', '/etc/passwd', 'a/../../b.ttf']) {
      const { appearance, messages } = resolved(
        `font:\n  catalog:\n    X:\n      normal: ${path}\nbase:\n  font_family: X\n`,
      );
      const requirement = appearance.fonts.find((font) => font.family === 'X');
      expect({ path, faces: requirement?.declaredFaces }).toEqual({ path, faces: {} });
      expect(messages).toContain(
        'The theme declares a font file at a path this preview will not request, so that face is not loaded.',
      );
    }
  });

  it('still carries a font file honestly named with a leading dot', () => {
    // Segments are matched whole, so `..bold.ttf` is a file and not an escape.
    const { appearance } = resolved(
      'font:\n  catalog:\n    X:\n      normal: fonts/..bold.ttf\nbase:\n  font_family: X\n',
    );
    expect(appearance.fonts.find((font) => font.family === 'X')?.declaredFaces).toEqual({
      normal: 'fonts/..bold.ttf',
    });
  });

  it.each([
    ['a relative unit, which the converter’s own pattern has no case for', "['1em', '1em']"],
    ['a percentage', "['10%', '10%']"],
    ['a leading decimal point', "['.5in', '11in']"],
    ['a negative dimension', "['-5in', '11in']"],
    ['a zero dimension', '[300, 0]'],
  ])('falls back to A4 and says so for a page size written with %s', (_label, size) => {
    // `build_pdf_options` (`converter.rb:480-487`) matches a page dimension against
    // `MeasurementPartsRx` — no sign, no leading dot, no exponent, none of `em`, `rem` or `%` — and
    // `break`s out of the WHOLE size otherwise. Every MediaBox below was read out of a PDF the
    // vendored gem actually wrote: each of these prints A4. Reading them as ordinary lengths laid
    // the preview out on a page the export never produces.
    const { appearance, keys } = resolved(`page:\n  size: ${size}\n`);
    expect(keys).toContain('page_size');
    expect([appearance.page.widthPt, appearance.page.heightPt]).toEqual([595.28, 841.89]);
  });

  it.each([
    ['inches', "['8.5in', '11in']", [612, 792]],
    ['pixels, at the converter’s 96 dpi', "['300px', '300px']", [225, 225]],
    ['one dimension, which squares the page', '[300]', [300, 300]],
  ])('keeps a page size written in %s, which the export prints', (_label, size, expected) => {
    const { appearance, keys } = resolved(`page:\n  size: ${size}\n`);
    expect([appearance.page.widthPt, appearance.page.heightPt]).toEqual(expected);
    expect(keys).not.toContain('page_size');
  });
});

describe('the themes already in this repository', () => {
  // Thirteen real documents — the demo project's own theme and twelve export-parity fixtures — read
  // end to end through the resolver. An EMPTY diagnostics list is the assertion, which subsumes every
  // per-key claim made anywhere above: no rejection, no dangling reference and no truncation.
  const themes = [
    'apps/api/data/demo-project/theme/showcase-theme.yml',
    'apps/web/e2e/pdf-parity/fixtures/extension-auto-license-page/source/license-theme.yml',
    'apps/web/e2e/pdf-parity/fixtures/extension-narrow-contents/source/narrow-theme.yml',
    'apps/web/e2e/pdf-parity/fixtures/extension-paragraph-numbering/source/numbering-theme.yml',
    'apps/web/e2e/pdf-parity/fixtures/extension-paragraph-numbering-margin/source/margin-theme.yml',
    'apps/web/e2e/pdf-parity/fixtures/extension-title-block-document-details/source/details-theme.yml',
    'apps/web/e2e/pdf-parity/fixtures/theme-editing/source/preview-theme.yml',
    'apps/web/e2e/pdf-parity/fixtures/theme-editing-all-extensions/source/preview-theme.yml',
    'apps/web/e2e/pdf-parity/fixtures/theme-fonts/source/theme/brand-theme.yml',
    'apps/web/e2e/pdf-parity/fixtures/theme-fonts-woff2/source/theme/brand-theme.yml',
    'apps/web/e2e/pdf-parity/fixtures/theme-selected-by-config/source/branding/corporate-theme.yml',
    'apps/web/e2e/pdf-parity/fixtures/theme-yaml-extension/source/local-theme.yaml',
    'apps/web/e2e/pdf-parity/fixtures/extension-additional-contents-entries-front-matter/source/theme.yml',
  ];

  it.each(themes)('resolves %s with nothing to report', (themePath) => {
    const result = resolveAppearance({
      themeText: readFileSync(path.join(REPO_ROOT, themePath), 'utf8'),
      themePath,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('applies the demo project’s own theme rather than falling back to the default', () => {
    const result = resolveAppearance({
      themeText: readFileSync(path.join(REPO_ROOT, 'apps/api/data/demo-project/theme/showcase-theme.yml'), 'utf8'),
      themePath: 'theme/showcase-theme.yml',
    });
    expect(result.themeApplied).toBe(true);
    expect(result.appearance).not.toEqual(defaultAppearance());
  });
});

describe('the settings load_theme derives after the document has been read', () => {
  // `theme_loader.rb:82-92` runs seven `||=` assignments once `load_file` has returned, so they see
  // the merge of the document and everything its `extends` chain contributed — and they run only for
  // a theme loaded from OUTSIDE the gem's themes directory, which is every project theme and none of
  // the bundled ones. Every expectation below is paired with what the vendored gem's own
  // `ThemeLoader` puts in its theme table for the same document, read under ruby 3.3.3.
  const resolve = resolveOverDefault;

  it('carries the heading face onto the sidebar title, which the default theme leaves unset', () => {
    // Gem: heading_font_family "Courier", sidebar_title_font_family "Courier". Preview, before this:
    // the sidebar title carried no face at all, so the delivery layer wrote no custom property and
    // the preview drew the title in the stylesheet's own face while the export drew it in Courier.
    const { appearance, diagnostics } = resolve('heading:\n  font_family: Courier\n');
    expect(appearance.headings[1].fontFamily).toBe('Courier');
    expect(appearance.sidebar.title?.fontFamily).toBe('Courier');
    expect(diagnostics).toEqual([]);
  });

  it('does not carry it over a sidebar title face the document wrote itself', () => {
    // Gem: sidebar_title_font_family "Times". `||=` only fills a setting that is not there.
    const { appearance } = resolve(
      'heading:\n  font_family: Courier\nsidebar:\n  title:\n    font_family: Times\n',
    );
    expect(appearance.sidebar.title?.fontFamily).toBe('Times');
  });

  it.each([
    ['null', 'null'],
    ['false', 'false'],
  ])('does carry it over a sidebar title face written as %s, and says nothing about it', (_label, written) => {
    // Gem: sidebar_title_font_family "Courier" for both — `||=` fires on nil and on false. The
    // silence is half the fix: the preview used to reject the value and tell the author their
    // sidebar title face was unreadable, about a value the loader replaces before anything reads it.
    const { appearance, diagnostics } = resolve(
      `heading:\n  font_family: Courier\nsidebar:\n  title:\n    font_family: ${written}\n`,
    );
    expect(appearance.sidebar.title?.fontFamily).toBe('Courier');
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ['null', 'null'],
    ['false', 'false'],
  ])('derives no title face from a heading face written as %s', (_label, written) => {
    // The pair sits inside `if (heading_font_family = theme_data.heading_font_family)`, so the gem
    // leaves sidebar_title_font_family unset for both — measured. Deriving nil or false onward would
    // have been the natural mistake, and it would have shown as a sidebar title in the DEFAULT face.
    const { appearance } = resolve(`heading:\n  font_family: ${written}\n`);
    expect(appearance.sidebar.title?.fontFamily).toBeUndefined();
  });

  it('speaks about the heading face the author wrote and not about the key it derives', () => {
    // Gem: heading_font_family 0, and both title faces 0 — Ruby calls 0 set, so the derivation runs
    // and carries a value no renderer can ink text in. Neither renderer draws a face here, so the
    // model carries none; what matters is that the author is told once, about the line they wrote.
    // A derived key is this module's inference, so it is not one of the document's own keys and
    // cannot be the subject of a sentence sending the author to a line that does not exist.
    const { appearance, keys } = resolved('extends: default\nheading:\n  font_family: 0\n');
    expect(appearance.sidebar.title?.fontFamily).toBeUndefined();
    expect(keys).toEqual(['heading_font_family']);
  });

  it.each([
    ['null', 'null'],
    ['false', 'false'],
  ])('aligns body text left when the alignment is written as %s, not as the default theme has it', (_label, written) => {
    // Gem: base_text_align "left" for both, over `extends: default` — the derivation OVERTAKES the
    // "justify" the default theme merged in, because `||=` reads the merged value and finds it unset.
    // The preview showed justified body text for null and rejected false outright.
    const { appearance, diagnostics } = resolve(`base:\n  text_align: ${written}\n`);
    expect(appearance.base.textAlign).toBe('left');
    expect(defaultAppearance().base.textAlign).toBe('justify');
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ['null', 'null'],
    ['false', 'false'],
  ])('sets the leading to 1 when it is written as %s', (_label, written) => {
    // Gem: base_line_height 1 for both. The preview gave 1.15 — the model's own fallback, which is
    // `base-theme.yml`'s number and is what the CONVERTER would have used had the loader not filled
    // the setting first. It never gets the chance for a project theme.
    const { appearance, diagnostics } = resolve(`base:\n  line_height: ${written}\n`);
    expect(appearance.base.lineHeight).toBe(1);
    expect(diagnostics).toEqual([]);
  });

  it('keeps a leading of 0, which Ruby calls set', () => {
    // Gem: base_line_height 0. Writing `||` in JavaScript instead of Ruby's rule would have made
    // this 1, which is a different page.
    expect(resolve('base:\n  line_height: 0\n').appearance.base.lineHeight).toBe(0);
  });

  it('takes the monospaced faces from codespan when they are written as null', () => {
    // Gem: code_font_family and conum_font_family both "M+ 1mn", by way of codespan_font_family.
    // The preview carried no face for either, so code blocks and callout numbers fell back to the
    // stylesheet while the export set them in the default theme's monospaced face.
    const { appearance, diagnostics } = resolve(
      'code:\n  font_family: null\nconum:\n  font_family: null\n',
    );
    expect(appearance.code.fontFamily).toBe('M+ 1mn');
    expect(appearance.conum.fontFamily).toBe('M+ 1mn');
    expect(diagnostics).toEqual([]);
  });

  it('falls back to Courier when codespan has no face either, and asks for that file', () => {
    // Gem: code_font_family "Courier" once codespan_font_family is nil too. A face is a FETCH as well
    // as a name — the delivery layer asks the project's storage for every family the model uses — so
    // the derived face has to reach the font requirements or the preview asks for the wrong file.
    const { appearance } = resolve(
      'code:\n  font_family: null\nconum:\n  font_family: null\ncodespan:\n  font_family: null\n',
    );
    expect(appearance.code.fontFamily).toBe('Courier');
    expect(appearance.conum.fontFamily).toBe('Courier');
    expect(appearance.fonts.map((font) => font.family)).toContain('Courier');
  });

  it('says nothing about a monospaced face written as false, which the loader replaces', () => {
    // Gem: conum_font_family "M+ 1mn". The preview reached the same face by another road — it
    // rejected the value and fell back to the default theme's — and told the author about a setting
    // the export never saw. The value was right by accident; the sentence was wrong.
    const { appearance, diagnostics } = resolve('conum:\n  font_family: false\n');
    expect(appearance.conum.fontFamily).toBe('M+ 1mn');
    expect(diagnostics).toEqual([]);
  });

  it('leaves the body colour to the colour reader when it is written as false', () => {
    // The one of the seven whose key is CONVERTED before `||=` reads it. `to_color` answers nil only
    // for nil, so the gem holds `"0FALSE"` here — measured — and keeps it rather than defaulting it.
    // That is not six hexadecimal digits, so it is a value the export cannot print at all: the model
    // refuses it and says so, which is the answer the derivation must not swallow.
    const { appearance, keys } = resolved('extends: default\nbase:\n  font_color: false\n');
    expect(appearance.base.fontColor).toBe(defaultAppearance().base.fontColor);
    expect(keys).toEqual(['base_font_color']);
  });

  it('blackens the body colour when it is written as null, which is the one nil to_color leaves', () => {
    // Gem: base_font_color "000000" — the loader's own string, assigned past `to_color`. The preview
    // reached the same colour through the model's fallback for the converter's
    // `theme.base_font_color ||= '000000'`, so this one was right by two roads; the assertion pins
    // that it stays right by the road the loader actually takes, and stays silent.
    const { appearance, diagnostics } = resolve('base:\n  font_color: null\n');
    expect(appearance.base.fontColor).toBe('000000');
    expect(diagnostics).toEqual([]);
  });

  it('derives nothing at all for a theme that only extends the default', () => {
    // The guard is `unless (::File.dirname theme_path) == ThemesDir`: the gem loads its OWN themes
    // without any of this, and the default theme sets all five of the unconditional keys anyway. So
    // a document that adds nothing must resolve to exactly the appearance a project with no theme
    // gets — which is also what keeps this change off every theme in the repository.
    expect(resolve('').appearance).toEqual(defaultAppearance());
    expect(defaultAppearance().base.lineHeight).toBe(12 / 10.5);
    expect(defaultAppearance().base.fontColor).toBe('333333');
    expect(defaultAppearance().sidebar.title?.fontFamily).toBeUndefined();
  });

  it('derives the abstract title face too, which changes nothing this model carries', () => {
    // The other half of the same `if`. `abstract.*` is not a construct the model reproduces, and the
    // one other reader of the raw cascade — the scan that decides which font files to fetch — cannot
    // see a new face here either, because what is derived is the heading's own family. Pinned so
    // that the inertness is a measured fact rather than a claim in a comment: a theme whose only
    // face is the heading's asks for exactly that face and nothing more.
    const { appearance } = resolve('heading:\n  font_family: Courier\n');
    expect(appearance.fonts.map((font) => font.family).filter((name) => name === 'Courier')).toEqual([
      'Courier',
    ]);
  });
});

describe('the settings prepare_theme derives before the document is drawn', () => {
  // `converter.rb:569-611` runs thirty-six assignments of the same kind one stage later, over
  // whatever theme the loader handed the converter. Nineteen of them write a key this model reads,
  // and `default-theme.yml` sets eighteen of those — so each is reachable only through a value the
  // author wrote as `null` or as `false`, which is exactly where this preview used to disagree with
  // the export. Every expectation below is paired with what the vendored gem's own
  // `Converter#prepare_theme` leaves in its theme table for the same document, read under ruby 3.3.3.
  const resolve = resolveOverDefault;

  it.each([
    ['list.indent', 'list:\n  indent: %s\n', (model: AppearanceModel) => model.list.indentPt, 0, 18],
    ['list.item-spacing', 'list:\n  item_spacing: %s\n', (model: AppearanceModel) => model.list.itemSpacingPt, 0, 6],
    ['heading.margin-top', 'heading:\n  margin_top: %s\n', (model: AppearanceModel) => model.headings[2].marginTopPt, 0, 12 * 0.4],
    ['heading.margin-bottom', 'heading:\n  margin_bottom: %s\n', (model: AppearanceModel) => model.headings[2].marginBottomPt, 0, 10.8],
    ['prose.margin-bottom', 'prose:\n  margin_bottom: %s\n', (model: AppearanceModel) => model.spacing.proseMarginBottomPt, 0, 12],
    ['block.margin-bottom', 'block:\n  margin_bottom: %s\n', (model: AppearanceModel) => model.spacing.blockMarginBottomPt, 0, 12],
    ['description-list.term-spacing', 'description_list:\n  term_spacing: %s\n', (model: AppearanceModel) => model.descriptionList.termSpacingPt, 0, 3],
    ['description-list.description-indent', 'description_list:\n  description_indent: %s\n', (model: AppearanceModel) => model.descriptionList.descriptionIndentPt, 0, 15],
    ['callout-list.margin-top-after-code', 'callout_list:\n  margin_top_after_code: %s\n', (model: AppearanceModel) => model.calloutList.marginTopAfterCodePt, 0, -6],
    ['footnotes.item-spacing', 'footnotes:\n  item_spacing: %s\n', (model: AppearanceModel) => model.footnotes.itemSpacingPt, 0, 3],
    ['toc.indent', 'toc:\n  indent: %s\n', (model: AppearanceModel) => model.toc.indentPt, 0, 12],
    ['table.border-width', 'table:\n  border_width: %s\n', (model: AppearanceModel) => model.table.borderWidthPt, 0.5, 0.5],
    // The default theme's separator is written with narrow no-break spaces around the plus, and the
    // converter's is the bare character.
    ['kbd.separator', 'kbd:\n  separator: %s\n', (model: AppearanceModel) => model.kbd.separator, '+', ' + '],
    ['base.font-family', 'base:\n  font_family: %s\n', (model: AppearanceModel) => model.base.fontFamily, 'Helvetica', 'Noto Serif'],
  ])(
    'gives %s the converter’s own default when the document writes null or false',
    (_label, template, read, prepared, defaulted) => {
      // Two documents per row, because `||=` fires on nil and on false alike — and the two used to
      // fail differently here. Written as `null`, the field went ABSENT from the appearance and the
      // preview fell back to whatever the stylesheet said; written as `false`, the value was rejected
      // as malformed, the default theme's own value was used, and the author was told off for a
      // setting the export replaces before it ever reads it.
      //
      // The last column is what the DEFAULT theme holds, and it is in the row to show that the
      // converter's answer is a third value rather than either of the two this used to give.
      for (const written of ['null', 'false']) {
        const result = resolve(template.replace('%s', written));
        expect(read(result.appearance)).toEqual(prepared);
        expect(result.diagnostics).toEqual([]);
      }
      expect(read(defaultAppearance())).toEqual(defaulted);
    },
  );

  it('gives base.font-style the word normal when the document writes null, and only null', () => {
    // The nineteenth key, and the one that cannot be in the table above: `false` does not default
    // this setting, it throws the whole document away. See the refusal group below.
    const result = resolve('base:\n  font_style: null\n');
    expect(result.appearance.base.fontStyle).toBe('normal');
    expect(result.diagnostics).toEqual([]);
    // The value the gem's Symbol prints as, and the same word the default theme already held — so
    // this one is right by two roads, and the assertion is that it stays right by the road the
    // converter actually takes.
    expect(defaultAppearance().base.fontStyle).toBe('normal');
  });

  it('leaves the same settings alone when the document writes a zero, which Ruby calls set', () => {
    // The other half of the rule, end to end: `0` is not what Ruby calls unset, so the derivation
    // does not fire and the zero is the value — which happens to agree with the default here, and is
    // asserted so that a derivation written with JavaScript's truthiness fails.
    const result = resolve('list:\n  indent: 0\ntable:\n  border_width: 0\n');
    expect(result.appearance.list.indentPt).toBe(0);
    expect(result.appearance.table.borderWidthPt).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });

  it('inherits the base border colour into a table border written as null', () => {
    // `theme.table_border_color ||= (theme.base_border_color || '000000')`. Measured over
    // `extends: default` with `base: border_color: FF0000`: "FF0000" in the gem's table, where this
    // showed the default theme's own "DDDDDD".
    const result = resolve('base:\n  border_color: FF0000\ntable:\n  border_color: null\n');
    expect(result.appearance.table.borderColor).toBe('FF0000');
    expect(result.appearance.thematicBreak.borderColor).toBe('EEEEEE');
    expect(result.diagnostics).toEqual([]);
  });

  it('inherits it into a thematic break written as null too', () => {
    const result = resolve('base:\n  border_color: FF0000\nthematic_break:\n  border_color: null\n');
    expect(result.appearance.thematicBreak.borderColor).toBe('FF0000');
    expect(result.diagnostics).toEqual([]);
  });

  it('takes the base border colour away when the document writes the transparent keyword', () => {
    // `theme.base_border_color = nil if theme.base_border_color == 'transparent'` — the one
    // assignment of the thirty-six that removes a value, and the reason the order matters: what
    // inherits from `base.border-color` inherits the black the rewrite leaves behind, not the
    // keyword. Measured over `extends: default` with `table: border_color: null` beside it:
    // base_border_color nil and table_border_color "000000" in the gem's table.
    const result = resolve('base:\n  border_color: transparent\ntable:\n  border_color: null\n');
    expect(result.appearance.base.borderColor).toBeUndefined();
    expect(result.appearance.table.borderColor).toBe('000000');
    expect(result.diagnostics).toEqual([]);
  });

  it('defaults a table border to black when there is no base border colour to inherit', () => {
    const result = resolve('base:\n  border_color: null\ntable:\n  border_color: null\n');
    expect(result.appearance.base.borderColor).toBeUndefined();
    expect(result.appearance.table.borderColor).toBe('000000');
  });
});

describe('resolveAppearance over a table border written as a list of sides', () => {
  const resolve = resolveOverDefault;

  it.each([
    ['two sides', 'table:\n  border_color: [1, 2]\n', '000001'],
    ['one side', 'table:\n  border_color: [1]\n', '000001'],
    ['three sides', 'table:\n  border_color: [10, 20, 30]\n', '000010'],
    ['four sides, which is not a CMYK colour here', 'table:\n  border_color: [1, 2, 3, 4]\n', '000001'],
    ['a side spelled in fewer digits than a colour', 'table:\n  border_color: [a, 0, 0]\n', '00000A'],
    ['a side written in hexadecimal', 'table:\n  border_color: [FF0000, 00FF00]\n', 'FF0000'],
    ['a side that is itself a list', 'table:\n  border_color: [[1], 2]\n', '000001'],
    ['a side that is itself an RGB triple', 'table:\n  border_color: [[1, 2, 3], 2]\n', '010203'],
    ['a side that is itself a CMYK literal', 'table:\n  border_color: [[0, 0, 0, 0], 2]\n', 'FFFFFF'],
    ['a side nested twice, which the element’s own join flattens', 'table:\n  border_color: [[[1, 2], [3]], 2]\n', '112233'],
    ['a side that is an empty list, which is the black an empty value is', 'table:\n  border_color: [[], 2]\n', '000000'],
  ])('paints the first side, given %s', (_label, text, expected) => {
    // Each row measured against the vendored gem under ruby 3.3.3 over `extends: default`: the theme
    // table holds a list of converted colours, and `expand_rect_values` puts element 0 at the TOP
    // whatever the list's length (`ext/prawn/extensions.rb:659-678`). `[1, 2]` inks `000001`.
    //
    // Joining the raw list instead answered `000012` — a colour neither element names — and for the
    // rows whose elements are lists it answered nothing at all, showing the default theme's `DDDDDD`
    // and telling the author their value was not a colour.
    const result = resolve(text);
    expect(result.appearance.table.borderColor).toBe(expected);
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    ['the keyword as the only side', 'table:\n  border_color: [transparent]\n'],
    ['the keyword as the first of two', 'table:\n  border_color: [transparent, 00FF00]\n'],
    ['an empty first side, which asks for the expansion’s own default', 'table:\n  border_color: [null, 2]\n'],
  ])('draws no top border, given %s', (_label, text) => {
    // An element IS reached by `to_color`'s String branch, so the keyword survives inside a list
    // where it does not survive a join — measured, `table: border_color: [transparent, 00FF00]` is
    // `["transparent", "00FF00"]` in the gem's theme table. And `shorthand[0] || default` with the
    // converter's `'transparent'` (`converter.rb:2244`) means an element written as `null` draws no
    // border either, where a join found the NEXT element's colour there and painted `000002`.
    const result = resolve(text);
    expect(result.appearance.table.borderColor).toBe('transparent');
    expect(result.diagnostics).toEqual([]);
  });

  it('does the same for the grid, whose list is two axes rather than four sides', () => {
    // `key == 'table_grid_color' && ::Array === val && val.size == 2` — measured,
    // `table: grid_color: [1, 2]` is `["000001", "000002"]` in the gem's theme table, and
    // `expand_grid_values` puts element 0 on the horizontal rules.
    expect(resolve('table:\n  grid_color: [1, 2]\n').appearance.table.gridColor).toBe('000001');
    expect(resolve('table:\n  grid_color: [transparent, 2]\n').appearance.table.gridColor).toBe(
      'transparent',
    );
    // Any other length is ONE colour: three channels of an RGB triple, not three axes.
    expect(resolve('table:\n  grid_color: [1, 2, 3]\n').appearance.table.gridColor).toBe('010203');
  });

  it('says nothing about the sides it does not paint, which are not a value cut short', () => {
    // A colour longer than six characters is reported, because `to_color` DISCARDS what it cuts. A
    // list of four sides discards nothing — the export draws every one of them — so a note about
    // "only its first six characters" would be false twice over.
    const result = resolve('table:\n  border_color: [FF0000, 00FF00, 0000FF, FFFF00]\n');
    expect(result.appearance.table.borderColor).toBe('FF0000');
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses a side the export cannot ink, and says so', () => {
    // `to_color 'red'` is `RREEDD`, which prawn refuses with `Unknown type of color` — the export
    // writes no PDF — so the key falls back to its default under a diagnostic, exactly as the same
    // value does under any other colour key. Sizing the stored element a second time would have
    // painted a page nobody can export.
    const result = resolve('table:\n  border_color: [red, 00FF00]\n');
    expect(result.appearance.table.borderColor).toBe('DDDDDD');
    expect(result.diagnostics.map((each) => each.code)).toEqual(['theme-value-rejected']);
  });

  it.each([
    ['the base border', 'base:\n  border_color: [transparent]\n', (a: AppearanceModel) => a.base.borderColor, 'EEEEEE'],
    ['a block border', 'code:\n  border_color: [transparent]\n', (a: AppearanceModel) => a.code.borderColor, 'CCCCCC'],
    ['the keyword spelled across two elements', 'base:\n  border_color: [transp, arent]\n', (a: AppearanceModel) => a.base.borderColor, 'EEEEEE'],
  ])('refuses a keyword a list only joins to, under %s', (_label, text, read, defaulted) => {
    // The keyword is tested inside `to_color`'s String branch alone; a list joins and falls THROUGH
    // to the length rule, which never looks at it. Measured against the vendored gem under ruby
    // 3.3.3 over `extends: default`, all three of these are `"TRANSP"` in the theme table — six
    // characters prawn refuses with `Unknown type of color`, so the export writes no PDF.
    //
    // The preview drew NO border for each of them and said nothing, which is a page the export does
    // not print described as if it did. The key now falls back to the default theme's own colour
    // under a diagnostic, which is what every other unpaintable colour gets.
    const result = resolve(text);
    expect(read(result.appearance)).toBe(defaulted);
    expect(result.diagnostics.map((each) => each.code)).toEqual(['theme-value-rejected']);
  });

  it('keeps taking the base border away for the keyword the document really wrote', () => {
    // The contrast that makes the row above meaningful, and the reason `derivePreparedSettings`
    // compares the document's own String rather than asking the colour reader: a String reading
    // exactly `transparent` IS the keyword, and the rewrite at `converter.rb:570` removes it.
    const result = resolve('base:\n  border_color: transparent\n');
    expect(result.appearance.base.borderColor).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it('reads a list a lone reference carried in as ONE colour, not as sides', () => {
    // The branch is chosen by the value the document wrote. Measured against the vendored gem under
    // ruby 3.3.3 over `extends: default`: `v: [1, 2]` with `table: border_color: $v` is `"000012"`
    // in the theme table, and `v: [null, 2]` the same way is `"000002"` — where the same lists
    // written out are two SIDES and paint `000001` and `transparent`.
    expect(resolve('v: [1, 2]\ntable:\n  border_color: $v\n').appearance.table.borderColor).toBe(
      '000012',
    );
    expect(resolve('v: [null, 2]\ntable:\n  border_color: $v\n').appearance.table.borderColor).toBe(
      '000002',
    );
  });

  it('hands a later reference the converted list, which it then joins', () => {
    // `resolve_var` answers with whatever the theme table holds, so a key referring to the border
    // list gets the CONVERTED elements. Measured: `table: border_color: [1, 2]` with
    // `thematic_break: border_color: $table_border_color` leaves the thematic break `"000001"` —
    // twelve joined characters cut to six — where a cascade holding the raw list found `"000012"`.
    const result = resolve(
      'table:\n  border_color: [1, 2]\nthematic_break:\n  border_color: $table_border_color\n',
    );
    expect(result.appearance.table.borderColor).toBe('000001');
    expect(result.appearance.thematicBreak.borderColor).toBe('000001');

    // …and the key that BORROWED it converts the whole list over again, so it is not a shorthand
    // there. The two answers differ wherever the first side is not six characters: measured,
    // `table: border_color: [null, 2]` carried onward leaves the thematic break `"000002"` — the
    // joined list — while the table itself draws no top border at all.
    const borrowed = resolve(
      'table:\n  border_color: [null, 2]\nthematic_break:\n  border_color: $table_border_color\n',
    );
    expect(borrowed.appearance.table.borderColor).toBe('transparent');
    expect(borrowed.appearance.thematicBreak.borderColor).toBe('000002');
    // And a four-element list is FOUR SIDES on the table and one CMYK colour where it is borrowed:
    // measured, `[transparent, 00FF00, 0000FF, FFFF00]` leaves the thematic break `"FFFFFF"`,
    // because every element reads as zero through `to_f`.
    const cmyk = resolve(
      'table:\n  border_color: [transparent, 00FF00, 0000FF, FFFF00]\nthematic_break:\n  border_color: $table_border_color\n',
    );
    expect(cmyk.appearance.table.borderColor).toBe('transparent');
    expect(cmyk.appearance.thematicBreak.borderColor).toBe('FFFFFF');
  });

  it('leaves every other colour key’s list joined whole', () => {
    // Measured over `extends: default`, each written `[1, 2]`: `thematic_break_border_color` is
    // `"000012"` in the gem's theme table and so is the tip admonition's icon colour. Only two keys
    // take a list of colours, and reading a third that way would show a border the export does not
    // draw.
    expect(
      resolve('thematic_break:\n  border_color: [1, 2]\n').appearance.thematicBreak.borderColor,
    ).toBe('000012');
    expect(
      resolve('admonition_icon_tip:\n  stroke_color: [1, 2]\n').appearance.admonition.icons?.tip
        ?.fontColor,
    ).toBe('000012');
  });

  it.each([
    ['the body colour', 'base:\n  font_color: [[1], 2]\n', (a: AppearanceModel) => a.base.fontColor],
    ['a border colour', 'base:\n  border_color: [[1], 2]\n', (a: AppearanceModel) => a.base.borderColor],
    [
      'a thematic break',
      'thematic_break:\n  border_color: [[1], 2]\n',
      (a: AppearanceModel) => a.thematicBreak.borderColor,
    ],
    [
      'an admonition icon',
      'admonition_icon_tip:\n  stroke_color: [[1], 2]\n',
      (a: AppearanceModel) => a.admonition.icons?.tip?.fontColor,
    ],
  ])('joins a collection nested inside %s, which the export inks', (_label, text, read) => {
    // The join is recursive under every key that converts its value whole. Measured against the
    // vendored gem under ruby 3.3.3 over `extends: default`, each of these is `"000012"` in the
    // theme table — the same six characters the flat `[1, 2]` gives, because the nesting adds no
    // characters of its own.
    //
    // Every one of them was refused: the reader answered nothing for a nested list, so the key fell
    // back to the default theme's colour and its author was told the value was not a colour. 166 of
    // the 198 disagreements in a 5,100-document differential were this.
    const result = resolve(text);
    expect(read(result.appearance)).toBe('000012');
    expect(result.diagnostics).toEqual([]);
  });

  it('carries a nested colour onward exactly as the gem’s table carries it', () => {
    // What a later `$reference` finds is what the theme table holds, which is the JOINED six
    // characters and not the list. Measured: `base: font_color: [[1], 2]` with `thematic_break:
    // border_color: $base_font_color` leaves both `"000012"`.
    const result = resolve(
      'base:\n  font_color: [[1], 2]\nthematic_break:\n  border_color: $base_font_color\n',
    );
    expect(result.appearance.base.fontColor).toBe('000012');
    expect(result.appearance.thematicBreak.borderColor).toBe('000012');
    expect(result.diagnostics).toEqual([]);
  });

  it('still refuses the document over a nested collection the loader RAISES on', () => {
    // The nesting is joined only where the loader joins it. Under three elements the same list is an
    // RGB triple and reaches `sprintf '%02X'`, which raises `TypeError: can't convert Array into
    // Integer` — measured, `base: font_color: [[1], 2, 3]` throws the whole document away — and under
    // `table_border_color` the element is a triple of its own. Reading it as a join would have shown
    // a colour for a document the export never loaded.
    const raised = resolve('base:\n  font_color: [[1], 2, 3]\n');
    expect(raised.themeApplied).toBe(false);
    expect(resolve('table:\n  grid_color: [[1], 2, 3]\n').themeApplied).toBe(false);
  });
});

describe('resolveAppearance when the base font style stops the theme being prepared', () => {
  /** A setting under a category none of the documents below write, so it can only come from them. */
  const WITNESS = 'page:\n  margin: 90\n';

  it.each([
    ['an integer', 'base:\n  font_style: 7\n'],
    ['a float', 'base:\n  font_style: 1.5\n'],
    ['a boolean', 'base:\n  font_style: true\n'],
    ['false, which the safe-navigation guard does not catch', 'base:\n  font_style: false\n'],
    ['a list', 'base:\n  font_style: [bold]\n'],
    ['an empty list', 'base:\n  font_style: []\n'],
    ['an expression the loader has already folded to a number', 'base:\n  font_style: 1 + 1\n'],
    ['a reference to a number', 'base:\n  font_style: $base_font_size\n'],
    ['the key written flat', 'base_font_style: 7\n'],
    ['the key written with a hyphen', 'base:\n  font-style: 7\n'],
  ])('shows the default page and applies NOTHING, given %s', (_label, text) => {
    // `theme.base_font_style = theme.base_font_style&.to_sym || :normal` (`converter.rb:573`) is the
    // one line of `prepare_theme` that can raise: `&.` guards nil alone and `to_sym` belongs to
    // String alone, so everything above raises `NoMethodError` into the bare rescue at
    // `converter.rb:575` and the export prints the DEFAULT theme — not the theme minus that setting.
    //
    // Measured by driving `Converter#load_theme` over a project theme reading `extends: default`,
    // `zzz: 9`, `base: font_family: Courier`, `font_style: 7` under ruby 3.3.3: base_font_family
    // comes back "Noto Serif" and `zzz` comes back nil, with `could not locate or load the pdf theme
    // … because of NoMethodError undefined method 'to_sym' for an instance of Integer; reverting to
    // default theme` on the error log. The last two rows are the same fault reached through the
    // loader's own key normalisation, and the two before them are values that are only numbers by
    // the time the converter sees them — which is why the rule is about the resolved value.
    //
    // The witness sits under a category none of the documents above touch, so it is a setting that
    // would plainly have applied; `toBe` on the shared default says none of it did.
    const result = resolveAppearance({ themeText: `extends: default\n${text}${WITNESS}`, themePath: 'theme/s.yml' });
    expect(result.appearance).toBe(defaultAppearance());
    expect(result.themeApplied).toBe(false);
    expect(result.diagnostics.map((each) => each.code)).toEqual(['theme-unparseable']);
    expect(result.appearance.page.marginPt.top).toBe(defaultAppearance().page.marginPt.top);
  });

  it.each([
    ['a style word', 'base:\n  font_style: bold\n'],
    ['a word that is not a style at all, which String#to_sym takes anyway', 'base:\n  font_style: nonsense\n'],
    ['the empty string', "base:\n  font_style: ''\n"],
    ['digits written as text', "base:\n  font_style: '0'\n"],
    ['null, which the guard catches and defaults', 'base:\n  font_style: null\n'],
    ['a mapping, which the loader recurses into rather than storing', 'base:\n  font_style:\n    x: 1\n'],
  ])('keeps reading the rest of the document, given %s', (_label, text) => {
    // The contrast that makes the refusal meaningful. A String has `to_sym` whatever it says, so
    // only its own key is ever at stake; and a Hash never reaches the assignment at all, because
    // `process_entry` recurses into one and writes `base_font_style_*` keys instead. Measured:
    // `font_style: nonsense` is `:nonsense` in the gem's table and the document loads.
    const result = resolveAppearance({ themeText: `extends: default\n${text}${WITNESS}`, themePath: 'theme/s.yml' });
    expect(result.themeApplied).toBe(true);
    expect(result.appearance.page.marginPt.top).toBe(90);
  });

  it('points at the line the style was written on, names the one key at fault, and repeats none of the document', () => {
    const result = resolveAppearance({
      themeText: 'extends: default\nbase:\n  font_size: 20\n  font_style: [</style>]\n',
      themePath: 'theme/s.yml',
    });
    expect(result.diagnostics).toHaveLength(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic.location).toEqual({ path: 'theme/s.yml', line: 4 });
    // Named, where the three load refusals name nothing: this sentence holds for ONE key, and that
    // key is in the closed vocabulary this module wrote rather than in the document's own text.
    expect(diagnostic.message).toContain('base.font-style');
    expect(diagnostic.message).not.toContain('</style>');
    expect(diagnostic.detail ?? '').not.toContain('</style>');
  });

  it('points at the second place a document that writes the setting twice wrote it', () => {
    // The value the converter read is the last one, and the line follows it rather than the first
    // spelling. The reader attributes one line per key — the last place it was written — so this
    // pins the reported line against the key being written twice under two spellings, which is the
    // shape that used to point an author at a line they had already corrected.
    const result = resolveAppearance({
      themeText: 'extends: default\nbase:\n  font_style: bold\n\n\nbase_font_style: 7\n',
      themePath: 'theme/s.yml',
    });
    expect(result.diagnostics[0]?.location).toEqual({ path: 'theme/s.yml', line: 6 });
  });

  it('is refused after the loader’s own refusals, which the export reaches first', () => {
    // A document wrong in both places raises inside `ThemeLoader.load_file`, before the converter is
    // handed anything to prepare — so the sentence is the loader's and the line is the colour's.
    const result = resolveAppearance({
      themeText: 'extends: default\nbase:\n  font_color: [a, 0, 0]\n  font_style: 7\n',
      themePath: 'theme/s.yml',
    });
    expect(result.diagnostics[0]?.location).toEqual({ path: 'theme/s.yml', line: 3 });
    expect(result.diagnostics[0]?.message).toContain('colour');
  });
});

/**
 * Resolve one document and hand back the whole appearance.
 *
 * @param themeText - The document.
 * @returns The appearance, whether or not the theme applied.
 */
function appearanceOf(themeText: string): AppearanceModel {
  return resolveAppearance({ themeText, themePath: 't.yml' }).appearance;
}

/** The default appearance, which is what a key the model refuses falls back to. */
const DEFAULT = defaultAppearance();

describe('the spelling a number reaches the export with', () => {
  it.each([
    // `to_color` stringifies and then reads the LENGTH, so a Float's `.0` moves it to another branch
    // of the length rule entirely. Every gem value here is the theme table under ruby 3.3.3.
    ['a whole float', 'base:\n  font_color: 1.0\n', '11..00'],
    ['a whole float with two digits', 'base:\n  font_color: 12.0\n', '0012.0'],
    ['negative zero', 'base:\n  font_color: -0.0\n', '00-0.0'],
    ['a large exponent', 'base:\n  font_color: 1.0e+20\n', '1.0E+2'],
    ['a small exponent', 'base:\n  font_color: 3.0e-7\n', '3.0E-0'],
    ['a float inside a list, which the join follows', 'base:\n  font_color: [1.0, 2]\n', '001.02'],
    ['a float inside a nested list', 'base:\n  font_color: [[1.0], 2]\n', '012.02'],
    ['a float reached through a reference', 'v: 1.0\nbase:\n  font_color: $v\n', '11..00'],
    ['a base-60 float, which Psych sums', 'base:\n  font_color: 1:30.5\n', '5430.0'],
  ])('refuses %s, because prawn refuses what the export stored', (_label, setting, stored) => {
    // Each `stored` is what the gem's theme table holds — none of them is six hexadecimal digits, so
    // prawn raises `Unknown type of color` and the export writes NO PDF. A preview that painted one
    // would be showing a page nobody can export. Every one of these was inked before the spelling
    // travelled with the value: `1.0` showed `000001`, `[1.0, 2]` showed `000012`.
    expect(stored).not.toMatch(/^[\dA-F]{6}$/);
    expect(appearanceOf(`extends: default\n${setting}`).base.fontColor).toBe(DEFAULT.base.fontColor);
  });

  it('inks the first six digits of an integer no double can hold, which the export prints', () => {
    // The other direction, and the one a blanket refusal would have got wrong: the gem's theme table
    // holds `"100000"` for this — twenty-three digits truncated to six — and the export inks it. The
    // nearest double spells itself `1e+22`, which is not a colour, so this key showed the default.
    expect(appearanceOf('extends: default\nbase:\n  font_color: 10000000000000000000000\n').base.fontColor).toBe(
      '100000',
    );
    expect(DEFAULT.base.fontColor).not.toBe('100000');
  });

  it.each([
    ['a flat list', 'base:\n  font_color: [10000000000000000000000, 0]\n'],
    ['a nested one, which the join follows', 'base:\n  font_color: [[10000000000000000000000], 0]\n'],
  ])('inks %s that reaches six digits only because a number spelled itself whole', (_label, setting) => {
    // The join is the other road a number's spelling travels, and a test that only watched a REFUSAL
    // could not see it: with the spelling dropped, `[1.0, 2]` is refused either way and the two builds
    // look alike. Here the export inks — the gem's theme table holds `"100000"` for both of these,
    // twenty-four joined characters cut to six — so anything less than the whole spelling shows the
    // default instead. The nearest double joins to `1e+220`, which is not a colour.
    expect(appearanceOf(`extends: default\n${setting}`).base.fontColor).toBe('100000');
    expect(DEFAULT.base.fontColor).not.toBe('100000');
  });

  it('inks a base-60 integer, which Psych sums rather than reads', () => {
    // `1:30:30` is 5,430 to Psych and `"005430"` in the gem's theme table — an Integer, so the padding
    // branch, where the base-60 FLOAT `1:30.5` is `"5430.0"` and prawn refuses it.
    expect(appearanceOf('extends: default\nbase:\n  font_color: 1:30:30\n').base.fontColor).toBe('005430');
  });

  it('spells a float into a content template the way the export stores it', () => {
    // `(expand_vars val.to_s, data).to_s` — measured, `menu_caret_content` is `"1.0"` in the theme
    // table, and `"3.0e-07"` for the exponent. It was `1` and `3e-7` here.
    expect(appearanceOf('extends: default\nmenu:\n  caret_content: 1.0\n').menu.caretContent).toBe('1.0');
    expect(appearanceOf('extends: default\nmenu:\n  caret_content: 3.0e-7\n').menu.caretContent).toBe('3.0e-07');
    expect(appearanceOf('extends: default\nmenu:\n  caret_content: -0.0\n').menu.caretContent).toBe('-0.0');
    expect(
      appearanceOf('extends: default\nmenu:\n  caret_content: 10000000000000000000000\n').menu.caretContent,
    ).toBe('10000000000000000000000');
  });

  it('spells a float interpolated into surrounding text, which is where expand_vars writes it out', () => {
    // `v: 1.0` and `caret_content: x$v` is `"x1.0"` in the gem's theme table, measured.
    expect(appearanceOf('extends: default\nv: 1.0\nmenu:\n  caret_content: x$v\n').menu.caretContent).toBe('x1.0');
  });

  it('keeps the spelling through the negation the loader applies to the number itself', () => {
    // `Numeric === val ? -val : '-' + val` (`theme_loader.rb:213`) negates the Float, so what reaches
    // `to_s` is `-1.0` and not `-1`. Measured: `"-1.0"`, and `-(-0.0)` is `"0.0"`.
    expect(appearanceOf('extends: default\nv: 1.0\nmenu:\n  caret_content: -$v\n').menu.caretContent).toBe('-1.0');
    expect(appearanceOf('extends: default\nv: -0.0\nmenu:\n  caret_content: -$v\n').menu.caretContent).toBe('0.0');
  });

  it('still reads a float as the number it is, everywhere a key wants a number', () => {
    // The other half of carrying a spelling: a reader that wanted the magnitude must still get it.
    // `base: font_size: 10.0` is 10 points in the export, not a dropped setting — and the model shows
    // the same size whichever way the document spells it.
    expect(appearanceOf('extends: default\nbase:\n  font_size: 10.0\n').base.fontSizePt).toBe(10);
    expect(appearanceOf('extends: default\nbase:\n  line_height: 2.0\n').base.lineHeight).toBe(2);
    expect(appearanceOf('extends: default\ntable:\n  border_width: 2.0\n').table.borderWidthPt).toBe(2);
    expect(appearanceOf('extends: default\npage:\n  size: [200.0, 400.0]\n').page.widthPt).toBe(200);
    expect(appearanceOf('extends: default\nv: 10.0\nbase:\n  font_size: $v\n').base.fontSizePt).toBe(10);
    expect(appearanceOf('extends: default\nheading:\n  h2:\n    margin_top: 7.0\n').headings[2].marginTopPt).toBe(7);
  });

  it('reads a float channel of an RGB triple as the number %02X truncates', () => {
    // `sprintf '%02X', 128.5` is `80`, so the CHANNEL path wants the magnitude where the join path
    // wants the spelling — measured, the gem's theme table holds `"FF8000"` for this.
    expect(appearanceOf('extends: default\nbase:\n  font_color: [255, 128.5, 0.0]\n').base.fontColor).toBe('FF8000');
  });
});

describe('what an empty value writes, which is Ruby’s to_s of nil', () => {
  // `nil.to_s` is the empty string and `String(null)` is the four characters `null`, and the whole of
  // this block is that one difference reaching a reader. Every gem value quoted is the theme table
  // under ruby 3.3.3 with the vendored gem, read after `prepare_theme`; `v:` written with no value is
  // a nil in the cascade, and so is a key written with no value at all.

  it('draws the empty caret a content template written empty asks for', () => {
    // `(expand_vars val.to_s, data).to_s` converts the nil BEFORE it expands, so the gem's theme table
    // holds `""` for both of these and the export draws no caret at all. This declined the value and
    // the key fell back to the default theme's `" › "`, which is a separator the export never drew.
    expect(appearanceOf('extends: default\nmenu:\n  caret_content:\n').menu.caretContent).toBe('');
    expect(appearanceOf('extends: default\nv:\nmenu:\n  caret_content: $v\n').menu.caretContent).toBe('');
    expect(DEFAULT.menu.caretContent).not.toBe('');
  });

  it.each([
    ['a content template', 'v:\nmenu:\n  caret_content: x$v\n', (m: AppearanceModel) => m.menu.caretContent, 'x'],
    ['a separator', 'v:\nkbd:\n  separator: +$v\n', (m: AppearanceModel) => m.kbd.separator, '+'],
  ])('writes nothing where %s interpolates an empty value', (_label, setting, read, stored) => {
    // `expr.gsub(VariableRx) { resolve_var … }` writes the block's answer out with `to_s`, so the
    // reference contributes nothing and the text around it closes up. Measured: `"x"` and `"+"` in the
    // theme table, where this wrote `"xnull"` and `"+null"` — text the export never put on a page.
    expect(read(appearanceOf(`extends: default\n${setting}`))).toBe(stored);
  });

  it.each([
    ['false, whose word both languages write out', 'false', '+false'],
    ['zero, which is empty to neither of them', '0', '+0'],
  ])('interpolates %s rather than emptying it', (_label, written, stored) => {
    // The boundary of the emptying, on the page rather than in the cascade: only `nil` is emptied, and
    // only because `nil.to_s` IS the empty string. Measured, `"+false"` and `"+0"` in the theme table.
    expect(appearanceOf(`extends: default\nv: ${written}\nkbd:\n  separator: +$v\n`).kbd.separator).toBe(stored);
  });

  it.each([
    ['what is left is padded to six', 'v:\nbase:\n  font_color: 00$v\n', '000000'],
    ['nothing is left at all', 'v:\nbase:\n  font_color: $v$v\n', '000000'],
  ])('inks a colour whose reference emptied it, where %s', (_label, setting, inked) => {
    // `to_color "00"` is `"000000"` and so is `to_color ""` — the length rule pads anything shorter
    // than six — and the export inks black for both. `00null` and `nullnull` are six and eight
    // characters that are not hexadecimal, so this showed the default colour instead.
    expect(appearanceOf(`extends: default\n${setting}`).base.fontColor).toBe(inked);
    expect(DEFAULT.base.fontColor).not.toBe(inked);
  });

  it('paints the border side an emptied reference leaves behind', () => {
    // `table_border_color` converts its elements one at a time, so the emptied `00` is a side of its
    // own: measured, `["000000", "000002"]` in the theme table, and the top side is what the model
    // shows. This showed the default `DDDDDD`.
    expect(appearanceOf('extends: default\nv:\ntable:\n  border_color: [00$v, 2]\n').table.borderColor).toBe('000000');
    expect(DEFAULT.table.borderColor).not.toBe('000000');
  });

  it('keeps the document a channel emptied by a reference still loads', () => {
    // The costliest shape, because the loss is the WHOLE document and not one key: `sprintf '%02X'`
    // reads `"1"` as the Integer 1 and the gem's theme table holds `"010000"`, while `1null` is a
    // channel it raises `ArgumentError` on — so this refused every setting in the document over a
    // colour the export inks.
    const emptied = appearanceOf('extends: default\nv:\nbase:\n  font_color: [1$v, 0, 0]\n');
    expect(emptied.base.fontColor).toBe('010000');
    // And the same value written three characters longer, where the emptied channel is one of three
    // that the join reads rather than a triple: `[0000, 0$v, 2]` is `"000002"`, measured.
    expect(appearanceOf('extends: default\nv:\nbase:\n  font_color: [0000, 0$v, 2]\n').base.fontColor).toBe('000002');
  });

  it.each([
    ['a font size', 'v:\nbase:\n  font_size: 1$v\n', (m: AppearanceModel) => m.base.fontSizePt, 1],
    ['a rule width', 'v:\ntable:\n  border_width: 2$v\n', (m: AppearanceModel) => m.table.borderWidthPt, 2],
    [
      'a heading margin',
      'v:\nheading:\n  h2:\n    margin_top: 3$v\n',
      (m: AppearanceModel) => m.headings[2].marginTopPt,
      3,
    ],
  ])('measures %s whose reference emptied its trailing text', (_label, setting, read, points) => {
    // The digits the author wrote are the whole of what is left, and the gem's theme table holds them
    // as `"1"`, `"2"` and `"3"` — `evaluate_math` returns the expansion unchanged when nothing in it
    // reduced. `1null` measures nothing, so every one of these showed the key's default.
    expect(read(appearanceOf(`extends: default\n${setting}`))).toBe(points);
  });

  it('substitutes an empty value into a font path rather than the word null', () => {
    // `expand_vars` runs over every catalogue path the loader stores (`theme_loader.rb:144`), so the
    // same substitution decides which FILE a face names: measured, `p.ttf` in the gem's catalogue,
    // where this asked for `pnull.ttf` and the face resolved to nothing.
    const model = appearanceOf(
      'extends: default\nv:\nfont:\n  catalog:\n    Brand:\n      normal: p$v.ttf\nbase:\n  font_family: Brand\n',
    );
    expect(model.fonts.find((font) => font.family === 'Brand')?.declaredFaces.normal).toBe('p.ttf');
  });

  it.each([
    ['arithmetic with nothing on its left', 'v:\nbase:\n  font_size: $v * 2\n'],
    ['arithmetic with nothing on its right', 'v:\nbase:\n  font_size: 2 * $v\n'],
    ['an addition with nothing on its right', 'v:\nbase:\n  font_size: 2 + $v\n'],
    ['a value emptied down to nothing at all', 'v:\nbase:\n  font_size: $v$v\n'],
  ])('leaves %s unmeasured, exactly as the export does', (_label, setting) => {
    // Emptying a reference does not turn an expression into a number. `evaluate_math` needs an operand
    // on each side of its operator and finds none, so the gem's theme table holds the reduced TEXT —
    // `" * 2"`, `"2 * "`, `"2 + "`, `""` — and the converter draws its own default size. A resolver
    // that read `2 * ` as two would put a size on the page the export never had.
    expect(appearanceOf(`extends: default\n${setting}`).base.fontSizePt).toBe(DEFAULT.base.fontSizePt);
  });

  it('rounds an emptied argument to the zero Ruby’s to_f gives it', () => {
    // The one arithmetic shape that DOES reduce: `round()` reads its argument with `to_f`, and
    // `"".to_f` is `0.0`, so the gem's theme table holds the Integer `0`. Both `""` and the `null`
    // this used to build read as zero, so this is the shape that already agreed — kept because the
    // agreement is now load-bearing on the emptying rather than on `to_f` forgiving four stray letters.
    expect(appearanceOf('extends: default\nv:\nbase:\n  font_size: round($v)\n').base.fontSizePt).toBe(0);
  });

  it('leaves a collection alone, which is the value this model still declines to spell', () => {
    // `[1, nil, 2].to_s` is `"[1, nil, 2]"` — Ruby's `inspect`, quoting and punctuation and all — and
    // reproducing it would mean inventing the export's text rather than reproducing it. Measured:
    // `"[1, nil, 2]"` in the theme table for the written list and `"[1, \"\", 2]"` for the referenced
    // one, against a model that stores neither. The nil inside them is not what this declines.
    expect(appearanceOf('extends: default\nmenu:\n  caret_content: [1, null, 2]\n').menu.caretContent).toBeUndefined();
    expect(
      appearanceOf('extends: default\nv:\nmenu:\n  caret_content: [1, $v, 2]\n').menu.caretContent,
    ).toBeUndefined();
  });

  it.each([
    ['a joined element', 'base:\n  font_color: [null, 2]\n', '000002'],
    ['a joined element reached through a reference', 'v:\nbase:\n  font_color: [$v, 2]\n', '000002'],
    ['a joined element nested inside another list', 'base:\n  font_color: [[null], 2]\n', '000002'],
    ['every element of the join', 'base:\n  font_color: [null, null, null, null, null]\n', '000000'],
    ['a CMYK channel, which to_f reads as zero', 'base:\n  font_color: [null, 0, 0, 0]\n', 'FFFFFF'],
    ['a CMYK channel reached through a reference', 'v:\nbase:\n  font_color: [$v, 0, 0, 0]\n', 'FFFFFF'],
  ])('already agreed about %s, and still does', (_label, setting, inked) => {
    // The paths a nil reaches through a COLLECTION rather than through text, each of which reads it
    // without stringifying the whole value: `Array#join` converts an element with `to_s` and a nil
    // contributes nothing, and a CMYK channel is `(e.to_s.chomp '%').to_f`, which is zero. Measured
    // values, and the reason the fix above is two call sites and not a sweep over every reader.
    expect(appearanceOf(`extends: default\n${setting}`).base.fontColor).toBe(inked);
  });

  it('still refuses the whole document over a channel the loader raises on', () => {
    // The direction that must NOT move: `sprintf '%02X', nil` raises `TypeError`, so the export throws
    // the document away and prints the default theme. A nil emptied to `""` here would be a channel
    // `Integer()` raises `ArgumentError` on, which is the same refusal — but only if the emptying stays
    // out of the channel path, where nothing stringifies.
    expect(resolveAppearance({ themeText: 'extends: default\nbase:\n  font_color: [null, 0, 0]\n', themePath: 't.yml' }).themeApplied).toBe(false);
    expect(resolveAppearance({ themeText: 'extends: default\nv:\nbase:\n  font_color: [$v, 0, 0]\n', themePath: 't.yml' }).themeApplied).toBe(false);
  });

  it('still refuses the document a negated empty value throws away', () => {
    // `'-' + val` raises `TypeError: no implicit conversion of nil into String` — the loader negates
    // the value rather than its text, so there is nothing here to empty. Measured under both a content
    // key and a colour key, and the export prints the default theme for both.
    expect(resolveAppearance({ themeText: 'extends: default\nv:\nmenu:\n  caret_content: -$v\n', themePath: 't.yml' }).themeApplied).toBe(false);
    expect(resolveAppearance({ themeText: 'extends: default\nv:\nbase:\n  font_color: -$v\n', themePath: 't.yml' }).themeApplied).toBe(false);
  });

  it('leaves a lone reference to an empty value the nothing the export stores', () => {
    // A LONE reference hands back the value ITSELF and never reaches a `to_s` at all, so the gem's
    // theme table holds `nil` for these — the key is set to nothing, which UNSETS what the default
    // theme contributed. The model omits the field for the same reason, and the size falls through to
    // prawn's own twelve points rather than to the default theme's 10.5. Both directions asserted, so
    // an emptying that leaked into the lone branch would be seen: `""` there would be a font size of
    // zero and a margin of zero, neither of which the export draws.
    expect(appearanceOf('extends: default\nv:\nbase:\n  font_size: $v\n').base.fontSizePt).toBe(12);
    expect(appearanceOf('extends: default\nbase:\n  font_size:\n').base.fontSizePt).toBe(12);
    expect(appearanceOf('extends: default\nv:\nheading:\n  h2:\n    margin_top: $v\n').headings[2].marginTopPt).toBe(
      DEFAULT.headings[2].marginTopPt,
    );
  });
});

describe('a setting the document never wrote a line of its own for', () => {
  // A merge key hands one mapping's entries to another, so the settings it contributes exist in the
  // theme without being written anywhere in its text — there is no line to point an author at. The
  // anchor below is parked under `font`, whose subkeys the loader reads only for the catalogue and
  // the fallback list and drops otherwise, so the anchor itself contributes no setting of its own
  // and the merged copy is the only place the value is read.
  const mergedRefusal = [
    'v: true',
    'font:',
    '  holder: &shared',
    '    font_color: -$v',
    'base:',
    '  <<: *shared',
    '',
  ].join('\n');

  const mergedDangling = [
    'font:',
    '  holder: &shared',
    '    caret_content: $nowhere',
    'menu:',
    '  <<: *shared',
    '',
  ].join('\n');

  it('refuses the whole document over a merged setting without inventing a line for it', () => {
    const result = resolveAppearance({ themeText: mergedRefusal, themePath: 'brand-theme.yml' });
    expect(result.themeApplied).toBe(false);
    // The resource still names the file, so the diagnostic is still attributable; what it must not
    // carry is a line number, because the setting is on none of them.
    expect(result.diagnostics[0]?.location).toEqual({ path: 'brand-theme.yml' });
  });

  it('names a merged dangling reference by its setting, still without a line', () => {
    const result = resolveAppearance({ themeText: mergedDangling, themePath: 'brand-theme.yml' });
    expect(result.themeApplied).toBe(true);
    // The key is one this module's own vocabulary can name, so the sentence spells it out — the
    // value survives as the text the export holds, so nothing else would mention it.
    expect(result.diagnostics[0]?.themeKey).toBe('menu_caret_content');
    expect(result.diagnostics[0]?.message).toContain('menu.caret.content');
    expect(result.diagnostics[0]?.location).toEqual({ path: 'brand-theme.yml' });
  });
});

describe('the seam the font catalogue puts through the middle of a document', () => {
  const CATALOGUE = [
    'font:',
    '  catalog:',
    '    Brand:',
    '      normal: GEM_FONTS_DIR/notoserif-regular-subset.ttf',
  ].join('\n');

  it('reports a refusal written below the catalogue at the line it is written on', () => {
    // The cascade is read in two passes split where the catalogue sits, and a refusal in the second
    // one is still a refusal: the export throws the document away wherever it meets it.
    const result = resolveAppearance({
      themeText: `${CATALOGUE}\nv: true\nzzz: -$v\n`,
      themePath: 'brand-theme.yml',
    });
    expect(result.themeApplied).toBe(false);
    expect(result.diagnostics[0]?.location).toEqual({ path: 'brand-theme.yml', line: 6 });
  });

  it('expands a fallback list written below the catalogue against the settings below it too', () => {
    // `font_fallbacks` written after the catalogue is expanded by the loader once it has read the
    // settings between the two, so `-$v` finds the boolean and throws the document away. Against the
    // settings ABOVE the split it would have found nothing and dangled harmlessly, which is the
    // contrast the second half states.
    const below = resolveAppearance({
      themeText: `${CATALOGUE}\nv: true\nfont_fallbacks: [-$v]\n`,
      themePath: 'brand-theme.yml',
    });
    expect(below.themeApplied).toBe(false);
    expect(below.diagnostics[0]?.message).toContain('fallback name');

    const above = resolveAppearance({
      themeText: `font_fallbacks: [-$v]\n${CATALOGUE}\nv: true\n`,
      themePath: 'brand-theme.yml',
    });
    expect(above.themeApplied).toBe(true);
    expect(above.diagnostics).toEqual([]);
  });

  it('says once what a dangling reference written on both sides of the seam says twice', () => {
    // One mistake, written under two spellings of the same setting — the nested one above the
    // catalogue and the flat one below it — so each pass meets it separately. A list that reported
    // both would count one fault twice in a panel an author reads top to bottom.
    const result = resolveAppearance({
      themeText: `menu:\n  caret_content: $nowhere\n${CATALOGUE}\nmenu_caret_content: $nowhere\n`,
      themePath: 'brand-theme.yml',
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.themeKey).toBe('menu_caret_content');
  });
});

describe('the shape constants the barrel publishes beside the appearance', () => {
  it('names an admonition kind for every icon the default appearance carries', () => {
    expect([...ADMONITION_TYPES].toSorted()).toEqual(Object.keys(DEFAULT.admonition.icons).toSorted());
  });

  it('names a heading level for every heading the default appearance carries', () => {
    for (const level of HEADING_LEVELS) expect(DEFAULT.headings[level]).toBeDefined();
    expect(Object.keys(DEFAULT.headings)).toHaveLength(HEADING_LEVELS.length);
  });

  it('reads a family name up to the published cap and no further', () => {
    // The cap is exported because it is the bound a caller can state to an author before they save;
    // a name longer than it is not read at all, and the default family stands.
    const atCap = 'A'.repeat(MAX_FONT_FAMILY_LENGTH);
    expect(appearanceOf(`base:\n  font_family: ${atCap}\n`).base.fontFamily).toBe(atCap);
    expect(appearanceOf(`base:\n  font_family: ${atCap}B\n`).base.fontFamily).toBe(DEFAULT.base.fontFamily);
  });
});
