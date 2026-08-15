import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AsciiDocPreview } from '@/components/asciidoc-preview';
import { PREVIEW_STYLE_VALUES } from '@asciidocollab/primitives';
import { PREVIEW_STYLE_DESCRIPTIONS } from '@/components/preview-style-control';

jest.mock('@/hooks/use-asciidoc-preview', () => ({ useAsciidocPreview: jest.fn() }));
jest.mock('@/components/math/render-math', () => ({ renderMath: jest.fn(() => Promise.resolve()) }));

import { useAsciidocPreview } from '@/hooks/use-asciidoc-preview';
import { commitToPreviewOutput, previewHookResult } from '../helpers/preview-panel';

const mockUsePreview = useAsciidocPreview as jest.Mock;

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

/** Render the preview in the Print style with a document on screen. */
function renderPrintPreview() {
  mockUsePreview.mockReturnValue(previewHookResult({ state: 'up-to-date', renderNonce: 1 }));
  const harness = render(
    <AsciiDocPreview
      content="= Doc"
      isEnabled
      projectId="p1"
      scrollToLine={null}
      previewStyle="print"
      onPreviewStyleChange={jest.fn()}
    />,
  );
  commitToPreviewOutput('<h1>Doc</h1><p>Body.</p>');
  const viewport = screen.getByTestId('preview-scroll-container');
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 900 });
  act(() => {
    resizeCallback?.([], {} as ResizeObserver);
  });
  return harness;
}

describe('the Print style is operable without a mouse', () => {
  test('every control the style adds is a real control, so the keyboard reaches it', () => {
    renderPrintPreview();
    // A `div` with a click handler looks identical and is reachable by no keyboard at all. Asserting
    // the element TYPE is what makes "operable without a mouse" a property of the markup rather than
    // of a test that happened to send the right events.
    for (const id of ['print-zoom-out', 'print-zoom-in', 'preview-style-print']) {
      const control = screen.getByTestId(id);
      expect(control.tagName).toBe('BUTTON');
      expect(control).not.toHaveAttribute('tabindex', '-1');
      expect(control).not.toBeDisabled();
    }
    expect(screen.getByTestId('print-zoom-preset').tagName).toBe('SELECT');
  });

  test('each control can be operated, and the page responds', () => {
    renderPrintPreview();
    const preset = screen.getByTestId('print-zoom-preset');
    preset.focus();
    expect(document.activeElement).toBe(preset);

    fireEvent.change(preset, { target: { value: '2' } });
    expect((preset as HTMLSelectElement).value).toBe('2');
    expect(Number.parseFloat(screen.getByTestId('print-page-viewport').style.width)).toBeGreaterThan(
      900,
    );
  });
});

