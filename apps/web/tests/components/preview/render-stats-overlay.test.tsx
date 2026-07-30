import { render, screen } from '@testing-library/react';
import { RenderStatsOverlay, type RenderStatRow } from '@/components/preview/render-stats-overlay';

/** The web-formatted preview's shape: four stage figures and nothing else. */
const WEB_ROWS: readonly RenderStatRow[] = [
  { label: 'parse', value: 4, unit: 'ms' },
  { label: 'convert', value: 18, unit: 'ms' },
  { label: 'post', value: 3, unit: 'ms' },
  { label: 'total', value: 27, unit: 'ms' },
];

/** The page-formatted preview's shape: counters alongside a longer stage list. */
const PAGE_ROWS: readonly RenderStatRow[] = [
  { label: 'render', value: 3200, unit: 'ms' },
  { label: 'cache hits', value: 4 },
  { label: 'raster fallbacks', value: 1 },
  { label: 'vm boot', value: 900, unit: 'ms' },
  { label: 'dry runs', value: 1200, unit: 'ms' },
];

describe('RenderStatsOverlay', () => {
  it('shows every stage it is given, with its figure', () => {
    render(<RenderStatsOverlay title="Web preview" rows={WEB_ROWS} />);

    expect(screen.getByText('parse')).toBeInTheDocument();
    expect(screen.getByText('4 ms')).toBeInTheDocument();
    expect(screen.getByText('total')).toBeInTheDocument();
    expect(screen.getByText('27 ms')).toBeInTheDocument();
  });

  it('shows a differently shaped set of figures just as readily', () => {
    // The two preview formats report structurally different things — four durations on one side,
    // counters plus nine stages on the other. The overlay is told what to show rather than knowing.
    render(<RenderStatsOverlay title="Page preview" rows={PAGE_ROWS} />);

    expect(screen.getByText('dry runs')).toBeInTheDocument();
    expect(screen.getByText('1200 ms')).toBeInTheDocument();
    // A counter is not a duration and must not be labelled as one.
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.queryByText('4 ms')).not.toBeInTheDocument();
  });

  it('rounds a fractional measurement to whole milliseconds', () => {
    render(<RenderStatsOverlay title="Web preview" rows={[{ label: 'parse', value: 3.34, unit: 'ms' }]} />);

    expect(screen.getByText('3 ms')).toBeInTheDocument();
  });

  it('renders nothing in a production build', () => {
    // A measurement surface for whoever is working on the renderer, not for authors. The bundler
    // eliminates it from the production bundle on this same condition; here it is exercised directly.
    const previous = process.env.NODE_ENV;
    process.env['NODE_ENV'] = 'production';
    try {
      const { container } = render(<RenderStatsOverlay title="Web preview" rows={WEB_ROWS} />);
      expect(container).toBeEmptyDOMElement();
    } finally {
      process.env['NODE_ENV'] = previous;
    }
  });

  it('renders nothing at all when there is nothing measured yet', () => {
    const { container } = render(<RenderStatsOverlay title="Web preview" rows={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
