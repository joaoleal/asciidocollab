import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReviewItemDto, ThreadDto } from '@asciidocollab/shared';
import { ReviewThreadCard } from '@/components/review/thread-card';

jest.mock('@/components/avatar', () => ({
  Avatar: ({ displayName, avatarKey }: { displayName: string; avatarKey: string | null }) =>
    require('react').createElement('span', { 'data-testid': 'avatar', 'data-avatar-key': avatarKey ?? '', 'aria-label': displayName }),
}));

jest.mock('@/lib/api/review', () => ({
  reactToItem: jest.fn(),
  resolveReviewItem: jest.fn().mockResolvedValue({}),
  createReviewItem: jest.fn(),
  replyToThread: jest.fn(),
  editReviewItem: jest.fn().mockResolvedValue({}),
}));

jest.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const item = (overrides: Partial<ReviewItemDto> = {}): ReviewItemDto => ({
  id: 'r1',
  documentId: 'd1',
  projectId: 'p1',
  kind: 'comment',
  body: 'Hello world',
  author: { id: 'u1', displayName: 'Alice Smith', avatarKey: null },
  reactions: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const thread = (rootOverrides: Partial<ReviewItemDto> = {}, replies: ReviewItemDto[] = []): ThreadDto => ({
  root: item(rootOverrides),
  replies,
});

describe('ReviewThreadCard', () => {
  test('renders the root body and author name', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
  });

  test('renders "Deleted user" when the author is null', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread({ author: null })} />);
    expect(screen.getByText('Deleted user')).toBeInTheDocument();
  });

  test('shows a status badge for a task', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread({ kind: 'task', status: 'in_progress' })} />);
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  test('renders replies', () => {
    const reply = item({ id: 'r2', body: 'A reply', author: { id: 'u2', displayName: 'Bob', avatarKey: null } });
    render(<ReviewThreadCard projectId="p1" thread={thread({}, [reply])} />);
    expect(screen.getByText('A reply')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  test('shows Reply and Resolve controls for an unresolved comment', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} />);
    expect(screen.getByRole('button', { name: /reply/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resolve/i })).toBeInTheDocument();
  });

  test('hides Resolve for a task (status drives task resolution instead)', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread({ kind: 'task', status: 'open' })} />);
    expect(screen.queryByRole('button', { name: /resolve/i })).not.toBeInTheDocument();
  });

  test('readOnly hides all mutation controls', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} readOnly />);
    expect(screen.queryByRole('button', { name: /reply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resolve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /thread actions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add reaction/i })).not.toBeInTheDocument();
  });

  test('hovering publishes the root id and clicking activates it', () => {
    const setHovered = jest.fn();
    const setActive = jest.fn();
    render(
      <ReviewThreadCard
        projectId="p1"
        thread={thread()}
        setHoveredItemId={setHovered}
        setActiveThreadId={setActive}
      />,
    );
    const card = screen.getByTestId('review-thread-card');
    fireEvent.mouseEnter(card);
    expect(setHovered).toHaveBeenCalledWith('r1');
    fireEvent.mouseLeave(card);
    expect(setHovered).toHaveBeenCalledWith(null);
    fireEvent.click(card);
    expect(setActive).toHaveBeenCalledWith('r1');
  });

  test('shows an Edit control for the signed-in user\'s own comment', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} currentUserId="u1" />);
    expect(screen.getByTestId('review-edit')).toBeInTheDocument();
  });

  test('hides Edit when the signed-in user is not the author', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} currentUserId="someone-else" />);
    expect(screen.queryByTestId('review-edit')).not.toBeInTheDocument();
  });

  test('hides Edit in read-only mode even for the author', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} currentUserId="u1" readOnly />);
    expect(screen.queryByTestId('review-edit')).not.toBeInTheDocument();
  });

  test('editing opens the composer prefilled and saves the new body', async () => {
    const { editReviewItem } = jest.requireMock('@/lib/api/review');
    const onChanged = jest.fn();
    render(<ReviewThreadCard projectId="p1" thread={thread()} currentUserId="u1" onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId('review-edit'));
    const textarea = screen.getByDisplayValue('Hello world');
    fireEvent.change(textarea, { target: { value: 'Edited body' } });
    fireEvent.click(screen.getByTestId('review-composer-submit'));

    await waitFor(() => expect(editReviewItem).toHaveBeenCalledWith('p1', 'r1', { body: 'Edited body' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test('the author can edit their own reply', async () => {
    const { editReviewItem } = jest.requireMock('@/lib/api/review');
    const reply = item({ id: 'r2', body: 'my reply', author: { id: 'u1', displayName: 'Me', avatarKey: null } });
    render(<ReviewThreadCard projectId="p1" thread={thread({}, [reply])} currentUserId="u1" />);

    // Root + reply are both authored by u1 → two Edit controls. Replies render
    // above the root action row, so the reply's Edit button comes first.
    const editButtons = screen.getAllByTestId('review-edit');
    expect(editButtons).toHaveLength(2);

    fireEvent.click(editButtons[0]);
    const textarea = screen.getByDisplayValue('my reply');
    fireEvent.change(textarea, { target: { value: 'my edited reply' } });
    fireEvent.click(screen.getByTestId('review-composer-submit'));

    await waitFor(() => expect(editReviewItem).toHaveBeenCalledWith('p1', 'r2', { body: 'my edited reply' }));
  });

  test('opening Reply shows the composer and submitting appends a reply', async () => {
    const { replyToThread } = jest.requireMock('@/lib/api/review');
    const onChanged = jest.fn();
    render(<ReviewThreadCard projectId="p1" thread={thread()} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId('review-reply'));
    const textarea = screen.getByPlaceholderText('Write a reply…');
    fireEvent.change(textarea, { target: { value: 'a reply' } });
    fireEvent.click(screen.getByTestId('review-composer-submit'));

    await waitFor(() => expect(replyToThread).toHaveBeenCalledWith('p1', 'r1', { body: 'a reply' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test('clicking Resolve resolves the thread', async () => {
    const { resolveReviewItem } = jest.requireMock('@/lib/api/review');
    const onChanged = jest.fn();
    render(<ReviewThreadCard projectId="p1" thread={thread()} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId('review-resolve'));
    await waitFor(() => expect(resolveReviewItem).toHaveBeenCalledWith('p1', 'r1', false));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test('a section-degraded anchor shows the "On this section" indicator', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} anchorState="section" />);
    expect(screen.getByTestId('thread-card-section-indicator')).toBeInTheDocument();
  });

  test('renders the per-item overflow menu extra slot', () => {
    render(
      <ReviewThreadCard projectId="p1" thread={thread()} itemMenuExtra={<span>delete-slot</span>} />,
    );
    expect(screen.getByText('delete-slot')).toBeInTheDocument();
  });

  test('a resolved comment is dimmed, hides Resolve, and offers Reopen', () => {
    render(
      <ReviewThreadCard
        projectId="p1"
        thread={thread({ resolvedAt: new Date().toISOString() })}
      />,
    );
    expect(screen.getByTestId('review-thread-card')).toHaveClass('opacity-75');
    expect(screen.queryByTestId('review-resolve')).not.toBeInTheDocument();
    expect(screen.getByTestId('review-reopen')).toBeInTheDocument();
  });

  test('clicking Reopen reopens the thread', async () => {
    const { resolveReviewItem } = jest.requireMock('@/lib/api/review');
    const onChanged = jest.fn();
    render(
      <ReviewThreadCard
        projectId="p1"
        thread={thread({ resolvedAt: new Date().toISOString() })}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByTestId('review-reopen'));
    await waitFor(() => expect(resolveReviewItem).toHaveBeenCalledWith('p1', 'r1', true));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test('cancelling the reply composer closes it', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} />);
    fireEvent.click(screen.getByTestId('review-reply'));
    expect(screen.getByPlaceholderText('Write a reply…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Write a reply…')).not.toBeInTheDocument();
  });

  test('the thread-actions menu trigger renders and is clickable', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} itemMenuExtra={<span>slot</span>} />);
    const trigger = screen.getByRole('button', { name: 'Thread actions' });
    fireEvent.click(trigger);
    expect(trigger).toBeInTheDocument();
  });

  test('reacting on the root forwards the change to onChanged', async () => {
    const mock = jest.requireMock('@/lib/api/review');
    mock.reactToItem.mockResolvedValueOnce([]);
    const onChanged = jest.fn();
    const reaction = { emoji: '👍', count: 1, reactedByMe: false, userIds: ['u9'] };
    render(<ReviewThreadCard projectId="p1" thread={thread({ reactions: [reaction] })} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId('review-reaction-👍'));
    await waitFor(() => expect(mock.reactToItem).toHaveBeenCalledWith('p1', 'r1', { emoji: '👍' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test('applies hovered and active emphasis styling from props', () => {
    render(
      <ReviewThreadCard projectId="p1" thread={thread()} hoveredItemId="r1" activeThreadId="r1" />,
    );
    const card = screen.getByTestId('review-thread-card');
    expect(card).toHaveClass('border-primary');
    expect(card).toHaveAttribute('data-active');
  });

  test('an editor-driven hover marks the card hovered (distinct from active)', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} hoveredItemId="r1" />);
    const card = screen.getByTestId('review-thread-card');
    expect(card).toHaveAttribute('data-hovered');
    expect(card).toHaveClass('bg-primary/5');
    expect(card).not.toHaveAttribute('data-active');
  });

  test('hides Edit for an item whose author was deleted', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread({ author: null })} currentUserId="u1" />);
    expect(screen.queryByTestId('review-edit')).not.toBeInTheDocument();
  });

  test('cancelling the inline edit composer restores the rendered body', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} currentUserId="u1" />);

    fireEvent.click(screen.getByTestId('review-edit'));
    expect(screen.getByDisplayValue('Hello world')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByDisplayValue('Hello world')).not.toBeInTheDocument();
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  test('a hover that settles reveals the card inside the scrolling rail', () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    const scrollIntoView = jest.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    jest.useFakeTimers();
    try {
      render(<ReviewThreadCard projectId="p1" thread={thread()} hoveredItemId="r1" />);
      act(() => {
        jest.advanceTimersByTime(200);
      });
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      jest.useRealTimers();
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
    }
  });

  test('degrades silently on an engine that does not implement scrollIntoView', () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    jest.useFakeTimers();
    try {
      render(<ReviewThreadCard projectId="p1" thread={thread()} hoveredItemId="r1" />);
      act(() => {
        jest.advanceTimersByTime(200);
      });
      expect(screen.getByTestId('review-thread-card')).toHaveAttribute('data-hovered');
    } finally {
      jest.useRealTimers();
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
    }
  });

  test('an unhovered card never schedules a reveal scroll', () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    const scrollIntoView = jest.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    jest.useFakeTimers();
    try {
      render(<ReviewThreadCard projectId="p1" thread={thread()} />);
      act(() => {
        jest.advanceTimersByTime(200);
      });
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
    }
  });

  test('hovering a card wired to no view-state setters is inert', () => {
    render(<ReviewThreadCard projectId="p1" thread={thread()} />);
    const card = screen.getByTestId('review-thread-card');

    fireEvent.mouseEnter(card);
    fireEvent.mouseLeave(card);
    fireEvent.click(card);

    expect(card).not.toHaveAttribute('data-hovered');
    expect(card).not.toHaveAttribute('data-active');
  });

  test('resolving without a change listener still calls the API', async () => {
    const { resolveReviewItem } = jest.requireMock('@/lib/api/review');
    resolveReviewItem.mockClear();
    render(<ReviewThreadCard projectId="p1" thread={thread()} />);

    fireEvent.click(screen.getByTestId('review-resolve'));

    await waitFor(() => expect(resolveReviewItem).toHaveBeenCalledWith('p1', 'r1', false));
  });

  test('submitting a reply without a change listener closes the composer', async () => {
    const { replyToThread } = jest.requireMock('@/lib/api/review');
    replyToThread.mockClear();
    render(<ReviewThreadCard projectId="p1" thread={thread()} />);

    fireEvent.click(screen.getByTestId('review-reply'));
    fireEvent.change(screen.getByPlaceholderText('Write a reply…'), { target: { value: 'ok' } });
    fireEvent.click(screen.getByTestId('review-composer-submit'));

    await waitFor(() => expect(replyToThread).toHaveBeenCalledWith('p1', 'r1', { body: 'ok' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('Write a reply…')).not.toBeInTheDocument());
  });

  test('reacting on a reply forwards the change to onChanged', async () => {
    const mock = jest.requireMock('@/lib/api/review');
    mock.reactToItem.mockResolvedValueOnce([]);
    const onChanged = jest.fn();
    const reply = item({
      id: 'r2',
      body: 'A reply',
      author: { id: 'u2', displayName: 'Bob', avatarKey: null },
      reactions: [{ emoji: '🎉', count: 1, reactedByMe: false, userIds: ['u9'] }],
    });
    render(<ReviewThreadCard projectId="p1" thread={thread({}, [reply])} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId('review-reaction-🎉'));

    await waitFor(() => expect(mock.reactToItem).toHaveBeenCalledWith('p1', 'r2', { emoji: '🎉' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test('renders the taskControls extension slot', () => {
    render(
      <ReviewThreadCard
        projectId="p1"
        thread={thread({ kind: 'task', status: 'open' })}
        taskControls={<span>slot-content</span>}
      />,
    );
    expect(screen.getByText('slot-content')).toBeInTheDocument();
  });
});
