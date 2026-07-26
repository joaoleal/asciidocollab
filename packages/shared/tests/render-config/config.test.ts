import {
  normalizeRenderConfig,
  safeNormalizeRenderConfig,
  renderConfigSchema,
  PINNED_ATTRIBUTE_KEYS,
  PDF_PAGE_SIZES,
  EMPTY_RENDER_CONFIG,
  HTML_EXPORT_PACKAGINGS,
  HTML_EXPORT_STYLES,
  HTML_EXPORT_THEMES,
  DEFAULT_HTML_EXPORT_PACKAGING,
  DEFAULT_HTML_EXPORT_THEME,
  resolveRenderAttributes,
} from '../../src/render-config';

describe('renderConfigSchema / normalizeRenderConfig', () => {
  it('accepts an empty config', () => {
    expect(normalizeRenderConfig({})).toEqual({});
    expect(EMPTY_RENDER_CONFIG).toEqual({});
  });

  it('accepts a fully populated config', () => {
    const config = {
      doctype: 'book',
      toc: true,
      toclevels: 3,
      sectnums: true,
      sectnumlevels: 2,
      icons: 'font',
      experimental: true,
      hardbreaks: false,
      grammarCheckEnabled: true,
      imagesdir: 'images',
      extraFontDirs: ['assets/fonts', 'branding/fonts'],
      bibtexFile: 'refs.bib',
      bibtexStyle: 'ieee',
      bibtexOrder: 'alphabetical',
      pdfTheme: 'acme',
      media: 'prepress',
      pdfPageSize: 'A4',
      pdfPageLayout: 'landscape',
      hyphens: true,
      autofit: true,
      pdfFolioPlacement: 'physical',
      customAttributes: { company: 'Acme', version: '1.0' },
    } as const;
    expect(normalizeRenderConfig(config)).toEqual(config);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const result = safeNormalizeRenderConfig({ notAnOption: true });
    expect(result.success).toBe(false);
  });

  it('accepts a boolean grammarCheckEnabled and rejects a non-boolean', () => {
    expect(safeNormalizeRenderConfig({ grammarCheckEnabled: true }).success).toBe(true);
    expect(safeNormalizeRenderConfig({ grammarCheckEnabled: false }).success).toBe(true);
    expect(safeNormalizeRenderConfig({ grammarCheckEnabled: 'yes' }).success).toBe(false);
    // Absent is valid — the web layer resolves the default for English projects.
    expect(safeNormalizeRenderConfig({}).success).toBe(true);
  });

  it('accepts the supported grammar dialects and rejects others', () => {
    expect(safeNormalizeRenderConfig({ grammarDialect: 'en-GB' }).success).toBe(true);
    expect(safeNormalizeRenderConfig({ grammarDialect: 'en-US' }).success).toBe(true);
    expect(safeNormalizeRenderConfig({ grammarDialect: 'en' }).success).toBe(false);
    expect(safeNormalizeRenderConfig({ grammarDialect: 'fr-FR' }).success).toBe(false);
  });

  it('rejects an out-of-range toclevels', () => {
    expect(safeNormalizeRenderConfig({ toclevels: 6 }).success).toBe(false);
    expect(safeNormalizeRenderConfig({ toclevels: 0 }).success).toBe(false);
  });

  it('allows sectnumlevels of 0 but rejects 6', () => {
    expect(safeNormalizeRenderConfig({ sectnumlevels: 0 }).success).toBe(true);
    expect(safeNormalizeRenderConfig({ sectnumlevels: 6 }).success).toBe(false);
  });

  it('rejects an unknown enum value', () => {
    expect(safeNormalizeRenderConfig({ doctype: 'manpage' }).success).toBe(false);
    expect(safeNormalizeRenderConfig({ media: 'web' }).success).toBe(false);
    expect(safeNormalizeRenderConfig({ pdfPageSize: 'B5' }).success).toBe(false);
  });

  it('accepts every advertised page size', () => {
    for (const size of PDF_PAGE_SIZES) {
      expect(safeNormalizeRenderConfig({ pdfPageSize: size }).success).toBe(true);
    }
  });

  it('caps the number of custom attributes', () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 101; index += 1) {
      many[`attr${index}`] = 'value';
    }
    expect(safeNormalizeRenderConfig({ customAttributes: many }).success).toBe(false);
  });

  it('caps the number of extra font dirs', () => {
    const directories = Array.from({ length: 21 }, (_unused, index) => `fonts/${index}`);
    expect(safeNormalizeRenderConfig({ extraFontDirs: directories }).success).toBe(false);
  });

  it('rejects an empty font-dir entry', () => {
    expect(safeNormalizeRenderConfig({ extraFontDirs: [''] }).success).toBe(false);
  });

  it('accepts an extension selection', () => {
    const config = { extensions: { enabled: ['paragraph-numbering', 'per-chapter-contents'] } };
    expect(normalizeRenderConfig(config)).toEqual(config);
    expect(safeNormalizeRenderConfig({ extensions: {} }).success).toBe(true);
    expect(safeNormalizeRenderConfig({ extensions: { enabled: [] } }).success).toBe(true);
  });

  it('enables nothing for a config that predates extensions (T061, FR-032g, SC-012b)', () => {
    // Every project created before this feature has a config with no `extensions` key, and adding an
    // extension to a deployment must not change what any of them render. So the absent case has to
    // mean "nothing enabled" and never "whatever the deployment now offers" — the opt-in has to be
    // in the SCHEMA, not only in the UI that writes it, because the renderer reads the config
    // directly and never sees the toggle.
    const predatesExtensions = { doctype: 'book', toc: true, pdfPageSize: 'A4' };
    expect(normalizeRenderConfig(predatesExtensions).extensions).toBeUndefined();
    // And an empty selection is not silently upgraded into one either.
    expect(normalizeRenderConfig({ extensions: { enabled: [] } }).extensions?.enabled).toEqual([]);
  });

  it('keeps an enabled id it does not recognise', () => {
    // An administrator can remove an extension a project still has enabled. That selection has to
    // survive normalisation so the owner can be told about it; silently filtering it here would
    // erase the very state the stale-selection warning exists to report.
    const config = { extensions: { enabled: ['an-extension-nobody-ships'] } };
    expect(normalizeRenderConfig(config)).toEqual(config);
  });

  it('rejects an extension id shaped like a path', () => {
    // An id is resolved by catalogue lookup, never joined onto a filesystem path. Refusing
    // separators at the boundary means a selection can never be read as one.
    expect(safeNormalizeRenderConfig({ extensions: { enabled: ['../../etc/passwd'] } }).success).toBe(
      false,
    );
    expect(safeNormalizeRenderConfig({ extensions: { enabled: ['nested/id'] } }).success).toBe(false);
    expect(safeNormalizeRenderConfig({ extensions: { enabled: ['with space'] } }).success).toBe(false);
    expect(safeNormalizeRenderConfig({ extensions: { enabled: [''] } }).success).toBe(false);
  });

  it('caps the number of enabled extensions', () => {
    const many = Array.from({ length: 101 }, (_unused, index) => `extension-${index}`);
    expect(safeNormalizeRenderConfig({ extensions: { enabled: many } }).success).toBe(false);
  });

  it('rejects unknown keys inside the extension selection (strict)', () => {
    expect(
      safeNormalizeRenderConfig({ extensions: { enabled: [], code: 'puts 1' } }).success,
    ).toBe(false);
  });

  it('trims string option values', () => {
    expect(normalizeRenderConfig({ imagesdir: '  images  ' }).imagesdir).toBe('images');
  });

  it('throws on invalid input via the throwing entry point', () => {
    expect(() => normalizeRenderConfig({ toclevels: 99 })).toThrow();
  });

  it('exposes the pinned attribute blocklist including engine-pinned + security keys', () => {
    for (const key of ['base_dir', 'pdf-fontsdir', 'pdf-themesdir', 'source-highlighter', 'safe', 'allow-uri-read']) {
      expect(PINNED_ATTRIBUTE_KEYS.has(key)).toBe(true);
    }
  });

  it('is the same schema object exported for the API to reuse', () => {
    expect(renderConfigSchema.safeParse({}).success).toBe(true);
  });
});

