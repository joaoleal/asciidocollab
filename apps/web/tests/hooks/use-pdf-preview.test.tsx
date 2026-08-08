import { renderHook, act } from '@testing-library/react';
import {
  computeSourceHash,
  detectRenderableBlocks,
  type FromWorker,
  type ProjectSnapshot,
  type RenderResult,
  type ToWorker,
} from '@asciidocollab/asciidoc-pdf';
import { usePdfPreview } from '@/hooks/use-pdf-preview';
import { PREVIEW_DEBOUNCE_MS, PREVIEW_MAX_WAIT_MS } from '@/lib/editor-config';
import {
  createMermaidPrerenderer,
  type IdleScheduler,
} from '@/lib/pdf/prerender-mermaid';
import { createMermaidShim, type MermaidRenderer } from '@/workers/shims/mermaid';

// ── Worker mock ──────────────────────────────────────────────────────────────

type WorkerMessageListener = (event: MessageEvent<FromWorker>) => void;

class MockWorker {
  static instances: MockWorker[] = [];
  private messageListeners: WorkerMessageListener[] = [];
  postMessage = jest.fn<void, [ToWorker]>();
  terminate = jest.fn();

  constructor() {
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: WorkerMessageListener) {
    if (type === 'message') this.messageListeners.push(listener);
  }

  emit(data: FromWorker) {
    for (const listener of this.messageListeners) {
      listener({ data } as MessageEvent<FromWorker>);
    }
  }
}

// Mock the worker factory so tests never touch import.meta.url or the real worker file.
jest.mock('@/lib/create-pdf-worker', () => ({
  createPdfWorker: jest.fn(() => new MockWorker()),
}));

// Fixed debounce so tests don't depend on the env-configured value.
jest.mock('@/lib/editor-config', () => ({
  ...jest.requireActual('@/lib/editor-config'),
  PREVIEW_DEBOUNCE_MS: 100,
}));

import { createPdfWorker } from '@/lib/create-pdf-worker';
const mockCreatePdfWorker = createPdfWorker as jest.Mock;

// ── Mermaid pre-pass seams ────────────────────────────────────────────────────

/** A deterministic, DOM-free stand-in for the real mermaid engine: SVG derived purely from the source. */
const fakeRenderer: MermaidRenderer = async (_config, source) => `<svg data-source="${source}"></svg>`;

/** Run the scheduled callback immediately (a synchronous idle). */
const runNow: IdleScheduler = (callback) => callback();

/** A document carrying exactly one mermaid diagram whose source is tagged with `label`. */
function mermaidDocument(label: string): string {
  return ['= Title', '', '[mermaid]', '----', `graph TD; A-->${label}`, '----', ''].join('\n');
}

/** A deterministic pre-pass instance for the hook to drive. */
function makePrerenderer(mermaidRenderer: MermaidRenderer = fakeRenderer, scheduleIdle: IdleScheduler = runNow) {
  return createMermaidPrerenderer({ mermaidRenderer, scheduleIdle });
}

/**
 * Flush the pre-pass's chained microtasks so its `.then` posts the render. The idle scheduler here is
 * synchronous, so only the promise chain (idle wait → shim render → post) needs draining.
 */
async function flushPrepass() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function lastWorker() {
  return MockWorker.instances.at(-1)!;
}

/** Render messages the hook posted (excludes the mount-time `warmup`). */
function renderCalls(worker: MockWorker) {
  return worker.postMessage.mock.calls
    .map((call) => call[0])
    .filter((message): message is Extract<ToWorker, { type: 'render' }> => message.type === 'render');
}

function makeSnapshot(files: Record<string, string>, rootPath = 'main.adoc'): ProjectSnapshot {
  return {
    files,
    binaryAssets: {},
    rootPath,
    openPath: rootPath,
    fontPaths: [],
    attributes: {},
  };
}

/** A stage breakdown of zeros: this fixture's render cost is not what the tests below are about. */
const NO_STAGE_COST = { vmBootMs: 0, populateMs: 0, pipelineMs: 0, convertMs: 0 };

