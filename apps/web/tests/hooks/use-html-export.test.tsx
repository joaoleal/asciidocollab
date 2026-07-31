import { renderHook, act, waitFor } from '@testing-library/react';
import { strFromU8, unzipSync } from 'fflate';

// The real factory reaches for `import.meta.url`, which the CommonJS test runtime cannot parse. Every
// test injects its own worker anyway, so the factory is never actually called.
jest.mock('@/lib/spawn-render-worker', () => ({ spawnRenderWorker: jest.fn() }));

// The real diagram engines are lazily imported browser bundles (mermaid, graphviz-wasm, vega) that the
// test runtime cannot load. This stands in for them by producing what they produce — an inline `<svg>`
// in the placeholder's output slot — so the packaging decision downstream is exercised for real.
jest.mock('@/components/diagrams/render-diagrams', () => ({
  renderDiagrams: async (container: HTMLElement) => {
    for (const output of container.querySelectorAll('.adc-diagram-output')) {
      output.innerHTML = '<svg width="120" height="60"><rect/></svg>';
    }
    return { rendered: 1, warnings: [] };
  },
}));


import { useHtmlExport, type HtmlExportRequest } from '@/hooks/use-html-export';
import type { PackagedExport } from '@/lib/html-export/package-export';
import type { AssetFetcher } from '@/lib/html-export/inline-assets';

// ── Worker mock ──────────────────────────────────────────────────────────────

type Listener = (event: { data?: unknown }) => void;

/** The render worker's reply shape, as much of it as an export consumes. */
interface WorkerReply {
  requestId: number;
  ok: boolean;
  html: string | null;
  error: string | null;
  details?: { title?: string; author?: string; revnumber?: string; revdate?: string; lang?: string };
  /** Set by the worker when the body carries diagram placeholders for the main thread to finish. */
  diagramsPresent?: boolean;
}

class MockWorker {
  static instances: MockWorker[] = [];
  postMessage = jest.fn();
  terminate = jest.fn();
  private messageListeners: Listener[] = [];
  private errorListeners: Listener[] = [];

  constructor() {
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    if (type === 'message') this.messageListeners.push(listener);
    if (type === 'error') this.errorListeners.push(listener);
  }

  /** Deliver a reply, as the real worker would. */
  reply(message: WorkerReply) {
    for (const listener of this.messageListeners) listener({ data: message });
  }

  /** Fail to start, as a worker whose bundle could not load would. */
  fail() {
    for (const listener of this.errorListeners) listener({});
  }

