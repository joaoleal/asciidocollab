import React from 'react';
import { render, screen } from '@testing-library/react';
import { RightPanel } from '@/components/editor/right-panel';

function slots() {
  return {
    commentsSlot: <div data-testid="comments-slot">COMMENTS CONTENT</div>,
    writingSlot: <div data-testid="writing-slot">WRITING CONTENT</div>,
  };
}

function renderPanel(activeTab: 'comments' | 'writing', extra: Record<string, unknown> = {}) {
  return render(<RightPanel activeTab={activeTab} onTabChange={jest.fn()} {...slots()} {...extra} />);
}

describe('RightPanel', () => {
  test('renders the rail and a body with the aria-controls id', () => {
    renderPanel('comments');
    expect(screen.getByRole('tablist', { name: 'Right panel views' })).toBeInTheDocument();
    expect(document.querySelector('#right-panel-body')).not.toBeNull();
  });

  test('keeps BOTH slots mounted; the inactive one is hidden', () => {
    renderPanel('comments');
    const comments = screen.getByTestId('comments-slot');
    const writing = screen.getByTestId('writing-slot');
    expect(comments).toBeInTheDocument();
    expect(writing).toBeInTheDocument();
    expect(writing.closest('[hidden], .hidden')).not.toBeNull();
    expect(comments.closest('[hidden], .hidden')).toBeNull();
  });

  test('activating the writing tab reveals the writing slot only', () => {
    renderPanel('writing');
    expect(screen.getByTestId('writing-slot').closest('[hidden], .hidden')).toBeNull();
    expect(screen.getByTestId('comments-slot').closest('[hidden], .hidden')).not.toBeNull();
  });

  test('switching views flips visibility WITHOUT unmounting either slot', () => {
    // Comment threads keep their scroll position and open thread across a trip to Writing and back.
    const { rerender } = renderPanel('comments');
    const commentsBefore = screen.getByTestId('comments-slot');
    rerender(<RightPanel activeTab="writing" onTabChange={jest.fn()} {...slots()} />);
    expect(screen.getByTestId('comments-slot')).toBe(commentsBefore);
    expect(screen.getByTestId('comments-slot').closest('[hidden], .hidden')).not.toBeNull();
    expect(screen.getByTestId('writing-slot').closest('[hidden], .hidden')).toBeNull();
  });

  test('renders no control row of its own — each view owns its controls', () => {
    renderPanel('comments');
    // Only the rail's tablist exists at the panel level; view controls come from the slots.
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
  });
});