/** One keystroke every half trailing-delay — fast enough that the trailing timer can never elapse. */
const KEYSTROKE_INTERVAL_MS = PREVIEW_DEBOUNCE_MS / 2;

/**
 * Type for `durationMs` of wall clock without ever pausing long enough for the trailing debounce.
 * Under this input the trailing timer is restarted before it can fire, so the maximum-wait cap is the
 * only thing that can still refresh the preview — which is exactly what these tests are about.
 *
 * @param durationMs - How long the uninterrupted burst lasts.
 * @param type - Feeds the next value of the edited document to the hook under test.
 * @returns The document text after the final keystroke.
 */
function typeWithoutPausing(durationMs: number, type: (documentText: string) => void): string {
  let text = '= Doc';
  for (let elapsed = 0; elapsed < durationMs; elapsed += KEYSTROKE_INTERVAL_MS) {
    text += 'x';
    act(() => type(text));
    act(() => jest.advanceTimersByTime(KEYSTROKE_INTERVAL_MS));
  }
  return text;
}

/**
 * A snapshot factory that records whether it was called — the lazy form of the hook's snapshot input.
 *
 * @param text - The document text the built snapshot carries.
 * @returns A spy producing that snapshot.
 */
function snapshotBuilder(text: string): jest.Mock<ProjectSnapshot, []> {
  return jest.fn(() => makeSnapshot({ 'main.adoc': text }));
}