describe('the Print style is named for a screen reader on the same terms as the others', () => {
  test('every style option carries the same kind of name and description', () => {
    renderPrintPreview();
    for (const style of PREVIEW_STYLE_VALUES) {
      const option = screen.getByTestId(`preview-style-${style}`);
      expect(option).toHaveAttribute('aria-pressed');
      expect(option).toHaveAttribute('aria-description', PREVIEW_STYLE_DESCRIPTIONS[style]);
      expect(option.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  test('the Print option says what it is for rather than leaving it to be inferred', () => {
    expect(PREVIEW_STYLE_DESCRIPTIONS.print).toMatch(/PDF/);
  });

  test('the zoom controls are named, not just drawn', () => {
    renderPrintPreview();
    expect(screen.getByRole('button', { name: 'zoom out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'zoom in' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'zoom level' })).toBeInTheDocument();
  });

  test('the previewed page is still announced as busy while a render is in flight', () => {
    mockUsePreview.mockReturnValue(previewHookResult({ state: 'rendering', renderNonce: 1 }));
    render(
      <AsciiDocPreview content="= Doc" isEnabled projectId="p1" scrollToLine={null} previewStyle="print" />,
    );
    expect(screen.getByTestId('asciidoc-output')).toHaveAttribute('aria-busy', 'true');
  });
});

describe('what the interface says about what this preview is', () => {
  // An approximation that never says so is one an author will eventually trust for a question it
  // cannot answer — a page break, a running header, where the twentieth page starts. It is said in
  // the style control's own description rather than in a strip across the page: a banner standing
  // permanently over the thing it describes is read once and then only ever in the way.
  test('the Print option states that the PDF remains the authority', () => {
    expect(PREVIEW_STYLE_DESCRIPTIONS.print).toMatch(/not paginated/i);
    expect(PREVIEW_STYLE_DESCRIPTIONS.print).toMatch(
      /PDF preview and the export remain the authority/i,
    );
    expect(PREVIEW_STYLE_DESCRIPTIONS.print).toMatch(/page breaks/i);
  });

  test('it is carried where a screen reader and a pointer both reach it', () => {
    renderPrintPreview();
    const option = screen.getByTestId('preview-style-print');
    expect(option).toHaveAttribute('aria-description', PREVIEW_STYLE_DESCRIPTIONS.print);
    expect(option).toHaveAttribute('title', PREVIEW_STYLE_DESCRIPTIONS.print);
  });

  test('the other styles say nothing of the sort, because it is not true of them', () => {
    for (const style of ['asciidocollab', 'asciidoctor'] as const) {
      expect(PREVIEW_STYLE_DESCRIPTIONS[style]).not.toMatch(/paginated/i);
    }
  });

  test('nothing stands over the page saying it', () => {
    const { container } = renderPrintPreview();
    // Not the absence of a `data-testid`: nothing in this tree has ever carried
    // `print-approximation-notice`, so querying for it passed on any markup whatsoever — including
    // markup with a strip across the page under some other name, which is the thing being ruled out.
    //
    // What is asserted instead is the property itself. The sentence is carried where a reader can ask
    // for it — an `aria-description` and a `title` on the style control, both checked above — and the
    // page shows none of it: no element anywhere in the preview has the claim as its own text.
    const shown = [...container.querySelectorAll('*')].filter((element) =>
      [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && /paginat|approximation/i.test(node.textContent ?? ''),
      ),
    );
    // An empty list rather than a length, so a failure names the strip it found.
    expect(shown.map((element) => element.textContent)).toEqual([]);
    // …and the control that does carry it still shows a NAME, not the sentence.
    expect(screen.getByTestId('preview-style-print').textContent?.trim()).not.toBe(
      PREVIEW_STYLE_DESCRIPTIONS.print,
    );
  });
});

describe('the page does not defeat the reader’s own settings', () => {
  const RULES = readFileSync(
    path.resolve(__dirname, '../../src/styles/print-preview.css'),
    'utf8',
  ).replaceAll(/\/\*[\s\S]*?\*\//g, '');

  test('nothing in the style animates, so there is nothing for reduced motion to have to stop', () => {
    expect(RULES).not.toMatch(/\banimation\b/);
    expect(RULES).not.toMatch(/\btransition\b/);
  });

  test('the page is sized in absolute units, so a reader’s own text zoom still scales it', () => {
    // The page column is a fixed measure by design — that is what makes its line lengths the PDF's.
    // Sizing it in `rem` would make the browser's own font-size setting change the measure, which
    // would silently stop it being the PDF's measure at all; the zoom control is the escape instead.
    //
    // Read off the declaration itself rather than by asking whether the sheet contains
    // `var(--print-page-width…) rem` — which is not a length any stylesheet would ever carry, so its
    // absence was never in doubt and never said anything about how the page is sized.
    //
    // Every such declaration, not the first one the scan happens to reach: the sheet reads the page's
    // dimensions in more than one place, and a second declaration written in `rem` would have sized
    // the page from the reader's font while this went on passing on the strength of the first.
    const declarations = [...RULES.matchAll(/(?:width|height):\s*(var\(--print-page-(?:width|height)[^;]*)/g)].map(
      (match) => match[1],
    );
    // The stylesheet sizes the page column from the page's own dimensions…
    expect(declarations.length).toBeGreaterThan(1);
    for (const declaration of declarations) {
      // …in a length the reader's own font size does not scale…
      expect(declaration).not.toMatch(/[\d.]\s*r?em\b/);
      // …including the fallback it uses before any property is set.
      expect(declaration).toMatch(/[\d.]+(px|pt|mm|cm|in)/);
    }
  });
});
