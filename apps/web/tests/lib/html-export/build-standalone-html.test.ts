/**
 * The exported document has to stand on its own: no app around it, no stylesheet to load, no
 * authenticated endpoint to reach. These pin the parts of that which are easy to get subtly wrong —
 * the palette actually reaching the file, the preview's selectors still matching, and the escaping.
 */
import {
  buildStandaloneHtml,
  composeExportCss,
  EXPORT_CONTENT_CLASS,
  EXPORT_FONT_TOKENS_CSS,
  EXPORT_PAGE_CLASS,
  type StandaloneHtmlInput,
} from '@/lib/html-export/build-standalone-html';
import {
  ASCIIDOCOLLAB_CSS,
  ASCIIDOCTOR_CSS,
  DARK_TOKENS_CSS,
  LIGHT_TOKENS_CSS,
} from '@/lib/html-export/export-css.generated';

function build(overrides: Partial<StandaloneHtmlInput> = {}): string {
  return buildStandaloneHtml({
    bodyHtml: '<div id="content"><p>Hello.</p></div>',
    title: 'My Document',
    style: 'asciidocollab',
    theme: 'light',
    ...overrides,
  });
}

describe('buildStandaloneHtml — document shell', () => {
  test('produces a complete document, not a fragment', () => {
    const html = build();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  test('carries the document title into the browser tab', () => {
    expect(build({ title: 'Quarterly Report' })).toContain('<title>Quarterly Report</title>');
  });

  test('falls back to a generic title rather than an empty tab', () => {
    expect(build({ title: '   ' })).toContain('<title>Document</title>');
    expect(build({ title: undefined })).toContain('<title>Document</title>');
  });

  test('sets the document language, defaulting to English', () => {
    expect(build({ lang: 'pt-PT' })).toContain('<html lang="pt-PT">');
    expect(build({ lang: '  ' })).toContain('<html lang="en">');
    expect(build({ lang: undefined })).toContain('<html lang="en">');
  });

  test('embeds the rendered body verbatim', () => {
    expect(build({ bodyHtml: '<p>Untouched &amp; intact</p>' })).toContain('<p>Untouched &amp; intact</p>');
  });
});

describe('buildStandaloneHtml — style selection', () => {
  test('uses the preview container class and style attribute, so the inlined CSS matches unchanged', () => {
    // This is what makes the export look like the panel rather than an approximation: the selectors
    // in both stylesheets are written against exactly this container.
    const html = build({ style: 'asciidoctor' });
    expect(html).toContain(`<div class="${EXPORT_CONTENT_CLASS}" data-preview-style="asciidoctor">`);
  });

  test('inlines the app stylesheet for the AsciidoCollab style and not the vendored one', () => {
    const html = build({ style: 'asciidocollab' });
    expect(html).toContain(ASCIIDOCOLLAB_CSS);
    expect(html).not.toContain(ASCIIDOCTOR_CSS);
  });

  test('inlines the vendored stylesheet for the Asciidoctor style and not the app one', () => {
    const html = build({ style: 'asciidoctor' });
    expect(html).toContain(ASCIIDOCTOR_CSS);
    expect(html).not.toContain(ASCIIDOCOLLAB_CSS);
  });

  test('needs no network: no external stylesheet, script or font reference', () => {
    const html = build();
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/@import\s/);
  });
});

describe('buildStandaloneHtml — palette', () => {
  test('bakes the light palette for a light export', () => {
    const html = build({ theme: 'light' });
    expect(html).toContain(LIGHT_TOKENS_CSS);
    expect(html).not.toContain(DARK_TOKENS_CSS);
  });

  test('bakes the dark palette for a dark export', () => {
    const html = build({ theme: 'dark' });
    expect(html).toContain(DARK_TOKENS_CSS);
  });

  test('auto emits light as the base and dark only under prefers-color-scheme', () => {
    // Light first and unconditional: a reader whose browser ignores the query still gets a readable
    // document rather than an unstyled one.
    const html = build({ theme: 'auto' });
    expect(html).toContain(LIGHT_TOKENS_CSS);
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    const lightAt = html.indexOf(LIGHT_TOKENS_CSS);
    const queryAt = html.indexOf('@media (prefers-color-scheme: dark)');
    expect(lightAt).toBeLessThan(queryAt);
  });

  test('every token the stylesheet consumes is declared, in both palettes', () => {
    // An undefined custom property in a var() with no fallback makes the whole declaration invalid at
    // computed-value time — CSS does NOT fall through to the next value in the list, it drops the
    // declaration. So a token the export forgets is not a small colour shift, it is a lost rule.
    const referenced = [...new Set([...ASCIIDOCOLLAB_CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
    expect(referenced.length).toBeGreaterThan(0);
    const missing = (declarations: string) =>
      referenced.filter((token) => !declarations.includes(`${token}:`));
    expect(missing(`${LIGHT_TOKENS_CSS}${EXPORT_FONT_TOKENS_CSS}`)).toEqual([]);
    expect(missing(`${DARK_TOKENS_CSS}${EXPORT_FONT_TOKENS_CSS}`)).toEqual([]);
  });

  test('declares the next/font families the app supplies, which a standalone file has no source for', () => {
    // These come from next/font in app/layout.tsx. Without them the typography rules are dropped
    // outright rather than degrading to the stylesheet's own fallback stack.
    for (const token of ['--font-asciidoctor-sans', '--font-asciidoctor-serif', '--font-asciidoctor-mono']) {
      expect(build()).toContain(`${token}:`);
    }
  });
});

describe('buildStandaloneHtml — title block', () => {
  test('restores the author and revision line the preview omits', () => {
    const html = build({ details: { author: 'Jane Doe', revnumber: '2.1', revdate: '2026-07-25' } });
    expect(html).toContain('Jane Doe');
    expect(html).toContain('v2.1');
    expect(html).toContain('2026-07-25');
  });

  test('does not double the v prefix on a revision that already has one', () => {
    expect(build({ details: { revnumber: 'v3' } })).toContain('v3');
    expect(build({ details: { revnumber: 'v3' } })).not.toContain('vv3');
  });

  test('renders nothing at all when the document declares no details', () => {
    // The class name itself always appears — it is styled in the page CSS. Assert on the ELEMENT.
    expect(build({ details: undefined })).not.toContain('<p class="adoc-export-details">');
    expect(build({ details: {} })).not.toContain('<p class="adoc-export-details">');
  });

  test('places the details above the body content', () => {
    const html = build({ bodyHtml: '<p>BODY</p>', details: { author: 'Jane Doe' } });
    expect(html.indexOf('Jane Doe')).toBeLessThan(html.indexOf('<p>BODY</p>'));
  });
});

describe('buildStandaloneHtml — escaping', () => {
  test('escapes metadata so a stray angle bracket cannot inject markup', () => {
    const html = build({ title: '<script>alert(1)</script>', details: { author: '<b>x</b>' } });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<title><script>');
    expect(html).not.toContain('<b>x</b>');
  });

  test('escapes a closing style tag hidden in the CSS, which would otherwise end the stylesheet early', () => {
    // `</style>` inside CSS ends the element wherever it appears, spilling the rest into the page.
    const html = build({ extraCss: '.x::after { content: "</style><img src=x>"; }' });
    expect(html).not.toContain('</style><img src=x>');
    expect(html).toContain(String.raw`<\/style`);
  });

  test('appends extra stylesheet rules, for output that carries its own CSS', () => {
    expect(build({ extraCss: 'mjx-container { color: red; }' })).toContain('mjx-container { color: red; }');
  });
});

describe('buildStandaloneHtml — the page', () => {
  test('wraps the content in a page column of its own', () => {
    // The column cannot live on the content container: the preview stylesheet declares `margin: 0` on
    // it with a `:not()` selector that outranks anything a page rule can say about the same element.
    const html = build({ bodyHtml: '<p>BODY</p>' });
    const wrapperAt = html.indexOf(`<div class="${EXPORT_PAGE_CLASS}"`);
    const contentAt = html.indexOf(`<div class="${EXPORT_CONTENT_CLASS}"`);
    expect(wrapperAt).toBeGreaterThanOrEqual(0);
    expect(wrapperAt).toBeLessThan(contentAt);
    expect(contentAt).toBeLessThan(html.indexOf('<p>BODY</p>'));
  });

  test('centres that column and gives it a readable width', () => {
    const css = composeExportCss({ style: 'asciidocollab', theme: 'light' });
    expect(css).toMatch(new RegExp(String.raw`\.${EXPORT_PAGE_CLASS} \{[^}]*margin: 0 auto`));
    expect(css).toMatch(new RegExp(String.raw`\.${EXPORT_PAGE_CLASS} \{[^}]*max-width`));
  });

  test('gives the Asciidoctor style the wider column its own stylesheet lays out', () => {
    const css = composeExportCss({ style: 'asciidoctor', theme: 'light' });
    expect(css).toContain(`.${EXPORT_PAGE_CLASS}[data-preview-style="asciidoctor"]`);
  });

  test('paints one surface for the whole page, from the palette the export carries', () => {
    // The bug this replaces: the tokens were declared on the content container only, so the body's
    // `background: hsl(var(--background))` referenced an undefined property and was dropped outright —
    // a dark export was a dark column on a white page.
    const css = composeExportCss({ style: 'asciidocollab', theme: 'dark' });
    expect(css).toMatch(/body \{[^}]*background: hsl\(var\(--background\)\)/);
    expect(DARK_TOKENS_CSS).toMatch(/^:root/);
    expect(LIGHT_TOKENS_CSS).toMatch(/^:root/);
    // The content container declares no surface of its own, so there is nothing for the page to differ
    // from — the one exception is the Asciidoctor stylesheet's fixed white, which is neutralised below.
    expect(css).toContain(`.${EXPORT_CONTENT_CLASS}[data-preview-style="asciidoctor"] { background: transparent; }`);
  });

  test('names the UI sans on the body, which the brand stylesheet inherits from', () => {
    // The brand style says `font-family: inherit` — in the app that is Inter, in a file with nothing
    // above it that is the browser's default serif.
    expect(composeExportCss({ style: 'asciidocollab', theme: 'light' })).toMatch(/body \{[^}]*font-family: Inter/);
  });

  test('pins the Asciidoctor style to the light palette, because that stylesheet is light', () => {
    // It paints its own near-white surface and near-black text whatever the app's theme is; a dark
    // palette around it is precisely the page-does-not-match-content look being fixed.
    const html = build({ style: 'asciidoctor', theme: 'dark' });
    expect(html).toContain(LIGHT_TOKENS_CSS);
    expect(html).not.toContain(DARK_TOKENS_CSS);
  });

  test('places its corrections after the stylesheet they correct, or they lose the cascade', () => {
    const css = composeExportCss({ style: 'asciidoctor', theme: 'light' });
    expect(css.indexOf(ASCIIDOCTOR_CSS)).toBeLessThan(css.indexOf('background: transparent'));
  });
});

describe('buildStandaloneHtml — the stylesheet', () => {
  test('links an external stylesheet when the packaging keeps one, and inlines nothing', () => {
    const html = build({ stylesheetHref: 'styles.css' });
    expect(html).toContain('<link rel="stylesheet" href="styles.css">');
    expect(html).not.toContain('<style>');
  });

  test('the linked path is relative, so a folder opened from disk still finds it', () => {
    const html = build({ stylesheetHref: 'styles.css' });
    expect(html).not.toMatch(/href="(\/|[a-z]+:)/);
  });

  test('both packagings dress the document from the same composed stylesheet', () => {
    // Otherwise the two would drift and a zip would quietly stop looking like the single file.
    const input: StandaloneHtmlInput = {
      bodyHtml: '<p>Hello.</p>',
      style: 'asciidoctor',
      theme: 'auto',
      extraCss: 'mjx-container { color: red; }',
    };
    expect(buildStandaloneHtml(input)).toContain(composeExportCss(input));
  });

  test('emits no absolute URL of its own — no origin, no localhost, nothing to fetch', () => {
    // The regression this guards: a real export referenced
    // `http://localhost:3000/vendor/mathjax/output/chtml/fonts/woff-v2/MathJax_Zero.woff`, which is
    // broken for every recipient and tells them where it was made.
    for (const style of ['asciidocollab', 'asciidoctor'] as const) {
      for (const theme of ['light', 'dark', 'auto'] as const) {
        const html = buildStandaloneHtml({ bodyHtml: '<p>Hi.</p>', style, theme });
        expect(html).not.toMatch(/https?:\/\/(localhost|127\.0\.0\.1)/);
        // Any url() that is not already embedded has to be a path relative to the document.
        expect(html).not.toMatch(/url\(\s*["']?(https?:|\/\/|\/)/);
      }
    }
  });

  test('drops a font the pipeline forgot to resolve rather than shipping its URL', () => {
    const remote = '@font-face { font-family: X; src: url("http://localhost:3000/f.woff2"); }';
    const html = build({ extraCss: remote });
    expect(html).not.toContain('localhost');
    expect(html).not.toContain('@font-face { font-family: X');
  });
});
