import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PanelViewTabs, type PanelViewTab } from '@/components/editor/panel-view-tabs';

type SubView = 'comments' | 'tasks';

const TABS: readonly PanelViewTab<SubView>[] = [
  { id: 'comments', label: 'All comments & tasks', testId: 'panel-tab-comments' },
  { id: 'tasks', label: 'Tasks' },
];

describe('PanelViewTabs', () => {
  test('renders one tab per entry inside a named tablist', () => {
    render(<PanelViewTabs label="Review sub-views" tabs={TABS} active="comments" onChange={jest.fn()} />);
    const tablist = screen.getByRole('tablist', { name: 'Review sub-views' });
    expect(tablist).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  test('marks only the active tab as selected', () => {
    render(<PanelViewTabs label="Review sub-views" tabs={TABS} active="tasks" onChange={jest.fn()} />);
    expect(screen.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'All comments & tasks' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  test('keeps the stable test id an end-to-end spec selects on', () => {
    render(<PanelViewTabs label="Review sub-views" tabs={TABS} active="comments" onChange={jest.fn()} />);
    expect(screen.getByTestId('panel-tab-comments')).toHaveTextContent('All comments & tasks');
  });

  test('reports the activated tab id to the change handler', () => {
    const onChange = jest.fn();
    render(<PanelViewTabs label="Review sub-views" tabs={TABS} active="comments" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    expect(onChange).toHaveBeenCalledWith('tasks');
  });

  test('renders extra controls at the right edge of the same row when given children', () => {
    render(
      <PanelViewTabs label="Review sub-views" tabs={TABS} active="comments" onChange={jest.fn()}>
        <button type="button">Refresh</button>
      </PanelViewTabs>,
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  test('omits the trailing control slot when no children are given', () => {
    const { container } = render(
      <PanelViewTabs label="Review sub-views" tabs={TABS} active="comments" onChange={jest.fn()} />,
    );
    expect(container.querySelector('.ml-auto')).toBeNull();
  });
});
