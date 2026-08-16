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
import type { RenderRequest } from '@/workers/render-protocol';
// Type-only, so the import is erased and does not defeat the `jest.doMock` the security tests install
// over this same module.
import type { OnDemandGrammar } from '@/workers/hljs-languages.generated';
import type { LanguageFn } from 'highlight.js';

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
// The request type comes from the protocol module rather than a hand-copied duplicate, which had
// already fallen behind it (no `projectAttributes`, no `showIncludes`).
async function sendMessage(data: RenderRequest): Promise<void> {
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

  // (e4) a monospaced table COLUMN is named, so a stylesheet can tell it from an inline codespan. The
  // PDF export draws the two differently — a monospaced cell takes the codespan's typeface and nothing
  // else, while a codespan is also given a box behind it — and Asciidoctor's HTML says the same thing
  // for both. The whole cell's text is only available here, which is why the distinction is drawn here.
  it('names a monospaced table cell, and leaves a codespan sharing its cell alone', async () => {
    mockConvert.mockResolvedValueOnce(
      '<table class="tableblock"><tbody>' +
        // A monospaced column's cell: the `<code>` is the whole cell.
        '<tr><td class="tableblock halign-left"><p class="tableblock"><code>Ctrl+F</code></p></td>' +
        // A monospaced column's cell carrying a codespan of its own, which nests.
        '<td class="tableblock"><p class="tableblock"><code><code>x</code> and y</code></p></td></tr>' +
        // A plain cell whose codespan shares it with text: not monospaced, and the export chips it.
        '<tr><td class="tableblock"><p class="tableblock">Insert <code>code</code></p></td>' +
        // A plain cell with a codespan that does not reach the end of it.
        '<td class="tableblock"><p class="tableblock"><code>code</code> first</p></td></tr>' +
        '</tbody></table>',
    );
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 32, content: '|===\n|a |b\n|===' });

    const { html } = postMessageMock.mock.calls[0][0];
    expect(html).toContain('<p class="tableblock monospaced"><code>Ctrl+F</code></p>');
    // The nested codespan is inside the cell's own `<code>`, so the cell is still the monospaced one.
    expect(html).toContain('<p class="tableblock monospaced"><code><code>x</code> and y</code></p>');
    // Neither plain cell is named: in one the codespan starts after text, in the other it ends before
    // the cell does. A selector cannot see either, which is the whole reason this runs here.
    expect(html).toContain('<p class="tableblock">Insert <code>code</code></p>');
    expect(html).toContain('<p class="tableblock"><code>code</code> first</p>');
    expect(html.match(/monospaced/g)?.length).toBe(2);
  });

  // The naming rule under NESTED cell paragraphs, which is the shape the pass is matched against and
  // the one it used to be cubic on. Asserted exactly, because the rewrite from a per-candidate walk to
  // one stack-matched pass is only worth having if it decides every one of these the same way:
  // an inner paragraph that is the whole of its enclosing cell is named too, an open with no close is
  // named nowhere, and a stray `</code>` closes the open before it and not the one it is nested in.
  it('names every cell of a nested run of cell paragraphs, and none of an unbalanced one', async () => {
    const open = '<p class="tableblock"><code>';
    mockConvert.mockResolvedValueOnce(
      // Three cell paragraphs nested inside one another: each one's own `<code>` is closed by the
      // `</code>` that its own `</p>` follows, so all three are cells.
      `${open.repeat(3)}${'</code></p>'.repeat(3)}` +
        // A cell paragraph whose `<code>` never closes: nothing to name, and nothing after it either.
        `${open}unclosed</p>` +
        // A stray close ahead of a cell paragraph must not be taken as that cell's own.
        `</code>${open}ok</code></p>`,
    );
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 33, content: '|===\n|a\n|===' });

    const { html } = postMessageMock.mock.calls[0][0];
    expect(html).toBe(
      '<p class="tableblock monospaced"><code>'.repeat(3) +
        '</code></p>'.repeat(3) +
        '<p class="tableblock"><code>unclosed</p>' +
        '</code><p class="tableblock monospaced"><code>ok</code></p>',
    );
  });

  // The same shape at document scale, as a COST bound rather than an example.
  //
  // A time assertion is the honest form here because the defect is a time property: the pass ran a
  // fresh walk per candidate and each of that walk's steps searched forward for a `<code` that was no
  // longer ahead, which scans to the end of the document. On this input — `<p class="tableblock">
  // <code>` × N then `</code></p>` × N, which `asciidoctor` emits byte for byte from a `++++`
  // passthrough block — that is cubic: 19 KB took 0.5 s, 38 KB 4.1 s and the 76 KB below 31.8 s, while
  // the parse and convert that produced the HTML together took 3.6 ms. The preview renders the
  // collaboratively synced document on a per-keystroke debounce, so one co-editor's paste wedged every
  // other editor's worker, in all three preview styles.
  //
  // The budget is deliberately three orders of magnitude above the cost: the pass now takes about a
  // millisecond here, so a runner would have to be a thousand times slower than a developer's machine
  // to fail this — while the behaviour it forbids overruns it by more than 30×, and overruns Jest's own
  // per-test timeout as well. A ratio between two sizes would be the more precise instrument and is
  // the more fragile one, because at these speeds both readings are noise.
  it('post-processes a deeply nested run of cell paragraphs in linear time', async () => {
    const nesting = 2000;
    const html = '<p class="tableblock"><code>'.repeat(nesting) + '</code></p>'.repeat(nesting);
    expect(html.length).toBeGreaterThan(76 * 1024);
    mockConvert.mockResolvedValueOnce(html);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');

    const startedAt = performance.now();
    await sendMessage({ requestId: 34, content: 'passthrough' });
    const elapsed = performance.now() - startedAt;

    // The work was really done, not skipped: every one of the nested paragraphs is a cell.
    expect(postMessageMock.mock.calls[0][0].html.match(/monospaced/g)).toHaveLength(nesting);
    expect(elapsed).toBeLessThan(1000);
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

  // (m2) a listing carrying callouts is highlighted too, with its markers left where they were
  it('highlights a source block that carries callout markers, and keeps them in place', async () => {
    // Asciidoctor puts the markers INSIDE the code element. A body pattern that assumed code holds
    // no markup matched nothing here, so a listing with callouts — the ordinary shape of an annotated
    // example — came back with no highlighting at all while the same code without them was coloured.
    const codeHtml =
      '<div class="listingblock"><div class="content">' +
      '<pre class="highlight"><code class="language-javascript" data-lang="javascript">' +
      'const doc = new Doc(); <i class="conum" data-value="1"></i><b>(1)</b>\n' +
      'const text = &quot;index.adoc&quot;; <i class="conum" data-value="2"></i><b>(2)</b>' +
      '</code></pre></div></div>';
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 32, content: 'code' });

    const html = postMessageMock.mock.calls[0][0].html;
    expect(html).toContain('class="highlight hljs"');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('hljs-string');
    // Both markers survive, and neither is swallowed into a token: the marker for the second line
    // follows that line's string rather than sitting inside it.
    expect(html).toContain('<i class="conum" data-value="1"></i><b>(1)</b>');
    expect(html).toContain('<i class="conum" data-value="2"></i><b>(2)</b>');
    // The marker text is not highlighted as part of the program.
    expect(html).not.toContain('<b>(<span');
  });

  it('leaves a callout-bearing block alone when the code also holds markup it cannot lift', async () => {
    // `subs="+macros"` turns a bare URL inside a listing into an anchor, so a block can hold BOTH a
    // link and a callout. The separation guard used to inspect only the text after the last marker,
    // which left every segment before one unguarded: its tags were decoded into the code text,
    // highlighted as program source and re-escaped, so the reader saw a raw `<a href=…>` as literal
    // text in their own document. An unrecognised body must come back exactly as it arrived.
    const linked =
      'puts <a href="https://example.com" class="bare">https://example.com</a> ' +
      '<i class="conum" data-value="1"></i><b>(1)</b>';
    const codeHtml =
      '<div class="listingblock"><div class="content">' +
      '<pre class="highlight"><code class="language-ruby" data-lang="ruby">' +
      linked +
      '</code></pre></div></div>';
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 33, content: 'code' });

    const html = postMessageMock.mock.calls[0][0].html;
    expect(html).toContain(linked);
    // Untouched means untouched: not highlighted, and above all not with the anchor turned into text.
    expect(html).not.toContain('hljs');
    expect(html).not.toContain('&lt;a href=');
  });

  it('highlights a listing whose callouts are drawn as images', async () => {
    // `convert_inline_callout` has three forms, not two: a font icon with its plain-text twin
    // (`icons=font`), the plain-text marker alone (no icons), and — for `icons` set to anything else
    // — an `<img>` pointing at the numbered callout icon. Only the first two were recognised while
    // the comment beside the pattern claimed both forms were covered, so a project rendering
    // callouts as images had every annotated listing come back with no highlighting at all.
    const codeHtml =
      '<div class="listingblock"><div class="content">' +
      '<pre class="highlight"><code class="language-javascript" data-lang="javascript">' +
      'const doc = new Doc(); <img src="./images/icons/callouts/1.png" alt="1">' +
      '</code></pre></div></div>';
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 36, content: 'code' });

    const html = postMessageMock.mock.calls[0][0].html;
    expect(html).toContain('class="highlight hljs"');
    expect(html).toContain('hljs-keyword');
    // The marker survives exactly as the converter wrote it, and is not highlighted as program text.
    expect(html).toContain('<img src="./images/icons/callouts/1.png" alt="1">');
    expect(html).not.toContain('&lt;img');
  });

  // (m3) a footnote entry's separator is named so a stylesheet can present the marker its own way
  it('names the separator after a footnote entry number', async () => {
    // Asciidoctor writes the "." after the back-link as a bare text node, which no selector can
    // reach — so a style that sets its markers off differently (the PDF brackets them) had no way to
    // suppress it and showed both. The span leaves the styles that keep the full stop unchanged.
    const footnoteHtml =
      '<div id="footnotes">\n<hr>\n' +
      '<div class="footnote" id="_footnotedef_1">\n<a href="#_footnoteref_1">1</a>. A remark.\n</div>\n' +
      '</div>';
    mockConvert.mockResolvedValueOnce(footnoteHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 33, content: 'text footnote:[A remark.]' });

    const html = postMessageMock.mock.calls[0][0].html;
    expect(html).toContain('<a href="#_footnoteref_1">1</a><span class="footnote-separator">. </span>');
    // The footnote's own text is untouched — only the marker's separator is wrapped.
    expect(html).toContain('A remark.');
  });

  // (m4) the sign between two key caps is named, for the same reason and with the same shape
  it('names the sign between the key caps of a chord', async () => {
    // Asciidoctor's HTML backend joins the caps with a bare `+`; the PDF renderer joins them with the
    // theme's own separator, whose default carries a narrow no-break space either side of the sign.
    // That air is most of the gap a reader sees between two caps, and a style could reach neither it
    // nor the sign while the sign was a text node. It cannot go on the caps themselves: a cap's box
    // is tinted, and the tint would run out under the separator.
    const chordHtml =
      '<div class="paragraph"><p>Press ' +
      '<span class="keyseq"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd></span>' +
      ' then <kbd>Esc</kbd>.</p></div>';
    mockConvert.mockResolvedValueOnce(chordHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 34, content: 'kbd:[Ctrl+Shift+P]' });

    const html = postMessageMock.mock.calls[0][0].html;
    // Both signs of a three-key chord, not just the first: the scan has to resume inside the run it
    // just rewrote or every chord past two keys keeps its second sign bare.
    expect(html).toContain(
      '<kbd>Ctrl</kbd><span class="keyseq-separator">+</span><kbd>Shift</kbd>' +
        '<span class="keyseq-separator">+</span><kbd>P</kbd>',
    );
    // A lone cap has nothing between it and anything else, and the text around the chord is prose.
    expect(html).toContain(' then <kbd>Esc</kbd>.');
  });

  it('leaves the prose between two independent key references as prose', async () => {
    // Asciidoctor wraps a CHORD in `<span class="keyseq">` and emits a bare `<kbd>` for a single
    // key, so the span is the only thing in the output that says two caps are one keystroke. Keyed
    // on the caps alone, a sentence mentioning two keys had the words between them tagged as a
    // separator and given the theme's air on either side. Nothing suppresses `.keyseq-separator`
    // today, which is why the visible cost was small — a rule that did would have deleted the
    // author's words. (The existing chord test could not catch this: its `</span>` supplies a `<`
    // that blocks the match by accident.)
    const proseHtml =
      '<div class="paragraph"><p>Press <kbd>Ctrl</kbd> and then <kbd>Alt</kbd> to switch.</p></div>';
    mockConvert.mockResolvedValueOnce(proseHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 35, content: 'kbd:[Ctrl] and then kbd:[Alt]' });

    const html = postMessageMock.mock.calls[0][0].html;
    expect(html).toContain('<kbd>Ctrl</kbd> and then <kbd>Alt</kbd>');
    expect(html).not.toContain('keyseq-separator');
  });

  // (n) a language with no grammar is GUESSED at, and the guess says so.
  //
  // DELIBERATE BEHAVIOUR CHANGE, not a loosened assertion. This test used to hold the opposite —
  // "left plain, never guessed at" — because guessing produced confidently wrong colour (a block of
  // `include::` directives came back with `include` as a keyword and its numbers as literals, in a
  // language it was never written in) and because the PDF, whose highlighter falls back to plain text
  // for a lexer it lacks, printed that same block in one colour.
  //
  // Both of those remain true, and neither is a statement about the WEB styles. The rule was written
  // for Print fidelity and applied to all three preview styles, because one rendered document serves
  // all three at once — so the two styles that only claim to present the document lost colour they
  // had always had, for a reason that has nothing to do with them. The split belongs where the styles
  // are, and that is where it now is: the guess is marked, and the generated region of
  // `print-preview.css` puts a marked block's tokens back at the code colour under Print alone.
  //
  // It has to be an attribute rather than a class: the rule beside it excludes the languages the
  // export DOES lex by class name, and 222 of the 392 names in rouge's registry have no grammar here
  // — a guessed block declaring one of those could never be reached by a class.
  it('guesses at a source block whose declared language has no grammar, and marks the guess', async () => {
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
    // The declared name is re-emitted untouched — it is the author's, and the detector's opinion of
    // what the code looks like is not a correction of it — and the marker is what says the colour was
    // detected rather than read off the grammar the block names.
    expect(result.html).toContain(
      '<code class="language-totally-unknown" data-lang="totally-unknown" data-hljs-guessed>',
    );
    // Coloured, by whatever the detector made of it — the point is that colour is emitted at all, not
    // which language it decided on, which is exactly the judgement the Print style declines.
    expect(result.html).toMatch(/<span class="hljs-[\w-]+">/);
  });

  // (n1b) and a block whose language IS answered for carries no such marker: the two must be
  // distinguishable, or the Print style would decline colour that came from the right grammar.
  it('does not mark a block highlighted from the grammar it declared', async () => {
    const codeHtml =
      '<pre class="highlight"><code class="language-ruby" data-lang="ruby">def x; end</code></pre>';
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 32, content: 'code' });

    const { html } = postMessageMock.mock.calls[0][0];
    expect(html).toContain('class="highlight hljs"');
    expect(html).toContain('hljs-keyword');
    expect(html).not.toContain('data-hljs-guessed');
  });

  // (n2) a language `highlight.js/lib/common` does not carry is fetched rather than left plain.
  //
  // The export highlights with rouge, which has a lexer for Dockerfile; the preview carried 36 of the
  // package's 192 grammars and left it alone. That is a Print-parity gap in the exact direction that
  // style promises not to have, and closing it must not weaken the rule above: a language NO grammar
  // answers to is still left plain, which is what (n) holds.
  it('fetches a grammar for a language the bundled set does not carry', async () => {
    const codeHtml =
      '<pre class="highlight"><code class="language-dockerfile" data-lang="dockerfile">' +
      'FROM node:20' +
      '</code></pre>';
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 61, content: '[,dockerfile]\n----\nFROM node:20\n----' });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    expect(result.html).toContain('class="highlight hljs"');
    expect(result.html).toContain('hljs-keyword');
  });

  // (n3) an overtaken render does not spend a round trip on a grammar, and does not paint with one.
  //
  // The reply is one the holder drops on arrival, so the fetch would buy nothing; and a grammar that
  // arrived after a newer render had already answered must not reach the older render's output. The
  // block is left plain — what this worker did for every unbundled language until now, never
  // something wrong — and the newer render colours it.
  it('skips on-demand grammars for a render another has already overtaken', async () => {
    const codeHtml =
      '<pre class="highlight"><code class="language-dockerfile" data-lang="dockerfile">' +
      'FROM node:20' +
      '</code></pre>';
    mockConvert.mockResolvedValue(codeHtml);
    mockFindBy.mockReturnValue([]);
    require('@/workers/asciidoc-render.worker');

    // Posted without awaiting the first, which is what a second keystroke does: the handler is
    // asynchronous, so the newer request arrives while the older one is still in flight.
    const overtaken = onMessageHandler!({ data: { requestId: 62, content: 'a' } } as MessageEvent);
    const newest = onMessageHandler!({ data: { requestId: 63, content: 'b' } } as MessageEvent);
    await Promise.all([overtaken, newest]);

    const [first, second] = postMessageMock.mock.calls.map((call) => call[0]);
    const overtakenResult = [first, second].find((result) => result.requestId === 62);
    const newestResult = [first, second].find((result) => result.requestId === 63);
    expect(overtakenResult.html).not.toContain('hljs-keyword');
    expect(overtakenResult.html).toContain(codeHtml);
    expect(newestResult.html).toContain('hljs-keyword');
  });

  // (n3b) one consumer's render does not overtake another's.
  //
  // "Overtaken" used to mean "any newer render, from anyone", because nothing on the wire said whose
  // a render was — so with two previews mounted, either one's keystroke silenced the other's grammar
  // fetches. The silenced consumer then ACCEPTED the reply, because its own `requestId` still
  // matched, and its listing came back uncoloured with nothing to say why until something else made
  // that panel render again. `consumerId` is what makes the question answerable, and this is the
  // difference it makes: the same two renders that must supersede each other in (n3) must not here.
  it('does not treat another consumer\'s render as overtaking this one', async () => {
    const codeHtml =
      '<pre class="highlight"><code class="language-dockerfile" data-lang="dockerfile">' +
      'FROM node:20' +
      '</code></pre>';
    mockConvert.mockResolvedValue(codeHtml);
    mockFindBy.mockReturnValue([]);
    require('@/workers/asciidoc-render.worker');

    // Two panels, each rendering its own document, each numbering its own requests from 1 — which is
    // exactly why `requestId` cannot tell them apart and `consumerId` has to.
    const first = onMessageHandler!({ data: { requestId: 1, consumerId: 7, content: 'a' } } as MessageEvent);
    const second = onMessageHandler!({ data: { requestId: 1, consumerId: 9, content: 'b' } } as MessageEvent);
    await Promise.all([first, second]);

    const replies = postMessageMock.mock.calls.map((call) => call[0]);
    expect(replies).toHaveLength(2);
    // BOTH are coloured. Neither is a stale render of the other's document.
    for (const reply of replies) expect(reply.html).toContain('hljs-keyword');
  });

  // (n4) two renders that overlap at a grammar fetch must not scan each other's documents.
  //
  // The block scanner's pattern carries its scan position on the regex object, and highlighting now
  // suspends inside its own loop. With one shared pattern, a render that resumes while another is
  // parked continues from — and leaves behind — a position taken in a DIFFERENT document, and the
  // parked one then scans its own from there. It skips whatever lies before it, silently.
  //
  // The overlap is arranged rather than hoped for: the older render is held inside the fetch until the
  // newer one has been posted, which is the only way it is still the newest when it enters the loop.
  // Its document ends with a block whose close never comes — an author mid-keystroke — so its scan
  // stops with its position left mid-document rather than reset by a failed match.
  it('highlights every block of the newest render while an older one is mid-fetch', async () => {
    let release: (() => void) | null = null;
    const held = new Promise<{ default: unknown }>((resolve) => {
      release = () => {
        resolve({ default: require('highlight.js/lib/languages/nginx') });
      };
    });
    jest.doMock('@/workers/hljs-languages.generated', () => ({
      __esModule: true,
      ON_DEMAND_GRAMMARS: new Map([['held', { name: 'held', spellings: ['held'], load: () => held }]]),
    }));

    const older =
      '<pre class="highlight"><code class="language-held" data-lang="held">server { listen 80; }</code></pre>' +
      '<pre class="highlight"><code class="language-held" data-lang="held">server { listen 8080;';
    const newer =
      '<pre class="highlight"><code class="language-held" data-lang="held">server { listen 443; }</code></pre>' +
      '<pre class="highlight"><code class="language-held" data-lang="held">server { listen 8443; }</code></pre>';
    mockConvert.mockResolvedValueOnce(older).mockResolvedValueOnce(newer);
    mockFindBy.mockReturnValue([]);
    require('@/workers/asciidoc-render.worker');

    const overtaken = onMessageHandler!({ data: { requestId: 64, content: 'a' } } as MessageEvent);
    // Everything already queued runs, which parks the first render inside the fetch it is still
    // entitled to make.
    await new Promise((resolve) => setImmediate(resolve));
    const newest = onMessageHandler!({ data: { requestId: 65, content: 'b' } } as MessageEvent);
    await new Promise((resolve) => setImmediate(resolve));
    release!();
    await Promise.all([overtaken, newest]);

    const newestResult = postMessageMock.mock.calls
      .map((call) => call[0])
      .find((result) => result.requestId === 65);
    // Both of its blocks, not just the one the other render's scan position happened to leave visible.
    expect(newestResult.html.match(/class="highlight hljs"/g)).toHaveLength(2);
    expect(newestResult.html).toContain('<span class="hljs-number">8443</span>');

    jest.dontMock('@/workers/hljs-languages.generated');
  });

  // (n4b) the grammars ONE render needs are fetched together, not one after the other.
  //
  // The fetch used to be awaited inside the walk over the blocks, so a document's grammars were
  // strictly sequential: a paper with forty listings in forty unbundled languages paid forty round
  // trips end to end before a single line of HTML went back, and the panel shows nothing until it
  // does. The languages are known before any of them is fetched — the whole document has already
  // been scanned — so there is nothing to serialise them for.
  //
  // Both loads are held open, which is what makes the difference observable: with them batched, both
  // have been ASKED for while neither has answered. Sequentially only the first would have been.
  it('fetches the grammars one document needs together rather than one after another', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    /**
     * A grammar that records when it is asked for and answers only when the test says so.
     *
     * @param name - The name the map is keyed by and the grammar is registered under.
     * @param definition - The highlight.js grammar to answer with.
     * @returns The map entry.
     */
    const heldGrammar = (name: string, definition: LanguageFn): OnDemandGrammar => ({
      name,
      spellings: [name],
      load: () => {
        started.push(name);
        return new Promise<{ default: LanguageFn }>((resolve) => {
          releases.push(() => resolve({ default: definition }));
        });
      },
    });
    jest.doMock('@/workers/hljs-languages.generated', () => ({
      __esModule: true,
      ON_DEMAND_GRAMMARS: new Map<string, OnDemandGrammar>([
        ['alpha', heldGrammar('alpha', require('highlight.js/lib/languages/nginx'))],
        ['beta', heldGrammar('beta', require('highlight.js/lib/languages/dockerfile'))],
      ]),
    }));

    const codeHtml =
      '<pre class="highlight"><code class="language-alpha" data-lang="alpha">server { listen 80; }</code></pre>' +
      '<pre class="highlight"><code class="language-beta" data-lang="beta">FROM node:20</code></pre>';
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');

    const render = onMessageHandler!({ data: { requestId: 69, content: 'a' } } as MessageEvent);
    // Everything already queued runs, which is as far as the render gets while both fetches are held.
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(['alpha', 'beta']);

    for (const release of releases) release();
    await render;

    const { html } = postMessageMock.mock.calls[0][0];
    // And both are painted with the grammar that was fetched for them.
    expect(html.match(/class="highlight hljs"/g)).toHaveLength(2);
    expect(html).toContain('<span class="hljs-number">80</span>');
    expect(html).toContain('<span class="hljs-keyword">FROM</span>');

    jest.dontMock('@/workers/hljs-languages.generated');
  });

  // (n5) a language whose name carries a dot is highlighted like any other.
  //
  // Asciidoctor writes the declared name into `class="language-…"` verbatim — it imposes no character
  // set on it at all — and four of the spellings the generated map carries are dotted:
  // `cmake.in`, `html.hbs`, `html.handlebars` and `pf.conf`. They are highlight.js's own spellings,
  // derived from the installed package, so a document naming one is naming a grammar the preview HAS.
  // The block scanner's pattern nonetheless bounded the name to `[\w+#-]+`, which has no dot in it, so
  // the opening tag did not match and every one of those four came back with no colour — while the
  // export's highlighter coloured them. Pinned per spelling rather than in one block, so a regression
  // says WHICH one broke.
  it.each([
    ['cmake.in', 'set(CMAKE_BUILD_TYPE Release)', 'hljs-keyword'],
    ['html.hbs', '{{#if user}}Hi{{/if}}', 'hljs-template-tag'],
    ['html.handlebars', '{{#if user}}Hi{{/if}}', 'hljs-template-tag'],
    ['pf.conf', 'block in all', 'hljs-built_in'],
  ])('highlights a source block whose language is spelled with a dot (%s)', async (language, code, token) => {
    const codeHtml =
      `<pre class="highlight"><code class="language-${language}" data-lang="${language}">${code}</code></pre>`;
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 66, content: `[source,${language}]\n----\n${code}\n----` });

    const result = postMessageMock.mock.calls[0][0];
    expect(result.ok).toBe(true);
    expect(result.html).toContain('class="highlight hljs"');
    expect(result.html).toContain(token);
    // The name is re-emitted exactly as the converter wrote it — dot included, nothing dropped.
    expect(result.html).toContain(`<code class="language-${language}" data-lang="${language}">`);
  });

  // (n6) the language name is text out of the document, and widening the pattern widens what that text
  // can be. What it must NOT widen is what the text can reach: one lookup in a real `Map`.
  //
  // An object literal keyed by spelling would answer `__proto__`, `constructor` and `toString` with
  // something inherited, and that something would then be asked for a `load()` — a document choosing
  // what the worker fetches. The generated registry is a `Map` precisely so a name a document invented
  // can only miss. This holds that property against the wider pattern, and holds it for a dotted
  // hostile name too, which the narrow pattern never even carried this far.
  it('lets a hostile language name reach nothing but a map lookup', async () => {
    const load = jest.fn<Promise<{ default: LanguageFn }>, []>();
    const grammars = new Map<string, OnDemandGrammar>([
      ['cmake.in', { name: 'cmake', spellings: ['cmake', 'cmake.in'], load }],
    ]);
    const lookup = jest.spyOn(grammars, 'get');
    jest.doMock('@/workers/hljs-languages.generated', () => ({
      __esModule: true,
      ON_DEMAND_GRAMMARS: grammars,
    }));

    const hostile = [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      '__proto__.polluted',
      'cmake.in.__proto__',
    ];
    const codeHtml = hostile
      .map((name) => `<pre class="highlight"><code class="language-${name}" data-lang="${name}">x</code></pre>`)
      .join('');
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 67, content: 'code' });

    const result = postMessageMock.mock.calls[0][0];
    // Every one of them was asked — the pattern does match them, dots and all — and every ask missed.
    // Asked in lower case, because that is how the generated map is keyed; that fold is the only thing
    // done to the name between the pattern and the lookup.
    expect(lookup.mock.calls.map(([name]) => name)).toEqual(hostile.map((name) => name.toLowerCase()));
    expect(lookup.mock.results.map((call) => call.value)).toEqual(hostile.map(() => undefined));
    // Nothing was fetched: a miss is a miss, whatever the name inherited from.
    expect(load).not.toHaveBeenCalled();
    // Each block is then GUESSED at, like any other language nothing answers to, and says so. (This
    // tail used to assert the markup came back byte for byte, which was true only while a language
    // with no grammar was left plain; the guess is deliberately back for the two styles that present
    // the document rather than the page — see the test above. What matters here is unchanged and is
    // asserted above: the name reached one `Map` lookup and nothing else.)
    expect(result.html.match(/data-hljs-guessed/g)).toHaveLength(hostile.length);
    // And the name is re-emitted exactly as the converter wrote it, marker appended after it.
    expect(result.html).toContain('<code class="language-__proto__" data-lang="__proto__" data-hljs-guessed>');

    jest.dontMock('@/workers/hljs-languages.generated');
  });

  // (n7) and what the pattern must still REFUSE, now that it admits a dot.
  //
  // Asciidoctor puts the name into the class attribute unescaped, so `[source,"a\"b"]` really does emit
  // `class="language-a"b"` — the name can carry a quote, an angle bracket, a space, a slash or an
  // ampersand, every one of which is meaningful either in the attribute the worker re-emits or in the
  // `[class~="language-…"]` selectors the Print style neutralises an unlexed language with. A space is
  // the sharpest of them: `class="language-foo bar"` is TWO class tokens, so it answers to
  // `[class~="language-foo"]` — a listing taking another language's rule — while
  // `[class~="language-foo bar"]` matches nothing the spec allows. None of the six is in any of
  // highlight.js's 371 spellings, so admitting them would buy no colour at all and cost the guarantee
  // that what the worker writes back into `class="language-…"` stays inside that attribute and names
  // exactly one thing. At most the sanctioned prefix before such a character reaches the lookup, and it
  // misses.
  it('never carries an unsanctioned character in a language name past the block scanner', async () => {
    const load = jest.fn<Promise<{ default: LanguageFn }>, []>();
    const grammars = new Map<string, OnDemandGrammar>([
      ['cmake.in', { name: 'cmake', spellings: ['cmake', 'cmake.in'], load }],
    ]);
    const lookup = jest.spyOn(grammars, 'get');
    jest.doMock('@/workers/hljs-languages.generated', () => ({
      __esModule: true,
      ON_DEMAND_GRAMMARS: grammars,
    }));

    const codeHtml = ['a"b', 'un.known"x', 'a<b>c', 'foo bar', '../../etc/passwd', 'ruby&sql']
      .map((name) => `<pre class="highlight"><code class="language-${name}" data-lang="${name}">x</code></pre>`)
      .join('');
    mockConvert.mockResolvedValueOnce(codeHtml);
    mockFindBy.mockReturnValueOnce([]);
    require('@/workers/asciidoc-render.worker');
    await sendMessage({ requestId: 68, content: 'code' });

    const result = postMessageMock.mock.calls[0][0];
    // `a"b` and `un.known"x` end at the quote — the sanctioned run before it is all that gets through,
    // and `un.known` is the one the narrow pattern could not even carry this far. The other four match
    // nothing at all: the character that stops them is the first one after `language-`'s sanctioned run,
    // and there is no quote for the pattern to close on.
    expect(lookup.mock.calls.map(([name]) => name)).toEqual(['a', 'un.known']);
    expect(load).not.toHaveBeenCalled();
    // The four that match nothing are returned byte for byte, untouched.
    for (const name of ['a<b>c', 'foo bar', '../../etc/passwd', 'ruby&sql']) {
      expect(result.html).toContain(`<code class="language-${name}" data-lang="${name}">x</code>`);
    }
    // The two that match a prefix miss the lookup and are guessed at, like any other unanswered
    // language. The marker is appended at the END of the tag rather than after the class, which is
    // what keeps it out of the wreckage the ENGINE made of this tag: `class="language-a"b"` is
    // already broken where the author's quote ended the attribute, and everything up to the `>` is
    // re-emitted exactly as it arrived.
    expect(result.html).toContain('<code class="language-a"b" data-lang="a"b" data-hljs-guessed>');
    expect(result.html.match(/data-hljs-guessed/g)).toHaveLength(2);

    jest.dontMock('@/workers/hljs-languages.generated');
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
        // The worker reads the bundled set at module load, to fix what a guess may be detected from.
        // A double that omits it throws on import rather than in the assertion, and the throw leaves
        // this mock installed for every test after it.
        listLanguages: jest.fn().mockReturnValue(['javascript']),
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
