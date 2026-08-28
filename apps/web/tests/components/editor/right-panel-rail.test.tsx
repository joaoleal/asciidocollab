import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { RightPanelRail } from '@/components/editor/right-panel-rail';

describe('RightPanelRail', () => {
  test('renders one tab per view with the active one selected', () => {
    render(<RightPanelRail activeTab="comments" onTabChange={jest.fn()} />);
    const comments = screen.getByRole('tab', { name: 'Comments' });
    const writing = screen.getByRole('tab', { name: 'Writing' });
    expect(comments).toHaveAttribute('aria-selected', 'true');
    expect(writing).toHaveAttribute('aria-selected', 'false');
  });

  test('clicking a tab reports the selected view', () => {
    const onTabChange = jest.fn();
    render(<RightPanelRail activeTab="comments" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Writing' }));
    expect(onTabChange).toHaveBeenCalledWith('writing');
  });

  test('ArrowDown/ArrowUp move between tabs and wrap, like the left panel rail', () => {
    const onTabChange = jest.fn();
    render(<RightPanelRail activeTab="comments" onTabChange={onTabChange} />);
    const comments = screen.getByRole('tab', { name: 'Comments' });
    fireEvent.keyDown(comments, { key: 'ArrowDown' });
    expect(onTabChange).toHaveBeenLastCalledWith('writing');
    // Wrapping: ArrowUp from the first tab lands on the last.
    fireEvent.keyDown(comments, { key: 'ArrowUp' });
    expect(onTabChange).toHaveBeenLastCalledWith('writing');
  });

  test('only the active tab is in the tab order (roving focus)', () => {
    render(<RightPanelRail activeTab="writing" onTabChange={jest.fn()} />);
    expect(screen.getByRole('tab', { name: 'Writing' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Comments' })).toHaveAttribute('tabindex', '-1');
  });

  test('activating the view already showing collapses the panel — the tab is a toggle', () => {
    const onCollapse = jest.fn();
    const onTabChange = jest.fn();
    render(<RightPanelRail activeTab="comments" onTabChange={onTabChange} onCollapse={onCollapse} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Comments' }));
    expect(onCollapse).toHaveBeenCalled();
    expect(onTabChange).not.toHaveBeenCalled();
  });

  test('while collapsed, activating a view selects it AND expands the panel', () => {
    const onExpand = jest.fn();
    const onTabChange = jest.fn();
    const onCollapse = jest.fn();
    render(
      <RightPanelRail
        activeTab="comments"
        onTabChange={onTabChange}
        onCollapse={onCollapse}
        onExpand={onExpand}
        collapsed
      />,
    );
    // Even the already-active view expands rather than toggling — there is nothing to collapse.
    fireEvent.click(screen.getByRole('tab', { name: 'Comments' }));
    expect(onExpand).toHaveBeenCalled();
    expect(onCollapse).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Writing' }));
    expect(onTabChange).toHaveBeenLastCalledWith('writing');
    expect(onExpand).toHaveBeenCalledTimes(2);
  });

  test('the top control switches between collapse and expand with the collapsed state', () => {
    const { rerender } = render(
      <RightPanelRail activeTab="comments" onTabChange={jest.fn()} onCollapse={jest.fn()} onExpand={jest.fn()} />,
    );
    expect(screen.getByLabelText('collapse panel')).toBeInTheDocument();
    expect(screen.queryByLabelText('expand panel')).not.toBeInTheDocument();

    rerender(
      <RightPanelRail activeTab="comments" onTabChange={jest.fn()} onCollapse={jest.fn()} onExpand={jest.fn()} collapsed />,
    );
    expect(screen.getByLabelText('expand panel')).toBeInTheDocument();
    expect(screen.queryByLabelText('collapse panel')).not.toBeInTheDocument();
  });

  test('keeps its tabs and badges while collapsed, so both views stay one click away', () => {
    render(
      <RightPanelRail
        activeTab="comments"
        onTabChange={jest.fn()}
        onExpand={jest.fn()}
        commentCount={2}
        writingCount={21}
        collapsed
      />,
    );
    expect(screen.getByRole('tab', { name: 'Comments' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Writing' })).toBeVisible();
    expect(screen.getByTestId('right-panel-count-comments')).toHaveTextContent('2');
    expect(screen.getByTestId('right-panel-count-writing')).toHaveTextContent('21');
  });

  test('shows the collapse control only when a handler is given', () => {
    const onCollapse = jest.fn();
    const { rerender } = render(<RightPanelRail activeTab="comments" onTabChange={jest.fn()} />);
    expect(screen.queryByLabelText('collapse panel')).not.toBeInTheDocument();
    rerender(<RightPanelRail activeTab="comments" onTabChange={jest.fn()} onCollapse={onCollapse} />);
    fireEvent.click(screen.getByLabelText('collapse panel'));
    expect(onCollapse).toHaveBeenCalled();
  });

  test('badges each view with its count, so the inactive view’s activity stays visible', () => {
    render(<RightPanelRail activeTab="comments" onTabChange={jest.fn()} commentCount={3} writingCount={12} />);
    expect(screen.getByRole('tab', { name: 'Comments' })).toHaveTextContent('3');
    expect(screen.getByRole('tab', { name: 'Writing' })).toHaveTextContent('12');
  });

  test('exposes each badge under a per-view test id, which the review e2e asserts the count on', () => {
    render(<RightPanelRail activeTab="comments" onTabChange={jest.fn()} commentCount={1} writingCount={0} />);
    expect(screen.getByTestId('right-panel-count-comments')).toHaveTextContent('1');
    expect(screen.queryByTestId('right-panel-count-writing')).not.toBeInTheDocument();
  });

  test('renders no badge for a zero or absent count', () => {
    render(<RightPanelRail activeTab="comments" onTabChange={jest.fn()} commentCount={0} />);
    expect(screen.getByRole('tab', { name: 'Comments' })).toHaveTextContent('');
    expect(screen.getByRole('tab', { name: 'Writing' })).toHaveTextContent('');
  });

  test('caps a badge over ninety-nine so it stays inside the icon', () => {
    render(<RightPanelRail activeTab="comments" onTabChange={jest.fn()} commentCount={100} writingCount={99} />);
    expect(screen.getByTestId('right-panel-count-comments')).toHaveTextContent('99+');
    expect(screen.getByTestId('right-panel-count-writing')).toHaveTextContent('99');
  });

  test('leaves keys other than the arrows to the browser', () => {
    const onTabChange = jest.fn();
    render(<RightPanelRail activeTab="comments" onTabChange={onTabChange} />);
    const comments = screen.getByRole('tab', { name: 'Comments' });
    fireEvent.keyDown(comments, { key: 'Enter' });
    fireEvent.keyDown(comments, { key: 'End' });
    expect(onTabChange).not.toHaveBeenCalled();
  });

  test('arrowing to another view while collapsed selects it and reopens the panel', () => {
    const onTabChange = jest.fn();
    const onExpand = jest.fn();
    render(
      <RightPanelRail activeTab="comments" onTabChange={onTabChange} onExpand={onExpand} collapsed />,
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Comments' }), { key: 'ArrowDown' });
    expect(onTabChange).toHaveBeenLastCalledWith('writing');
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  test('arrowing while collapsed still selects the view when no expand handler is given', () => {
    const onTabChange = jest.fn();
    render(<RightPanelRail activeTab="writing" onTabChange={onTabChange} collapsed />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Writing' }), { key: 'ArrowUp' });
    expect(onTabChange).toHaveBeenLastCalledWith('comments');
  });

  test('clicking a view while collapsed still selects it when no expand handler is given', () => {
    const onTabChange = jest.fn();
    const onCollapse = jest.fn();
    render(
      <RightPanelRail
        activeTab="comments"
        onTabChange={onTabChange}
        onCollapse={onCollapse}
        collapsed
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Comments' }));
    expect(onTabChange).toHaveBeenLastCalledWith('comments');
    expect(onCollapse).not.toHaveBeenCalled();
  });

  test('clicking the view already showing is inert when no collapse handler is given', () => {
    const onTabChange = jest.fn();
    render(<RightPanelRail activeTab="writing" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Writing' }));
    expect(onTabChange).not.toHaveBeenCalled();
  });
});
