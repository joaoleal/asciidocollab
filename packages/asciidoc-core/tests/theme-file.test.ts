import {
  isThemeFilePath,
  resolveThemePath,
  themeFilePaths,
  THEME_FILENAME_CONVENTION,
} from '../src';

describe('isThemeFilePath', () => {
  it('recognises the documented naming convention', () => {
    expect(isThemeFilePath('acme-theme.yml')).toBe(true);
    expect(isThemeFilePath('acme-theme.yaml')).toBe(true);
    expect(isThemeFilePath('branding/corporate-theme.yml')).toBe(true);
  });

  it('recognises a theme regardless of the case its name is written in', () => {
    // The editor and the renderer previously disagreed here: one lowercased only the extension, so
    // `Corporate-Theme.yml` was a theme to one surface and an ordinary YAML file to the other.
    expect(isThemeFilePath('Corporate-Theme.yml')).toBe(true);
    expect(isThemeFilePath('acme-THEME.YAML')).toBe(true);
  });

  it('rejects YAML that does not carry the theme suffix', () => {
    expect(isThemeFilePath('config.yml')).toBe(false);
    expect(isThemeFilePath('theme.yml')).toBe(false);
    expect(isThemeFilePath('themes/palette.yaml')).toBe(false);
  });

  it('rejects the theme suffix on a non-YAML extension', () => {
    expect(isThemeFilePath('acme-theme.json')).toBe(false);
    expect(isThemeFilePath('acme-theme.adoc')).toBe(false);
    expect(isThemeFilePath('acme-theme')).toBe(false);
  });

  it('matches on the final path segment only, never a directory name', () => {
    expect(isThemeFilePath('acme-theme.yml/notes.adoc')).toBe(false);
    expect(isThemeFilePath('my-theme.yaml/nested-theme.txt')).toBe(false);
  });

  it('does not require a name before the suffix', () => {
    // Both pre-existing implementations accepted this, so unifying them must not silently narrow it.
    expect(isThemeFilePath('-theme.yml')).toBe(true);
  });

  it('ignores content — recognition is by filename alone', () => {
    expect(isThemeFilePath('notes.adoc')).toBe(false);
  });

  it('publishes the convention it enforces, for display to authors', () => {
    expect(THEME_FILENAME_CONVENTION).toBe('*-theme.yml');
  });
});

describe('themeFilePaths', () => {
  it('keeps only theme documents, sorted', () => {
    expect(themeFilePaths(['z-theme.yml', 'notes.adoc', 'a-theme.yaml', 'config.yml'])).toEqual([
      'a-theme.yaml',
      'z-theme.yml',
    ]);
  });

  it('returns nothing for a project with no theme', () => {
    expect(themeFilePaths(['notes.adoc', 'config.yml'])).toEqual([]);
  });
});

describe('resolveThemePath', () => {
  const FILES = ['docs/intro.adoc', 'branding/corporate-theme.yml', 'acme-theme.yaml'];

  it('honours an explicit selection over any discovered file', () => {
    expect(resolveThemePath('branding/corporate-theme.yml', FILES)).toBe('branding/corporate-theme.yml');
  });

  it('returns an explicit selection even when it names no project file', () => {
    // Whether the path EXISTS is the caller's question — the renderer sandbox-checks it, the options
    // page reports it as missing. Resolution itself must not quietly substitute a different theme.
    expect(resolveThemePath('gone-theme.yml', FILES)).toBe('gone-theme.yml');
  });

  it('falls back to the first theme file in sorted order', () => {
    expect(resolveThemePath(undefined, FILES)).toBe('acme-theme.yaml');
    expect(resolveThemePath('', FILES)).toBe('acme-theme.yaml');
    expect(resolveThemePath('   ', FILES)).toBe('acme-theme.yaml');
  });

  it('picks the same theme regardless of the order the files arrive in', () => {
    // Determinism is the point: adding an unrelated file must not change which theme is applied.
    expect(resolveThemePath(undefined, [...FILES].toReversed())).toBe('acme-theme.yaml');
  });

  it('trims an explicit selection', () => {
    expect(resolveThemePath('  acme-theme.yaml  ', FILES)).toBe('acme-theme.yaml');
  });

  it('resolves to nothing when the project has no theme at all', () => {
    expect(resolveThemePath(undefined, ['notes.adoc'])).toBeUndefined();
  });
});