function makeResult(requestId: string, sourceMap?: RenderResult['sourceMap']): RenderResult {
  return {
    requestId,
    mode: 'preview',
    pdf: new Blob(['%PDF'], { type: 'application/pdf' }),
    diagnostics: [],
    stats: { renderMs: 1, cacheHits: 0, rasterFallbacks: 0, stages: NO_STAGE_COST },
    ...(sourceMap === undefined ? {} : { sourceMap }),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  MockWorker.instances = [];
  mockCreatePdfWorker.mockClear();
  mockCreatePdfWorker.mockImplementation(() => new MockWorker());
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('usePdfPreview', () => {
  it('creates a single warm worker and sends a warmup message on mount', () => {
    renderHook(() =>
      usePdfPreview({ snapshot: makeSnapshot({ 'main.adoc': '= Doc' }), isEnabled: true }),
    );

    expect(mockCreatePdfWorker).toHaveBeenCalledTimes(1);
    const warmups = lastWorker().postMessage.mock.calls
      .map((call) => call[0])
      .filter((message) => message.type === 'warmup');
    expect(warmups).toHaveLength(1);
  });

  it('coalesces rapid snapshot changes into a single latest render after debounce', async () => {
    const { rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) => usePdfPreview({ snapshot, isEnabled: true }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': '= A' }) } },
    );

    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': '= AB' }) }));
    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': '= ABC' }) }));
    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': '= ABCD' }) }));

    // No render posted before the debounce elapses.
    expect(renderCalls(lastWorker())).toHaveLength(0);

    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();

    const renders = renderCalls(lastWorker());
    expect(renders).toHaveLength(1);
    expect(renders[0]!.request.snapshot.files['main.adoc']).toBe('= ABCD');
    expect(renders[0]!.request.mode).toBe('preview');
  });

  it('marks the preview as rendering while a render is in flight', () => {
    const { result } = renderHook(() =>
      usePdfPreview({ snapshot: makeSnapshot({ 'main.adoc': '= Doc' }), isEnabled: true }),
    );

    act(() => jest.advanceTimersByTime(200));
    expect(result.current.isRendering).toBe(true);

    act(() => lastWorker().emit({ type: 'result', result: makeResult('1') }));
    expect(result.current.isRendering).toBe(false);
    expect(result.current.pdf).toBeInstanceOf(Blob);
  });

  it('exposes the source map from a result and clears it on a later map-less render', () => {
    const sourceMap = [{ line: 1, page: 1, yFraction: 0.2 }];
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) => usePdfPreview({ snapshot, isEnabled: true }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': '= A' }) } },
    );

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ type: 'result', result: makeResult('1', sourceMap) }));
    expect(result.current.sourceMap).toEqual(sourceMap);

    // A subsequent render whose result carries no map resets it, so a stale map never lingers.
    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': '= AB' }) }));
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ type: 'result', result: makeResult('2') }));
    expect(result.current.sourceMap).toBeUndefined();
  });

  it('discards a stale result whose requestId is not the latest issued', () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) => usePdfPreview({ snapshot, isEnabled: true }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': '= First' }) } },
    );

    // requestId '1' issued and answered.
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ type: 'result', result: makeResult('1') }));
    const firstPdf = result.current.pdf;

    // requestId '2' issued.
    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': '= Second' }) }));
    act(() => jest.advanceTimersByTime(200));

    // A late duplicate for the superseded request '1' must be ignored: the preview keeps the document
    // it is showing and stays rendering, rather than treating the older render as this one's answer.
    act(() => lastWorker().emit({ type: 'result', result: makeResult('1') }));
    expect(result.current.pdf).toBe(firstPdf);
    expect(result.current.isRendering).toBe(true);

    // The latest result is honored.
    act(() => lastWorker().emit({ type: 'result', result: makeResult('2') }));
    expect(result.current.pdf).toBeInstanceOf(Blob);
    expect(result.current.pdf).not.toBe(firstPdf);
    expect(result.current.isRendering).toBe(false);
  });

  it('tracks the phase from progress messages and ignores stale progress', () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) => usePdfPreview({ snapshot, isEnabled: true }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': '= First' }) } },
    );

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ type: 'result', result: makeResult('1') }));
    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': '= Second' }) }));
    act(() => jest.advanceTimersByTime(200));

    // Stale progress for request '1' ignored.
    act(() => lastWorker().emit({ type: 'progress', requestId: '1', phase: 'converting' }));
    expect(result.current.phase).toBeUndefined();

    // Fresh progress for request '2' honored.
    act(() => lastWorker().emit({ type: 'progress', requestId: '2', phase: 'converting' }));
    expect(result.current.phase).toBe('converting');
  });

  it('surfaces diagnostics carried by a successful result', () => {
    const { result } = renderHook(() =>
      usePdfPreview({ snapshot: makeSnapshot({ 'main.adoc': '= Doc' }), isEnabled: true }),
    );

    act(() => jest.advanceTimersByTime(200));
    const withDiagnostics: RenderResult = {
      ...makeResult('1'),
      diagnostics: [
        { severity: 'warning', code: 'remote-skipped', resource: 'https://x', message: 'skipped' },
      ],
    };
    act(() => lastWorker().emit({ type: 'result', result: withDiagnostics }));

    expect(result.current.diagnostics).toHaveLength(1);
    expect(result.current.diagnostics[0]!.code).toBe('remote-skipped');
  });

  it('surfaces what the render cost, as the engine reported it', () => {
    const { result } = renderHook(() =>
      usePdfPreview({ snapshot: makeSnapshot({ 'main.adoc': '= Doc' }), isEnabled: true }),
    );

    act(() => jest.advanceTimersByTime(200));
    const withStats: RenderResult = {
      ...makeResult('1'),
      stats: {
        coldStartMs: 900,
        renderMs: 3200,
        cacheHits: 4,
        rasterFallbacks: 1,
        stages: { vmBootMs: 900, populateMs: 40, pipelineMs: 260, convertMs: 2000 },
      },
    };
    act(() => lastWorker().emit({ type: 'result', result: withStats }));

    expect(result.current.stats).toEqual({
      coldStartMs: 900,
      renderMs: 3200,
      cacheHits: 4,
      rasterFallbacks: 1,
      stages: { vmBootMs: 900, populateMs: 40, pipelineMs: 260, convertMs: 2000 },
    });
  });

  it('exposes a fatal error and stops rendering', () => {
    const { result } = renderHook(() =>
      usePdfPreview({ snapshot: makeSnapshot({ 'main.adoc': '= Doc' }), isEnabled: true }),
    );

    act(() => jest.advanceTimersByTime(200));
    act(() =>
      lastWorker().emit({
        type: 'error',
        error: { requestId: '1', phase: 'convert', code: 'convert-failed', message: 'boom' },
      }),
    );

    expect(result.current.error?.message).toBe('boom');
    expect(result.current.isRendering).toBe(false);
  });

  it('forwards caller-supplied changedPaths on a delta render', async () => {
    const { rerender } = renderHook(
      ({ snapshot, changedPaths }: { snapshot: ProjectSnapshot; changedPaths?: readonly string[] }) =>
        usePdfPreview({ snapshot, isEnabled: true, changedPaths }),
      {
        initialProps: {
          snapshot: makeSnapshot({ 'main.adoc': '= A', 'ch.adoc': '== A' }),
          changedPaths: undefined as readonly string[] | undefined,
        },
      },
    );

    // Initial full render — no changedPaths.
    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();
    expect(renderCalls(lastWorker())[0]!.request.changedPaths).toBeUndefined();
    act(() => lastWorker().emit({ type: 'result', result: makeResult('1') }));

    // A single file changed → the caller supplies the delta.
    act(() =>
      rerender({
        snapshot: makeSnapshot({ 'main.adoc': '= A', 'ch.adoc': '== B' }),
        changedPaths: ['ch.adoc'],
      }),
    );
    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();

    const renders = renderCalls(lastWorker());
    expect(renders).toHaveLength(2);
    expect(renders[1]!.request.changedPaths).toEqual(['ch.adoc']);
  });

  it('cancels a pending debounced render when the preview is disabled before it fires', () => {
    // A stable snapshot identity keeps the snapshot effect from re-running on the toggle, so the
    // enable effect is the one that clears the still-pending debounce timer.
    const snapshot = makeSnapshot({ 'main.adoc': '= Doc' });
    const { rerender } = renderHook(
      ({ isEnabled }: { isEnabled: boolean }) => usePdfPreview({ snapshot, isEnabled }),
      { initialProps: { isEnabled: true } },
    );

    // A render is scheduled on mount but the debounce window has not elapsed yet.
    expect(renderCalls(lastWorker())).toHaveLength(0);

    // Disabling before the timer fires must clear the pending render so nothing is posted.
    act(() => rerender({ isEnabled: false }));
    act(() => jest.advanceTimersByTime(500));

    expect(renderCalls(lastWorker())).toHaveLength(0);
  });

  it('does not render while disabled and terminates the worker on unmount', async () => {
    const { rerender, unmount } = renderHook(
      ({ isEnabled }: { isEnabled: boolean }) =>
        usePdfPreview({ snapshot: makeSnapshot({ 'main.adoc': '= Doc' }), isEnabled }),
      { initialProps: { isEnabled: false } },
    );

    act(() => jest.advanceTimersByTime(500));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(0);

    act(() => rerender({ isEnabled: true }));
    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(1);

    const worker = lastWorker();
    expect(worker.terminate).not.toHaveBeenCalled();
    unmount();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('attaches the mermaid pre-pass assets to the preview render request', async () => {
    const document = mermaidDocument('B');
    renderHook(() =>
      usePdfPreview({
        snapshot: makeSnapshot({ 'main.adoc': document }),
        isEnabled: true,
        prerenderer: makePrerenderer(),
      }),
    );

    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();

    const renders = renderCalls(lastWorker());
    expect(renders).toHaveLength(1);
    const assets = renders[0]!.request.generatedAssets ?? [];
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ kind: 'diagram', format: 'svg' });
  });

  it('drops a superseded pre-pass so only the newest edit renders (coalescing across the debounce)', async () => {
    const idleQueue: Array<() => void> = [];
    const scheduleIdle: IdleScheduler = (callback) => {
      idleQueue.push(callback);
    };
    const renderer = jest.fn(fakeRenderer);
    const prerenderer = makePrerenderer(renderer, scheduleIdle);

    const { rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) =>
        usePdfPreview({ snapshot, isEnabled: true, prerenderer }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': mermaidDocument('A') }) } },
    );

    // The first edit's debounce fires: pre-pass A starts and parks on the (manual) idle queue.
    act(() => jest.advanceTimersByTime(200));
    // A newer edit arrives and its debounce fires: pre-pass B supersedes A.
    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': mermaidDocument('B') }) }));
    act(() => jest.advanceTimersByTime(200));

    // Drain every parked idle slice and settle both promise chains.
    await act(async () => {
      while (idleQueue.length > 0) idleQueue.shift()!();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });

    const renders = renderCalls(lastWorker());
    // The stale pre-pass never posted; only the newest document rendered.
    expect(renders).toHaveLength(1);
    expect(renders[0]!.request.snapshot.files['main.adoc']).toContain('A-->B');
    expect(renders[0]!.request.generatedAssets ?? []).toHaveLength(1);
    // The superseded run never invoked the (DOM-bound) engine: only the winner rendered.
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it('produces the same renderable blocks and diagnostics on the preview path as the export path', async () => {
    const document = mermaidDocument('B');
    renderHook(() =>
      usePdfPreview({
        snapshot: makeSnapshot({ 'main.adoc': document }),
        isEnabled: true,
        prerenderer: makePrerenderer(),
      }),
    );

    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();

    const previewAssets = renderCalls(lastWorker())[0]!.request.generatedAssets ?? [];

    // The export path rides the identical shared detector + shim; simulate it independently.
    const exportRun = await makePrerenderer().prerender(document);

    // Same renderable-block set (content-addressed) AND same diagnostics on both paths.
    expect(previewAssets.map((asset) => asset.sourceHash)).toEqual(
      exportRun.assets.map((asset) => asset.sourceHash),
    );
    expect(exportRun.diagnostics).toEqual([]);

    // And both match the shared detector + shim computed straight from the document.
    const block = detectRenderableBlocks(document).find(
      (candidate) => candidate.category === 'diagram' && candidate.notation === 'mermaid',
    )!;
    const expectedHash = computeSourceHash({
      source: block.source,
      renderParams: block.params,
      shimVersion: createMermaidShim().version,
    });
    expect(previewAssets.map((asset) => asset.sourceHash)).toEqual([expectedHash]);
  });
});

