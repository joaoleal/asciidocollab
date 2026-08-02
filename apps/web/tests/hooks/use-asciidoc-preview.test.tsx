import { renderHook, act, cleanup } from '@testing-library/react';
import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import { adaptiveDelayMs } from '@/lib/preview/adaptive-delay';
import {
  MAX_ENGINE_REBUILDS,
  PREVIEW_DEBOUNCE_MS,
  PREVIEW_MAX_WAIT_MS,
  RENDER_WORKER_IDLE_RETENTION_MS,
} from '@/lib/editor-config';
import DOMPurify from 'dompurify';

// ── Worker mock ──────────────────────────────────────────────────────────────

type WorkerMessageListener = (event: MessageEvent) => void;
type WorkerErrorListener = () => void;

class MockWorker {
  static instances: MockWorker[] = [];
  private messageListeners: WorkerMessageListener[] = [];
  private errorListeners: WorkerErrorListener[] = [];
  postMessage = jest.fn();
  terminate = jest.fn();

  constructor() {
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: WorkerMessageListener | WorkerErrorListener) {
    if (type === 'message') this.messageListeners.push(listener as WorkerMessageListener);
    if (type === 'error') this.errorListeners.push(listener as WorkerErrorListener);
  }

  /**
   * Reply to a render, the way the real worker replies to one.
   *
   * A test names the render it is answering by the hook's own `requestId`, which is what the hook
   * itself reads. The wire also carries the holder's routing token — the hook's numbering restarts at
   * 1 per mount and cannot say whose reply is whose on a shared worker — and the real worker echoes
   * it back untouched. Doing that here, by looking up the request that went out under this id, is what
   * keeps the token an implementation detail of the holder rather than something every test recites.
   */
  emit(data: unknown) {
    const answering = data as { requestId?: number; renderId?: number };
    const posted = this.postMessage.mock.calls
      .map(([request]) => request as { requestId: number; renderId?: number })
      .findLast((request) => request.requestId === answering.requestId);
    const echoed =
      answering.renderId === undefined && posted?.renderId !== undefined
        ? { ...answering, renderId: posted.renderId }
        : answering;
    for (const listener of this.messageListeners) {
      listener({ data: echoed } as MessageEvent);
    }
  }

  /** Report that the worker itself has gone — a crash or a reclaim, not a render that failed. */
  die() {
    for (const listener of this.errorListeners) listener();
  }
}

// Mock the worker factory so tests never touch import.meta.url or the real worker file.
// jest.fn() allows spying on call counts; the implementation creates a MockWorker.
jest.mock('@/lib/spawn-render-worker', () => ({
  spawnRenderWorker: jest.fn(() => new MockWorker()),
}));

// ── DOMPurify mock ───────────────────────────────────────────────────────────

// Test double for DOMPurify: strips <script>…</script> with a linear, non-regex scan so the mock
// itself does not trip the ReDoS / incomplete-sanitization scanners the way a regex HTML filter would.
// The name is `mock`-prefixed so jest permits it inside the hoisted jest.mock factory below.
function mockStripScriptTags(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let index = 0;
  while (index < html.length) {
    const start = lower.indexOf('<script', index);
    if (start === -1) {
      out += html.slice(index);
      break;
    }
    out += html.slice(index, start);
    const end = lower.indexOf('</script>', start);
    if (end === -1) break; // unterminated: drop the remainder
    index = end + '</script>'.length;
  }
  return out;
}

/**
 * Answer in the currency the hook now asks for: NODES, not markup.
 *
 * The hook sanitizes straight to a fragment and commits those nodes, so a double that still returned a
 * string would be standing in for a hook that no longer exists. What the real sanitizer actually
 * decides is not this suite's business — a double can only ever prove what it was written to do — and
 * is proved against the real DOMPurify in `use-asciidoc-preview.sanitizer.test.tsx`.
 */
function mockSanitizeToFragment(html: string): DocumentFragment {
  const parsed = document.createElement('template');
  parsed.innerHTML = mockStripScriptTags(html);
  return parsed.content;
}

/**
 * Both shapes the real sanitizer answers in, chosen by the same flag the real one reads.
 *
 * The hook asks for nodes to commit and — only if someone reads the render's markup — for markup. A
 * double that answered with nodes whichever was asked for would let a test pass while the hook was
 * handed something it could not use.
 */
function mockSanitizeInShape(html: string, config?: { RETURN_DOM_FRAGMENT?: boolean }): DocumentFragment | string {
  return config?.RETURN_DOM_FRAGMENT === true ? mockSanitizeToFragment(html) : mockStripScriptTags(html);
}

jest.mock('dompurify', () => ({
  sanitize: jest.fn((html: string, config?: { RETURN_DOM_FRAGMENT?: boolean }) => mockSanitizeInShape(html, config)),
}));

