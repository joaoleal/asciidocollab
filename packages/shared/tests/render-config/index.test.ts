import {
  THEME_SETTINGS,
  THEME_CATEGORIES,
  isKnownThemeKey,
  canonicalThemeKey,
  THEME_DESCRIPTOR_GEM_VERSION,
  DEFAULT_THEME_YAML,
  DEFAULT_THEME_GEM_VERSION,
  isThemeFilePath,
  resolveThemePath,
  themeFilePaths,
  THEME_FILENAME_CONVENTION,
} from '../../src/render-config';

// Covers the render-config barrel re-export itself (its value getters), not just the sub-modules
// directly — otherwise the barrel's re-exported runtime bindings register as uncovered functions.
// It also earns its keep as a surface check: every consumer outside this package reaches these names
// through the barrel, so a re-export dropped during a refactor breaks them and nothing else.
describe('render-config barrel re-exports', () => {
  it('re-exports the theme catalogue and its lookups', () => {
    expect(THEME_SETTINGS.length).toBeGreaterThan(0);
    expect(THEME_CATEGORIES).toContain('heading');
    expect(isKnownThemeKey('heading.h2.font-size')).toBe(true);
    expect(canonicalThemeKey('heading.h2-font-size')).toBe('heading_h2_font_size');
  });

  it('re-exports the vendored gem artefacts, both stamped with the version they came from', () => {
    // The two are generated from one gem checkout, so a regeneration that updated only one of them
    // would pair a theme with descriptors that no longer describe it.
    expect(DEFAULT_THEME_YAML).toContain('font:');
    expect(DEFAULT_THEME_GEM_VERSION).toBe(THEME_DESCRIPTOR_GEM_VERSION);
  });

  it('re-exports the theme-path rules that live in the asciidoc-core leaf', () => {
    // These are re-exported from another package rather than defined here, which is exactly the kind
    // of indirection a refactor drops silently.
    expect(THEME_FILENAME_CONVENTION).toBe('*-theme.yml');
    expect(isThemeFilePath('branding/corporate-theme.yml')).toBe(true);
    expect(isThemeFilePath('branding/notes.yml')).toBe(false);
    expect(themeFilePaths(['b-theme.yml', 'readme.adoc', 'a-theme.yml'])).toEqual([
      'a-theme.yml',
      'b-theme.yml',
    ]);
    expect(resolveThemePath(undefined, ['b-theme.yml', 'a-theme.yml'])).toBe('a-theme.yml');
    expect(resolveThemePath('b-theme.yml', ['a-theme.yml'])).toBe('b-theme.yml');
  });
});
