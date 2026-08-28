import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { LeftPanelRail } from '@/components/editor/left-panel-rail';

describe('LeftPanelRail', () => {
  test('renders a vertical tablist with a tab per view', () => {
    render(<LeftPanelRail activeTab="files" onTabChange={jest.fn()} />);
    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  test('marks the active tab with aria-selected and points aria-controls at the body', () => {
    render(<LeftPanelRail activeTab="outline" onTabChange={jest.fn()} />);
    const files = screen.getByRole('tab', { name: /files/i });
    const outline = screen.getByRole('tab', { name: /outline/i });
    expect(files).toHaveAttribute('aria-selected', 'false');
    expect(outline).toHaveAttribute('aria-selected', 'true');
    expect(outline).toHaveAttribute('aria-controls', 'left-panel-body');
  });

  test('each tab has an aria-label and a native title tooltip', () => {
    render(<LeftPanelRail activeTab="files" onTabChange={jest.fn()} />);
    const files = screen.getByRole('tab', { name: /files/i });
    expect(files).toHaveAttribute('aria-label', 'Files');
    expect(files).toHaveAttribute('title', 'Files');
  });

  test('clicking a tab calls onTabChange with its id', () => {
    const onTabChange = jest.fn();
    render(<LeftPanelRail activeTab="files" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /outline/i }));
    expect(onTabChange).toHaveBeenCalledWith('outline');
  });

  test('only the active tab is in the roving tab order (tabIndex 0); others -1', () => {
    render(<LeftPanelRail activeTab="files" onTabChange={jest.fn()} />);
    expect(screen.getByRole('tab', { name: /files/i })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: /outline/i })).toHaveAttribute('tabindex', '-1');
  });

  test('ArrowDown moves the active tab to the next view', () => {
    const onTabChange = jest.fn();
    render(<LeftPanelRail activeTab="files" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: /files/i }), { key: 'ArrowDown' });
    expect(onTabChange).toHaveBeenCalledWith('outline');
  });

  test('ArrowUp from the first view wraps to the last', () => {
    const onTabChange = jest.fn();
    render(<LeftPanelRail activeTab="files" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: /files/i }), { key: 'ArrowUp' });
    expect(onTabChange).toHaveBeenCalledWith('search');
  });

  test('renders the Search tab alongside Files and Outline', () => {
    render(<LeftPanelRail activeTab="search" onTabChange={jest.fn()} />);
    const searchTab = screen.getByRole('tab', { name: /search/i });
    expect(searchTab).toHaveAttribute('aria-selected', 'true');
  });

  test('renders a collapse control (always visible) that calls onCollapse', () => {
    const onCollapse = jest.fn();
    render(<LeftPanelRail activeTab="outline" onTabChange={jest.fn()} onCollapse={onCollapse} />);
    // The collapse button is a sibling of the tablist, not a tab — so it is reachable from any view.
    const collapse = screen.getByRole('button', { name: /collapse sidebar/i });
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    fireEvent.click(collapse);
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  test('omits the collapse control when onCollapse is not provided', () => {
    render(<LeftPanelRail activeTab="files" onTabChange={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /collapse sidebar/i })).not.toBeInTheDocument();
  });

  test('leaves keys other than the arrows to the browser', () => {
    const onTabChange = jest.fn();
    render(<LeftPanelRail activeTab="files" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: /files/i }), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('tab', { name: /files/i }), { key: 'Home' });
    expect(onTabChange).not.toHaveBeenCalled();
  });

  test('swaps the top control for an expand control while collapsed', () => {
    const onExpand = jest.fn();
    render(
      <LeftPanelRail
        activeTab="files"
        onTabChange={jest.fn()}
        onCollapse={jest.fn()}
        onExpand={onExpand}
        collapsed
      />,
    );
    expect(screen.queryByRole('button', { name: /collapse sidebar/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /expand sidebar/i }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  test('omits the expand control while collapsed when no expand handler is given', () => {
    render(<LeftPanelRail activeTab="files" onTabChange={jest.fn()} onCollapse={jest.fn()} collapsed />);
    expect(screen.queryByRole('button', { name: /expand sidebar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /collapse sidebar/i })).not.toBeInTheDocument();
  });

  test('arrowing to another view while collapsed selects it and reopens the panel', () => {
    const onTabChange = jest.fn();
    const onExpand = jest.fn();
    render(
      <LeftPanelRail activeTab="files" onTabChange={onTabChange} onExpand={onExpand} collapsed />,
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: /files/i }), { key: 'ArrowDown' });
    expect(onTabChange).toHaveBeenCalledWith('outline');
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  test('arrowing while collapsed still selects the view when no expand handler is given', () => {
    const onTabChange = jest.fn();
    render(<LeftPanelRail activeTab="outline" onTabChange={onTabChange} collapsed />);
    fireEvent.keyDown(screen.getByRole('tab', { name: /outline/i }), { key: 'ArrowUp' });
    expect(onTabChange).toHaveBeenCalledWith('files');
  });

  test('clicking a view while collapsed still selects it when no expand handler is given', () => {
    const onTabChange = jest.fn();
    const onCollapse = jest.fn();
    render(
      <LeftPanelRail
        activeTab="files"
        onTabChange={onTabChange}
        onCollapse={onCollapse}
        collapsed
      />,
    );
    // Even the view already showing selects rather than toggling — there is nothing to collapse.
    fireEvent.click(screen.getByRole('tab', { name: /files/i }));
    expect(onTabChange).toHaveBeenCalledWith('files');
    expect(onCollapse).not.toHaveBeenCalled();
  });

  test('clicking the view already showing collapses the panel — the tab is a toggle', () => {
    const onCollapse = jest.fn();
    const onTabChange = jest.fn();
    render(<LeftPanelRail activeTab="files" onTabChange={onTabChange} onCollapse={onCollapse} />);
    fireEvent.click(screen.getByRole('tab', { name: /files/i }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onTabChange).not.toHaveBeenCalled();
  });

  test('clicking a view while collapsed selects it and reopens the panel', () => {
    const onTabChange = jest.fn();
    const onExpand = jest.fn();
    render(
      <LeftPanelRail activeTab="files" onTabChange={onTabChange} onExpand={onExpand} collapsed />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /search/i }));
    expect(onTabChange).toHaveBeenCalledWith('search');
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  test('clicking the view already showing is inert when no collapse handler is given', () => {
    const onTabChange = jest.fn();
    render(<LeftPanelRail activeTab="search" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /search/i }));
    expect(onTabChange).not.toHaveBeenCalled();
  });
});