// ── editor-config mock — fixed debounce so tests don't depend on env ─────────
//
// The adaptive floor is pinned alongside the ceiling because the two are read together: the delay
// derived from a measured render is clamped between them, and leaving the real 120ms floor beside a
// 100ms ceiling here would invert the range and make every derived delay a clamp artefact rather
// than a figure a test could reason about. A fifth of the ceiling keeps the same relationship the
// configured pair has — a floor well below the fixed delay it can shrink towards.
jest.mock('@/lib/editor-config', () => ({
  ...jest.requireActual('@/lib/editor-config'),
  PREVIEW_DEBOUNCE_MS: 100,
  PREVIEW_ADAPTIVE_MIN_MS: 20,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function lastWorker() {
  return MockWorker.instances.at(-1)!;
}

const mockSanitize = DOMPurify.sanitize as jest.Mock;

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

import { spawnRenderWorker } from '@/lib/spawn-render-worker';
const mockSpawnRenderWorker = spawnRenderWorker as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  MockWorker.instances = [];
  mockSanitize.mockClear();
  mockSanitize.mockImplementation((html: string, config?: { RETURN_DOM_FRAGMENT?: boolean }) =>
    mockSanitizeInShape(html, config),
  );
  mockSpawnRenderWorker.mockClear();
  mockSpawnRenderWorker.mockImplementation(() => new MockWorker());
});

afterEach(() => {
  // The render engine is shared and outlives the hook on purpose, so it is still there — retained,
  // waiting to be picked up again — when a test ends. Unmount whatever the test left mounted and let
  // the retention window run out, so the next test starts against a cold engine instead of inheriting
  // this one's worker along with everything already posted to it.
  cleanup();
  jest.advanceTimersByTime(RENDER_WORKER_IDLE_RETENTION_MS);
  jest.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useAsciidocPreview', () => {
  // (a) state transitions idle → pending → rendering → up-to-date on content change + worker response
  it('transitions idle → pending → rendering → up-to-date on content change and worker success', () => {
    const { result, rerender } = renderHook(
      ({ content, isEnabled }: { content: string; isEnabled: boolean }) =>
        useAsciidocPreview({ content, isEnabled, scrollToLine: null }),
      { initialProps: { content: '', isEnabled: true } },
    );

    // Empty content → idle
    expect(result.current.state).toBe('idle');

    // Provide content → pending
    act(() => rerender({ content: '= Hello', isEnabled: true }));
    expect(result.current.state).toBe('pending');

    // Debounce fires → rendering
    act(() => jest.advanceTimersByTime(200));
    expect(result.current.state).toBe('rendering');

    // Worker responds with success → up-to-date
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Hello</h1>', error: null }));
    expect(result.current.state).toBe('up-to-date');
    expect(result.current.html).toBe('<h1>Hello</h1>');
    expect(result.current.error).toBeNull();
  });

  // (b) state → error on ok:false with previous html retained
  it('transitions to error on worker failure and retains previous html', () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Good' } },
    );

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Good</h1>', error: null }));
    expect(result.current.state).toBe('up-to-date');
    expect(result.current.html).toBe('<h1>Good</h1>');

    // Second render fails
    act(() => rerender({ content: '= Bad' }));
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 2, ok: false, html: null, error: 'parse error' }));

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('parse error');
    // Previous html retained
    expect(result.current.html).toBe('<h1>Good</h1>');
  });

  // (c) stale requestId responses are discarded
  it('discards stale worker responses (mismatched requestId)', () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= First' } },
    );

    // requestId=1 dispatched
    act(() => jest.advanceTimersByTime(200));
    expect(result.current.state).toBe('rendering');

    // New content — requestId=2 will be dispatched on next debounce
    act(() => rerender({ content: '= Second' }));
    act(() => jest.advanceTimersByTime(200));

    // Stale response for requestId=1 — should be discarded
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Stale</h1>', error: null }));
    expect(result.current.state).toBe('rendering');
    expect(result.current.html).toBeNull();

    // Fresh response for requestId=2
    act(() => lastWorker().emit({ requestId: 2, ok: true, html: '<h1>Second</h1>', error: null }));
    expect(result.current.state).toBe('up-to-date');
    expect(result.current.html).toBe('<h1>Second</h1>');
  });

  // (d) debounce: rapid content changes produce only one worker message
  it('coalesces rapid content changes into a single worker message after debounce', () => {
    const { rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: 'a' } },
    );

    act(() => rerender({ content: 'ab' }));
    act(() => rerender({ content: 'abc' }));
    act(() => rerender({ content: 'abcd' }));

    // Before debounce fires — no messages sent
    expect(lastWorker().postMessage).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(200));

    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);
    expect(lastWorker().postMessage.mock.calls[0][0].content).toBe('abcd');
  });

  // (d2) include assembly: openFileId + files are forwarded when the open file content is
  // available. Assembly is now rooted at the open file; mainPath is the project config but
  // the hook routes assembly through openFileId so any open file can be assembled, not only main.
  it('forwards openFileId + files to the worker when the open file content is available', () => {
    renderHook(() =>
      useAsciidocPreview({
        content: '= Book\n\ninclude::ch.adoc[]\n',
        isEnabled: true,
        scrollToLine: null,
        mainPath: 'main.adoc',
        openFileId: 'main.adoc',
        getFiles: () => ({ 'main.adoc': '= Book\n\ninclude::ch.adoc[]\n', 'ch.adoc': '== Ch\n' }),
      }),
    );
    act(() => jest.advanceTimersByTime(200));
    const message = lastWorker().postMessage.mock.calls[0][0];
    expect(message.openFileId).toBe('main.adoc');
    expect(message.files).toMatchObject({ 'main.adoc': expect.any(String) });
  });

  it('forwards project render-config attributes to the worker when provided', () => {
    renderHook(() =>
      useAsciidocPreview({
        content: '= Doc',
        isEnabled: true,
        scrollToLine: null,
        projectAttributes: { doctype: 'book@', company: 'Acme@' },
      }),
    );
    act(() => jest.advanceTimersByTime(200));
    const message = lastWorker().postMessage.mock.calls[0][0];
    expect(message.projectAttributes).toEqual({ doctype: 'book@', company: 'Acme@' });
  });

  it('omits projectAttributes from the message when none are provided', () => {
    renderHook(() => useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine: null }));
    act(() => jest.advanceTimersByTime(200));
    expect(lastWorker().postMessage.mock.calls[0][0]).not.toHaveProperty('projectAttributes');
  });

  // (d3) guard: when getFiles lacks the root path (tree not loaded yet), assembly is skipped so the
  // preview renders the open file's content instead of blanking.
  it('skips assembly (no mainPath/files in the message) when the root content is not yet available', () => {
    renderHook(() =>
      useAsciidocPreview({
        content: '= Book',
        isEnabled: true,
        scrollToLine: null,
        mainPath: 'main.adoc',
        getFiles: () => ({}),
      }),
    );
    act(() => jest.advanceTimersByTime(200));
    const message = lastWorker().postMessage.mock.calls[0][0];
    expect(message.mainPath).toBeUndefined();
    expect(message.files).toBeUndefined();
    expect(message.content).toBe('= Book');
  });

  // (d4) live re-resolution on main-file change: changing the resolution root
  // (rootFileId) for an open CHILD file re-posts the render so its inherited cross-document scope is
  // re-resolved under the new root — with no document edit.
  it('re-renders an open child file when the project main file (rootFileId) changes', () => {
    const childContent = '== Child\n\n{product}\n';
    const files = {
      'old-main.adoc': '= Old\n:product: Old\n\ninclude::child.adoc[]\n',
      'new-main.adoc': '= New\n:product: New\n\ninclude::child.adoc[]\n',
      'child.adoc': childContent,
    };
    const { rerender } = renderHook(
      ({ rootFileId }: { rootFileId: string }) =>
        useAsciidocPreview({
          content: childContent,
          isEnabled: true,
          scrollToLine: null,
          rootFileId,
          openFileId: 'child.adoc',
          getFiles: () => files,
        }),
      { initialProps: { rootFileId: 'old-main.adoc' } },
    );

    act(() => jest.advanceTimersByTime(200));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);
    expect(lastWorker().postMessage.mock.calls[0][0].rootFileId).toBe('old-main.adoc');

    // The project main file setting changes → rootFileId changes. The child must re-resolve live.
    act(() => rerender({ rootFileId: 'new-main.adoc' }));
    act(() => jest.advanceTimersByTime(200));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);
    expect(lastWorker().postMessage.mock.calls[1][0].rootFileId).toBe('new-main.adoc');
  });

  // (e) scrollToLine calls querySelector and scrollIntoView
  it('scrolls to the element matching data-source-line when scrollToLine changes', () => {
    const mockScrollIntoView = jest.fn();
    const mockQuerySelectorAll = jest.fn().mockReturnValue([]);
    const mockQuerySelector = jest.fn().mockReturnValue({ scrollIntoView: mockScrollIntoView });

    const { result, rerender } = renderHook(
      ({ scrollToLine }: { scrollToLine: { line: number } | null }) =>
        useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine }),
      { initialProps: { scrollToLine: null as { line: number } | null } },
    );

    // Attach mock div to previewRef — override methods via prototype to avoid deprecation lint
    const div = document.createElement('div');
    Object.defineProperty(div, 'querySelector', { value: mockQuerySelector, configurable: true });
    Object.defineProperty(div, 'querySelectorAll', { value: mockQuerySelectorAll, configurable: true });
    Object.assign(result.current.previewRef, { current: div });

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<p data-source-line="5">text</p>', error: null }));

    act(() => rerender({ scrollToLine: { line: 5 } }));

    expect(mockQuerySelector).toHaveBeenCalledWith('[data-source-line="5"]');
    expect(mockScrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  // (f) scrollTop is saved and restored across re-renders
  it('saves and restores scrollTop across re-renders', () => {
    const { result } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Doc' } },
    );

    const div = document.createElement('div');
    let storedScrollTop = 120;
    Object.defineProperty(div, 'scrollTop', {
      get: () => storedScrollTop,
      set: (v: number) => { storedScrollTop = v; },
      configurable: true,
    });
    Object.defineProperty(div, 'innerHTML', { value: '', writable: true, configurable: true });
    Object.assign(result.current.previewRef, { current: div });

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<p>text</p>', error: null }));

    expect(storedScrollTop).toBe(120);
  });

  // (g) isEnabled: false transitions state to idle
  it('transitions to idle when isEnabled is false', () => {
    const { result, rerender } = renderHook(
      ({ isEnabled }: { isEnabled: boolean }) =>
        useAsciidocPreview({ content: '= Hello', isEnabled, scrollToLine: null }),
      { initialProps: { isEnabled: true } },
    );

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Hello</h1>', error: null }));
    expect(result.current.state).toBe('up-to-date');

    act(() => rerender({ isEnabled: false }));
    expect(result.current.state).toBe('idle');
  });

  // (h) when isEnabled transitions from false back to true, a fresh render is triggered
  it('triggers fresh render when isEnabled transitions from false to true', () => {
    const { result, rerender } = renderHook(
      ({ isEnabled }: { isEnabled: boolean }) =>
        useAsciidocPreview({ content: '= Hello', isEnabled, scrollToLine: null }),
      { initialProps: { isEnabled: false } },
    );

    expect(result.current.state).toBe('idle');

    act(() => rerender({ isEnabled: true }));
    expect(result.current.state).toBe('pending');

    act(() => jest.advanceTimersByTime(200));
    expect(result.current.state).toBe('rendering');
  });

  // (j) hook must NOT directly mutate previewRef.current.innerHTML
  it('does not directly mutate previewRef.current.innerHTML on worker success', () => {
    const { result } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Hello' } },
    );

    const div = document.createElement('div');
    let directInnerHtmlMutation = false;
    const originalDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(div, 'innerHTML', {
      get() {
        return (originalDescriptor?.get as (() => string) | undefined)?.call(this) ?? '';
      },
      set(v: string) {
        directInnerHtmlMutation = true;
        (originalDescriptor?.set as ((v: string) => void) | undefined)?.call(this, v);
      },
      configurable: true,
    });
    Object.assign(result.current.previewRef, { current: div });

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Hello</h1>', error: null }));

    expect(directInnerHtmlMutation).toBe(false);
  });

  // (k) each new ScrollRequest object triggers a scroll even when line number is identical
  it('scrolls on every new ScrollRequest object, even for the same line number', () => {
    const mockScrollIntoView = jest.fn();
    const mockQuerySelectorAll = jest.fn().mockReturnValue([]);
    const mockQuerySelector = jest.fn().mockReturnValue({ scrollIntoView: mockScrollIntoView });

    const { result, rerender } = renderHook(
      ({ scrollToLine }: { scrollToLine: { line: number } | null }) =>
        useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine }),
      { initialProps: { scrollToLine: null as { line: number } | null } },
    );

    const div = document.createElement('div');
    Object.defineProperty(div, 'querySelector', { value: mockQuerySelector, configurable: true });
    Object.defineProperty(div, 'querySelectorAll', { value: mockQuerySelectorAll, configurable: true });
    Object.assign(result.current.previewRef, { current: div });

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<p data-source-line="5">text</p>', error: null }));

    // First scroll request for line 5
    act(() => rerender({ scrollToLine: { line: 5 } }));
    expect(mockScrollIntoView).toHaveBeenCalledTimes(1);

    // Second scroll request — new object, same line number — must scroll again
    act(() => rerender({ scrollToLine: { line: 5 } }));
    expect(mockScrollIntoView).toHaveBeenCalledTimes(2);
  });

  // (stale-content) content changed while disabled; re-enabling must use fresh content
  it('sends fresh content to the worker when re-enabled after content changed while disabled', () => {
    const { result, rerender } = renderHook(
      ({ content, isEnabled }: { content: string; isEnabled: boolean }) =>
        useAsciidocPreview({ content, isEnabled, scrollToLine: null }),
      { initialProps: { content: 'initial content', isEnabled: true } },
    );

    // Complete an initial render so state reaches up-to-date
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<p>initial</p>', error: null }));
    expect(result.current.state).toBe('up-to-date');

    // Disable the preview
    act(() => rerender({ content: 'initial content', isEnabled: false }));
    expect(result.current.state).toBe('idle');

    // Content changes while disabled (user edits file in another tab, etc.)
    act(() => rerender({ content: 'updated content', isEnabled: false }));

    // Re-enable — worker must receive the UPDATED content, not the stale initial content
    act(() => rerender({ content: 'updated content', isEnabled: true }));
    act(() => jest.advanceTimersByTime(200));

    const allCalls = lastWorker().postMessage.mock.calls;
    const lastCall = allCalls.at(-1)?.[0];
    expect(lastCall?.content).toBe('updated content');
  });

  // (l) debounce is cleared when isEnabled transitions to false mid-debounce
  it('clears pending debounce when isEnabled transitions to false before the timer fires', () => {
    const { result, rerender } = renderHook(
      ({ isEnabled }: { isEnabled: boolean }) =>
        useAsciidocPreview({ content: '= Hello', isEnabled, scrollToLine: null }),
      { initialProps: { isEnabled: true } },
    );

    // Initial render with content queues a debounce — state should be pending
    expect(result.current.state).toBe('pending');

    // Disable before the debounce fires
    act(() => rerender({ isEnabled: false }));
    expect(result.current.state).toBe('idle');

    // Advance timers well past the debounce window — worker must never receive a message
    act(() => jest.advanceTimersByTime(500));
    expect(lastWorker().postMessage).not.toHaveBeenCalled();
  });

  // (m) scroll fallback: nearest element with data-source-line ≤ target when exact match absent
  it('scrolls to the nearest element with data-source-line ≤ target when exact match is absent', () => {
    const mockScrollLine3 = jest.fn();
    const mockScrollLine7 = jest.fn();

    const element1 = document.createElement('p');
    element1.dataset['sourceLine'] = '1';

    const element3 = document.createElement('p');
    element3.dataset['sourceLine'] = '3';
    element3.scrollIntoView = mockScrollLine3;

    const element7 = document.createElement('p');
    element7.dataset['sourceLine'] = '7';
    element7.scrollIntoView = mockScrollLine7;

    const mockQuerySelector = jest.fn().mockReturnValue(null); // no exact match for line 5
    const mockQuerySelectorAll = jest.fn().mockReturnValue([element1, element3, element7]);

    const { result, rerender } = renderHook(
      ({ scrollToLine }: { scrollToLine: { line: number } | null }) =>
        useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine }),
      { initialProps: { scrollToLine: null as { line: number } | null } },
    );

    const div = document.createElement('div');
    Object.defineProperty(div, 'querySelector', { value: mockQuerySelector, configurable: true });
    Object.defineProperty(div, 'querySelectorAll', { value: mockQuerySelectorAll, configurable: true });
    Object.assign(result.current.previewRef, { current: div });

    act(() => rerender({ scrollToLine: { line: 5 } }));

    // No exact element for line 5 → falls back to largest ≤ 5, which is line 3
    expect(mockQuerySelector).toHaveBeenCalledWith('[data-source-line="5"]');
    expect(mockScrollLine3).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    // Line 7 is beyond the target — must not scroll
    expect(mockScrollLine7).not.toHaveBeenCalled();
  });

  // The worker comes from the spawn factory, not a hardcoded static path. This is what makes
  // Next.js/webpack bundle the worker with all its dependencies (asciidoctor).
  it('creates the worker via the spawn factory', () => {
    renderHook(() => useAsciidocPreview({ content: '= Hello', isEnabled: true, scrollToLine: null }));
    expect(mockSpawnRenderWorker).toHaveBeenCalledTimes(1);
  });

  // Live update: renders new HTML after content changes following initial render
  it('renders updated HTML after content changes (live update)', () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Initial' } },
    );

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Initial</h1>', error: null }));
    expect(result.current.state).toBe('up-to-date');
    expect(result.current.html).toBe('<h1>Initial</h1>');

    // Change content — should re-enter pending then rendering then up-to-date
    act(() => rerender({ content: '= Updated' }));
    expect(result.current.state).toBe('pending');

    act(() => jest.advanceTimersByTime(200));
    expect(result.current.state).toBe('rendering');

    act(() => lastWorker().emit({ requestId: 2, ok: true, html: '<h1>Updated</h1>', error: null }));
    expect(result.current.state).toBe('up-to-date');
    expect(result.current.html).toBe('<h1>Updated</h1>');
  });

  // debounce null check: debounce timer starts as null so clearTimeout is skipped on first render
  it('does not crash on first content change (debounceReference starts null)', () => {
    expect(() => {
      const { rerender } = renderHook(
        ({ content }: { content: string }) =>
          useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
        { initialProps: { content: '' } },
      );
      act(() => rerender({ content: '= Hello' }));
    }).not.toThrow();
  });

  // scrollToLine null guard: no crash when scrollToLine changes but previewRef is null
  it('does not crash when scrollToLine changes but previewRef.current is null', () => {
    expect(() => {
      const { rerender } = renderHook(
        ({ scrollToLine }: { scrollToLine: { line: number } | null }) =>
          useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine }),
        { initialProps: { scrollToLine: null as { line: number } | null } },
      );
      act(() => rerender({ scrollToLine: { line: 5 } }));
    }).not.toThrow();
  });

  // scroll: no match even in querySelectorAll returns — target stays null, no crash
  it('does not crash when no elements match data-source-line', () => {
    const mockQuerySelector = jest.fn().mockReturnValue(null);
    const mockQuerySelectorAll = jest.fn().mockReturnValue([]);

    const { result, rerender } = renderHook(
      ({ scrollToLine }: { scrollToLine: { line: number } | null }) =>
        useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine }),
      { initialProps: { scrollToLine: null as { line: number } | null } },
    );

    const div = document.createElement('div');
    Object.defineProperty(div, 'querySelector', { value: mockQuerySelector, configurable: true });
    Object.defineProperty(div, 'querySelectorAll', { value: mockQuerySelectorAll, configurable: true });
    Object.assign(result.current.previewRef, { current: div });

    expect(() => {
      act(() => rerender({ scrollToLine: { line: 99 } }));
    }).not.toThrow();
  });

  // result.ok false with html=null goes to error branch, not up-to-date
  it('goes to error state when ok=true but html=null', () => {
    const { result } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Hello' } },
    );

    act(() => jest.advanceTimersByTime(200));
    // result.ok=true but html=null → should NOT set up-to-date
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: null, error: 'unexpected null' }));
    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('unexpected null');
  });

  // (i) DOMPurify.sanitize is called; script tags are stripped from stored html
  it('sanitizes worker HTML through DOMPurify before storing', () => {
    const { result } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Hello' } },
    );

    act(() => jest.advanceTimersByTime(200));
    const rawHtml = '<h1>Hello</h1><script>alert(1)</script>';
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: rawHtml, error: null }));

    // Same sanitizer, same profile, same allow-list — asked for nodes, because handing the markup back
    // as a string is the parse (and the second route to the DOM) this hook no longer has.
    expect(mockSanitize).toHaveBeenCalledWith(rawHtml, {
      USE_PROFILES: { html: true },
      RETURN_DOM_FRAGMENT: true,
    });
    expect(result.current.html).not.toContain('<script>');
    expect(result.current.html).toContain('<h1>Hello</h1>');
  });

  // The engine is shared and expensive to start, so it is not the hook's to destroy. An earlier
  // version of this test asserted the opposite — that unmounting terminated the worker — which is
  // precisely what made closing the panel, switching preview format or opening another file pay for a
  // fresh engine every time.
  it('leaves the shared engine running when the hook unmounts', () => {
    const { unmount } = renderHook(() =>
      useAsciidocPreview({ content: '= Hello', isEnabled: true, scrollToLine: null }),
    );
    const worker = lastWorker();

    unmount();

    expect(worker.terminate).not.toHaveBeenCalled();
  });

  // The point of not terminating: coming back is free. This is the file switch, the HTML↔PDF switch
  // and the panel close/reopen, all of which unmount and remount this hook.
  it('reuses the engine already running when the panel is mounted again', () => {
    const { unmount } = renderHook(() =>
      useAsciidocPreview({ content: '= Hello', isEnabled: true, scrollToLine: null }),
    );
    unmount();

    renderHook(() => useAsciidocPreview({ content: '= Hello again', isEnabled: true, scrollToLine: null }));

    expect(mockSpawnRenderWorker).toHaveBeenCalledTimes(1);
    expect(MockWorker.instances).toHaveLength(1);
  });

  // querySelectorAll must be called with the exact '[data-source-line]' attribute selector (kills L147)
  it('querySelectorAll is called with exactly "[data-source-line]" when no exact querySelector match', () => {
    const mockQuerySelectorAll = jest.fn().mockReturnValue([]);
    const mockQuerySelector = jest.fn().mockReturnValue(null);

    const { result, rerender } = renderHook(
      ({ scrollToLine }: { scrollToLine: { line: number } | null }) =>
        useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine }),
      { initialProps: { scrollToLine: null as { line: number } | null } },
    );

    const div = document.createElement('div');
    Object.defineProperty(div, 'querySelector', { value: mockQuerySelector, configurable: true });
    Object.defineProperty(div, 'querySelectorAll', { value: mockQuerySelectorAll, configurable: true });
    Object.assign(result.current.previewRef, { current: div });

    act(() => rerender({ scrollToLine: { line: 10 } }));

    expect(mockQuerySelectorAll).toHaveBeenCalledWith('[data-source-line]');
  });

  // scroll fallback correctness: exactly one element scrolled, the nearest ≤ target (kills L152)
  it('scroll fallback picks element at line 3, not line 7, when target is line 5', () => {
    const mockScrollLine3 = jest.fn();
    const mockScrollLine7 = jest.fn();

    const element1 = document.createElement('p');
    element1.dataset['sourceLine'] = '1';

    const element3 = document.createElement('p');
    element3.dataset['sourceLine'] = '3';
    element3.scrollIntoView = mockScrollLine3;

    const element7 = document.createElement('p');
    element7.dataset['sourceLine'] = '7';
    element7.scrollIntoView = mockScrollLine7;

    const mockQuerySelector = jest.fn().mockReturnValue(null);
    const mockQuerySelectorAll = jest.fn().mockReturnValue([element1, element3, element7]);

    const { result, rerender } = renderHook(
      ({ scrollToLine }: { scrollToLine: { line: number } | null }) =>
        useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine }),
      { initialProps: { scrollToLine: null as { line: number } | null } },
    );

    const div = document.createElement('div');
    Object.defineProperty(div, 'querySelector', { value: mockQuerySelector, configurable: true });
    Object.defineProperty(div, 'querySelectorAll', { value: mockQuerySelectorAll, configurable: true });
    Object.assign(result.current.previewRef, { current: div });

    act(() => rerender({ scrollToLine: { line: 5 } }));

    expect(mockQuerySelectorAll).toHaveBeenCalledWith('[data-source-line]');
    // el3 (line=3) is the best: 3 ≤ 5 and 3 > 0; el7 (line=7) exceeds target
    expect(mockScrollLine3).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(mockScrollLine7).not.toHaveBeenCalled();
  });

  // L152 EqualityOperator: 'elementLine <= line' vs 'elementLine < line'
  // When elementLine === line (exact match exists in querySelectorAll but querySelector missed),
  // the ≤ check must still select that element.
  it('scroll fallback selects element at exact line when querySelector misses but querySelectorAll finds it', () => {
    const mockScrollExact = jest.fn();

    const elementExact = document.createElement('p');
    elementExact.dataset['sourceLine'] = '5';
    elementExact.scrollIntoView = mockScrollExact;

    const elementBefore = document.createElement('p');
    elementBefore.dataset['sourceLine'] = '3';

    const mockQuerySelector = jest.fn().mockReturnValue(null);
    const mockQuerySelectorAll = jest.fn().mockReturnValue([elementBefore, elementExact]);

    const { result, rerender } = renderHook(
      ({ scrollToLine }: { scrollToLine: { line: number } | null }) =>
        useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine }),
      { initialProps: { scrollToLine: null as { line: number } | null } },
    );

    const div = document.createElement('div');
    Object.defineProperty(div, 'querySelector', { value: mockQuerySelector, configurable: true });
    Object.defineProperty(div, 'querySelectorAll', { value: mockQuerySelectorAll, configurable: true });
    Object.assign(result.current.previewRef, { current: div });

    act(() => rerender({ scrollToLine: { line: 5 } }));

    // The exact-line element (line=5 ≤ 5) must win over elBefore (line=3)
    expect(mockScrollExact).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('scroll fallback picks the first of two elements sharing the same source line', () => {
    const scrollSpyFirst = jest.fn();
    const scrollSpySecond = jest.fn();

    const elementFirst = document.createElement('p');
    elementFirst.dataset['sourceLine'] = '5';
    elementFirst.scrollIntoView = scrollSpyFirst;

    const elementSecond = document.createElement('p');
    elementSecond.dataset['sourceLine'] = '5';
    elementSecond.scrollIntoView = scrollSpySecond;

    const mockQuerySelector = jest.fn().mockReturnValue(null);
    const mockQuerySelectorAll = jest.fn().mockReturnValue([elementFirst, elementSecond]);

    const { result, rerender } = renderHook(
      ({ scrollToLine }: { scrollToLine: { line: number } | null }) =>
        useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine }),
      { initialProps: { scrollToLine: null as { line: number } | null } },
    );

    const div = document.createElement('div');
    Object.defineProperty(div, 'querySelector', { value: mockQuerySelector, configurable: true });
    Object.defineProperty(div, 'querySelectorAll', { value: mockQuerySelectorAll, configurable: true });
    Object.assign(result.current.previewRef, { current: div });

    act(() => rerender({ scrollToLine: { line: 5 } }));

    // The first element (encountered first in iteration) must be selected since
    // the second element has the same line number and cannot beat it with strict >
    expect(scrollSpyFirst).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(scrollSpySecond).not.toHaveBeenCalled();
  });

  // The hook forwards the open file's inherited context (rootFileId/openFileId)
  // so the worker can resolve cross-document `{attr}` references rooted at the project main file.
  it('forwards rootFileId and openFileId to the worker', () => {
    renderHook(() =>
      useAsciidocPreview({
        content: '{productName}',
        isEnabled: true,
        scrollToLine: null,
        rootFileId: 'main.adoc',
        openFileId: 'child.adoc',
        getFiles: () => ({ 'main.adoc': ':productName: Acme\n\ninclude::child.adoc[]\n', 'child.adoc': '{productName}' }),
      }),
    );
    act(() => jest.advanceTimersByTime(200));
    const message = lastWorker().postMessage.mock.calls[0][0];
    expect(message.rootFileId).toBe('main.adoc');
    expect(message.openFileId).toBe('child.adoc');
    expect(message.files).toMatchObject({ 'main.adoc': expect.any(String) });
  });

  // Live re-resolution: when the parent's content changes (so the inherited value changes), the hook
  // re-posts a fresh RenderRequest carrying the updated files snapshot.
  it('re-posts to the worker (live) when the files snapshot changes the inherited context', () => {
    let parentValue = 'Acme';
    const { rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({
          content,
          isEnabled: true,
          scrollToLine: null,
          rootFileId: 'main.adoc',
          openFileId: 'child.adoc',
          getFiles: () => ({
            'main.adoc': `:productName: ${parentValue}\n\ninclude::child.adoc[]\n`,
            'child.adoc': '{productName}',
          }),
        }),
      { initialProps: { content: '{productName}' } },
    );
    act(() => jest.advanceTimersByTime(200));
    expect(lastWorker().postMessage.mock.calls[0][0].files['main.adoc']).toContain('Acme');

    // Parent edits the value; the open child re-renders and re-posts the fresh snapshot.
    parentValue = 'Globex';
    act(() => rerender({ content: '{productName} ' })); // content nudge stands in for the live edit
    act(() => jest.advanceTimersByTime(200));
    const lastCall = lastWorker().postMessage.mock.calls.at(-1)?.[0];
    expect(lastCall.files['main.adoc']).toContain('Globex');
  });

  // Live conditional re-evaluation: toggling a gating attribute in the main file
  // re-posts the assembler inputs (openFileId + the fresh files snapshot) so the worker re-assembles and
  // the include-gating decision is recomputed. The assembler (unit-tested) performs the gating; the
  // hook only needs to keep feeding it the current snapshot on each debounced edit.
  it('re-posts openFileId + the fresh files snapshot when a gating attribute toggles (live conditional re-eval)', () => {
    let flag = ':flag:\n';
    const main = () => `= Book\n${flag}\nifdef::flag[]\ninclude::ch.adoc[]\nendif::[]\n`;
    const { rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({
          content,
          isEnabled: true,
          scrollToLine: null,
          mainPath: 'main.adoc',
          openFileId: 'main.adoc',
          getFiles: () => ({ 'main.adoc': main(), 'ch.adoc': '== Chapter\n' }),
        }),
      { initialProps: { content: '= Book' } },
    );
    act(() => jest.advanceTimersByTime(200));
    expect(lastWorker().postMessage.mock.calls[0][0].files['main.adoc']).toContain('ifdef::flag[]');

    // Unset the flag in the main file; the next debounced render re-posts the fresh snapshot so the
    // assembler re-evaluates the conditional and skips the include.
    flag = ':flag!:\n';
    act(() => rerender({ content: '= Book ' })); // content nudge stands in for the live edit
    act(() => jest.advanceTimersByTime(200));
    const lastCall = lastWorker().postMessage.mock.calls.at(-1)?.[0];
    expect(lastCall.openFileId).toBe('main.adoc');
    expect(lastCall.files['main.adoc']).toContain(':flag!:');
  });

  // diagramsPresent gating: mirrors mathPresent — the hook exposes the worker's flag so a consumer
  // can lazy-load the heavy diagram engines (mermaid/vega/graphviz) only when a diagram is present.
  it('exposes diagramsPresent=true when the worker reports a diagram placeholder', () => {
    const { result } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '[mermaid]\n----\ngraph TD; A-->B\n----\n' } },
    );

    act(() => jest.advanceTimersByTime(200));
    act(() =>
      lastWorker().emit({
        requestId: 1,
        ok: true,
        html: '<div class="adc-diagram"></div>',
        error: null,
        diagramsPresent: true,
      }),
    );
    expect(result.current.diagramsPresent).toBe(true);
  });

  it('exposes diagramsPresent=false when the worker omits the flag', () => {
    const { result } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Doc' } },
    );

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null }));
    expect(result.current.diagramsPresent).toBe(false);
  });

  it('flips diagramsPresent as a document gains then loses a diagram across re-renders', () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Doc' } },
    );

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null, diagramsPresent: false }));
    expect(result.current.diagramsPresent).toBe(false);

    // Document gains a diagram
    act(() => rerender({ content: '[mermaid]\n----\ngraph TD; A-->B\n----\n' }));
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 2, ok: true, html: '<div class="adc-diagram"></div>', error: null, diagramsPresent: true }));
    expect(result.current.diagramsPresent).toBe(true);

    // Document loses the diagram again
    act(() => rerender({ content: '= Doc again' }));
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 3, ok: true, html: '<h1>Doc again</h1>', error: null, diagramsPresent: false }));
    expect(result.current.diagramsPresent).toBe(false);
  });

  it('forwards imagesDir to the worker as the image base path', () => {
    renderHook(() =>
      useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine: null, imagesDir: 'https://api/projects/p1/images' }),
    );
    act(() => jest.advanceTimersByTime(200));
    expect(lastWorker().postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '= Doc', imagesDir: 'https://api/projects/p1/images' }),
    );
  });
});

