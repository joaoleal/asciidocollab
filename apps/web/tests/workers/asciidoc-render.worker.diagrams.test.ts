/* @jest-environment jsdom */

/**
 * Diagram-placeholder emission from asciidoc-render.worker.ts.
 *
 * The worker module is imported directly (not via `new Worker(url)`) so Jest can execute it: the
 * global `onmessage` setter and `postMessage` are shimmed to capture and drive the message handler.
 * Asciidoctor is mocked so the tests focus on placeholder emission + the `diagramsPresent` flag
 * without the real library. The engine's `load` and `convert` are asynchronous, so the doubles resolve
 * promises and each render is awaited.
 *
 * jsdom is selected via the pragma above so the real shared preview sanitizer (DOMPurify) can run
 * against the emitted placeholder and prove it survives the `html` profile unchanged.
 */

import DOMPurify from 'dompurify';

let onMessageHandler: ((event: MessageEvent) => Promise<void>) | null = null;
const postMessageMock = jest.fn();

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
const mockGetAttribute = jest.fn();
const mockLoad = jest.fn();

// The engine exposes `load` as a module function, not a processor factory, and it resolves a promise.
jest.mock('asciidoctor', () => ({ __esModule: true, load: mockLoad }));

interface MockBlockOptions {
  lineNumber: number | null;
  id?: string | null;
  context?: string;
  level?: number | null;
  style?: string | null;
  source?: string;
}

/**
 * A parsed-block test double exposing the API the worker reads (line/id/context/style/source).
 *
 * `getLineNumber` is the block's own accessor, which is what the worker asks: the engine answers it for
 * every node it hands back, including the table cells whose source-location cursor it stores stripped
 * of its methods.
 */
function makeBlock(options: MockBlockOptions) {
  const { lineNumber, id = null, context = 'paragraph', level = null, style = null, source = '' } = options;
  const mockId = jest.fn().mockReturnValue(id);
  const localSetId = jest.fn((newId: string) => {
    mockId.mockReturnValue(newId);
  });
  const block: Record<string, unknown> = {
    getLineNumber: jest.fn().mockReturnValue(lineNumber ?? undefined),
    getId: mockId,
    setId: localSetId,
    getContext: jest.fn().mockReturnValue(context),
    getStyle: jest.fn().mockReturnValue(style),
    getSource: jest.fn().mockReturnValue(source),
  };
  if (level !== null) {
    block['getLevel'] = jest.fn().mockReturnValue(level);
  }
  return block as Record<string, unknown>;
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Serialize the CURRENT block set the way Asciidoctor would, reading each block's live id (so a
 * synthetic id the worker assigned via `setId` before `convert()` is reflected here) — the worker
 * locates a diagram block by that id to swap in its placeholder.
 */
function renderBlocks(blocks: Array<Record<string, unknown>>): string {
  return blocks
    .map((block) => {
      const getId = block['getId'] as () => string | null;
      const getContext = block['getContext'] as () => string;
      const getSource = block['getSource'] as () => string;
      const id = getId() ?? '';
      const idAttribute = id ? ` id="${id}"` : '';
      if (getContext() === 'listing') {
        return `<div${idAttribute} class="listingblock"><div class="content"><pre>${escapeText(getSource())}</pre></div></div>`;
      }
      return `<div${idAttribute} class="paragraph"><p>text</p></div>`;
    })
    .join('');
}

/**
 * Drive one render, and settle before returning. The handler is asynchronous, so the reply exists only
 * once the promise it returns has settled; asserting without awaiting would read no reply at all.
 */
async function sendMessage(data: { requestId: number; content: string; imagesDir?: string }): Promise<void> {
  if (onMessageHandler) {
    await onMessageHandler({ data } as MessageEvent);
  } else {
    throw new Error('onmessage handler not registered');
  }
}

function lastResult() {
  return postMessageMock.mock.calls[0][0] as { html: string | null; diagramsPresent?: boolean; ok: boolean };
}

