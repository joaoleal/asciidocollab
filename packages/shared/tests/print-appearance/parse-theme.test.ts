import { Alias, YAMLMap, YAMLSeq } from 'yaml';
import { resolveAppearance } from '../../src/print-appearance';
import { flatThemeKey, parseThemeDocument } from '../../src/print-appearance/parse-theme';
import { RubyNumber } from '../../src/print-appearance/units';
import { DEFAULT_THEME_YAML } from '../../src/render-config/default-theme.generated';
import { expectWithinBudget } from './perf-budget';

/**
 * A number the export spells differently from the way JavaScript does — see {@link RubyNumber}.
 *
 * Written out rather than derived, so a test says what the export writes and not what the module
 * computes: a helper that called `spelledFloat` would agree with any spelling the module invented.
 *
 * @param value - The magnitude.
 * @param spelling - What ruby 3.3.3's `to_s` writes for it, measured.
 * @returns The value as the parser hands it on.
 */
function spelled(value: number, spelling: string): RubyNumber {
  return new RubyNumber(value, spelling);
}

/** The entries of a document that parsed, or a failure if it did not — keeps each test to one assert. */
function entriesOf(text: string, bundled = false): Record<string, unknown> {
  const result = parseThemeDocument(text, { bundled });
  if (!result.ok) throw new Error(`expected the document to parse: ${result.failure.message}`);
  return Object.fromEntries(result.theme.entries.map((entry) => [entry.key, entry.value]));
}

describe('flatThemeKey', () => {
  it('folds the dotted descriptor form and the nested document form onto the same key', () => {
    expect(flatThemeKey('heading.h2.font-color')).toBe('heading_h2_font_color');
    expect(flatThemeKey('font_color')).toBe('font_color');
    expect(flatThemeKey('Base.Font-Size')).toBe('base_font_size');
  });
});

