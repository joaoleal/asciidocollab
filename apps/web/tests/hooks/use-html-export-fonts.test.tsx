/**
 * A real export once shipped
 * `http://localhost:3000/vendor/mathjax/output/chtml/fonts/woff-v2/MathJax_Zero.woff` — a font request
 * that fails for every recipient and tells them which machine produced the file. This pins the whole
 * pipeline against that: whatever the packaging, whatever the style, nothing in the bytes that get
 * downloaded may point at an origin.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { strFromU8, unzipSync } from 'fflate';

// The real factory reaches for `import.meta.url`, which the CommonJS test runtime cannot parse.
jest.mock('@/lib/spawn-render-worker', () => ({ spawnRenderWorker: jest.fn() }));

// The diagram/maths pass needs a live browser to measure in; what matters here is only what it hands
// back — the typeset markup and MathJax's injected stylesheet, absolute font URLs and all. It runs AFTER
// sanitisation in the real pipeline, which is why the maths is added here rather than in the worker's
// reply: DOMPurify's html profile does not know MathJax's custom elements and would strip them.
jest.mock('@/lib/html-export/prerender-content', () => ({
  prerenderContent: jest.fn(async (bodyHtml: string) => ({
    html: bodyHtml + typesetMath,
    extraCss: mathJaxStyles,
    // These documents have no diagrams, so there is nothing to extract — but the field is part of the
    // contract and a mock that omits it is a mock of a function that does not exist. (apps/web's jest is
    // transpile-only, so a missing field is a runtime crash rather than a type error.)
    assets: [],
  })),
}));

import { useHtmlExport, type HtmlExportRequest } from '@/hooks/use-html-export';
import type { PackagedExport } from '@/lib/html-export/package-export';
import type { AssetFetcher } from '@/lib/html-export/inline-assets';

/** MathJax's own base URL in development — the source of the URL this whole file is about. */
const MATHJAX_FONTS = 'http://localhost:3000/vendor/mathjax/output/chtml/fonts/woff-v2';

/** The stylesheet MathJax injects: a handful of variant classes, then a face for every font it owns. */
const MATHJAX_CSS = `
mjx-container[jax="CHTML"] {line-height: 0;}
.MJX-TEX {font-family: MJXZERO, MJXTEX;}
.TEX-I {font-family: MJXZERO, MJXTEX-I;}
.TEX-B {font-family: MJXZERO, MJXTEX-B;}
@font-face /* 0 */ {font-family: MJXZERO; src: url("${MATHJAX_FONTS}/MathJax_Zero.woff") format("woff");}
@font-face /* 1 */ {font-family: MJXTEX; src: url("${MATHJAX_FONTS}/MathJax_Main-Regular.woff") format("woff");}
@font-face /* 2 */ {font-family: MJXTEX-B; src: url("${MATHJAX_FONTS}/MathJax_Main-Bold.woff") format("woff");}
@font-face /* 3 */ {font-family: MJXTEX-I; src: url("${MATHJAX_FONTS}/MathJax_Math-Italic.woff") format("woff");}
`;

/** The stylesheet the mocked prerender hands back; a test sets this before starting an export. */
let mathJaxStyles = '';
/** The typeset markup the mocked prerender appends; a test sets this before starting an export. */
let typesetMath = '';

/** CHTML output for one italic variable — the variant class rides on the character element. */
const CHTML_MATH =
  '<mjx-container class="MathJax" jax="CHTML"><mjx-math class=" MJX-TEX">' +
  '<mjx-mi class="mjx-i"><mjx-c class="mjx-c1D465 TEX-I"></mjx-c></mjx-mi></mjx-math></mjx-container>';

const FONT_BYTES = new Uint8Array([119, 79, 70, 70]);

class MockWorker {
  static instances: MockWorker[] = [];
  postMessage = jest.fn();
  terminate = jest.fn();
  private messageListeners: Array<(event: { data?: unknown }) => void> = [];

  constructor() {
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    if (type === 'message') this.messageListeners.push(listener);
  }

  reply(message: unknown) {
    for (const listener of this.messageListeners) listener({ data: message });
  }
}

const REQUEST: HtmlExportRequest = {
  rootPath: 'book.adoc',
  projectName: 'Book',
  files: { 'book.adoc': '= Book' },
  packaging: 'single-file',
  style: 'asciidocollab',
  theme: 'light',
};

const fetchImage: AssetFetcher = async () => ({ bytes: new Uint8Array([1]), contentType: 'image/png' });
const fetchFont: AssetFetcher = async () => ({ bytes: FONT_BYTES, contentType: 'font/woff2' });

/** Run one whole export and return what would have been downloaded. */
async function exportOnce(
  request: Partial<HtmlExportRequest> = {},
  options: { fetchFont?: AssetFetcher } = {},
): Promise<PackagedExport> {
  MockWorker.instances = [];
  const downloads: PackagedExport[] = [];
  const view = renderHook(() =>
    useHtmlExport({
      projectId: 'project-1',
      createWorker: () => new MockWorker() as unknown as Worker,
      fetchAsset: fetchImage,
      fetchFont: options.fetchFont ?? fetchFont,
      download: (packaged) => downloads.push(packaged),
    }),
  );

  act(() => {
    view.result.current.exportHtml({ ...REQUEST, ...request });
  });
  const worker = MockWorker.instances.at(-1)!;
  await waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
  await act(async () => {
    worker.reply({
      requestId: 1,
      ok: true,
      html: '<p>Hello.</p>',
      error: null,
      mathPresent: true,
    });
  });
  await waitFor(() => expect(view.result.current.isExporting).toBe(false));
  expect(downloads).toHaveLength(1);
  return downloads[0];
}