describe('asciidoc-render.worker diagram placeholders', () => {
  beforeEach(() => {
    jest.resetModules();
    postMessageMock.mockClear();
    mockConvert.mockClear();
    mockFindBy.mockClear();
    mockGetAttribute.mockClear();
    mockLoad.mockClear();
    onMessageHandler = null;
    mockGetAttribute.mockReturnValue(undefined);
    mockLoad.mockResolvedValue({ findBy: mockFindBy, convert: mockConvert, getAttribute: mockGetAttribute });
  });

  it('emits one adc-diagram placeholder per diagram block with engine, source line, and escaped source', async () => {
    const blocks = [
      makeBlock({ lineNumber: 3, context: 'listing', style: 'mermaid', source: 'graph TD; A-->B' }),
      makeBlock({ lineNumber: 8, context: 'listing', style: 'graphviz', source: 'digraph { a -> b }' }),
      makeBlock({ lineNumber: 13, context: 'listing', style: 'vega', source: '{ "mark": "bar" }' }),
    ];
    mockFindBy.mockReturnValue(blocks);
    mockConvert.mockImplementation(() => Promise.resolve(renderBlocks(blocks)));
    require('@/workers/asciidoc-render.worker');

    await sendMessage({ requestId: 1, content: '= Doc' });
    const { html } = lastResult();

    expect(html!.match(/class="adc-diagram"/g)).toHaveLength(3);
    expect(html).toContain('<div class="adc-diagram" data-diagram-engine="mermaid" data-source-line="3">graph TD; A--&gt;B</div>');
    expect(html).toContain('<div class="adc-diagram" data-diagram-engine="graphviz" data-source-line="8">digraph { a -&gt; b }</div>');
    expect(html).toContain('<div class="adc-diagram" data-diagram-engine="vega" data-source-line="13">{ "mark": "bar" }</div>');
    // The raw listing rendering of the diagram source is gone — only the placeholder remains.
    expect(html).not.toContain('listingblock');
  });

  it('sets diagramsPresent=true when at least one placeholder is emitted', async () => {
    const blocks = [makeBlock({ lineNumber: 3, context: 'listing', style: 'mermaid', source: 'graph TD; A-->B' })];
    mockFindBy.mockReturnValue(blocks);
    mockConvert.mockImplementation(() => Promise.resolve(renderBlocks(blocks)));
    require('@/workers/asciidoc-render.worker');

    await sendMessage({ requestId: 2, content: '= Doc' });
    expect(lastResult().diagramsPresent).toBe(true);
  });

  it('emits no placeholder and diagramsPresent=false for a diagram-free document', async () => {
    const blocks = [makeBlock({ lineNumber: 3, context: 'paragraph' })];
    mockFindBy.mockReturnValue(blocks);
    mockConvert.mockImplementation(() => Promise.resolve(renderBlocks(blocks)));
    require('@/workers/asciidoc-render.worker');

    await sendMessage({ requestId: 3, content: '= Doc\n\nplain prose' });
    const { html, diagramsPresent } = lastResult();
    expect(html).not.toContain('adc-diagram');
    expect(diagramsPresent).toBe(false);
  });

  it('keeps diagram source as inert escaped text (a script tag never becomes markup)', async () => {
    const blocks = [
      makeBlock({ lineNumber: 5, context: 'listing', style: 'mermaid', source: '<script>alert(1)</script>' }),
    ];
    mockFindBy.mockReturnValue(blocks);
    mockConvert.mockImplementation(() => Promise.resolve(renderBlocks(blocks)));
    require('@/workers/asciidoc-render.worker');

    await sendMessage({ requestId: 4, content: '= Doc' });
    const { html } = lastResult();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('normalizes the vega-lite notation to the vegalite engine and excludes offline-unsupported engines', async () => {
    const blocks = [
      makeBlock({ lineNumber: 3, context: 'listing', style: 'vega-lite', source: '{ "mark": "point" }' }),
      makeBlock({ lineNumber: 9, context: 'listing', style: 'plantuml', source: '@startuml\nA -> B\n@enduml' }),
    ];
    mockFindBy.mockReturnValue(blocks);
    mockConvert.mockImplementation(() => Promise.resolve(renderBlocks(blocks)));
    require('@/workers/asciidoc-render.worker');

    await sendMessage({ requestId: 5, content: '= Doc' });
    const { html } = lastResult();
    expect(html).toContain('data-diagram-engine="vegalite"');
    // PlantUML has no offline renderer — it is left as its normal listing block, not a native placeholder.
    expect(html!.match(/class="adc-diagram"/g)).toHaveLength(1);
    expect(html).toContain('@startuml');
    expect(html).toContain('listingblock');
  });

  it('produces a placeholder the shared html-profile sanitizer keeps intact', async () => {
    const blocks = [makeBlock({ lineNumber: 7, context: 'listing', style: 'mermaid', source: 'graph TD; A-->B' })];
    mockFindBy.mockReturnValue(blocks);
    mockConvert.mockImplementation(() => Promise.resolve(renderBlocks(blocks)));
    require('@/workers/asciidoc-render.worker');

    await sendMessage({ requestId: 6, content: '= Doc' });
    const { html } = lastResult();
    const sanitized = DOMPurify.sanitize(html!, { USE_PROFILES: { html: true } });
    expect(sanitized).toContain('class="adc-diagram"');
    expect(sanitized).toContain('data-diagram-engine="mermaid"');
    expect(sanitized).toContain('data-source-line="7"');
    expect(sanitized).toContain('graph TD; A--&gt;B');
  });
});
