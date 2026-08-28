/* @jest-environment jsdom */

/**
 * The app's typography comes from `next/font`, whose files are content-hashed and whose subsets are
 * Next's choice — so an export reads the faces out of the running page rather than hard-coding them.
 * These pin what it takes and what it refuses to take, since every extra face is 25–50 KB of somebody
 * else's download.
 */
import { collectAppFontFaceCss, EXPORT_WEBFONT_FAMILIES } from '@/lib/html-export/app-fonts';

/** Declare a stylesheet in the page, as the app's own font CSS is declared. */
function loadStylesheet(css: string): void {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
}

/** One face, in the shape `next/font` emits (plain family name, subset range, hashed file). */
function face(family: string, file: string, unicodeRange: string): string {
  return `@font-face { font-family: ${family}; font-style: normal; font-weight: 400; src: url("${file}") format("woff2"); unicode-range: ${unicodeRange}; }`;
}

const LATIN = 'U+0-FF, U+131, U+152-153';
const CYRILLIC = 'U+460-52F, U+1C80-1C88';

afterEach(() => {
  document.head.textContent = '';
});

describe('collectAppFontFaceCss', () => {
  test('takes the basic-Latin face of a family the style renders in', () => {
    loadStylesheet(face('Inter', '/_next/static/media/inter.woff2', LATIN));
    const css = collectAppFontFaceCss('asciidocollab');
    expect(css).toContain('@font-face');
    expect(css).toContain('inter.woff2');
  });

  test('leaves the other subsets behind', () => {
    loadStylesheet(
      [face('Inter', '/_next/static/media/latin.woff2', LATIN), face('Inter', '/_next/static/media/cyrillic.woff2', CYRILLIC)].join('\n'),
    );
    const css = collectAppFontFaceCss('asciidocollab');
    expect(css).toContain('latin.woff2');
    expect(css).not.toContain('cyrillic.woff2');
  });

  test('takes only the families the chosen style actually renders in', () => {
    // The brand style sets its prose in the UI sans; the vendored Asciidoctor stylesheet names three
    // other families and never mentions Inter. Carrying both sets would double the font payload.
    loadStylesheet(
      [
        face('Inter', '/_next/static/media/inter.woff2', LATIN),
        face('Noto Serif', '/_next/static/media/noto.woff2', LATIN),
        face('Open Sans', '/_next/static/media/opensans.woff2', LATIN),
        face('Urbanist', '/_next/static/media/urbanist.woff2', LATIN),
      ].join('\n'),
    );

    const brand = collectAppFontFaceCss('asciidocollab');
    expect(brand).toContain('inter.woff2');
    expect(brand).not.toContain('noto.woff2');

    const asciidoctor = collectAppFontFaceCss('asciidoctor');
    expect(asciidoctor).toContain('noto.woff2');
    expect(asciidoctor).toContain('opensans.woff2');
    expect(asciidoctor).not.toContain('inter.woff2');
    // Urbanist is the marketing display face — it appears in no export's document body.
    expect(asciidoctor).not.toContain('urbanist.woff2');
  });

  test('resolves a src written relative to the stylesheet, not to the page', () => {
    // `next/font` writes `../media/…`, which is a different directory from the document: resolving it
    // against the page would fetch nothing and the face would be dropped.
    loadStylesheet(face('Inter', '../media/inter.woff2', LATIN));
    expect(collectAppFontFaceCss('asciidocollab')).toContain(`${document.baseURI.replace(/\/[^/]*$/, '')}/media/inter.woff2`);
  });

  test('declares each face once even when two loaded stylesheets carry it', () => {
    // A dev server serves the same font CSS in more than one chunk; the reader needs one copy of the
    // file, not one per declaration.
    loadStylesheet(face('Inter', '/_next/static/media/inter.woff2', LATIN));
    loadStylesheet(face('Inter', '/_next/static/media/inter.woff2', LATIN));
    expect(collectAppFontFaceCss('asciidocollab').match(/@font-face/g)).toHaveLength(1);
  });

  test('a page declaring no faces yields nothing rather than failing the export', () => {
    expect(collectAppFontFaceCss('asciidocollab')).toBe('');
  });

  test('a stylesheet that refuses to be read is skipped, not fatal', () => {
    loadStylesheet(face('Inter', '/_next/static/media/inter.woff2', LATIN));
    const sheet = document.styleSheets[0];
    Object.defineProperty(sheet, 'cssRules', {
      get() {
        throw new DOMException('cross-origin', 'SecurityError');
      },
    });
    expect(collectAppFontFaceCss('asciidocollab')).toBe('');
  });

  test('reads the document it is given rather than the running page', () => {
    loadStylesheet(face('Inter', '/_next/static/media/page.woff2', LATIN));
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const other = frame.contentDocument;
    const style = other?.createElement('style');
    if (style) {
      style.textContent = face('Inter', '/_next/static/media/given.woff2', LATIN);
      other?.head.append(style);
    }

    const css = other === null ? '' : collectAppFontFaceCss('asciidocollab', other);

    frame.remove();
    expect(css).toContain('given.woff2');
    expect(css).not.toContain('page.woff2');
  });

  test('walks past the rules that are not font faces', () => {
    loadStylesheet(
      ['body { color: red; }', face('Inter', '/_next/static/media/inter.woff2', LATIN)].join('\n'),
    );

    const css = collectAppFontFaceCss('asciidocollab');

    expect(css).toContain('inter.woff2');
    expect(css).not.toContain('color');
  });

  test('resolves a relative src against the stylesheet URL when the sheet has one', () => {
    loadStylesheet(face('Inter', '../media/inter.woff2', LATIN));
    const sheet = document.styleSheets[0];
    Object.defineProperty(sheet, 'href', {
      get() {
        return 'https://app.example.com/_next/static/css/app.css';
      },
    });

    const css = collectAppFontFaceCss('asciidocollab');

    expect(css).toContain('https://app.example.com/_next/static/media/inter.woff2');
  });

  test('skips a rule that reports no text at all', () => {
    loadStylesheet(face('Inter', '/_next/static/media/inter.woff2', LATIN));
    const sheet = document.styleSheets[0];
    Object.defineProperty(sheet, 'cssRules', {
      get() {
        return [{}];
      },
    });

    expect(collectAppFontFaceCss('asciidocollab')).toBe('');
  });

  test('leaves an already-embedded data: src exactly as it was written', () => {
    loadStylesheet(face('Inter', 'data:font/woff2;base64,AAAA', LATIN));

    const css = collectAppFontFaceCss('asciidocollab');

    expect(css).toContain('data:font/woff2;base64,AAAA');
  });
});