describe('parseThemeDocument', () => {
  it('flattens a nested document into the key space the renderer stores settings under', () => {
    expect(entriesOf('heading:\n  h2:\n    font-color: 1A4E8A\n')).toEqual({
      heading_h2_font_color: '1A4E8A',
    });
  });

  it('keeps a role NAME’s hyphens, which is the one place the loader does not fold them', () => {
    // `%(#{key}_#{key == 'role' || !(subkey.include? '-') ? subkey : (subkey.tr '-', '_')})`
    // (`theme_loader.rb:172`). A role name is the author's own word, not a category the loader
    // renames, so it survives as written — while everything UNDER it goes on folding normally.
    // Measured against the vendored gem under ruby 3.3.3, this document loads as
    // `{:"role_my-role_font_color" => "FF0000", :role_plain_font_color => "00FF00"}`, so a preview
    // that folded the name reached a setting under a spelling the export has no way to read.
    expect(entriesOf('role:\n  my-role:\n    font-color: FF0000\n  plain:\n    font-color: 00FF00\n')).toEqual(
      { 'role_my-role_font_color': 'FF0000', role_plain_font_color: '00FF00' },
    );
    // One level only: the rule tests the ENCLOSING key for `role`, so a hyphen deeper still folds.
    expect(entriesOf('role:\n  a-b:\n    c-d:\n      font-color: FF0000\n')).toEqual({
      'role_a-b_c_d_font_color': 'FF0000',
    });
    // And nothing else in the document gets the exemption, however much it looks like a role.
    expect(entriesOf('role-x:\n  my-role:\n    font-color: FF0000\n')).toEqual({
      role_x_my_role_font_color: 'FF0000',
    });
  });

  it('records the keys written as a group of settings, so a shadowed one can be named', () => {
    const result = parseThemeDocument('base:\n  font_size:\n    h1: 24\n');
    if (!result.ok) throw new Error('expected the document to parse');
    // `base_font_size` is not a setting in the export either — the loader descends into a mapping
    // and never assigns the key — so the preview is faithful and the author is told nothing. This
    // is what lets the resolver say it.
    expect([...result.theme.mappingKeys].toSorted()).toEqual(['base', 'base_font_size']);
    expect(result.theme.entries.map((entry) => entry.key)).toEqual(['base_font_size_h1']);
  });

  it('keeps document order, because a variable may only refer to a value already loaded', () => {
    const result = parseThemeDocument('base:\n  font_size: 10\n  font_size_large: $base_font_size * 2\n');
    if (!result.ok) throw new Error('expected the document to parse');
    expect(result.theme.entries.map((entry) => entry.key)).toEqual([
      'base_font_size',
      'base_font_size_large',
    ]);
  });

  it('quotes a bare hexadecimal colour so YAML cannot read it as a number', () => {
    // Unquoted, `999999` parses as the integer 999999 and `000123` as 123 — both losing the value.
    expect(entriesOf('base:\n  font_color: 999999\n  border_color: 000123\n')).toEqual({
      base_font_color: '999999',
      base_border_color: '000123',
    });
  });

  it('strips the optional hash a theme may write before a colour', () => {
    expect(entriesOf('link:\n  font_color: #428BCA\n')).toEqual({ link_font_color: '428BCA' });
  });

  it('keeps a trailing comment out of the value it follows', () => {
    expect(entriesOf('base:\n  font_color: 333333 # the body colour\n')).toEqual({
      base_font_color: '333333',
    });
  });

  it('leaves a value the loader leaves numeric, however hexadecimal its digits look', () => {
    // `m[:h] || (m[:k].end_with? 'color')` (theme_loader.rb:102) decides the quoting: a value is
    // quoted only when it carries a `#` or its KEY ends in `color`. `105`, `250` and `123456` are all
    // runs of hexadecimal digits, and the export loads every one of them as the number it is —
    // quoting them here made the preview read a size as text the export reads as a measurement.
    expect(entriesOf('base:\n  font_size: 105\n  border_width: 123456\n')).toEqual({
      base_font_size: 105,
      base_border_width: 123_456,
    });
    expect(entriesOf('title_page:\n  logo_image_width: 250\n')).toEqual({
      title_page_logo_image_width: 250,
    });
  });

  it('tests the key for the five letters `color`, case-sensitively, as `end_with?` does', () => {
    // `end_with? 'color'` is a plain suffix test on the written key: no British spelling, no case
    // folding, and no `_` required before it. The KEY keeps its case too — `key.tr '-', '_'` is the
    // whole of the loader's normalisation — so an oddly-cased spelling is a setting of its own that
    // nothing reads, rather than the same setting with a different value. Run against the vendored
    // gem under ruby 3.3.3, the three spellings below load as `:a_font_Color => 333333`,
    // `:a_FONT_COLOR => 333333` and `:a_font_color => "333333"`.
    expect(entriesOf('a:\n  font_color: 333333\n')).toEqual({ a_font_color: '333333' });
    expect(entriesOf('a:\n  mycolor: 333333\n')).toEqual({ a_mycolor: '333333' });
    expect(entriesOf('a:\n  font_colour: 333333\n')).toEqual({ a_font_colour: 333_333 });
    expect(entriesOf('a:\n  font_Color: 333333\n')).toEqual({ 'a_font_Color': 333_333 });
    expect(entriesOf('a:\n  FONT_COLOR: 333333\n')).toEqual({ 'a_FONT_COLOR': 333_333 });
  });

  it('quotes three to six digits, which is the run the loader’s own pattern matches', () => {
    // `(?<v>\h\h\h\h{0,3})` (theme_loader.rb:23) is three digits plus up to three more — five is a
    // length the loader quotes and `to_color` then pads to `012345`, not a length it skips. A value
    // that is not such a run is not the substitution's business at all, whatever the key is called.
    expect(entriesOf('a:\n  font_color: 1234\n')).toEqual({ a_font_color: '1234' });
    expect(entriesOf('a:\n  font_color: 12345\n')).toEqual({ a_font_color: '12345' });
    expect(entriesOf('a:\n  font_color: 12345678\n')).toEqual({ a_font_color: 12_345_678 });
    expect(entriesOf('a:\n  font_color: red\n  border_color: transparent\n')).toEqual({
      a_font_color: 'red',
      a_border_color: 'transparent',
    });
  });

  it('quotes a value carrying a hash whatever its key is, so the line is not read as a comment', () => {
    // `m[:h] ||` — without the substitution, `font_size: #12345` is a null setting followed by a
    // comment. The hash itself is dropped, exactly as the loader drops it.
    expect(entriesOf('a:\n  font_size: #12345\n')).toEqual({ a_font_size: '12345' });
    expect(entriesOf('a:\n  font_size: #105\n')).toEqual({ a_font_size: '105' });
  });

  it('re-reads a value the author quoted, because the loader’s pattern matches quotes too', () => {
    // `(?<q>["']?)…\k<q>` matches an already-quoted value, and the replacement re-emits the quotes
    // only when the key or the `#` calls for them. `'105'` reaches the export as the number 105.
    expect(entriesOf("a:\n  font_size: '105'\n")).toEqual({ a_font_size: 105 });
    expect(entriesOf('a:\n  font_color: "333333"\n')).toEqual({ a_font_color: '333333' });
    expect(entriesOf('a:\n  font_color: "#333333"\n')).toEqual({ a_font_color: '333333' });
  });

  it('leaves a leading zero on a non-colour key to the reader, which reads it as OCTAL', () => {
    // Restated over the stronger invariant. This used to expect 12,345 — the YAML 1.2 core schema's
    // reading — with a note saying that the export reads a leading-zero digit run as octal and that
    // closing the gap was not what this pass decides. It is closed now: {@link psychScalar} types the
    // value the way the export's own reader types it, so what is asserted is the export's number and
    // not the parser's. Measured against the vendored gem under ruby 3.3.3: `a_font_size` comes back
    // as 5,349, and `012349` — which has a digit octal has no room for — as the string `012349`.
    //
    // What the quoting pass decides is still what it decided: the value stops being a string on a key
    // the export never quotes, and stays one on a colour key, which is the other half below.
    expect(entriesOf('a:\n  font_size: 012345\n')).toEqual({ a_font_size: 5349 });
    expect(entriesOf('a:\n  font_size: 012349\n')).toEqual({ a_font_size: '012349' });
    expect(entriesOf('a:\n  font_color: 012345\n')).toEqual({ a_font_color: '012345' });
  });

  it('quotes a whole `key: value` line only, never a value inside a collection', () => {
    // The pattern is anchored to a line and bounded by the end of it, so a flow sequence never
    // matches — and a key nested UNDER a colour key is judged by its own name, not its parent's.
    expect(entriesOf('a:\n  border_color: [333333, 666666]\n')).toEqual({
      a_border_color: [333_333, 666_666],
    });
    expect(entriesOf('a:\n  border_color:\n    top: 333333\n')).toEqual({ a_border_color_top: 333_333 });
  });

  it('reads a key the way the loader’s pattern reads one: no spaces in it, spaces after it', () => {
    // `^(?<k> *\p{Graph}+): +` — a key with a space inside it is not a key the substitution sees, and
    // the separator is one or more SPACES, so a tab-separated entry is left for YAML to read.
    expect(entriesOf('a:\n  my color: 333333\n')).toEqual({ 'a_my color': 333_333 });
    expect(entriesOf('a:\n  font_color:\t333333\n')).toEqual({ a_font_color: 333_333 });
  });

  it('substitutes on a document saved with Windows line endings, which the loader normalises first', () => {
    // `::File.read filename, newline: :universal` (theme_loader.rb:100) — the loader never sees a
    // carriage return, so a CRLF document is substituted exactly like any other. Splitting on `\n`
    // alone left the `\r` where the pattern expects the end of the line and nothing was substituted
    // at all: every colour in a Windows-saved theme was read as a number.
    expect(entriesOf('base:\r\n  font_color: 000123\r\n')).toEqual({ base_font_color: '000123' });
    expect(entriesOf('base:\r\n  font_size: 105\r\n')).toEqual({ base_font_size: 105 });
    expect(entriesOf('base:\r  font_color: 000123\r')).toEqual({ base_font_color: '000123' });
  });

  it('leaves the renderer’s own vendored theme unquoted, as the renderer reads it', () => {
    // The renderer applies the quoting only to project documents; the bundled theme quotes its own.
    const bundled = parseThemeDocument('base:\n  font_color: 333333\n', { bundled: true });
    if (!bundled.ok) throw new Error('expected the document to parse');
    expect(bundled.theme.entries[0].value).toBe(333_333);
  });

  it('reads the extends targets, in the order the document declares them', () => {
    const single = parseThemeDocument('extends: default\nbase:\n  font_size: 11\n');
    const many = parseThemeDocument('extends: [base, ./house-theme.yml]\n');
    if (!single.ok || !many.ok) throw new Error('expected both documents to parse');
    expect(single.theme.extendsTargets).toEqual(['default']);
    expect(many.theme.extendsTargets).toEqual(['base', './house-theme.yml']);
  });

  it('does not turn the extends declaration into a setting of its own', () => {
    expect(entriesOf('extends: default\nbase:\n  font_size: 11\n')).toEqual({ base_font_size: 11 });
  });

  describe('an extends the loader cannot read as the name of a theme', () => {
    /**
     * The `extends` value, and what the vendored gem does with it under ruby 3.3.3.
     *
     * `(Array extends).each {|extend_path| extend_path.end_with? ' !important' … }`
     * (`theme_loader.rb:107-119`) asks `end_with?` of every element, and `end_with?` belongs to
     * String — so the loader raises `NoMethodError` before it has read one setting, `converter.rb:556`
     * rescues it bare, and the export prints the document with the DEFAULT theme. The preview said
     * NOTHING about any of the refusing rows: `readExtends` dropped the non-String and read the rest,
     * so `extends: 5` was a theme with no `extends` at all, applied with `themeApplied` true.
     */
    const REFUSED: [string, string, number][] = [
      ['an integer', 'extends: 5\n', 1],
      // Ruby truthiness, not JavaScript's: `0` reaches `end_with?` where a falsiness test would not.
      ['a zero', 'extends: 0\n', 1],
      ['a float', 'extends: 5.5\n', 1],
      ['a true', 'extends: true\n', 1],
      // `Array(hash)` is the hash's PAIRS, and a pair is an Array.
      ['a mapping', 'extends:\n  a: b\n', 1],
      ['a mapping written inline', 'extends: {a: b}\n', 1],
      ['a mapping of two pairs', 'extends:\n  - a: 1\n    b: 2\n', 1],
      ['a list holding an integer', 'extends: [base, 5]\n', 1],
      ['a list holding a null', 'extends: [~]\n', 1],
      ['a list holding a true', 'extends: [true]\n', 1],
      ['a list holding a false', 'extends: [base, false]\n', 1],
      ['a list holding a mapping', 'extends: [{a: b}]\n', 1],
      ['a list holding a list', 'extends: [[base]]\n', 1],
      // Line 2 rather than 1, which is what makes the attribution a real read of the document.
      ['an anchor naming an integer', 'a: &a 5\nextends: *a\n', 2],
    ];

    /**
     * The contrast, and the half that is easiest to over-refuse.
     *
     * `if ::Hash === yaml_data && (extends = yaml_data.delete 'extends')` guards the whole loop, so
     * `false` and an absent or empty value skip it — and `Array({})` is empty, so an empty mapping
     * iterates nothing. Every one of THESE loads in the vendored gem under ruby 3.3.3, with the
     * setting below the declaration, so refusing any of them would be refusing a document the export
     * prints.
     *
     * The rows that name a file the gem then cannot open are not here. They are a divergence, not
     * fidelity, and are pinned separately below — this table is the one a future change that
     * over-refuses has to fail, and a row the gem does not load would have made it fail for the
     * opposite reason.
     */
    const LOADED: [string, string][] = [
      ['a false, which the truthiness guard skips', 'extends: false\n'],
      ['an empty value', 'extends:\n'],
      ['an explicit null', 'extends: null\n'],
      ['a tilde', 'extends: ~\n'],
      ['an empty list, which iterates nothing', 'extends: []\n'],
      ['an empty mapping, whose Array() is empty too', 'extends: {}\n'],
      ['a bundled name', 'extends: base\n'],
      ['a list of names', 'extends: [base, default]\n'],
      ['a name with the !important suffix', 'extends: base !important\n'],
      ['an extends nested under a category, which is an ordinary setting', 'base:\n  extends: 5\n'],
    ];

    /**
     * Read here, refused THERE — and refused for a reason this module deliberately does not model.
     *
     * Every row is a String, so `end_with?` answers and the shape check these tests are about passes.
     * What happens next is that the loader opens the file it names and there is no such file: measured
     * against the vendored gem under ruby 3.3.3, all five raise `Errno::ENOENT` out of `load_file`,
     * into the same bare rescue, and the export prints the document with the DEFAULT theme.
     *
     * Kept out of {@link LOADED} because the two tables pin opposite things. That one says a document
     * the export prints must be read; this one records a document the export does NOT print being
     * read anyway, which is what {@link EXTENDS_SHAPE_FAILURE} argues for on purpose — a preview
     * cannot know which names a file until it has the file, and refusing every name it does not
     * recognise would refuse every theme that extends a real one this module has not been handed.
     * A change that came to refuse these would be a fidelity IMPROVEMENT, and would fail here rather
     * than reading as a regression in the table meant to catch over-refusal.
     */
    const ENOENT_IN_THE_EXPORT: [string, string][] = [
      // A String either way: `5 !important` is text, and a `$reference` in an extends is never
      // expanded — the loader treats the whole value as a file name.
      ['a number carrying the !important suffix, which YAML types as text', 'extends: 5 !important\n'],
      ['a name that looks like a reference', 'extends: -$v\n'],
      ['a name no file answers to', 'extends: nope\n'],
      ['an empty name', "extends: ''\n"],
      ['a list holding an empty name', "extends: ['']\n"],
    ];

    it.each(REFUSED)('refuses the whole document, given %s', (_label, text, line) => {
      const result = parseThemeDocument(`${text}base:\n  font_size: 11\n`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.message).toBe(
        'The extends setting in the theme document has something other than the name of a theme where a name was expected, and reading it stops the whole document being read.',
      );
      // The line the author has to change, which is what a reveal-in-editor control navigates by.
      expect(result.failure.line).toBe(line);
    });

    it.each(LOADED)('reads the document, given %s', (_label, text) => {
      // The setting below the declaration is the witness: the document is read in full, not merely
      // read past the `extends` line.
      expect(entriesOf(`${text}base:\n  font_size: 11\n`)).toEqual({ base_font_size: 11 });
    });

    it.each(ENOENT_IN_THE_EXPORT)(
      'reads the document the export cannot open, given %s',
      (_label, text) => {
        expect(entriesOf(`${text}base:\n  font_size: 11\n`)).toEqual({ base_font_size: 11 });
      },
    );

    it('is answered before every refusal the settings walk finds', () => {
      // `load_file` follows `extends` before it hands the mapping to `load` (`theme_loader.rb:107`
      // against `:121`), so a document wrong in both places is refused over its `extends` — and the
      // author is sent to the line that is read first rather than to the one written first.
      const both = parseThemeDocument('example:\n  padding: 1\n10:\n  font_size: 5\nextends: 5\n');
      expect(both.ok).toBe(false);
      if (both.ok) return;
      expect(both.failure.message).toContain('extends setting');
      expect(both.failure.line).toBe(5);
    });

    it('says nothing of what the document wrote there', () => {
      // The sentence has to hold for every shape above, and an `extends` value is the document's own
      // text — a mapping KEY under it is too. See the marker suite in `hostile-theme.test.ts`.
      const result = parseThemeDocument('extends:\n  "</style> contact admin@evil.example": 1\n');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.message).not.toContain('</style>');
      expect(result.failure.message).not.toContain('evil.example');
    });
  });

  it('reads the font catalogue without minting a setting per font file', () => {
    const result = parseThemeDocument(
      'font:\n  catalog:\n    Brand Sans:\n      normal: fonts/brand-regular.woff2\n      bold: fonts/brand-bold.woff2\n',
    );
    if (!result.ok) throw new Error('expected the document to parse');
    expect(result.theme.fontFamilies).toEqual([
      {
        name: 'Brand Sans',
        styles: { normal: 'fonts/brand-regular.woff2', bold: 'fonts/brand-bold.woff2' },
      },
    ]);
    expect(result.theme.entries).toEqual([]);
  });

  it('expands the catalogue’s single-file and regular aliases the way the renderer does', () => {
    const result = parseThemeDocument(
      'font:\n  catalog:\n    One File: fonts/one.woff2\n    Aliased:\n      regular: fonts/r.woff2\n',
    );
    if (!result.ok) throw new Error('expected the document to parse');
    expect(result.theme.fontFamilies).toEqual([
      {
        name: 'One File',
        styles: {
          normal: 'fonts/one.woff2',
          bold: 'fonts/one.woff2',
          italic: 'fonts/one.woff2',
          bold_italic: 'fonts/one.woff2',
        },
      },
      { name: 'Aliased', styles: { normal: 'fonts/r.woff2' } },
    ]);
  });

  it('stores every other catalogue style exactly as written, because the renderer does', () => {
    // `subaccum[style] = expanded_path` (`theme_loader.rb:151`) neither folds a hyphen nor
    // downcases, and `register_fonts` then registers the face under `style.to_sym`
    // (`converter.rb:4158`) — where prawn only ever looks up `:normal`, `:bold`, `:italic` and
    // `:bold_italic`. So a face declared as `bold-italic` or `Bold` inks NOTHING in the export.
    // Folding those spellings here set the preview's text in a face the export leaves on the shelf.
    // Measured against the vendored gem under ruby 3.3.3: `font_catalog` comes back as
    // `{"X" => {"bold-italic" => "a.ttf", "Bold" => "b.ttf"}}`.
    const result = parseThemeDocument(
      'font:\n  catalog:\n    X:\n      bold-italic: a.ttf\n      Bold: b.ttf\n      normal: c.ttf\n',
    );
    if (!result.ok) throw new Error('expected the document to parse');
    expect(result.theme.fontFamilies).toEqual([
      { name: 'X', styles: { 'bold-italic': 'a.ttf', Bold: 'b.ttf', normal: 'c.ttf' } },
    ]);
  });

  it('reports whether the catalogue adds to the inherited one or replaces it', () => {
    const replacing = parseThemeDocument('font:\n  catalog:\n    Brand: fonts/b.woff2\n');
    const merging = parseThemeDocument('font:\n  catalog:\n    merge: true\n    Brand: fonts/b.woff2\n');
    if (!replacing.ok || !merging.ok) throw new Error('expected both documents to parse');
    expect(replacing.theme.fontCatalogueMerges).toBe(false);
    expect(merging.theme.fontCatalogueMerges).toBe(true);
    // `merge` is an instruction, never a family — a face named "merge" would be a real regression.
    expect(merging.theme.fontFamilies.map((family) => family.name)).toEqual(['Brand']);
  });

  it.each([
    ['a number', '1'],
    ['a word', 'yes'],
    ['zero, which Ruby counts as true', '0'],
    ['an empty list', '[]'],
  ])('merges the catalogue for %s, because the renderer tests it for truth', (_label, written) => {
    // `(val.delete 'merge') ? data[key] || {} : {}` (theme_loader.rb:138) — only `false` and null are
    // falsy in Ruby, so testing for `true` alone dropped the built-in families from a catalogue the
    // export still merges.
    const result = parseThemeDocument(`font:\n  catalog:\n    merge: ${written}\n    Brand: fonts/b.woff2\n`);
    if (!result.ok) throw new Error('expected the document to parse');
    expect(result.theme.fontCatalogueMerges).toBe(true);
  });

  it.each([
    ['false', 'false'],
    ['null', 'null'],
  ])('replaces the catalogue for a merge written as %s', (_label, written) => {
    const result = parseThemeDocument(`font:\n  catalog:\n    merge: ${written}\n    Brand: fonts/b.woff2\n`);
    if (!result.ok) throw new Error('expected the document to parse');
    expect(result.theme.fontCatalogueMerges).toBe(false);
  });

  it('records how many settings precede the catalogue, so its paths resolve where it was written', () => {
    const result = parseThemeDocument(
      'base:\n  font_size: 11\nfont:\n  catalog:\n    Brand: $fonts_dir/b.ttf\ncode:\n  font_size: 9\n',
    );
    if (!result.ok) throw new Error('expected the document to parse');
    expect(result.theme.entries.map((entry) => entry.key)).toEqual(['base_font_size', 'code_font_size']);
    expect(result.theme.fontCatalogueEntryIndex).toBe(1);
  });

  it.each([
    ['a scalar subkey', 'font:\n  size: 30\n'],
    ['a subkey the renderer has never had', 'font:\n  weird: 1\n'],
    ['a nested subkey', 'font:\n  fallback:\n    size: 30\n'],
    ['a font that is not a mapping at all', 'font: 12\n'],
  ])('drops %s, because the loader’s font branch reads only catalog and fallbacks', (_label, text) => {
    // `if key == 'font'` reads `catalog` and `fallbacks` out of the value and stores nothing else
    // (`theme_loader.rb:133-136`), and the branch is guarded by `::Hash === val` with no fall-through,
    // so a `font` that is not a mapping stores nothing either. Run against the vendored gem under
    // ruby 3.3.3, `font_size`, `font_weird` and `font` all come back nil. Flattening the subtree into
    // settings meant `$font_size` resolved here and dangled in the export.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries).toEqual([]);
  });

  it('mints no setting from a catalogue written as one flat top-level key', () => {
    // `font_catalog` and `font_fallbacks` are branches of `process_entry` in their own right
    // (`theme_loader.rb:137,157`), so a document may write either as a flat top-level key instead of
    // nesting it under `font`. Run against the vendored gem under ruby 3.3.3, this loads
    // `font_catalog => {"Brand"=>{"normal"=>"b.ttf"}}` and `font_catalog_Brand_normal => nil` — a
    // catalogue, never a setting per font file. Descending into it would mint one setting per file,
    // named after paths the author chose.
    const result = parseThemeDocument(
      'font_catalog:\n  Brand:\n    normal: b.ttf\nfont_fallbacks: [Brand]\nbase:\n  font_size: 9\n',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries.map((entry) => entry.key)).toEqual(['base_font_size']);
    // Written above the only setting, so this is where the catalogue sits in document order.
    expect(result.theme.fontCatalogueEntryIndex).toBe(0);
  });

  it('still finds the catalogue’s position when a dropped subkey is written beside it', () => {
    // The subtree is descended into for one reason — where `font.catalog` sits in document order
    // decides which values its paths expand against — so dropping the settings must not lose that.
    // `font.size` is not a setting, so it does not shift the count the way it used to.
    const result = parseThemeDocument(
      'base:\n  font_size: 11\nfont:\n  size: 30\n  catalog:\n    Brand: $fonts_dir/b.ttf\ncode:\n  font_size: 9\n',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries.map((entry) => entry.key)).toEqual(['base_font_size', 'code_font_size']);
    expect(result.theme.fontCatalogueEntryIndex).toBe(1);
    expect(result.theme.fontFamilies.map((family) => family.name)).toEqual(['Brand']);
  });

  it('says the whole entry list precedes a catalogue that is not there at all', () => {
    const result = parseThemeDocument('base:\n  font_size: 11\ncode:\n  font_size: 9\n');
    if (!result.ok) throw new Error('expected the document to parse');
    expect(result.theme.fontCatalogueEntryIndex).toBe(2);
  });

  it('keeps an array value whole, because an inset is four edges rather than four settings', () => {
    expect(entriesOf('page:\n  margin: [0.5in, 0.67in, 0.67in, 0.67in]\n')).toEqual({
      page_margin: ['0.5in', '0.67in', '0.67in', '0.67in'],
    });
  });

  it('records the line each setting was written on, so a rejection can be revealed in the editor', () => {
    const result = parseThemeDocument('extends: default\n\nheading:\n  h2:\n    font-color: 1A4E8A\n');
    if (!result.ok) throw new Error('expected the document to parse');
    expect(result.theme.entries).toEqual([{ key: 'heading_h2_font_color', value: '1A4E8A', line: 5 }]);
  });

  it('reads the renderer’s own default theme without a failure', () => {
    const result = parseThemeDocument(DEFAULT_THEME_YAML, { bundled: true });
    expect(result.ok).toBe(true);
  });

  it('treats an empty document as overriding nothing rather than as a failure', () => {
    expect(parseThemeDocument('')).toEqual({
      ok: true,
      theme: {
        entries: [],
        extendsTargets: [],
        fontFamilies: [],
        fontFallbacks: [],
        fontCatalogueMerges: false,
        fontCatalogueEntryIndex: 0,
        mappingKeys: new Set(),
        expandedOnlyStrings: [],
      },
    });
    expect(parseThemeDocument('# only a comment\n').ok).toBe(true);
  });

  it('reports malformed YAML as a failure with the line the parser blamed', () => {
    const result = parseThemeDocument('base:\n  font_size: [unclosed\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).not.toBe('');
    expect(result.failure.line).toBeGreaterThan(0);
  });

  it.each([
    ['at the top level', 'a: 1\nb: 2\na: 3\n', [{ key: 'a', value: 3 }, { key: 'b', value: 2 }]],
    ['inside a nested mapping', 'base:\n  x: 1\n  x: 2\n', [{ key: 'base_x', value: 2 }]],
    ['inside a flow mapping', 'list:\n  - {k: 1, k: 2}\n', [{ key: 'list', value: [{ k: 2 }] }]],
    [
      'written once bare and once quoted, which YAML calls the same key',
      'a: 1\n"a": 2\n',
      [{ key: 'a', value: 2 }],
    ],
  ])('reads a key the document sets twice %s, last write winning', (_label, text, expected) => {
    // The export does not refuse these and neither may this. `revive_hash` writes `hash[key] = val`
    // for every pair in turn (`psych/visitors/to_ruby.rb:344-381`) with no duplicate check anywhere,
    // so the last write wins and the theme loads. Each of these four was run against the vendored gem
    // under ruby 3.3.3 and the values below are what it returned — `a => 3`, `base_x => 2`,
    // `list => [{"k"=>2}]`, `a => 2`.
    //
    // Refusing instead cost the author the WHOLE theme: the default page, under a `theme-unparseable`
    // error, for a document the export applies in full. That is the outcome
    // `MAX_STRINGIFIED_KEY_CHARGE` already argues against for a collection key, and the two paths now
    // agree. Fails with the duplicate-key scan restored — every one of these comes back `ok: false`.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries.map(({ key, value }) => ({ key, value }))).toEqual(expected);
  });

  it.each([
    ['written last', 'base:\n  font_size: $10\n"10": 20\n', ['base_font_size', '10']],
    ['written first', '"10": 20\nbase:\n  font_size: $10\n', ['10', 'base_font_size']],
    ['among several', '"2": a\nb: 1\n"1": c\n', ['2', 'b', '1']],
  ])('keeps a numeric key in document order, %s', (_label, text, expected) => {
    // An own property whose name is a canonical non-negative integer is an array INDEX, and
    // `[[OwnPropertyKeys]]` lists every index in ascending numeric order ahead of the string keys —
    // whatever order they were inserted in. Materialising the document into a JavaScript object
    // therefore reordered it, and everything downstream reads that order as the document's own.
    //
    // Fails without the rename: the first case comes back `['10', 'base_font_size']`.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries.map((entry) => entry.key)).toEqual(expected);
  });

  it('leaves a forward reference to a later numeric key dangling, as the export does', () => {
    // Why the order is load-bearing, and this file's header says so: the renderer expands against what
    // it has already loaded, so a key can only refer BACKWARDS. Run against the vendored gem under
    // ruby 3.3.3, this document loads `base_font_size` as the literal `"$10"` and warns about an
    // unknown variable reference, so the PDF prints at the default 10.5. Reordered, `$10` found 20 and
    // the preview showed 20 pt with nothing to say about it.
    const forward = resolveAppearance({ themeText: 'extends: default\nbase:\n  font_size: $10\n"10": 20\n' });
    expect(forward.appearance.base.fontSizePt).toBe(10.5);
    // Written the other way round it DOES resolve, which is what says this is an ordering rule and
    // not a refusal to read numeric keys at all.
    const backward = resolveAppearance({ themeText: 'extends: default\n"10": 20\nbase:\n  font_size: $10\n' });
    expect(backward.appearance.base.fontSizePt).toBe(20);
  });

  it('keeps a font family named with digits under the name the document gave it', () => {
    // The rename moves a key out of the index space, and a catalogue's keys are author-chosen FACE
    // names that a `font-family` setting matches on — so the name has to come back as written.
    const result = parseThemeDocument('font:\n  catalog:\n    "10":\n      normal: a.ttf\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.fontFamilies).toEqual([{ name: '10', styles: { normal: 'a.ttf' } }]);
    // And the UNQUOTED spelling gives the same name, which is a claim about prawn rather than about
    // this module. The loader stores the Integer `10` as the catalogue's key — measured under ruby
    // 3.3.3, `font_catalog.keys` comes back `[[Integer, 10]]` — but nothing looks a face up in the
    // catalogue: `register_fonts` hands it to `register_font`, which is
    // `font_families.update data.transform_keys(&:to_s)` (`ext/prawn/extensions.rb:313`). Measured on
    // a real `Prawn::Document` given that very catalogue: `font_families.key? '10'` is true and
    // `font_families.key? 10` is false, so `font-family: '10'` matches in the export exactly as it
    // does here, and the two spellings agree because prawn makes them agree.
    const unquoted = parseThemeDocument('font:\n  catalog:\n    10:\n      normal: a.ttf\n');
    expect(unquoted.ok).toBe(true);
    if (!unquoted.ok) return;
    expect(unquoted.theme.fontFamilies).toEqual([{ name: '10', styles: { normal: 'a.ttf' } }]);
  });

  it('keeps a re-set key in the position it was first written, as Hash#[]= does', () => {
    // Last write wins is only half the rule; the other half is that the winning value stays where the
    // FIRST write put it, which is what decides what a later `$reference` to a neighbouring key sees.
    const result = parseThemeDocument('base:\n  font_size: 9\n  font_color: 111111\n  font_size: 21\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: 'base_font_size', value: 21 },
      { key: 'base_font_color', value: '111111' },
    ]);
  });

  it.each([
    [
      'a number and the string of it, which YAML calls two keys',
      'role:\n  1:\n    font_size: 9\n  "1":\n    font_color: 111111\n',
    ],
    ['two merge keys, which the export applies in turn', 'a: &z {x: 1}\nb:\n  <<: *z\n  <<: *z\n'],
  ])('does not call %s a duplicate, because the parser does not', (_label, text) => {
    // Written under `role`, which is the one parent an unquoted number reaches the export through:
    // everywhere else `process_entry` calls `include?` on it and the whole theme fails to load, so
    // the top-level spelling this case used to be written in is now a document the export refuses
    // too — see the non-String key cases below. Measured against the vendored gem under ruby 3.3.3,
    // the document below loads `role_1_font_size => 9` and `role_1_font_color => "111111"`, so the
    // two spellings are still two keys and the duplicate check has to stay off for them.
    expect(parseThemeDocument(text).ok).toBe(true);
  });

  it.each([
    ['a tab used as indentation', 'a: 1\n\t</style><img src=x onerror=alert(1)>: 2\n'],
    ['an unclosed flow sequence', 'x: 1\nbase:\n  size: [1, 2 "; } html { display: none } .a {"\n'],
    ['a nested mapping where a value belongs', 'a: <script>alert(1)</script>\n b: 2\n'],
    ['an alias naming an anchor set after it', 'a: &a x\nb: *missing_</style>_anchor\n'],
    [
      'an alias bomb',
      [
        'a: &a ["</style>","x","x","x","x","x","x","x","x"]',
        'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
        'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
        'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
        'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      ].join('\n'),
    ],
  ])('says why %s could not be read without repeating any of the document back', (_label, text) => {
    // The `yaml` package appends a CODE FRAME of the offending line to its own message, and names the
    // anchor in an alias error, so copying either into a failure carried the document's own text into
    // a diagnostic — against this module's header and against `AppearanceDiagnostic.message`. The
    // fixtures put markup on exactly the line the parser blames, so a message built from the parser's
    // would carry it.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const fragment of ['</style>', '<script', 'display: none', 'onerror', 'missing_']) {
      expect({ fragment, present: result.failure.message.includes(fragment) }).toEqual({
        fragment,
        present: false,
      });
    }
    expect(result.failure.message).toMatch(/theme document/);
  });

  it('reports a document that is not a mapping of settings', () => {
    const result = parseThemeDocument('- just\n- a\n- list\n');
    expect(result.ok).toBe(false);
  });

  /**
   * Typing a plain scalar the way the export's reader types it.
   *
   * The parser resolves the YAML 1.2 core schema; Psych resolves YAML 1.1 with extensions of its own.
   * Every value below was measured against the vendored gem under ruby 3.3.3 — through
   * `ThemeLoader.load_file`, so it is what the export STORES and not what a YAML library says — and
   * several were measured again from a converted PDF, which is what settled the ones the loader and
   * the converter disagree about.
   *
   * Every case fails with {@link installPsychScalars} removed, and each names what it comes back as.
   */
  it.each([
    // The exponent rule, which is the whole of Psych's FLOAT regex: a literal dot AND a signed
    // exponent, or it is not a float. Was 1,000,000,000 for the first five.
    ['an exponent with no dot', 'a: 1e9\n', { a: '1e9' }],
    ['an exponent with a dot but no sign', 'a: 1.0e9\n', { a: '1.0e9' }],
    ['an exponent with a sign but no dot', 'a: 1e+9\n', { a: '1e+9' }],
    ['a capital exponent with neither', 'a: 1E9\n', { a: '1E9' }],
    ['a negative exponent with no dot', 'a: 1e-9\n', { a: '1e-9' }],
    ['an exponent with both, which IS a float', 'a: 1.0e+9\n', { a: spelled(1e9, '1000000000.0') }],
    ['a dot with an empty fraction and an exponent', 'a: 1.e+9\n', { a: spelled(1e9, '1000000000.0') }],
    // Bases. A leading zero is octal in YAML 1.1 and decimal in the core schema; `0o` is the core
    // schema's own octal and nothing to Psych; `0b` is binary to Psych and nothing to the core schema.
    ['a leading zero, which is octal', 'a: 010\n', { a: 8 }],
    ['a leading zero with a digit octal has no room for', 'a: 09\n', { a: '09' }],
    ['the core schema’s octal, which the export has never had', 'a: 0o10\n', { a: '0o10' }],
    ['binary, which the export has and the core schema does not', 'a: 0b101\n', { a: 5 }],
    ['hexadecimal, which both have', 'a: 0x1f\n', { a: 31 }],
    // Digit separators. Psych takes an underscore anywhere between digits and, as an extension of its
    // own, a comma too. Was the text of the literal for all four.
    ['an underscore between digits', 'a: 1_000\n', { a: 1000 }],
    ['an underscore inside a float', 'a: 1_0.5\n', { a: 10.5 }],
    ['a comma between digits', 'a: 1,000\n', { a: 1000 }],
    ['an underscore in a hexadecimal literal', 'a: 0x_1f\n', { a: 31 }],
    ['a trailing underscore, which separates nothing', 'a: 1000_\n', { a: '1000_' }],
    ['two underscores together', 'a: 1__000\n', { a: '1__000' }],
    // The booleans YAML 1.1 spells and the core schema does not. Was the text for every one of them.
    ['yes', 'a: yes\n', { a: true }],
    ['no', 'a: no\n', { a: false }],
    ['on', 'a: on\n', { a: true }],
    ['off', 'a: off\n', { a: false }],
    ['YES, since the test is case-insensitive', 'a: YES\n', { a: true }],
    ['Off', 'a: Off\n', { a: false }],
    // …and the ones that look like them and are not. `y` and `n` are the two the YAML 1.1 SCHEMA
    // reads as booleans and Psych does not, which is one of the reasons the schema is not the fix.
    ['y, which the export keeps as one letter', 'a: y\n', { a: 'y' }],
    ['n, likewise', 'a: n\n', { a: 'n' }],
    ['Off-white, which is prose', 'a: Off-white\n', { a: 'Off-white' }],
    ['On the road, which is longer than a keyword can be', 'a: On the road\n', { a: 'On the road' }],
    // Base 60, with Psych's own arithmetic. `60 ** (e - 2).abs` weights the components by their
    // distance from the THIRD one, so a two-component literal is read as hours and minutes: 5,400 and
    // not the 90 the YAML 1.1 type specifies. `page: size: [1:30, 1:30]` prints MediaBox `5400 5400`.
    ['a two-component base-60 literal', 'a: 1:30\n', { a: 5400 }],
    ['a three-component one', 'a: 1:30:30\n', { a: 5430 }],
    ['one whose first component is out of range', 'a: 190:20:30\n', { a: 685_230 }],
    ['a fractional one', 'a: 1:30.5\n', { a: spelled(5430, '5430.0') }],
    ['one whose minutes are out of range, which is text', 'a: 1:60\n', { a: '1:60' }],
    // The remaining keywords.
    ['NuLL, which is nothing at all', 'a: NuLL\n', { a: null }],
    ['positive infinity', 'a: .inf\n', { a: Number.POSITIVE_INFINITY }],
    ['negative infinity', 'a: -.inf\n', { a: Number.NEGATIVE_INFINITY }],
    ['inf, which is three letters', 'a: inf\n', { a: 'inf' }],
    ['a bare point, which is one character', 'a: .\n', { a: '.' }],
    // The shapes that must NOT be re-typed, because the export does not type them either: `deserialize`
    // returns the text unread for anything quoted — which in Psych includes a block scalar — and
    // dispatches on the tag when there is one (`psych/visitors/to_ruby.rb:63-64`).
    ['a single-quoted value', "a: 'yes'\n", { a: 'yes' }],
    ['a double-quoted value', 'a: "12345678"\n', { a: '12345678' }],
    ['a value tagged as a string', 'a: !!str 1e9\n', { a: '1e9' }],
    ['a block literal', 'a: |-\n  yes\n', { a: 'yes' }],
    ['a folded block', 'a: >-\n  010\n', { a: '010' }],
  ])('types a plain scalar as the export types it: %s', (_label, text, expected) => {
    expect(entriesOf(text)).toStrictEqual(expected);
  });

  it('types a value inside a list, which is where a page size is written', () => {
    // The motivating case. `page: size: [1e9, 1e9]` laid out a page a billion points square in the
    // preview; the export prints MediaBox `595.28 841.89`, because the converter's own
    // `MeasurementPartsRx` rejects the STRING `1e9` and falls back to A4 — measured from a converted
    // PDF. Was `[1000000000, 1000000000]`.
    expect(entriesOf('page:\n  size: [1e9, 1e9]\n')).toEqual({ page_size: ['1e9', '1e9'] });
    // And the same list written with values the export DOES read as numbers, so this is a test of the
    // typing rather than of lists: MediaBox `1000 1000` and `5400 5400`, both measured.
    expect(entriesOf('page:\n  size: [1_000, 1_000]\n')).toEqual({ page_size: [1000, 1000] });
    expect(entriesOf('page:\n  size: [1:30, 1:30]\n')).toEqual({ page_size: [5400, 5400] });
  });

  it('types a value the hexadecimal-colour pass re-emitted BARE, which is how a quoted one gets here', () => {
    // The two passes compose, and this is the composition. `'1e9'` is three hexadecimal digits, so the
    // loader's line substitution matches it — and re-emits it WITHOUT the author's quotes, because the
    // key does not end in `color` (`theme_loader.rb:102`). So the value the reader is handed is plain
    // after all, and an author who quoted it gets the same text the export gets. Measured against the
    // vendored gem: `a_font_size` comes back as the string `1e9`. Was 1,000,000,000.
    expect(entriesOf("a:\n  font_size: '1e9'\n")).toEqual({ a_font_size: '1e9' });
    // The same composition where the two passes push in the same direction: quoted, re-emitted bare,
    // and then read as octal. Measured against the vendored gem: `a_font_size => 8`. Was 10.
    expect(entriesOf('a:\n  font_size: "010"\n')).toEqual({ a_font_size: 8 });
    // On a colour key the same pass re-emits the quotes, so nothing types it and this is the string it
    // always was — which is what says the two passes are ordered the way the loader orders them.
    expect(entriesOf("a:\n  font_color: '1e9'\n")).toEqual({ a_font_color: '1e9' });
    expect(entriesOf('a:\n  font_color: "010"\n')).toEqual({ a_font_color: '010' });
  });

  it('types a KEY as the reader types it, because that is the name the setting is stored under', () => {
    // The re-typing used to be value-position only, on the argument that there was no key spelling to
    // agree with. There is: `revive_hash` calls `accept` on a pair's key before its value, so Psych
    // types both, and the name it produces is the name `process_entry` interpolates into the flat key
    // a `$reference` and a descriptor then look the setting up by.
    //
    // `1e9` is a billion to the parser and the three characters it spells to Psych, so leaving the key
    // to the parser stored this setting as `1000000000_font_size`. Measured against the vendored gem
    // under ruby 3.3.3: `1e9_font_size => 9`.
    expect(entriesOf('1e9:\n  font_size: 9\n')).toEqual({ '1e9_font_size': 9 });
    // Under `role`, which is the one parent that lets a key Psych types as something other than a
    // String through at all, both halves of the same disagreement show. `yes` is a true to Psych and
    // three letters to the parser, and `010` is eight to Psych and ten to the parser. Measured:
    // `role_true_font_color => "FF0000"` and `role_8_font_size => 9`. Were `role_yes_font_color` and
    // `role_10_font_size`, neither of which the export has.
    expect(entriesOf('role:\n  yes:\n    font-color: FF0000\n')).toEqual({
      role_true_font_color: 'FF0000',
    });
    expect(entriesOf('role:\n  010:\n    font_size: 9\n')).toEqual({ role_8_font_size: 9 });
    // And a nil key keeps the empty name Ruby's `to_s` gives it rather than the `null` that
    // `String(null)` would. Measured: `role__font_size => 9`.
    expect(entriesOf('role:\n  ~:\n    font_size: 9\n')).toEqual({ role__font_size: 9 });
  });

  it.each([
    ['a date', 'base:\n  font_size: 2001-12-14\n'],
    ['a date under a key nothing reads', 'some_key: 2001-12-14\nbase:\n  font_size: 20\n'],
    ['a date inside a list', 'page:\n  margin: [2001-12-14, 0, 0, 0]\n'],
    ['a timestamp', 'base:\n  font_size: 2001-12-14 21:59:43 -5\n'],
    ['a symbol', 'base:\n  font_family: :serif\n'],
  ])('refuses the whole document over %s, which is what the export does with one', (_label, text) => {
    // Psych builds a `Date`, a `Time` or a `Symbol` for these three shapes, and the loader reads a
    // theme with `safe_load` and no `permitted_classes` (`theme_loader.rb:104`), so the reader raises
    // `Psych::DisallowedClass` before a key has been looked at. Measured through a real conversion:
    // asciidoctor logs `could not locate or load the pdf theme … because of Psych::DisallowedClass`
    // and prints the page with the DEFAULT theme, MediaBox `595.28 841.89` — including for the date
    // written under a key the converter never reads, which is what says it is the document that is
    // refused and not the value.
    //
    // Was read, in full, with the date carried as text. A theme whose author wrote one saw a preview
    // built from settings the export had thrown away.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/date, a time or a symbol/);
  });

  it.each([
    ['a hexadecimal prefix with only separators after it', 'some_unread_key: 0x_\nbase:\n  font_size: 20\n'],
    ['a binary prefix with only separators after it', 'some_unread_key: 0b,\nbase:\n  font_size: 20\n'],
    ['both signed spellings of it', 'a: -0b_\nb: +0x,\n'],
    ['an exponent with no mantissa', 'base:\n  font_size: .e+1\n'],
    ['one inside a list', 'page:\n  margin: [.E-2, 0, 0, 0]\n'],
  ])('refuses the whole document over %s, which is what the export does with one', (_label, text) => {
    // Psych MATCHES these as numbers and then raises converting them. `INTEGER_LEGACY` counts a comma
    // as a digit separator, so `0x,` matches a base prefix carrying nothing else, and `parse_int`
    // deletes the separators before handing `Integer()` the bare `0x`; `FLOAT` makes both the integer
    // part and the fraction optional, so `.e+1` matches, and the `\.([Ee]|$)` rewrite takes the dot
    // away before `Float()` is handed `e+1`. Both raise `ArgumentError` — measured against ruby 3.3.3
    // over every string of length four or less across an alphabet holding every character those
    // patterns use, which turns up exactly `[-+]?0b[_,]+`, `[-+]?0x[_,]+` and `[-+]?\.[eE][-+]\d+`.
    //
    // `load_theme`'s rescue (`converter.rb:556`) is BARE, so the raise leaves the loader exactly as
    // `Psych::DisallowedClass` does: `could not locate or load the pdf theme …; reverting to default
    // theme`, and the page is printed with the default theme.
    //
    // Was `parseInt('', 16)` — NaN, assigned to the key and read on past. The first document here
    // previewed at 20 pt with nothing to report, for a page the export prints at 10.5.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/number the theme reader cannot read/);
  });

  it.each([
    ['a prefix with a digit among the separators', 'a: 0x_1_\n', { a: 1 }],
    ['a prefix and nothing at all after it, which is not a number to begin with', 'a: 0x\n', { a: '0x' }],
    ['an exponent with a fraction in front of it', 'a: .0e+1\n', { a: spelled(0, '0.0') }],
    ['an exponent with an integer part in front of it', 'a: 1.e+1\n', { a: spelled(10, '10.0') }],
    ['a bare point, which Psych hands back as text', 'a: .\n', { a: '.' }],
    ['an unsigned exponent, which is not a float to Psych at all', 'a: .e1\n', { a: '.e1' }],
  ])('reads a document whose number only LOOKS unreadable: %s', (_label, text, expected) => {
    // The other side of that refusal, drawn on what `Integer()` and `Float()` actually take rather
    // than on anything looser: each of these was tokenized through ruby 3.3.3's own ScalarScanner and
    // came back as the value below. Refusing one of them would show the default page for a theme the
    // export applies in full.
    expect(entriesOf(text)).toStrictEqual(expected);
  });

  it.each([
    ['at the top level', '2001-12-14: 1\nbase:\n  font_size: 20\n'],
    ['under a key nothing reads', 'some_key:\n  2001-12-14: 1\nbase:\n  font_size: 20\n'],
    ['under role, where an unquoted number IS legal', 'role:\n  2001-12-14: 1\n'],
    ['written as a timestamp', '2001-12-14 21:59:43 -5: 1\n'],
    ['written as a symbol', ':serif: 1\n'],
  ])('refuses the whole document over a date in KEY position, %s', (_label, text) => {
    // `revive_hash` calls `accept` on a pair's KEY before it calls it on the value
    // (`psych/visitors/to_ruby.rb:344-381`), so the same `ScalarScanner` types both and the same
    // `Psych::DisallowedClass` reaches the export from either side. Measured against the vendored gem
    // under ruby 3.3.3, every one of these raises `Tried to load unspecified class: Date`, `Time` or
    // `Symbol` — including under `role`, because the reader has not reached a key yet when it raises
    // and the `role` exemption is the LOADER's, one stage later.
    //
    // Was read, in full: the first document came back as `{"2001_12_14": 1, "base_font_size": 20}`,
    // so a theme whose author wrote a date-shaped key previewed at 20 pt for a page the export prints
    // at the default 10.5 with every other setting thrown away too.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe(
      'A key in the theme document is written as a date, a time or a symbol, and a theme is not read with any of those.',
    );
  });

  it.each([
    ['a hexadecimal prefix with only separators after it', '0x_: 1\nbase:\n  font_size: 20\n'],
    ['a binary prefix with only separators after it', 'base:\n  0b,: 1\n'],
    ['one under role, where an unquoted number IS legal', 'role:\n  0x_: 1\n'],
    ['an exponent with no mantissa', '.e+1: 1\n'],
  ])('refuses the whole document over %s in KEY position', (_label, text) => {
    // The other half of the same reader. Psych MATCHES these as numbers and raises converting them,
    // and it does so wherever they are written. Measured against the vendored gem under ruby 3.3.3:
    // `invalid value for Integer(): "0x"`, `… "0b"` and `invalid value for Float(): "e+1"`, each of
    // which `load_theme`'s bare rescue (`converter.rb:556`) turns into `reverting to default theme`.
    //
    // Was read: the first document came back as `{"0x_": 1, "base_font_size": 20}` and previewed at
    // 20 pt, for a page the export prints at 10.5.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe(
      'A key in the theme document is written as a number the theme reader cannot read, so none of the document is read.',
    );
  });

  it.each([
    ['a number at the top level', '10:\n  font_size: 5\n'],
    ['a number under a parent that is not role', 'base:\n  10:\n    font_size: 5\n'],
    ['a number two levels under role, where the exemption reaches one', 'role:\n  x:\n    10: 5\n'],
    ['a word Psych reads as true', 'yes:\n  font_size: 5\n'],
    ['nothing at all', '~:\n  font_size: 5\n'],
    ['a float', '1.5:\n  font_size: 5\n'],
    ['a not-a-number', '.nan:\n  font_size: 5\n'],
    ['an octal the parser would have read as a decimal', '010:\n  font_size: 5\n'],
    ['the immediate subkey of an admonition icon', 'admonition_icon_tip:\n  10: 5\n'],
    [
      'one written under role and MERGED into a parent that is not',
      'c: &c\n  10:\n    font_size: 5\nrole:\n  <<: *c\n',
    ],
  ])('refuses the whole document over %s in key position', (_label, text) => {
    // This one survives the reader and dies in the LOADER. `process_entry` normalises a key with
    // `key.tr '-', '_' if … (key.include? '-')` (`theme_loader.rb:132`) and joins a nested one with
    // `key == 'role' || !(subkey.include? '-')` (`:172`), and an Integer, a Float, a true, a false and
    // a nil have no `include?` — so it raises `NoMethodError`, which the bare rescue at
    // `converter.rb:556` turns into the default theme exactly as `Psych::DisallowedClass` is.
    //
    // Measured against the vendored gem under ruby 3.3.3: every document here raises
    // `undefined method 'include?'`, for an Integer, a Float, `true` or `nil` in turn. The last is the
    // one that says the position has to be the MATERIALISED one — `c` is written at the top level and
    // merged under `role`, so a rule read off where the mapping is WRITTEN would have exempted it.
    //
    // All ten were read: `10_font_size`, `base_10_font_size`, `role_x_10`, `yes_font_size` and the
    // rest, each alongside every other setting in a document the export prints with the default theme.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe(
      'A key in the theme document is written as a number, a boolean or nothing at all, and a theme names its settings with text.',
    );
  });

  it.each([
    ['a role subkey, which the join short-circuits past', 'role:\n  10: 5\n', { role_10: 5 }],
    [
      'a role subkey reached through a merge written under role',
      'role:\n  <<: &c\n    10:\n      font_size: 5\n',
      { role_10_font_size: 5 },
    ],
    [
      'a subkey of an admonition icon’s own mapping, which `evaluate` returns untouched',
      'admonition_icon_tip:\n  a:\n    10: 5\n',
      { admonition_icon_tip_a: { '10': 5 } },
    ],
    [
      'the same, under an icon named by the composed spelling',
      'admonition:\n  icon_tip:\n    a:\n      10: 5\n',
      { admonition_icon_tip_a: { '10': 5 } },
    ],
    ['a subkey of `font`, which the loader reads two names out of', 'font:\n  10: 5\n', {}],
  ])('still reads a document whose non-String key the loader never asks about: %s', (_label, text, expected) => {
    // The other side of that refusal, and the reason it is drawn on the position rather than on the
    // key. Each of these loads in the vendored gem under ruby 3.3.3: `role_10 => 5`,
    // `role_10_font_size => 5`, `admonition_icon_tip => {a: {10 => 5}}` — twice, since the branch is a
    // `start_with?` on the name the loader has built and not a test of a top-level key — and nothing
    // at all for `font`, whose branch compares the subkey to `catalog` and `fallbacks` and never calls
    // a method on it. Refusing any of them would show the default page for a theme the export applies.
    //
    // The admonition rows are asserted over the SHAPE the export stores rather than over a flat name,
    // which is the strengthening: `evaluate` hands the Hash back untouched, so `a` is a setting whose
    // value is a mapping and `10` is a key INSIDE it. Flattened to `admonition_icon_tip_a_10` it read
    // as a setting the export has no name for, and — this is what the flattening cost — the `\0n10`
    // this module mints to keep a typed key apart travelled into the value with it.
    expect(entriesOf(text)).toEqual(expected);
  });

  it.each([
    ['a date in key position', '2001-12-14: 1\nbase:\n  font_size: 20\n'],
    ['a number the reader raises on in key position', '0x_: 1\nbase:\n  font_size: 20\n'],
    ['a key the loader cannot name a setting with', '10: 1\nbase:\n  font_size: 20\n'],
    ['a top-level key written as a list', '? [1, 2]\n: v\nbase:\n  font_size: 20\n'],
    ['an admonition icon set to one value', 'admonition_icon_tip: hello\nbase:\n  font_size: 20\n'],
  ])('costs the WHOLE document, as the export’s bare rescue does, given %s', (_label, themeText) => {
    // What "a document failure" means where anyone can see it. `load_theme`'s rescue
    // (`converter.rb:556`) names no exception class, so all three of these leave the export in the
    // same place: `could not locate or load the pdf theme …; reverting to default theme`, and the page
    // printed at the default 10.5 pt with `base_font_size: 20` thrown away along with everything else.
    // Each was read here instead, and the preview showed 20 pt for a page the export prints at 10.5.
    const result = resolveAppearance({ themeText, themePath: 'theme/refused-theme.yml' });
    expect(result.themeApplied).toBe(false);
    expect(result.appearance.base.fontSizePt).toBe(10.5);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['theme-unparseable']);
  });

  it('reports whichever of a key and a value the reader would have raised on first', () => {
    // Two refusals of different kinds in one document, and the reader meets them in document order:
    // `revive_hash` accepts a pair's key and then its value, mapping by mapping. Measured against the
    // vendored gem under ruby 3.3.3, the first document raises `Psych::DisallowedClass` over the date
    // and the second raises `ArgumentError: invalid value for Integer(): "0x"` over the key — the same
    // two documents, in the two orders.
    const valueFirst = parseThemeDocument('a: 2001-12-14\n0x_: 1\n');
    expect(valueFirst.ok).toBe(false);
    if (valueFirst.ok) return;
    expect(valueFirst.failure.message).toMatch(/^A value .* a date, a time or a symbol/);
    const keyFirst = parseThemeDocument('0x_: 1\na: 2001-12-14\n');
    expect(keyFirst.ok).toBe(false);
    if (keyFirst.ok) return;
    expect(keyFirst.failure.message).toMatch(/^A key .* number the theme reader cannot read/);
  });

  it('keeps a role subkey written twice, as an Integer and as a String, apart', () => {
    // `process_entry`'s nested join is `key == 'role' || !(subkey.include? '-') ? subkey : …`
    // (`theme_loader.rb:172`), and `||` SHORT-CIRCUITS: under `role` the `include?` is never called,
    // so an Integer subkey raises nothing there — where at the top level and under any other parent
    // it raises `NoMethodError` and the whole theme fails to load. Measured against the vendored gem
    // under ruby 3.3.3, this document loads BOTH `role_10_font_size => 5` and
    // `role_10_font_color => "333333"`.
    //
    // Materialising both spellings under one name dropped the first mapping WHOLESALE, so
    // `role_10_font_size` vanished and nothing said so.
    expect(entriesOf('role:\n  10:\n    font_size: 5\n  "10":\n    font_color: "333333"\n')).toEqual({
      role_10_font_size: 5,
      'role_10_font_color': '333333',
    });
  });

  it('still calls a key written twice the SAME way one key, in the position it was first written', () => {
    // The other half of the rule the type tag has to leave alone. `revive_hash` writes into one Hash,
    // so two pairs spelled identically are one entry with the last value, keeping the first's
    // position — which is what a later `$reference` to a neighbouring key sees.
    const result = parseThemeDocument('"10": 1\nb: 2\n"10": 3\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: '10', value: 3 },
      { key: 'b', value: 2 },
    ]);
  });

  it('leaves a key the document began with a NUL where the document put it', () => {
    // A NUL is not a character no key can hold: `"\0base"` is a legal double-quoted scalar and the
    // parser decodes the escape. Stripping a leading NUL — which is how the index-key rename used to
    // be undone — turned that into `base`, so this document previewed body text at 20 pt. Measured
    // against the vendored gem under ruby 3.3.3, it loads as `:"\x00base_font_size" => 20`, an inert
    // setting nothing reads, and the export prints the page at the default 10.5.
    expect(entriesOf('"\\0base":\n  font_size: 20\n')).toEqual({ '\u0000base_font_size': 20 });
    expect(resolveAppearance({ themeText: 'extends: default\n"\\0base":\n  font_size: 20\n' }).appearance.base.fontSizePt).toBe(10.5);
    // The tag alone is not the shape either, and the `n` tag now names more than an index-like key —
    // it names every value the reader types as something other than a String — so the strip has to be
    // the exact inverse of what the mint can WRITE. `base` is not a name `String(value)` produces for
    // any such value, and `true` is not an index-like key, so neither of these is this module's. The
    // vendored gem under ruby 3.3.3 loads them as `:"\x00nbase_font_size"` and
    // `:"\x00strue_font_size"`, two inert settings, and prints the page at the default 10.5.
    expect(entriesOf('"\\0nbase":\n  font_size: 20\n')).toEqual({ '\u0000nbase_font_size': 20 });
    expect(entriesOf('"\\0strue":\n  font_size: 20\n')).toEqual({ '\u0000strue_font_size': 20 });
  });

  it.each([
    // Every name above is one the mint could NOT have written, which is the easy half. These are the
    // names it CAN write, spelled by the document — and until the mint's space was closed by
    // escaping into it, each of these was read as the mint's own.
    ['an index-like name under the number tag', String.raw`"\0n10"`, '\u0000n10'],
    ['a true', String.raw`"\0ntrue"`, '\u0000ntrue'],
    ['a false', String.raw`"\0nfalse"`, '\u0000nfalse'],
    ['the empty name a nil key is given', String.raw`"\0n"`, '\u0000n'],
    ['a float in its canonical spelling', String.raw`"\0n1.5"`, '\u0000n1.5'],
    ['an index-like name under the string tag', String.raw`"\0s10"`, '\u0000s10'],
  ])('reads a key the document wrote into the mint’s own space: %s', (_label, written, name) => {
    // The refusal direction, which the reasoning that left this open never looked at. The HONEST
    // spelling of a number key raises in the loader — `base:\n  10: 5` raises `NoMethodError` — and
    // is refused here, so reading a forged one as the mint's own refused the whole document over a
    // key the author wrote as text. Measured against the vendored gem under ruby 3.3.3, every one of
    // these loads, storing an inert setting beside everything else: `base_\x00n10`, `base_\x00ntrue`,
    // `base_\x00nfalse`, `base_\x00n`, `base_\x00n1.5` and `base_\x00s10`.
    expect(entriesOf(`base:\n  ${written}: 5\n  font_size: 11\n`)).toEqual({
      [`base_${name}`]: 5,
      base_font_size: 11,
    });
    // At the top level, where there is no category to hide behind…
    expect(entriesOf(`${written}: 5\n`)).toEqual({ [name]: 5 });
    // …and carried into a parent that is not the one it was written under, which is the position the
    // refusal is drawn at.
    expect(entriesOf(`c: &c\n  ${written}: 5\nbase:\n  <<: *c\n`)).toEqual({
      [`c_${name}`]: 5,
      [`base_${name}`]: 5,
    });
  });

  it('goes on refusing the honest spelling of a key the loader cannot name a setting with', () => {
    // The contrast that makes the row above a fidelity fix rather than a hole: closing the mint's
    // space must not close the refusal. `key.include? '-'` (`theme_loader.rb:132`) is a method an
    // Integer lacks, and the gem under ruby 3.3.3 raises `NoMethodError: undefined method 'include?'
    // for an instance of Integer` on this document.
    const result = parseThemeDocument('base:\n  10: 5\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/^A key in the theme document is written as a number/);
  });

  it('types a key an alias names, which is the one road the rename does not sit on', () => {
    // `? *big` names its key from a scalar written somewhere else, and that scalar is not a key node
    // — so the mint was absent from this road entirely, and both halves of what it is for came apart
    // on it, in opposite directions. Measured against the vendored gem under ruby 3.3.3.
    //
    // An Integer reaches `process_entry` exactly as the honest `base:\n  10: 5` does and raises
    // `NoMethodError`; the preview read a setting `base_10` and showed a page for a theme the export
    // throws away.
    const integer = parseThemeDocument('big: &big 10\nbase:\n  ? *big\n  : 5\n');
    expect(integer.ok).toBe(false);
    if (integer.ok) return;
    expect(integer.failure.message).toMatch(/^A key in the theme document is written as a number/);

    // …and the forged mint name is a String, so it loads as an inert setting: the gem stores
    // `:"base_\x00n10" => 5`, where the preview read the mint's own spelling and refused.
    expect(entriesOf('big: &big "\\0n10"\nbase:\n  ? *big\n  : 5\n')).toEqual({
      big: '\u0000n10',
      'base_\u0000n10': 5,
    });

    // The exemption travels with it: under `role` the loader never asks, so the same Integer names a
    // role. Measured: `role_10_font_size => 5`.
    expect(entriesOf('big: &big 10\nrole:\n  ? *big\n  : {font_size: 5}\n')).toEqual({
      big: 10,
      role_10_font_size: 5,
    });

    // And an ordinary name is left where the document put it, in both readers.
    expect(entriesOf('big: &big abc\nbase:\n  ? *big\n  : 5\n')).toEqual({ big: 'abc', base_abc: 5 });
  });

  it('reads a forged mint name under role under the name the loader stores it under', () => {
    // The strip direction of the same forgery, which was a known divergence rather than a refusal:
    // `role` is the one parent an index-like key survives, so this document loads in both readers —
    // and the preview read it as the role `10`, where the gem under ruby 3.3.3 loads
    // `:"role_\x00n10_font_size" => 5`. The escape closes both directions at once.
    expect(entriesOf('role:\n  "\\0n10":\n    font_size: 5\n')).toEqual({
      'role_\u0000n10_font_size': 5,
    });
    // The honest spelling still names the role `10`, in both readers.
    expect(entriesOf('role:\n  10:\n    font_size: 5\n')).toEqual({ role_10_font_size: 5 });
  });

  it.each([
    ['quoted', "base:\n  font_size: '2001-12-14'\n", { base_font_size: '2001-12-14' }],
    ['not a real date', 'base:\n  font_size: 2001-13-14\n', { base_font_size: '2001-13-14' }],
    ['a year and a month', 'base:\n  font_size: 2001-12\n', { base_font_size: '2001-12' }],
    ['a leading minus, which the date pattern has no room for', 'a: -2001-12-14\n', { a: '-2001-12-14' }],
    ['a lone colon-less word', 'a: serif\n', { a: 'serif' }],
  ])('reads a document whose value only LOOKS like one of those: %s', (_label, text, expected) => {
    // The other side of the refusal, and the reason it is drawn on Psych's own patterns rather than on
    // anything looser: a document the export reads has to be read here, and refusing one over a value
    // that merely resembles a date would show the default page for a theme the export applies in full.
    expect(entriesOf(text)).toEqual(expected);
  });

  it('refuses a document too large to be worth reading on the preview path', () => {
    const result = parseThemeDocument(`# ${'x'.repeat(600 * 1024)}\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/larger than/);
  });

  it('does not expand an alias bomb into an unbounded allocation', () => {
    // 66,430 nodes from 200 bytes. Refused by the expansion budget, which is now the only bound in
    // the module at all — the parser's own `maxAliasCount` is off, and never saw this document
    // anyway: its worst charge here is 9 × 6,561 = 59,049.
    const bomb = [
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
    ].join('\n');
    const result = parseThemeDocument(bomb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/far more content/);
  });

  it('says a document is nested too deeply rather than calling it invalid', () => {
    // The composer catches its own stack overflow and reports `RESOURCE_EXHAUSTION`, which had no
    // sentence and fell through to "is not valid YAML". This document is valid YAML.
    const result = parseThemeDocument(`a: ${'['.repeat(60_000)}${']'.repeat(60_000)}\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/nested more deeply/);
  });
});

