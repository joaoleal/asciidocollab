import { collectReferencedAssetPaths } from '@/lib/pdf/collect-referenced-assets';
import { resolveImageTarget } from '@/lib/asciidoc/include-path';

const attributes = (entries: Record<string, string> = {}): ReadonlyMap<string, string> =>
  new Map(Object.entries(entries));

describe('collectReferencedAssetPaths', () => {
  describe('image enumeration', () => {
    it('collects block and inline image macro targets, de-duplicated and sorted', () => {
      const paths = collectReferencedAssetPaths({
        files: {
          'main.adoc': '= T\n\nimage::diagrams/flow.png[]\n\nText with an image:icons/logo.svg[Logo] inline.',
          'ch/one.adoc': 'image::diagrams/flow.png[]', // duplicate of the block macro above
        },
        attributes: attributes(),
      });
      expect(paths).toEqual(['diagrams/flow.png', 'icons/logo.svg']);
    });

    it('resolves a target through :imagesdir: exactly as the engine will', () => {
      const attributeMap = attributes({ imagesdir: 'assets/img' });
      const paths = collectReferencedAssetPaths({
        files: { 'main.adoc': 'image::pic.png[]' },
        attributes: attributeMap,
      });
      const resolved = resolveImageTarget('pic.png', attributeMap);
      expect(resolved.ok).toBe(true);
      expect(paths).toEqual([resolved.ok ? resolved.path : '']);
      expect(paths).toEqual(['assets/img/pic.png']);
    });

    // The exact scenario in the bug report: a space-bearing path must round-trip and match the key
    // the render engine resolves the macro to (proved against resolveImageTarget).
    it('preserves a space-bearing image path and matches resolveImageTarget', () => {
      const target = 'New Folder/Screenshot_20260608_164409.png';
      const paths = collectReferencedAssetPaths({
        files: { 'main.adoc': `image::${target}[]` },
        attributes: attributes(),
      });
      const resolved = resolveImageTarget(target, attributes());
      expect(paths).toEqual([resolved.ok ? resolved.path : '']);
      expect(paths).toEqual([target]);
    });

    it('never returns a remote, data-URI, or traversal target (no-egress)', () => {
      const paths = collectReferencedAssetPaths({
        files: {
          'main.adoc': [
            'image::https://cdn.example.com/remote.png[]',
            'image::data:image/png;base64,AAAA[]',
            'image::../../etc/passwd.png[]',
            'image::local/ok.png[]',
          ].join('\n'),
        },
        attributes: attributes(),
      });
      expect(paths).toEqual(['local/ok.png']);
    });

    it('ignores an image: substring that is part of a larger word', () => {
      const paths = collectReferencedAssetPaths({
        files: { 'main.adoc': 'the word preimage:not-a-macro[] is prose' },
        attributes: attributes(),
      });
      expect(paths).toEqual([]);
    });

    it('skips a whitespace-only image target', () => {
      const paths = collectReferencedAssetPaths({
        files: { 'main.adoc': 'image::   [Blank]' },
        attributes: attributes(),
      });
      expect(paths).toEqual([]);
    });
  });

  describe('theme font enumeration', () => {
    it('collects fonts a *-theme.yml catalog names, resolved relative to the theme directory', () => {
      const paths = collectReferencedAssetPaths({
        files: {
          'main.adoc': '= T',
          'themes/brand-theme.yml': [
            'font:',
            '  catalog:',
            '    Brand:',
            '      normal: fonts/brand-regular.ttf',
            '      bold: fonts/brand-bold.otf',
          ].join('\n'),
        },
        attributes: attributes(),
      });
      expect(paths).toEqual(['themes/fonts/brand-bold.otf', 'themes/fonts/brand-regular.ttf']);
    });

    it('honours an explicit :pdf-theme: attribute for font discovery', () => {
      const paths = collectReferencedAssetPaths({
        files: {
          'custom.yml': "font:\n  catalog:\n    Body:\n      normal: 'body.woff2'",
        },
        attributes: attributes({ 'pdf-theme': 'custom.yml' }),
      });
      expect(paths).toEqual(['body.woff2']);
    });

    it('returns nothing when no theme is present', () => {
      const paths = collectReferencedAssetPaths({ files: { 'main.adoc': '= T' }, attributes: attributes() });
      expect(paths).toEqual([]);
    });

    it('ignores an explicit :pdf-theme: that names a file not in the snapshot', () => {
      const paths = collectReferencedAssetPaths({
        files: { 'main.adoc': '= T' },
        attributes: attributes({ 'pdf-theme': 'themes/absent-theme.yml' }),
      });
      expect(paths).toEqual([]);
    });

    it('ignores an escaping :pdf-theme: without throwing', () => {
      const paths = collectReferencedAssetPaths({
        files: { 'main.adoc': '= T' },
        attributes: attributes({ 'pdf-theme': '../../etc/theme.yml' }),
      });
      expect(paths).toEqual([]);
    });

    it('skips a theme font token that escapes the sandbox', () => {
      const paths = collectReferencedAssetPaths({
        files: { 'brand-theme.yml': 'font:\n  catalog:\n    B:\n      normal: ../../secret/font.ttf' },
        attributes: attributes(),
      });
      expect(paths).toEqual([]);
    });
  });
});

describe('fonts the renderer supplies itself', () => {
  it('does not ask the project for a GEM_FONTS_DIR font', () => {
    // `GEM_FONTS_DIR/x.ttf` is a placeholder the renderer expands into its own bundle. It looks
    // like a project-relative path, so it passed the sandbox check and was reported as missing —
    // and the default theme (which every new theme is a copy of) names eight of them, so an author
    // met eight warnings about fonts that were being applied correctly.
    const paths = collectReferencedAssetPaths({
      files: {
        'theme.yml': [
          'font:',
          '  catalog:',
          '    Noto Serif:',
          '      normal: GEM_FONTS_DIR/notoserif-regular-subset.ttf',
          '    Brand:',
          '      normal: fonts/brand.ttf',
        ].join('\n'),
      },
      attributes: new Map([['pdf-theme', 'theme.yml']]),
    });
    // The project's own font is still collected — only the renderer-internal one is skipped.
    expect(paths).toEqual(['fonts/brand.ttf']);
  });
});
