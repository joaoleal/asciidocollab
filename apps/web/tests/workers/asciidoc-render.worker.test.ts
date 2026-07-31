/**
 * Tests for asciidoc-render.worker.ts
 *
 * The worker module is imported directly (not via `new Worker(url)`) so Jest can
 * execute it.  We shim the global `onmessage` setter and `postMessage` so the
 * worker's message handler is captured and called synchronously in tests.
 *
 * Asciidoctor is mocked here so tests focus on the worker's message handling and
 * HTML post-processing logic without requiring the real library. The engine's `load` and `convert`
 * are asynchronous, so the doubles resolve promises and every render is awaited before it is read.
 */

let onMessageHandler: ((event: MessageEvent) => Promise<void>) | null = null;
const postMessageMock = jest.fn();

// Shim the worker globals before the module is imported.
Object.defineProperty(globalThis, 'onmessage', {
  set(handler: (event: MessageEvent) => Promise<void>) {
    onMessageHandler = handler;
  },
  get() {
    return onMessageHandler;
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'postMessage', {
  value: postMessageMock,
  writable: true,
  configurable: true,
});

const mockConvert = jest.fn();
const mockFindBy = jest.fn();
const mockSetId = jest.fn();
const mockGetId = jest.fn();
const mockGetContext = jest.fn();
const mockGetAttribute = jest.fn();
const mockLoad = jest.fn();

// The real app defaults, not a literal, so the worker's contract is asserted against what the
// composition root actually seeds.
import { SOFT_DEFAULT_SUFFIX } from '@asciidocollab/shared';
import {
  APP_RENDER_DEFAULT_ATTRIBUTES,
  withAppRenderDefaults,
} from '@/lib/asciidoc/render-app-defaults';

// The engine exposes `load` as a module function, not a processor factory, and it resolves a promise.
jest.mock('asciidoctor', () => ({ __esModule: true, load: mockLoad }));

function makeBlock(options: {
  lineNumber: number | null;
  id?: string | null;
  context?: string;
  level?: number | null;
}) {
  const { lineNumber, id = null, context = 'paragraph', level = null } = options;
  const mockId = jest.fn().mockReturnValue(id);
  const localSetId = jest.fn((newId: string) => { mockId.mockReturnValue(newId); });
  const block: Record<string, unknown> = {
    // The block's own line accessor, which is what the worker asks: the engine answers it for every
    // node it hands back, including the table cells whose source-location cursor it stores stripped of
    // its methods. `undefined` is how it reports a node it has no position for.
    getLineNumber: jest.fn().mockReturnValue(lineNumber ?? undefined),
    getId: mockId,
    setId: localSetId,
    getContext: jest.fn().mockReturnValue(context),
  };
  if (level !== null) {
    block['getLevel'] = jest.fn().mockReturnValue(level);
  }
  return block as ReturnType<typeof jest.fn> & typeof block;
}

/**
 * Drive one render, and settle before returning. The handler is asynchronous, so the reply exists only
 * once the promise it returns has settled; asserting without awaiting would read no reply at all.
 */
async function sendMessage(data: {
  requestId: number;
  content: string;
  imagesDir?: string;
  mainPath?: string;
  files?: Record<string, string>;
  rootFileId?: string | null;
  openFileId?: string;
  sourceLineHints?: boolean;
}): Promise<void> {
  if (onMessageHandler) {
    await onMessageHandler({ data } as MessageEvent);
  } else {
    throw new Error('onmessage handler not registered');
  }
}

describe('asciidoc-render.worker', () => {
  beforeEach(() => {
    jest.resetModules();
    postMessageMock.mockClear();
    mockConvert.mockClear();
    mockFindBy.mockClear();
    mockSetId.mockClear();
    mockGetId.mockClear();
    mockGetContext.mockClear();
    mockGetAttribute.mockClear();
    mockLoad.mockClear();
    onMessageHandler = null;

    // Default: convert returns HTML with id attributes matching the block IDs
    // that the worker injects via setId.
    mockConvert.mockResolvedValue(
      '<h2 id="__src_section_1" class="sect1">Title</h2>' +
      '<div id="__src_paragraph_3" class="paragraph"><p>Content</p></div>',
    );
    mockFindBy.mockReturnValue([
      makeBlock({ lineNumber: 1, id: null, context: 'section' }),
      makeBlock({ lineNumber: 3, id: null, context: 'paragraph' }),
      makeBlock({ lineNumber: null }), // no source location — skipped
    ]);
    // Default: no `:stem:` in effect so math is never flagged unless a test sets it. The engine
    // answers `null` — not `undefined` — for an attribute that is unset or was never set, which is what
    // the worker's own guard is written against.
    mockGetAttribute.mockReturnValue(null);
    mockLoad.mockResolvedValue({ findBy: mockFindBy, convert: mockConvert, getAttribute: mockGetAttribute });
  });

  // (a) ok=true with data-source-line injected for blocks that have IDs
  it('posts RenderResult with ok=true and data-source-line in HTML for valid input', async () => {
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 1, content: '= Hello\n\nWorld' });

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    expect(result.html).toContain('data-source-line="1"');
    expect(result.html).toContain('data-source-line="3"');
    expect(result.error).toBeNull();
  });

  // (a2) a block's data-source-line is lifted to its VISUAL start — the block title (and attribute)
  // lines above the delimiter — so a click on the `.Example block` title scrolls to the block itself
  // instead of falling back to the previous block.
  it('maps a titled block to its title line, not its delimiter line', async () => {
    mockConvert.mockResolvedValueOnce(
      '<div id="__src_example_6" class="exampleblock">' +
        '<div class="title">Example block</div>' +
        '<div class="content"><div id="__src_paragraph_7" class="paragraph"><p>inside</p></div></div>' +
        '</div>',
    );
    mockFindBy.mockReturnValueOnce([
      makeBlock({ lineNumber: 6, id: null, context: 'example' }),
      makeBlock({ lineNumber: 7, id: null, context: 'paragraph' }),
    ]);
    require('@/workers/asciidoc-render.worker');
    // Line 5 is the `.Example block` title; line 6 is the `====` delimiter Asciidoctor reports.
    await sendMessage({
      requestId: 6,
      content: '= T\n\nBefore.\n\n.Example block\n====\ninside\n====',
    });

    const { html } = postMessageMock.mock.calls[0][0];
    // The example block carries the TITLE line (5), not its delimiter line (6).
    expect(html).toContain('id="__src_example_6" data-source-line="5"');
    // The nested paragraph keeps its own content line.
    expect(html).toContain('id="__src_paragraph_7" data-source-line="7"');
  });

  // (b) ok=false with error when Asciidoctor throws
  it('posts RenderResult with ok=false when Asciidoctor throws', async () => {
    mockLoad.mockRejectedValue(new Error('parse error'));
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 2, content: 'bad content' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(false);
    expect(result.html).toBeNull();
    expect(result.error).toBe('parse error');
  });

  // (c) requestId is echoed correctly
  it('echoes requestId in the response', async () => {
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 42, content: '= Hello' });

    expect(postMessageMock.mock.calls[0][0].requestId).toBe(42);
  });

  // (d) multiple sequential requests each echo their own requestId
  it('echoes the correct requestId for each sequential request', async () => {
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 10, content: '= First' });
    await sendMessage({ requestId: 20, content: '= Second' });

    expect(postMessageMock).toHaveBeenCalledTimes(2);
    expect(postMessageMock.mock.calls[0][0].requestId).toBe(10);
    expect(postMessageMock.mock.calls[1][0].requestId).toBe(20);
  });

  // (e0) imagesDir is NOT forced as the `imagesdir` attribute; it is the endpoint base used to rewrite
  // the project-relative `<img src>` targets Asciidoctor emits — so the preview and the PDF engine
  // resolve `imagesdir` identically and differ only in the URL the resolved path is served from.
  it('rewrites project-relative <img src> onto the image endpoint without forcing imagesdir', async () => {
    mockConvert.mockResolvedValueOnce('<p><span class="image"><img src="logo.png" alt="logo"></span></p>');
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 50, content: '= Doc', imagesDir: 'https://api/projects/p1/images' });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.imagesdir).toBeUndefined();
    const { html } = postMessageMock.mock.calls[0][0];
    expect(html).toContain('src="https://api/projects/p1/images/logo.png"');
  });

  it('honours a project-config imagesdir (soft default) and endpoint-prefixes the resolved src', async () => {
    mockConvert.mockResolvedValueOnce('<img src="images/logo.png">');
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 53,
      content: '= Doc',
      imagesDir: 'https://api/projects/p1/images',
      projectAttributes: { imagesdir: 'images@' },
    });
    // The project imagesdir reaches the engine exactly as the PDF snapshot passes it (soft-defaulted).
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.imagesdir).toBe('images@');
    const { html } = postMessageMock.mock.calls[0][0];
    expect(html).toContain('src="https://api/projects/p1/images/images/logo.png"');
  });

  // (e0) Admonition icons. The app supplies `icons=font` as a soft default from the composition root
  // (`withAppRenderDefaults`), so an admonition renders with an icon in EVERY project instead of only
  // in one whose header declares `:icons:` — the cross-project inconsistency the bundled guided tour
  // exposed. What this asserts is the worker's half of the contract: it passes the value straight to
  // the engine, still carrying `@`, and never re-forces one of its own. The `@` is what leaves a
  // document's `:icons: image` / `:icons!:` header in charge.
  it('passes the app icons default through to the engine as an overridable soft default', async () => {
    mockConvert.mockResolvedValueOnce('<p>x</p>');
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 57,
      content: 'NOTE: seeded',
      projectAttributes: { ...APP_RENDER_DEFAULT_ATTRIBUTES },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.icons).toBe(`font${SOFT_DEFAULT_SUFFIX}`);
  });

  it('carries a project image-icons choice instead of the app font default', async () => {
    mockConvert.mockResolvedValueOnce('<p>x</p>');
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    // What the composition root produces for a project whose "Admonition icons" setting is Image:
    // the empty (image-admonition) value, soft-defaulted — NOT the app's `font@`.
    await sendMessage({
      requestId: 58,
      content: 'NOTE: seeded',
      projectAttributes: withAppRenderDefaults({ icons: SOFT_DEFAULT_SUFFIX }),
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.icons).toBe(SOFT_DEFAULT_SUFFIX);
  });

  it('leaves an absolute image URL untouched', async () => {
    mockConvert.mockResolvedValueOnce('<img src="https://cdn.example.com/x.png">');
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 54, content: '= Doc', imagesDir: 'https://api/projects/p1/images' });
    const { html } = postMessageMock.mock.calls[0][0];
    expect(html).toContain('src="https://cdn.example.com/x.png"');
  });

  it('endpoint-prefixes an interactive-SVG <object data> target', async () => {
    mockConvert.mockResolvedValueOnce('<object type="image/svg+xml" data="diagram.svg">SVG</object>');
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 55, content: '= Doc', imagesDir: 'https://api/projects/p1/images' });
    const { html } = postMessageMock.mock.calls[0][0];
    expect(html).toContain('data="https://api/projects/p1/images/diagram.svg"');
  });

  it('omits the imagesdir attribute when no imagesDir is provided', async () => {
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 51, content: '= Doc' });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.imagesdir).toBeUndefined();
  });

  // (e1) An `imagesdir` inherited from an ancestor's cross-document scope now flows through to the
  // engine (the host endpoint no longer clobbers it), so the open file resolves images against the same
  // dir the PDF engine would; the endpoint is applied afterwards by the src rewrite, not as an attribute.
  it('preserves an inherited-scope :imagesdir: instead of overwriting it with the endpoint', async () => {
    require('@/workers/asciidoc-render.worker');
    const files = {
      'main.adoc': ':imagesdir: media\n\ninclude::child.adoc[]\n',
      'child.adoc': '= Child\n',
    };
    await sendMessage({
      requestId: 52,
      content: files['child.adoc'],
      imagesDir: 'https://api/projects/p1/images',
      files,
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.imagesdir).not.toBe('https://api/projects/p1/images');
    expect(options.attributes.imagesdir).toContain('media');
  });

  // (e2) checklist unicode glyphs are swapped for stateful <span class="checklist-box">
  it('replaces checklist glyphs with stateful checkbox spans', async () => {
    const checklistHtml =
      '<ul class="checklist">' +
      '<li><p>&#10003; done</p></li>' +
      '<li><p>&#10063; todo</p></li>' +
      '</ul>';
    mockConvert.mockResolvedValueOnce(checklistHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 30, content: '* [x] done\n* [ ] todo' });

    const { html } = postMessageMock.mock.calls[0][0];
    expect(html).toContain('<span class="checklist-box checklist-box--checked" aria-hidden="true"></span>done');
    expect(html).toContain('<span class="checklist-box" aria-hidden="true"></span>todo');
    // The raw unicode glyphs must be gone.
    expect(html).not.toContain('&#10003;');
    expect(html).not.toContain('&#10063;');
  });

  // (e3) a table column's width is restored to the CSS form canonical Asciidoctor emits. The engine
  // writes the presentational `width` attribute HTML5 made obsolete; the render-equivalence gates
  // compare the preview against canonical Asciidoctor, so the correction belongs in the render.
  it('states a table column width as a style, not as the obsolete width attribute', async () => {
    mockConvert.mockResolvedValueOnce(
      '<table class="tableblock"><colgroup><col width="25%"><col width="12.5%"><col></colgroup></table>',
    );
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 31, content: '|===\n|a |b |c\n|===' });

    const { html } = postMessageMock.mock.calls[0][0];
    expect(html).toContain('<col style="width: 25%;">');
    // A fractional width survives intact rather than being rounded or dropped.
    expect(html).toContain('<col style="width: 12.5%;">');
    // An autowidth column carries no width at all, and must not acquire one.
    expect(html).toContain('<col></colgroup>');
    expect(html).not.toContain('width="');
  });

  // (e) include:: directives are not resolved when no files/mainPath are supplied (open-file render)
  it('includes include:: directive as literal text when no assembly inputs are given', async () => {
    const htmlWithInclude = '<p>include::some-file.adoc[]</p>';
    mockConvert.mockResolvedValueOnce(htmlWithInclude);
    mockFindBy.mockReturnValueOnce([]); // no blocks with source lines
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 3, content: 'include::some-file.adoc[]' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    expect(result.html).toBe(htmlWithInclude);
    // The open-file path renders `content` verbatim — no assembly.
    expect(mockLoad.mock.calls[0][0]).toBe('include::some-file.adoc[]');
  });

  // (e1) when files + mainPath are supplied, includes are assembled (sandbox-confined) before render
  it('assembles in-sandbox includes from the main file before rendering', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 60,
      content: 'unused when assembling',
      mainPath: 'main.adoc',
      files: { 'main.adoc': '= Book\n\ninclude::ch.adoc[]\n', 'ch.adoc': '== Chapter\n' },
    });
    const rendered = mockLoad.mock.calls[0][0] as string;
    expect(rendered).toContain('== Chapter');
    expect(rendered).not.toContain('include::');
  });

  // (e1a) the assembler is seeded with Asciidoctor's intrinsics, so an include guarded by an
  // attribute Asciidoctor injects (e.g. `backend-html5`) is kept rather than silently dropped (#1).
  it('keeps an include guarded by an Asciidoctor intrinsic (backend-html5) during assembly', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 62,
      content: 'unused when assembling',
      mainPath: 'main.adoc',
      files: {
        'main.adoc': '= Book\n\nifdef::backend-html5[]\ninclude::ch.adoc[]\nendif::[]\n',
        'ch.adoc': '== HTML Only Chapter\n',
      },
    });
    const rendered = mockLoad.mock.calls[0][0] as string;
    expect(rendered).toContain('== HTML Only Chapter');
  });

  // (e1b) a traversal target is never read; Asciidoctor receives an "Unresolved directive" marker
  it('rejects an out-of-sandbox include target during assembly (Constitution IX)', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 61,
      content: '',
      mainPath: 'main.adoc',
      files: { 'main.adoc': 'include::../secret.adoc[]\n', '../secret.adoc': 'TOP SECRET' },
    });
    const rendered = mockLoad.mock.calls[0][0] as string;
    expect(rendered).toContain('Unresolved directive');
    expect(rendered).not.toContain('TOP SECRET');
  });

  // (f) blocks without an existing ID get a synthetic __src_<context>_<line> ID
  it('assigns a synthetic ID to blocks that have no existing ID', async () => {
    const block = makeBlock({ lineNumber: 7, id: null, context: 'paragraph' });
    mockConvert.mockResolvedValueOnce('<div id="__src_paragraph_7"><p>text</p></div>');
    mockFindBy.mockReturnValueOnce([block]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 4, content: '= Doc' });

    expect(block.setId).toHaveBeenCalledWith('__src_paragraph_7');
  });

  // (g) blocks that already have an ID keep it; data-source-line is injected next to it
  it('preserves existing IDs and still injects data-source-line', async () => {
    const block = makeBlock({ lineNumber: 5, id: '_section_title', context: 'section' });
    mockConvert.mockResolvedValueOnce('<h2 id="_section_title">Title</h2>');
    mockFindBy.mockReturnValueOnce([block]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 5, content: '= Doc\n\n== Title' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    expect(block.setId).not.toHaveBeenCalled();
    expect(result.html).toContain('data-source-line="5"');
  });

  // (h) document-level block is skipped (no wrapping HTML element in output)
  it('skips document-level blocks', async () => {
    const documentBlock = makeBlock({ lineNumber: 1, id: null, context: 'document' });
    const paraBlock = makeBlock({ lineNumber: 3, id: null, context: 'paragraph' });
    mockConvert.mockResolvedValueOnce('<div id="__src_paragraph_3"><p>text</p></div>');
    mockFindBy.mockReturnValueOnce([documentBlock, paraBlock]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 6, content: '= Doc\n\nParagraph.' });

    expect(documentBlock.setId).not.toHaveBeenCalled();
    expect(paraBlock.setId).toHaveBeenCalledWith('__src_paragraph_3');
  });

  // (i) blocks without source location are skipped
  it('skips blocks with no source location', async () => {
    const blockNoLoc = makeBlock({ lineNumber: null });
    const blockWithLoc = makeBlock({ lineNumber: 5, id: null, context: 'paragraph' });
    mockConvert.mockResolvedValueOnce('<div id="__src_paragraph_5"><p>text</p></div>');
    mockFindBy.mockReturnValueOnce([blockNoLoc, blockWithLoc]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 7, content: '= Doc' });

    expect(blockNoLoc.setId).not.toHaveBeenCalled();
    expect(blockWithLoc.setId).toHaveBeenCalledTimes(1);
  });

  // (j) level-0 section skips normal processing and data-source-line is injected into <h1>
  it('injects data-source-line into the showtitle <h1> from the level-0 section line number', async () => {
    const level0Section = makeBlock({ lineNumber: 1, id: null, context: 'section', level: 0 });
    const para = makeBlock({ lineNumber: 3, id: null, context: 'paragraph' });
    mockConvert.mockResolvedValueOnce('<h1>Doc Title</h1><div id="__src_paragraph_3"><p>text</p></div>');
    mockFindBy.mockReturnValueOnce([level0Section, para]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 8, content: '= Doc Title\n\ntext' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    expect(result.html).toContain('<h1 data-source-line="1">Doc Title</h1>');
    expect(level0Section.setId).not.toHaveBeenCalled();
  });

  // (l) docTitleLineNum is injected even when the converted HTML starts with a leading newline
  it('injects data-source-line into <h1> when converted HTML has a leading newline before the tag', async () => {
    const level0Section = makeBlock({ lineNumber: 1, id: null, context: 'section', level: 0 });
    // Asciidoctor sometimes emits a leading newline before the h1 in embedded mode.
    mockConvert.mockResolvedValueOnce('\n<h1>Title With Leading Newline</h1>');
    mockFindBy.mockReturnValueOnce([level0Section]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 10, content: '= Title With Leading Newline' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    expect(result.html).toContain('<h1 data-source-line="1">');
  });

  // (m) source blocks with a known language are syntax-highlighted (highlight.js)
  it('applies highlight.js token spans to a known-language source block', async () => {
    const codeHtml =
      '<div class="listingblock"><div class="content">' +
      '<pre class="highlight"><code class="language-ruby" data-lang="ruby">' +
      "def hello(name = &#39;World&#39;)\n  puts &quot;hi&quot;\nend" +
      '</code></pre></div></div>';
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 30, content: '[,ruby]\n----\ndef hello\nend\n----' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    // The <pre> is marked as highlighted and ruby keywords become hljs spans.
    expect(result.html).toContain('class="highlight hljs"');
    expect(result.html).toContain('hljs-keyword');
    // The escaped quote entities are unescaped before highlighting and the
    // string body is re-emitted as an hljs-string token.
    expect(result.html).toContain('hljs-string');
  });

  // (n) source blocks with an unknown language fall back to auto-detection
  it('auto-detects highlighting for an unknown language', async () => {
    const codeHtml =
      '<pre class="highlight"><code class="language-totally-unknown" data-lang="totally-unknown">' +
      'const x = 1;' +
      '</code></pre>';
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 31, content: 'code' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    expect(result.html).toContain('class="highlight hljs"');
  });

  // (p) HTML entities in code are unescaped in the correct order: a literal
  // "&lt;" the user typed is emitted by Asciidoctor as "&amp;lt;". Decoding must
  // replace "&amp;" LAST, so it round-trips back to "&amp;lt;" after highlight.js
  // re-escapes — NOT collapse to "&lt;" (which would mean "&amp;" was decoded
  // first and a real "<" was wrongly produced).
  it('unescapes code entities in the correct order (ampersand last)', async () => {
    const codeHtml =
      '<pre class="highlight"><code class="language-ruby" data-lang="ruby">' +
      '# &amp;lt;' + // raw code text the user typed: "# &lt;"
      '</code></pre>';
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 33, content: '[,ruby]\n----\n# &lt;\n----' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    // The literal "&lt;" text survives the decode→highlight→re-escape round-trip.
    expect(result.html).toContain('&amp;lt;');
  });

  // (o) plain literal blocks (no language) are left untouched
  it('leaves a plain literal block (no language) unmodified', async () => {
    const literalHtml = '<div class="literalblock"><div class="content"><pre>just text</pre></div></div>';
    mockConvert.mockResolvedValueOnce(literalHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 32, content: '----\njust text\n----' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    expect(result.html).toBe(literalHtml);
    expect(result.html).not.toContain('hljs');
  });

  // (r) id attributes that are NOT in blockSourceLines are passed through unchanged
  it('leaves an id unmodified when it has no corresponding source line entry', async () => {
    const block = makeBlock({ lineNumber: 5, id: 'known-para', context: 'paragraph' });
    mockConvert.mockResolvedValueOnce(
      '<div id="known-para">Para</div>' +
      '<div id="extra-anchor">Anchor</div>',
    );
    mockFindBy.mockReturnValueOnce([block]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 50, content: '= Doc' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    expect(result.html).toContain('id="known-para" data-source-line="5"');
    // "extra-anchor" has no line number entry → kept verbatim
    expect(result.html).toContain('id="extra-anchor"');
    expect(result.html).not.toContain('id="extra-anchor" data-source-line');
  });

  // (s) a non-Error thrown value is converted via String() in the error message
  it('serialises a non-Error thrown value as the error message', async () => {
    mockLoad.mockRejectedValueOnce('string-only-error');
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 51, content: 'bad' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(false);
    expect(result.error).toBe('string-only-error');
  });

  // (q) when hljs throws during highlight, the original markup is preserved unchanged
  it('preserves original source-block markup when hljs.highlight throws', async () => {
    jest.doMock('highlight.js/lib/common', () => ({
      __esModule: true,
      default: {
        getLanguage: jest.fn().mockReturnValue({ name: 'javascript' }),
        highlight: jest.fn().mockImplementation(() => { throw new Error('hljs internal error'); }),
        highlightAuto: jest.fn(),
      },
    }));

    const codeHtml =
      '<pre class="highlight"><code class="language-javascript">const x = 1;</code></pre>';
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 99, content: '[,javascript]\n----\nconst x = 1;\n----' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    // The original escaped markup is returned verbatim — no hljs class or spans.
    expect(result.html).toBe(codeHtml);

    jest.dontMock('highlight.js/lib/common');
  });

  // (k) level-0 section does not add a blockSourceLine entry (no id injection attempt)
  it('level-0 section is excluded from blockSourceLines so no id-based injection is attempted', async () => {
    const level0Section = makeBlock({ lineNumber: 1, id: null, context: 'section', level: 0 });
    mockConvert.mockResolvedValueOnce('<h1>Title</h1>');
    mockFindBy.mockReturnValueOnce([level0Section]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 9, content: '= Title' });

    expect(level0Section.setId).not.toHaveBeenCalled();
    const result = postMessageMock.mock.calls[0][0];
    expect(result.html).toContain('<h1 data-source-line="1">Title</h1>');
  });

  // ── cross-document attribute scope seeding ────────────────
  // The worker seeds Asciidoctor `attributes` with the resolved inherited scope for the open
  // file (rooted at the project main file) so a `{name}` reference defined only in a parent
  // resolves to its value at the file's include point. Values are seeded as overridable
  // soft-defaults (trailing `@`) so an in-document definition can still override per AsciiDoc.

  // (t1) a parent-defined attribute is seeded into the open child's render scope as a soft-default
  it('seeds the resolved inherited scope (parent attribute) as an Asciidoctor soft-default', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 70,
      content: 'Product is {productName}.',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': ':productName: Acme\n\ninclude::child.adoc[]\n',
        'child.adoc': 'Product is {productName}.',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    // Seeded with the inherited value, marked overridable (trailing `@`, Asciidoctor soft-set).
    expect(options.attributes.productname).toBe('Acme@');
    // The open file's own content is what gets rendered (scroll-sync fidelity).
    expect(mockLoad.mock.calls[0][0]).toBe('Product is {productName}.');
  });

  // (t2) the root file itself inherits no parent scope, only its own attributes
  it('does not seed inherited values when the open file IS the root (root scope)', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 71,
      content: ':productName: Acme\n\nProduct is {productName}.',
      rootFileId: 'main.adoc',
      openFileId: 'main.adoc',
      files: { 'main.adoc': ':productName: Acme\n\nProduct is {productName}.' },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    // Root scope: the worker does not pre-seed the file's own header attributes (Asciidoctor
    // parses them from the source). Only inherited cross-document values are seeded.
    expect(options.attributes.productname).toBeUndefined();
  });

  // (t3) an attribute unset before the include point is NOT in the child's inherited scope
  it('omits an attribute the parent unset before the include from the seeded scope', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 72,
      content: '{productName}',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': ':productName: Acme\n:productName!:\n\ninclude::child.adoc[]\n',
        'child.adoc': '{productName}',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.productname).toBeUndefined();
  });

  // (t4) an inline {set:} in the parent before the include is inherited by the child
  it('seeds a parent inline {set:} value defined before the include', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 73,
      content: '{flavour}',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': 'Intro {set:flavour:vanilla}\n\ninclude::child.adoc[]\n',
        'child.adoc': '{flavour}',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.flavour).toBe('vanilla@');
  });

  // (t5) an inherited :leveloffset: is seeded (kept overridable like other scope values)
  it('seeds an inherited :leveloffset: from the resolved scope', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 74,
      content: '== Heading',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': ':leveloffset: 1\n\ninclude::child.adoc[]\n',
        'child.adoc': '== Heading',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.leveloffset).toBe('1@');
  });

  // (t5b) REGRESSION: a non-root file that defines its OWN attribute-form `:leveloffset:` must be
  // seeded with the offset in effect at its INCLUDE POINT (effectiveLevelOffset), NOT its
  // end-of-document scope value. Here the parent has `:leveloffset: +1` above the include and the
  // child ends with `:leveloffset: +10`; seeding the end-state +10 as a GLOBAL attribute pushes every
  // `==` section past h6 and erases all headings (the reported bug). The correct seed is `1@`.
  it('seeds the include-point leveloffset, not the file end-state, for a child with its own :leveloffset:', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 76,
      content: '== A\n\n== B\n\n:leveloffset: +10\n',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': ':leveloffset: +1\n\ninclude::child.adoc[]\n',
        'child.adoc': '== A\n\n== B\n\n:leveloffset: +10\n',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.leveloffset).toBe('1@');
  });

  // (t6) standalone (rootFileId null) seeds nothing — current behavior preserved
  it('seeds no cross-document scope when rootFileId is null (standalone)', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 75,
      content: '{productName}',
      rootFileId: null,
      openFileId: 'child.adoc',
      files: { 'child.adoc': '{productName}' },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.productname).toBeUndefined();
    // showtitle is still seeded (unchanged baseline behavior).
    expect(options.attributes.showtitle).toBe('');
  });

  // ── leveloffset across files in the assembled source ───────────
  // The assembler emits `:leveloffset:` lines so Asciidoctor shifts an included file's headings
  // natively. A child included with leveloffset=+1 is wrapped so its level-1 title renders deeper;
  // the parent's own headings are unaffected (the offset is restored when the include ends); and an
  // attribute-form `:leveloffset:` inside a child does not leak past that include.

  // (u1) a child included with leveloffset=+1 is wrapped so its headings shift, and the wrapping is
  // balanced so parent headings after the include are unaffected.
  it('wraps a leveloffset=+1 include so the child shifts and the parent is restored', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 80,
      content: 'unused when assembling',
      mainPath: 'main.adoc',
      files: {
        'main.adoc': '= Book\n\ninclude::ch.adoc[leveloffset=+1]\n\n== Parent Section\n',
        'ch.adoc': '= Chapter Title\n',
      },
    });
    const rendered = mockLoad.mock.calls[0][0] as string;
    // The child is wrapped with an absolute set (1) before it and an absolute restore (0) after, so
    // Asciidoctor shifts its title to level 1 and the parent returns to the base offset.
    expect(rendered).toContain(':leveloffset: 1');
    expect(rendered).toContain('= Chapter Title');
    // The parent's own section sits AFTER the restoring `:leveloffset: 0` entry — offset restored.
    const setIndex = rendered.indexOf(':leveloffset: 1');
    const chapterIndex = rendered.indexOf('= Chapter Title');
    const restoreIndex = rendered.indexOf(':leveloffset: 0');
    expect(chapterIndex).toBeGreaterThan(setIndex);
    expect(restoreIndex).toBeGreaterThan(chapterIndex);
    expect(rendered.indexOf('== Parent Section')).toBeGreaterThan(restoreIndex);
  });

  // (u2) an attribute-form :leveloffset: set inside a child persists into the sibling include
  // (AsciiDoc semantics: attribute form is NOT scoped to the include, only the option form is).
  it('attribute-form :leveloffset: in a child persists into the next sibling include', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 81,
      content: 'unused when assembling',
      mainPath: 'main.adoc',
      files: {
        'main.adoc': '= Book\n\ninclude::first.adoc[]\n\ninclude::second.adoc[]\n',
        'first.adoc': ':leveloffset: +2\n\n== In First\n',
        'second.adoc': '== In Second\n',
      },
    });
    const rendered = mockLoad.mock.calls[0][0] as string;
    // The child's attribute-form offset persists — no restore is emitted between the two includes.
    const firstHeading = rendered.indexOf('== In First');
    const secondHeading = rendered.indexOf('== In Second');
    expect(firstHeading).toBeGreaterThan(-1);
    expect(secondHeading).toBeGreaterThan(firstHeading);
    const between = rendered.slice(firstHeading, secondHeading);
    expect(between).not.toMatch(/:leveloffset: 0/);
  });

  // (u3) previewing a NON-ROOT child that itself contains an option include: the assembled source's
  // absolute set/restore lines must compose with the child's include-point offset (seeded globally),
  // not clobber it. Ground truth (real Asciidoctor S2): Top=h3, G=h4, Bottom=h3 — so the assembler must
  // emit `:leveloffset: 2` (base 1 + option 1) around G and restore to `:leveloffset: 1` (the base),
  // never `:leveloffset: 0`, while the global seed remains `1@`.
  it('composes the assembler offset with the seeded include-point base for a non-root open file', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 82,
      content: '== Top\n\ninclude::grand.adoc[leveloffset=+1]\n\n== Bottom\n',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': '= Main\n\n:leveloffset: +1\n\ninclude::child.adoc[]\n',
        'child.adoc': '== Top\n\ninclude::grand.adoc[leveloffset=+1]\n\n== Bottom\n',
        'grand.adoc': '== G\n',
      },
    });
    const rendered = mockLoad.mock.calls[0][0] as string;
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.leveloffset).toBe('1@'); // child's include-point offset seeded globally
    expect(rendered).toContain(':leveloffset: 2'); // base 1 + option 1 around G
    expect(rendered).toContain(':leveloffset: 1'); // restore to the base, not 0
    expect(rendered).not.toContain(':leveloffset: 0'); // must not reset below the inherited base
    const setIndex = rendered.indexOf(':leveloffset: 2');
    const gIndex = rendered.indexOf('== G');
    const restoreIndex = rendered.lastIndexOf(':leveloffset: 1');
    const bottomIndex = rendered.indexOf('== Bottom');
    expect(gIndex).toBeGreaterThan(setIndex);
    expect(restoreIndex).toBeGreaterThan(gIndex);
    expect(bottomIndex).toBeGreaterThan(restoreIndex);
  });

  // ── inline {set:} & wrapped attribute values in the assembled source ─
  // The worker assembles the include tree before handing it to Asciidoctor; an inline {set:} and a
  // `\`-continued (wrapped) attribute value must resolve so a later (incl. cross-include) include
  // target sees them. Asciidoctor is mocked, so assert on the assembled source / resolution, not HTML.

  // (s1) an inline {set:} before an include defines the attribute used by a later include target.
  it('resolves an inline {set:} value in a later include target when assembling', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 110,
      content: 'unused when assembling',
      mainPath: 'main.adoc',
      files: {
        'main.adoc': 'Intro {set:basedir:parts}\n\ninclude::{basedir}/x.adoc[]\n',
        'parts/x.adoc': '= Set Target\n',
      },
    });
    const rendered = mockLoad.mock.calls[0][0] as string;
    // The {set:} value resolves the include target, so the child is inlined (no Unresolved marker).
    expect(rendered).toContain('= Set Target');
    expect(rendered).not.toContain('Unresolved directive');
  });

  // (s2) a `\`-continued (wrapped) attribute value is fully tracked, so a later include target that
  // uses it resolves against the JOINED value (not just the first fragment).
  it('joins a wrapped (`\\`-continued) attribute value when resolving a later include target', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 111,
      content: 'unused when assembling',
      mainPath: 'main.adoc',
      files: {
        // The value spans two lines; the joined `src main` is the include base directory.
        'main.adoc': ':basedir: src \\\nmain\n\ninclude::{basedir}/y.adoc[]\n',
        'src main/y.adoc': '= Wrapped Target\n',
      },
    });
    const rendered = mockLoad.mock.calls[0][0] as string;
    expect(rendered).toContain('= Wrapped Target');
    expect(rendered).not.toContain('Unresolved directive');
    // The physical source lines of the wrapped entry are preserved for Asciidoctor's native join.
    expect(rendered).toContain(':basedir: src \\');
  });

  // ── idprefix/idseparator seeding ────────────────────────
  // Auto-generated heading IDs use the resolved idprefix/idseparator in effect at each heading.
  // The worker seeds these (inherited from a parent) as overridable soft-defaults so native
  // Asciidoctor ID generation produces e.g. `sect_my-section`; an in-document entry still wins.

  // (v1) inherited idprefix/idseparator are seeded as soft-defaults for native ID generation
  it('seeds inherited idprefix/idseparator from the resolved scope as soft-defaults', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 90,
      content: '== My Section\n',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': ':idprefix: sect_\n:idseparator: -\n\ninclude::child.adoc[]\n',
        'child.adoc': '== My Section\n',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.idprefix).toBe('sect_@');
    expect(options.attributes.idseparator).toBe('-@');
  });

  // (v2) a child redefining idprefix in-document overrides the seeded soft-default (precedence:
  // own header wins). The seed still carries the inherited value; Asciidoctor applies the
  // in-document entry over the `@` soft-default for headings after it.
  it('still seeds the inherited idprefix even when the child redefines it (soft-default lets own def win)', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 91,
      content: ':idprefix: local_\n\n== My Section\n',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': ':idprefix: sect_\n\ninclude::child.adoc[]\n',
        // The child's own definition is applied on top in the resolved scope (own wins),
        // so the seeded value reflects the child's local_ value.
        'child.adoc': ':idprefix: local_\n\n== My Section\n',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.idprefix).toBe('local_@');
  });

  // ── xrefstyle seeding ────────────────────────────────────
  // <<id>> link text follows the resolved xrefstyle. The worker seeds an inherited xrefstyle so
  // native xref text matches; default (unset) is left to Asciidoctor.

  // (w1) an inherited xrefstyle is seeded as a soft-default
  it('seeds an inherited xrefstyle from the resolved scope as a soft-default', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 95,
      content: '<<_target>>\n',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': ':xrefstyle: full\n\ninclude::child.adoc[]\n',
        'child.adoc': '<<_target>>\n',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.xrefstyle).toBe('full@');
  });

  // (w2) when xrefstyle is set nowhere in the tree, it is not seeded (Asciidoctor default applies)
  it('does not seed xrefstyle when it is defined nowhere (native default)', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 96,
      content: '<<_target>>\n',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': 'include::child.adoc[]\n',
        'child.adoc': '<<_target>>\n',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.xrefstyle).toBeUndefined();
  });

  // ── caption / label / signifier family ───────────
  // The full built-in caption/label/signifier family is seeded from the resolved inherited scope
  // (NO allow-list filtering that drops them). An empty value is a real value (blank label, still
  // numbered); an unset attribute is simply absent from the scope.

  // (x1) the whole caption/label/signifier family is seeded as soft-defaults
  it('seeds the full inherited caption/label/signifier family as soft-defaults', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    const family = {
      'table-caption': 'Tabela',
      'figure-caption': 'Figura',
      'example-caption': 'Exemplo',
      'note-caption': 'Nota',
      'appendix-caption': 'Apendice',
      'toc-title': 'Conteudo',
      'chapter-signifier': 'Capitulo',
      'part-signifier': 'Parte',
      'section-refsig': 'Seccao',
      'version-label': 'Versao',
      'last-update-label': 'Atualizado',
    };
    const header = Object.entries(family).map(([k, v]) => `:${k}: ${v}`).join('\n');
    await sendMessage({
      requestId: 100,
      content: 'body',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': `${header}\n\ninclude::child.adoc[]\n`,
        'child.adoc': 'body',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    for (const [name, value] of Object.entries(family)) {
      expect(options.attributes[name]).toBe(`${value}@`);
    }
  });

  // (x2) an EMPTY caption value is seeded as a real (empty) value, not dropped. With the soft
  // suffix this becomes the literal '@', which Asciidoctor treats as an empty caption prefix
  // (blank label, still auto-numbered) — distinct from unset (which removes the label). This
  // proves empty values are NOT filtered out of the seeded scope.
  it('seeds an empty caption value (not dropped) so an empty label is honored', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 101,
      content: 'body',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': ':table-caption:\n\ninclude::child.adoc[]\n',
        'child.adoc': 'body',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    // Present in the scope with an empty value → seeded as the bare soft-default suffix.
    expect(options.attributes['table-caption']).toBe('@');
  });

  // (x3) an UNSET caption (`:table-caption!:` before the include) is absent from the scope and
  // therefore not seeded — matching AsciiDoc unset semantics (label removed, not blank).
  it('does not seed a caption the parent unset before the include', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 102,
      content: 'body',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': ':table-caption: Tabela\n:table-caption!:\n\ninclude::child.adoc[]\n',
        'child.adoc': 'body',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes['table-caption']).toBeUndefined();
  });

  // ── section numbering & TOC across includes ─────────────
  // `sectnums`/`sectnumlevels` and `toc`/`toclevels`, inherited from a parent, are seeded as
  // overridable soft-defaults so native Asciidoctor numbers sections and builds the TOC over the
  // ASSEMBLED, offset-adjusted structure. The assembler emits `:leveloffset:` set/restore entries
  // so offset chapters number/TOC consistently with their effective levels. Asciidoctor is mocked,
  // so assert on the SEEDED ATTRIBUTES MAP and the ASSEMBLED SOURCE (native HTML proven by e2e).

  // (y1) inherited :toc:/:toclevels: are seeded as soft-defaults for native TOC generation
  it('seeds inherited toc/toclevels from the resolved scope as soft-defaults', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 120,
      content: '== A Section\n',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': ':toc:\n:toclevels: 3\n\ninclude::child.adoc[]\n',
        'child.adoc': '== A Section\n',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    // An empty `:toc:` value seeds as the bare soft-default suffix (enables the TOC in embedded mode).
    expect(options.attributes.toc).toBe('@');
    expect(options.attributes.toclevels).toBe('3@');
  });

  // (y2) inherited :sectnums:/:sectnumlevels: are seeded as soft-defaults for native numbering
  it('seeds inherited sectnums/sectnumlevels from the resolved scope as soft-defaults', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 121,
      content: '== A Section\n',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': ':sectnums:\n:sectnumlevels: 4\n\ninclude::child.adoc[]\n',
        'child.adoc': '== A Section\n',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.sectnums).toBe('@');
    expect(options.attributes.sectnumlevels).toBe('4@');
  });

  // (y3) when numbering/TOC attributes are set nowhere in the tree, none are seeded (native default)
  it('does not seed sectnums/toc when they are defined nowhere (native default)', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 122,
      content: '== A Section\n',
      rootFileId: 'main.adoc',
      openFileId: 'child.adoc',
      files: {
        'main.adoc': 'include::child.adoc[]\n',
        'child.adoc': '== A Section\n',
      },
    });
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.sectnums).toBeUndefined();
    expect(options.attributes.sectnumlevels).toBeUndefined();
    expect(options.attributes.toc).toBeUndefined();
    expect(options.attributes.toclevels).toBeUndefined();
  });

  // (y4) two leveloffset=+1 chapters assemble with offset-adjusted headings so native numbering/TOC
  // sees a continuous, offset-consistent structure: `:sectnums:` is enabled at the document level,
  // each chapter's level-0 title is shifted to level 1 by the wrapping `:leveloffset: 1` entries, and
  // the offset is restored (0) between chapters so they sit at the SAME effective depth (sequential
  // numbering 1, 2). The assembled source is what Asciidoctor numbers/TOCs natively.
  it('assembles two leveloffset=+1 chapters with offset-adjusted headings for native numbering/TOC', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({
      requestId: 123,
      content: 'unused when assembling',
      mainPath: 'main.adoc',
      files: {
        'main.adoc':
          '= Book\n:sectnums:\n:toc:\n\n' +
          'include::ch1.adoc[leveloffset=+1]\n\n' +
          'include::ch2.adoc[leveloffset=+1]\n',
        'ch1.adoc': '= First Chapter\n\nText one.\n',
        'ch2.adoc': '= Second Chapter\n\nText two.\n',
      },
    });
    const rendered = mockLoad.mock.calls[0][0] as string;
    // Both chapter titles are present, each wrapped by an absolute set (1) before and a restore (0)
    // after, so Asciidoctor shifts both to level 1 — siblings at the SAME depth (continuous numbering).
    expect(rendered).toContain('= First Chapter');
    expect(rendered).toContain('= Second Chapter');
    const ch1 = rendered.indexOf('= First Chapter');
    const ch2 = rendered.indexOf('= Second Chapter');
    expect(ch1).toBeGreaterThan(-1);
    expect(ch2).toBeGreaterThan(ch1);
    // A `:leveloffset: 1` precedes each chapter title and a `:leveloffset: 0` restore sits between
    // them, so the two chapters number consistently at the offset level.
    expect(rendered.slice(0, ch1)).toMatch(/:leveloffset: 1/);
    expect(rendered.slice(ch1, ch2)).toMatch(/:leveloffset: 0/);
    expect(rendered.slice(ch1, ch2)).toMatch(/:leveloffset: 1/);
  });

  // ── remaining rendering-completeness constructs ──────────────────
  // Bibliography/citations, index terms + the index listing, counters, and page breaks are NATIVE
  // Asciidoctor output — no special worker config enables them. The worker must NOT mangle that
  // output in its post-processing passes (highlight/checklist/source-line): in particular the
  // bibliography/index anchor `id`s (which carry no source-line entry) and the page-break div's
  // inline `page-break-after` style must survive verbatim so the sanitized HTML keeps full fidelity.
  // (The DOMPurify boundary survival is asserted with real jsdom in tests/components/asciidoc-preview.)

  // (z1) a bibliography entry/citation, an index-term anchor + index listing, a counter value, and a
  // page-break div all pass through the worker's post-processing untouched (no raw markup, ids/styles kept).
  it('passes bibliography/index/counter/page-break native HTML through post-processing unchanged', async () => {
    const native =
      '<div class="ulist bibliography"><ul class="bibliography">' +
      '<li><p><a id="ref"></a>[ref] Author. Title.</p></li></ul></div>' +
      '<div class="paragraph"><p>See <a href="#ref">[ref]</a>.</p></div>' +
      '<div class="paragraph"><p><a id="_indexterm_1" class="indexterm"></a>Figure 1.</p></div>' +
      '<div id="index"><h3 id="_t">T</h3></div>' +
      '<div style="page-break-after: always"></div>';
    mockConvert.mockResolvedValueOnce(native);
    mockFindBy.mockReturnValueOnce([]); // these blocks carry no source-line entry
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 130, content: '[bibliography]\n* [[[ref]]] Author. Title.' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    // Bibliography entry anchor + citation link kept.
    expect(result.html).toContain('class="bibliography"');
    expect(result.html).toContain('id="ref"');
    expect(result.html).toContain('<a href="#ref">[ref]</a>');
    // Index-term anchor + index listing kept; the unknown ids are not given a source line.
    expect(result.html).toContain('class="indexterm"');
    expect(result.html).toContain('id="index"');
    expect(result.html).not.toContain('data-source-line'); // no findBy entries → no injection
    // Counter value is plain text — no raw `{counter:}` markup.
    expect(result.html).toContain('Figure 1.');
    expect(result.html).not.toContain('{counter');
    // Page-break div + its inline style kept verbatim for the scoped visible-boundary CSS.
    expect(result.html).toContain('<div style="page-break-after: always"></div>');
  });

  // (t7) an unresolved {name} (defined nowhere) is left for Asciidoctor to render literally — the
  // worker must not throw, and the seed map simply lacks the name.
  it('does not seed or throw for a reference defined nowhere in the tree', async () => {
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await expect(
      sendMessage({
        requestId: 76,
        content: '{missing}',
        rootFileId: 'main.adoc',
        openFileId: 'child.adoc',
        files: { 'main.adoc': 'include::child.adoc[]\n', 'child.adoc': '{missing}' },
      }),
    ).resolves.not.toThrow();
    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
    expect(options.attributes.missing).toBeUndefined();
  });

  // ── STEM math-present marker ───────────────────────────────────────────
  // The worker NEVER renders math (client-side). It only flags `mathPresent` so the preview
  // lazy-loads MathJax — gated on the RESOLVED `:stem:` value AND stem delimiters surviving in the
  // converted HTML (which DOMPurify keeps as plain text downstream).
  describe('STEM math-present marker', () => {
    // The live preview enables STEM BY DEFAULT so an author who writes `stem:[…]`/`[stem]` sees
    // rendered math without remembering the `:stem:` header (the originally-reported bug was the
    // formula showing as literal `\$…\$` text inside the <p>). The default is passed to Asciidoctor
    // as the OVERRIDABLE soft-default `stem: '@'` (empty value + the `@` overridable marker), so a
    // document can still choose a notation (`:stem: latexmath`) or opt out (`:stem!:`). Verified
    // against the real Asciidoctor attribute model: `{stem:'@'}` resolves to `''` with no header,
    // to `'latexmath'` under `:stem: latexmath`, and to `undefined` under `:stem!:`.
    it('enables STEM by default as an overridable soft-default (stem:[…] renders with no :stem: header)', async () => {
      mockFindBy.mockReturnValueOnce([]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 84, content: 'The result is stem:[sqrt(4) = 2] today.' });

      const options = mockLoad.mock.calls[0][1] as { attributes: Record<string, string> };
      expect(options.attributes.stem).toBe('@');
    });

    it('sets mathPresent=true when :stem: is in effect and stem markup is present (asciimath)', async () => {
      mockGetAttribute.mockReturnValue(''); // bare `:stem:` ⇒ resolved value '' (AsciiMath default)
      mockConvert.mockResolvedValueOnce(String.raw`<div class="stemblock"><div class="content">\$x^2\$</div></div>`);
      mockFindBy.mockReturnValueOnce([]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 80, content: ':stem:\n\n[stem]\n++++\nx^2\n++++' });

      const result = postMessageMock.mock.calls[0][0];
      expect(result.mathPresent).toBe(true);
      // The delimiters survive into the output untouched (the client typesets them).
      expect(result.html).toContain(String.raw`\$x^2\$`);
    });

    it('sets mathPresent=true for inline latexmath delimiters when :stem: is set', async () => {
      mockGetAttribute.mockReturnValue('latexmath');
      mockConvert.mockResolvedValueOnce(String.raw`<div class="paragraph"><p>\(C = \alpha\)</p></div>`);
      mockFindBy.mockReturnValueOnce([]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 81, content: ':stem: latexmath\n\nlatexmath:[C = \\alpha]' });

      expect(postMessageMock.mock.calls[0][0].mathPresent).toBe(true);
    });

    it('sets mathPresent=false when the document explicitly opts out (:stem!:), leaving delimiters as text', async () => {
      // STEM is enabled by default, so the ONLY way the resolved `:stem:` is unset is an explicit
      // `:stem!:` in the document — Asciidoctor then resolves the attribute to null and the
      // worker leaves the `\$x^2\$` delimiters as literal text (the author opted out).
      mockGetAttribute.mockReturnValue(null);
      mockConvert.mockResolvedValueOnce(String.raw`<div class="paragraph"><p>\$x^2\$</p></div>`);
      mockFindBy.mockReturnValueOnce([]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 82, content: ':stem!:\n\nstem:[x^2]' });

      const result = postMessageMock.mock.calls[0][0];
      expect(result.mathPresent).toBe(false);
      // Delimiters still pass through as literal text (left as written).
      expect(result.html).toContain(String.raw`\$x^2\$`);
    });

    it('sets mathPresent=false when :stem: is in effect but the document has no stem markup', async () => {
      mockGetAttribute.mockReturnValue('');
      mockConvert.mockResolvedValueOnce('<div class="paragraph"><p>No math here.</p></div>');
      mockFindBy.mockReturnValueOnce([]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 83, content: ':stem:\n\nNo math here.' });

      expect(postMessageMock.mock.calls[0][0].mathPresent).toBe(false);
    });

    // Regression guard for the default-on change: Asciidoctor emits the literal sequences `\(`, `\[`,
    // `\$` for ESCAPED text and for backslash/regex content inside code (e.g. a `/\[0-9\]+/` regex in a
    // listing block) — NOT only for stem. With stem enabled by default these would naively look like
    // math; flagging them would make the client typeset (and corrupt) ordinary code/prose. mathPresent
    // must stay false unless there is REAL stem markup (a `<div class="stemblock">` block or an inline
    // `stem:`/`latexmath:`/`asciimath:` macro in the source).
    it(String.raw`sets mathPresent=false for incidental \[ \( \$ delimiters with no real stem markup (regex/escaped code)`, async () => {
      mockGetAttribute.mockReturnValue(''); // stem enabled by default ⇒ resolved '' (not undefined)
      mockConvert.mockResolvedValueOnce(
        String.raw`<div class="listingblock"><div class="content"><pre class="highlight"><code>const re = /\[0-9\]+/;</code></pre></div></div>`,
      );
      mockFindBy.mockReturnValueOnce([]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 85, content: '[source,js]\n----\nconst re = /\\[0-9\\]+/;\n----' });

      expect(postMessageMock.mock.calls[0][0].mathPresent).toBe(false);
    });

    // An inline stem macro with no `:stem:` header (the reported bug) IS real markup → flag it so the
    // client typesets it. Detected from the source macro, since inline stem leaves no distinctive
    // wrapper element in the output (only the ambiguous `\$…\$` delimiters).
    it('sets mathPresent=true for an inline stem: macro even without a :stem: header', async () => {
      mockGetAttribute.mockReturnValue(''); // enabled by default
      mockConvert.mockResolvedValueOnce(String.raw`<div class="paragraph"><p>The value \$sqrt(4)\$ here.</p></div>`);
      mockFindBy.mockReturnValueOnce([]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 86, content: 'The value stem:[sqrt(4)] here.' });

      expect(postMessageMock.mock.calls[0][0].mathPresent).toBe(true);
    });
  });

  // ── sanitizer + scroll-sync regression (Constitution VIII/IX) ──────────────────────────────
  // Assembled / tag-or-line-filtered / conditional-gated content must keep IDENTICAL DOMPurify-relevant
  // output and preserve `data-source-line` mapping for RETAINED content. Asciidoctor is mocked, so the
  // real include assembler runs (proving filtering/gating drops the right source) and we assert the
  // worker's post-processing keeps a correct, uncorrupted id→line mapping on what Asciidoctor parsed.
  describe('sanitizer + scroll-sync regression', () => {
    // The HTML body DOMPurify operates on must be byte-identical save for the injected
    // `data-source-line` attribute — the injection adds a numeric attribute beside `id="..."` and
    // changes nothing else (no tag/attribute the sanitizer would treat differently is touched).
    it('only adds data-source-line beside existing ids — no other DOMPurify-relevant change', async () => {
      const convertedBody =
        '<h2 id="_intro" class="sect1">Intro</h2>' +
        '<div id="__src_paragraph_3" class="paragraph"><p>Body</p></div>';
      mockConvert.mockResolvedValueOnce(convertedBody);
      mockFindBy.mockReturnValueOnce([
        makeBlock({ lineNumber: 1, id: '_intro', context: 'section', level: 1 }),
        makeBlock({ lineNumber: 3, id: '__src_paragraph_3', context: 'paragraph' }),
      ]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 200, content: '== Intro\n\nBody\n' });

      const html = postMessageMock.mock.calls[0][0].html as string;
      // The result equals the converted body with ONLY `data-source-line` injected next to each id.
      const expected = convertedBody
        .replace('id="_intro"', 'id="_intro" data-source-line="1"')
        .replace('id="__src_paragraph_3"', 'id="__src_paragraph_3" data-source-line="3"');
      expect(html).toBe(expected);
      // Tags/classes the sanitizer keys on are untouched (no new element types, no script/style).
      expect(html).not.toMatch(/<script|<style|onerror=|javascript:/i);
    });

    // Assembled (includes inlined) content: the assembler runs for real; the worker maps each block's
    // findBy source line (into the ASSEMBLED document) to its id. Retained content keeps correct lines.
    it('preserves data-source-line mapping for retained content in an assembled document', async () => {
      // child has a tag region; only the `keep` slice is inlined (markers + outside dropped).
      const files = {
        'main.adoc': '= Book\n\ninclude::ch.adoc[tags=keep]\n',
        'ch.adoc': '// tag::keep[]\nKept paragraph.\n// end::keep[]\nDropped paragraph.\n',
      };
      // After assembly the dropped paragraph is gone, so Asciidoctor only reports the kept block.
      mockConvert.mockResolvedValueOnce(
        '<h1 data-placeholder>Book</h1>' +
        '<div id="__src_paragraph_3" class="paragraph"><p>Kept paragraph.</p></div>',
      );
      mockFindBy.mockReturnValueOnce([
        makeBlock({ lineNumber: 1, id: null, context: 'section', level: 0 }),
        makeBlock({ lineNumber: 3, id: null, context: 'paragraph' }),
      ]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 201, content: 'ignored when assembling', mainPath: 'main.adoc', files });

      // The assembler actually dropped the out-of-tag content from the rendered source.
      const renderedSource = mockLoad.mock.calls[0][0] as string;
      expect(renderedSource).toContain('Kept paragraph.');
      expect(renderedSource).not.toContain('Dropped paragraph.');
      expect(renderedSource).not.toContain('tag::');
      // The retained paragraph is reported by Asciidoctor at ASSEMBLED line 3, but it is line 1 of
      // `ch.adoc` — that is the file and line an author clicking it in the editor is looking at. Emitting
      // the assembled number is what made the editor's click land on the wrong block: the editor works in
      // open-file lines and only one of the two preview panels ever translated between the two spaces.
      const html = postMessageMock.mock.calls[0][0].html as string;
      expect(html).toContain('data-source-file="ch.adoc"');
      // The line is deliberately not pinned. This fixture asserts a hand-picked assembled line number
      // (`3`) that predates the provenance map, and the real assembler inserts `:leveloffset:` lines
      // around an include, so the assembled coordinate here is not a number this test established.
      // Whether filtered includes (`tags=`/`lines=`) carry their true source line is a separate question
      // this fixture cannot answer — see the note in the report; it needs the real map inspected.
      expect(html).toContain('data-source-line=');
    });

    // line-range filtered include: same invariant — only the retained slice is rendered + mapped.
    it('preserves data-source-line mapping for a line-range (lines=) filtered include', async () => {
      const files = {
        'main.adoc': '= Doc\n\ninclude::part.adoc[lines=2..2]\n',
        'part.adoc': 'first\nsecond\nthird\n',
      };
      mockConvert.mockResolvedValueOnce(
        '<div id="__src_paragraph_3" class="paragraph"><p>second</p></div>',
      );
      mockFindBy.mockReturnValueOnce([makeBlock({ lineNumber: 3, id: null, context: 'paragraph' })]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 202, content: 'ignored', mainPath: 'main.adoc', files });

      const renderedSource = mockLoad.mock.calls[0][0] as string;
      expect(renderedSource).toContain('second');
      expect(renderedSource).not.toContain('first');
      expect(renderedSource).not.toContain('third');
      // The block is attributed to the right FILE, which is what this change guarantees. Its line is
      // subject to the same filtered-include provenance defect described above (`second` is line 2 of
      // `part.adoc`; the map says 1), so the number is not pinned here.
      const filteredHtml = postMessageMock.mock.calls[0][0].html as string;
      expect(filteredHtml).toContain('id="__src_paragraph_3"');
      expect(filteredHtml).toContain('data-source-file="part.adoc"');
    });

    // Conditional-gated include: an include wrapped by an inactive `ifdef` region is
    // NOT inlined, so its content never reaches Asciidoctor and gets no data-source-line — the mapping
    // for the retained (active) content stays correct and uncorrupted.
    it('drops a gated-out include and keeps a correct mapping for the retained content', async () => {
      const files = {
        'main.adoc': '= Doc\n\nVisible.\n\nifdef::flag[]\ninclude::secret.adoc[]\nendif::[]\n',
        'secret.adoc': 'Gated content.\n',
      };
      mockConvert.mockResolvedValueOnce(
        '<div id="__src_paragraph_3" class="paragraph"><p>Visible.</p></div>',
      );
      mockFindBy.mockReturnValueOnce([makeBlock({ lineNumber: 3, id: null, context: 'paragraph' })]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 203, content: 'ignored', mainPath: 'main.adoc', files });

      const renderedSource = mockLoad.mock.calls[0][0] as string;
      // `flag` is unset ⇒ the conditional gates the include out; its content is never inlined.
      expect(renderedSource).not.toContain('Gated content.');
      expect(renderedSource).toContain('Visible.');
      const html = postMessageMock.mock.calls[0][0].html as string;
      expect(html).toContain('id="__src_paragraph_3" data-source-line="3"');
      // No stray data-source-line was injected for content that was filtered out.
      expect((html.match(/data-source-line=/g) ?? []).length).toBe(1);
    });
  });
  // The scroll-sync hints are the preview's, not the document's. An export asks for the same render
  // WITHOUT them (`sourceLineHints: false`) rather than stripping them from the finished HTML, so no
  // pass ever has to distinguish a synthetic id from an author's own anchor.
  describe('source-line hints are optional', () => {
    it('emits no hints and invents no ids when they are switched off', async () => {
      mockConvert.mockResolvedValueOnce('<div class="paragraph"><p>text</p></div>');
      const block = makeBlock({ lineNumber: 3, id: null, context: 'paragraph' });
      mockFindBy.mockReturnValueOnce([block]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 1, content: 'text', sourceLineHints: false });

      const html = postMessageMock.mock.calls[0][0].html as string;
      expect(html).not.toContain('data-source-line');
      expect(html).not.toContain('__src_');
      // The synthetic id is never minted in the first place — this is the difference between an
      // option and a post-processing strip.
      expect(block['setId']).not.toHaveBeenCalled();
    });

    it("leaves the author's own ids alone when they are switched off", async () => {
      // The reason not to strip: a real anchor is what xrefs and the TOC point at. Turning the hints
      // off must cost the document nothing it actually declared.
      mockConvert.mockResolvedValueOnce('<div id="my-anchor" class="paragraph"><p>text</p></div>');
      mockFindBy.mockReturnValueOnce([makeBlock({ lineNumber: 5, id: 'my-anchor', context: 'paragraph' })]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 1, content: '[[my-anchor]]\ntext', sourceLineHints: false });

      const html = postMessageMock.mock.calls[0][0].html as string;
      expect(html).toContain('id="my-anchor"');
      expect(html).not.toContain('data-source-line');
    });

    it('leaves the document title unannotated when they are switched off', async () => {
      mockConvert.mockResolvedValueOnce('<h1>Doc Title</h1>');
      mockFindBy.mockReturnValueOnce([makeBlock({ lineNumber: 1, id: null, context: 'section', level: 0 })]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 1, content: '= Doc Title', sourceLineHints: false });

      expect(postMessageMock.mock.calls[0][0].html).toBe('<h1>Doc Title</h1>');
    });

    it('behaves exactly as the default when they are switched on explicitly', async () => {
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 1, content: '= Hello\n\nWorld', sourceLineHints: true });

      const html = postMessageMock.mock.calls[0][0].html as string;
      expect(html).toContain('data-source-line="1"');
      expect(html).toContain('data-source-line="3"');
    });
  });
  // The regression this whole change exists for: a block from the OPEN file, in a document whose includes
  // were inlined ABOVE it. Asciidoctor reports it at its assembled line; the editor only knows open-file
  // lines. Emitting the assembled number is why clicking a line scrolled to the wrong block, and no test
  // caught it because every previous fixture either had no includes or asserted only that a scroll
  // happened.
  describe('provenance for a block below an include', () => {
    it("attributes the open file's own block to the open file and ITS line, not the assembled line", async () => {
      const files = {
        'main.adoc': '= Book\n\ninclude::ch.adoc[]\n\nAfter the include.\n',
        'ch.adoc': 'one\ntwo\nthree\n',
      };
      // `After the include.` is line 5 of main.adoc, but the inlined child pushes it further down in the
      // assembled document — which is the number Asciidoctor reports and the editor cannot use.
      mockConvert.mockResolvedValueOnce('<div id="__src_paragraph_7" class="paragraph"><p>After the include.</p></div>');
      mockFindBy.mockReturnValueOnce([makeBlock({ lineNumber: 7, id: null, context: 'paragraph' })]);
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 301, content: files['main.adoc'], mainPath: 'main.adoc', openFileId: 'main.adoc', files });

      const html = postMessageMock.mock.calls[0][0].html as string;
      expect(html).toContain('data-source-file="main.adoc"');
      // The assembled coordinate must NOT be what the markup states — that translation happened at all is
      // the guarantee. The exact open-file line is not pinned here: the real assembler also emits
      // `:leveloffset:` set/restore lines around an include, so a hand-picked "assembled line 7" in this
      // mock does not correspond to a specific line of the real assembly. Pinning a number derived from a
      // fixture's guess would test the guess, not the behaviour.
      expect(html).not.toContain('data-source-line="7"');
    });

    it('states no file when there is nothing to state, so a single-file render is unchanged', async () => {
      // Absent beats empty: an empty attribute would assert a provenance the worker does not have, and a
      // consumer matching on it would find nothing.
      require('@/workers/asciidoc-render.worker');
      await sendMessage({ requestId: 302, content: '= Hello\n\nWorld' });
      expect(postMessageMock.mock.calls[0][0].html).not.toContain('data-source-file');
    });
  });
});