/**
 * One wide anchor merged in at the bottom of `chains` mappings nested `depth` levels deep.
 *
 * The shape that showed the expansion budget was counting the wrong thing. `flatten` names every node
 * by the whole path down to it, so `width × chains` settings nested `depth` deep cost `width × chains
 * × depth` CHARACTERS while the node count stays at `width × chains`, and only the node count was
 * ever charged. At 93 KB it denoted 52,000 settings with keys up to 1,809 characters: 87 million
 * characters, 175 MB of strings, 1.4 seconds, accepted in silence, per keystroke.
 *
 * @param width - Settings in the anchored mapping.
 * @param chains - How many chains merge it.
 * @param depth - How deeply each chain nests before merging it.
 * @returns The document.
 */
function deepWideMerge(width: number, chains: number, depth: number): string {
  const anchor = `big: &big {${Array.from({ length: width }, (_unused, index) => `k${index}: 1`).join(', ')}}`;
  const chained = Array.from(
    { length: chains },
    (_unused, index) => `d${index}: ${'{a: '.repeat(depth)}{<<: *big}${'}'.repeat(depth)}`,
  );
  return `${[anchor, ...chained].join('\n')}\n`;
}

/**
 * A chain of anchors, each level naming the one below it `fan` times through a merge key.
 *
 * @param depth - How many levels.
 * @param fan - How many times each level names the one below it.
 * @returns The document.
 */
