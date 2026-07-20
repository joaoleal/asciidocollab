import {
  computeThemeValuePreviews,
  themeColourToCss,
} from '@/lib/codemirror/theme/theme-value-widgets';

describe('themeColourToCss', () => {
  it('accepts the bare hex form the theming guide uses', () => {
    expect(themeColourToCss('333333')).toBe('#333333');
    expect(themeColourToCss('428BCA')).toBe('#428BCA');
  });

  it('accepts a hash prefix', () => {
    expect(themeColourToCss('#428BCA')).toBe('#428BCA');
  });

  it('expands the three-digit shorthand', () => {
    expect(themeColourToCss('#abc')).toBe('#aabbcc');
  });

  it('accepts transparent', () => {
    expect(themeColourToCss('transparent')).toBe('transparent');
    expect(themeColourToCss('TRANSPARENT')).toBe('transparent');
  });

  it('converts a CMYK array so print themes get a swatch too', () => {
    expect(themeColourToCss('[0, 0, 0, 100]')).toBe('rgb(0, 0, 0)');
    expect(themeColourToCss('[0, 0, 0, 0]')).toBe('rgb(255, 255, 255)');
  });

  it('ignores surrounding quotes', () => {
    expect(themeColourToCss("'333333'")).toBe('#333333');
  });

  it('refuses a value it cannot render faithfully', () => {
    // A wrong colour shown with the authority of a rendered swatch is worse than no swatch.
    expect(themeColourToCss('$base-font-color')).toBeNull();
    expect(themeColourToCss('dark-blue')).toBeNull();
    expect(themeColourToCss('33333')).toBeNull();
    expect(themeColourToCss('')).toBeNull();
  });

  it('refuses a CMYK array with an out-of-range component', () => {
    expect(themeColourToCss('[0, 0, 0, 300]')).toBeNull();
  });
});

describe('computeThemeValuePreviews', () => {
  it('previews a colour value', () => {
    const text = 'base:\n  font-color: 333333';
    const previews = computeThemeValuePreviews(text);
    expect(previews).toHaveLength(1);
    expect(text.slice(previews[0].from, previews[0].to)).toBe('333333');
  });

  it('previews a font family', () => {
    const text = 'base:\n  font-family: Noto Serif';
    const previews = computeThemeValuePreviews(text);
    expect(previews).toHaveLength(1);
    expect(text.slice(previews[0].from, previews[0].to)).toBe('Noto Serif');
  });

  it('covers exactly the value, never the key or the colon', () => {
    const text = 'link:\n  font-color: 428BCA';
    const [preview] = computeThemeValuePreviews(text);
    expect(text.slice(preview.from, preview.to)).toBe('428BCA');
  });

  it('leaves a value it cannot resolve undecorated', () => {
    expect(computeThemeValuePreviews('heading:\n  font-color: $base-font-color')).toEqual([]);
    expect(computeThemeValuePreviews('base:\n  font-family: $codespan-font-family')).toEqual([]);
  });

  it('previews nothing for a setting that is neither a colour nor a font', () => {
    expect(computeThemeValuePreviews('page:\n  layout: landscape')).toEqual([]);
    expect(computeThemeValuePreviews('base:\n  font-size: 10.5')).toEqual([]);
  });

  it('previews nothing for a key the renderer does not recognise', () => {
    // Without a descriptor there is no basis for calling the value a colour.
    expect(computeThemeValuePreviews('made-up-color: 333333')).toEqual([]);
  });

  it('stops at the comment, so a swatch never swallows one', () => {
    const text = 'base:\n  font-color: #333333  # body text';
    const [preview] = computeThemeValuePreviews(text);
    expect(text.slice(preview.from, preview.to)).toBe('#333333');
  });

  it('previews every value in a realistic theme, in document order', () => {
    const text = [
      'page:',
      '  layout: portrait',
      'base:',
      '  font-family: Noto Serif',
      '  font-color: 333333',
      'link:',
      '  font-color: 428BCA',
    ].join('\n');
    const previews = computeThemeValuePreviews(text);
    expect(previews.map((p) => text.slice(p.from, p.to))).toEqual([
      'Noto Serif',
      '333333',
      '428BCA',
    ]);
  });
});
