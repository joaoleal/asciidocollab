import { PDF_RENDER_INTRINSIC_ATTRIBUTES } from '@/lib/asciidoc/render-intrinsics';
import { resolveImageTarget } from '@/lib/asciidoc/include-path';
import {
  buildProjectSnapshot,
  type BuildProjectSnapshotInput,
  type SnapshotFile,
} from '@/lib/pdf/build-project-snapshot';

const text = (path: string, content: string): SnapshotFile => ({ path, kind: 'text', content });
const binary = (path: string, bytes: Uint8Array): SnapshotFile => ({ path, kind: 'binary', bytes });
const attributes = (entries: Record<string, string> = {}): ReadonlyMap<string, string> =>
  new Map(Object.entries(entries));

const baseInput = (overrides: Partial<BuildProjectSnapshotInput> = {}): BuildProjectSnapshotInput => ({
  files: [],
  mainPath: null,
  openPath: 'main.adoc',
  attributes: attributes(),
  ...overrides,
});

describe('buildProjectSnapshot', () => {
  describe('text/binary partitioning', () => {
    it('routes text records to files and binary records to binaryAssets', () => {
      const png = new Uint8Array([1, 2, 3]);
      const { snapshot } = buildProjectSnapshot(
        baseInput({
          files: [
            text('main.adoc', '= Title\n\nBody'),
            text('chapters/intro.adoc', '== Intro'),
            binary('images/logo.png', png),
          ],
        }),
      );

      expect(snapshot.files).toEqual({
        'main.adoc': '= Title\n\nBody',
        'chapters/intro.adoc': '== Intro',
      });
      expect(snapshot.binaryAssets).toEqual({ 'images/logo.png': png });
      expect(snapshot.binaryAssets['images/logo.png']).toBe(png);
    });
  });

  describe('binary asset mounting (image path-match)', () => {
    // The placeholder bug is a path-match bug: the engine looks an image up at the path
    // `resolveImageTarget` resolves the macro to, so the bytes MUST be keyed identically. These tests
    // prove the key `buildProjectSnapshot` stores equals the engine's lookup key.
    it('keys a space-bearing image path identically to resolveImageTarget (no imagesdir)', () => {
      const png = new Uint8Array([1, 2, 3]);
      const resolved = resolveImageTarget('New Folder/Screenshot_20260608_164409.png', attributes());
      expect(resolved.ok).toBe(true);
      const key = resolved.ok ? resolved.path : '';

      const { snapshot } = buildProjectSnapshot(
        baseInput({ files: [text('main.adoc', `image::${'New Folder/Screenshot_20260608_164409.png'}[]`), binary(key, png)] }),
      );

      expect(key).toBe('New Folder/Screenshot_20260608_164409.png');
      expect(snapshot.binaryAssets[key]).toBe(png);
    });

    it('keys an imagesdir-relative image identically to resolveImageTarget', () => {
      const png = new Uint8Array([4, 5]);
      const attributeMap = attributes({ imagesdir: 'assets/img' });
      const resolved = resolveImageTarget('New Folder/pic.png', attributeMap);
      expect(resolved.ok).toBe(true);
      const key = resolved.ok ? resolved.path : '';

      const { snapshot } = buildProjectSnapshot(baseInput({ files: [binary(key, png)], attributes: attributeMap }));

      expect(key).toBe('assets/img/New Folder/pic.png');
      expect(snapshot.imagesDir).toBe('assets/img');
      expect(snapshot.binaryAssets[key]).toBe(png);
    });
  });

  describe('rootPath resolution', () => {
    it('prefers the main file path when present', () => {
      const { snapshot } = buildProjectSnapshot(
        baseInput({ mainPath: 'book.adoc', openPath: 'chapters/one.adoc' }),
      );
      expect(snapshot.rootPath).toBe('book.adoc');
      expect(snapshot.openPath).toBe('chapters/one.adoc');
    });

    it('falls back to the open file path when no main file is set', () => {
      const { snapshot } = buildProjectSnapshot(
        baseInput({ mainPath: null, openPath: 'chapters/one.adoc' }),
      );
      expect(snapshot.rootPath).toBe('chapters/one.adoc');
      expect(snapshot.openPath).toBe('chapters/one.adoc');
    });
  });

  describe('attribute merge', () => {
    it('seeds the PDF render-intrinsic attributes merged with the project attributes', () => {
      const { snapshot } = buildProjectSnapshot(
        baseInput({ attributes: attributes({ author: 'Ada', version: '2' }) }),
      );
      for (const [name, value] of PDF_RENDER_INTRINSIC_ATTRIBUTES) {
        expect(snapshot.attributes[name]).toBe(value);
      }
      expect(snapshot.attributes.author).toBe('Ada');
      expect(snapshot.attributes.version).toBe('2');
    });

    // These attributes reach the engine as API attributes, which OVERRIDE the document header. The
    // html5 intrinsic set used to be seeded here, so every PDF the app rendered was forced to
    // `doctype: article` and `backend: html5` — a book lost its title page and its chapters no
    // matter what its header said, and every `ifdef::backend-pdf[]` gate resolved to false.
    it('does not force a doctype or an html backend onto the document', () => {
      const { snapshot } = buildProjectSnapshot(baseInput({ attributes: attributes({}) }));
      expect(snapshot.attributes.doctype).toBeUndefined();
      expect(snapshot.attributes.backend).toBe('pdf');
      expect(snapshot.attributes['backend-html5']).toBeUndefined();
      expect(snapshot.attributes['doctype-article']).toBeUndefined();
    });

    it('lets a project attribute override an intrinsic default', () => {
      const { snapshot } = buildProjectSnapshot(baseInput({ attributes: attributes({ doctype: 'book' }) }));
      expect(snapshot.attributes.doctype).toBe('book');
    });
  });

  describe('imagesDir discovery', () => {
    it('captures the effective :imagesdir: attribute', () => {
      const { snapshot } = buildProjectSnapshot(baseInput({ attributes: attributes({ imagesdir: 'assets/img/' }) }));
      expect(snapshot.imagesDir).toBe('assets/img');
    });

    it('omits imagesDir when the attribute is unset', () => {
      const { snapshot } = buildProjectSnapshot(baseInput());
      expect(snapshot.imagesDir).toBeUndefined();
    });

    it('excludes and drops a remote :imagesdir:', () => {
      const { snapshot, excluded } = buildProjectSnapshot(
        baseInput({ attributes: attributes({ imagesdir: 'https://cdn.example.com/img' }) }),
      );
      expect(snapshot.imagesDir).toBeUndefined();
      expect(excluded).toContainEqual({ path: 'https://cdn.example.com/img', reason: 'remote' });
      // The rejected value is also stripped from the engine attribute map (defence in depth).
      expect(snapshot.attributes.imagesdir).toBeUndefined();
    });
  });

  describe('theme discovery', () => {
    it('uses an explicit :pdf-theme: attribute', () => {
      const { snapshot } = buildProjectSnapshot(
        baseInput({
          files: [text('themes/custom-theme.yml', 'font:')],
          attributes: attributes({ 'pdf-theme': 'themes/custom-theme.yml' }),
        }),
      );
      expect(snapshot.themePath).toBe('themes/custom-theme.yml');
    });

    it('auto-detects a *-theme.yml file when no attribute is set', () => {
      const { snapshot } = buildProjectSnapshot(
        baseInput({ files: [text('main.adoc', '= T'), text('brand-theme.yaml', 'base:')] }),
      );
      expect(snapshot.themePath).toBe('brand-theme.yaml');
    });

    it('auto-detects a theme whose name is capitalised', () => {
      // The file tree marks this as a theme and the asset collector resolves its fonts, so the
      // renderer has to agree — otherwise the author edits a theme that never reaches the export.
      const { snapshot } = buildProjectSnapshot(
        baseInput({ files: [text('main.adoc', '= T'), text('Corporate-Theme.yml', 'base:')] }),
      );
      expect(snapshot.themePath).toBe('Corporate-Theme.yml');
    });

    it('omits themePath when nothing matches', () => {
      const { snapshot } = buildProjectSnapshot(baseInput({ files: [text('main.adoc', '= T')] }));
      expect(snapshot.themePath).toBeUndefined();
    });

    it('omits themePath when a declared :pdf-theme: names a file the project does not contain', () => {
      // A sandbox-legal but absent declared theme must not become a themePath missing from `files`:
      // that would skip the alias mount and silently fall back to the default. The sibling collector
      // (collect-referenced-assets) already treats it as absent, so both must agree.
      const { snapshot } = buildProjectSnapshot(
        baseInput({
          files: [text('main.adoc', '= T')],
          attributes: attributes({ 'pdf-theme': 'themes/ghost-theme.yml' }),
        }),
      );
      expect(snapshot.themePath).toBeUndefined();
    });

    it('excludes and drops an escaping :pdf-theme:', () => {
      const { snapshot, excluded } = buildProjectSnapshot(
        baseInput({ attributes: attributes({ 'pdf-theme': '../../etc/theme.yml' }) }),
      );
      expect(snapshot.themePath).toBeUndefined();
      expect(excluded).toContainEqual({ path: '../../etc/theme.yml', reason: 'traversal' });
      expect(snapshot.attributes['pdf-theme']).toBeUndefined();
    });
  });

  describe('font discovery', () => {
    it('collects every binary asset with a font extension', () => {
      const ttf = new Uint8Array([0]);
      const otf = new Uint8Array([1]);
      const { snapshot } = buildProjectSnapshot(
        baseInput({
          files: [
            binary('fonts/body.ttf', ttf),
            binary('fonts/head.otf', otf),
            binary('images/pic.png', new Uint8Array([2])),
          ],
        }),
      );
      expect(snapshot.fontPaths).toEqual(['fonts/body.ttf', 'fonts/head.otf']);
    });

    it('returns an empty list when there are no fonts', () => {
      const { snapshot } = buildProjectSnapshot(baseInput());
      expect(snapshot.fontPaths).toEqual([]);
    });

    it('derives a WOFF2 custom font (the asset-mount stage converts it to TTF)', () => {
      const woff2 = new Uint8Array([7]);
      const { snapshot } = buildProjectSnapshot(baseInput({ files: [binary('fonts/brand.woff2', woff2)] }));
      expect(snapshot.fontPaths).toEqual(['fonts/brand.woff2']);
    });
  });

  describe('bib discovery', () => {
    it('uses an explicit :bibtex-file: attribute', () => {
      const { snapshot } = buildProjectSnapshot(
        baseInput({
          files: [text('refs/library.bib', '@book{x}')],
          attributes: attributes({ 'bibtex-file': 'refs/library.bib' }),
        }),
      );
      expect(snapshot.bibPath).toBe('refs/library.bib');
    });

    it('auto-detects a .bib file when no attribute is set', () => {
      const { snapshot } = buildProjectSnapshot(
        baseInput({ files: [text('main.adoc', '= T'), text('sources.bib', '@article{y}')] }),
      );
      expect(snapshot.bibPath).toBe('sources.bib');
    });

    it('omits bibPath when there is no bibliography', () => {
      const { snapshot } = buildProjectSnapshot(baseInput({ files: [text('main.adoc', '= T')] }));
      expect(snapshot.bibPath).toBeUndefined();
    });

    it('excludes an escaping :bibtex-file: and strips it from the attribute map', () => {
      const { snapshot, excluded } = buildProjectSnapshot(
        baseInput({ attributes: attributes({ 'bibtex-file': '../../etc/refs.bib' }) }),
      );
      expect(snapshot.bibPath).toBeUndefined();
      expect(excluded).toContainEqual({ path: '../../etc/refs.bib', reason: 'traversal' });
      expect(snapshot.attributes['bibtex-file']).toBeUndefined();
    });
  });

  describe('extra font directories', () => {
    it('captures sandbox-valid project-relative dirs', () => {
      const { snapshot } = buildProjectSnapshot(
        baseInput({ extraFontDirs: ['assets/fonts', 'branding/fonts'] }),
      );
      expect(snapshot.extraFontDirs).toEqual(['assets/fonts', 'branding/fonts']);
    });

    it('drops an escaping dir into excluded and omits extraFontDirs when all are dropped', () => {
      const { snapshot, excluded } = buildProjectSnapshot(baseInput({ extraFontDirs: ['../escape'] }));
      expect(snapshot.extraFontDirs).toBeUndefined();
      expect(excluded.some((entry) => entry.path === '../escape')).toBe(true);
    });

    it('omits extraFontDirs when none are configured', () => {
      const { snapshot } = buildProjectSnapshot(baseInput());
      expect(snapshot.extraFontDirs).toBeUndefined();
    });
  });

  describe('soft-default (@) handling', () => {
    it('strips the marker for path discovery but keeps it in the engine attributes', () => {
      const { snapshot } = buildProjectSnapshot(
        baseInput({
          files: [text('main.adoc', '= T'), text('themes/brand-theme.yml', 'x'), text('refs.bib', '@book{z}')],
          attributes: attributes({
            imagesdir: 'images@',
            'pdf-theme': 'themes/brand-theme.yml@',
            'bibtex-file': 'refs.bib@',
          }),
        }),
      );
      expect(snapshot.imagesDir).toBe('images');
      expect(snapshot.themePath).toBe('themes/brand-theme.yml');
      expect(snapshot.bibPath).toBe('refs.bib');
      // The engine still receives the overridable soft-default value.
      expect(snapshot.attributes.imagesdir).toBe('images@');
    });
  });

  describe('sandbox exclusion', () => {
    it('excludes remote and escaping file paths, keeping the safe ones', () => {
      const safe = new Uint8Array([9]);
      const { snapshot, excluded } = buildProjectSnapshot(
        baseInput({
          files: [
            text('main.adoc', '= Ok'),
            text('../secret.adoc', 'leak'),
            binary('http://evil.example/x.png', new Uint8Array([0])),
            binary('images/ok.png', safe),
          ],
        }),
      );

      expect(snapshot.files).toEqual({ 'main.adoc': '= Ok' });
      expect(snapshot.binaryAssets).toEqual({ 'images/ok.png': safe });
      expect(excluded).toContainEqual({ path: '../secret.adoc', reason: 'traversal' });
      expect(excluded).toContainEqual({ path: 'http://evil.example/x.png', reason: 'remote' });
    });

    it('surfaces excluded paths without throwing', () => {
      const { excluded } = buildProjectSnapshot(baseInput({ files: [text('/abs/path.adoc', 'x')] }));
      expect(excluded).toContainEqual({ path: '/abs/path.adoc', reason: 'absolute' });
    });
  });

  describe('enabled extensions (T061, FR-032g, SC-012b)', () => {
    // The web end of the same opt-in the config schema and the registry enforce: a project that has
    // enabled nothing must produce a snapshot that ASKS for nothing, so that adding an extension to
    // a deployment cannot change what it renders.
    it('omits the field entirely when the project enables nothing', () => {
      // Omitted rather than sent as `[]`. Both mean the same thing downstream, and a test pinning
      // that equivalence lives beside `mountPdfExtensions` — this pins which one is actually sent,
      // because `undefined` is the shape every pre-feature project produces.
      expect(buildProjectSnapshot(baseInput()).snapshot.enabledExtensions).toBeUndefined();
      expect(
        buildProjectSnapshot(baseInput({ enabledExtensions: [] })).snapshot.enabledExtensions,
      ).toBeUndefined();
    });

    it('passes a selection through when the project has made one', () => {
      // The counterpart, so the test above cannot be satisfied by dropping the field unconditionally.
      expect(
        buildProjectSnapshot(baseInput({ enabledExtensions: ['narrow-contents'] })).snapshot
          .enabledExtensions,
      ).toEqual(['narrow-contents']);
    });
  });
});