function mergeChain(depth: number, fan = 8): string {
  const lines = ['l0: &l0', '  k0: v', '  k1: v'];
  for (let level = 1; level <= depth; level++) {
    lines.push(`l${level}: &l${level}`);
    for (let branch = 0; branch < fan; branch++) lines.push(`  m${branch}:`, `    <<: *l${level - 1}`);
  }
  return `${[...lines, 'base:', `  <<: *l${depth}`].join('\n')}\n`;
}

/** An anchored mapping whose every later child merges it, each copying the ones before it. */
function siblingMerges(count: number): string {
  const nested = Array.from({ length: count }, (_unused, at) => `  s${at + 1}:\n    <<: *a\n`);
  return `a: &a\n  k: 1\n${nested.join('')}`;
}

/**
 * What a document may DENOTE, as against what it says.
 *
 * Every test below fails with one specific bound removed, and each names which. They are here rather
 * than only in `hostile-theme.test.ts` because that file asks whether an appearance came back at all;
 * these ask WHICH bound refused the document, which is the question a bound that has quietly stopped
 * doing anything still answers correctly in the other file.
 */
describe('the expansion budget', () => {
  it('charges the key text a document denotes, not only the nodes', () => {
    // The two documents differ in NESTING and nothing else, which is what makes this a test of the
    // dimension rather than of a constant. Flat, the same 6,000 settings are read without complaint,
    // so the node count is nowhere near its allowance — 6,000 against 303,056. Nested six hundred
    // levels the settings are the same settings and the keys are 2,400 characters each, and that is
    // what is refused. Fails outright with the key-character half of the budget removed: the nested
    // form is then accepted, in 1.4 seconds, exactly as it was.
    const flat = parseThemeDocument(deepWideMerge(2000, 2, 1));
    expect(flat.ok).toBe(true);
    if (!flat.ok) return;
    expect(flat.theme.entries.length).toBe(6000);

    const started = process.hrtime.bigint();
    const nested = parseThemeDocument(deepWideMerge(2000, 2, 600));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(nested.ok).toBe(false);
    if (nested.ok) return;
    expect(nested.failure.message).toMatch(/far more content/);
    // Refusing has to be cheaper than not refusing, or the bound is a second cost rather than a cap.
    expectWithinBudget(elapsedMs, 500);
  });

  it('charges a merge for the whole materialisation it asks for', () => {
    // The charge `maxAliasCount` never makes, at any setting: `addMergeToJSMap` resolves the alias
    // itself and materialises the source afresh per merge, so nothing in the parser counts it. Six
    // levels is 952 bytes and 1.1 million entries; seven exhausted a 1 GB heap. Fails with the
    // expansion budget removed — not by asserting the wrong message, by not finishing.
    for (const depth of [3, 4, 5, 6, 7]) {
      const result = parseThemeDocument(mergeChain(depth));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect({ depth, message: result.failure.message }).toEqual({
        depth,
        message: expect.stringMatching(/far more content/),
      });
    }
  });

  it.each([
    ['a mapping that holds itself', 'a: &a\n  b: *a\n'],
    ['a sequence that holds itself', 'a: &a\n  - *a\n'],
    ['a cycle two levels down', 'a: &a\n  b:\n    c: *a\n'],
    // A merge naming an enclosing SEQUENCE, which is a cycle for a reason of its own: `Hash#merge!`
    // raises `TypeError` on an Array and the rescue keeps `<<` as an ordinary key holding it, so
    // what the export ends up with is a list that contains itself. Measured against the vendored gem
    // under ruby 3.3.3, this one LOADS — `flatten_theme` never walks into a list, so the cycle sits
    // there inert under `a` — and is refused here deliberately: no reader below this one holds a
    // structure that contains itself, and the setting it would hold is one no theme reads.
    ['a merge naming the sequence that encloses it', 'a: &a\n  - <<: *a\n'],
  ])('refuses %s rather than following it', (_label, text) => {
    // Twelve bytes. Composing succeeds and produces a CYCLIC object; `flatten` follows it forever.
    // With the budget removed and no boundary around the flattening, the first of these threw
    // `RangeError: Maximum call stack size exceeded` out of `parseThemeDocument` — and out of the
    // render-phase `useMemo` that calls it. With the budget removed and the boundary in place it
    // comes back as a failure with the wrong sentence, which is why both are here.
    //
    // Every VALUE case here is one the export refuses too: measured against the vendored gem under
    // ruby 3.3.3, `a: &a\n  b: *a` raises `SystemStackError`. That is what separates them from a
    // merge naming an enclosing MAPPING, which terminates in the export and is read — see
    // `the merge key, resolved the way the export resolves it`.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/far more content/);
  });

  it('charges a merge naming an enclosing mapping for the copies it accumulates', () => {
    // The reason the prefix has to be CHARGED rather than merely allowed. Each sibling merge copies
    // everything the mapping has accumulated, the earlier siblings' own copies included, so the
    // settings double with every sibling added: measured against the vendored gem under ruby 3.3.3,
    // seven siblings load 128 `a_…` settings and twelve load 4,096, from 220 bytes.
    //
    // Fails with the prefix charged as a constant — thirty siblings then denote 2^30 settings from
    // 544 bytes, and the document is accepted, per keystroke.
    const read = parseThemeDocument(siblingMerges(7));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.theme.entries.length).toBe(128);

    const started = process.hrtime.bigint();
    const bomb = parseThemeDocument(siblingMerges(30));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(bomb.ok).toBe(false);
    if (bomb.ok) return;
    expect(bomb.failure.message).toMatch(/far more content/);
    // Refusing has to be cheaper than not refusing, or the bound is a second cost rather than a cap.
    expectWithinBudget(elapsedMs, 500);
  });

  it('charges a collection used as a key what the reader will stringify it to', () => {
    // A JavaScript object cannot be keyed by a collection, so the reader stringifies the key and
    // every flat key beneath it then carries that text. Charged as though such a key were short, one
    // 40 KB sequence written as an explicit key over a merged mapping of twenty thousand settings was
    // read as 40,000 settings with keys of 60,012 characters — 1.2 billion characters from 253 KB of
    // document, and `resolveAppearance` did not finish in two minutes. Fails with the key charged a
    // nominal two: the document is accepted, and quickly, which is the whole problem.
    const wide = `wide: &wide {${Array.from({ length: 2000 }, (_unused, index) => `k${index}: 1`).join(', ')}}`;
    const longKey = `[${Array.from({ length: 1000 }, () => 'aaaaaaaa').join(',')}]`;
    const started = process.hrtime.bigint();
    const written = parseThemeDocument(`${wide}\nd0:\n  ? ${longKey}\n  :\n    <<: *wide\n`);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.failure.message).toMatch(/far more content/);
    expectWithinBudget(elapsedMs, 500);

    // The other half of the same rule, and what stops it from being "collection keys are refused":
    // an ALIAS is stringified to `*name` however large the anchor it names, so the same document
    // written that way costs four characters a key and is read.
    //
    // Read in silence, too. The parser announces a stringified key through `process.emitWarning`,
    // quoting it — the document's own text, in the host's warning stream, which is the one channel
    // this module's guarantee about never repeating a document back did not cover.
    const warned = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const aliased = parseThemeDocument(
        `big: &big ${longKey}\n${wide}\nd0:\n  ? *big\n  :\n    <<: *wide\n`,
      );
      expect(aliased.ok).toBe(true);
      if (!aliased.ok) return;
      expect(aliased.theme.entries.at(-1)?.key).toBe('d0_*big_k1999');
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  it('charges an alias key that names a SCALAR the whole string, not the alias', () => {
    // The other half of `stringifyKey`, and the half the charge above missed. It re-serialises to
    // `*name` only what materialises to an OBJECT; its first branch is
    // `typeof jsKey !== 'object' → String(jsKey)`, so an alias naming an anchored STRING is keyed by
    // every character of that string. Charged the written span — `2 × len("*big") + 2 = 10` — the
    // segment every flat key beneath it carries cost ten characters and denoted sixty thousand.
    //
    // Fails with the alias unresolved in `keySegmentCost`: the document is ACCEPTED, 60,007,693
    // characters of flat key against a 3,906,944-character budget, 15.4× over, with no diagnostic —
    // and the same shape at 62,726 bytes took 1,690 ms and 479 MB of resident memory to resolve.
    const big = 'A'.repeat(60_000);
    const wide = `wide: &wide {${Array.from({ length: 50 }, (_unused, index) => `k${index}: 1`).join(', ')}}`;
    const blocks = Array.from({ length: 20 }, (_unused, index) => `d${index}:\n  ? *big\n  :\n    <<: *wide`);
    const document = `big: &big "${big}"\n${wide}\n${blocks.join('\n')}\n`;
    // Well inside the size a theme document may be, which is what makes the bypass reachable at all.
    expect(document.length).toBeLessThan(64 * 1024);

    const started = process.hrtime.bigint();
    const result = parseThemeDocument(document);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/far more content/);
    // Refusing has to be cheaper than not refusing, or the bound is a second cost rather than a cap.
    expectWithinBudget(elapsedMs, 500);
  });

  it('reads a theme whose key names a SHORT anchored scalar, which now costs what it says', () => {
    // The bound has to price the alias rather than refuse it, or `keySegmentCost` would have traded
    // one wrong answer for another: an anchored NAME used as a key is charged its own characters, so
    // a document that reuses a short one is read exactly as the same document written out is.
    const aliased = parseThemeDocument('n: &n heading\nbase:\n  ? *n\n  : 1\n');
    const written = parseThemeDocument('n: heading\nbase:\n  heading: 1\n');
    expect(aliased.ok).toBe(true);
    expect(written.ok).toBe(true);
    if (!aliased.ok || !written.ok) return;
    // The same flat key by both roads, which is what says the charge is measuring the right thing.
    expect(aliased.theme.entries.at(-1)?.key).toBe('base_heading');
    expect(written.theme.entries.at(-1)?.key).toBe('base_heading');
  });

  it('still reads a theme that names one anchor from every role it has', () => {
    // The other side of the bound, and the reason `maxAliasCount` could not be left at its default:
    // the palette idiom is the commonest reason a theme has an anchor at all, and one anchored colour
    // named by 60 roles under three keys each was REFUSED at the hundred-and-first use — under the
    // expansion budget's sentence, which said the document expands into far more content than it is
    // written from. It denotes 181 nodes against an allowance of 77,968. Fails with `maxAliasCount`
    // back at 100.
    const roles = 200;
    const document = [
      'extends: default',
      'brand: &brand 2A5DB0',
      'role:',
      ...Array.from(
        { length: roles },
        (_unused, index) =>
          `  r${index}:\n    font-color: *brand\n    border-color: *brand\n    background-color: *brand`,
      ),
      '',
    ].join('\n');
    const result = parseThemeDocument(document);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries.length).toBe(roles * 3 + 1);
    // Named, not merely counted: an anchor read as something else would still count.
    expect(result.theme.entries.at(-1)).toEqual({
      key: `role_r${roles - 1}_background_color`,
      value: '2A5DB0',
      line: expect.any(Number),
    });
  });
});