describe('EXPORT_WEBFONT_FAMILIES', () => {
  test('names a family for every export style, so no style silently ships without typography', () => {
    for (const families of Object.values(EXPORT_WEBFONT_FAMILIES)) {
      expect(families.length).toBeGreaterThan(0);
    }
  });
});

describe('collectAppFontFaceCss — the same face served twice', () => {
  test('takes one copy when a dev server hands out the same face under two hashed names', () => {
    // Deduplicating on the rule text would keep both and double the payload: 47 KB of Inter becoming
    // 95 KB for two spellings of one file.
    loadStylesheet(face('Inter', '/_next/static/media/inter.aaa.woff2', LATIN));
    loadStylesheet(face('Inter', '/_next/static/media/inter.bbb.woff2', LATIN));
    const css = collectAppFontFaceCss('asciidocollab');
    expect(css.match(/@font-face/g)).toHaveLength(1);
  });

  test('keeps two genuinely different weights of one family', () => {
    // Ubuntu Mono ships 400 and 700; code blocks need both.
    loadStylesheet(
      [
        '@font-face { font-family: Ubuntu Mono; font-weight: 400; src: url("/a.woff2"); unicode-range: U+0-FF; }',
        '@font-face { font-family: Ubuntu Mono; font-weight: 700; src: url("/b.woff2"); unicode-range: U+0-FF; }',
      ].join('\n'),
    );
    expect(collectAppFontFaceCss('asciidoctor').match(/@font-face/g)).toHaveLength(2);
  });
});