// ── useAsciidocPreview — showIncludes generalized root (029) ────────────

describe('useAsciidocPreview — showIncludes generalized root (029)', () => {
  // showIncludes is forwarded in the RenderRequest
  // Fails until: (1) UseAsciidocPreviewOptions gains `showIncludes?: boolean`
  //              (2) the hook reads it and includes it in postMessage
  it('includes showIncludes:false in the worker RenderRequest when the option is false', () => {
    renderHook(() =>
      useAsciidocPreview({
        content: '= Root\n\ninclude::child.adoc[]\n',
        isEnabled: true,
        scrollToLine: null,
        // @ts-expect-error — showIncludes not yet in UseAsciidocPreviewOptions
        showIncludes: false,
        openFileId: 'root.adoc',
        getFiles: () => ({ 'root.adoc': '= Root\n\ninclude::child.adoc[]\n', 'child.adoc': '== Child\n' }),
      }),
    );
    act(() => jest.advanceTimersByTime(200));
    const message = lastWorker().postMessage.mock.calls[0][0];
    expect(message.showIncludes).toBe(false);
  });

  // Assembly is rooted at the open file even when it is NOT the configured main file
  // Fails until the open==main gate is removed and it sends `files` + `openFileId` for any open file.
  it('sends files and openFileId in the RenderRequest even when openFileId differs from mainPath', () => {
    renderHook(() =>
      useAsciidocPreview({
        content: '== Child\n\nSome content.\n',
        isEnabled: true,
        scrollToLine: null,
        mainPath: 'root.adoc',
        openFileId: 'child.adoc',          // open file is NOT the main file
        getFiles: () => ({
          'root.adoc': '= Root\n\ninclude::child.adoc[]\n',
          'child.adoc': '== Child\n\nSome content.\n',
        }),
      }),
    );
    act(() => jest.advanceTimersByTime(200));
    const message = lastWorker().postMessage.mock.calls[0][0];
    // The worker must receive the files snapshot so the open child can be assembled
    expect(message.files).toBeDefined();
    expect(message.files).toMatchObject({ 'child.adoc': expect.any(String) });
    // The open file id must be forwarded so the worker roots assembly there
    expect(message.openFileId).toBe('child.adoc');
    // mainPath from the project config must NOT appear (the root is the open file, not the main)
    expect(message.mainPath).toBeUndefined();
  });

  // The live content prop is used for the open file (not the stale snapshot copy)
  // Fails until the hook's `content` prop (the live editor buffer) is what the worker
  // renders for the open file, overriding whatever `files[openFileId]` contains.
  it('uses the live content prop for the open file root, not the stale snapshot value', () => {
    const staleContentInSnapshot = '== Child\n\nSTALE content from snapshot.\n';
    const liveContent = '== Child\n\nLIVE content from editor buffer.\n';

    renderHook(() =>
      useAsciidocPreview({
        content: liveContent,
        isEnabled: true,
        scrollToLine: null,
        openFileId: 'child.adoc',
        getFiles: () => ({
          'root.adoc': '= Root\n\ninclude::child.adoc[]\n',
          // The snapshot has stale content for the open file — the hook must use content prop instead
          'child.adoc': staleContentInSnapshot,
        }),
      }),
    );
    act(() => jest.advanceTimersByTime(200));
    const message = lastWorker().postMessage.mock.calls[0][0];
    // The `content` field in the RenderRequest must be the live prop, not the snapshot copy
    expect(message.content).toBe(liveContent);
    expect(message.content).not.toBe(staleContentInSnapshot);
  });
});