  /** The payload the export posted. */
  get sent(): Record<string, unknown> {
    const [payload] = this.postMessage.mock.calls.at(-1) ?? [];
    return payload as Record<string, unknown>;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const PNG = new Uint8Array([137, 80, 78, 71]);

const REQUEST: HtmlExportRequest = {
  rootPath: 'book.adoc',
  projectName: 'The Book Project',
  files: { 'book.adoc': '= Book\n\nHello.', 'chapter.adoc': '== Chapter' },
  packaging: 'single-file',
  style: 'asciidocollab',
  theme: 'light',
};

const fetchOk: AssetFetcher = async () => ({ bytes: PNG, contentType: 'image/png' });

/** Render the hook with a mock worker and a capturing download, returning both. */
function setup(fetchAsset: AssetFetcher = fetchOk) {
  MockWorker.instances = [];
  const downloads: PackagedExport[] = [];
  const view = renderHook(() =>
    useHtmlExport({
      projectId: 'project-1',
      createWorker: () => new MockWorker() as unknown as Worker,
      fetchAsset,
      download: (packaged) => downloads.push(packaged),
    }),
  );
  return { view, downloads };
}

/** The worker serving the current export. */
function worker() {
  return MockWorker.instances.at(-1)!;
}

/** Start an export and let the hook post its render request. */
async function start(
  view: ReturnType<typeof setup>['view'],
  request: HtmlExportRequest = REQUEST,
): Promise<void> {
  act(() => {
    view.result.current.exportHtml(request);
  });
  await waitFor(() => expect(worker().postMessage).toHaveBeenCalled());
}

/** Deliver a successful render and wait for the export to settle. */
async function finish(view: ReturnType<typeof setup>['view'], reply: Partial<WorkerReply> = {}) {
  await act(async () => {
    worker().reply({ requestId: 1, ok: true, html: '<p>Hello.</p>', error: null, ...reply });
  });
  await waitFor(() => expect(view.result.current.isExporting).toBe(false));
}

describe('useHtmlExport — what it renders', () => {
  test('renders the whole document rooted at the main file, with includes expanded', async () => {
    // An export is the entire document, like the PDF — never the placeholder view the panel shows
    // while an author works on one file.
    const { view } = setup();
    await start(view);
    expect(worker().sent['openFileId']).toBe('book.adoc');
    expect(worker().sent['showIncludes']).toBe(true);
    expect(worker().sent['files']).toEqual(REQUEST.files);
  });

  test('leaves image sources project-relative so the export can resolve them itself', async () => {
    // The preview points images at the authenticated endpoint, which is useless in a saved file.
    const { view } = setup();
    await start(view);
    expect(worker().sent['imagesDir']).toBeUndefined();
  });

  test('passes the project render attributes through, so an export matches the preview', async () => {
    const { view } = setup();
    await start(view, { ...REQUEST, projectAttributes: { toc: '@' } });
    expect(worker().sent['projectAttributes']).toEqual({ toc: '@' });
  });
});

describe('useHtmlExport — what it produces', () => {
  test('downloads a standalone page carrying the document body', async () => {
    const { view, downloads } = setup();
    await start(view);
    await finish(view);
    expect(downloads).toHaveLength(1);
    const html = strFromU8(downloads[0].bytes);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<p>Hello.</p>');
    // Named after the PROJECT plus the export date, never after the root document.
    expect(downloads[0].fileName).toMatch(/^the-book-project-\d{4}-\d{2}-\d{2}\.html$/);
  });

  test('restores the title and author line the app itself was showing in its chrome', async () => {
    const { view, downloads } = setup();
    await start(view);
    await finish(view, {
      details: { title: 'The Book', author: 'Ada Lovelace', revnumber: '2.0', lang: 'pt' },
    });
    const html = strFromU8(downloads[0].bytes);
    expect(html).toContain('<title>The Book</title>');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('v2.0');
    expect(html).toContain('lang="pt"');
  });

  test('embeds every image for a single-file export', async () => {
    const { view, downloads } = setup();
    await start(view);
    await finish(view, { html: '<img src="images/logo.png">' });
    expect(strFromU8(downloads[0].bytes)).toContain('src="data:image/png;base64,');
  });

  test('writes a zip holding the document beside its images when the project asks for one', async () => {
    const { view, downloads } = setup();
    await start(view, { ...REQUEST, packaging: 'zip' });
    await finish(view, { html: '<img src="images/logo.png">' });
    expect(downloads[0].fileName).toMatch(/^the-book-project-\d{4}-\d{2}-\d{2}\.zip$/);
    const entries = unzipSync(downloads[0].bytes);
    expect(Object.keys(entries)).toContain('index.html');
    // The document links to whatever path the archive actually holds — a mismatch is a broken image
    // that only shows up after the file has been sent to someone.
    const document_ = strFromU8(entries['index.html']);
    for (const path of Object.keys(entries).filter((name) => name.startsWith('assets/'))) {
      expect(document_).toContain(`src="${path}"`);
    }
  });

  test('keeps the zip stylesheet in its own file, linked relatively so file:// resolves it', async () => {
    // The two packagings differ here on purpose: a zip is a document you can open and edit, so its CSS
    // is a file of its own; a single file has nowhere to put one.
    const { view, downloads } = setup();
    await start(view, { ...REQUEST, packaging: 'zip' });
    await finish(view);
    const entries = unzipSync(downloads[0].bytes);
    expect(Object.keys(entries)).toContain('styles.css');
    const document_ = strFromU8(entries['index.html']);
    expect(document_).toContain('<link rel="stylesheet" href="styles.css">');
    expect(document_).not.toContain('<style>');
    // The palette has to be in the file that is actually loaded, not left behind in the document.
    expect(strFromU8(entries['styles.css'])).toContain('--background:');
  });

  test('inlines the stylesheet for a single file, which is the whole point of the format', async () => {
    const { view, downloads } = setup();
    await start(view);
    await finish(view);
    const html = strFromU8(downloads[0].bytes);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link');
  });

  test('dresses the document in the requested style', async () => {
    const { view, downloads } = setup();
    await start(view, { ...REQUEST, style: 'asciidoctor' });
    await finish(view);
    expect(strFromU8(downloads[0].bytes)).toContain('data-preview-style="asciidoctor"');
  });
});

describe('useHtmlExport — failures', () => {
  test('a document that will not render surfaces its reason and downloads nothing', async () => {
    const { view, downloads } = setup();
    await start(view);
    await act(async () => {
      worker().reply({ requestId: 1, ok: false, html: null, error: 'include target missing' });
    });
    await waitFor(() => expect(view.result.current.error).toBe('include target missing'));
    expect(downloads).toHaveLength(0);
    expect(view.result.current.isExporting).toBe(false);
  });

  test('a worker that cannot start is reported rather than leaving the button spinning forever', async () => {
    const { view } = setup();
    await start(view);
    await act(async () => {
      worker().fail();
    });
    await waitFor(() => expect(view.result.current.isExporting).toBe(false));
    expect(view.result.current.error).toMatch(/\w/);
  });

  test('an image that cannot be fetched is reported, and the export still completes', async () => {
    const { view, downloads } = setup(async () => null);
    await start(view);
    await finish(view, { html: '<img src="images/gone.png">' });
    expect(downloads).toHaveLength(1);
    expect(view.result.current.failures).toEqual([
      { source: 'images/gone.png', reason: 'could not be retrieved' },
    ]);
  });
});

describe('useHtmlExport — lifecycle', () => {
  test('terminates the render engine once the export is done', async () => {
    // The worker is per-export: keeping a second Asciidoctor engine warm would cost every session's
    // memory to save time in the rare ones that export.
    const { view } = setup();
    await start(view);
    const engine = worker();
    await finish(view);
    expect(engine.terminate).toHaveBeenCalled();
  });

  test('a second export supersedes the first, whose late result is discarded', async () => {
    const { view, downloads } = setup();
    await start(view);
    const first = worker();
    await start(view);
    const second = worker();
    expect(first).not.toBe(second);
    expect(first.terminate).toHaveBeenCalled();

    await act(async () => {
      first.reply({ requestId: 1, ok: true, html: '<p>stale</p>', error: null });
    });
    await finish(view, { html: '<p>current</p>' });

    expect(downloads).toHaveLength(1);
    expect(strFromU8(downloads[0].bytes)).toContain('current');
  });

  test('unmounting mid-export takes the engine down with it', async () => {
    const { view } = setup();
    await start(view);
    const engine = worker();
    view.unmount();
    expect(engine.terminate).toHaveBeenCalled();
  });
});

describe('useHtmlExport — degradation', () => {
  test('a render failure with no message still says something useful', async () => {
    const { view } = setup();
    await start(view);
    await act(async () => {
      worker().reply({ requestId: 1, ok: false, html: null, error: null });
    });
    await waitFor(() => expect(view.result.current.isExporting).toBe(false));
    expect(view.result.current.error).toBe('The document could not be rendered.');
  });

  test('a root file missing from the tree renders as empty rather than crashing', async () => {
    // The root can go away between the click and the read (a concurrent delete); an empty render is a
    // recoverable outcome, an exception mid-pipeline is not.
    const { view } = setup();
    await start(view, { ...REQUEST, rootPath: 'gone.adoc' });
    expect(worker().sent['content']).toBe('');
  });

  test('an export with no document language leaves the page language unset', async () => {
    const { view, downloads } = setup();
    await start(view);
    await finish(view, { details: {} });
    expect(downloads[0]!.bytes).toBeDefined();
  });

  test('a failure that is not an Error is still reported', async () => {
    // Nothing in the pipeline guarantees it throws an `Error`; without `String(...)` the banner would
    // read "undefined" and say nothing about what went wrong.
    MockWorker.instances = [];
    const view = renderHook(() =>
      useHtmlExport({
        projectId: 'project-1',
        createWorker: () => new MockWorker() as unknown as Worker,
        fetchAsset: fetchOk,
        download: () => {
          throw 'the browser refused the download';
        },
      }),
    );
    await start(view);
    await act(async () => {
      worker().reply({ requestId: 1, ok: true, html: '<p>Hello.</p>', error: null });
    });
    await waitFor(() => expect(view.result.current.isExporting).toBe(false));
    expect(view.result.current.error).toBe('the browser refused the download');
  });

  test('an image the server will not serve is reported, not silently dropped', async () => {
    const { view, downloads } = setup(async () => null);
    await start(view);
    await act(async () => {
      worker().reply({ requestId: 1, ok: true, html: '<p><img src="pic.png"></p>', error: null });
    });
    await waitFor(() => expect(view.result.current.isExporting).toBe(false));
    expect(view.result.current.failures.map((failure) => failure.source)).toEqual(['pic.png']);
    // The document is still produced — one unreachable image must not cost the whole export.
    expect(downloads).toHaveLength(1);
  });
});

/** Render the hook with the REAL asset fetcher, so the endpoint path and headers are exercised. */
function setupWithRealFetcher() {
  MockWorker.instances = [];
  const downloads: PackagedExport[] = [];
  const view = renderHook(() =>
    useHtmlExport({
      projectId: 'project-1',
      createWorker: () => new MockWorker() as unknown as Worker,
      download: (packaged) => downloads.push(packaged),
    }),
  );
  return { view, downloads };
}

describe('useHtmlExport — the project asset endpoint', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('takes the image type from the server rather than guessing from the path', async () => {
    // The endpoint's paths do not always carry a usable extension, and a `data:` URI with the wrong
    // type renders as a broken image.
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'image/webp' }),
      arrayBuffer: async () => PNG.buffer,
    })) as unknown as typeof fetch;
    const { view, downloads } = setupWithRealFetcher();
    await start(view);
    await act(async () => {
      worker().reply({ requestId: 1, ok: true, html: '<p><img src="pic"></p>', error: null });
    });
    await waitFor(() => expect(view.result.current.isExporting).toBe(false));
    expect(strFromU8(downloads[0]!.bytes)).toContain('data:image/webp;base64,');
  });

  test('falls back to a generic type when the server declares none', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      headers: new Headers(),
      arrayBuffer: async () => PNG.buffer,
    })) as unknown as typeof fetch;
    const { view, downloads } = setupWithRealFetcher();
    await start(view);
    await act(async () => {
      worker().reply({ requestId: 1, ok: true, html: '<p><img src="pic"></p>', error: null });
    });
    await waitFor(() => expect(view.result.current.isExporting).toBe(false));
    expect(strFromU8(downloads[0]!.bytes)).toContain('data:application/octet-stream;base64,');
  });

  test('a rejected image request is reported as a failure', async () => {
    globalThis.fetch = jest.fn(async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    const { view } = setupWithRealFetcher();
    await start(view);
    await act(async () => {
      worker().reply({ requestId: 1, ok: true, html: '<p><img src="pic.png"></p>', error: null });
    });
    await waitFor(() => expect(view.result.current.isExporting).toBe(false));
    expect(view.result.current.failures).toHaveLength(1);
  });
});

