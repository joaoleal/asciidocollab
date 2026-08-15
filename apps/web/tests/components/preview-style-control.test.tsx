import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  PreviewStyleControl,
  isPreviewStyleValue,
  PREVIEW_STYLE_DESCRIPTIONS,
  PREVIEW_STYLE_LABELS,
} from '@/components/preview-style-control';

describe('isPreviewStyleValue', () => {
  test('accepts known tokens', () => {
    expect(isPreviewStyleValue('asciidocollab')).toBe(true);
    expect(isPreviewStyleValue('asciidoctor')).toBe(true);
    expect(isPreviewStyleValue('print')).toBe(true);
  });

  test('rejects unknown tokens', () => {
    expect(isPreviewStyleValue('markdown')).toBe(false);
    expect(isPreviewStyleValue('')).toBe(false);
  });
});

describe('PREVIEW_STYLE_LABELS', () => {
  test('maps each token to a display label', () => {
    expect(PREVIEW_STYLE_LABELS.asciidocollab).toBe('Asciidocollab');
    expect(PREVIEW_STYLE_LABELS.asciidoctor).toBe('Asciidoctor');
    expect(PREVIEW_STYLE_LABELS.print).toBe('Print');
  });
});

describe('PREVIEW_STYLE_DESCRIPTIONS', () => {
  test('describes what each option is for, on the same terms', () => {
    for (const token of ['asciidocollab', 'asciidoctor', 'print'] as const) {
      expect(PREVIEW_STYLE_DESCRIPTIONS[token].length).toBeGreaterThan(20);
    }
  });

  test('says the Print style is the live preview rather than the exported document', () => {
    // The label alone reads as "this is the PDF"; the description is where that is corrected.
    expect(PREVIEW_STYLE_DESCRIPTIONS.print).toMatch(/live preview/i);
    expect(PREVIEW_STYLE_DESCRIPTIONS.print).toMatch(/PDF export/i);
  });
});

describe('PreviewStyleControl', () => {
  test('renders every option with the default aria-label', () => {
    render(<PreviewStyleControl value="asciidocollab" onChange={jest.fn()} />);
    expect(screen.getByRole('group', { name: 'Preview style' })).toBeInTheDocument();
    expect(screen.getByTestId('preview-style-asciidocollab')).toBeInTheDocument();
    expect(screen.getByTestId('preview-style-asciidoctor')).toBeInTheDocument();
    expect(screen.getByTestId('preview-style-print')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  test('marks Print active when it is the selected style, and only Print', () => {
    render(<PreviewStyleControl value="print" onChange={jest.fn()} />);
    expect(screen.getByTestId('preview-style-print')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('preview-style-asciidocollab')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('preview-style-asciidoctor')).toHaveAttribute('aria-pressed', 'false');
  });

  test('calls onChange with the print token', () => {
    const onChange = jest.fn();
    render(<PreviewStyleControl value="asciidocollab" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('preview-style-print'));
    expect(onChange).toHaveBeenCalledWith('print');
  });

  test('describes each option to a screen reader on the same terms', () => {
    render(<PreviewStyleControl value="asciidocollab" onChange={jest.fn()} />);
    for (const token of ['asciidocollab', 'asciidoctor', 'print'] as const) {
      expect(screen.getByTestId(`preview-style-${token}`)).toHaveAttribute(
        'aria-description',
        PREVIEW_STYLE_DESCRIPTIONS[token],
      );
    }
  });

  test('rounds only the ends of the group, so the middle option is square on both sides', () => {
    render(<PreviewStyleControl value="asciidocollab" onChange={jest.fn()} />);
    expect(screen.getByTestId('preview-style-asciidocollab')).toHaveClass('rounded-l-[5px]');
    expect(screen.getByTestId('preview-style-asciidoctor')).not.toHaveClass('rounded-r-[5px]');
    expect(screen.getByTestId('preview-style-asciidoctor')).not.toHaveClass('rounded-l-[5px]');
    expect(screen.getByTestId('preview-style-print')).toHaveClass('rounded-r-[5px]');
  });

  test('marks the active option with aria-pressed', () => {
    render(<PreviewStyleControl value="asciidoctor" onChange={jest.fn()} />);
    expect(screen.getByTestId('preview-style-asciidoctor')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('preview-style-asciidocollab')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('calls onChange with the picked option', () => {
    const onChange = jest.fn();
    render(<PreviewStyleControl value="asciidocollab" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('preview-style-asciidoctor'));
    expect(onChange).toHaveBeenCalledWith('asciidoctor');
  });

  test('applies compact sizing when compact is set', () => {
    render(<PreviewStyleControl value="asciidocollab" onChange={jest.fn()} compact={true} />);
    expect(screen.getByRole('group')).toHaveClass('h-6');
    expect(screen.getByTestId('preview-style-asciidocollab')).toHaveClass('text-xs');
  });

  test('applies regular sizing when compact is not set', () => {
    render(<PreviewStyleControl value="asciidocollab" onChange={jest.fn()} />);
    expect(screen.getByRole('group')).toHaveClass('h-9');
    expect(screen.getByTestId('preview-style-asciidocollab')).toHaveClass('text-sm');
  });

  test('honours a custom aria-label', () => {
    render(
      <PreviewStyleControl value="asciidocollab" onChange={jest.fn()} ariaLabel="Render mode" />,
    );
    expect(screen.getByRole('group', { name: 'Render mode' })).toBeInTheDocument();
  });
});
