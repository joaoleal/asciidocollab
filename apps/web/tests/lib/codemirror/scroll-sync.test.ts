import { wireScrollSync } from '@/lib/codemirror/editor-dom-handlers';
import type { EditorView } from '@codemirror/view';

/**
 * A minimal fake {@link EditorView} exposing only what {@link wireScrollSync} touches: a scroll
 * container that records its listener (so a test can fire a synthetic scroll), plus the coordinate →
 * line resolution that always maps to line 3. Layout metrics are stubbed since jsdom has none.
 */
function makeView(): { view: EditorView; fireScroll: () => void; removed: () => boolean } {
  let listener: (() => void) | null = null;
  let removed = false;
  const view = {
    scrollDOM: {
      addEventListener: (_type: string, function_: () => void) => { listener = function_; },
      removeEventListener: () => { removed = true; },
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    },
    posAtCoords: () => 5,
    state: { doc: { lineAt: () => ({ number: 3 }) } },
  } as unknown as EditorView;
  return { view, fireScroll: () => listener?.(), removed: () => removed };
}

describe('wireScrollSync suppression', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('reports the top-of-viewport line on a scroll when not suppressed', () => {
    const onScrollLine = jest.fn();
    const { view, fireScroll } = makeView();
    const teardown = wireScrollSync(view, () => onScrollLine, () => false);

    fireScroll();
    jest.advanceTimersByTime(50);

    expect(onScrollLine).toHaveBeenCalledWith(3);
    teardown();
  });

  test('swallows the scroll emit while suppressed (a selection reveal is in flight)', () => {
    const onScrollLine = jest.fn();
    const { view, fireScroll } = makeView();
    let suppressed = true;
    const teardown = wireScrollSync(view, () => onScrollLine, () => suppressed);

    fireScroll();
    jest.advanceTimersByTime(50);
    expect(onScrollLine).not.toHaveBeenCalled();

    // Once the window elapses, a genuine user scroll syncs again.
    suppressed = false;
    fireScroll();
    jest.advanceTimersByTime(50);
    expect(onScrollLine).toHaveBeenCalledWith(3);

    teardown();
  });

  test('omitting the suppression predicate preserves the original always-emit behaviour', () => {
    const onScrollLine = jest.fn();
    const { view, fireScroll } = makeView();
    const teardown = wireScrollSync(view, () => onScrollLine);

    fireScroll();
    jest.advanceTimersByTime(50);

    expect(onScrollLine).toHaveBeenCalledWith(3);
    teardown();
  });
});
