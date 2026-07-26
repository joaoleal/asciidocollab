import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { RenderDiagnostic } from '@asciidocollab/asciidoc-pdf';
import { PdfPreviewPanel } from '@/components/pdf-preview-panel';

// pdf.js paints into a real 2D canvas context, which only exists in a browser. The unit test mocks
// the whole module so we assert the component's render orchestration (invocation, cancellation,
// teardown) without pretending to rasterize pixels in jsdom.
const mockRenderCancel = jest.fn();
const mockTextLayerCancel = jest.fn();
const mockDocumentDestroy = jest.fn();
const mockPageRender = jest.fn(() => ({
  promise: Promise.resolve(),
  cancel: mockRenderCancel,
}));
const mockStreamTextContent = jest.fn(() => ({} as ReadableStream));
const mockGetAnnotations = jest.fn(() => Promise.resolve([]));
// The component asks for the page's intrinsic size (scale 1) to fit-to-width, then for the scaled
// render viewport; honour the scale argument so the fit/zoom maths can be observed via the call log.
const INTRINSIC_PAGE_WIDTH = 200;
const mockGetViewport = jest.fn(({ scale = 1 }: { scale?: number } = {}) => ({
  width: INTRINSIC_PAGE_WIDTH * scale,
  height: (INTRINSIC_PAGE_WIDTH * 1.5) * scale,
  scale,
}));
const mockGetPage = jest.fn(() =>
  Promise.resolve({
    getViewport: mockGetViewport,
    render: mockPageRender,
    streamTextContent: mockStreamTextContent,
    getAnnotations: mockGetAnnotations,
    cleanup: jest.fn(),
  })
);
/** A page whose intrinsic (scale-1) height is 0, to exercise the link service's zero-height guard. */
const zeroHeightPage = () =>
  Promise.resolve({
    getViewport: ({ scale = 1 }: { scale?: number } = {}) => ({ width: 200 * scale, height: 0, scale }),
    render: mockPageRender,
    streamTextContent: mockStreamTextContent,
    getAnnotations: mockGetAnnotations,
    cleanup: jest.fn(),
  });
const mockGetDocument = jest.fn(() => ({
  promise: Promise.resolve({
    numPages: 1,
    getPage: mockGetPage,
    cleanup: jest.fn(),
    destroy: mockDocumentDestroy,
  }),
  destroy: mockDocumentDestroy,
}));

// The text and annotation layers are pdf.js DOM overlays; jsdom cannot lay out real glyphs, so each is
// stubbed to record that the component constructed and rendered one per page. The TextLayer stub also
// exposes `cancel()` so the teardown assertions can prove the overlay render is abandoned on supersede.
const mockTextLayerRender = jest.fn(() => Promise.resolve());
const mockTextLayerConstructor = jest.fn();
const mockAnnotationLayerRender = jest.fn(() => Promise.resolve());
const mockAnnotationLayerConstructor = jest.fn();

class MockTextLayer {
  constructor(options: unknown) {
    mockTextLayerConstructor(options);
  }
  render = mockTextLayerRender;
  cancel = mockTextLayerCancel;
}

class MockAnnotationLayer {
  constructor(options: unknown) {
    mockAnnotationLayerConstructor(options);
  }
  render = mockAnnotationLayerRender;
}

jest.mock('pdfjs-dist', () => ({
  __esModule: true,
  getDocument: (...arguments_: unknown[]) => mockGetDocument(...arguments_),
  GlobalWorkerOptions: { workerSrc: '' },
  TextLayer: class {
    constructor(options: unknown) {
      return new MockTextLayer(options);
    }
  },
  AnnotationLayer: class {
    constructor(options: unknown) {
      return new MockAnnotationLayer(options);
    }
  },
}));

function makePdf(): Blob {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'application/pdf' });
}

// jsdom implements neither ResizeObserver nor a synchronous rAF. Capture the observer callback so a
// test can drive a resize, and run rAF synchronously so the fit measurement lands within the act().
let resizeCallback: ResizeObserverCallback | null = null;
class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
}

/** Set the scroll viewport's measured width and fire the captured ResizeObserver callback. */
function resizeViewport(width: number): void {
  const stack = screen.getByLabelText('Rendered PDF pages');
  const container = stack.parentElement as HTMLElement;
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: width });
  resizeCallback?.([], {} as ResizeObserver);
}

// jsdom lacks IntersectionObserver; capture the latest callback so a test can simulate scrolling a
// given page into view.
let intersectionCallback: IntersectionObserverCallback | null = null;
class MockIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
}

/** Simulate the given page becoming the most in-view page by driving the IntersectionObserver. */
function setInViewPage(pageNumber: number): void {
  const stack = screen.getByLabelText('Rendered PDF pages');
  const entries = [...stack.children].map((element) => ({
    target: element,
    intersectionRatio: Number((element as HTMLElement).dataset.page) === pageNumber ? 1 : 0,
    isIntersecting: Number((element as HTMLElement).dataset.page) === pageNumber,
  }));
  act(() => {
    intersectionCallback?.(
      entries as unknown as IntersectionObserverEntry[],
      {} as IntersectionObserver
    );
  });
}

