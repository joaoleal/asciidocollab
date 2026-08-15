import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AsciiDocPreview } from '@/components/asciidoc-preview';
import type { PreviewStyleValue } from '@/components/preview-style-control';

jest.mock('@/hooks/use-asciidoc-preview', () => ({ useAsciidocPreview: jest.fn() }));
jest.mock('@/components/math/render-math', () => ({ renderMath: jest.fn(() => Promise.resolve()) }));

import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import { commitToPreviewOutput, previewHookResult } from '../helpers/preview-panel';

const mockUsePreview = useAsciidocPreview as jest.Mock;

// The page frame observes the pane, and jsdom has no ResizeObserver.
class MockResizeObserver {
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, value: MockResizeObserver });
});

beforeEach(() => mockUsePreview.mockReset());

/**
 * Render the panel under one style with a jump-to-source callback attached.
 *
 * @param markup - The rendered document to put on screen.
 * @param previewStyle - The style to select.
 * @param onNavigateToSource - The jump-to-source callback.
 * @returns The render harness.
 */
function renderPreview(
  markup: string,
  previewStyle: PreviewStyleValue,
  onNavigateToSource = jest.fn(),
) {
  mockUsePreview.mockReturnValue(previewHookResult({ state: 'up-to-date', renderNonce: 1 }));
  const harness = render(
    <AsciiDocPreview
      content="= Doc"
      isEnabled
      projectId="p1"
      scrollToLine={null}
      previewStyle={previewStyle}
      onPreviewStyleChange={jest.fn()}
      onNavigateToSource={onNavigateToSource}
    />,
  );
  commitToPreviewOutput(markup);
  return { ...harness, onNavigateToSource };
}

/** The overflow values that make an element a scroll container. */
const SCROLLS = new Set(['auto', 'scroll', 'overlay']);

/**
 * Whether an element asks for a scroll through its inline style.
 *
 * @param element - The element to inspect.
 * @returns True when `overflow`, `overflow-x` or `overflow-y` is set to a scrolling value inline.
 */
function scrollAskedForInline(element: HTMLElement): boolean {
  return (['overflow', 'overflow-x', 'overflow-y'] as const).some((property) =>
    SCROLLS.has(element.style.getPropertyValue(property)),
  );
}

/**
 * Whether an element asks for a scroll through a Tailwind utility class.
 *
 * @param element - The element to inspect.
 * @returns True when it carries an `overflow[-x|-y]-{auto,scroll}` class, at any responsive variant.
 */
function scrollAskedForByClass(element: HTMLElement): boolean {
  return [...element.classList].some((name) =>
    /(^|:)overflow(-[xy])?-(auto|scroll)$/.test(name),
  );
}

describe('what the page frame must not disturb', () => {
  test('switching styles does not remount the element the render lives in', () => {
    // The rendered document is patched into this element by the preview hook rather than rendered by
    // React, so a remount discards it — and nothing would put it back until the next render, which
    // for a document nobody is typing in never comes. The page frame's wrappers are therefore
    // present under every style, which is exactly what this asserts.
    const harness = renderPreview('<p id="b1" data-source-line="7">Body</p>', 'asciidocollab');
    const before = screen.getByTestId('asciidoc-output');

    harness.rerender(
      <AsciiDocPreview
        content="= Doc"
        isEnabled
        projectId="p1"
        scrollToLine={null}
        previewStyle="print"
        onPreviewStyleChange={jest.fn()}
      />,
    );

    const after = screen.getByTestId('asciidoc-output');
    expect(after).toBe(before);
    expect(after.innerHTML).toBe('<p id="b1" data-source-line="7">Body</p>');
  });

  test('clicking a block still reveals its source under the page frame', () => {
    const { container, onNavigateToSource } = renderPreview(
      '<p id="b1" data-source-line="7">Body</p>',
      'print',
    );
    fireEvent.click(container.querySelector('#b1')!);
    expect(onNavigateToSource).toHaveBeenCalledWith(7);
  });

  test('an internal cross-reference still scrolls to its target under the page frame', () => {
    // `scrollIntoView` is defined against the element's visual box, so it stays correct however the
    // page is scaled — which is why the scale transform needs no compensation here.
    const scrollSpy = jest.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollSpy;
    const { container, onNavigateToSource } = renderPreview(
      '<a id="lnk" href="#sec2" data-source-line="4">see</a><h2 id="sec2" data-source-line="9">S</h2>',
      'print',
    );
    fireEvent.click(container.querySelector('#lnk')!);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(onNavigateToSource).not.toHaveBeenCalled();
    HTMLElement.prototype.scrollIntoView = original;
  });

  test('finishing a selection drag inside the page still selects rather than navigates', () => {
    const { container, onNavigateToSource } = renderPreview(
      '<p id="b1" data-source-line="7">Body text to select</p>',
      'print',
    );
    const block = container.querySelector('#b1')!;
    // jsdom performs no hit testing, so the selection a drag would leave behind has to be stated.
    const selection = jest.spyOn(globalThis, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: block.firstChild,
      focusNode: block.firstChild,
      toString: () => 'Body text',
    } as unknown as Selection);

    fireEvent.click(block, { clientX: 120, clientY: 10, detail: 1 });
    expect(onNavigateToSource).not.toHaveBeenCalled();
    selection.mockRestore();
  });

  test('the page frame adds no scroll container of its own', () => {
    // One scrolling element in the pane is what keeps browser find, scroll sync and the scrollbar
    // all talking about the same thing. A wrapper that scrolled would give find somewhere to scroll
    // that the sync knows nothing about.
    //
    // Asserted over EVERY element in the pane and over both ways of asking for a scroll, because
    // this used to read `style.overflow` on two named elements — and the page frame's wrappers are
    // styled by Tailwind class, not by inline style, so the one way the frame could plausibly grow a
    // scroll container was the one way that was not being looked at. jsdom resolves no stylesheet,
    // so the class list has to be read directly.
    renderPreview('<p>Body</p>', 'print');
    const pane = screen.getByTestId('preview-scroll-container');
    const scrolling = [pane, ...pane.querySelectorAll<HTMLElement>('*')].filter(
      (element) => scrollAskedForInline(element) || scrollAskedForByClass(element),
    );
    expect(scrolling).toEqual([pane]);
    // …and the one that does scroll really is asking to: an empty list above would otherwise pass
    // for "no wrapper scrolls" while the pane had quietly stopped scrolling at all.
    expect(scrollAskedForByClass(pane)).toBe(true);
    // The two elements the page frame itself adds, named so a failure says which one grew a scroll.
    const viewport = screen.getByTestId('print-page-viewport');
    for (const element of [viewport, viewport.firstElementChild as HTMLElement]) {
      expect(scrollAskedForInline(element)).toBe(false);
      expect(scrollAskedForByClass(element)).toBe(false);
    }
  });
});