// ── useAsciidocPreview — live re-render on showIncludes change (029) ────

describe('useAsciidocPreview — live re-render on showIncludes change', () => {
  // Changing `showIncludes` triggers a new render request (no content edit needed).
  // This is a GREEN test — showIncludes is already in the [mainPath, rootFileId, showIncludes]
  // effect dependencies, so the re-render fires automatically.
  it('triggers a new postMessage when showIncludes changes after an initial render', () => {
    const { rerender } = renderHook(
      ({ showIncludes }: { showIncludes: boolean | undefined }) =>
        useAsciidocPreview({
          content: '= Root\n\ninclude::child.adoc[]\n',
          isEnabled: true,
          scrollToLine: null,
          showIncludes,
          openFileId: 'root.adoc',
          getFiles: () => ({ 'root.adoc': '= Root\n\ninclude::child.adoc[]\n', 'child.adoc': '== Child\n' }),
        }),
      { initialProps: { showIncludes: undefined } },
    );

    // Debounce fires for the initial render
    act(() => jest.advanceTimersByTime(200));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);

    // Simulate the user toggling showIncludes (no content change)
    act(() => rerender({ showIncludes: false }));
    act(() => jest.advanceTimersByTime(200));

    // A NEW postMessage must have been sent — the preview re-renders live
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);
    expect(lastWorker().postMessage.mock.calls[1][0].showIncludes).toBe(false);
  });
});

