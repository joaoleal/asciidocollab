import { themeHoverAt, themeHoverLines } from '@/lib/codemirror/theme/theme-key-hover';
import { THEME_SETTINGS, canonicalThemeKey, themeSetting } from '@asciidocollab/shared';
import type { ThemeSettingDescriptor } from '@asciidocollab/shared';

/** A nested theme, so a hover has to resolve a leaf against the container path above it. */
const THEME = ['heading:', '  font-color: 191970', '  font-style: bold', ''].join('\n');

/** The offset of `needle`'s first character in `text`. */
function offsetOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

/**
 * A one-line theme assigning `key`, hovered at its start.
 *
 * The key is written FLAT — `heading_font_color` — because a dotted key is not a YAML line: the
 * document reader takes nesting from indentation, and `a.b: 1` would be one key literally named
 * `a.b`. The flat spelling is the form the renderer itself flattens everything to, so this exercises
 * a real theme rather than a shape only this test produces.
 */
function hoverFor(key: string, value = 'x'): ReturnType<typeof themeHoverAt> {
  return themeHoverAt(`${canonicalThemeKey(key)}: ${value}\n`, 0, []);
}

describe('themeHoverAt', () => {
  it('resolves a leaf to its full dotted key', () => {
    // The line under the pointer reads `font-color`, which is a key several containers define. What
    // makes the hover worth showing is that it names WHICH one.
    const hover = themeHoverAt(THEME, offsetOf(THEME, 'font-color'), []);
    expect(hover?.key).toBe('heading.font-color');
    expect(hover?.overKey).toBe(true);
  });

  it('anchors to the key text rather than the whole line', () => {
    const from = offsetOf(THEME, 'font-color');
    const hover = themeHoverAt(THEME, from, []);
    expect(hover?.from).toBe(from);
    expect(hover?.to).toBe(from + 'font-color'.length);
  });

  it('answers over the value too, which is where the legal words are asked about', () => {
    // `font-style: bold` — hovering `bold` is the one moment an author wants the permitted set, and
    // it is exactly when completion has already closed.
    const hover = themeHoverAt(THEME, offsetOf(THEME, 'bold'), []);
    expect(hover?.key).toBe('heading.font-style');
    expect(hover?.overKey).toBe(false);
    expect(themeHoverLines(hover!)).toContainEqual(expect.stringContaining('One of:'));
  });

  it('resolves a leaf nested two containers deep', () => {
    const nested = ['abstract:', '  title:', '    font-style: italic', ''].join('\n');
    expect(themeHoverAt(nested, offsetOf(nested, 'font-style'), [])?.key).toBe(
      'abstract.title.font-style',
    );
  });

  it('says nothing on a container line', () => {
    // `heading:` assigns nothing, so there is no setting to describe. Naming the container would
    // invent a descriptor the catalogue does not carry.
    expect(themeHoverAt(THEME, offsetOf(THEME, 'heading'), [])).toBeNull();
  });

  it('says nothing on a blank line, or on the indent before a key', () => {
    // Ranges are end-INCLUSIVE, so the offset immediately past `bold` still resolves — that is the
    // caret-edge behaviour hover wants and is not what this is about. These are positions with no
    // token anywhere near them.
    const spaced = ['heading:', '  font-style: bold', '', 'base:', '  font-size: 10.5', ''].join(
      '\n',
    );
    expect(themeHoverAt(spaced, offsetOf(spaced, '\n\nbase') + 1, [])).toBeNull();
    expect(themeHoverAt(spaced, offsetOf(spaced, '  font-size'), [])).toBeNull();
  });

  it('says nothing on a key the renderer would not read', () => {
    // The linter already underlines this with a message saying so; a tooltip repeating "unknown"
    // would be a second voice saying less.
    const unknown = 'heading:\n  not-a-real-setting: 3\n';
    expect(themeHoverAt(unknown, offsetOf(unknown, 'not-a-real-setting'), [])).toBeNull();
  });

  it('reads a key written flat, as the renderer does', () => {
    // `heading_h2_font_size` and the nested `heading:` / `h2-font-size:` form are the SAME setting to
    // the renderer, so a hover that only understood one spelling would go silent on valid themes.
    const flat = 'heading_h2_font_size: 22\n';
    expect(themeHoverAt(flat, 0, [])?.descriptor.key).toBe('heading.h2-font-size');
  });

  it('describes a setting an enabled extension contributes', () => {
    const contributed: ThemeSettingDescriptor = {
      key: 'extension.demo.width',
      category: 'extension',
      valueKind: 'measurement',
      description: 'A setting only an extension reads.',
      contributedBy: 'demo-extension',
    };
    const text = 'extension:\n  demo:\n    width: 20\n';
    const hover = themeHoverAt(text, offsetOf(text, 'width'), [contributed]);
    expect(hover?.descriptor.description).toBe('A setting only an extension reads.');
    expect(themeHoverLines(hover!)).toContainEqual('Contributed by the demo-extension extension.');
  });
});

describe('themeHoverLines', () => {
  it('leads with the full key, so a deeply nested leaf is identifiable', () => {
    const nested = ['abstract:', '  title:', '    font-style: italic', ''].join('\n');
    const hover = themeHoverAt(nested, offsetOf(nested, 'font-style'), []);
    expect(themeHoverLines(hover!)[0]).toBe('abstract.title.font-style');
  });

  it('shows the description when one has been written', () => {
    const described = THEME_SETTINGS.find((setting) => setting.description !== '');
    expect(described).toBeDefined();
    expect(themeHoverLines(hoverFor(described!.key)!)[1]).toBe(described!.description);
  });

  it('falls back to the value kind rather than rendering an empty tooltip', () => {
    // A hover that silently does nothing reads as a broken feature rather than as a missing string.
    //
    // The descriptor is CONSTRUCTED rather than found in the catalogue, which currently describes
    // every key it carries. Searching for an undescribed one would make this test silently vacuous
    // exactly while coverage is complete — and stop guarding the branch that the next gem bump, which
    // may add keys before anyone writes prose for them, is precisely what would reach.
    const undescribed: ThemeSettingDescriptor = {
      key: 'newly.added.setting',
      category: 'newly',
      valueKind: 'measurement',
      description: '',
    };
    const text = 'newly:\n  added:\n    setting: 4\n';
    const hover = themeHoverAt(text, offsetOf(text, 'setting'), [undescribed]);
    const lines = themeHoverLines(hover!);
    expect(lines[0]).toBe('newly.added.setting');
    expect(lines[1]).toEqual(expect.stringMatching(/\w/));
  });

  it('never yields an empty line for any key in the catalogue', () => {
    // Swept across the whole catalogue rather than sampled, because the fallback's whole job is to
    // hold for the keys nobody thought about.
    for (const setting of THEME_SETTINGS) {
      const hover = hoverFor(setting.key);
      expect(hover).not.toBeNull();
      for (const text of themeHoverLines(hover!)) expect(text.trim()).not.toBe('');
    }
  });

  it('shows the renderer default, so the author sees what they are changing from', () => {
    const withDefault = THEME_SETTINGS.find((setting) => setting.defaultValue !== undefined);
    expect(themeHoverLines(hoverFor(withDefault!.key)!)).toContainEqual(
      `Default: ${withDefault!.defaultValue}`,
    );
  });

  it('lists the permitted words for a keyword setting', () => {
    const keyword = themeSetting('heading.font-style');
    expect(keyword?.permittedValues).toBeDefined();
    expect(themeHoverLines(hoverFor('heading.font-style')!)).toContainEqual(
      `One of: ${keyword!.permittedValues!.join(', ')}`,
    );
  });
});