/**
 * `count` collection keys and `count` anchors, interleaved so each key is priced against the rest.
 *
 * Every collection key is written one level down, under a parent of its own, because that is the only
 * place the EXPORT reads one: at the top level `process_entry` reaches `key.start_with?` on the list
 * and raises, so a document of top-level collection keys is one the export throws away entirely — and
 * asserting that this module reads such a document, as this fixture used to, asserted the wrong thing.
 * Nested, each of these loads in the vendored gem as the inert setting `d0_[0]`, so the small sizes
 * below are documents the export really does apply in full. The reader's cost is unchanged by the
 * nesting: `addPairToJSMap` re-serialises a collection key against every anchor set so far wherever
 * the pair sits.
 */
const stringifiedKeyDocument = (count: number): string =>
  `${Array.from({ length: count }, (_unused, index) => `d${index}:\n  ? [${index}]\n  : &a${index} 1`).join('\n')}\n`;

/**
 * How many sequence keys the reader re-serialised while reading a document, and whether it read it.
 *
 * A counter rather than `jest.spyOn`, and the difference is not stylistic: a spy RETAINS the arguments
 * of every call, an argument here is a stringify context holding the whole document, and 24,000 of them
 * exhausted a 2 GB heap before any assertion could be reached — so the spy failed the unbounded case by
 * aborting the runner rather than by reporting the count that says what is wrong.
 *
 * @param document - The theme document to read.
 * @returns Whether it was read, and how many sequence keys were re-serialised while reading it.
 */
function stringifiedKeysOf(document: string): { readonly ok: boolean; readonly keys: number } {
  const original = YAMLSeq.prototype.toString;
  let keys = 0;
  YAMLSeq.prototype.toString = function counted(
    ...parameters: Parameters<typeof original>
  ): ReturnType<typeof original> {
    keys += 1;
    return original.apply(this, parameters);
  };
  try {
    return { ok: parseThemeDocument(document).ok, keys };
  } finally {
    YAMLSeq.prototype.toString = original;
  }
}

/**
 * What NAMING a key costs, which is not what materialising it costs.
 *
 * A key that is a list or a mapping cannot key a JavaScript object, so the reader re-serialises it to
 * text — and rebuilds the set of anchor names it serialises against from scratch for every such key,
 * walking the whole list of anchors it has materialised so far (`addPairToJSMap.stringifyKey`). The
 * cost is a PRODUCT of two things the document writes, and neither of the two dimensions the budget
 * measured could see it: a collection key denotes one node and a dozen characters of flat key, which
 * is the truth about what it materialises. 16,200 anchors beside 16,200 nested collection keys fit in
 * 505 KB and were ACCEPTED, in 5.6 seconds on the thread the preview renders on, per keystroke.
 */