// ── useAsciidocPreview — live re-render when a reachable included file changes ──

describe('useAsciidocPreview — live re-render on reachable-file change', () => {
  // A collaborator's live edit to an INCLUDED file (not the open file) changes the assembled preview
  // but leaves the open file's `content` prop, mainPath, and rootFileId untouched. The layout signals
  // the change by bumping `filesVersion`; the hook must re-post a render carrying the fresh snapshot so
  // the preview reflects the include's new heading level / content — matching the outline, which already
  // recomputes on the same signal.
  it('re-posts a render with the fresh snapshot when filesVersion bumps after an edit to an included file', () => {
    let childBody = '== Child\n';
    const { rerender } = renderHook(
      ({ filesVersion }: { filesVersion: number }) =>
        useAsciidocPreview({
          content: '= Root\n\ninclude::child.adoc[]\n',
          isEnabled: true,
          scrollToLine: null,
          openFileId: 'root.adoc',
          filesVersion,
          getFiles: () => ({ 'root.adoc': '= Root\n\ninclude::child.adoc[]\n', 'child.adoc': childBody }),
        }),
      { initialProps: { filesVersion: 0 } },
    );

    act(() => jest.advanceTimersByTime(200));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);
    expect(lastWorker().postMessage.mock.calls[0][0].files['child.adoc']).toBe('== Child\n');

    // A collaborator promotes the child heading a level (=== → ==, etc.); the layout refetches the
    // included file and bumps filesVersion. No open-file edit, no main-file change.
    childBody = '= Child\n';
    act(() => rerender({ filesVersion: 1 }));
    act(() => jest.advanceTimersByTime(200));

    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);
    expect(lastWorker().postMessage.mock.calls[1][0].files['child.adoc']).toBe('= Child\n');
  });
});

// ── useAsciidocPreview — reported render cost ────────────────────────────────

describe('useAsciidocPreview — reported render cost', () => {
  const timings = { parseMs: 4, convertMs: 18, postProcessMs: 3, totalMs: 27 };

  it('reports nothing before any render has completed', () => {
    const { result } = renderHook(() =>
      useAsciidocPreview({ content: '= Hello', isEnabled: true, scrollToLine: null }),
    );

    expect(result.current.timings).toBeNull();
  });

  it('reports what the completed render cost', () => {
    const { result } = renderHook(() =>
      useAsciidocPreview({ content: '= Hello', isEnabled: true, scrollToLine: null }),
    );

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Hello</h1>', error: null, timings }));

    expect(result.current.timings).toEqual(timings);
  });

  it('keeps the last successful figures when a later render fails', () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Hello' } },
    );

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Hello</h1>', error: null, timings }));

    // A failed render carries no breakdown; reporting zeros — or nothing — would read as a document
    // that suddenly became free to render, which is what the adaptive delay would then act on.
    act(() => rerender({ content: '= Hello\n\n[[' }));
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 2, ok: false, html: null, error: 'boom' }));

    expect(result.current.state).toBe('error');
    expect(result.current.timings).toEqual(timings);
  });
});

// ── useAsciidocPreview — the refresh delay follows the measured render cost ──

/** Figures of a document cheap enough that the derived delay lands well inside the fixed one. */
const cheapTimings = { parseMs: 6, convertMs: 5, postProcessMs: 3, totalMs: 15 };

/** What the schedule should wait after a render of {@link cheapTimings} cost. */
const derivedDelayMs = adaptiveDelayMs(cheapTimings.totalMs);

/**
 * Mount the preview, complete one render, and answer it with `result`.
 *
 * @param result - The worker reply to the first render, with or without figures of its own.
 * @returns The mounted harness, with the first render answered.
 */
function afterFirstRender(result: Record<string, unknown>) {
  const harness = renderHook(
    ({ content }: { content: string }) =>
      useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
    { initialProps: { content: '= Doc' } },
  );
  act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
  act(() => lastWorker().emit({ requestId: 1, html: '<h1>Doc</h1>', error: null, ...result }));
  return harness;
}

describe('useAsciidocPreview — refresh delay derived from the last render', () => {
  it('waits the fixed delay while nothing has been measured yet', () => {
    renderHook(() => useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine: null }));

    // Nothing has rendered, so there is no measurement to derive a delay from — and the absence of
    // one is answered with the fixed delay rather than with a guess about this document.
    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1));
    expect(lastWorker().postMessage).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(1));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);
  });

  it('refreshes sooner than the fixed delay once a cheap render has been measured', () => {
    const { rerender } = afterFirstRender({ ok: true, timings: cheapTimings });

    // A short document costs a fraction of the fixed delay to render, so waiting the whole of it
    // spends most of the pause on nothing.
    expect(derivedDelayMs).toBeLessThan(PREVIEW_DEBOUNCE_MS);

    act(() => rerender({ content: '= Doc edited' }));
    act(() => jest.advanceTimersByTime(derivedDelayMs));

    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);
    expect(lastWorker().postMessage.mock.calls[1][0].content).toBe('= Doc edited');
  });

  it('keeps waiting the fixed delay when nothing was measured on the first render', () => {
    // An engine that reports no figures leaves the schedule with no measurement, which is the same
    // state as before the first render — not "this document is free to render".
    const { rerender } = afterFirstRender({ ok: true });

    act(() => rerender({ content: '= Doc edited' }));
    act(() => jest.advanceTimersByTime(derivedDelayMs));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);

    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - derivedDelayMs));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);
  });

  it('leaves the shortened delay in place when a later render fails', () => {
    const { rerender } = afterFirstRender({ ok: true, timings: cheapTimings });

    // A syntax error typed mid-edit: the render fails and carries no figures at all. Treating that
    // as "no measurement" would put the delay back to the fixed one, so the preview an author was
    // getting in a fraction of a second would slow down the moment they typed a broken construct —
    // and stay slow until they happened to fix it. The last successful measurement still describes
    // this document, so it is what the schedule keeps using.
    act(() => rerender({ content: '= Doc\n\n[[' }));
    act(() => jest.advanceTimersByTime(derivedDelayMs));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);
    act(() => lastWorker().emit({ requestId: 2, ok: false, html: null, error: 'parse error' }));

    act(() => rerender({ content: '= Doc\n\n[[]]' }));
    act(() => jest.advanceTimersByTime(derivedDelayMs));

    expect(lastWorker().postMessage).toHaveBeenCalledTimes(3);
  });

  it('lengthens the delay again when the document becomes expensive to render', () => {
    const { rerender } = afterFirstRender({ ok: true, timings: cheapTimings });

    // The author pastes in a document that costs more than half the fixed delay to render. Doubling
    // that exceeds the ceiling, so the delay goes back to the fixed one rather than past it.
    act(() => rerender({ content: '= Doc grown' }));
    act(() => jest.advanceTimersByTime(derivedDelayMs));
    act(() =>
      lastWorker().emit({
        requestId: 2,
        ok: true,
        html: '<h1>Doc grown</h1>',
        error: null,
        timings: { parseMs: 300, convertMs: 60, postProcessMs: 40, totalMs: 420 },
      }),
    );

    act(() => rerender({ content: '= Doc grown further' }));
    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);

    act(() => jest.advanceTimersByTime(1));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(3);
  });
});