/** Declare the app's own webfaces in the page, as `next/font` does. */
function loadAppFonts(): void {
  const style = document.createElement('style');
  style.textContent = `
    @font-face { font-family: Inter; src: url("/_next/static/media/inter-latin.woff2") format("woff2"); unicode-range: U+0-FF; }
    @font-face { font-family: Inter; src: url("/_next/static/media/inter-cyrillic.woff2") format("woff2"); unicode-range: U+460-52F; }
    @font-face { font-family: Noto Serif; src: url("/_next/static/media/noto-latin.woff2") format("woff2"); unicode-range: U+0-FF; }
  `;
  document.head.append(style);
}

beforeEach(() => {
  mathJaxStyles = '';
  typesetMath = '';
  document.head.textContent = '';
});

describe('useHtmlExport — nothing in the output points at an origin', () => {
  test('a single-file export with maths carries no localhost URL', async () => {
    mathJaxStyles = MATHJAX_CSS;
    loadAppFonts();
    typesetMath = CHTML_MATH;
    const packaged = await exportOnce();
    const html = strFromU8(packaged.bytes);
    expect(html).toContain('MJX-TEX'); // the maths really is in there
    expect(html).not.toContain('localhost');
    expect(html).not.toMatch(/url\(\s*["']?(https?:|\/\/|\/)/);
  });

  test('a zip export with maths carries no localhost URL either, in any of its files', async () => {
    mathJaxStyles = MATHJAX_CSS;
    loadAppFonts();
    typesetMath = CHTML_MATH;
    const packaged = await exportOnce({ packaging: 'zip' });
    const entries = unzipSync(packaged.bytes);
    for (const [name, bytes] of Object.entries(entries)) {
      if (!name.endsWith('.html') && !name.endsWith('.css')) continue;
      expect(strFromU8(bytes)).not.toContain('localhost');
    }
  });

  test('every stylesheet URL in a zip is relative, so the folder renders from disk', async () => {
    mathJaxStyles = MATHJAX_CSS;
    loadAppFonts();
    typesetMath = CHTML_MATH;
    const packaged = await exportOnce({ packaging: 'zip' });
    const entries = unzipSync(packaged.bytes);
    const css = strFromU8(entries['styles.css']);
    for (const [, url] of css.matchAll(/url\(\s*"([^"]*)"/g)) {
      if (url.startsWith('data:')) continue;
      expect(url).not.toMatch(/^(https?:|\/\/|\/)/);
      expect(Object.keys(entries)).toContain(url);
    }
  });
});

describe('useHtmlExport — the fonts it carries', () => {
  test('embeds the app face the document is set in, and only its Latin subset', async () => {
    loadAppFonts();
    const packaged = await exportOnce();
    const html = strFromU8(packaged.bytes);
    expect(html).toContain('font-family: Inter');
    expect(html).toContain('data:font/woff2;base64,');
    expect(html).not.toContain('inter-cyrillic');
  });

  test('carries the Asciidoctor families for an Asciidoctor export, not the UI sans', async () => {
    loadAppFonts();
    const packaged = await exportOnce({ style: 'asciidoctor' });
    const html = strFromU8(packaged.bytes);
    expect(html).toContain('font-family: Noto Serif');
    expect(html).not.toContain('font-family: Inter;');
  });

  test('writes the font files into a zip rather than embedding them', async () => {
    loadAppFonts();
    const packaged = await exportOnce({ packaging: 'zip' });
    const entries = unzipSync(packaged.bytes);
    const fonts = Object.keys(entries).filter((name) => name.startsWith('fonts/'));
    expect(fonts).toHaveLength(1);
    expect(entries[fonts[0]]).toEqual(FONT_BYTES);
    expect(strFromU8(entries['styles.css'])).toContain(`url("${fonts[0]}")`);
  });

  test('ships only the maths fonts the document actually renders in', async () => {
    // MathJax declares a face for all of its fonts whatever the document contains. This one uses the
    // upright and italic variants, so the bold face is 34 KB the reader should never be sent.
    mathJaxStyles = MATHJAX_CSS;
    typesetMath = CHTML_MATH;
    const packaged = await exportOnce();
    const html = strFromU8(packaged.bytes);
    expect(html).toContain('font-family: MJXTEX-I');
    expect(html).toContain('font-family: MJXZERO');
    expect(html).not.toContain('font-family: MJXTEX-B');
  });

  test('ships no maths font at all when the maths is native MathML', async () => {
    // Which is the usual case: every current browser typesets MathML itself, so MathJax's 392 KB of
    // fonts would be pure overhead.
    mathJaxStyles = MATHJAX_CSS;
    typesetMath = '<math><mi>x</mi></math>';
    const packaged = await exportOnce();
    const html = strFromU8(packaged.bytes);
    expect(html).not.toContain('@font-face');
    // MathJax's other rules still travel: they are what positions any CHTML the document does contain.
    expect(html).toContain('mjx-container[jax="CHTML"]');
  });

  test('ships no maths font for a document with no maths', async () => {
    const packaged = await exportOnce();
    const html = strFromU8(packaged.bytes);
    expect(html).not.toContain('MathJax_');
  });

  test('a font the server will not serve costs its face, not the export', async () => {
    loadAppFonts();
    mathJaxStyles = MATHJAX_CSS;
    typesetMath = CHTML_MATH;
    const packaged = await exportOnce({}, { fetchFont: async () => null });
    const html = strFromU8(packaged.bytes);
    expect(html).toContain('<p>'); // the document is still there
    expect(html).not.toContain('@font-face');
    expect(html).not.toContain('localhost');
  });
});