describe('naming a key the reader cannot key an object by', () => {
  it('never re-serialises a key against more anchors than a theme is read with', () => {
    // The scale-free half, and the one that states the property rather than a symptom. Every entry
    // into the reader's key stringification walks every anchor the document has set, so the work is
    // the PRODUCT below — a number of operations, not a number of milliseconds, so what it says is
    // true of any machine. `YAMLSeq.prototype.toString` is where the reader re-serialises a sequence
    // key and the only place this module reaches it, so counting the calls counts the keys.
    //
    // Fails without the bound: the last three documents are read rather than refused, so the product
    // is 9 million, 100 million and 262 million against an allowance of one million, and the last
    // takes 5.6 seconds.
    const sizes = [100, 300, 900, 3000, 10_000, 16_000];
    const measured = sizes.map((size) => {
      const { ok, keys } = stringifiedKeysOf(stringifiedKeyDocument(size));
      return { size, ok, product: keys * size };
    });
    expect(measured.filter((each) => each.product > 1_000_000)).toEqual([]);
    // And the bound is not satisfied by refusing the whole family: the small documents are read, and
    // the large ones are refused rather than read to a truncated theme.
    expect(measured.map((each) => each.ok)).toEqual([true, true, true, false, false, false]);
  });

  it('refuses the largest document of that shape in the time a keystroke has', () => {
    // The coarse half, kept because it survives the reader re-serialising a key some way that does not
    // go through `YAMLSeq.prototype.toString`, at which point the assertion above would pass and the
    // tab would still freeze. 520 KB of ordinary project file, which any collaborator with write
    // access can commit; every other collaborator's tab renders the preview from it.
    //
    // The ceiling is more than an order of magnitude off the measurement it guards rather than a tight
    // budget: 5.6 seconds before, 0.29 after, of which the parse is nearly all.
    const document = stringifiedKeyDocument(16_200);
    expect(document.length).toBeGreaterThan(500 * 1024);
    expect(document.length).toBeLessThanOrEqual(512 * 1024);
    const started = process.hrtime.bigint();
    const result = parseThemeDocument(document);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectWithinBudget(elapsedMs, 3000);
    // Its own sentence. A previous round shipped a bound whose failure wore another bound's, and the
    // author of a document that denoted 181 nodes was told it expands into far more content than it is
    // written from. This document denotes 73,942 nodes against an allowance of 250,000 and 372,132
    // characters of flat key against four million, so that sentence would be untrue of it too — it
    // denotes barely more than it says, and is refused for what NAMING what it says would cost.
    //
    // And it is refused for THAT rather than for its size: 505 KB is inside `MAX_THEME_BYTES`, so the
    // sentence below is the bound's own and not the one that says a document is too large to read.
    expect(result.failure.message).toMatch(/lists or mappings/);
    expect(result.failure.message).not.toMatch(/far more content/);
  });

  it('answers with a failure when the reader throws something no bound predicted', () => {
    // The totality guarantee this file's header makes, and the only thing that now reaches the
    // catch-all sentence. Every failure a document can actually cause is named — a parse error, a
    // duplicate key, a bound, an unresolved alias — and the boundary is there for the case none of
    // them saw, because this runs in a render-phase `useMemo` where a throw is a blank preview
    // rather than a diagnostic. Until the merge was made the export's, the parser's own
    // `mergeValue` supplied such a throw ("Merge sources must be maps or map aliases") for a
    // document the export reads happily; with that gone there is no known document that gets here,
    // which is a reason to assert the boundary rather than to drop it.
    const original = YAMLMap.prototype.toJSON;
    YAMLMap.prototype.toJSON = function throwing(): never {
      throw new TypeError('reader broke');
    };
    try {
      const result = parseThemeDocument('base:\n  font_size: 9\n');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // This module's own sentence, not the thrower's: a message from below may carry the document.
      expect(result.failure.message).toBe('The theme document could not be read.');
    } finally {
      YAMLMap.prototype.toJSON = original;
    }
  });

  it('reads a document the parser would have refused for reusing an anchor', () => {
    // Why `maxAliasCount` is off rather than set low. It charges `count × aliasCount`, and
    // `aliasCount` is the LARGEST such product anywhere in the anchor's subtree
    // (`nodes/Alias.getAliasCount`, yaml 2.9.0) — so a chain of anchors each naming the one below
    // multiplies, and the charge stops measuring anything the document costs. This is 947 bytes; it
    // denotes six settings and reads in under three milliseconds, and the charge on `&a` is
    // 1,050,804. At the backstop this module used to set — the node bound, 250,000 — it was refused,
    // under a sentence telling its author they had reused an anchor too often.
    //
    // Fails with `maxAliasCount` set to anything but `-1` below about a million.
    const warm = (name: string, times: number): string =>
      `w_${name}: [${Array.from({ length: times }, () => `*${name}`).join(',')}]`;
    const document = [
      'c: &c 1',
      warm('c', 100),
      'b: &b [*c]',
      warm('b', 100),
      'a: &a [*b]',
      `x: [${Array.from({ length: 100 }, () => '*a').join(',')}]`,
      '',
    ].join('\n');
    expect(document.length).toBeLessThan(1024);
    const started = process.hrtime.bigint();
    const result = parseThemeDocument(document);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries.map((entry) => entry.key)).toEqual(['c', 'w_c', 'b', 'w_b', 'a', 'x']);
    expectWithinBudget(elapsedMs, 500);
  });

  it.each([
    [
      'writes collection keys and sets no anchors',
      `${Array.from({ length: 20_000 }, (_unused, index) => `d${index}:\n  ? [${index}]\n  : 1`).join('\n')}\n`,
    ],
    [
      'sets anchors and writes no collection key',
      `${Array.from({ length: 30_000 }, (_unused, index) => `a${index}: &a${index} 1`).join('\n')}\n`,
    ],
  ])('still reads a document that %s', (_label, document) => {
    // The other side of the bound, and what makes it a charge on the product rather than on either
    // half. Neither of these is expensive — 0.45 seconds for 486 KB of collection keys and 0.35 for
    // 506 KB of anchors, against 5.6 seconds for the 505 KB holding both — so refusing either would
    // be refusing a document that costs no more than any other of its size.
    expect(document.length).toBeLessThanOrEqual(512 * 1024);
    const started = process.hrtime.bigint();
    const result = parseThemeDocument(document);
    expect(result.ok).toBe(true);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // Headroom sized for slower developer hardware (CI parses this in under half a second): the
    // budget only has to stay far below the cost of refusing a document, which is the real guard.
    expectWithinBudget(elapsedMs, 6000);
  });

  it('still reads the rest of a theme that writes one key as a list', () => {
    // The reason this is a charge rather than a refusal, and it is the EXPORT that decides it. A
    // top-level collection key raises `NoMethodError` out of the gem's `process_entry`, but a NESTED
    // one it reads: `d0:\n  ? [1, 2]\n  : v` loads as the setting `d0_[1, 2]`. No descriptor claims a
    // key with brackets in it, so that setting is inert in both readers — but the theme AROUND it is
    // one the export applies in full, and a preview that refused the document over one such key would
    // show the default page while the PDF showed the author's.
    const result = parseThemeDocument('base:\n  font_size: 17\nd0:\n  ? [1, 2]\n  : v\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries.map((entry) => entry.key)).toContain('base_font_size');
  });

  it.each([
    ['a list', '? [1, 2]\n: v\n'],
    ['a mapping', '? {a: 1}\n: v\n'],
    ['an empty list, which is a list all the same', '? []\n: v\n'],
    ['an empty mapping', '? {}\n: v\n'],
    ['an alias naming a list set earlier', 'a: &k [1, 2]\n? *k\n: v\n'],
    ['one carried to the top level by a merge', 'c: &c\n  ? [1, 2]\n  : v\n<<: *c\n'],
    ['one written beside settings the theme really sets', 'base:\n  font_size: 20\n? [1, 2]\n: v\n'],
  ])('refuses the whole document over a TOP-LEVEL key written as %s', (_label, text) => {
    // The other half of the same key, and a third mechanism: an Array and a Hash both HAVE `include?`,
    // so the normalisation at `theme_loader.rb:132` lets them through and `key.start_with?` four lines
    // on does not. Measured against the vendored gem under ruby 3.3.3, every document here raises
    // `undefined method 'start_with?' for an instance of Array` or `… of Hash` — including the merged
    // one, which is why the check follows a merge into the root the way the loader is handed it.
    //
    // All seven were read: the first as a setting named `[ 1, 2 ]`, the last as that beside
    // `base_font_size: 20`, previewing 20 pt for a page the export prints at the default 10.5 with
    // every setting thrown away.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe(
      'A key in the theme document is written as a list or a mapping, and a theme names its settings with text.',
    );
  });

  it.each([
    ['a sequence of aliases', 'a: &a {x: 1}\nb: &b\n  ? [1, 2]\n  : v\n<<: [*a, *b]\n'],
    ['a sequence whose FIRST element holds it', 'a: &a\n  ? [1, 2]\n  : v\nb: &b {y: 2}\n<<: [*a, *b]\n'],
  ])('refuses the whole document over a collection key merged into the root by %s', (_label, text) => {
    // The sequence form of the merge, which folds every element into the root and so puts every
    // element's keys where the loader raises on one. Measured against the vendored gem under ruby
    // 3.3.3, both raise `undefined method 'start_with?' for an instance of Array` — the second one
    // says the fold is over the whole sequence rather than up to the first mapping it can use.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe(
      'A key in the theme document is written as a list or a mapping, and a theme names its settings with text.',
    );
  });

  it.each([
    ['a sequence of aliases naming ordinary mappings', 'a: &a {x: 1}\nb: &b {y: 2}\n<<: [*a, *b]\n', 'x'],
    ['a sequence written out', '<<: [{x: 1}, {y: 2}]\n', 'x'],
    ['a sequence one of whose elements is not a mapping', 'a: &a {x: 1}\n<<: [*a, 42]\n', '<<'],
    ['an alias naming a sequence, which is not a merge at all', 's: &s [1, 2]\n<<: *s\n', '<<'],
  ])('still reads a root merge written as %s', (_label, text, expected) => {
    // The other side of following a merge into the root: every source it can have, none of them
    // holding a key the loader raises on. Measured under ruby 3.3.3, in order: `{x: 1, y: 2}` merged
    // in, the same for the inline form, `<<` kept as an ordinary setting holding the whole sequence
    // (`Hash#merge!` raises on `42` and the rescue keeps the key), and the same for an alias naming a
    // sequence, which `revive_hash` never treats as a merge.
    expect(Object.keys(entriesOf(text))).toContain(expected);
  });

  it.each([
    ['under a parent, where the loader interpolates it', 'd0:\n  ? [1, 2]\n  : v\n', 'd0_[ 1, 2 ]'],
    ['under a parent, written as a mapping', 'd0:\n  ? {a: 1}\n  : v\n', 'd0_{ a: 1 }'],
    [
      'named by an alias, under a parent',
      'a: &k [1, 2]\nd0:\n  ? *k\n  : v\n',
      'd0_*k',
    ],
    [
      'merged into a parent that is not the root',
      'c: &c\n  ? [1, 2]\n  : v\nrole:\n  <<: *c\n',
      'role_1,2',
    ],
  ])('still reads a collection key written %s', (_label, text, expected) => {
    // The line the refusal above is drawn at, asserted from the side that must keep working. The gem
    // never reaches `start_with?` on any of these: a nested key is interpolated into the flat name it
    // recurses with, so `d0:\n  ? [1, 2]\n  : v` loads as `d0_[1, 2]`, `? {a: 1}` as
    // `d0_{"a"=>1}`, and the merged one as `c_[1, 2]` and `role_[1, 2]` — all measured under ruby
    // 3.3.3. Each is an inert setting no descriptor claims, and refusing the document over one would
    // show the default page for a theme the export applies in full.
    //
    // The two readers spell such a name differently — `[ 1, 2 ]` against `[1, 2]`, `role_1,2` for the
    // copy a merge materialises through a `Map`, and `d0_*k` where the gem resolves the alias and
    // writes `d0_[1, 2]` — which is a difference in how a collection is rendered into a flat name and
    // not in what is read. Every one of these names is inert on both sides, which is why the assertion
    // is that the setting LANDS rather than what it is called.
    const warned = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      expect(Object.keys(entriesOf(text))).toContain(expected);
    } finally {
      warned.mockRestore();
    }
  });
});

/**
 * What an alias costs to RESOLVE, which is not what it costs to materialise.
 *
 * The expansion budget measures what a document denotes. An alias to a one-node scalar denotes one
 * node and no key text, and that is the truth about it — but the reader still has to work out what it
 * names, and `Alias.resolve` answers by scanning the document's alias and anchor nodes from the start,
 * once per dereference. Cost is therefore quadratic in the number of aliases a document WRITES, in a
 * dimension neither half of the budget can see, and raising `maxAliasCount` off its default removed
 * the only bound that had incidentally stopped it. The two tests below are the two halves of that: one
 * says the scan does not happen, and one says the reading agrees with the scan it replaced.
 */
describe('resolving the aliases a document writes', () => {
  it('never asks the parser to search the document for an anchor', () => {
    // The scale-free half, and the one that states the property rather than a symptom: every entry
    // into `Alias.resolve` is a walk of the whole document, so any count that grows with the number of
    // aliases is quadratic however fast the machine is. Zero is the only count that is not.
    //
    // Fails without the resolution installed up front: `Alias.toJSON` calls `resolve` on every
    // dereference and `addMergeToJSMap` on every merge, so this is 24,000 rather than 0 — and 20.1
    // seconds rather than 0.20 for the document in the next test, on the thread the preview renders
    // on.
    const resolve = jest.spyOn(Alias.prototype, 'resolve');
    try {
      // Every route the reader resolves by is in here: a plain value, a merge source — which
      // `addMergeToJSMap` resolves without going through `Alias.toJSON` at all — and a flow sequence.
      const document = [
        'brand: &brand 2A5DB0',
        'pair: &pair {font-style: bold}',
        'role:',
        ...Array.from(
          { length: 2000 },
          (_unused, index) => `  r${index}:\n    <<: *pair\n    font-color: *brand`,
        ),
        `wide: [${Array.from({ length: 20_000 }, () => '*brand').join(',')}]`,
        '',
      ].join('\n');
      const result = parseThemeDocument(document);
      expect(result.ok).toBe(true);
      // The COUNT rather than the spy: `toHaveBeenCalled` prints the arguments of every call it saw,
      // and the argument here is the whole document. Failing this assertion should not print 24,000
      // copies of a syntax tree.
      expect(resolve.mock.calls.length).toBe(0);
    } finally {
      resolve.mockRestore();
    }
  });

  it('reads a document written almost entirely from aliases in the time a keystroke has', () => {
    // The coarse half, kept because it survives the parser resolving aliases some way that does not
    // go through `Alias.resolve` at all — at which point the assertion above would pass and the tab
    // would still freeze. Three bytes an alias in a flow sequence, so this is 180 KB of theme: an
    // ordinary project file, which any collaborator with write access can commit.
    //
    // The ceiling is two orders of magnitude off the measurement it guards rather than a tight
    // budget: 20.1 seconds before, 0.20 after. It is here to catch a quadratic coming back, and a
    // quadratic is never a near miss.
    const document = `t: &t 1\nx: [${Array.from({ length: 60_000 }, () => '*t').join(',')}]\n`;
    const started = process.hrtime.bigint();
    const result = parseThemeDocument(document);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries.map((entry) => entry.key)).toEqual(['t', 'x']);
    expectWithinBudget(elapsedMs, 5000);
  });

  it.each([
    [
      'the LAST anchor of that name set before it, not the first',
      'a: &t 1\nb: &t 2\nc: *t\n',
      { a: 1, b: 2, c: 2 },
    ],
    [
      'the anchor in force where the alias is written, not where the document ends',
      'a: &t 1\nc: *t\nb: &t 2\nd: *t\n',
      { a: 1, c: 1, b: 2, d: 2 },
    ],
    [
      'an anchor set on a nested node, which is in scope for the whole document',
      'a:\n  b: &t 5\nc: *t\n',
      { a_b: 5, c: 5 },
    ],
    [
      'a mapping, whose entries the alias brings with it',
      'a: &t {x: 1, y: 2}\nb: *t\n',
      { a_x: 1, a_y: 2, b_x: 1, b_y: 2 },
    ],
    [
      'a merge source, where the key written AFTER the merge wins',
      'a: &t {x: 1, y: 2}\nb:\n  <<: *t\n  y: 9\n',
      { a_x: 1, a_y: 2, b_x: 1, b_y: 9 },
    ],
    [
      'each source of a merged sequence of aliases',
      'p: &p {x: 1}\nq: &q {y: 2}\nb:\n  <<: [*p, *q]\n',
      { p_x: 1, q_y: 2, b_x: 1, b_y: 2 },
    ],
  ])('resolves an alias to %s', (_label, text, expected) => {
    // Not a restatement of the parser's behaviour for its own sake. This module works out what every
    // alias names in one ordered pass, for the budget, and now hands that answer to the reader in
    // place of the search — so the rule it applies decides a VALUE in the theme and no longer only a
    // price. A document whose answer differs between the two rules is read wrongly and in silence,
    // which is why the cases here are the ones where the rule is doing work: a name bound twice, an
    // alias between the two bindings, and the two paths — `Alias.toJSON` and `addMergeToJSMap` — that
    // resolve by different routes inside the parser.
    expect(entriesOf(text)).toEqual(expected);
  });

  it('still fails an alias that names an anchor not set before it', () => {
    // The alias this module has no answer for keeps the parser's own search, which is what reports it.
    // Installing a resolution for every alias would have made this document read as though the alias
    // were absent.
    const result = parseThemeDocument('a: 1\nb: *nope\nc: &nope 2\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/not set before it/);
  });
});