// ── useAsciidocPreview — refreshing while typing never pauses ────────────────

describe('useAsciidocPreview — refresh while typing without pause', () => {
  it('refreshes once the maximum wait elapses even though typing never pauses', () => {
    const { rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Doc' } },
    );

    const typed = typeWithoutPausing(PREVIEW_MAX_WAIT_MS + KEYSTROKE_INTERVAL_MS, (documentText) =>
      rerender({ content: documentText }),
    );

    // The trailing delay never came due, so this render exists only because the cap forced it.
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);
    const posted: string = lastWorker().postMessage.mock.calls[0][0].content;
    // It carried an edit made during the burst, not the value the hook mounted with.
    expect(typed.startsWith(posted)).toBe(true);
    expect(posted).not.toBe('= Doc');
  });

  it('does not start a second render while the first is still in flight', () => {
    const { rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Doc' } },
    );

    // Two whole cap windows of uninterrupted typing, with the worker never answering the first
    // render: the second expiry must be held back rather than stacked on the render still running.
    typeWithoutPausing(PREVIEW_MAX_WAIT_MS * 2 + KEYSTROKE_INTERVAL_MS, (documentText) =>
      rerender({ content: documentText }),
    );

    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);
  });

  it('runs the refresh the cap held back once the in-flight render finishes', () => {
    const { rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Doc' } },
    );

    typeWithoutPausing(PREVIEW_MAX_WAIT_MS * 2 + KEYSTROKE_INTERVAL_MS, (documentText) =>
      rerender({ content: documentText }),
    );
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);

    // No timer advance after the result: the held-back refresh is already owed, so it must run at
    // once instead of the guarantee silently lapsing for the rest of the session.
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<p>x</p>', error: null }));

    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);
  });

  it('releases the held-back refresh when the in-flight render finishes with an error', () => {
    const { rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Doc' } },
    );

    typeWithoutPausing(PREVIEW_MAX_WAIT_MS * 2 + KEYSTROKE_INTERVAL_MS, (documentText) =>
      rerender({ content: documentText }),
    );
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);

    // A failed render is a finished render: it frees the worker exactly like a successful one, and
    // treating it otherwise would suppress every later refresh for as long as the document is broken.
    act(() => lastWorker().emit({ requestId: 1, ok: false, html: null, error: 'parse error' }));

    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps the refresh held back when a superseded render reports back', () => {
    const { rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Doc' } },
    );

    // The cap forces the first render mid-burst…
    typeWithoutPausing(PREVIEW_MAX_WAIT_MS + KEYSTROKE_INTERVAL_MS, (documentText) =>
      rerender({ content: documentText }),
    );
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);

    // …then typing stops and the trailing delay posts a second render, superseding the first.
    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);

    // The first render's late result is discarded as stale, so it says nothing about the render that
    // IS in flight: the cap stays held and another burst adds no third render.
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<p>stale</p>', error: null }));
    typeWithoutPausing(PREVIEW_MAX_WAIT_MS + KEYSTROKE_INTERVAL_MS, (documentText) =>
      rerender({ content: documentText }),
    );
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);

    // Only the current render finishing releases it.
    act(() => lastWorker().emit({ requestId: 2, ok: true, html: '<p>fresh</p>', error: null }));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(3);
  });

  it('cancels the pending refresh when the hook unmounts', () => {
    const { unmount } = renderHook(() =>
      useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine: null }),
    );
    const worker = lastWorker();

    // A render is scheduled but neither timer has come due yet.
    expect(worker.postMessage).not.toHaveBeenCalled();

    unmount();
    // Long enough for both the trailing timer and the cap to have come due had they survived. Stated
    // as "nothing is posted" rather than "no timers remain": the shared engine's own retention timer
    // is armed by the unmount and is none of this hook's business.
    jest.advanceTimersByTime(PREVIEW_MAX_WAIT_MS * 2);

    expect(worker.postMessage).not.toHaveBeenCalled();
  });
});

// ── useAsciidocPreview — opening a different file ────────────────────────────

/** The two files the reader switches between, as the layout would supply them. */
const switchedProjectFiles = () => ({ 'first.adoc': '= First', 'second.adoc': '= Second' });

/**
 * Mount the preview on one file, render it, and answer that render.
 *
 * @returns The mounted harness, ready for a rerender that opens the other file.
 */
function previewingFirstFile() {
  const harness = renderHook(
    ({ content, openFileId }: { content: string; openFileId: string }) =>
      useAsciidocPreview({
        content,
        isEnabled: true,
        scrollToLine: null,
        openFileId,
        getFiles: switchedProjectFiles,
      }),
    { initialProps: { content: '= First', openFileId: 'first.adoc' } },
  );
  act(() => jest.advanceTimersByTime(200));
  act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>First</h1>', error: null }));
  return harness;
}

/**
 * Attach a scroll container to the preview and report its offset, so a test can state where the
 * reader is looking before and after a switch.
 *
 * @param previewReference - The hook's scroll-container ref.
 * @param initialOffset - How far down the previous document the reader had scrolled.
 * @returns A reader for the container's current scroll offset.
 */
function trackScrollOffset(
  previewReference: React.RefObject<HTMLDivElement | null>,
  initialOffset: number,
): () => number {
  const scrollContainer = document.createElement('div');
  let offset = initialOffset;
  Object.defineProperty(scrollContainer, 'scrollTop', {
    get: () => offset,
    set: (value: number) => { offset = value; },
    configurable: true,
  });
  Object.assign(previewReference, { current: scrollContainer });
  return () => offset;
}

describe('useAsciidocPreview — opening a different file', () => {
  it('renders the newly opened file without waiting out the trailing delay', () => {
    const { rerender } = previewingFirstFile();
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);

    // No timer is advanced after the switch: the delay is there to absorb typing, and opening a file
    // is not typing. Waiting it out would show the previous document for the whole delay.
    act(() => rerender({ content: '= Second', openFileId: 'second.adoc' }));

    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);
    const posted = lastWorker().postMessage.mock.calls[1][0];
    expect(posted.content).toBe('= Second');
    expect(posted.openFileId).toBe('second.adoc');
  });

  it('keeps the previous file on screen, marked as rendering, until the new one is ready', () => {
    const { result, rerender } = previewingFirstFile();
    expect(result.current.html).toBe('<h1>First</h1>');

    act(() => rerender({ content: '= Second', openFileId: 'second.adoc' }));

    // Blanking here would say the panel has nothing to show, when it is a moment from showing the new
    // document; the indicator is what tells the reader the change is on its way.
    expect(result.current.html).toBe('<h1>First</h1>');
    expect(result.current.state).toBe('rendering');

    act(() => lastWorker().emit({ requestId: 2, ok: true, html: '<h1>Second</h1>', error: null }));
    expect(result.current.html).toBe('<h1>Second</h1>');
    expect(result.current.state).toBe('up-to-date');
  });

  it('returns the preview to the top of the newly opened document', () => {
    const { result, rerender } = previewingFirstFile();
    const scrollOffset = trackScrollOffset(result.current.previewRef, 640);

    act(() => rerender({ content: '= Second', openFileId: 'second.adoc' }));

    // Carrying the previous file's offset over drops the reader at an arbitrary point in a document
    // they have not seen.
    expect(scrollOffset()).toBe(0);
  });

  it('leaves the scroll position alone while the same file is edited', () => {
    const { result, rerender } = previewingFirstFile();
    const scrollOffset = trackScrollOffset(result.current.previewRef, 640);

    act(() => rerender({ content: '= First edited', openFileId: 'first.adoc' }));
    act(() => jest.advanceTimersByTime(200));

    // Typing must not throw the reader back to the top of the document they are working in.
    expect(scrollOffset()).toBe(640);
  });

  it('discards the previous file\'s render when it arrives after the switch', () => {
    const { result, rerender } = renderHook(
      ({ content, openFileId }: { content: string; openFileId: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null, openFileId }),
      { initialProps: { content: '= First', openFileId: 'first.adoc' } },
    );
    // The first file's render is posted and still unanswered when the reader opens another file.
    act(() => jest.advanceTimersByTime(200));
    act(() => rerender({ content: '= Second', openFileId: 'second.adoc' }));

    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>First</h1>', error: null }));

    // Committing it would put the file the reader just left on screen as though it were the one they
    // opened.
    expect(result.current.html).toBeNull();
    expect(result.current.state).toBe('rendering');

    act(() => lastWorker().emit({ requestId: 2, ok: true, html: '<h1>Second</h1>', error: null }));
    expect(result.current.html).toBe('<h1>Second</h1>');
  });
});

// ── useAsciidocPreview — the engine giving up ────────────────────────────────

