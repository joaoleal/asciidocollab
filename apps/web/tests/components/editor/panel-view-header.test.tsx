import React from 'react';
import { render, screen } from '@testing-library/react';
import { PanelViewHeader } from '@/components/editor/panel-view-header';
import { PanelViewTabs } from '@/components/editor/panel-view-tabs';
import { OutlineView } from '@/components/editor/outline-view';
import { WritingPanelView } from '@/components/editor/writing-panel-view';

jest.mock('@/components/grammar/grammar-rail', () => ({ GrammarRail: () => null }));
jest.mock('@/components/grammar/dictionary-panel', () => ({ DictionaryPanel: () => null }));
jest.mock('@/components/grammar/rules-panel', () => ({ RulesPanel: () => null }));
jest.mock('@/components/grammar/grammar-scope-toggle', () => ({ GrammarScopeToggle: () => null }));

/** Reads the class list of the header row that owns the given title label. */
function headerRowClasses(title: string): string {
  const label = screen.getByText(title);
  return label.parentElement?.className ?? '';
}

describe('PanelViewHeader', () => {
  test('renders the view title as the small uppercase panel label', () => {
    render(<PanelViewHeader title="Comments" />);
    const label = screen.getByText('Comments');
    expect(label.className).toContain('text-xs');
    expect(label.className).toContain('uppercase');
    expect(label.className).toContain('tracking-wide');
    expect(label.className).toContain('text-muted-foreground');
  });

  test('sits on a fixed-height bottom-bordered row', () => {
    render(<PanelViewHeader title="Writing" />);
    expect(headerRowClasses('Writing')).toContain('h-9');
    expect(headerRowClasses('Writing')).toContain('border-b');
  });

  test('pushes the view actions to the right edge of the same row', () => {
    render(
      <PanelViewHeader title="Files">
        <button type="button">Options</button>
      </PanelViewHeader>,
    );
    const actions = screen.getByRole('button', { name: 'Options' }).parentElement;
    expect(actions?.className).toContain('ml-auto');
  });

  test('a left-panel view and a right-panel view render the SAME header row', () => {
    // The whole point of the shared header: a screenshot of either panel is the same design.
    const left = render(<OutlineView entries={[]} currentLine={null} hasDocument onHeadingClick={jest.fn()} />);
    const leftLabel = screen.getByText('Outline');
    const leftRow = leftLabel.parentElement?.className;
    const leftLabelClass = leftLabel.className;
    left.unmount();

    render(<WritingPanelView view="issues" onViewChange={jest.fn()} grammar={null} />);
    const rightLabel = screen.getByText('Writing');
    expect(rightLabel.parentElement?.className).toBe(leftRow);
    expect(rightLabel.className).toBe(leftLabelClass);
  });
});

describe('PanelViewTabs', () => {
  test('renders an ARIA tablist whose selected tab reflects the active id', () => {
    render(
      <PanelViewTabs
        label="Example views"
        tabs={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]}
        active="b"
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByRole('tablist', { name: 'Example views' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true');
  });

  test('keeps every tab at the panel chrome type scale', () => {
    render(
      <PanelViewTabs label="Example views" tabs={[{ id: 'a', label: 'A' }]} active="a" onChange={jest.fn()} />,
    );
    expect(screen.getByRole('tab', { name: 'A' }).className).toContain('text-xs');
  });
});
