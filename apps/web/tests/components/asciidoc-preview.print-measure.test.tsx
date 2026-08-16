/**
 * What the Print page frame measures with, and how often it rebuilds it.
 *
 * The frame keeps two measurements — how much width a page may occupy, and how tall the laid-out
 * page came out — and both come from one `ResizeObserver`. That observer used to be torn down and
 * built again after EVERY render, because the effect that owns it took the render nonce as a
 * dependency: the page's height is the document's height, and the document changes with every
 * keystroke. It bought nothing. The observed box IS the page, so a render that changes its height is
 * a resize the observer reports on its own, and a render that does not change it needs no
 * measurement at all — while the rebuild cost a disconnect, a fresh observation of both boxes (an
 * observation reports itself, so a second measurement follows), and a layout read forced out of an
 * effect running directly after the DOM patch, on every keystroke.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { AsciiDocPreview } from '@/components/asciidoc-preview';

jest.mock('@/hooks/use-asciidoc-preview', () => ({ useAsciidocPreview: jest.fn() }));
jest.mock('@/components/math/render-math', () => ({ renderMath: jest.fn(() => Promise.resolve()) }));

import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import { commitToPreviewOutput, previewHookResult } from '../helpers/preview-panel';

const mockUsePreview = useAsciidocPreview as jest.Mock;

/** Every observer the panel has built while a test ran, in the order it built them. */
let observers: MockResizeObserver[] = [];

// jsdom implements no ResizeObserver and lays nothing out, so both the observation and the sizes it
// would report have to be supplied by the test.
class MockResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed: Element[] = [];
  disconnected = 0;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }

  observe = (target: Element): void => {
    this.observed.push(target);
  };

  unobserve = (): void => {};

  disconnect = (): void => {
    this.disconnected += 1;
  };
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, value: MockResizeObserver });
  // The measure is rAF-guarded so a resize drag coalesces into one update per frame; running the
  // frame synchronously is what lets a test's resize land inside its own `act()`.
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 0;
  });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
});

beforeEach(() => {
  mockUsePreview.mockReset();
  observers = [];
});

/**
 * The panel, under the Print style, with a document on screen.
 *
 * @param renderNonce - Which render has been committed into the output element.
 * @param isEnabled - Whether this file can be previewed at all.
 * @returns The element tree, ready to be re-rendered with another nonce.
 */
function panel(renderNonce: number, isEnabled = true) {
  mockUsePreview.mockReturnValue(previewHookResult({ state: 'up-to-date', renderNonce }));
  return (
    <AsciiDocPreview
      content="= Doc"
      isEnabled={isEnabled}
      projectId="p1"
      scrollToLine={null}
      previewStyle="print"
      onPreviewStyleChange={jest.fn()}
    />
  );
}

/** The scaled box the page occupies, which is what the pane scrolls. */
function pageViewport(): HTMLElement {
  return screen.getByTestId('print-page-viewport');
}

/** The page column: laid out once at its own width, and only then scaled. */
function pageColumn(): HTMLElement {
  return pageViewport().firstElementChild as HTMLElement;
}

/**
 * Report a resize through the observer the panel is actually holding.
 *
 * @param paneWidth - The scroll viewport's client width, in CSS pixels.
 * @param pageHeight - The page column's laid-out height, in CSS pixels.
 */
function reportSizes(paneWidth: number, pageHeight: number): void {
  const viewport = screen.getByTestId('preview-scroll-container');
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: paneWidth });
  Object.defineProperty(pageColumn(), 'offsetHeight', { configurable: true, value: pageHeight });
  const observer = observers.at(-1);
  act(() => {
    observer?.callback([], observer as unknown as ResizeObserver);
  });
}

describe('what the fit measurement is allowed to depend on', () => {
  // The fit scale is measured from the pane's `clientWidth`, and the box that scale produces is what
  // decides whether the pane needs a scrollbar. Where a scrollbar takes layout space that is a loop
  // with no fixed point over a band of document heights ≈ 1.9% wide — 855..873px of pane height for a
  // 1000px column in a 700px pane, alternating once per animation frame. Reserving the gutter is what
  // takes `clientWidth` out of the loop.
  //
  // jsdom lays nothing out and has no scrollbars, so this asserts that the pane asks for the gutter,
  // not that the browser stops oscillating; the oscillation itself is driven in a real browser by
  // `e2e/print-preview.spec.ts`.
  test('the Print pane reserves the scrollbar gutter', () => {
    render(panel(1));
    expect(screen.getByTestId('preview-scroll-container').className).toContain(
      '[scrollbar-gutter:stable]',
    );
  });

  test('the other styles leave the pane as it was', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ state: 'up-to-date', renderNonce: 1 }));
    render(
      <AsciiDocPreview
        content="= Doc"
        isEnabled
        projectId="p1"
        scrollToLine={null}
        previewStyle="asciidocollab"
        onPreviewStyleChange={jest.fn()}
      />,
    );
    expect(screen.getByTestId('preview-scroll-container').className).not.toContain('scrollbar-gutter');
  });
});

describe('the page frame measures with one observer', () => {
  test('a render does not rebuild the observer', () => {
    const harness = render(panel(1));
    commitToPreviewOutput('<h1>Doc</h1>');
    expect(observers).toHaveLength(1);

    // Three more renders land, which is three keystrokes.
    for (const nonce of [2, 3, 4]) {
      harness.rerender(panel(nonce));
      commitToPreviewOutput(`<h1>Doc ${nonce}</h1>`);
    }

    expect(observers).toHaveLength(1);
    expect(observers[0].disconnected).toBe(0);
    // Both boxes, observed once each: the pane decides the fit, the page gives the scaled box its
    // height.
    expect(observers[0].observed).toEqual([
      screen.getByTestId('preview-scroll-container'),
      pageColumn(),
    ]);
  });

  test('a render that changes the page height is still measured, through that observer', () => {
    const harness = render(panel(1));
    commitToPreviewOutput('<h1>Doc</h1>');
    reportSizes(400, 500);
    // 400 pane less its 16px inset either side, over the A4 page's 793.7px: the page is scaled to fit.
    const scale = (400 - 32) / 793.7067;
    expect(pageViewport().style.height).toBe(`${500 * scale}px`);

    // The next render makes the document taller. Nothing rebuilds the effect; the observer reports it.
    harness.rerender(panel(2));
    commitToPreviewOutput('<h1>Doc</h1><p>and more of it</p>');
    reportSizes(400, 900);

    expect(pageViewport().style.height).toBe(`${900 * scale}px`);
  });

  test('a file the panel cannot preview takes its page frame with it, and the observer follows', () => {
    const harness = render(panel(1));
    commitToPreviewOutput('<h1>Doc</h1>');
    const first = observers[0];

    // An image, say: the frame is unmounted, and the element the observer is watching leaves the
    // document with it.
    harness.rerender(panel(2, false));
    expect(first.disconnected).toBe(1);

    // Back to a file that can be previewed. The frame is a NEW element, and it is the one measured
    // from here on — an effect that had not noticed would still be watching the detached one, and the
    // page would keep the height of a document that is no longer on screen.
    harness.rerender(panel(3));
    commitToPreviewOutput('<h1>Doc</h1>');
    expect(observers.at(-1)?.observed).toContain(pageColumn());

    reportSizes(400, 700);
    expect(pageViewport().style.height).toBe(`${(700 * (400 - 32)) / 793.7067}px`);
  });
});
