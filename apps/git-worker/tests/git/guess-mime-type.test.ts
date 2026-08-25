import { DEFAULT_MIME_TYPE, guessMimeType } from '../../src/git/guess-mime-type.js';

describe('guessMimeType', () => {
  it('maps an AsciiDoc extension to its MIME type', () => {
    expect(guessMimeType('chapters/intro.adoc')).toBe('text/asciidoc');
  });

  it('maps a common image extension to its MIME type', () => {
    expect(guessMimeType('assets/logo.png')).toBe('image/png');
  });

  it('matches the extension case-insensitively', () => {
    expect(guessMimeType('assets/LOGO.PNG')).toBe('image/png');
  });

  it('falls back to a generic binary type for an unrecognized extension', () => {
    expect(guessMimeType('data/archive.xyz')).toBe(DEFAULT_MIME_TYPE);
  });

  it('falls back to a generic binary type for a file with no extension', () => {
    expect(guessMimeType('LICENSE')).toBe(DEFAULT_MIME_TYPE);
  });
});
