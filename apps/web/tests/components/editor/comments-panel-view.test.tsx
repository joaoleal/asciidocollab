import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommentsPanelView } from '@/components/editor/comments-panel-view';

jest.mock('@/components/review', () => ({
  CommentRail: () => require('react').createElement('div', { 'data-testid': 'comment-rail-stub' }),
  TaskPanel: () => require('react').createElement('div', { 'data-testid': 'task-panel-stub' }),
}));

const noop = jest.fn();

/** Renders the view with the wiring every test shares, plus the per-test overrides. */
function renderView(overrides: Partial<React.ComponentProps<typeof CommentsPanelView>> = {}) {
  const properties: React.ComponentProps<typeof CommentsPanelView> = {
    view: 'threads',
    onViewChange: jest.fn(),
    canStepThreads: false,
    onStepThread: jest.fn(),
    projectId: 'p1',
    documentId: 'd1',
    ydoc: null,
    role: 'editor',
    currentUserId: 'u1',
    isProjectOwner: false,
    enabled: true,
    members: [],
    pendingAnchor: null,
    onPendingResolved: noop,
    hoveredItemId: null,
    setHoveredItemId: noop,
    activeThreadId: null,
    setActiveThreadId: noop,
    onReattach: noop,
    onMutated: noop,
    onNavigateToItem: noop,
    ...overrides,
  };
  return render(<CommentsPanelView {...properties} />);
}

describe('CommentsPanelView', () => {
  test('announces itself with a "Comments" header, exactly once', () => {
    renderView();
    expect(screen.getAllByText('Comments')).toHaveLength(1);
  });

  test('renders the view tabs under the header with their pinned test ids', () => {
    renderView();
    const threads = screen.getByTestId('comments-view-threads');
    const tasks = screen.getByTestId('comments-view-tasks');
    expect(threads).toHaveAttribute('role', 'tab');
    expect(threads).toHaveAttribute('aria-selected', 'true');
    expect(tasks).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tablist', { name: 'Comments view' })).toBeInTheDocument();
  });

  test('selecting a tab reports the new sub-view', () => {
    const onViewChange = jest.fn();
    renderView({ onViewChange });
    fireEvent.click(screen.getByTestId('comments-view-tasks'));
    expect(onViewChange).toHaveBeenCalledWith('tasks');
  });

  test('shows the open file threads or the project-wide list, per the active tab', () => {
    const { unmount } = renderView();
    expect(screen.getByTestId('comment-rail-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('task-panel-stub')).toBeNull();
    unmount();

    renderView({ view: 'tasks' });
    expect(screen.getByTestId('task-panel-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('comment-rail-stub')).toBeNull();
  });

  test('puts the prev/next thread walk in the header, like the left panel puts its actions there', () => {
    const onStepThread = jest.fn();
    renderView({ canStepThreads: true, onStepThread });
    const next = screen.getByRole('button', { name: 'Next comment' });
    expect(screen.getByText('Comments').parentElement).toBe(next.parentElement?.parentElement);
    fireEvent.click(next);
    fireEvent.click(screen.getByRole('button', { name: 'Previous comment' }));
    expect(onStepThread).toHaveBeenNthCalledWith(1, 1);
    expect(onStepThread).toHaveBeenNthCalledWith(2, -1);
  });

  test('hides the thread walk when there is nothing to step through', () => {
    renderView({ canStepThreads: false });
    expect(screen.queryByRole('button', { name: 'Next comment' })).toBeNull();
  });
});