// ── usePdfPreview — refreshing while typing never pauses ─────────────────────

describe('usePdfPreview — refresh while typing without pause', () => {
  it('refreshes once the maximum wait elapses even though typing never pauses', async () => {
    const { rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) => usePdfPreview({ snapshot, isEnabled: true }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': '= Doc' }) } },
    );

    const typed = typeWithoutPausing(PREVIEW_MAX_WAIT_MS + KEYSTROKE_INTERVAL_MS, (documentText) =>
      rerender({ snapshot: makeSnapshot({ 'main.adoc': documentText }) }),
    );
    await flushPrepass();

    // The trailing delay never came due, so this render exists only because the cap forced it.
    const renders = renderCalls(lastWorker());
    expect(renders).toHaveLength(1);
    const posted = renders[0]!.request.snapshot.files['main.adoc']!;
    // It carried an edit made during the burst, not the value the hook mounted with.
    expect(typed.startsWith(posted)).toBe(true);
    expect(posted).not.toBe('= Doc');
  });

  it('holds the refresh back while a render is in flight and runs it when that render finishes', async () => {
    const { rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) => usePdfPreview({ snapshot, isEnabled: true }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': '= Doc' }) } },
    );

    // Two whole cap windows of uninterrupted typing, with the worker never answering the first
    // render: the second expiry must be held back rather than stacked on the render still running.
    typeWithoutPausing(PREVIEW_MAX_WAIT_MS * 2 + KEYSTROKE_INTERVAL_MS, (documentText) =>
      rerender({ snapshot: makeSnapshot({ 'main.adoc': documentText }) }),
    );
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(1);

    // The in-flight render reports back with work still pending, so the held-back refresh runs —
    // without waiting for another cap window.
    act(() => lastWorker().emit({ type: 'result', result: makeResult('1') }));
    await flushPrepass();

    expect(renderCalls(lastWorker())).toHaveLength(2);
  });

  it('never posts a second render while one is still outstanding', async () => {
    const { rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) => usePdfPreview({ snapshot, isEnabled: true }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': '= A' }) } },
    );

    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(1);

    // The author edits and pauses — twice, each pause long enough for the trailing delay AND the cap —
    // while the worker has still not answered the render it is holding.
    for (const text of ['= AB', '= ABC']) {
      act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': text }) }));
      act(() => jest.advanceTimersByTime(PREVIEW_MAX_WAIT_MS + 200));
      await flushPrepass();
      expect(renderCalls(lastWorker())).toHaveLength(1);
    }

    // Reporting back releases exactly one render, and it carries the NEWEST document rather than the
    // one that was current when the first refresh came due.
    act(() => lastWorker().emit({ type: 'result', result: makeResult('1') }));
    await flushPrepass();

    const renders = renderCalls(lastWorker());
    expect(renders).toHaveLength(2);
    expect(renders[1]!.request.snapshot.files['main.adoc']).toBe('= ABC');
  });

  it('renders the edit that was still waiting out its pause when the render finished', async () => {
    const { rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) => usePdfPreview({ snapshot, isEnabled: true }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': '= A' }) } },
    );

    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(1);

    // An edit comes due while that render is running, so it is held behind it.
    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': '= AB' }) }));
    act(() => jest.advanceTimersByTime(PREVIEW_MAX_WAIT_MS + 200));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(1);

    // A further edit arrives and is still waiting out its trailing pause when the render reports.
    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': '= ABC' }) }));
    act(() => lastWorker().emit({ type: 'result', result: makeResult('1') }));
    await flushPrepass();

    // The newest edit is the one worth rendering — the held state is a version older, and rendering
    // it while discarding the run that carried this one is how the newest edit went missing outright.
    const renders = renderCalls(lastWorker());
    expect(renders).toHaveLength(2);
    expect(renders[1]!.request.snapshot.files['main.adoc']).toBe('= ABC');

    // Nothing further is owed: it was rendered, not merely postponed.
    act(() => jest.advanceTimersByTime(PREVIEW_MAX_WAIT_MS * 2));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(2);
  });

  it('holds the render a reopened panel asks for behind the one still running', async () => {
    const snapshot = makeSnapshot({ 'main.adoc': '= Doc' });
    const { rerender } = renderHook(
      ({ isEnabled }: { isEnabled: boolean }) => usePdfPreview({ snapshot, isEnabled }),
      { initialProps: { isEnabled: true } },
    );

    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(1);

    // Closing the panel does not reach into the engine: the convert is one synchronous call, so that
    // render is still running and its VM instance is still one no other render may share.
    act(() => rerender({ isEnabled: false }));
    act(() => rerender({ isEnabled: true }));
    act(() => jest.advanceTimersByTime(PREVIEW_MAX_WAIT_MS + 200));
    await flushPrepass();

    // Posted, the reopened panel's render would only queue BEHIND the abandoned one — the first
    // refresh after reopening costing two full page renders instead of one.
    expect(renderCalls(lastWorker())).toHaveLength(1);

    act(() => lastWorker().emit({ type: 'result', result: makeResult('1') }));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(2);
  });

  it('releases the held render when the outstanding one fails, not only when it succeeds', async () => {
    const { rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) => usePdfPreview({ snapshot, isEnabled: true }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': '= A' }) } },
    );

    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();
    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': '= AB' }) }));
    act(() => jest.advanceTimersByTime(PREVIEW_MAX_WAIT_MS + 200));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(1);

    act(() =>
      lastWorker().emit({
        type: 'error',
        error: { requestId: '1', phase: 'convert', code: 'convert-failed', message: 'boom' },
      }),
    );
    await flushPrepass();

    // A failed render must not wedge the preview: the edit made while it was running still renders.
    const renders = renderCalls(lastWorker());
    expect(renders).toHaveLength(2);
    expect(renders[1]!.request.snapshot.files['main.adoc']).toBe('= AB');
  });

  it('materialises a lazily-supplied snapshot when the render is due, not on every edit', async () => {
    const builders = [snapshotBuilder('= A'), snapshotBuilder('= AB'), snapshotBuilder('= ABC')];

    const { rerender } = renderHook(
      ({ source }: { source: () => ProjectSnapshot }) =>
        usePdfPreview({ snapshot: source, isEnabled: true }),
      { initialProps: { source: builders[0]! } },
    );
    act(() => rerender({ source: builders[1]! }));
    act(() => rerender({ source: builders[2]! }));

    // Three edits, no render due yet: capturing the project is what the debounce is protecting.
    expect(builders.map((builder) => builder.mock.calls.length)).toEqual([0, 0, 0]);

    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();

    // Exactly one capture happened, for the state that actually rendered.
    expect(builders.map((builder) => builder.mock.calls.length)).toEqual([0, 0, 1]);
    expect(renderCalls(lastWorker())[0]!.request.snapshot.files['main.adoc']).toBe('= ABC');
  });

  it('waits longer before the next render when the last one was expensive', async () => {
    const { rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) => usePdfPreview({ snapshot, isEnabled: true }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': '= A' }) } },
    );

    // Nothing measured yet, so the first render goes out after the fixed delay.
    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(1);

    // It reports having cost 400 ms, so the next pause is twice that rather than the fixed delay.
    const costly: RenderResult = {
      ...makeResult('1'),
      stats: { renderMs: 400, cacheHits: 0, rasterFallbacks: 0, stages: NO_STAGE_COST },
    };
    act(() => lastWorker().emit({ type: 'result', result: costly }));

    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': '= AB' }) }));
    act(() => jest.advanceTimersByTime(300));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(1);

    act(() => jest.advanceTimersByTime(600));
    await flushPrepass();
    expect(renderCalls(lastWorker())).toHaveLength(2);
  });

  it('exposes the snapshot the current preview was rendered from, not the latest edit', async () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: ProjectSnapshot }) => usePdfPreview({ snapshot, isEnabled: true }),
      { initialProps: { snapshot: makeSnapshot({ 'main.adoc': '= A' }) } },
    );

    expect(result.current.renderedSnapshot).toBeUndefined();

    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();
    // The author types on while the render is running.
    act(() => rerender({ snapshot: makeSnapshot({ 'main.adoc': '= AB' }) }));
    act(() => lastWorker().emit({ type: 'result', result: makeResult('1') }));

    // What the preview is showing came from the earlier text, and that is what it reports.
    expect(result.current.renderedSnapshot?.files['main.adoc']).toBe('= A');
  });

  it('still renders when the mermaid pre-pass fails, rather than stalling on it', async () => {
    const failing = {
      prerender: jest.fn(() => Promise.reject(new Error('the mermaid engine could not be loaded'))),
    };
    const { result } = renderHook(() =>
      usePdfPreview({
        snapshot: makeSnapshot({ 'main.adoc': mermaidDocument('A') }),
        isEnabled: true,
        prerenderer: failing,
      }),
    );

    act(() => jest.advanceTimersByTime(200));
    await flushPrepass();

    // The render went out with nothing pre-seeded — the worker's own mermaid handling reports the
    // block — instead of the preview being pinned on "rendering" with no reply ever coming.
    const renders = renderCalls(lastWorker());
    expect(renders).toHaveLength(1);
    expect(renders[0]!.request.generatedAssets).toBeUndefined();
    expect(result.current.isRendering).toBe(true);

    act(() => lastWorker().emit({ type: 'result', result: makeResult('1') }));
    expect(result.current.isRendering).toBe(false);
  });

  it('cancels the pending refresh when the hook unmounts', () => {
    const { unmount } = renderHook(() =>
      usePdfPreview({ snapshot: makeSnapshot({ 'main.adoc': '= Doc' }), isEnabled: true }),
    );

    // A render is scheduled but neither timer has come due yet.
    expect(renderCalls(lastWorker())).toHaveLength(0);
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    unmount();

    // Both the trailing timer and the cap are gone — nothing is left armed to fire into a dead hook.
    expect(jest.getTimerCount()).toBe(0);
  });
});