describe('useAsciidocPreview — engine failure', () => {
  it('reports nothing wrong while the engine is being rebuilt within its budget', () => {
    const { result } = renderHook(() =>
      useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine: null }),
    );
    act(() => jest.advanceTimersByTime(200));

    for (let death = 0; death < MAX_ENGINE_REBUILDS; death += 1) {
      act(() => lastWorker().die());
    }

    // Every one of those was answered with a replacement that replayed the outstanding render, so
    // there is nothing for the author to do and nothing to tell them.
    expect(result.current.engineFailed).toBe(false);
  });

  it('reports the engine down once the rebuild budget is spent, and renders again on retry', () => {
    const { result } = renderHook(() =>
      useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine: null }),
    );
    act(() => jest.advanceTimersByTime(200));

    // One death past the budget: this is the document that kills the engine every time.
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      act(() => lastWorker().die());
    }
    expect(result.current.engineFailed).toBe(true);

    act(() => result.current.retryEngine());

    expect(result.current.engineFailed).toBe(false);
    // The render that was outstanding is replayed on the new engine, so the preview catches up by
    // itself instead of waiting for the author to type something.
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);
    expect(lastWorker().postMessage.mock.calls[0][0].content).toBe('= Doc');
  });

  it('stops claiming a render is under way once the engine has given up', () => {
    const { result } = renderHook(() =>
      useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine: null }),
    );
    act(() => jest.advanceTimersByTime(200));
    expect(result.current.state).toBe('rendering');

    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      act(() => lastWorker().die());
    }

    // The render in flight died with the engine and nothing will ever answer it. Left saying
    // "rendering", the sync indicator pulses for the rest of the session behind the failure notice —
    // telling the reader the preview is catching up when nothing is coming.
    expect(result.current.state).toBe('error');

    // The engine is shared module state that outlives this test, and an engine left given up on stays
    // given up on — unmounting is not evidence it would start this time. Hand the next test a working
    // one, exactly as the tests below that kill it do.
    act(() => result.current.retryEngine());
  });

  it('does not claim a render is under way for one posted while the engine is down', () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Doc' } },
    );
    act(() => jest.advanceTimersByTime(200));
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      act(() => lastWorker().die());
    }

    // Editing while the engine is down still schedules a refresh, and the holder still records it as
    // the render to replay on retry — but there is no engine to run it, so saying it is under way
    // would restart the same false pulse the failure above ended.
    act(() => rerender({ content: '= Doc edited' }));
    act(() => jest.advanceTimersByTime(200));

    expect(result.current.state).toBe('error');

    // See above: the shared engine has to be given back in working order.
    act(() => result.current.retryEngine());
  });

  it('says a render is under way again once the author asks for another engine', () => {
    const { result } = renderHook(() =>
      useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine: null }),
    );
    act(() => jest.advanceTimersByTime(200));
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      act(() => lastWorker().die());
    }

    act(() => result.current.retryEngine());

    // The retry replays the outstanding render on the new engine, so one genuinely is under way.
    expect(result.current.state).toBe('rendering');

    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null }));
    expect(result.current.state).toBe('up-to-date');
  });

  it('serialises the refresh after a retry behind the render the retry put back in flight', () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '= Doc' } },
    );
    act(() => jest.advanceTimersByTime(200));

    // The engine dies with a render in flight. Nothing will ever report that render finished, so the
    // cap must not be left believing one is still running — it would suppress every later refresh.
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      act(() => lastWorker().die());
    }
    act(() => result.current.retryEngine());
    const revived = lastWorker();

    typeWithoutPausing(PREVIEW_MAX_WAIT_MS + KEYSTROKE_INTERVAL_MS, (documentText) =>
      rerender({ content: documentText }),
    );

    // The replay is a render genuinely under way on a live engine, so the cap holds its forced
    // refresh back rather than stacking a second render on it — the same treatment it gives a render
    // the schedule posted. Left unreported, the cap would fire into the replay and the author would
    // pay for two renders of a document only one of them describes.
    expect(revived.postMessage).toHaveBeenCalledTimes(1);

    // Held, though, not lost — which is the difference between pacing the refresh and retiring it.
    // The replay reporting back releases it at once, without waiting out another burst window.
    act(() => revived.emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null }));
    expect(revived.postMessage).toHaveBeenCalledTimes(2);
  });

  it('leaves the cap running when a retry had nothing of ours to replay', () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) =>
        useAsciidocPreview({ content, isEnabled: true, scrollToLine: null }),
      { initialProps: { content: '' } },
    );
    // The engine dies before this panel has posted anything at all, so the retry starts an engine but
    // replays nothing. What is pinned here is that the announcement stays CONDITIONAL: told a render
    // is under way when none is, the cap would wait on a completion nothing is ever going to report
    // and suppress every refresh after it — so the burst below would go out unrendered.
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      act(() => lastWorker().die());
    }
    act(() => result.current.retryEngine());
    const revived = lastWorker();

    typeWithoutPausing(PREVIEW_MAX_WAIT_MS + KEYSTROKE_INTERVAL_MS, (documentText) =>
      rerender({ content: documentText }),
    );

    expect(revived.postMessage).toHaveBeenCalledTimes(1);
  });

  it('clears the error state when a retry brings the engine back with nothing to replay', () => {
    const { result } = renderHook(() =>
      useAsciidocPreview({ content: '', isEnabled: true, scrollToLine: null }),
    );
    // An empty file: nothing is worth rendering, so nothing was ever posted. The engine dies anyway —
    // it starts up for the panel, not for a document — and the author presses the retry.
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      act(() => lastWorker().die());
    }
    expect(result.current.state).toBe('error');

    act(() => result.current.retryEngine());

    // The engine IS back, and the notice offering the retry is gone with it. Left in `error` the panel
    // would keep saying "Preview error" with no message under it and nothing to press, until the
    // author happened to type.
    expect(result.current.engineFailed).toBe(false);
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('leaves the failure notice up for a retry that did nothing', () => {
    const { result } = renderHook(() =>
      useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine: null }),
    );
    act(() => jest.advanceTimersByTime(200));
    for (let death = 0; death <= MAX_ENGINE_REBUILDS; death += 1) {
      act(() => lastWorker().die());
    }
    act(() => result.current.retryEngine());
    expect(result.current.engineFailed).toBe(false);

    // A second press — on a notice already acted on, which is an ordinary double-click. The holder
    // refuses it because the engine is healthy, so nothing was rebuilt and nothing must be claimed.
    act(() => result.current.retryEngine());

    expect(result.current.state).toBe('rendering');
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);
  });
});

// ── useAsciidocPreview — putting the render on screen ────────────────────────

/**
 * Attach an output element to the hook, the way the preview panel does.
 *
 * The panel mounts this element before anything has been rendered, precisely so the first render has
 * somewhere to be committed to; a test that attached it later would be testing a panel nobody ships.
 *
 * @param outputReference - The hook's output ref.
 * @returns The attached element, to read the committed document back out of.
 */
function attachOutputElement(outputReference: React.RefObject<HTMLDivElement | null>): HTMLDivElement {
  const output = document.createElement('div');
  Object.assign(outputReference, { current: output });
  return output;
}

/**
 * Mount the preview with an output element already attached, and answer nothing yet.
 *
 * @param content - The document to preview.
 * @returns The harness and the element the hook will commit into.
 */
function previewingInto(content: string) {
  const harness = renderHook(
    ({ text }: { text: string }) =>
      useAsciidocPreview({ content: text, isEnabled: true, scrollToLine: null }),
    { initialProps: { text: content } },
  );
  const output = attachOutputElement(harness.result.current.outputRef);
  return { ...harness, output };
}

describe('useAsciidocPreview — putting the render on screen', () => {
  it('commits the render into the output element it was given', () => {
    const { output } = previewingInto('= Doc');

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null }));

    expect(output.innerHTML).toBe('<h1>Doc</h1>');
  });

  it('patches the displayed document rather than replacing it', () => {
    const { output, rerender } = previewingInto('= Doc');
    act(() => jest.advanceTimersByTime(200));
    act(() =>
      lastWorker().emit({
        requestId: 1,
        ok: true,
        html: '<p id="one">First</p><p id="two">Second</p>',
        error: null,
      }),
    );
    const untouched = output.querySelector('#two');

    // Only the first paragraph changes. If the panel were still publishing by replacing its contents,
    // every node below would be a new one — and everything the client had put in them (a drawn
    // diagram, a typeset expression, the focused element) would have gone with the old ones.
    act(() => rerender({ text: '= Doc edited' }));
    act(() => jest.advanceTimersByTime(200));
    act(() =>
      lastWorker().emit({
        requestId: 2,
        ok: true,
        html: '<p id="one">First edited</p><p id="two">Second</p>',
        error: null,
      }),
    );

    expect(output.querySelector('#one')?.textContent).toBe('First edited');
    expect(output.querySelector('#two')).toBe(untouched);
  });

  it('sanitizes before anything reaches the output element', () => {
    const { output } = previewingInto('= Doc');

    act(() => jest.advanceTimersByTime(200));
    act(() =>
      lastWorker().emit({
        requestId: 1,
        ok: true,
        html: '<h1>Doc</h1><script>alert(1)</script>',
        error: null,
      }),
    );

    // The hook is the only crossing from worker output to the screen, so this is where the whole
    // preview's safety is decided — the commit must never be reachable with unsanitized nodes.
    expect(output.querySelector('script')).toBeNull();
    expect(output.textContent).toContain('Doc');
  });

  it('never puts the render into the scroll container', () => {
    const { result, output } = previewingInto('= Doc');
    const scrollContainer = document.createElement('div');
    Object.assign(result.current.previewRef, { current: scrollContainer });

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null }));

    // The scroll container holds the reader's position and the panel's own chrome; the document goes
    // in the element scoped to it.
    expect(scrollContainer.innerHTML).toBe('');
    expect(output.innerHTML).toBe('<h1>Doc</h1>');
  });

  it('announces every commit, including one whose markup is unchanged', () => {
    const { result, rerender } = previewingInto('= Doc');
    expect(result.current.renderNonce).toBe(0);

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null }));
    const afterFirst = result.current.renderNonce;
    expect(afterFirst).toBeGreaterThan(0);

    // The same document rendered again. The markup is identical, so anything using it as a stand-in
    // for "something was committed" would conclude nothing happened — while a commit did happen, and
    // the passes that follow one (typesetting, drawing) have work to do.
    act(() => rerender({ text: '= Doc ' }));
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 2, ok: true, html: '<h1>Doc</h1>', error: null }));

    expect(result.current.renderNonce).toBe(afterFirst + 1);
  });

  it('announces nothing when the render fails', () => {
    const { result, rerender } = previewingInto('= Doc');
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null }));
    const afterFirst = result.current.renderNonce;

    // A failed render commits nothing: what is on screen is still the previous document, and the
    // passes that follow a commit have already run over it.
    act(() => rerender({ text: '= Doc\n\n[[' }));
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 2, ok: false, html: null, error: 'parse error' }));

    expect(result.current.renderNonce).toBe(afterFirst);
  });

  it('keeps the sanitized markup as the render identity alongside the commit', () => {
    const { result, output } = previewingInto('= Doc');

    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null }));

    // Reported as what was RENDERED, which is not the same as what is on screen: the client goes on to
    // draw diagrams and typeset expressions into the element, and none of that belongs to the render.
    expect(result.current.html).toBe('<h1>Doc</h1>');
    output.append(document.createElement('span'));
    expect(result.current.html).toBe('<h1>Doc</h1>');
  });

  it('renders with no output element attached rather than failing', () => {
    // The panel always attaches one, but the hook is mounted a moment before the element exists, and a
    // reply that arrived in that window must not take the preview down with it.
    const { result } = renderHook(() =>
      useAsciidocPreview({ content: '= Doc', isEnabled: true, scrollToLine: null }),
    );

    act(() => jest.advanceTimersByTime(200));
    expect(() =>
      act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null })),
    ).not.toThrow();

    expect(result.current.state).toBe('up-to-date');
    expect(result.current.renderNonce).toBe(0);
  });
});

