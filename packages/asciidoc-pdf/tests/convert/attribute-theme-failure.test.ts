import { attributeThemeFailure } from '../../src/convert/invoke';

const THEME = 'branding/corporate-theme.yml';

describe('attributeThemeFailure', () => {
  it('names the theme file and the line for a YAML syntax error', () => {
    // Psych is handed a string, not a path, so its own message says `(<unknown>)`. Without this the
    // author is told only that something was malformed at line 12 — in which of their files, they
    // are left to guess.
    const raw = "(<unknown>): mapping values are not allowed in this context at line 12 column 5";
    expect(attributeThemeFailure(raw, THEME)).toBe(
      `The PDF theme ${THEME}, line 12 could not be read: ${raw}`,
    );
  });

  it('recognises the several shapes Psych reports', () => {
    for (const raw of [
      'Psych::SyntaxError: something went wrong',
      "did not find expected key while parsing a block mapping at line 3 column 1",
      "could not find expected ':' while scanning a simple key at line 8 column 2",
    ]) {
      expect(attributeThemeFailure(raw, THEME)).toContain(THEME);
    }
  });

  it('names the file alone when the parser located no position', () => {
    expect(attributeThemeFailure('Psych::SyntaxError: broken', THEME)).toBe(
      `The PDF theme ${THEME} could not be read: Psych::SyntaxError: broken`,
    );
  });

  it('passes through a failure that is not a YAML problem', () => {
    // Attributing a message we are not sure about points the author at the wrong file, which is
    // worse than the vague message they started with.
    const raw = 'undefined method `foo` for nil:NilClass';
    expect(attributeThemeFailure(raw, THEME)).toBe(raw);
  });

  it('passes through everything when the project defines no theme', () => {
    const raw = 'did not find expected key at line 3 column 1';
    expect(attributeThemeFailure(raw, undefined)).toBe(raw);
  });

  it('leaves an already-clear message unchanged', () => {
    expect(attributeThemeFailure('Document is empty', THEME)).toBe('Document is empty');
  });
});
