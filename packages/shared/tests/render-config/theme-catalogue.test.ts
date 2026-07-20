import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  THEME_CATEGORIES,
  THEME_SETTINGS,
  canonicalThemeKey,
  isKnownThemeKey,
  isPlausibleThemeKey,
  themeSetting,
  themeSettingsFor,
} from '../../src/render-config/theme-catalogue';
import { DEFAULT_THEME_YAML } from '../../src/render-config/default-theme.generated';
import { THEME_DESCRIPTIONS } from '../../src/render-config/theme-descriptions';
import {
  GENERATED_THEME_DESCRIPTORS,
  THEME_DESCRIPTOR_GEM_VERSION,
} from '../../src/render-config/theme-descriptors.generated';
import type { ThemeSettingDescriptor } from '../../src/render-config/theme-descriptor-types';

const GEM_ROOT = path.join(
  __dirname,
  '../../../asciidoc-pdf/ruby/.wasm-build/vendor/bundle/ruby/3.3.0/gems',
);

/** The one vendored gem's directory, or null where the wasm engine has not been built. */
function gemDirectory(): string | null {
  let gems: string[];
  try {
    gems = readdirSync(GEM_ROOT).filter((name) => name.startsWith('asciidoctor-pdf-'));
  } catch {
    return null;
  }
  return gems.length === 1 ? path.join(GEM_ROOT, gems[0]) : null;
}

/** The vendored gem's default theme, read raw. */
function readDefaultTheme(): string | null {
  const gem = gemDirectory();
  return gem === null ? null : readFileSync(path.join(gem, 'data/themes/default-theme.yml'), 'utf8');
}

/**
 * Every `@theme.<key>` the converter's Ruby reads, flattened.
 *
 * The SECOND half of the ground truth, and the half this file used to be missing. A theme file
 * contains only the keys it SETS; a key whose default lives in Ruby appears in no theme file, so
 * checking offered keys against the default theme alone declared 134 real settings invented — which
 * is the same wrong premise that kept them out of the catalogue and had the editor underlining
 * `running-content.start-at` in a theme that renders perfectly.
 */
function readConverterKeys(): string | null {
  const gem = gemDirectory();
  if (gem === null) return null;
  const parts: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.rb')) parts.push(readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(gem, 'lib'));
  return parts.join('\n');
}

