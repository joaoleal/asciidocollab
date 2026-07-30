import { renderHook, act } from '@testing-library/react';
import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import DOMPurify from 'dompurify';

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

  emit(data: unknown) {
    for (const listener of this.messageListeners) {
      listener({ data } as MessageEvent);
    }
  }
}

// Mock the worker factory so tests never touch import.meta.url or the real worker file.
// jest.fn() allows spying on call counts; the implementation creates a MockWorker.
jest.mock('@/lib/create-render-worker', () => ({
  createRenderWorker: jest.fn(() => new MockWorker()),
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

jest.mock('dompurify', () => ({
  sanitize: jest.fn((html: string) => mockStripScriptTags(html)),
}));

// ── editor-config mock — fixed debounce so tests don't depend on env ─────────
jest.mock('@/lib/editor-config', () => ({
  ...jest.requireActual('@/lib/editor-config'),
  PREVIEW_DEBOUNCE_MS: 100,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function lastWorker() {
  return MockWorker.instances.at(-1)!;
}

const mockSanitize = DOMPurify.sanitize as jest.Mock;

import { createRenderWorker } from '@/lib/create-render-worker';
const mockCreateRenderWorker = createRenderWorker as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  MockWorker.instances = [];
  mockSanitize.mockClear();
  mockSanitize.mockImplementation((html: string) => mockStripScriptTags(html));
  mockCreateRenderWorker.mockClear();
  mockCreateRenderWorker.mockImplementation(() => new MockWorker());
});

afterEach(() => {
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

  // The worker is created via the createRenderWorker factory, not a hardcoded static path.
  // This ensures Next.js webpack bundles the worker with all dependencies (asciidoctor).
  it('creates the worker via the createRenderWorker factory', () => {
    renderHook(() => useAsciidocPreview({ content: '= Hello', isEnabled: true, scrollToLine: null }));
    expect(mockCreateRenderWorker).toHaveBeenCalledTimes(1);
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

    expect(mockSanitize).toHaveBeenCalledWith(rawHtml, { USE_PROFILES: { html: true } });
    expect(result.current.html).not.toContain('<script>');
    expect(result.current.html).toContain('<h1>Hello</h1>');
  });

  // terminate() must be called when the hook unmounts (kills L92 BlockStatement)
  it('calls worker.terminate() when the hook unmounts', () => {
    const { unmount } = renderHook(() =>
      useAsciidocPreview({ content: '= Hello', isEnabled: true, scrollToLine: null }),
    );
    const worker = lastWorker();
    expect(worker.terminate).not.toHaveBeenCalled();
    unmount();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
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
