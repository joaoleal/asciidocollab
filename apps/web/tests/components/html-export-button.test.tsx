import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { HtmlExportButton } from '@/components/html-export-button';

describe('HtmlExportButton', () => {
  test('renders the actionable export trigger when idle', () => {
    render(<HtmlExportButton onExport={jest.fn()} isExporting={false} />);
    const button = screen.getByRole('button', { name: /export to html/i });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-busy', 'false');
  });

  test('invokes onExport when the idle trigger is clicked', () => {
    const onExport = jest.fn();
    render(<HtmlExportButton onExport={onExport} isExporting={false} />);
    fireEvent.click(screen.getByRole('button', { name: /export to html/i }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  test('while exporting it is busy, disabled, and surfaces the phase progress', () => {
    render(<HtmlExportButton onExport={jest.fn()} isExporting phase="assets" />);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(/images/i);
  });

  test('shows a starting message before the first phase arrives', () => {
    render(<HtmlExportButton onExport={jest.fn()} isExporting />);
    expect(screen.getByRole('status')).toHaveTextContent(/\w/);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  test('does not invoke onExport while exporting', () => {
    const onExport = jest.fn();
    render(<HtmlExportButton onExport={onExport} isExporting phase="rendering" />);
    fireEvent.click(screen.getByRole('button'));
    expect(onExport).not.toHaveBeenCalled();
  });

  test('is inert when disabled, so an export cannot be taken without a document', () => {
    const onExport = jest.fn();
    render(<HtmlExportButton onExport={onExport} isExporting={false} disabled />);
    const button = screen.getByRole('button', { name: /export to html/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onExport).not.toHaveBeenCalled();
  });
});