describe('renderConfigSchema — htmlExport', () => {
  it('accepts both packaging values and rejects anything else', () => {
    expect(safeNormalizeRenderConfig({ htmlExport: { packaging: 'single-file' } }).success).toBe(true);
    expect(safeNormalizeRenderConfig({ htmlExport: { packaging: 'zip' } }).success).toBe(true);
    expect(safeNormalizeRenderConfig({ htmlExport: { packaging: 'tarball' } }).success).toBe(false);
  });

  it('accepts every theme value and rejects anything else', () => {
    for (const theme of HTML_EXPORT_THEMES) {
      expect(safeNormalizeRenderConfig({ htmlExport: { theme } }).success).toBe(true);
    }
    expect(safeNormalizeRenderConfig({ htmlExport: { theme: 'sepia' } }).success).toBe(false);
  });

  it('accepts both styles and rejects anything else', () => {
    for (const style of HTML_EXPORT_STYLES) {
      expect(safeNormalizeRenderConfig({ htmlExport: { style } }).success).toBe(true);
    }
    expect(safeNormalizeRenderConfig({ htmlExport: { style: 'github' } }).success).toBe(false);
  });

  it('leaves style absent when unset — that is what "follow the exporter\'s own preview" looks like', () => {
    expect(normalizeRenderConfig({ htmlExport: { packaging: 'zip' } }).htmlExport?.style).toBeUndefined();
  });

  it('treats the section and each field as optional', () => {
    expect(normalizeRenderConfig({}).htmlExport).toBeUndefined();
    expect(normalizeRenderConfig({ htmlExport: {} }).htmlExport).toEqual({});
    expect(normalizeRenderConfig({ htmlExport: { theme: 'auto' } }).htmlExport).toEqual({ theme: 'auto' });
  });

  it('rejects unknown keys inside the section, so a typo cannot be stored and silently ignored', () => {
    expect(safeNormalizeRenderConfig({ htmlExport: { packagin: 'zip' } }).success).toBe(false);
  });

  it('emits NO Asciidoctor attribute — it describes the exported file, not the document', () => {
    const resolved = resolveRenderAttributes(
      normalizeRenderConfig({ htmlExport: { packaging: 'zip', theme: 'dark', style: 'asciidoctor' } }),
    );
    expect(resolved.attributes).toEqual({});
  });

  it('defaults name a packaging and theme that are both valid schema values', () => {
    expect(HTML_EXPORT_PACKAGINGS).toContain(DEFAULT_HTML_EXPORT_PACKAGING);
    expect(HTML_EXPORT_THEMES).toContain(DEFAULT_HTML_EXPORT_THEME);
  });
});