describe('the merge key, resolved the way the export resolves it', () => {
  // Every expectation below was MEASURED, not reasoned about: each document was written to a file and
  // loaded with `Asciidoctor::PDF::ThemeLoader.load_theme` against the vendored gem
  // (asciidoctor-pdf 2.3.24, Psych on ruby 3.3.3), and the flat settings it returned are what is
  // asserted here. The rule they describe is one line of `psych/visitors/to_ruby.rb`:
  //
  //   * a mapping's pairs are applied in document order and the LAST write wins;
  //   * a merge is `hash.merge!`, which is the writes its source would make, so it REPLACES what the
  //     mapping already holds rather than filling in around it;
  //   * the sequence form is folded back to front first (`val.reverse_each`), so the earliest element
  //     wins inside the fold, and the fold as a whole still replaces;
  //   * a merge value that is not a mapping raises `TypeError` and the rescue keeps `<<` as an
  //     ordinary key, so the rest of the theme still loads;
  //   * and the key merges unless it is tagged `!!str` — the quoting is not the test.
  //
  // The parser this module reads with implements a different rule in three of those five places, and
  // the difference is a wrong VALUE rather than a wrong message: `base: {font-size: 9, <<: *common}`
  // with `*common` at 17 printed at 17 pt and previewed at 9 pt.
  it.each([
    [
      'replaces a key the mapping already set, which is what `hash.merge!` does',
      'common: &common\n  font_size: 17\nbase:\n  font_size: 9\n  <<: *common\n',
      { common_font_size: 17, base_font_size: 17 },
    ],
    [
      'is itself replaced by a key written after it',
      'common: &common\n  font_size: 17\nbase:\n  <<: *common\n  font_size: 9\n',
      { common_font_size: 17, base_font_size: 9 },
    ],
    [
      'loses to the LATER of two merge keys',
      'a: &a\n  font_size: 1\nb: &b\n  font_size: 2\nbase:\n  <<: *a\n  <<: *b\n',
      { a_font_size: 1, b_font_size: 2, base_font_size: 2 },
    ],
    [
      'loses to the later one whichever anchor that is',
      'a: &a\n  font_size: 1\nb: &b\n  font_size: 2\nbase:\n  <<: *b\n  <<: *a\n',
      { a_font_size: 1, b_font_size: 2, base_font_size: 1 },
    ],
    [
      'takes the EARLIEST element of a merged sequence',
      'a: &a\n  font_size: 1\nb: &b\n  font_size: 2\nbase:\n  <<: [*a, *b]\n',
      { a_font_size: 1, b_font_size: 2, base_font_size: 1 },
    ],
    [
      'takes the earliest element whichever anchor that is',
      'a: &a\n  font_size: 1\nb: &b\n  font_size: 2\nbase:\n  <<: [*b, *a]\n',
      { a_font_size: 1, b_font_size: 2, base_font_size: 2 },
    ],
    [
      'replaces a key already set, in the sequence form too',
      'a: &a\n  font_size: 1\nb: &b\n  font_size: 2\nbase:\n  font_size: 9\n  <<: [*a, *b]\n',
      { a_font_size: 1, b_font_size: 2, base_font_size: 1 },
    ],
    [
      'copies a source whose own merge lost to its own later key',
      'inner: &inner\n  font_size: 21\nouter: &outer\n  <<: *inner\n  font_size: 22\nbase:\n  font_size: 9\n  <<: *outer\n',
      { inner_font_size: 21, outer_font_size: 22, base_font_size: 22 },
    ],
    [
      'copies a source whose own merge replaced its own earlier key',
      'inner: &inner\n  font_size: 21\nouter: &outer\n  font_size: 22\n  <<: *inner\nbase:\n  font_size: 9\n  <<: *outer\n',
      { inner_font_size: 21, outer_font_size: 21, base_font_size: 21 },
    ],
    [
      'replaces a key already set when the source is written inline',
      'base:\n  font_size: 9\n  <<: {font_size: 17}\n',
      { base_font_size: 17 },
    ],
    [
      'replaces a key whose value was itself an alias',
      'size: &size 33\ncommon: &common\n  font_size: 17\nbase:\n  font_size: *size\n  <<: *common\n',
      { size: 33, common_font_size: 17, base_font_size: 17 },
    ],
    [
      'replaces a whole nested mapping rather than merging into it',
      'common: &common\n  sub:\n    b: 2\nbase:\n  sub:\n    a: 1\n  <<: *common\n',
      { common_sub_b: 2, base_sub_b: 2 },
    ],
    [
      'follows a chain of merged anchors to the value the last of them sets',
      'l0: &l0\n  font_size: 1\nl1: &l1\n  <<: *l0\n  font_size: 2\nl2: &l2\n  <<: *l1\n  font_size: 3\nbase:\n  font_size: 9\n  <<: *l2\n',
      { l0_font_size: 1, l1_font_size: 2, l2_font_size: 3, base_font_size: 3 },
    ],
    [
      'leaves a key the source does not set alone',
      'common: &common\n  zzz: 1\n  font_size: 17\nbase:\n  font_size: 9\n  aaa: 2\n  <<: *common\n',
      { common_zzz: 1, common_font_size: 17, base_font_size: 17, base_aaa: 2, base_zzz: 1 },
    ],
    [
      'takes a key only the later sequence element sets',
      'a: &a\n  other: 1\nb: &b\n  font_size: 2\nbase:\n  font_size: 9\n  <<: [*a, *b]\n',
      { a_other: 1, b_font_size: 2, base_font_size: 2, base_other: 1 },
    ],
    [
      'applies three merge keys in the order they are written',
      'a: &a\n  f: 1\nb: &b\n  f: 2\nd: &d\n  f: 3\nbase:\n  <<: *a\n  <<: *b\n  <<: *d\n',
      { a_f: 1, b_f: 2, d_f: 3, base_f: 3 },
    ],
    [
      'lets a merge written after an explicit key replace it',
      'a: &a\n  f: 1\nb: &b\n  f: 2\nbase:\n  <<: *a\n  f: 9\n  <<: *b\n',
      { a_f: 1, b_f: 2, base_f: 2 },
    ],
    [
      'leaves an explicit key standing when the merge after it sets another',
      'a: &a\n  f: 1\nb: &b\n  g: 2\nbase:\n  <<: *a\n  f: 9\n  <<: *b\n',
      { a_f: 1, b_g: 2, base_f: 9, base_g: 2 },
    ],
    [
      'replaces from the first of two merges when the second sets nothing else',
      'a: &a\n  font_size: 1\nb: &b\n  other: 2\nbase:\n  font_size: 9\n  <<: *a\n  <<: *b\n',
      { a_font_size: 1, b_other: 2, base_font_size: 1, base_other: 2 },
    ],
    [
      'resolves a merge inside a source reached through a sequence',
      'x: &x\n  font_size: 1\ny: &y\n  <<: *x\n  other: 7\nbase:\n  font_size: 9\n  <<: [*y]\n',
      { x_font_size: 1, y_font_size: 1, y_other: 7, base_font_size: 1, base_other: 7 },
    ],
    [
      'merges a sequence of one',
      'a: &a\n  font_size: 1\nbase:\n  font_size: 9\n  <<: [*a]\n',
      { a_font_size: 1, base_font_size: 1 },
    ],
    [
      'applies two sequence merges in the order they are written',
      'a: &a\n  f: 1\nb: &b\n  f: 2\nd: &d\n  f: 3\nbase:\n  <<: [*a, *b]\n  <<: [*d]\n',
      { a_f: 1, b_f: 2, d_f: 3, base_f: 3 },
    ],
    [
      'applies under a nested mapping the same way',
      'a: &a\n  size: 1\nbase:\n  sub:\n    size: 9\n    <<: *a\n',
      { a_size: 1, base_sub_size: 1 },
    ],
    [
      'copies a source reached by an alias whose target merged another',
      'a: &a\n  f: 1\nb: &b\n  <<: *a\n  g: 2\nbase:\n  f: 9\n  <<: *b\n',
      { a_f: 1, b_f: 1, b_g: 2, base_f: 1, base_g: 2 },
    ],
    [
      'replaces one key and loses another to the key after it',
      'a: &a\n  f: 1\n  g: 1\nbase:\n  f: 9\n  <<: *a\n  g: 9\n',
      { a_f: 1, a_g: 1, base_f: 1, base_g: 9 },
    ],
    [
      'merges an anchor whose mapping is a setting of its own',
      'base: &base\n  font_size: 9\nother:\n  <<: *base\n  font_size: 3\n',
      { base_font_size: 9, other_font_size: 3 },
    ],
    [
      'changes nothing when the source is empty',
      'a: &a {}\nbase:\n  font_size: 9\n  <<: *a\n',
      { base_font_size: 9 },
    ],
    [
      'changes nothing when the sequence is empty',
      'base:\n  font_size: 9\n  <<: []\n',
      { base_font_size: 9 },
    ],
    [
      'changes nothing when the source is an empty inline mapping',
      'base:\n  font_size: 9\n  <<: {}\n',
      { base_font_size: 9 },
    ],
    [
      'keeps `<<` as a key when the value is a scalar',
      'base:\n  font_size: 9\n  <<: 42\n',
      { base_font_size: 9, 'base_<<': 42 },
    ],
    [
      'keeps `<<` as a key when the value is empty',
      'base:\n  font_size: 9\n  <<:\n',
      { base_font_size: 9, 'base_<<': null },
    ],
    [
      'keeps `<<` as a key when a sequence element is not a mapping',
      'a: &a\n  font_size: 1\nbase:\n  font_size: 9\n  <<: [*a, 42]\n',
      { a_font_size: 1, base_font_size: 9, 'base_<<': [{"font_size":1},42] },
    ],
    [
      'keeps `<<` as a key when a sequence element is null',
      'a: &a\n  font_size: 1\nbase:\n  font_size: 9\n  <<: [*a, ~]\n',
      { a_font_size: 1, base_font_size: 9, 'base_<<': [{"font_size":1},null] },
    ],
    [
      'keeps `<<` as a key when the alias names a sequence',
      'seq: &seq [1, 2]\nbase:\n  font_size: 9\n  <<: *seq\n',
      { seq: [1,2], base_font_size: 9, 'base_<<': [1,2] },
    ],
    [
      'keeps `<<` as a key when the alias names a sequence OF mappings',
      'a: &a\n  font_size: 1\nb: &b\n  other: 2\nseq: &seq [*a, *b]\nbase:\n  font_size: 9\n  <<: *seq\n',
      { a_font_size: 1, b_other: 2, seq: [{"font_size":1},{"other":2}], base_font_size: 9, 'base_<<': [{"font_size":1},{"other":2}] },
    ],
    [
      'keeps `<<` as a key when the sequence holds a sequence',
      'a: &a\n  font_size: 1\nb: &b\n  font_size: 2\nbase:\n  <<: [[*a, *b]]\n',
      { a_font_size: 1, b_font_size: 2, 'base_<<': [[{"font_size":1},{"font_size":2}]] },
    ],
    [
      'merges a double-quoted `<<`, which carries no tag',
      'common: &common\n  font_size: 17\nbase:\n  font_size: 9\n  "<<": *common\n',
      { common_font_size: 17, base_font_size: 17 },
    ],
    [
      'merges a folded `<<`, which carries no tag either',
      'common: &common\n  font_size: 17\nbase:\n  font_size: 9\n  ? >-\n    <<\n  : *common\n',
      { common_font_size: 17, base_font_size: 17 },
    ],
    [
      'merges every spelling but the one tagged `!!str`',
      'w: &w\n  w: 1\nx: &x\n  x: 1\ny: &y\n  y: 1\nz: &z\n  z: 1\nbase:\n  a: 1\n  <<: *w\n  "<<": *x\n  \'<<\': *y\n  !!str "<<": *z\n',
      { w_w: 1, x_x: 1, y_y: 1, z_z: 1, base_a: 1, base_w: 1, base_x: 1, base_y: 1, 'base_<<_z': 1 },
    ],
    [
      'leaves a `<<` tagged `!!str` an ordinary key',
      'common: &common\n  font_size: 17\nbase:\n  font_size: 9\n  !!str \'<<\': *common\n',
      { common_font_size: 17, base_font_size: 9, 'base_<<_font_size': 17 },
    ],
  ])('%s', (_label, text, expected) => {
    expect(entriesOf(text)).toEqual(expected);
  });

  /**
   * A merge whose source ENCLOSES it, which the module refused whole and the export reads in full.
   *
   * `revive_hash` registers an anchor against its Hash before it fills it
   * (`psych/visitors/to_ruby.rb:344-350`), so a merge reached from inside that mapping copies the
   * entries written above the pair it sits under — a finite prefix, and one that is already complete,
   * since the reader finishes each pair's value before it starts the next. Nothing about it is
   * unbounded, and every row here loads in the vendored gem under ruby 3.3.3, with exactly the
   * settings asserted.
   *
   * What the preview did instead was refuse the document — `themeApplied: false`, the default page,
   * and a sentence saying the document expands its aliases into far more content than it is written
   * from, about a document denoting ten nodes. That is the outcome the whole of this file's
   * over-refusal reasoning is against, and it was reached by one branch that could not tell a merge
   * to an ancestor from a VALUE naming one — which does not terminate, and is still refused.
   */
  it.each([
    [
      'specialises a level from the category’s own defaults, which is the idiom',
      "heading: &heading\n  font_color: '333333'\n  font_style: bold\n  h2:\n    <<: *heading\n    font_size: 20\n",
      {
        heading_font_color: '333333',
        heading_font_style: 'bold',
        heading_h2_font_color: '333333',
        heading_h2_font_style: 'bold',
        heading_h2_font_size: 20,
      },
    ],
    [
      'copies the keys written above the pair the merge sits under, and no others',
      'x: &x\n  k: 1\n  y:\n    <<: *x\n',
      { x_k: 1, x_y_k: 1 },
    ],
    [
      'copies nothing when the merge is written above every other key',
      'x: &x\n  y:\n    <<: *x\n  k: 1\n',
      { x_k: 1 },
    ],
    [
      'copies nothing when the enclosing mapping has written nothing yet',
      'a: &a\n  y:\n    <<: *a\n',
      {},
    ],
    [
      'is a no-op when a mapping merges itself after setting a key',
      'base: &b\n  font_size: 17\n  <<: *b\n',
      { base_font_size: 17 },
    ],
    [
      'is a no-op when a mapping merges itself before setting a key',
      'a: &a\n  <<: *a\n  b: 1\n',
      { a_b: 1 },
    ],
    [
      'is the same no-op in the sequence spelling',
      'base: &b\n  font_size: 17\n  <<: [*b]\n',
      { base_font_size: 17 },
    ],
    [
      'copies the prefix of a GRANDPARENT, not of the nearest mapping',
      'a: &a\n  p: 1\n  b:\n    q: 2\n    c:\n      <<: *a\n  r: 3\n',
      { a_p: 1, a_b_q: 2, a_b_c_p: 1, a_r: 3 },
    ],
    [
      'copies the prefix of the ROOT when the root is what carries the anchor',
      '--- &root\np: 1\nq:\n  <<: *root\n',
      { p: 1, q_p: 1 },
    ],
    [
      'copies a prefix that a merge of its own had filled in',
      'big: &big\n  z: 9\na: &a\n  <<: *big\n  y:\n    <<: *a\n',
      { big_z: 9, a_z: 9, a_y_z: 9 },
    ],
    [
      'copies the prefix each merge has, when one mapping holds two of them',
      'a: &a\n  m:\n    <<: *a\n  n: 1\n  b:\n    <<: *a\n',
      { a_n: 1, a_b_n: 1 },
    ],
    [
      'accumulates the earlier siblings’ own copies, which is what makes this cost',
      'a: &a\n  k: 1\n  s1:\n    <<: *a\n  s2:\n    <<: *a\n',
      { a_k: 1, a_s1_k: 1, a_s2_k: 1, a_s2_s1_k: 1 },
    ],
    [
      'is still replaced by a key written after it',
      'a: &a\n  k: 1\n  y:\n    <<: *a\n    k: 5\n',
      { a_k: 1, a_y_k: 5 },
    ],
    [
      'still replaces a key written before it',
      'a: &a\n  k: 1\n  y:\n    k: 5\n    <<: *a\n',
      { a_k: 1, a_y_k: 1 },
    ],
    [
      'folds an enclosing source together with an ordinary one',
      'big: &big\n  z: 9\na: &a\n  k: 1\n  y:\n    <<: [*a, *big]\n',
      { big_z: 9, a_k: 1, a_y_z: 9, a_y_k: 1 },
    ],
    [
      'leaves the mapping it filled complete for a later alias to name',
      'a: &a\n  k: 1\n  y:\n    <<: *a\nz: *a\n',
      { a_k: 1, a_y_k: 1, z_k: 1, z_y_k: 1 },
    ],
    [
      'leaves it complete for a later merge that does not enclose it, too',
      'a: &a\n  k: 1\n  y:\n    <<: *a\nz:\n  <<: *a\n',
      { a_k: 1, a_y_k: 1, z_k: 1, z_y_k: 1 },
    ],
  ])('merges an enclosing anchor as the export does: %s', (_label, text, expected) => {
    expect(entriesOf(text)).toEqual(expected);
  });

  it('reads a fold that never happens over an enclosing source, as the prefix', () => {
    // The one row above where the value diverges, and it is the only value it CAN take. One element
    // that is not a mapping makes `h.merge!` raise and the rescue keeps `<<` holding the whole
    // sequence — with the enclosing mapping's own Hash in it. Measured against the vendored gem
    // under ruby 3.3.3, this document loads, storing `a_k => 1` and `a_y_<<` as a list that contains
    // itself. Nothing on this side holds a value that contains itself, so `<<` holds the prefix the
    // merge would have copied; the difference is a `<<` setting no theme reads, and the document is
    // read either way, which is what refusing it was not.
    expect(entriesOf('a: &a\n  k: 1\n  y:\n    <<: [*a, 5]\n')).toEqual({
      a_k: 1,
      'a_y_<<': [{ k: 1 }, 5],
    });
  });

  it('leaves the settings in the order the export leaves them in', () => {
    // `Hash#merge!` REPLACES in place: a key the merge overwrites keeps the position it was written
    // at, and only the keys the merge adds are appended. Order is not decoration here — the export
    // resolves a `$variable` against the settings loaded before it, so a document read in another
    // order resolves to other values.
    const result = parseThemeDocument('common: &common\n  zzz: 1\n  font_size: 17\nbase:\n  font_size: 9\n  aaa: 2\n  <<: *common\n');
    if (!result.ok) throw new Error('expected the document to parse');
    expect(result.theme.entries.map((entry) => entry.key)).toEqual([
      'common_zzz',
      'common_font_size',
      'base_font_size',
      'base_aaa',
      'base_zzz',
    ]);
  });

  it('reports the anchor rather than the merge when a merge source names nothing', () => {
    // `revive_hash` materialises the value before it decides anything, so `Psych::AnchorNotDefined`
    // is what this document raises in the export. Reading the failure as "merge sources must be maps"
    // told the author about the wrong half of a line they can fix.
    const result = parseThemeDocument('base:\n  <<: *later\nlater: &later\n  font_size: 5\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/not set before it/);
  });

  it('keeps `<<` as a key when the flow form gives it no value at all', () => {
    // `{<<}` is the one spelling that leaves the merge pair a JavaScript `null` rather than an empty
    // scalar node, so it is the one that reaches the branch materialising a value that is not a node.
    // Measured: the export loads it as a `<<` setting holding nothing.
    expect(entriesOf('base: {<<}\n')).toEqual({ 'base_<<': null });
    expect(entriesOf('base:\n  ? <<\n')).toEqual({ 'base_<<': null });
  });

  it('copies a key the reader cannot key an object by, under the name it gives it', () => {
    // A merge source is materialised into a `Map`, whose keys are values — a list written as a key is
    // an actual array here, and naming a property by it converts it. The export reaches this too and
    // spells the name differently (`a_[1, 2]` against `a_[ 1, 2 ]` for the key the document writes,
    // and `base_[1, 2]` against `base_1,2` for the copy), which is a difference in how each side
    // renders a collection into a flat name and not in what merges. Neither setting is claimed by any
    // descriptor, so both are inert; what is asserted here is that the copy HAPPENS and lands
    // somewhere, which is what the merge is responsible for.
    const warned = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      expect(entriesOf('a: &a\n  ? [1, 2]\n  : v\nbase:\n  <<: *a\n')).toEqual({
        'a_[ 1, 2 ]': 'v',
        'base_1,2': 'v',
      });
    } finally {
      warned.mockRestore();
    }
  });

  it('does not call two merge keys one key written twice, because the export does not', () => {
    // A plain `<<` is a symbol of its own to the parser, so no two of them were ever equal and this
    // held by accident. A quoted one is the string `<<` every time, and now merges too.
    expect(entriesOf('a: &a {f: 1}\nb: &b {f: 2}\nbase:\n  "<<": *a\n  "<<": *b\n')).toEqual({
      a_f: 1,
      b_f: 2,
      base_f: 2,
    });
  });
});

/**
 * How far into an admonition icon the loader reads, which is one level and not the whole subtree.
 *
 * `process_entry`'s admonition branch (`theme_loader.rb:161-166`) is reached by `key.start_with?` on
 * the flat name the loader has BUILT, so it fires at whatever depth the composition arrives at; it is
 * reached BEFORE the general `::Hash === val` branch, so it replaces the descent; and what it then
 * does is fold each immediate subkey and hand the value to `evaluate`, which returns a Hash untouched.
 * This module flattened straight past all three of those, so it minted settings the export has no name
 * for, folded hyphens the export keeps, expanded references the export leaves as text, and refused
 * five spellings of the branch the export reads without complaint.
 */
