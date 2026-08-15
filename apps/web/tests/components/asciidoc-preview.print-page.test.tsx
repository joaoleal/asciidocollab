import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { AsciiDocPreview } from '@/components/asciidoc-preview';
import type { PreviewStyleValue } from '@/components/preview-style-control';

jest.mock('@/hooks/use-asciidoc-preview', () => ({ useAsciidocPreview: jest.fn() }));
jest.mock('@/components/math/render-math', () => ({ renderMath: jest.fn(() => Promise.resolve()) }));

import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import { commitToPreviewOutput, previewHookResult } from '../helpers/preview-panel';

const mockUsePreview = useAsciidocPreview as jest.Mock;

/** The default theme's A4 page, in CSS pixels: 595.28pt at 96/72. */
const A4_WIDTH_PX = 793.7067;

/** The scroll viewport's own inset, which is not width a page may occupy. */
const PANE_INSET = 16;

// jsdom implements no ResizeObserver and lays nothing out, so the panel's two measurements — how much
// width a page may occupy, and how tall the laid-out page is — have to be supplied by the test.
let resizeCallback: ResizeObserverCallback | null = null;
class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
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
  resizeCallback = null;
});

/** The page column: the element the page's own width and the theme's values are set on. */
function pageColumn(): HTMLElement {
  return screen.getByTestId('asciidoc-output');
}

/** The scaled box the page occupies, which is what the pane scrolls. */
function pageViewport(): HTMLElement {
  return screen.getByTestId('print-page-viewport');
}

/**
 * Render the panel with a document on screen under one preview style.
 *
 * @param previewStyle - The style to select.
 * @returns The render harness.
 */
function renderPreview(previewStyle: PreviewStyleValue = 'print') {
  mockUsePreview.mockReturnValue(previewHookResult({ state: 'up-to-date', renderNonce: 1 }));
  const harness = render(
    <AsciiDocPreview
      content="= Doc"
      isEnabled
      projectId="p1"
      scrollToLine={null}
      previewStyle={previewStyle}
      onPreviewStyleChange={jest.fn()}
    />,
  );
  commitToPreviewOutput('<h1>Doc</h1><p>Body text.</p>');
  return harness;
}

/**
 * Tell the panel how wide the pane is and how tall the laid-out page came out.
 *
 * @param paneWidth - The scroll viewport's client width, in CSS pixels.
 * @param pageHeight - The page column's laid-out height, in CSS pixels.
 */
function measure(paneWidth: number, pageHeight = 1122): void {
  const viewport = screen.getByTestId('preview-scroll-container');
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: paneWidth });
  const page = pageViewport().firstElementChild as HTMLElement;
  Object.defineProperty(page, 'offsetHeight', { configurable: true, value: pageHeight });
  act(() => {
    resizeCallback?.([], {} as ResizeObserver);
  });
}

describe('the previewed page is a page', () => {
  test('the column holds the theme page size, whatever the pane is doing', () => {
    renderPreview();
    measure(400);
    const scaler = pageViewport().firstElementChild as HTMLElement;
    // The column is laid out once at its own width and only then scaled, which is what makes the
    // preview's line breaks the export's line breaks at every zoom rather than only at 100%.
    expect(scaler.style.width).toBe(`${A4_WIDTH_PX}px`);
  });

  test('the page carries the theme geometry and paper colour as its own values', () => {
    renderPreview();
    const style = pageColumn().getAttribute('style') ?? '';
    expect(style).toContain(`--print-page-width: ${A4_WIDTH_PX}px`);
    expect(style).toContain('--print-page-margin-top:');
    expect(style).toContain('--print-page-background-color:');
  });

  test('the page is set against a backdrop, so it reads as a page rather than as the pane', () => {
    renderPreview();
    expect(screen.getByTestId('preview-scroll-container').className).toContain('bg-muted');
  });

  test('no page framing survives a switch to another style', () => {
    renderPreview('asciidocollab');
    expect(pageColumn().getAttribute('style')).toBeNull();
    expect(pageViewport().getAttribute('style')).toBeNull();
    expect(pageViewport().className).not.toContain('mx-auto');
  });
});