describe('theme descriptor catalogue — generation invariants', () => {
  it('derives a non-trivial catalogue from the gem', () => {
    expect(GENERATED_THEME_DESCRIPTORS.length).toBeGreaterThan(100);
    expect(THEME_DESCRIPTOR_GEM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('resolves every key to exactly one descriptor (invariant D1)', () => {
    // Completion cannot be ambiguous about which descriptor governs a key the author typed.
    const seen = new Set<string>();
    for (const descriptor of THEME_SETTINGS) {
      const canonical = canonicalThemeKey(descriptor.key);
      expect(seen.has(canonical)).toBe(false);
      seen.add(canonical);
    }
  });

  it('gives every descriptor a category matching its key’s first segment', () => {
    for (const descriptor of THEME_SETTINGS) {
      const [first] = descriptor.key.split('.');
      expect(descriptor.category).toBe(first);
    }
  });

  it('lists permitted values for keyword settings and only for them', () => {
    for (const descriptor of THEME_SETTINGS) {
      if (descriptor.valueKind === 'keyword') {
        expect(descriptor.permittedValues?.length ?? 0).toBeGreaterThan(0);
      } else {
        expect(descriptor.permittedValues).toBeUndefined();
      }
    }
  });

  it('emits keys in the documented dotted, hyphenated, lowercase form', () => {
    for (const descriptor of THEME_SETTINGS) {
      expect(descriptor.key).toMatch(/^[a-z\d]+(?:[.-][a-z\d]+)*$/);
    }
  });
});

describe('theme descriptor catalogue — description table (invariant D2)', () => {
  it('describes only keys the gem still has', () => {
    // THE guard on the generated/hand-written split. If a gem bump drops a key, this fails and the
    // entry must be deleted or re-keyed — never the check relaxed, or the table silently decays into
    // the hand-maintained key list the generation exists to replace.
    const orphans = Object.keys(THEME_DESCRIPTIONS).filter((key) => !isKnownThemeKey(key));
    expect(orphans).toEqual([]);
  });

  it('writes each description against the generator’s own spelling of the key', () => {
    // A description keyed `heading_h1_font_size` would still resolve, but would drift from the key
    // shown in completion. Keeping the spellings identical keeps the two files diffable together.
    for (const key of Object.keys(THEME_DESCRIPTIONS)) {
      expect(themeSetting(key)?.key).toBe(key);
    }
  });

  it('describes every key the catalogue offers', () => {
    // The converse of the orphan check above, and the one that actually decays: an orphan is caught
    // by a gem bump, whereas an UNdescribed key is silently fine — everything still compiles, and
    // completion just shows a key with no explanation beside it. Coverage was 206 of 315 for exactly
    // that reason, and it was invisible until the editor started offering hover documentation.
    //
    // This is the one invariant here that a gem bump is EXPECTED to break. When it does, the fix is
    // to write prose for the new keys, not to relax it. Nothing is broken meanwhile — hover falls
    // back to the key's value kind — so the failure is a task, not an outage.
    const undescribed = THEME_SETTINGS.filter((setting) => setting.description === '').map(
      (setting) => setting.key,
    );
    expect(undescribed).toEqual([]);
  });

  it('writes descriptions that say something', () => {
    for (const [key, description] of Object.entries(THEME_DESCRIPTIONS)) {
      expect(description.length).toBeGreaterThan(10);
      expect(description).not.toBe(key);
    }
  });

  it('merges descriptions onto the generated descriptors', () => {
    const heading = themeSetting('heading.font-color');
    expect(heading).toBeDefined();
    expect(heading?.valueKind).toBe('colour');
    expect(heading?.description).toBe(THEME_DESCRIPTIONS['heading.font-color']);
  });

  it('leaves an undescribed key with an empty description rather than dropping it', () => {
    // An undescribed key is still a key the renderer honours; withholding it from completion would
    // be worse than offering it bare.
    for (const descriptor of THEME_SETTINGS) {
      expect(typeof descriptor.description).toBe('string');
    }
  });
});

// The gem lives under a gitignored build directory, so it is absent on a fresh clone. The generated
// catalogue is committed and every other test here checks it directly; these two compare it against
// the gem itself, so they can only run where the gem was built.
const theme = readDefaultTheme();
const converterSource = readConverterKeys();
const describeWithGem = theme === null ? describe.skip : describe;

describeWithGem('theme descriptor catalogue — SC-011 coverage', () => {
  it('offers no key the renderer does not recognise (invariant D3)', () => {
    if (theme === null || converterSource === null) return;
    // Checked against BOTH halves of what "the renderer recognises" means: a key it is given a value
    // for in the default theme, or a key its own code reads. Either is evidence; neither alone is
    // the set. A key supported by neither is one we invented.
    //
    // The two are matched differently on purpose. The theme is searched by LEAF, because its nesting
    // is not the catalogue's nesting. The converter is searched by the WHOLE key flattened, because
    // that is literally the identifier Ruby writes — which makes it the stricter of the two, and the
    // reason a code-only key cannot slip through on a leaf that merely looks familiar.
    const flattenedTheme = canonicalThemeKey(theme);
    const flattenedSource = canonicalThemeKey(converterSource);
    const invented = THEME_SETTINGS.filter((descriptor) => {
      const canonical = canonicalThemeKey(descriptor.key);
      if (flattenedSource.includes(canonical)) return false;
      const leaf = canonicalThemeKey(descriptor.key.slice(descriptor.key.lastIndexOf('.') + 1));
      return !flattenedTheme.includes(leaf);
    }).map((descriptor) => descriptor.key);
    expect(invented).toEqual([]);
  });

  it('offers the settings the converter reads but no shipped theme sets', () => {
    if (converterSource === null) return;
    // The defect that sent an author here, pinned by name. Each of these is read by the converter
    // and set by NO shipped theme, so a catalogue derived from theme files alone cannot contain
    // them — and the editor underlines every one of them in a theme that renders correctly.
    for (const key of [
      'running-content.start-at',
      'page.numbering.start-at',
      // Read by this repo's OWN shipped extensions, which is how far the gap reached.
      'toc.dot-leader.content',
      'toc.hanging-indent',
      'page.column-gap',
    ]) {
      expect(isKnownThemeKey(key)).toBe(true);
    }
  });

  it('accepts every spelling the renderer flattens together', () => {
    // The renderer joins nested keys with `_` and normalises `-` to `_`, so it cannot distinguish
    // these three. The catalogue must not either, or an author gets underlined for choosing a
    // nesting the catalogue happens not to use — which is what the reported theme did.
    expect(isKnownThemeKey('page-numbering.start-at')).toBe(true);
    expect(isKnownThemeKey('page.numbering.start-at')).toBe(true);
    expect(isKnownThemeKey('page_numbering_start_at')).toBe(true);
  });

  it('covers at least 90% of the settings the default theme sets (SC-011)', () => {
    if (theme === null) return;
    // Re-derive the theme's leaf settings INDEPENDENTLY of the generator, so this measures coverage
    // rather than agreeing with the generator about its own output.
    const parsed = parse(theme) as Record<string, unknown>;
    const settings: string[] = [];
    const walk = (node: Record<string, unknown>, prefix: string): void => {
      for (const [rawKey, value] of Object.entries(node)) {
        const path = prefix === '' ? rawKey : `${prefix}.${rawKey}`;
        // The font catalogue maps author-chosen family names to files; its children are data, not
        // settings, so counting them would understate coverage of the settings that exist.
        if (canonicalThemeKey(path) === 'font_catalog') {
          settings.push(path);
        } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          walk(value as Record<string, unknown>, path);
        } else {
          settings.push(path);
        }
      }
    };
    walk(parsed, '');

    const missing = settings.filter((path) => !isKnownThemeKey(path));
    expect(settings.length).toBeGreaterThan(100);
    expect(1 - missing.length / settings.length).toBeGreaterThanOrEqual(0.9);
  });
});

describe('canonicalThemeKey', () => {
  it('treats the three forms the renderer flattens together as one key', () => {
    // The renderer reads all of these as `heading_h1_font_size`; an editor that did not would mark
    // two of the three as unknown settings.
    expect(canonicalThemeKey('heading.h1.font-size')).toBe('heading_h1_font_size');
    expect(canonicalThemeKey('heading.h1-font-size')).toBe('heading_h1_font_size');
    expect(canonicalThemeKey('heading_h1_font_size')).toBe('heading_h1_font_size');
  });

  it('ignores case, as the renderer does', () => {
    expect(canonicalThemeKey('Page.Layout')).toBe('page_layout');
  });
});

describe('themeSetting / isKnownThemeKey', () => {
  it('finds a setting however the author nested it', () => {
    expect(themeSetting('heading.h1.font-size')?.key).toBe('heading.h1-font-size');
    expect(themeSetting('heading_h1_font_size')?.key).toBe('heading.h1-font-size');
  });

  it('reports an unrecognised key', () => {
    expect(themeSetting('heading.h1.font-colour-ish')).toBeUndefined();
    expect(isKnownThemeKey('made.up.key')).toBe(false);
    expect(isKnownThemeKey('page.layout')).toBe(true);
  });

  it('carries the gem’s own default for a setting', () => {
    expect(themeSetting('page.layout')?.defaultValue).toBe('portrait');
    expect(themeSetting('page.layout')?.permittedValues).toEqual(['portrait', 'landscape']);
  });
});

describe('themeSettingsFor', () => {
  const CONTRIBUTED: ThemeSettingDescriptor = {
    key: 'paragraph-numbering.font-color',
    category: 'paragraph-numbering',
    valueKind: 'colour',
    description: 'Colour of the generated paragraph number.',
    contributedBy: 'paragraph-numbering',
  };

  it('offers only built-ins when no extension is enabled (invariant D5)', () => {
    expect(themeSettingsFor()).toBe(THEME_SETTINGS);
    expect(themeSettingsFor().some((d) => d.contributedBy !== undefined)).toBe(false);
  });

  it('adds an enabled extension’s settings alongside the built-ins', () => {
    const settings = themeSettingsFor([CONTRIBUTED]);
    expect(settings).toHaveLength(THEME_SETTINGS.length + 1);
    expect(settings.find((d) => d.key === CONTRIBUTED.key)?.contributedBy).toBe('paragraph-numbering');
    // The built-ins are still all there.
    expect(settings.find((d) => d.key === 'page.layout')).toBeDefined();
  });

  it('lets an extension override a built-in it deliberately reinterprets, without duplicating it', () => {
    const override: ThemeSettingDescriptor = {
      key: 'page.layout',
      category: 'page',
      valueKind: 'keyword',
      permittedValues: ['portrait', 'landscape', 'spread'],
      description: 'Page orientation, with the spread mode this extension adds.',
      contributedBy: 'multi-column',
    };
    const settings = themeSettingsFor([override]);
    expect(settings.filter((d) => canonicalThemeKey(d.key) === 'page_layout')).toHaveLength(1);
    expect(themeSettingsFor([override]).find((d) => d.key === 'page.layout')?.contributedBy).toBe(
      'multi-column',
    );
  });

  it('returns keys sorted, so completion order never depends on selection order', () => {
    const settings = themeSettingsFor([CONTRIBUTED]);
    const keys = settings.map((d) => d.key);
    expect(keys).toEqual([...keys].toSorted((a, b) => a.localeCompare(b)));
  });
});

describe('THEME_CATEGORIES', () => {
  it('lists each category once, sorted', () => {
    expect(THEME_CATEGORIES).toEqual([...new Set(THEME_CATEGORIES)].toSorted());
    expect(THEME_CATEGORIES).toContain('heading');
    expect(THEME_CATEGORIES).toContain('page');
  });
});

describe('isPlausibleThemeKey', () => {
  // WHY THIS IS DELIBERATELY WEAK. The catalogue is derived from two example theme files, not from a
  // schema — none exists upstream — so "absent from the catalogue" is not "invalid". These tests pin
  // the two failure modes that matter in opposite directions: a documented, working theme must not be
  // reported as broken, and a typo must still be caught.

  const CONTRIBUTED_GUTTER: ThemeSettingDescriptor = {
    key: 'multi-column.gutter',
    category: 'multi-column',
    valueKind: 'measurement',
    description: 'Space between columns.',
    contributedBy: 'multi-column',
  };

  it('accepts a key the catalogue carries, with no contributed keys supplied', () => {
    expect(isPlausibleThemeKey('heading.h2.font-size')).toBe(true);
    expect(isPlausibleThemeKey('heading.h2-font-size')).toBe(true);
  });

  it('accepts `extends`, which no theme file sets and the generator therefore cannot see', () => {
    // The load-bearing case: `extends` opens most documented themes, and neither shipped theme uses
    // it because they ARE the things being extended.
    expect(isPlausibleThemeKey('extends')).toBe(true);
  });

  it('accepts a key an enabled extension declares, however unlike a theme property it looks', () => {
    // `gutter` ends in no word the vocabulary knows, so this passes only via the contributed set —
    // which is the point: the extension declaring the key is what reads it.
    expect(isPlausibleThemeKey('multi-column.gutter')).toBe(false);
    expect(isPlausibleThemeKey('multi-column.gutter', [CONTRIBUTED_GUTTER])).toBe(true);
  });

  it('accepts a legal composition the example themes never demonstrate', () => {
    // `widget` is not a category the catalogue knows, but `font-size` is a property the renderer
    // honours wherever it appears. Rejecting this is the failure that teaches authors to ignore
    // validation entirely.
    expect(isKnownThemeKey('widget.font-size')).toBe(false);
    expect(isPlausibleThemeKey('widget.font-size')).toBe(true);
  });

  it('judges a key under an open namespace on its property leaf alone', () => {
    // `removed` is a role the DOCUMENT invents with `[.removed]#…#`; no catalogue could enumerate it.
    expect(isPlausibleThemeKey('role.removed.font-style')).toBe(true);
    // A font catalogue entry names a FACE, not a property — and the family between is author-chosen.
    expect(isPlausibleThemeKey('font.catalog.Roboto.bold_italic')).toBe(true);
    // The same face word outside an open namespace is still not a setting.
    expect(isPlausibleThemeKey('heading.bold')).toBe(false);
  });

  it('still catches a typo, inside an open namespace as well as outside it', () => {
    expect(isPlausibleThemeKey('heading.colour-scheme')).toBe(false);
    expect(isPlausibleThemeKey('role.removed.gubbins')).toBe(false);
  });

  it('rejects a bare word that names no property', () => {
    expect(isPlausibleThemeKey('gibberish')).toBe(false);
  });
});

/** Every dotted path in a parsed theme that ends at a scalar or a list. */
function leafKeys(node: unknown, prefix: readonly string[] = []): string[] {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return prefix.length > 0 ? [prefix.join('.')] : [];
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    leafKeys(value, [...prefix, key]),
  );
}

describe('the shipped default theme is plausible by its own rule', () => {
  // THE REGRESSION THIS EXISTS FOR. `isPlausibleThemeKey` underlines what it does not accept, so a
  // rule that rejects a key the RENDERER ITSELF ships marks a working theme as broken — the precise
  // failure the weak-by-design rule was written to avoid. Measured rather than assumed: this found 8
  // rejected keys (every `font.catalog.<family>.<face>` entry) when it was first written.
  //
  // The default theme is the strongest corpus available: it is the file a new theme is seeded from,
  // it is vendored verbatim from the gem, and it is regenerated whenever the gem is upgraded — so an
  // upgrade that introduces a new key shape fails here rather than in an author's editor.

  it('accepts every key the vendored default theme actually sets', () => {
    const keys = leafKeys(parse(DEFAULT_THEME_YAML));
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.filter((key) => !isPlausibleThemeKey(key))).toEqual([]);
  });
});

describe('settings the theming guide documents that the catalogue cannot enumerate', () => {
  it('accepts a custom admonition icon', () => {
    // `admonition.icon.tip.name: fa-lightbulb-o` is the guide's own custom-icon snippet, and the gem
    // reads the whole subtree through a dedicated `admonition_icon_` branch. Only the admonition
    // types the shipped themes happen to style can ever reach the catalogue, so the rest were
    // reported as settings that "will have no effect" — while working.
    expect(isPlausibleThemeKey('admonition.icon.tip.name')).toBe(true);
    expect(isPlausibleThemeKey('admonition.icon.caution.stroke-color')).toBe(true);
    expect(isPlausibleThemeKey('admonition.icon.important.size')).toBe(true);
  });

  it('still rejects a typo in that namespace', () => {
    // The point is to stop crying wolf, not to accept everything under the prefix.
    expect(isPlausibleThemeKey('admonition.icon.tip.colour-scheme')).toBe(false);
  });
});