describe('the reach of an admonition icon', () => {
  it.each([
    ['a word', 'admonition_icon_tip: hello\n'],
    ['a number', 'admonition_icon_tip: 5\n'],
    ['a fractional number', 'admonition_icon_tip: 5.5\n'],
    ['a word Psych reads as true', 'admonition_icon_tip: true\n'],
    ['a word, under an icon named through the composed spelling', 'admonition:\n  icon_tip: hello\n'],
    ['a word, under an icon name nothing claims', 'admonition_icon_zzz: hello\n'],
    ['a word, under the bare prefix', 'admonition_icon_: hello\n'],
    ['a word, beside settings the theme really sets', 'base:\n  font_size: 20\nadmonition_icon_tip: 5\n'],
  ])('refuses the whole document over an admonition icon set to %s', (_label, text) => {
    // `val.each do |key2, val2| … end if val` is the whole branch, and `each` is the whole of what it
    // requires of the value. Measured against the vendored gem under ruby 3.3.3, every document here
    // raises `undefined method 'each'` — for a String, an Integer, a Float and `true` in turn — which
    // `converter.rb:556`'s bare rescue turns into the default theme, exactly as a date does.
    //
    // All eight were read: `admonition_icon_tip: "hello"` and the rest, each an inert setting beside
    // every other setting in the document. The last previewed body text at 20 pt for a page the export
    // prints at 10.5.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe(
      'An admonition icon in the theme document is set to one value where a group of icon properties was expected, so none of the document is read.',
    );
  });

  it.each([
    ['written with nothing after it', 'admonition_icon_tip:\nbase:\n  font_size: 20\n'],
    ['written as a null', 'admonition_icon_tip: ~\nbase:\n  font_size: 20\n'],
    ['written as false', 'admonition_icon_tip: false\nbase:\n  font_size: 20\n'],
  ])('reads a document whose admonition icon is %s, and sets nothing for it', (_label, text) => {
    // The `if val` at the end of the branch guards the WHOLE of it, so these three raise nothing and
    // set nothing either. Measured under ruby 3.3.3: all three load a theme with no
    // `admonition_icon_tip` key in it at all, beside `base_font_size => 20`. This module set one — to
    // `null` and to `false` — which is a key the export does not have.
    expect(entriesOf(text)).toEqual({ base_font_size: 20 });
  });

  it.each([
    [
      'the composed spelling',
      'admonition:\n  icon_tip:\n    stroke-color: FF0000\n    a:\n      my-key: 5\n',
      'admonition_icon_tip',
    ],
    [
      'a composition that splits the prefix itself',
      'admonition_icon:\n  tip:\n    stroke-color: FF0000\n    a:\n      my-key: 5\n',
      'admonition_icon_tip',
    ],
    [
      'a hyphen in the icon name, which the loader folds before it tests the prefix',
      'admonition:\n  icon-tip:\n    stroke-color: FF0000\n    a:\n      my-key: 5\n',
      'admonition_icon_tip',
    ],
    [
      'a composition that lands the underscore in the middle',
      'admonition:\n  icon:\n    _tip:\n      stroke-color: FF0000\n      a:\n        my-key: 5\n',
      'admonition_icon__tip',
    ],
  ])('reads an icon reached through %s', (_label, text, icon) => {
    // `start_with?` is asked of the name the loader has built, not of a top-level key, so all four of
    // these take the admonition branch. Measured under ruby 3.3.3: the first three load
    // `admonition_icon_tip => {stroke_color: "FF0000", a: {"my-key"=>5}}` and the fourth
    // `admonition_icon__tip`, which starts with the same sixteen characters and so takes the same
    // branch.
    //
    // Each fixture carries a property the branch reads and one it only STORES, because the two models
    // differ nowhere else: a walk that descends into every mapping arrives at the same flat name for
    // `stroke-color` and gets `a_my_key` wrong. Modelling the branch as a top-level key also REFUSED
    // all four the moment anything under them held a key the loader would not have looked at —
    // `admonition:\n  icon_tip:\n    a:\n      10: 5` was a whole-document failure here for a theme
    // the export applies in full, which is the worst direction this class of divergence runs in.
    expect(entriesOf(text)).toEqual({
      [`${icon}_stroke_color`]: 'FF0000',
      [`${icon}_a`]: { 'my-key': 5 },
    });
  });

  it('leaves an icon property that is itself a mapping as ONE setting, unread', () => {
    // `evaluate` returns a Hash untouched (`theme_loader.rb:198`), so everything below an icon's
    // property is data the loader stores and never looks at. Three things followed from descending
    // into it anyway, all measured against the vendored gem under ruby 3.3.3:
    //
    // - `my-key` keeps its hyphen there. The gem loads `{a: {"my-key"=>5}}`; this emitted
    //   `admonition_icon_tip_a_my_key`, a name the export cannot reach by any spelling.
    // - a `$reference` stays the text it is written from. The gem loads `{a: {"b"=>"$base_font_size"}}`
    //   with `base_font_size` set to 10 right above it; this emitted `admonition_icon_tip_a_b` as a
    //   setting, which the cascade then expanded to 10.
    // - the mint this module puts on a typed key travelled into the value with it, so
    //   `admonition_icon_tip_a` carried a `\0n10` — one of this module's own names, in data.
    expect(entriesOf('admonition_icon_tip:\n  a:\n    my-key: 5\n')).toEqual({
      admonition_icon_tip_a: { 'my-key': 5 },
    });
    expect(
      entriesOf('base:\n  font_size: 10\nadmonition_icon_tip:\n  a:\n    b: $base_font_size\n'),
    ).toEqual({ base_font_size: 10, admonition_icon_tip_a: { b: '$base_font_size' } });
    expect(entriesOf('admonition_icon_tip:\n  a:\n    b:\n      10: 5\n')).toEqual({
      admonition_icon_tip_a: { b: { '10': 5 } },
    });
  });

  it('sets an icon property the export sets, even where the export sets nonsense into it', () => {
    // `stroke-color` written as a mapping. The gem folds the subkey, sees `_color`, and reaches
    // `to_color` on the Hash — which sizes `{"a"=>"FF0000"}.to_s` to six characters and stores the
    // string `{"A"=>`, measured under ruby 3.3.3. So the key IS set, to something prawn then paints
    // with. Descending emitted `admonition_icon_tip_stroke_color_a` instead: a key the export has no
    // name for, with the claimed key left unset and nothing said about it.
    //
    // The value below is not the gem's `{"A"=>` — modelling `to_color` over a Hash's `inspect` is
    // pricing a shape no theme writes — but it is a value at the key the model reads, so the reader
    // rejects it and says so, where before it fell back to a default in silence.
    expect(entriesOf('admonition_icon_tip:\n  stroke-color:\n    a: FF0000\n')).toEqual({
      admonition_icon_tip_stroke_color: { a: 'FF0000' },
    });
  });

  it.each([
    [
      'a list of scalars',
      'admonition_icon_tip:\n  a: [1, 2]\n',
      { admonition_icon_tip_a: [1, 2] },
    ],
    [
      'a list holding a mapping whose key the export typed as a number',
      'admonition_icon_tip:\n  a:\n    - 10: 5\n',
      { admonition_icon_tip_a: [{ '10': 5 }] },
    ],
  ])('stores an icon property written as %s without reading into it', (_label, text, expected) => {
    // `evaluate` returns an Array by mapping `evaluate` over it and a Hash untouched, so a list under
    // a property is stored as written and its contents are never named. Measured under ruby 3.3.3:
    // `{a: [1, 2]}` and `{a: [{10=>5}]}` — the `10` is a key inside a value, so the loader neither
    // inspects it nor raises over it, and neither does this.
    expect(entriesOf(text)).toEqual(expected);
  });

  it.each([
    ['a list of names', 'admonition_icon_tip: [a, b]\n', { admonition_icon_tip_a: null, admonition_icon_tip_b: null }],
    [
      'a list of name-and-value pairs',
      'admonition_icon_tip:\n  - [name, fa-lightbulb]\n  - [stroke-color, FF0000]\n',
      { admonition_icon_tip_name: 'fa-lightbulb', admonition_icon_tip_stroke_color: 'FF0000' },
    ],
    [
      'a list whose pairs carry more than two items, of which the loader reads two',
      'admonition_icon_tip:\n  - [name, fa-lightbulb, ignored]\n',
      { admonition_icon_tip_name: 'fa-lightbulb' },
    ],
  ])('reads an admonition icon written as %s', (_label, text, expected) => {
    // `Array#each` yields one element at a time and the block destructures it, so a list is the same
    // branch by another road: an element that is itself a list is a name and a value, and a bare one
    // is a name with nothing after it. Measured under ruby 3.3.3, these load
    // `{a: nil, b: nil}`, `{name: "fa-lightbulb", stroke_color: "FF0000"}` and
    // `{name: "fa-lightbulb"}` — the hyphen folded exactly as it is for a mapping's subkey.
    expect(entriesOf(text)).toEqual(expected);
  });

  it.each([
    ['a number', 'admonition_icon_tip:\n  - [1, 2]\n', 'a number, a boolean or nothing at all'],
    ['nothing at all', 'admonition_icon_tip:\n  - ~\n', 'a number, a boolean or nothing at all'],
    ['a word Psych reads as true', 'admonition_icon_tip:\n  - true\n', 'a number, a boolean or nothing at all'],
    ['a mapping', 'admonition_icon_tip:\n  - {a: 1}\n', 'a list or a mapping'],
    ['a list', 'admonition_icon_tip:\n  - [[1, 2], 3]\n', 'a list or a mapping'],
  ])('refuses the whole document over a list element the loader names a property by: %s', (_label, text, shape) => {
    // The element becomes the property's own name — `accum[key2.to_sym]` — so it meets exactly the
    // methods a KEY meets, and fails on exactly the same ones. Measured under ruby 3.3.3:
    // `- [1, 2]` raises `undefined method 'include?' for an instance of Integer`, `- ~` and `- true`
    // the same for nil and true, and `- {a: 1}` and `- [[1, 2], 3]` raise
    // `undefined method 'to_sym' for an instance of Hash` and `… of Array`. All five were read here as
    // one inert `admonition_icon_tip` setting holding the list.
    const result = parseThemeDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain(shape);
  });
});

/**
 * What the font catalogue does with a style whose value is not a path.
 *
 * `(path.start_with? 'GEM_FONTS_DIR')` (`theme_loader.rb:145`) is the FIRST thing the catalogue does
 * with a style's value, and `start_with?` is a method only a String has — so the loader raises before
 * it has looked at the file name, `converter.rb:556`'s bare rescue reverts the whole document to the
 * default theme, and every setting written beside the catalogue goes with it.
 *
 * This module skipped the style and read the theme in full, with no diagnostic at all. The shape that
 * makes that matter is `normal:` with nothing after it, which is not an exotic mistake — it is what a
 * live preview is looking at for as long as it takes its author to type a filename.
 */
describe('the font files a catalogue names', () => {
  /** A setting under a category the documents below do not write, so it can only come from them. */
  const WITNESS = 'base:\n  font_size: 20\n';

  it.each([
    ['a number', 'normal: 10'],
    ['a fractional number', 'normal: 1.5'],
    ['a word Psych reads as true', 'normal: true'],
    ['a word Psych reads as false', 'normal: false'],
    ['a list', 'normal: [1, 2]'],
    ['an empty list', 'normal: []'],
    ['a mapping', 'normal: {a: 1}'],
    ['an empty mapping', 'normal: {}'],
    ['a number under the bold style', 'bold: 10'],
    ['a number under the italic style', 'italic: 10'],
    ['a number under the bold_italic style', 'bold_italic: 10'],
    ['a number under the regular alias', 'regular: 10'],
    ['a number under the every-style wildcard', "'*': 10"],
    ['a number under a style name prawn never asks for', 'weird: 10'],
  ])('refuses the whole document over a font style set to %s', (_label, style) => {
    // Measured against the vendored gem under ruby 3.3.3, every one of these raises
    // `undefined method 'start_with?'` — for an Integer, a Float, a `true`, a `false`, an Array and a
    // Hash in turn — and it raises in every style slot alike, because the slot is only the key the
    // path is filed under and the path is what the method is called on.
    const result = parseThemeDocument(`${WITNESS}font:\n  catalog:\n    Brand:\n      ${style}\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe(
      'A font style in the theme document is set to a number, a boolean, a list or a mapping where a font file was expected, so none of the document is read.',
    );
  });

  it.each([
    ['written with nothing after it', 'font:\n  catalog:\n    Brand:\n      normal:\n'],
    ['written as an explicit null', 'font:\n  catalog:\n    Brand:\n      normal: ~\n'],
    ['written flat, with nothing after it', 'font_catalog:\n  Brand:\n    normal:\n'],
  ])('says a font style is unfinished rather than wrong, given one %s', (_label, text) => {
    // `nil` has no `start_with?` either, so this raises exactly as `normal: 10` does and the export
    // discards the document just as completely — measured. What differs is what its author has to do:
    // nothing is written wrong, nothing is written yet, and a sentence about a style being "set to"
    // the wrong kind of thing describes a mistake they have not made.
    //
    // The BEHAVIOUR is the hard one either way, and deliberately so: the page really is the default
    // page while the line is unfinished, and a softer outcome would be the preview showing a theme
    // the export does not apply.
    const result = parseThemeDocument(WITNESS + text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe(
      'A font style in the theme document has no font file after it yet, and a theme is not read until every style it declares names one.',
    );
  });

  it.each([
    ['written flat at the top level', 'font_catalog:\n  Brand:\n    normal: 10\n'],
    ['written flat with a hyphen the loader folds', 'font-catalog:\n  Brand:\n    normal: 10\n'],
    ['written under a family named with a number', 'font:\n  catalog:\n    10:\n      normal: 10\n'],
    ['written in the second family, after a good one', 'font:\n  catalog:\n    A:\n      normal: a.ttf\n    B:\n      normal: 10\n'],
    ['reached through an alias', 'z: &z\n  normal: 10\nfont:\n  catalog:\n    Brand: *z\n'],
  ])('refuses the whole document over a catalogue %s', (_label, text) => {
    // The flat spelling reaches the same branch of `process_entry` the nested one does — measured, it
    // raises `NoMethodError` identically — and so does a catalogue an alias carries in. A bad path in
    // the SECOND family is enough on its own: the loader folds the families in order and raises at the
    // first one it cannot ask a question about.
    const result = parseThemeDocument(WITNESS + text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain('A font style in the theme document');
  });

  it.each([
    ['a family whose whole value is a number', 'font:\n  catalog:\n    Brand: 10\n'],
    ['a family whose whole value is a list', 'font:\n  catalog:\n    Brand: [1, 2]\n'],
    ['a family whose whole value is empty', 'font:\n  catalog:\n    Brand:\n'],
    ['a family whose whole value is a boolean', 'font:\n  catalog:\n    Brand: true\n'],
    ['a merge flag written as a number', 'font:\n  catalog:\n    merge: 10\n    Brand:\n      normal: a.ttf\n'],
    ['a merge flag written as a mapping of bad paths', 'font:\n  catalog:\n    merge:\n      normal: 10\n'],
    ['a style whose path is an empty string', "font:\n  catalog:\n    Brand:\n      normal: ''\n"],
    ['a catalogue that is not a mapping at all', 'font:\n  catalog: 5\n'],
    ['a font key that is not a mapping at all', 'font: 5\n'],
    ['a catalogue nested under a key of the author’s own', 'x:\n  font:\n    catalog:\n      Brand:\n        normal: 10\n'],
  ])('goes on reading the document, given %s', (_label, text) => {
    // The contrast that makes the refusals above mean something, and every line of it was measured
    // rather than reasoned to. `accum[name] = styles.reduce … if ::Hash === styles` never enters the
    // reduce for a family that is not a mapping, so such a family is DROPPED and no path is ever
    // asked a question — `font_catalog` comes back `{}`. `merge` is `delete`d out of the catalogue
    // before the reduce begins, so its value is never a path however it is written. An empty string
    // is a String and has `start_with?`. And the branch is reached only for `font` and `font_catalog`
    // at the top level, so a catalogue an author nests under a name of their own is an inert setting:
    // `x_font_catalog_Brand_normal => 10`, measured.
    const result = parseThemeDocument(WITNESS + text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries).toContainEqual({ key: 'base_font_size', value: 20, line: 2 });
  });

  it('shows the default page rather than a theme the export throws away', () => {
    // The end of the road the preview used to take: 20 pt on screen for a page the export prints at
    // 10.5, with nothing said, while the author is still typing the filename.
    const result = resolveAppearance({
      themeText: 'base:\n  font_size: 20\nfont:\n  catalog:\n    Brand:\n      normal:\n',
      themePath: 'theme/brand.yml',
    });
    expect(result.themeApplied).toBe(false);
    expect(result.appearance.base.fontSizePt).toBe(10.5);
    expect(result.diagnostics.map((each) => each.code)).toEqual(['theme-unparseable']);
  });

  it('names no font, no style and no file in what it says about a catalogue', () => {
    const result = resolveAppearance({
      themeText: 'font:\n  catalog:\n    </style>:\n      "<script>": [1]\n',
      themePath: 'theme/brand.yml',
    });
    expect(result.diagnostics).toHaveLength(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic.message).not.toContain('</style>');
    expect(diagnostic.message).not.toContain('<script>');
    expect(diagnostic.detail ?? '').not.toContain('</style>');
    expect(diagnostic.detail ?? '').not.toContain('<script>');
  });
});