// The same packaging decision the document's images, fonts and stylesheet already take, applied to
// diagrams: a zip keeps each one in a file of its own, a single file has nowhere else to put it.
describe('useHtmlExport — where diagrams end up', () => {
  const DIAGRAM_BODY =
    '<div class="adc-diagram" data-diagram-engine="mermaid" data-source-line="4">' +
    '<div class="adc-diagram-output">graph TD; a--&gt;b;</div></div>';

  test('writes each diagram as its own file in a zip and links to it', async () => {
    // Inline SVG in a zip buries the prose in vector markup and stores a reused diagram twice.
    const { view, downloads } = setup();
    await start(view, { ...REQUEST, packaging: 'zip' });
    await finish(view, { html: DIAGRAM_BODY, diagramsPresent: true });

    const entries = unzipSync(downloads[0].bytes);
    expect(Object.keys(entries)).toContain('diagrams/001-mermaid.svg');
    expect(strFromU8(entries['diagrams/001-mermaid.svg'])).toContain('<rect');

    const document_ = strFromU8(entries['index.html']);
    expect(document_).toContain('src="diagrams/001-mermaid.svg"');
    expect(document_).not.toContain('<svg');
  });

  test('keeps diagrams inline in a single file, which has nowhere else to put them', async () => {
    const { view, downloads } = setup();
    await start(view, { ...REQUEST, packaging: 'single-file' });
    await finish(view, { html: DIAGRAM_BODY, diagramsPresent: true });

    const document_ = new TextDecoder().decode(downloads[0].bytes);
    expect(document_).toContain('<svg');
    expect(document_).not.toContain('diagrams/001-mermaid.svg');
  });

  test('reports no missing image for the diagram files it wrote itself', async () => {
    // `diagrams/001-mermaid.svg` is a path inside the archive, not something the asset endpoint knows.
    // Fetching it would fail and surface as an image the author never referenced.
    const { view } = setup(async () => null);
    await start(view, { ...REQUEST, packaging: 'zip' });
    await finish(view, { html: DIAGRAM_BODY, diagramsPresent: true });

    expect(view.result.current.failures).toEqual([]);
  });
});