/** Records go-to-page scrolls; jsdom does not implement Element.scrollIntoView. */
const scrollIntoViewMock = jest.fn();

/** The crisp-render debounce the component applies; mirrored here to drive the fake timers. */
const RENDER_DEBOUNCE = 180;

/** Flush the pdf.js render chain's chained microtasks so the off-DOM pages swap in under fake timers. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver;
  (
    globalThis as unknown as { IntersectionObserver: typeof MockIntersectionObserver }
  ).IntersectionObserver = MockIntersectionObserver;
  HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
  jest
    .spyOn(globalThis, 'requestAnimationFrame')
    .mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  // jsdom has no 2D canvas backend; return a stub so the render path reaches pdf.js `render`.
  HTMLCanvasElement.prototype.getContext = jest.fn(
    () => ({})
  ) as unknown as HTMLCanvasElement['getContext'];
  // jsdom's Blob does not implement arrayBuffer(); the mocked pdf.js ignores the bytes.
  if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      writable: true,
      value: () => Promise.resolve(new ArrayBuffer(0)),
    });
  }
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PdfPreviewPanel', () => {
  test('renders the labelled preview surface when idle and empty', () => {
    render(<PdfPreviewPanel pdf={null} isRendering={false} />);
    expect(
      screen.getByRole('region', { name: /pdf preview/i })
    ).toBeInTheDocument();
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  test('shows the "not part of the main document" notice only when outsideMainTree is set', () => {
    const { queryByTestId, rerender } = render(<PdfPreviewPanel pdf={null} isRendering={false} />);
    expect(queryByTestId('outside-main-tree-notice')).not.toBeInTheDocument();

    rerender(<PdfPreviewPanel pdf={null} isRendering={false} outsideMainTree />);
    expect(queryByTestId('outside-main-tree-notice')).toBeInTheDocument();
    expect(queryByTestId('outside-main-tree-notice')).toHaveTextContent(/part of the main document/i);
  });

  test('surfaces a phase-keyed rendering status while a render is in flight', () => {
    render(<PdfPreviewPanel pdf={null} isRendering phase="converting" />);
    const region = screen.getByRole('region', { name: /pdf preview/i });
    expect(region).toHaveAttribute('aria-busy', 'true');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/render/i);
  });

  test('shows a pending status before the first phase arrives', () => {
    render(<PdfPreviewPanel pdf={null} isRendering />);
    expect(screen.getByRole('status')).toHaveTextContent(/\w/);
  });

  test('renders a supplied pdf through pdf.js', async () => {
    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await waitFor(() => expect(mockGetDocument).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockPageRender).toHaveBeenCalledTimes(1));
  });

  test('builds a selectable text layer and a clickable annotation layer per page', async () => {
    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);

    // The text layer streams the page's text content into a `.textLayer` overlay and renders it.
    await waitFor(() => expect(mockTextLayerConstructor).toHaveBeenCalledTimes(1));
    expect(mockStreamTextContent).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockTextLayerRender).toHaveBeenCalledTimes(1));

    // The annotation layer fetches the page's annotations and renders link anchors into `.annotationLayer`.
    expect(mockGetAnnotations).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockAnnotationLayerConstructor).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockAnnotationLayerRender).toHaveBeenCalledTimes(1));

    // Both overlays are stacked over the canvas inside the positioned page container.
    const canvas = screen.getByLabelText('Rendered PDF page 1');
    const pageContainer = canvas.parentElement!;
    expect(pageContainer.querySelector('.textLayer')).not.toBeNull();
    expect(pageContainer.querySelector('.annotationLayer')).not.toBeNull();
  });

  test('reveals the source of a clicked (non-link) page position via onNavigateToSource', async () => {
    const onNavigateToSource = jest.fn();
    const sourceMap = [
      { line: 5, page: 1, yFraction: 0 },
      { line: 12, page: 1, yFraction: 0.5 },
    ];
    render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        sourceMap={sourceMap}
        onNavigateToSource={onNavigateToSource}
      />,
    );
    const canvas = await screen.findByLabelText('Rendered PDF page 1');
    const pageContainer = canvas.parentElement!; // carries data-page="1"
    fireEvent.click(pageContainer);
    // jsdom's getBoundingClientRect is all zeros → yFraction 0 → the page's first block governs.
    expect(onNavigateToSource).toHaveBeenCalledWith(5);
  });

  test('prefers a block’s exact render-time origin when the source-map entry carries one', async () => {
    const onNavigateToSource = jest.fn();
    const onNavigateToExactSource = jest.fn();
    render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        sourceMap={[{ line: 4, page: 1, yFraction: 0, path: 'ch/one.adoc', sourceLine: 12 }]}
        onNavigateToSource={onNavigateToSource}
        onNavigateToExactSource={onNavigateToExactSource}
      />,
    );
    const canvas = await screen.findByLabelText('Rendered PDF page 1');
    fireEvent.click(canvas.parentElement!);
    expect(onNavigateToExactSource).toHaveBeenCalledWith('ch/one.adoc', 12);
    expect(onNavigateToSource).not.toHaveBeenCalled();
  });

  test('a click on a link annotation is left to pdf.js and does not jump to source', async () => {
    const onNavigateToSource = jest.fn();
    render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        sourceMap={[{ line: 5, page: 1, yFraction: 0 }]}
        onNavigateToSource={onNavigateToSource}
      />,
    );
    const canvas = await screen.findByLabelText('Rendered PDF page 1');
    const annotationLayer = canvas.parentElement!.querySelector('.annotationLayer')!;
    const anchor = document.createElement('a');
    anchor.href = 'https://example.com';
    annotationLayer.append(anchor);
    fireEvent.click(anchor);
    expect(onNavigateToSource).not.toHaveBeenCalled();
  });

  test('turns an external link annotation into a hardened new-tab anchor', async () => {
    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await waitFor(() => expect(mockAnnotationLayerRender).toHaveBeenCalledTimes(1));

    // The component hands the annotation layer a link service; exercise it exactly as pdf.js would when
    // it encounters a `data.url` link, then confirm the anchor is safe to open in a new tab.
    const { linkService } = mockAnnotationLayerRender.mock.calls[0][0] as {
      linkService: {
        addLinkAttributes: (link: HTMLAnchorElement, url: string) => void;
        getDestinationHash: () => string;
        getAnchorUrl: () => string;
        goToDestination: () => Promise<void>;
        goToPage: () => void;
        setHash: () => void;
        executeNamedAction: () => void;
        executeSetOCGState: () => void;
      };
    };

    const anchor = document.createElement('a');
    linkService.addLinkAttributes(anchor, 'https://example.com/docs');
    expect(anchor.getAttribute('href')).toBe('https://example.com/docs');
    expect(anchor.target).toBe('_blank');
    expect(anchor.rel).toBe('noopener noreferrer');
    expect(anchor.title).toBe('https://example.com/docs');

    // Internal-navigation members are inert in a scrollable, all-pages-at-once preview.
    expect(linkService.getDestinationHash()).toBe('');
    expect(linkService.getAnchorUrl()).toBe('');
    await expect(linkService.goToDestination()).resolves.toBeUndefined();
    expect(() => {
      linkService.goToPage();
      linkService.setHash();
      linkService.executeNamedAction();
      linkService.executeSetOCGState();
    }).not.toThrow();
  });

  test('cancels the prior render task when the pdf is superseded', async () => {
    const { rerender } = render(
      <PdfPreviewPanel pdf={makePdf()} isRendering={false} />
    );
    await waitFor(() => expect(mockPageRender).toHaveBeenCalledTimes(1));

    rerender(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);

    await waitFor(() => expect(mockRenderCancel).toHaveBeenCalled());
    expect(mockDocumentDestroy).toHaveBeenCalled();
    await waitFor(() => expect(mockGetDocument).toHaveBeenCalledTimes(2));
  });

  test('cleans up the render task and document on unmount (no leak)', async () => {
    const { unmount } = render(
      <PdfPreviewPanel pdf={makePdf()} isRendering={false} />
    );
    await waitFor(() => expect(mockPageRender).toHaveBeenCalledTimes(1));

    unmount();

    await waitFor(() => expect(mockRenderCancel).toHaveBeenCalled());
    expect(mockDocumentDestroy).toHaveBeenCalled();
    // The text-layer overlay render is abandoned alongside the canvas render task on teardown.
    expect(mockTextLayerCancel).toHaveBeenCalled();
  });

  test('paints one canvas per page for a multi-page document', async () => {
    mockGetDocument.mockImplementationOnce(() => ({
      promise: Promise.resolve({
        numPages: 3,
        getPage: mockGetPage,
        cleanup: jest.fn(),
        destroy: mockDocumentDestroy,
      }),
      destroy: mockDocumentDestroy,
    }));

    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);

    await waitFor(() => expect(mockPageRender).toHaveBeenCalledTimes(3));
    expect(mockGetPage).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText('Rendered PDF page 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Rendered PDF page 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Rendered PDF page 3')).toBeInTheDocument();

    // One text layer and one annotation layer accompany each of the three page canvases.
    await waitFor(() => expect(mockTextLayerRender).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(mockAnnotationLayerRender).toHaveBeenCalledTimes(3));
  });

  test('fits pages to the measured viewport width and re-renders when it resizes', async () => {
    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await waitFor(() => expect(mockPageRender).toHaveBeenCalledTimes(1));

    // A 432px viewport reserves 16px padding per side, leaving 400px for a 200pt-wide page: scale 2.
    await act(async () => {
      resizeViewport(432);
    });

    // The page is re-rendered against a viewport requested at the fitted scale.
    await waitFor(() => expect(mockPageRender).toHaveBeenCalledTimes(2));
    expect(mockGetViewport).toHaveBeenCalledWith({ scale: 2 });
    // The preset control stays in fit mode and its Fit option shows the live fitted percentage.
    const preset = screen.getByTestId('pdf-zoom-preset') as HTMLSelectElement;
    await waitFor(() => expect(preset).toHaveValue('fit'));
    await waitFor(() => expect(preset).toHaveTextContent('Fit (200%)'));

    // A sub-pixel change below the threshold does not spawn another render.
    await act(async () => {
      resizeViewport(433);
    });
    expect(mockPageRender).toHaveBeenCalledTimes(2);
  });

  test('zooms in and out to an explicit scale and re-renders each time', async () => {
    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await act(async () => {
      resizeViewport(432);
    });
    const preset = screen.getByTestId('pdf-zoom-preset') as HTMLSelectElement;
    // Wait until the fitted scale has been committed so the zoom step builds on 200%, not the fallback.
    await waitFor(() => expect(preset).toHaveTextContent('Fit (200%)'));

    // Zooming in leaves fit mode for an explicit factor one step above the on-screen scale (2 * 1.25).
    fireEvent.click(screen.getByTestId('pdf-zoom-in'));
    await waitFor(() => expect(mockGetViewport).toHaveBeenCalledWith({ scale: 2.5 }));
    // 2.5 is not a preset, so the control surfaces it as a reflective custom entry reading 250%.
    expect(preset).toHaveValue('custom');
    expect(preset).toHaveTextContent('250%');

    // Zooming out steps back down (2.5 / 1.25 = 2).
    fireEvent.click(screen.getByTestId('pdf-zoom-out'));
    await waitFor(() => expect(mockGetViewport).toHaveBeenCalledWith({ scale: 2 }));
    // 2 matches the 200% preset.
    expect(preset).toHaveValue('2');
  });

  test('selecting a preset sets the scale and Fit returns to fit mode', async () => {
    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await act(async () => {
      resizeViewport(432);
    });
    const preset = screen.getByTestId('pdf-zoom-preset') as HTMLSelectElement;
    await waitFor(() => expect(preset).toHaveValue('fit'));

    // Choosing the 125% preset pins that custom scale and re-renders against it.
    fireEvent.change(preset, { target: { value: '1.25' } });
    expect(preset).toHaveValue('1.25');
    await waitFor(() => expect(mockGetViewport).toHaveBeenCalledWith({ scale: 1.25 }));

    // Choosing Fit returns to width-fitting and re-renders at the fitted scale (400 / 200 = 2).
    fireEvent.change(preset, { target: { value: 'fit' } });
    expect(preset).toHaveValue('fit');
    await waitFor(() => expect(mockGetViewport).toHaveBeenCalledWith({ scale: 2 }));
  });

  test('clamps zoom to its range and disables the buttons at the limits', async () => {
    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await act(async () => {
      resizeViewport(432);
    });
    const preset = screen.getByTestId('pdf-zoom-preset') as HTMLSelectElement;
    await waitFor(() => expect(preset).toHaveTextContent('Fit (200%)'));

    const zoomInButton = screen.getByTestId('pdf-zoom-in') as HTMLButtonElement;
    for (let step = 0; step < 8 && !zoomInButton.disabled; step += 1) {
      fireEvent.click(zoomInButton);
    }
    expect(zoomInButton).toBeDisabled();
    expect(preset).toHaveTextContent('400%');

    const zoomOutButton = screen.getByTestId('pdf-zoom-out') as HTMLButtonElement;
    for (let step = 0; step < 20 && !zoomOutButton.disabled; step += 1) {
      fireEvent.click(zoomOutButton);
    }
    expect(zoomOutButton).toBeDisabled();
    expect(preset).toHaveTextContent('25%');
  });

  test('reflects the in-view page and jumps to a requested page', async () => {
    mockGetDocument.mockImplementationOnce(() => ({
      promise: Promise.resolve({
        numPages: 5,
        getPage: mockGetPage,
        cleanup: jest.fn(),
        destroy: mockDocumentDestroy,
      }),
      destroy: mockDocumentDestroy,
    }));

    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await waitFor(() => expect(screen.getByTestId('pdf-page-total')).toHaveTextContent('5'));
    await waitFor(() => expect(screen.getByLabelText('Rendered PDF page 5')).toBeInTheDocument());
    // The indicator starts on the first page.
    expect(screen.getByTestId('pdf-page-current')).toHaveTextContent('1');

    // Scrolling the third page into view updates the indicator.
    setInViewPage(3);
    expect(screen.getByTestId('pdf-page-current')).toHaveTextContent('3');

    // Entering a page and pressing Enter scrolls it into view and moves the indicator.
    const jump = screen.getByTestId('pdf-page-jump');
    fireEvent.change(jump, { target: { value: '4' } });
    fireEvent.keyDown(jump, { key: 'Enter' });
    expect(scrollIntoViewMock).toHaveBeenCalled();
    expect(screen.getByTestId('pdf-page-current')).toHaveTextContent('4');

    // An out-of-range entry clamps to the last page; a blank entry is ignored.
    fireEvent.change(jump, { target: { value: '99' } });
    fireEvent.keyDown(jump, { key: 'Enter' });
    expect(screen.getByTestId('pdf-page-current')).toHaveTextContent('5');

    scrollIntoViewMock.mockClear();
    fireEvent.change(jump, { target: { value: '' } });
    fireEvent.keyDown(jump, { key: 'Enter' });
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    // A non-Enter key does not commit a jump.
    fireEvent.change(jump, { target: { value: '2' } });
    fireEvent.keyDown(jump, { key: 'ArrowUp' });
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    // Blurring the field with a valid page commits the jump.
    fireEvent.blur(jump);
    expect(scrollIntoViewMock).toHaveBeenCalled();
    expect(screen.getByTestId('pdf-page-current')).toHaveTextContent('2');
  });

  test('scales the visible pages instantly on zoom and debounces one crisp re-render', async () => {
    jest.useFakeTimers({ doNotFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    try {
      render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
      await settle(); // initial paint at the fallback scale
      await act(async () => {
        resizeViewport(432); // fit target: (432 - 32) / 200 = 2
      });
      await act(async () => {
        jest.advanceTimersByTime(RENDER_DEBOUNCE);
      });
      await settle(); // the crisp fit render commits

      const stack = screen.getByLabelText('Rendered PDF pages') as HTMLElement;
      const baseline = mockPageRender.mock.calls.length;
      // With the target settled, the freshly painted pages carry no residual transform.
      expect(stack.style.transform).toBe('');

      // A burst of zoom-ins transforms the already-painted pages at once, with no crisp re-render yet.
      act(() => {
        fireEvent.click(screen.getByTestId('pdf-zoom-in'));
        fireEvent.click(screen.getByTestId('pdf-zoom-in'));
      });
      expect(stack.style.transform).toMatch(/^scale\(/);
      expect(mockPageRender.mock.calls.length).toBe(baseline);

      // Nothing repaints until the quiet period elapses.
      await act(async () => {
        jest.advanceTimersByTime(RENDER_DEBOUNCE - 20);
      });
      expect(mockPageRender.mock.calls.length).toBe(baseline);

      // Once it does, the whole burst collapses into a single crisp re-render and the transform resets.
      await act(async () => {
        jest.advanceTimersByTime(40);
      });
      await settle();
      expect(mockPageRender.mock.calls.length).toBe(baseline + 1);
      expect(stack.style.transform).toBe('');
    } finally {
      jest.useRealTimers();
    }
  });

  test('skips painting a page whose 2D canvas context is unavailable', async () => {
    (HTMLCanvasElement.prototype.getContext as jest.Mock).mockReturnValueOnce(null);

    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);

    await waitFor(() => expect(mockGetPage).toHaveBeenCalledTimes(1));
    // With no drawing context the page render is abandoned before pdf.js paints.
    expect(mockPageRender).not.toHaveBeenCalled();
  });

  test('proportionally scrolls the page stack for a new scroll request when sync is enabled', () => {
    const { rerender } = render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        totalLines={101}
        scrollToLine={null}
      />
    );
    const container = screen.getByLabelText('Rendered PDF pages').parentElement!;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });

    rerender(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        totalLines={101}
        scrollToLine={{ line: 51 }}
      />
    );

    // fraction = (51 - 1) / (101 - 1) = 0.5; scrollTop = 0.5 * (1000 - 200).
    expect(container.scrollTop).toBe(400);
  });

  test('treats a document with an unknown line count as a single-line span for scroll-sync', () => {
    const { rerender } = render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        scrollToLine={null}
      />
    );
    const container = screen.getByLabelText('Rendered PDF pages').parentElement!;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });

    rerender(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        scrollToLine={{ line: 5 }}
      />
    );

    // With no total-line count the span collapses to 1, so any line past the first saturates the
    // fraction at 1 and scrolls to the full extent (1000 - 200).
    expect(container.scrollTop).toBe(800);
  });

  test('clamps the scroll fraction to the bottom of the stack for an out-of-range line', () => {
    const { rerender } = render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        totalLines={10}
        scrollToLine={null}
      />
    );
    const container = screen.getByLabelText('Rendered PDF pages').parentElement!;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });

    rerender(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        totalLines={10}
        scrollToLine={{ line: 9999 }}
      />
    );

    // The fraction saturates at 1, so the container scrolls to its full extent (1000 - 200).
    expect(container.scrollTop).toBe(800);
  });

  test('does not re-scroll when the same scroll request object is re-applied', () => {
    const request = { line: 40 };
    const { rerender } = render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        totalLines={100}
        scrollToLine={null}
      />
    );
    const container = screen.getByLabelText('Rendered PDF pages').parentElement!;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });

    rerender(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        totalLines={100}
        scrollToLine={request}
      />
    );
    // Simulate the user scrolling away after the first sync.
    container.scrollTop = 12;

    // A re-render that changes only an unrelated dependency, keeping the same request object.
    rerender(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        totalLines={200}
        scrollToLine={request}
      />
    );

    expect(container.scrollTop).toBe(12);
  });

  test('scrolls to the exact source-map position when a map and assembled line are supplied', async () => {
    const sourceMap = [
      { line: 1, page: 1, yFraction: 0 },
      { line: 10, page: 1, yFraction: 0.5 },
      { line: 20, page: 1, yFraction: 0.9 },
    ];
    const { rerender } = render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        sourceMap={sourceMap}
        scrollToLine={null}
      />
    );
    // Wait for the page element (the source-map target) to be painted into the stack.
    await waitFor(() => expect(screen.getByLabelText('Rendered PDF page 1')).toBeInTheDocument());
    const pageElement = screen.getByLabelText('Rendered PDF page 1').parentElement as HTMLElement;
    Object.defineProperty(pageElement, 'offsetTop', { configurable: true, value: 100 });
    Object.defineProperty(pageElement, 'offsetHeight', { configurable: true, value: 400 });
    const container = screen.getByLabelText('Rendered PDF pages').parentElement as HTMLElement;

    // A new request at assembled line 12 selects the nearest entry with line ≤ 12 (line 10, yFraction 0.5).
    rerender(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        sourceMap={sourceMap}
        assembledLine={12}
        scrollToLine={{ line: 3 }}
      />
    );

    // scrollTop = offsetTop(100) + yFraction(0.5) * offsetHeight(400) − top margin(12) = 288.
    expect(container.scrollTop).toBe(288);
  });

  test('falls back to proportional sync when a map is present but no assembled line is given', async () => {
    const sourceMap = [{ line: 1, page: 1, yFraction: 0 }];
    const { rerender } = render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        sourceMap={sourceMap}
        totalLines={101}
        scrollToLine={null}
      />
    );
    await waitFor(() => expect(screen.getByLabelText('Rendered PDF page 1')).toBeInTheDocument());
    const container = screen.getByLabelText('Rendered PDF pages').parentElement as HTMLElement;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });

    // Without an assembled line the panel uses the proportional path: (51-1)/(101-1) = 0.5.
    rerender(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        sourceMap={sourceMap}
        totalLines={101}
        scrollToLine={{ line: 51 }}
      />
    );

    expect(container.scrollTop).toBe(400);
  });

  test('follows an internal link destination to its resolved page', async () => {
    const mockGetDestination = jest.fn(() => Promise.resolve([{ num: 7, gen: 0 }, { name: 'Fit' }]));
    const mockGetPageIndex = jest.fn(() => Promise.resolve(1));
    mockGetDocument.mockImplementationOnce(() => ({
      promise: Promise.resolve({
        numPages: 2,
        getPage: mockGetPage,
        getDestination: mockGetDestination,
        getPageIndex: mockGetPageIndex,
        cleanup: jest.fn(),
        destroy: mockDocumentDestroy,
      }),
      destroy: mockDocumentDestroy,
    }));

    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await waitFor(() => expect(mockAnnotationLayerRender).toHaveBeenCalled());

    const { linkService } = mockAnnotationLayerRender.mock.calls[0][0] as {
      linkService: { goToDestination: (destination: unknown) => Promise<void> };
    };

    scrollIntoViewMock.mockClear();
    // A named destination resolves to page index 1 (the second page); with no y-coordinate it scrolls
    // the whole page into view.
    await act(async () => {
      await linkService.goToDestination('_section_two');
    });
    expect(mockGetDestination).toHaveBeenCalledWith('_section_two');
    expect(mockGetPageIndex).toHaveBeenCalledWith({ num: 7, gen: 0 });
    const secondPage = screen.getByLabelText('Rendered PDF page 2').parentElement as HTMLElement;
    expect(scrollIntoViewMock.mock.instances).toContain(secondPage);
  });

  test('offsets within the page when an internal destination carries a y-coordinate', async () => {
    const explicitDestination = [{ num: 3, gen: 0 }, { name: 'XYZ' }, 0, 600, null];
    const mockGetPageIndex = jest.fn(() => Promise.resolve(0));
    mockGetDocument.mockImplementationOnce(() => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: mockGetPage, // intrinsic height = 200 * 1.5 = 300 points at scale 1
        getDestination: jest.fn(),
        getPageIndex: mockGetPageIndex,
        cleanup: jest.fn(),
        destroy: mockDocumentDestroy,
      }),
      destroy: mockDocumentDestroy,
    }));

    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await waitFor(() => expect(mockAnnotationLayerRender).toHaveBeenCalled());
    const pageElement = screen.getByLabelText('Rendered PDF page 1').parentElement as HTMLElement;
    Object.defineProperty(pageElement, 'offsetTop', { configurable: true, value: 40 });
    Object.defineProperty(pageElement, 'offsetHeight', { configurable: true, value: 900 });
    const container = screen.getByLabelText('Rendered PDF pages').parentElement as HTMLElement;

    const { linkService } = mockAnnotationLayerRender.mock.calls[0][0] as {
      linkService: { goToDestination: (destination: unknown) => Promise<void> };
    };

    // An explicit dest already in array form skips getDestination; y=600 in a 300pt page clamps the
    // fraction to 0 (top): scrollTop = offsetTop(40) + 0*900 − 12 = 28.
    await act(async () => {
      await linkService.goToDestination(explicitDestination);
    });
    expect(container.scrollTop).toBe(28);
  });

  test('ignores an invalid internal destination without throwing', async () => {
    const mockGetDestination = jest.fn(() => Promise.resolve(null));
    mockGetDocument.mockImplementationOnce(() => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: mockGetPage,
        getDestination: mockGetDestination,
        getPageIndex: jest.fn(),
        cleanup: jest.fn(),
        destroy: mockDocumentDestroy,
      }),
      destroy: mockDocumentDestroy,
    }));

    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await waitFor(() => expect(mockAnnotationLayerRender).toHaveBeenCalled());
    const { linkService } = mockAnnotationLayerRender.mock.calls[0][0] as {
      linkService: { goToDestination: (destination: unknown) => Promise<void> };
    };

    scrollIntoViewMock.mockClear();
    await expect(linkService.goToDestination('missing')).resolves.toBeUndefined();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  test('treats a zero-height destination page as the page top when offsetting', async () => {
    mockGetDocument.mockImplementationOnce(() => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: zeroHeightPage,
        getDestination: jest.fn(),
        getPageIndex: jest.fn(() => Promise.resolve(0)),
        cleanup: jest.fn(),
        destroy: mockDocumentDestroy,
      }),
      destroy: mockDocumentDestroy,
    }));

    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await waitFor(() => expect(mockAnnotationLayerRender).toHaveBeenCalled());
    const pageElement = screen.getByLabelText('Rendered PDF page 1').parentElement as HTMLElement;
    Object.defineProperty(pageElement, 'offsetTop', { configurable: true, value: 40 });
    Object.defineProperty(pageElement, 'offsetHeight', { configurable: true, value: 500 });
    const container = screen.getByLabelText('Rendered PDF pages').parentElement as HTMLElement;

    const { linkService } = mockAnnotationLayerRender.mock.calls[0][0] as {
      linkService: { goToDestination: (destination: unknown) => Promise<void> };
    };

    // With a zero-height page the fraction collapses to 0 (top): scrollTop = offsetTop(40) − 12 = 28.
    await act(async () => {
      await linkService.goToDestination([{ num: 1, gen: 0 }, { name: 'XYZ' }, 0, 500, null]);
    });
    expect(container.scrollTop).toBe(28);
  });

  test('ignores an internal destination that resolves to an out-of-range page index', async () => {
    mockGetDocument.mockImplementationOnce(() => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: mockGetPage,
        getDestination: jest.fn(),
        getPageIndex: jest.fn(() => Promise.resolve(-1)),
        cleanup: jest.fn(),
        destroy: mockDocumentDestroy,
      }),
      destroy: mockDocumentDestroy,
    }));

    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await waitFor(() => expect(mockAnnotationLayerRender).toHaveBeenCalled());
    const { linkService } = mockAnnotationLayerRender.mock.calls[0][0] as {
      linkService: { goToDestination: (destination: unknown) => Promise<void> };
    };

    scrollIntoViewMock.mockClear();
    // An explicit dest whose page reference resolves to a negative index is rejected before scrolling.
    await act(async () => {
      await linkService.goToDestination([{ num: 1, gen: 0 }, { name: 'Fit' }]);
    });
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  test('uses the first map entry when the target line precedes every mapped block', async () => {
    // The only entry starts at line 10; an assembled line of 3 is before it, so the first entry governs.
    const sourceMap = [{ line: 10, page: 1, yFraction: 0.5 }];
    const { rerender } = render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        sourceMap={sourceMap}
        scrollToLine={null}
      />
    );
    await waitFor(() => expect(screen.getByLabelText('Rendered PDF page 1')).toBeInTheDocument());
    const pageElement = screen.getByLabelText('Rendered PDF page 1').parentElement as HTMLElement;
    Object.defineProperty(pageElement, 'offsetTop', { configurable: true, value: 60 });
    Object.defineProperty(pageElement, 'offsetHeight', { configurable: true, value: 200 });
    const container = screen.getByLabelText('Rendered PDF pages').parentElement as HTMLElement;

    rerender(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        sourceMap={sourceMap}
        assembledLine={3}
        scrollToLine={{ line: 1 }}
      />
    );

    // The first entry's position: offsetTop(60) + yFraction(0.5) * offsetHeight(200) − margin(12) = 148.
    expect(container.scrollTop).toBe(148);
  });

  test('ignores an internal destination whose page is beyond the rendered stack', async () => {
    mockGetDocument.mockImplementationOnce(() => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: mockGetPage,
        getDestination: jest.fn(),
        getPageIndex: jest.fn(() => Promise.resolve(5)), // valid index, but only 1 page is rendered
        cleanup: jest.fn(),
        destroy: mockDocumentDestroy,
      }),
      destroy: mockDocumentDestroy,
    }));

    render(<PdfPreviewPanel pdf={makePdf()} isRendering={false} />);
    await waitFor(() => expect(mockAnnotationLayerRender).toHaveBeenCalled());
    const { linkService } = mockAnnotationLayerRender.mock.calls[0][0] as {
      linkService: { goToDestination: (destination: unknown) => Promise<void> };
    };

    scrollIntoViewMock.mockClear();
    // The resolved page element does not exist, so the jump is a no-op rather than a crash.
    await act(async () => {
      await linkService.goToDestination([{ num: 1, gen: 0 }, { name: 'Fit' }]);
    });
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  test('warns, then falls back to proportional sync, when the mapped page is not in the DOM', async () => {
    // The map points at page 9, which this single-page document never renders, so the panel must
    // degrade to the proportional path rather than scroll to a missing element. It must also SAY so:
    // the proportional guess lands at an unrelated fraction (and can scroll backwards), which silently
    // masquerades as a working sync. The engine filters out-of-range pages, so reaching here means the
    // map and the render have gone out of step and someone needs to see it.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sourceMap = [{ line: 1, page: 9, yFraction: 0.5 }];
    const { rerender } = render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        sourceMap={sourceMap}
        assembledLine={1}
        totalLines={101}
        scrollToLine={null}
      />
    );
    await waitFor(() => expect(screen.getByLabelText('Rendered PDF page 1')).toBeInTheDocument());
    const container = screen.getByLabelText('Rendered PDF pages').parentElement as HTMLElement;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });

    rerender(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        sourceMap={sourceMap}
        assembledLine={1}
        totalLines={101}
        scrollToLine={{ line: 51 }}
      />
    );

    // The proportional path runs: (51 - 1) / (101 - 1) = 0.5 → 0.5 * (1000 - 200) = 400.
    expect(container.scrollTop).toBe(400);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('page 9'));
    warn.mockRestore();
  });

  test('falls back to proportional sync when the source map is empty', () => {
    // An empty map is an ordinary "no map this render" state, not a broken lookup: no warning.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rerender } = render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        sourceMap={[]}
        assembledLine={5}
        totalLines={101}
        scrollToLine={null}
      />
    );
    const container = screen.getByLabelText('Rendered PDF pages').parentElement as HTMLElement;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });

    rerender(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled
        sourceMap={[]}
        assembledLine={5}
        totalLines={101}
        scrollToLine={{ line: 51 }}
      />
    );

    expect(container.scrollTop).toBe(400);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('does not scroll when sync is disabled even with a scroll request present', () => {
    const { rerender } = render(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled={false}
        totalLines={100}
        scrollToLine={null}
      />
    );
    const container = screen.getByLabelText('Rendered PDF pages').parentElement!;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 200 });

    rerender(
      <PdfPreviewPanel
        pdf={makePdf()}
        isRendering={false}
        scrollSyncEnabled={false}
        totalLines={100}
        scrollToLine={{ line: 50 }}
      />
    );

    expect(container.scrollTop).toBe(0);
  });

  test('fires the header control callbacks when their handlers are provided', () => {
    const onPreviewModeChange = jest.fn();
    const onToggleScrollSync = jest.fn();
    const onCollapse = jest.fn();

    render(
      <PdfPreviewPanel
        pdf={null}
        isRendering={false}
        previewMode="pdf"
        onPreviewModeChange={onPreviewModeChange}
        onToggleScrollSync={onToggleScrollSync}
        onCollapse={onCollapse}
      />
    );

    fireEvent.click(screen.getByTestId('preview-mode-html'));
    expect(onPreviewModeChange).toHaveBeenCalledWith('html');

    fireEvent.click(screen.getByTestId('pdf-scroll-sync-toggle'));
    expect(onToggleScrollSync).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /collapse preview/i }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  test('reflects the enabled scroll-sync state on its header toggle', () => {
    render(
      <PdfPreviewPanel
        pdf={null}
        isRendering={false}
        scrollSyncEnabled
        onToggleScrollSync={jest.fn()}
      />
    );
    const toggle = screen.getByTestId('pdf-scroll-sync-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveAccessibleName(/disable scroll sync/i);
  });

  test('renders the diagnostics slot when diagnostics are present', () => {
    const diagnostic: RenderDiagnostic = {
      severity: 'warning',
      code: 'remote-skipped',
      resource: 'https://cdn.example.com/logo.png',
      message: 'Remote image was skipped because no network access is allowed.',
    };
    render(
      <PdfPreviewPanel pdf={null} isRendering={false} diagnostics={[diagnostic]} />
    );
    expect(
      screen.getByText(/remote image was skipped/i)
    ).toBeInTheDocument();
  });
});
