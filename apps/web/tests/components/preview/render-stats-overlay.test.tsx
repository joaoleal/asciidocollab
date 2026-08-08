import { render, screen, fireEvent } from '@testing-library/react';
import { RenderStatsOverlay, type RenderStatRow } from '@/components/preview/render-stats-overlay';

/** The web-formatted preview's shape: a total with its three stages inside it. */
const WEB_ROWS: readonly RenderStatRow[] = [
  { label: 'total', value: 27, unit: 'ms' },
  { label: 'parse', value: 4, unit: 'ms', depth: 1 },
  { label: 'convert', value: 18, unit: 'ms', depth: 1 },
  { label: 'post', value: 3, unit: 'ms', depth: 1 },
];

/** The page-formatted preview's shape: two levels of nesting, plus counters that measure no time. */
const PAGE_ROWS: readonly RenderStatRow[] = [
  { label: 'render', value: 3200, unit: 'ms' },
  { label: 'vm boot', value: 900, unit: 'ms', depth: 1 },
  { label: 'convert', value: 2300, unit: 'ms', depth: 1 },
  { label: 'dry runs', value: 1200, unit: 'ms', depth: 2 },
  { label: 'cache hits', value: 4 },
  { label: 'raster fallbacks', value: 1 },
];

/** Open the overlay the way a reader does, and return its now-visible content. */
function open(title = 'Web preview'): void {
  fireEvent.click(screen.getByRole('button', { name: `Show ${title} render cost` }));
}

describe('RenderStatsOverlay', () => {
  it('shows only a button until someone asks for the figures', () => {
    render(<RenderStatsOverlay title="Web preview" rows={WEB_ROWS} />);

    // This sits on top of the document being previewed. A panel of figures nobody asked to see covers
    // the corner of the page they are reading, at every refresh, for the whole session.
    expect(screen.queryByText('parse')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Web preview render cost' })).toBeInTheDocument();
  });

  it('shows every stage it is given, with its figure, once opened', () => {
    render(<RenderStatsOverlay title="Web preview" rows={WEB_ROWS} />);

    open();

    expect(screen.getByText('parse')).toBeInTheDocument();
    expect(screen.getByText('4 ms')).toBeInTheDocument();
    expect(screen.getByText('total')).toBeInTheDocument();
    expect(screen.getByText('27 ms')).toBeInTheDocument();
  });

  it('puts the figures away again', () => {
    render(<RenderStatsOverlay title="Web preview" rows={WEB_ROWS} />);
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Hide Web preview render cost' }));

    expect(screen.queryByText('parse')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Web preview render cost' })).toBeInTheDocument();
  });

  it('shows a differently shaped set of figures just as readily', () => {
    // The two preview formats report structurally different things — four durations on one side,
    // counters plus nine stages on the other. The overlay is told what to show rather than knowing.
    render(<RenderStatsOverlay title="Page preview" rows={PAGE_ROWS} />);

    open('Page preview');

    expect(screen.getByText('dry runs')).toBeInTheDocument();
    expect(screen.getByText('1200 ms')).toBeInTheDocument();
    // A counter is not a duration and must not be labelled as one.
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.queryByText('4 ms')).not.toBeInTheDocument();
  });

  it('sets a figure in from the one that contains it, by how deep it sits', () => {
    render(<RenderStatsOverlay title="Page preview" rows={PAGE_ROWS} />);

    open('Page preview');

    // These figures overlap almost entirely — the convert is most of the render, the dry runs are
    // most of the convert — so shown flat they read as a render costing several times what it did.
    expect(screen.getByText('render').className).toBe('');
    expect(screen.getByText('convert').className).toBe('pl-3');
    expect(screen.getByText('dry runs').className).toBe('pl-6');
  });

  it('rounds a fractional measurement to whole milliseconds', () => {
    render(<RenderStatsOverlay title="Web preview" rows={[{ label: 'parse', value: 3.34, unit: 'ms' }]} />);

    open();

    expect(screen.getByText('3 ms')).toBeInTheDocument();
  });

  it('renders nothing in a production build', () => {
    // A measurement surface for whoever is working on the renderer, not for authors. The bundler
    // eliminates it from the production bundle on this same condition; here it is exercised directly.
    const previous = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: 'production' });
    try {
      const { container } = render(<RenderStatsOverlay title="Web preview" rows={WEB_ROWS} />);
      expect(container).toBeEmptyDOMElement();
    } finally {
      Object.assign(process.env, { NODE_ENV: previous });
    }
  });

  it('renders nothing at all when there is nothing measured yet', () => {
    const { container } = render(<RenderStatsOverlay title="Web preview" rows={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