describe('fitting the page to the pane', () => {
  test('a narrow pane scales the page down to fit, and nothing overflows sideways', () => {
    renderPreview();
    measure(400);
    const available = 400 - PANE_INSET * 2;
    const box = pageViewport();
    expect(Number.parseFloat(box.style.width)).toBeCloseTo(available, 1);
    expect(Number.parseFloat(box.style.width)).toBeLessThanOrEqual(400);
    // The scaled height is what the pane scrolls; without it the pane would scroll by the page's
    // unscaled height and run on past the bottom of what is drawn.
    expect(Number.parseFloat(box.style.height)).toBeCloseTo(1122 * (available / A4_WIDTH_PX), 1);
  });

  test('a pane wider than the page leaves the page at its own width rather than stretching it', () => {
    renderPreview();
    measure(2000);
    expect(Number.parseFloat(pageViewport().style.width)).toBeCloseTo(A4_WIDTH_PX, 1);
    expect(screen.getByTestId('print-zoom-fit')).toHaveTextContent('Fit (100%)');
  });

  test('the page is centred in a pane it does not fill', () => {
    renderPreview();
    measure(2000);
    expect(pageViewport().className).toContain('mx-auto');
  });
});

describe('zooming the page', () => {
  test('the control appears only for the style that presents a page, and offers the PDF preview\'s presets', () => {
    renderPreview();
    measure(400);
    const options = [...screen.getByTestId('print-zoom-preset').querySelectorAll('option')];
    expect(options.map((option) => option.textContent)).toEqual([
      'Fit (46%)',
      '75%',
      '100%',
      '125%',
      '150%',
      '200%',
    ]);
  });

  test('no zoom control is offered by the styles that present no page', () => {
    renderPreview('asciidocollab');
    expect(screen.queryByTestId('print-zoom-preset')).not.toBeInTheDocument();
  });

  test('the pane grows wider than itself only once the author zooms in past it', () => {
    renderPreview();
    measure(400);
    expect(Number.parseFloat(pageViewport().style.width)).toBeLessThanOrEqual(400);

    fireEvent.change(screen.getByTestId('print-zoom-preset'), { target: { value: '2' } });
    expect(Number.parseFloat(pageViewport().style.width)).toBeCloseTo(A4_WIDTH_PX * 2, 1);
  });
});

describe('the page is not paginated', () => {
  // A MUST NOT that nothing else in this feature would fail on: everything would still look right
  // with a page break in it. The preview shows one page's appearance, not a paginated document, so
  // the absence of pagination needs asserting rather than leaving to follow from the design.
  const css = readFileSync(
    path.resolve(__dirname, '../../src/styles/print-preview.css'),
    'utf8',
  ).replaceAll(/\/\*[\s\S]*?\*\//g, '');

  test('the style asks for no page break anywhere', () => {
    expect(css).not.toMatch(/break-(before|after|inside)\s*:/);
    expect(css).not.toMatch(/page-break-/);
    expect(css).not.toMatch(/@page\b/);
  });

  test('the style prints no page number and no running header or footer', () => {
    expect(css).not.toMatch(/counter\(\s*page/);
    expect(css).not.toMatch(/@(top|bottom)-(left|center|right)\b/);
    expect(css).not.toMatch(/position\s*:\s*(fixed|sticky)/);
  });

  test('the whole document flows inside the one column', () => {
    renderPreview();
    measure(400);
    expect(screen.getAllByTestId('print-page-viewport')).toHaveLength(1);
    expect(pageColumn().textContent).toBe('DocBody text.');
    // One continuous flow: nothing splits the column into separately-scrolling pieces.
    expect(pageColumn().querySelectorAll('[data-page]')).toHaveLength(0);
  });
});
