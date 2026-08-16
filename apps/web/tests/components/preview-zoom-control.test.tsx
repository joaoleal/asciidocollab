import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  PreviewZoomControl,
  ZOOM_PRESETS,
  usePreviewZoom,
  type PreviewZoom,
} from '@/components/preview-zoom-control';

/** Renders the control over the shared model and exposes the model to the test. */
function Harness({ fitScale, onModel }: { fitScale?: number; onModel?: (zoom: PreviewZoom) => void }) {
  const zoom = usePreviewZoom(fitScale, 1.5);
  onModel?.(zoom);
  return (
    <div>
      <PreviewZoomControl zoom={zoom} testIdPrefix="probe" />
      <span data-testid="target">{zoom.targetScale.toFixed(4)}</span>
      <span data-testid="preset">{zoom.presetValue}</span>
    </div>
  );
}

describe('the zoom model shared by both preview panes', () => {
  test('starts fitting to width rather than at a fixed factor', () => {
    render(<Harness fitScale={0.92} />);
    expect(screen.getByTestId('preset')).toHaveTextContent('fit');
    expect(screen.getByTestId('target')).toHaveTextContent('0.9200');
  });

  test('shows the resulting percentage in the fit option once a fit has been measured', () => {
    render(<Harness fitScale={0.92} />);
    expect(screen.getByTestId('probe-zoom-fit')).toHaveTextContent('Fit (92%)');
  });

  test('says only "Fit" before anything has been measured, and presents at the fallback', () => {
    render(<Harness />);
    expect(screen.getByTestId('probe-zoom-fit')).toHaveTextContent('Fit');
    expect(screen.getByTestId('probe-zoom-fit')).not.toHaveTextContent('%');
    expect(screen.getByTestId('target')).toHaveTextContent('1.5000');
  });

  test('offers the same presets both panes are required to offer', () => {
    render(<Harness fitScale={1} />);
    const options = [...screen.getByTestId('probe-zoom-preset').querySelectorAll('option')];
    expect(options.map((option) => option.textContent)).toEqual([
      'Fit (100%)',
      '75%',
      '100%',
      '125%',
      '150%',
      '200%',
    ]);
    expect(ZOOM_PRESETS.map((preset) => preset.scale)).toEqual([0.75, 1, 1.25, 1.5, 2]);
  });

  test('pins an explicit scale when a preset is chosen', () => {
    render(<Harness fitScale={0.92} />);
    fireEvent.change(screen.getByTestId('probe-zoom-preset'), { target: { value: '1.25' } });
    expect(screen.getByTestId('target')).toHaveTextContent('1.2500');
    expect(screen.getByTestId('preset')).toHaveTextContent('1.25');
  });

  test('returns to fitting when the fit option is chosen again', () => {
    render(<Harness fitScale={0.92} />);
    fireEvent.change(screen.getByTestId('probe-zoom-preset'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('probe-zoom-preset'), { target: { value: 'fit' } });
    expect(screen.getByTestId('target')).toHaveTextContent('0.9200');
  });

  test('steps by a multiplicative factor from whatever is on screen', () => {
    render(<Harness fitScale={1} />);
    fireEvent.click(screen.getByTestId('probe-zoom-in'));
    expect(screen.getByTestId('target')).toHaveTextContent('1.2500');
    fireEvent.click(screen.getByTestId('probe-zoom-out'));
    expect(screen.getByTestId('target')).toHaveTextContent('1.0000');
  });

  test('surfaces a stepped scale that matches no preset as its own transient option', () => {
    render(<Harness fitScale={0.92} />);
    fireEvent.click(screen.getByTestId('probe-zoom-in'));
    expect(screen.getByTestId('preset')).toHaveTextContent('custom');
    expect(screen.getByTestId('probe-zoom-preset')).toHaveTextContent('115%');
  });

  test('selecting the reflective custom entry changes nothing', () => {
    render(<Harness fitScale={0.92} />);
    fireEvent.click(screen.getByTestId('probe-zoom-in'));
    const before = screen.getByTestId('target').textContent;
    fireEvent.change(screen.getByTestId('probe-zoom-preset'), { target: { value: 'custom' } });
    expect(screen.getByTestId('target')).toHaveTextContent(before ?? '');
  });

  test('clamps to the range both panes are held to, and disables the stepper at each end', () => {
    render(<Harness fitScale={1} />);
    const zoomIn = screen.getByTestId('probe-zoom-in');
    for (let press = 0; press < 12; press++) fireEvent.click(zoomIn);
    expect(screen.getByTestId('target')).toHaveTextContent(MAX_ZOOM.toFixed(4));
    expect(zoomIn).toBeDisabled();

    const zoomOut = screen.getByTestId('probe-zoom-out');
    for (let press = 0; press < 24; press++) fireEvent.click(zoomOut);
    expect(screen.getByTestId('target')).toHaveTextContent(MIN_ZOOM.toFixed(4));
    expect(zoomOut).toBeDisabled();
  });

  test('clamps a fit that would exceed the range rather than presenting beyond it', () => {
    render(<Harness fitScale={99} />);
    expect(screen.getByTestId('target')).toHaveTextContent(MAX_ZOOM.toFixed(4));
  });

  test('keeps every control reachable by keyboard and named for a screen reader', () => {
    render(<Harness fitScale={1} />);
    expect(screen.getByRole('button', { name: 'zoom out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'zoom in' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'zoom level' })).toBeInTheDocument();
  });

  test('namespaces its test ids so two panes on screen stay individually addressable', () => {
    render(
      <div>
        <Harness fitScale={1} />
        <PreviewZoomControl
          zoom={{
            targetScale: 1,
            presetValue: 'fit',
            livePercentLabel: '100%',
            fitOptionLabel: 'Fit',
            canZoomIn: true,
            canZoomOut: true,
            zoomIn: jest.fn(),
            zoomOut: jest.fn(),
            selectPreset: jest.fn(),
          }}
          testIdPrefix="other"
        />
      </div>,
    );
    expect(screen.getByTestId('probe-zoom-in')).toBeInTheDocument();
    expect(screen.getByTestId('other-zoom-in')).toBeInTheDocument();
  });
});