// ── useAsciidocPreview — a document with nothing in it ───────────────────────

/**
 * Mount the preview on a file that has content, with an output element attached, and commit its
 * first render — the state every test below starts from, because the defect they cover is about what
 * happens to a document that is ALREADY on screen.
 *
 * @param content - The first file's source.
 * @returns The harness, plus the element the render was committed into.
 */
function showingFirstFile(content = '= First') {
  const harness = renderHook(
    ({ text, openFileId }: { text: string; openFileId: string }) =>
      useAsciidocPreview({
        content: text,
        isEnabled: true,
        scrollToLine: null,
        openFileId,
        // Present so each render states which file it is FOR: the hook forwards the open file's id
        // only when that file is in the snapshot, and the point of the tests below is which file's
        // document ends up on screen.
        getFiles: () => ({ 'first.adoc': content, 'second.adoc': '' }),
      }),
    { initialProps: { text: content, openFileId: 'first.adoc' } },
  );
  const output = attachOutputElement(harness.result.current.outputRef);
  act(() => jest.advanceTimersByTime(200));
  act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>First</h1>', error: null }));
  return { ...harness, output };
}

describe('useAsciidocPreview — a document with nothing in it', () => {
  it('empties the preview when the newly opened file has no content', () => {
    const { rerender, result, output } = showingFirstFile();
    expect(output.innerHTML).toBe('<h1>First</h1>');

    // Every new file is created empty, so this is the ordinary route to it: open the preview, add a
    // file, click it. The panel is not remounted per file, so nothing else takes the previous
    // document off screen — skipping the render leaves the file the reader just left on display
    // while the indicator reports the preview is up to date.
    act(() => rerender({ text: '', openFileId: 'second.adoc' }));
    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));

    const posted = lastWorker().postMessage.mock.calls.at(-1)?.[0];
    expect(posted.content).toBe('');
    expect(posted.openFileId).toBe('second.adoc');

    act(() => lastWorker().emit({ requestId: 2, ok: true, html: '', error: null }));
    expect(output.innerHTML).toBe('');
    expect(result.current.state).toBe('up-to-date');
  });

  it('empties the preview when the author deletes everything in the open file', () => {
    const { rerender, output } = showingFirstFile();

    // The same defect without a file switch: an empty buffer is a document that renders to nothing,
    // not an absence of one to render.
    act(() => rerender({ text: '', openFileId: 'first.adoc' }));
    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    act(() => lastWorker().emit({ requestId: 2, ok: true, html: '', error: null }));

    expect(output.innerHTML).toBe('');
  });

  it('renders once when the buffer is momentarily empty between two edits', () => {
    const { rerender } = showingFirstFile();
    const before = lastWorker().postMessage.mock.calls.length;

    // Select-all-and-retype empties the buffer for a keystroke. Rendering that emptiness would cost a
    // conversion and a blank frame for a state the author never meant to be in; the trailing delay
    // absorbs it exactly as it absorbs any other keystroke.
    act(() => rerender({ text: '', openFileId: 'first.adoc' }));
    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS / 2));
    act(() => rerender({ text: '= First, rewritten', openFileId: 'first.adoc' }));
    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));

    expect(lastWorker().postMessage.mock.calls).toHaveLength(before + 1);
    expect(lastWorker().postMessage.mock.calls.at(-1)?.[0].content).toBe('= First, rewritten');
  });

  it('leaves the previous document up while the newly opened file is still loading', () => {
    const { rerender, output } = showingFirstFile();
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);

    // The open file changes the instant it is clicked, while its content is still being fetched, so an
    // empty buffer here means "not arrived yet" as often as it means "an empty file" — and the two are
    // indistinguishable. So the switch schedules the empty render but does not force it: content that
    // arrives within the delay replaces it, and the reader never sees a blank in between.
    act(() => rerender({ text: '', openFileId: 'second.adoc' }));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(1);
    expect(output.innerHTML).toBe('<h1>First</h1>');

    // The content arrives: forced through at once, as a file switch always is.
    act(() => rerender({ text: '= Second', openFileId: 'second.adoc' }));
    expect(lastWorker().postMessage).toHaveBeenCalledTimes(2);
    expect(lastWorker().postMessage.mock.calls[1][0].content).toBe('= Second');

    act(() => lastWorker().emit({ requestId: 2, ok: true, html: '<h1>Second</h1>', error: null }));
    expect(output.innerHTML).toBe('<h1>Second</h1>');
  });

  it('renders nothing for an empty buffer before anything has ever been shown', () => {
    // The one case an empty document is not worth rendering: the output element is already empty, so
    // the render would change nothing on screen — and a file that has only just been opened is
    // routinely still loading. This is what keeps a mount from posting a wasted render of nothing.
    renderHook(() => useAsciidocPreview({ content: '', isEnabled: true, scrollToLine: null }));

    act(() => jest.advanceTimersByTime(PREVIEW_MAX_WAIT_MS * 2));

    expect(lastWorker().postMessage).not.toHaveBeenCalled();
  });
});

// ── useAsciidocPreview — the markup nobody reads ─────────────────────────────

/**
 * Count every read of `innerHTML` in the document while `body` runs.
 *
 * Serializing a whole rendered document is precisely what reading `innerHTML` off it does, so this
 * states the cost the commit path is not allowed to pay in the terms it is actually paid in. The
 * descriptor is put back whatever happens, because leaving a counting getter on `Element.prototype`
 * would follow every later test in the file.
 *
 * @param body - The work to measure.
 * @returns How many times `innerHTML` was read during it.
 */
function countInnerHtmlReads(body: () => void): number {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  const read = descriptor?.get;
  if (descriptor === undefined || read === undefined) throw new Error('innerHTML has no getter to count');
  let reads = 0;
  Object.defineProperty(Element.prototype, 'innerHTML', {
    ...descriptor,
    get(this: Element) {
      reads += 1;
      return read.call(this);
    },
  });
  try {
    body();
  } finally {
    Object.defineProperty(Element.prototype, 'innerHTML', descriptor);
  }
  return reads;
}

describe('useAsciidocPreview — the markup nobody reads', () => {
  it('serializes nothing while committing a render', () => {
    const { result } = previewingInto('= Doc');
    act(() => jest.advanceTimersByTime(200));

    // Nothing on screen depends on the render's markup — the panel commits by patching the DOM and
    // never destructures it — so producing it would be a whole-document serialization per refresh, on
    // the main thread this feature exists to unburden.
    const reads = countInnerHtmlReads(() => {
      act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null }));
    });

    expect(reads).toBe(0);
    expect(result.current.state).toBe('up-to-date');
  });

  it('produces the render identity on demand, and once however often it is read', () => {
    const { result } = previewingInto('= Doc');
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null }));
    mockSanitize.mockClear();

    expect(result.current.html).toBe('<h1>Doc</h1>');
    expect(result.current.html).toBe('<h1>Doc</h1>');

    // Deferred, not discarded — and remembered, so a reader that asks twice does not pay twice.
    expect(mockSanitize).toHaveBeenCalledTimes(1);
  });

  it('reports the markup of the latest render, not of the one before it', () => {
    const { result, rerender } = previewingInto('= Doc');
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 1, ok: true, html: '<h1>Doc</h1>', error: null }));
    expect(result.current.html).toBe('<h1>Doc</h1>');

    act(() => rerender({ text: '= Doc edited' }));
    act(() => jest.advanceTimersByTime(200));
    act(() => lastWorker().emit({ requestId: 2, ok: true, html: '<h1>Doc edited</h1>', error: null }));

    expect(result.current.html).toBe('<h1>Doc edited</h1>');
  });

  it('sanitizes the markup it hands out, exactly as it sanitizes what it commits', () => {
    const { result } = previewingInto('= Doc');
    act(() => jest.advanceTimersByTime(200));
    act(() =>
      lastWorker().emit({
        requestId: 1,
        ok: true,
        html: '<h1>Doc</h1><script>alert(1)</script>',
        error: null,
      }),
    );

    // Deferring the work must not defer the verdict: the markup is the render's identity and is read
    // by the export path, so an unsanitized string here would be a second, unguarded route out of the
    // worker's output.
    expect(result.current.html).toBe('<h1>Doc</h1>');
  });
});
