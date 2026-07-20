import {
  resolveRenderAttributes,
  stripSoftDefault,
  SOFT_DEFAULT_SUFFIX,
  RENDER_OPTION_CATALOG,
  PINNED_ATTRIBUTE_KEYS,
  type RenderConfig,
} from '../../src/render-config';

describe('resolveRenderAttributes', () => {
  it('emits nothing for an empty config', () => {
    const { attributes, extraFontDirs } = resolveRenderAttributes({});
    expect(attributes).toEqual({});
    expect(extraFontDirs).toEqual([]);
  });

  it('marks every emitted value as an overridable soft-default', () => {
    const { attributes } = resolveRenderAttributes({ doctype: 'book', toclevels: 2 });
    expect(attributes.doctype).toBe(`book${SOFT_DEFAULT_SUFFIX}`);
    expect(attributes.toclevels).toBe(`2${SOFT_DEFAULT_SUFFIX}`);
  });

  it('maps a true flag to an empty, soft-defaulted value and omits a false flag', () => {
    const on = resolveRenderAttributes({ toc: true, sectnums: false });
    expect(on.attributes.toc).toBe(SOFT_DEFAULT_SUFFIX);
    expect(on.attributes).not.toHaveProperty('sectnums');
  });

  it('maps icons=image to the empty (image-admonition) value and icons=font to font', () => {
    expect(resolveRenderAttributes({ icons: 'image' }).attributes.icons).toBe(SOFT_DEFAULT_SUFFIX);
    expect(resolveRenderAttributes({ icons: 'font' }).attributes.icons).toBe(`font${SOFT_DEFAULT_SUFFIX}`);
  });

  it('maps hyphenated PDF + bibtex attribute names', () => {
    const { attributes } = resolveRenderAttributes({
      pdfTheme: 'acme',
      pdfPageSize: 'A4',
      pdfPageLayout: 'landscape',
      pdfFolioPlacement: 'physical',
      autofit: true,
      hyphens: true,
      media: 'print',
      bibtexFile: 'refs.bib',
      bibtexStyle: 'ieee',
      bibtexOrder: 'appearance',
    });
    expect(attributes['pdf-theme']).toBe(`acme${SOFT_DEFAULT_SUFFIX}`);
    expect(attributes['pdf-page-size']).toBe(`A4${SOFT_DEFAULT_SUFFIX}`);
    expect(attributes['pdf-page-layout']).toBe(`landscape${SOFT_DEFAULT_SUFFIX}`);
    expect(attributes['pdf-folio-placement']).toBe(`physical${SOFT_DEFAULT_SUFFIX}`);
    expect(attributes['autofit-option']).toBe(SOFT_DEFAULT_SUFFIX);
    expect(attributes.hyphens).toBe(SOFT_DEFAULT_SUFFIX);
    expect(attributes.media).toBe(`print${SOFT_DEFAULT_SUFFIX}`);
    expect(attributes['bibtex-file']).toBe(`refs.bib${SOFT_DEFAULT_SUFFIX}`);
    expect(attributes['bibtex-style']).toBe(`ieee${SOFT_DEFAULT_SUFFIX}`);
    expect(attributes['bibtex-order']).toBe(`appearance${SOFT_DEFAULT_SUFFIX}`);
  });

  it('passes custom attributes through as soft-defaults, lower-casing the name', () => {
    const { attributes } = resolveRenderAttributes({ customAttributes: { Company: 'Acme', VERSION: '1.0' } });
    expect(attributes.company).toBe(`Acme${SOFT_DEFAULT_SUFFIX}`);
    expect(attributes.version).toBe(`1.0${SOFT_DEFAULT_SUFFIX}`);
  });

  it('drops custom attributes that collide with a pinned attribute name', () => {
    const { attributes } = resolveRenderAttributes({
      customAttributes: { 'pdf-fontsdir': '/etc', base_dir: '/', 'source-highlighter': 'pygments' },
    });
    expect(attributes).toEqual({});
  });

  it('lets a curated option win over a colliding custom attribute', () => {
    const { attributes } = resolveRenderAttributes({
      imagesdir: 'images',
      customAttributes: { imagesdir: 'evil' },
    });
    expect(attributes.imagesdir).toBe(`images${SOFT_DEFAULT_SUFFIX}`);
  });

  it('drops the docinfo family (a raw-HTML injection vector) as pinned', () => {
    const { attributes } = resolveRenderAttributes({
      customAttributes: { docinfo: '', docinfo1: '', docinfo2: '', docinfodir: 'meta' },
    });
    expect(attributes).toEqual({});
  });

  it('emits a custom attribute whose name shadows an Object.prototype member', () => {
    const { attributes } = resolveRenderAttributes({
      customAttributes: { toString: 'x', constructor: 'y' },
    });
    expect(attributes.tostring).toBe(`x${SOFT_DEFAULT_SUFFIX}`);
    expect(attributes.constructor).toBe(`y${SOFT_DEFAULT_SUFFIX}`);
  });

  it('returns the extra font dirs verbatim as a fresh array', () => {
    const config: RenderConfig = { extraFontDirs: ['assets/fonts'] };
    const { extraFontDirs } = resolveRenderAttributes(config);
    expect(extraFontDirs).toEqual(['assets/fonts']);
    expect(extraFontDirs).not.toBe(config.extraFontDirs);
  });

  it('never emits an attribute in the pinned blocklist from the catalog', () => {
    for (const descriptor of RENDER_OPTION_CATALOG) {
      expect(PINNED_ATTRIBUTE_KEYS.has(descriptor.attribute)).toBe(false);
    }
  });

  it('emits no attribute for an extension selection', () => {
    // Extensions are loaded by the renderer from the deployment; they are not an attribute channel.
    // If a selection ever resolved to an attribute it would become a second route to the pinned keys
    // the blocklist exists to protect.
    const { attributes } = resolveRenderAttributes({
      extensions: { enabled: ['paragraph-numbering'] },
    });
    expect(attributes).toEqual({});
  });
});

describe('stripSoftDefault', () => {
  it('removes a single trailing marker', () => {
    expect(stripSoftDefault(`images${SOFT_DEFAULT_SUFFIX}`)).toBe('images');
  });

  it('removes only one marker and leaves a raw value untouched', () => {
    expect(stripSoftDefault('images')).toBe('images');
    expect(stripSoftDefault(`x${SOFT_DEFAULT_SUFFIX}${SOFT_DEFAULT_SUFFIX}`)).toBe(`x${SOFT_DEFAULT_SUFFIX}`);
  });

  it('recovers the empty value from a bare marker', () => {
    expect(stripSoftDefault(SOFT_DEFAULT_SUFFIX)).toBe('');
  });
});
