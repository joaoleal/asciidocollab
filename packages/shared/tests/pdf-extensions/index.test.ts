import {
  compareExtensionIds,
  pdfExtensionManifestSchema,
  pdfExtensionThemeKeySchema,
  pdfExtensionOriginSchema,
  themeValueKindSchema,
} from '../../src/pdf-extensions';

// Covers the pdf-extensions barrel re-export itself (its value getters), not just `./manifest`
// directly — otherwise the barrel's re-exported runtime bindings register as uncovered functions.
// The four schemas below are the ones every ring outside this package validates against, so they are
// only reachable through this barrel; a dropped re-export is a break nothing else would catch.
describe('pdf-extensions barrel re-exports', () => {
  it('re-exports the constituent schemas as usable Zod schemas', () => {
    expect(pdfExtensionOriginSchema.parse('shipped')).toBe('shipped');
    expect(pdfExtensionOriginSchema.safeParse('project').success).toBe(false);
    expect(themeValueKindSchema.parse('colour')).toBe('colour');
    expect(themeValueKindSchema.safeParse('colr').success).toBe(false);
    expect(
      pdfExtensionThemeKeySchema.parse({
        key: 'paragraph-numbering.font-color',
        valueKind: 'colour',
        description: 'Colour of the generated paragraph number.',
      }),
    ).toMatchObject({ key: 'paragraph-numbering.font-color' });
  });

  it('re-exports the whole-manifest schema', () => {
    expect(
      pdfExtensionManifestSchema.parse({
        id: 'paragraph-numbering',
        displayName: 'Paragraph numbering',
        description: 'Numbers each paragraph sequentially in document order.',
        targeting: '[.numbered]',
        themeKeys: [],
        sampleContent: '[.numbered]\nA paragraph.\n',
      }),
    ).toMatchObject({ id: 'paragraph-numbering' });
  });

  it('re-exports the id comparison the catalogue is ordered by', () => {
    // Reached only through this barrel outside the package, and load order changes what a PDF looks
    // like — so an id comparison the barrel stopped exposing would silently fall back to whatever
    // order a caller's own sort happened to produce.
    expect(compareExtensionIds('alpha', 'beta')).toBe(-1);
    expect(compareExtensionIds('beta', 'alpha')).toBe(1);
    expect(compareExtensionIds('alpha', 'alpha')).toBe(0);
    // The hyphen orders by code unit, not by a locale that may treat it as ignorable punctuation.
    expect(compareExtensionIds('title-block', 'titleblock')).toBe(-1);
  });
});
