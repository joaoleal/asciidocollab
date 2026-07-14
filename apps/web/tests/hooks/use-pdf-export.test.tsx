import { renderHook, act } from '@testing-library/react';
import type {
  FromWorker,
  GeneratedAsset,
  ProjectSnapshot,
  RenderError,
  RenderResult,
} from '@asciidocollab/asciidoc-pdf';
import { usePdfExport, type UsePdfExportDeps } from '@/hooks/use-pdf-export';
import type {
  MermaidPrerenderer,
  MermaidPrerenderResult,
} from '@/lib/pdf/prerender-mermaid';

// ── Worker mock ──────────────────────────────────────────────────────────────

type WorkerMessageListener = (event: MessageEvent) => void;

class MockWorker {
  static instances: MockWorker[] = [];
  private messageListeners: WorkerMessageListener[] = [];
  postMessage = jest.fn();
  terminate = jest.fn();

  constructor() {
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: WorkerMessageListener) {
    if (type === 'message') this.messageListeners.push(listener);
  }

  /** Push a worker→main message through every registered listener. */
  emit(message: FromWorker) {
    for (const listener of this.messageListeners) {
      listener({ data: message } as MessageEvent);
    }
  }
}

// Mock the worker factory so tests never touch import.meta.url or the real worker file.
jest.mock('@/lib/create-pdf-worker', () => ({
  createPdfWorker: jest.fn(() => new MockWorker()),
}));

import { createPdfWorker } from '@/lib/create-pdf-worker';
const mockCreatePdfWorker = createPdfWorker as jest.Mock;

// ── Helpers ──────────────────────────────────────────────────────────────────

function lastWorker() {
  return MockWorker.instances.at(-1)!;
}

const SNAPSHOT: ProjectSnapshot = {
  files: { 'book.adoc': '= Book' },
  binaryAssets: {},
  rootPath: 'book.adoc',
  openPath: 'book.adoc',
  fontPaths: [],
  attributes: {},
};

// ── Mermaid pre-pass injection ─────────────────────────────────────────────────

const MERMAID_ASSET: GeneratedAsset = {
  sourceHash: 'mermaid-hash-1',
  kind: 'diagram',
  format: 'svg',
  bytes: new Uint8Array([1, 2, 3]),
  rasterFallback: false,
  altText: '',
};

/** A deterministic pre-pass that resolves to a fixed result — no real (DOM-bound) mermaid render. */
function fakePrerenderer(
  result: MermaidPrerenderResult,
): { prerenderer: MermaidPrerenderer; prerender: jest.Mock } {
  const prerender = jest.fn(async () => result);
  return { prerenderer: { prerender }, prerender };
}

/** Kick off an export and flush the awaited pre-pass so the render request is posted. */
async function exportAndSettle(
  exportPdf: (snapshot: ProjectSnapshot) => void,
  snapshot: ProjectSnapshot,
): Promise<void> {
  await act(async () => {
    exportPdf(snapshot);
  });
}

/** Render the hook with an optional injected pre-pass factory. */
function renderExport(deps?: UsePdfExportDeps) {
  return renderHook(() => usePdfExport(deps));
}

/** The render request the hook posted (skipping the leading warmup message). */
function lastRenderRequest() {
  const calls = lastWorker().postMessage.mock.calls;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const message = calls[index][0];
    if (message.type === 'render') return message.request;
  }
  throw new Error('no render request was posted');
}

function makeResult(requestId: string, overrides: Partial<RenderResult> = {}): RenderResult {
  return {
    requestId,
    mode: 'export',
    pdf: new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
    diagnostics: [],
    stats: { renderMs: 12, cacheHits: 0, rasterFallbacks: 0 },
    ...overrides,
  };
}

let createObjectUrl: jest.Mock;
let revokeObjectUrl: jest.Mock;
let anchorClick: jest.SpyInstance;
let capturedDownloadNames: string[];

beforeEach(() => {
  MockWorker.instances = [];
  mockCreatePdfWorker.mockClear();
  mockCreatePdfWorker.mockImplementation(() => new MockWorker());

  createObjectUrl = jest.fn(() => 'blob:mock-url');
  revokeObjectUrl = jest.fn();
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectUrl, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectUrl, configurable: true });

  // Capture the download filename off each anchor at click time, so tests can assert the name the
  // hook derived from the snapshot's root path without touching the download element directly.
  capturedDownloadNames = [];
  anchorClick = jest
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function mockClick(this: HTMLAnchorElement) {
      capturedDownloadNames.push(this.download);
    });
});

afterEach(() => {
  anchorClick.mockRestore();
});

