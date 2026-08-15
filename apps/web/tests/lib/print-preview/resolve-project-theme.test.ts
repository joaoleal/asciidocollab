import { resolveThemePath } from '@asciidocollab/shared';
import { resolveProjectTheme } from '@/lib/print-preview/resolve-project-theme';

const THEME = 'extends: default\nbase:\n  font_color: 3C763D\n';

describe('choosing the theme the preview dresses the page in', () => {
  test('a project with no theme file resolves to nothing at all', () => {
    expect(resolveProjectTheme({ files: { 'doc.adoc': '= Doc' } })).toEqual({});
  });

  test('the single theme file in the project is the one applied', () => {
    const theme = resolveProjectTheme({
      files: { 'doc.adoc': '= Doc', 'brand-theme.yml': THEME },
    });
    expect(theme).toEqual({ themePath: 'brand-theme.yml', themeText: THEME });
  });

  test('with two theme files, the preview picks the one the export picks', () => {
    // Not "the same idea as" the export's rule — the same function. A preview with a rule of its own
    // would agree until a project had two themes, then confidently show an appearance nothing exports.
    const files = { 'z-theme.yml': 'z', 'a-theme.yml': 'a', 'doc.adoc': '= Doc' };
    const theme = resolveProjectTheme({ files });
    expect(theme.themePath).toBe(resolveThemePath(undefined, Object.keys(files)));
    expect(theme.themeText).toBe('a');
  });

  test('an explicit selection wins over the automatic choice', () => {
    const theme = resolveProjectTheme({
      files: { 'a-theme.yml': 'a', 'chosen-theme.yml': 'chosen' },
      declaredThemePath: 'chosen-theme.yml',
    });
    expect(theme.themePath).toBe('chosen-theme.yml');
    expect(theme.themeText).toBe('chosen');
  });

  test('a selection naming a file the project does not contain is no theme, not a dangling path', () => {
    // A path with nothing behind it would resolve to the default appearance anyway, but by way of an
    // "unreadable theme" report about a document the author never wrote. The export calls this case
    // "no theme"; so does this.
    expect(
      resolveProjectTheme({ files: { 'a-theme.yml': 'a' }, declaredThemePath: '../../etc/passwd' }),
    ).toEqual({});
    expect(
      resolveProjectTheme({ files: { 'a-theme.yml': 'a' }, declaredThemePath: 'missing-theme.yml' }),
    ).toEqual({});
  });

  test('a blank selection falls back to the automatic choice rather than blocking it', () => {
    const theme = resolveProjectTheme({
      files: { 'a-theme.yml': 'a' },
      declaredThemePath: '   ',
    });
    expect(theme.themePath).toBe('a-theme.yml');
  });

  test('an empty theme file is still the theme, and still resolves to its own path', () => {
    // Emptiness is the author's business — the resolver downstream treats it as "no theme applied",
    // and reports nothing, because an empty document holds no mistake to report.
    expect(resolveProjectTheme({ files: { 'a-theme.yml': '' } })).toEqual({
      themePath: 'a-theme.yml',
      themeText: '',
    });
  });

  test('a file whose name only looks theme-adjacent is not a theme', () => {
    expect(resolveProjectTheme({ files: { 'theme.yml': 'x', 'themes.yaml': 'y' } })).toEqual({});
  });
});
