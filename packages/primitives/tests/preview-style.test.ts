import { PREVIEW_STYLE_VALUES, isPreviewStyleValue } from '../src/preview-style';

describe('preview style tokens', () => {
  it('offers the brand style first so it reads as the default in any list built from this order', () => {
    expect(PREVIEW_STYLE_VALUES[0]).toBe('asciidocollab');
  });

  it('recognises every token it publishes', () => {
    for (const token of PREVIEW_STYLE_VALUES) {
      expect(isPreviewStyleValue(token)).toBe(true);
    }
  });

  it('publishes the three styles the preview offers', () => {
    expect(PREVIEW_STYLE_VALUES).toEqual(['asciidocollab', 'asciidoctor', 'print']);
  });

  it('rejects a token that is not published', () => {
    expect(isPreviewStyleValue('rouge')).toBe(false);
    expect(isPreviewStyleValue('')).toBe(false);
    expect(isPreviewStyleValue('Asciidoctor')).toBe(false);
  });

  it('rejects inherited Object members, which a bare property lookup would accept', () => {
    expect(isPreviewStyleValue('constructor')).toBe(false);
    expect(isPreviewStyleValue('toString')).toBe(false);
  });
});
