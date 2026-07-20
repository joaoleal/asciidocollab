import {
  extensionThemeSettings,
  themeSettingsFor,
  themeSetting,
  isPlausibleThemeKey,
} from '../../src/render-config';
import type { PdfExtensionCatalogueEntry } from '@asciidocollab/asciidoc-core';

/** A catalogue entry contributing `themeKeys`. */
function entry(
  id: string,
  themeKeys: PdfExtensionCatalogueEntry['manifest']['themeKeys'],
  available = true,
): PdfExtensionCatalogueEntry {
  return {
    manifest: {
      id,
      displayName: `The ${id} extension`,
      description: '',
      targeting: '',
      themeKeys,
      sampleContent: '',
    },
    origin: 'shipped',
    available,
  };
}

const NARROW = entry('narrow-contents', [
  {
    key: 'narrow-contents.left',
    valueKind: 'measurement',
    description: 'Space between the left margin and the contents list.',
    default: '72',
  },
  {
    key: 'narrow-contents.right',
    valueKind: 'measurement',
    description: 'Space between the contents list and the right margin.',
    default: '72',
  },
]);

describe('extensionThemeSettings — which contributed keys are offered', () => {
  it('groups a single-segment contributed key under the whole key', () => {
    // A manifest may declare a top-level key — `extends` is the renderer's own precedent. With no dot
    // to split on there is no category to derive, so the key itself becomes one rather than the
    // setting landing in an empty group.
    const flat = entry('spread-mode', [
      { key: 'spread', valueKind: 'keyword', description: 'Whether pages are laid out as spreads.' },
    ]);
    const settings = extensionThemeSettings([flat], ['spread-mode']);
    expect(settings).toHaveLength(1);
    expect(settings[0].category).toBe('spread');
  });

  it('offers the keys of an enabled extension', () => {
    const settings = extensionThemeSettings([NARROW], ['narrow-contents']);
    expect(settings.map((s) => s.key)).toEqual(['narrow-contents.left', 'narrow-contents.right']);
  });

  it('offers nothing for an extension the project has not enabled', () => {
    // The extension's Ruby is not loaded, so its keys are read by nothing. Completing them would
    // walk an author into writing a line that silently does nothing (FR-031b, invariant D5).
    expect(extensionThemeSettings([NARROW], [])).toEqual([]);
  });

  it('offers nothing for an enabled extension the deployment no longer provides', () => {
    // A stale selection: the project still lists it, but nothing will load it.
    const retired = entry('narrow-contents', NARROW.manifest.themeKeys, false);
    expect(extensionThemeSettings([retired], ['narrow-contents'])).toEqual([]);
  });

  it('names the contributing extension on each descriptor', () => {
    const [first] = extensionThemeSettings([NARROW], ['narrow-contents']);
    expect(first.contributedBy).toBe('The narrow-contents extension');
  });

  it('groups a contributed key under its first segment, like a built-in', () => {
    const [first] = extensionThemeSettings([NARROW], ['narrow-contents']);
    expect(first.category).toBe('narrow-contents');
  });

  it('carries a declared default through, and omits an empty one', () => {
    const blank = entry('licence', [
      { key: 'license-page.font-color', valueKind: 'colour', description: 'Colour.', default: '' },
    ]);
    const [withDefault] = extensionThemeSettings([NARROW], ['narrow-contents']);
    const [withoutDefault] = extensionThemeSettings([blank], ['licence']);
    expect(withDefault.defaultValue).toBe('72');
    // An empty `default` means "no value unless the theme sets one"; showing an empty default would
    // tell the author the setting has a value when it has none.
    expect(withoutDefault.defaultValue).toBeUndefined();
  });
});

describe('contributed keys reaching completion and validation together', () => {
  const contributed = extensionThemeSettings([NARROW], ['narrow-contents']);

  it('merges contributed settings into the offerable catalogue', () => {
    const offered = themeSettingsFor(contributed);
    expect(offered.some((s) => s.key === 'narrow-contents.left')).toBe(true);
    // The built-ins are still there — the contributed half is additive, not a replacement.
    expect(offered.some((s) => s.key === 'heading.font-color')).toBe(true);
  });

  it('resolves a contributed key to its own description', () => {
    expect(themeSetting('narrow-contents.left', contributed)?.description).toMatch(/left margin/);
  });

  it('resolves a contributed key however the author spelled it', () => {
    // The renderer flattens dots and hyphens to underscores before reading anything, so all three
    // spellings are the same setting and completion must treat them as one.
    expect(themeSetting('narrow_contents_left', contributed)).toBeDefined();
    expect(themeSetting('NARROW-CONTENTS.LEFT', contributed)).toBeDefined();
  });

  it('accepts a contributed key in validation while its extension is enabled', () => {
    // The extension declaring the key is what reads it, so it is honoured by definition.
    expect(isPlausibleThemeKey('narrow-contents.left', contributed)).toBe(true);
  });

  it('still judges a key no enabled extension declares on the built-in vocabulary alone', () => {
    // Passing contributed settings must not turn validation off wholesale: a typo is still a typo.
    //
    // `heading.fnt-clr` rather than `heading.font-colour`, because the latter is ACCEPTED by design
    // — `colour` is in the property vocabulary, so the British spelling passes the plausibility
    // check. That is pre-existing and deliberate; this test is about the contributed half not
    // widening the check, so it uses a key the check genuinely rejects.
    expect(isPlausibleThemeKey('heading.fnt-clr', contributed)).toBe(false);
  });

  it('retracts a contributed key from completion once its extension is disabled again', () => {
    // The gate has to swing both ways: disabling an extension must stop its keys being offered, or
    // an author is completed into settings nothing reads.
    const none = extensionThemeSettings([NARROW], []);
    expect(themeSettingsFor(none).some((s) => s.key === 'narrow-contents.left')).toBe(false);
  });

  it('does NOT start warning about that key once the extension is disabled', () => {
    // Deliberate, and worth pinning so it is not "fixed" later.
    //
    // Gating applies to COMPLETION, which can be exact. Validation cannot be: `isPlausibleThemeKey`
    // judges the property VOCABULARY rather than the key space, because the built-in catalogue is
    // derived from two example themes rather than a schema, and treating "absent from the catalogue"
    // as "invalid" reports working themes as broken. `narrow-contents.left` ends in `left`, a real
    // property word, so it stays plausible either way.
    //
    // The alternative — warning on every key no enabled extension declares — would require the
    // validator to know the whole legal key space, which is exactly what it cannot know.
    const none = extensionThemeSettings([NARROW], []);
    expect(isPlausibleThemeKey('narrow-contents.left', none)).toBe(true);
  });
});