/** The download name applied to the most recently clicked download anchor. */
function lastDownloadName(): string {
  const name = capturedDownloadNames.at(-1);
  if (name === undefined) throw new Error('no download anchor was clicked');
  return name;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('usePdfExport', () => {
  it('creates the worker once via the createPdfWorker factory', () => {
    renderHook(() => usePdfExport());
    expect(mockCreatePdfWorker).toHaveBeenCalledTimes(1);
  });

  it('warms the VM on mount by posting a warmup message', () => {
    renderHook(() => usePdfExport());
    expect(lastWorker().postMessage).toHaveBeenCalledWith({ type: 'warmup' });
  });

  it('posts an export render request with optimize enabled on exportPdf', async () => {
    const { result } = renderExport();

    await exportAndSettle(result.current.exportPdf, SNAPSHOT);

    const request = lastRenderRequest();
    expect(request.mode).toBe('export');
    expect(request.optimize).toBe(true);
    expect(request.snapshot).toBe(SNAPSHOT);
    expect(typeof request.requestId).toBe('string');
    expect(result.current.isExporting).toBe(true);
  });

  it('triggers a browser download and clears isExporting on a matching result', async () => {
    const { result } = renderExport();

    await exportAndSettle(result.current.exportPdf, SNAPSHOT);
    const requestId = lastRenderRequest().requestId;

    act(() => lastWorker().emit({ type: 'result', result: makeResult(requestId) }));

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:mock-url');
    expect(result.current.isExporting).toBe(false);
  });

  it('derives the download name from a root path that carries an extension', async () => {
    const { result } = renderExport();
    await exportAndSettle(result.current.exportPdf, { ...SNAPSHOT, rootPath: 'chapters/intro.adoc' });
    const requestId = lastRenderRequest().requestId;

    act(() => lastWorker().emit({ type: 'result', result: makeResult(requestId) }));

    expect(lastDownloadName()).toBe('intro.pdf');
  });

  it('appends a .pdf extension when the root path has no extension of its own', async () => {
    const { result } = renderExport();
    await exportAndSettle(result.current.exportPdf, { ...SNAPSHOT, rootPath: 'book' });
    const requestId = lastRenderRequest().requestId;

    act(() => lastWorker().emit({ type: 'result', result: makeResult(requestId) }));

    expect(lastDownloadName()).toBe('book.pdf');
  });

  it('falls back to a default name when the root path has no usable basename', async () => {
    const { result } = renderExport();
    await exportAndSettle(result.current.exportPdf, { ...SNAPSHOT, rootPath: 'chapters/' });
    const requestId = lastRenderRequest().requestId;

    act(() => lastWorker().emit({ type: 'result', result: makeResult(requestId) }));

    expect(lastDownloadName()).toBe('document.pdf');
  });

  it('exposes the result diagnostics for the UI to surface', async () => {
    const { result } = renderExport();
    await exportAndSettle(result.current.exportPdf, SNAPSHOT);
    const requestId = lastRenderRequest().requestId;

    const diagnostics = [
      {
        severity: 'warning' as const,
        code: 'remote-skipped' as const,
        resource: 'https://example.com/logo.png',
        message: 'Remote image skipped.',
      },
    ];
    act(() => lastWorker().emit({ type: 'result', result: makeResult(requestId, { diagnostics }) }));

    expect(result.current.diagnostics).toEqual(diagnostics);
  });

  it('ignores a stale result whose requestId is not the latest', async () => {
    const { result } = renderExport();

    await exportAndSettle(result.current.exportPdf, SNAPSHOT);
    // A second export supersedes the first; the first result is now stale.
    await exportAndSettle(result.current.exportPdf, SNAPSHOT);
    const staleId = String(Number(lastRenderRequest().requestId) - 1);

    act(() => lastWorker().emit({ type: 'result', result: makeResult(staleId) }));

    // No download fired and the export is still considered in flight.
    expect(anchorClick).not.toHaveBeenCalled();
    expect(result.current.isExporting).toBe(true);
  });

  it('reflects progress phase updates for the current request', async () => {
    const { result } = renderExport();
    await exportAndSettle(result.current.exportPdf, SNAPSHOT);
    const requestId = lastRenderRequest().requestId;

    act(() => lastWorker().emit({ type: 'progress', requestId, phase: 'converting' }));
    expect(result.current.phase).toBe('converting');
  });

  it('ignores a stale progress update from a superseded request', async () => {
    const { result } = renderExport();
    await exportAndSettle(result.current.exportPdf, SNAPSHOT);
    await exportAndSettle(result.current.exportPdf, SNAPSHOT);
    const staleId = String(Number(lastRenderRequest().requestId) - 1);

    act(() => lastWorker().emit({ type: 'progress', requestId: staleId, phase: 'optimizing' }));
    expect(result.current.phase).not.toBe('optimizing');
  });

  it('surfaces a fatal error and clears isExporting', async () => {
    const { result } = renderExport();
    await exportAndSettle(result.current.exportPdf, SNAPSHOT);
    const requestId = lastRenderRequest().requestId;

    const error: RenderError = {
      requestId,
      phase: 'convert',
      code: 'convert-failed',
      message: 'The document could not be converted.',
    };
    act(() => lastWorker().emit({ type: 'error', error }));

    expect(result.current.error).toEqual(error);
    expect(result.current.isExporting).toBe(false);
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it('reuses the single warm worker across multiple exports', async () => {
    const { result } = renderExport();
    await exportAndSettle(result.current.exportPdf, SNAPSHOT);
    await exportAndSettle(result.current.exportPdf, SNAPSHOT);

    expect(mockCreatePdfWorker).toHaveBeenCalledTimes(1);
    expect(MockWorker.instances).toHaveLength(1);
  });

  it('terminates the worker on unmount', () => {
    const { unmount } = renderHook(() => usePdfExport());
    const worker = lastWorker();
    expect(worker.terminate).not.toHaveBeenCalled();
    unmount();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  // ── Mermaid pre-pass wiring ──────────────────────────────────────────────────

  it('renders the document mermaid diagrams before posting the request and attaches them as assets', async () => {
    const { prerenderer, prerender } = fakePrerenderer({
      assets: [MERMAID_ASSET],
      diagnostics: [],
      aborted: false,
    });
    const { result } = renderExport({ createPrerenderer: () => prerenderer });

    await exportAndSettle(result.current.exportPdf, SNAPSHOT);

    // The pre-pass ran over the current (open) document's text, up front.
    expect(prerender).toHaveBeenCalledTimes(1);
    expect(prerender.mock.calls[0][0]).toBe(SNAPSHOT.files[SNAPSHOT.openPath]);
    expect(lastRenderRequest().generatedAssets).toEqual([MERMAID_ASSET]);
  });

  it('surfaces the diagram phase for the pre-pass before the worker reports progress', async () => {
    const { prerenderer } = fakePrerenderer({
      assets: [MERMAID_ASSET],
      diagnostics: [],
      aborted: false,
    });
    const { result } = renderExport({ createPrerenderer: () => prerenderer });

    await exportAndSettle(result.current.exportPdf, SNAPSHOT);

    expect(result.current.isExporting).toBe(true);
    expect(result.current.phase).toBe('diagrams-math');
  });

  it('carries pre-pass diagnostics into the export diagnostics, ahead of the worker diagnostics', async () => {
    const { prerenderer } = fakePrerenderer({
      assets: [],
      diagnostics: [{ line: 7, message: 'Parse error on line 1.' }],
      aborted: false,
    });
    const { result } = renderExport({ createPrerenderer: () => prerenderer });

    await exportAndSettle(result.current.exportPdf, SNAPSHOT);

    // Exposed as soon as the pre-pass resolves, mapped onto the shared diagnostic shape.
    expect(result.current.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'malformed-diagram',
        resource: SNAPSHOT.openPath,
        location: { path: SNAPSHOT.openPath, line: 7 },
        message: 'Parse error on line 1.',
      },
    ]);

    const workerDiagnostic = {
      severity: 'warning' as const,
      code: 'remote-skipped' as const,
      resource: 'https://example.com/logo.png',
      message: 'Remote image skipped.',
    };
    act(() =>
      lastWorker().emit({
        type: 'result',
        result: makeResult(lastRenderRequest().requestId, { diagnostics: [workerDiagnostic] }),
      }),
    );

    expect(result.current.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'malformed-diagram',
        resource: SNAPSHOT.openPath,
        location: { path: SNAPSHOT.openPath, line: 7 },
        message: 'Parse error on line 1.',
      },
      workerDiagnostic,
    ]);
  });

  it('omits generatedAssets and exports normally when the document has no mermaid diagrams', async () => {
    const { prerenderer, prerender } = fakePrerenderer({
      assets: [],
      diagnostics: [],
      aborted: false,
    });
    const { result } = renderExport({ createPrerenderer: () => prerenderer });

    await exportAndSettle(result.current.exportPdf, SNAPSHOT);

    expect(prerender).toHaveBeenCalledTimes(1);
    const request = lastRenderRequest();
    expect(request.generatedAssets).toBeUndefined();
    expect(request.mode).toBe('export');

    act(() => lastWorker().emit({ type: 'result', result: makeResult(request.requestId) }));
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(result.current.isExporting).toBe(false);
  });
});
