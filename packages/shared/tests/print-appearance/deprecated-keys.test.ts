import { CLAIMED_THEME_KEYS, defaultAppearance, resolveAppearance } from '../../src/print-appearance';
import {
  DEPRECATED_THEME_CATEGORIES,
  DEPRECATED_THEME_KEYS,
} from '../../src/print-appearance/deprecated-keys.generated';
import { parseThemeDocument } from '../../src/print-appearance/parse-theme';

/**
 * @file The spellings the renderer still honours, which the preview used to drop.
 *
 * `ThemeLoader#process_entry` renames a key before storing it and says nothing about having done so
 * (`theme_loader.rb:167-176`). The export therefore applies `sidebar: title: align`; the preview kept
 * the written spelling, found no such setting, and reported nothing — so an author saw a centred
 * title in the preview and a right-aligned one in the PDF, with an empty diagnostics list to explain
 * it. The application's OWN theme editor offers `sidebar.title.align`, described as a legacy alias.
 *
 * The tables are generated from the gem, so the assertions below walk them rather than naming their
 * contents: a gem bump that adds a spelling is covered the moment the table is regenerated.
 */

/** Build a theme document setting one flat key, nesting it back into the shape a theme is written in. */
function themeSetting(flatKey: string, value: string): string {
  return `extends: default\n${flatKey}: ${value}\n`;
}

describe('the spellings the theme loader rewrites', () => {
  const renames = Object.entries(DEPRECATED_THEME_KEYS);

  it('has a table with something in it, so the assertions below are not vacuous', () => {
    expect(renames.length).toBeGreaterThan(10);
    expect(Object.keys(DEPRECATED_THEME_CATEGORIES).length).toBeGreaterThan(0);
  });

  it.each(renames)('reads %s exactly as it reads %s', (deprecated, current) => {
    // `right` is a value every one of these keys accepts (they are all alignments), and for any that
    // is not, both spellings are read the same WRONG way — which is still the property under test:
    // what the loader renames, this reads as the renamed key, whatever the value turns out to be.
    const asWritten = resolveAppearance({ themeText: themeSetting(deprecated, 'right') });
    const asRenamed = resolveAppearance({ themeText: themeSetting(current, 'right') });
    expect(asWritten.appearance).toEqual(asRenamed.appearance);
    expect(asWritten.diagnostics).toEqual(asRenamed.diagnostics);
  });

  it('changes the page for every deprecated spelling of a key the model reads', () => {
    // The equality above would hold if BOTH spellings were ignored, so this is what makes it mean
    // something: for a key the model claims, the deprecated spelling must move the appearance off
    // the default — which is what it did in the export all along.
    //
    // Compared by VALUE, never by identity. `resolveAppearance` builds a fresh appearance for every
    // theme that parses and `defaultAppearance()` hands back a shared singleton, so
    // `result.appearance !== defaultAppearance()` is true for any theme at all — including one whose
    // only setting is a key no renderer has ever had, which resolves to something deep-equal to the
    // default. An assertion on that reference was here, and it could not fail.
    const claimed = new Set(CLAIMED_THEME_KEYS);
    const reaching = renames.filter(([, current]) => claimed.has(current));
    expect(reaching.length).toBeGreaterThan(0);
    for (const [deprecated, current] of reaching) {
      const written = resolveAppearance({ themeText: themeSetting(deprecated, 'right') });
      expect({ deprecated, appearance: written.appearance }).not.toEqual({
        deprecated,
        appearance: defaultAppearance(),
      });
      // And moved to the same place the current spelling moves it, which is the claim the rename
      // actually makes. The `it.each` above asserts this too, but only over the pair — here it is
      // asserted for the keys the model READS, where a difference is a difference on the page.
      const renamed = resolveAppearance({ themeText: themeSetting(current, 'right') });
      expect({ deprecated, appearance: written.appearance }).toEqual({
        deprecated,
        appearance: renamed.appearance,
      });
    }
  });

  it('would notice a theme that changes nothing — the check above is by value, not by reference', () => {
    // The guard on the guard. A theme naming a key nothing reads resolves to an appearance that is
    // deep-equal to the default and is NOT the same object, so an identity comparison calls it a
    // change and a value comparison does not. This is the input that told the two apart.
    const inert = resolveAppearance({ themeText: themeSetting('not_a_theme_key_at_all', 'right') });
    expect(inert.appearance).not.toBe(defaultAppearance());
    expect(inert.appearance).toEqual(defaultAppearance());
  });

  it('right-aligns a sidebar title written the way the theme editor offers it', () => {
    // The reported case, and the reason the silence mattered: `sidebar.title.align` is one of the
    // 316 settings the product's own theme editor renders, described there as a legacy alias. A
    // user picking it got a right-aligned title in the PDF and a centred one on screen.
    const result = resolveAppearance({
      themeText: 'extends: default\nsidebar:\n  title:\n    align: right\n',
    });
    expect(result.appearance.sidebar?.title?.textAlign).toBe('right');
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps the value out of the arithmetic, as the loader’s own branch does', () => {
    // `data[rekey] = evaluate val, data, math: false` — the deprecated branch is the one place the
    // answer to "is this value an expression?" depends on how the key was spelled.
    const result = parseThemeDocument('base:\n  align: 1 + 1\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.entries).toEqual([
      { key: 'base_text_align', value: '1 + 1', line: 2, math: false },
    ]);
  });

  it('follows a deprecated spelling through a variable reference too', () => {
    // `resolve_var` tries the deprecated spellings before it warns (`theme_loader.rb:219-229`), so a
    // reference to one resolves in the export. Here it used to dangle, which cost the referring key
    // its value AND produced a warning about a theme that renders perfectly.
    const result = resolveAppearance({
      themeText: 'extends: default\nquote:\n  font_color: DD0000\nbase:\n  font_color: $blockquote_font_color\n',
    });
    expect(result.appearance.base.fontColor).toBe('DD0000');
    expect(result.diagnostics).toEqual([]);
  });
});

describe('the categories the theme loader renames', () => {
  it.each(Object.entries(DEPRECATED_THEME_CATEGORIES))(
    'reads the %s category exactly as it reads %s',
    (deprecated, current) => {
      const asWritten = resolveAppearance({
        themeText: `extends: default\n${deprecated}:\n  font_color: AA0000\n  font_size: 9\n`,
      });
      const asRenamed = resolveAppearance({
        themeText: `extends: default\n${current}:\n  font_color: AA0000\n  font_size: 9\n`,
      });
      expect(asWritten.appearance).toEqual(asRenamed.appearance);
      expect(asWritten.diagnostics).toEqual(asRenamed.diagnostics);
    },
  );

  it.each([
    ['blockquote', 'font_color: AA0000', (appearance: ReturnType<typeof defaultAppearance>) => appearance.quote?.fontColor],
    ['literal', 'font_color: BB0000', (appearance: ReturnType<typeof defaultAppearance>) => appearance.codespan?.fontColor],
    [
      'key',
      'background_color: CC0000',
      (appearance: ReturnType<typeof defaultAppearance>) => appearance.kbd?.backgroundColor,
    ],
    ['outline_list', 'indent: 30', (appearance: ReturnType<typeof defaultAppearance>) => appearance.list?.indentPt],
  ])('applies a setting written under the deprecated %s category', (category, setting, read) => {
    // One probe per category, so the equality above cannot pass by both spellings being dropped.
    const result = resolveAppearance({ themeText: `extends: default\n${category}:\n  ${setting}\n` });
    expect(read(result.appearance)).not.toEqual(read(defaultAppearance()));
    expect(result.diagnostics).toEqual([]);
  });
});
