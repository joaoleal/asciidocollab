import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReviewItemDto, ThreadDto } from '@asciidocollab/shared';
import type { UseReviewItemsResult } from '@/hooks/use-review-items';
import { CommentRail } from '@/components/review/comment-rail';
import { ReviewViewStateProvider } from '@/components/review/view-state';
import { useReviewItems } from '@/hooks/use-review-items';

jest.mock('@/components/avatar', () => ({
  Avatar: ({ displayName, avatarKey }: { displayName: string; avatarKey: string | null }) =>
    require('react').createElement('span', { 'data-testid': 'avatar', 'data-avatar-key': avatarKey ?? '', 'aria-label': displayName }),
}));

jest.mock('@/hooks/use-review-items', () => ({ useReviewItems: jest.fn() }));

jest.mock('@/lib/api/review', () => ({
  reactToItem: jest.fn(),
  resolveReviewItem: jest.fn(),
  createReviewItem: jest.fn(),
  replyToThread: jest.fn(),
}));

jest.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const mockHook = useReviewItems as jest.MockedFunction<typeof useReviewItems>;
const setIncludeResolved = jest.fn();

const item = (overrides: Partial<ReviewItemDto> = {}): ReviewItemDto => ({
  id: 'r1',
  documentId: 'd1',
  projectId: 'p1',
  kind: 'comment',
  body: 'body',
  author: { id: 'u1', displayName: 'Alice', avatarKey: null },
  reactions: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const thread = (root: Partial<ReviewItemDto>): ThreadDto => ({ root: item(root), replies: [] });

function primeHook(threads: ThreadDto[], overrides: Partial<UseReviewItemsResult> = {}) {
  mockHook.mockReturnValue({
    threads,
    ranges: [],
    anchorStates: new Map(),
    loading: false,
    error: null,
    refetch: jest.fn(),
    includeResolved: false,
    setIncludeResolved,
    ...overrides,
  } satisfies UseReviewItemsResult);
}

const renderRail = () =>
  render(<CommentRail projectId="p1" documentId="d1" ydoc={null} role="editor" />);

describe('CommentRail', () => {
  beforeEach(() => {
    setIncludeResolved.mockReset();
    mockHook.mockReset();
  });

  test('renders the rail shell with a count', () => {
    primeHook([thread({ id: 'c1' }), thread({ id: 'c2' })]);
    renderRail();
    expect(screen.getByTestId('comment-rail')).toBeInTheDocument();
    expect(screen.getByTestId('comment-rail-count')).toHaveTextContent('2');
  });

  test('defaults to Open (excludes resolved) on mount', () => {
    primeHook([]);
    renderRail();
    // The Open→All→Tasks effect runs on mount with mode=open.
    expect(setIncludeResolved).toHaveBeenLastCalledWith(false);
  });

  test('the All filter includes resolved items', () => {
    primeHook([thread({ id: 'c1' })]);
    renderRail();
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(setIncludeResolved).toHaveBeenLastCalledWith(true);
  });

  test('the Tasks filter shows only task threads', () => {
    primeHook([thread({ id: 'c1', kind: 'comment', body: 'a comment' }), thread({ id: 't1', kind: 'task', status: 'open', body: 'a task' })]);
    renderRail();
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    expect(screen.getByText('a task')).toBeInTheDocument();
    expect(screen.queryByText('a comment')).not.toBeInTheDocument();
    expect(screen.getByTestId('comment-rail-count')).toHaveTextContent('1');
  });

  test('shows the empty state when there are no threads', () => {
    primeHook([]);
    renderRail();
    expect(screen.getByTestId('comment-rail-empty')).toBeInTheDocument();
  });

  test('observers get a read-only rail (no reply controls)', () => {
    primeHook([thread({ id: 'c1' })]);
    render(<CommentRail projectId="p1" documentId="d1" ydoc={null} role="observer" />);
    expect(screen.queryByRole('button', { name: /reply/i })).not.toBeInTheDocument();
  });

  test('surfaces a load error', () => {
    primeHook([], { error: new Error('offline') });
    renderRail();
    expect(screen.getByRole('alert')).toHaveTextContent('offline');
  });

  test('a pending anchor pins the new-comment composer for an editor', () => {
    primeHook([]);
    render(
      <CommentRail
        projectId="p1"
        documentId="d1"
        ydoc={null}
        role="editor"
        pendingAnchor={{ quote: { prefix: '', exact: 'x', suffix: '' }, lineHint: 1 }}
      />,
    );
    expect(screen.getByTestId('comment-composer')).toBeInTheDocument();
  });

  test('an observer never sees the pending composer', () => {
    primeHook([]);
    render(
      <CommentRail
        projectId="p1"
        documentId="d1"
        ydoc={null}
        role="observer"
        pendingAnchor={{ quote: { prefix: '', exact: 'x', suffix: '' }, lineHint: 1 }}
      />,
    );
    expect(screen.queryByTestId('comment-composer')).not.toBeInTheDocument();
  });

  test('a detached item is routed to the tray rather than the card list', () => {
    primeHook([thread({ id: 'gone', body: 'orphaned' })], {
      anchorStates: new Map([['gone', 'detached']]),
    });
    renderRail();
    expect(screen.getByTestId('detached-tray')).toBeInTheDocument();
    expect(screen.queryByTestId('review-thread-card')).not.toBeInTheDocument();
  });

  test('renders the cards in document order, not in the order the server returned them', () => {
    primeHook(
      [
        thread({ id: 'bottom', createdAt: '2026-01-01T00:00:00.000Z' }),
        thread({ id: 'top', createdAt: '2026-01-03T00:00:00.000Z' }),
        thread({ id: 'middle', createdAt: '2026-01-02T00:00:00.000Z' }),
      ],
      {
        ranges: [
          { id: 'bottom', from: 900, to: 910 },
          { id: 'top', from: 4, to: 9 },
          { id: 'middle', from: 120, to: 130 },
        ],
      },
    );
    renderRail();
    const ids = screen.getAllByTestId('review-thread-card').map((card) => card.dataset.itemId);
    expect(ids).toEqual(['top', 'middle', 'bottom']);
  });

  test('a card whose anchor has not resolved sorts after every located card', () => {
    primeHook(
      [
        thread({ id: 'unresolved', createdAt: '2026-01-01T00:00:00.000Z' }),
        thread({ id: 'located', createdAt: '2026-01-05T00:00:00.000Z' }),
      ],
      { ranges: [{ id: 'located', from: 50, to: 60 }] },
    );
    renderRail();
    const ids = screen.getAllByTestId('review-thread-card').map((card) => card.dataset.itemId);
    expect(ids).toEqual(['located', 'unresolved']);
  });

  test('shows a tasks-specific empty state under the Tasks filter', () => {
    primeHook([thread({ id: 'c1', kind: 'comment' })]);
    renderRail();

    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));

    expect(screen.getByTestId('comment-rail-empty')).toHaveTextContent('No tasks yet.');
  });

  test('submitting the pinned composer refreshes the rail and notifies the layout', async () => {
    const refetch = jest.fn();
    const onMutated = jest.fn();
    const onPendingResolved = jest.fn();
    primeHook([], { refetch });
    render(
      <CommentRail
        projectId="p1"
        documentId="d1"
        ydoc={null}
        role="editor"
        pendingAnchor={{ quote: { prefix: '', exact: 'x', suffix: '' }, lineHint: 1 }}
        onPendingResolved={onPendingResolved}
        onMutated={onMutated}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: 'looks good' } });
    fireEvent.click(screen.getByTestId('review-composer-submit'));

    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(onMutated).toHaveBeenCalled();
    expect(onPendingResolved).toHaveBeenCalled();
  });

  test('submitting the pinned composer without listeners still refreshes the rail', async () => {
    const refetch = jest.fn();
    primeHook([], { refetch });
    render(
      <CommentRail
        projectId="p1"
        documentId="d1"
        ydoc={null}
        role="editor"
        pendingAnchor={{ quote: { prefix: '', exact: 'x', suffix: '' }, lineHint: 1 }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: 'looks good' } });
    fireEvent.click(screen.getByTestId('review-composer-submit'));

    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  test('cancelling the pinned composer clears the captured selection', () => {
    const onPendingResolved = jest.fn();
    primeHook([]);
    render(
      <CommentRail
        projectId="p1"
        documentId="d1"
        ydoc={null}
        role="editor"
        pendingAnchor={{ quote: { prefix: '', exact: 'x', suffix: '' }, lineHint: 1 }}
        onPendingResolved={onPendingResolved}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onPendingResolved).toHaveBeenCalled();
  });

  test('cancelling the pinned composer without a listener leaves it mounted', () => {
    primeHook([]);
    render(
      <CommentRail
        projectId="p1"
        documentId="d1"
        ydoc={null}
        role="editor"
        pendingAnchor={{ quote: { prefix: '', exact: 'x', suffix: '' }, lineHint: 1 }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByTestId('comment-composer')).toBeInTheDocument();
  });

  test('adopts the ambient view-state when no overrides are passed', () => {
    primeHook([thread({ id: 'c1' })]);
    render(
      <ReviewViewStateProvider>
        <CommentRail projectId="p1" documentId="d1" ydoc={null} role="editor" />
      </ReviewViewStateProvider>,
    );

    const card = screen.getByTestId('review-thread-card');
    fireEvent.mouseEnter(card);
    expect(screen.getByTestId('review-thread-card')).toHaveAttribute('data-hovered');

    fireEvent.click(card);
    expect(screen.getByTestId('review-thread-card')).toHaveAttribute('data-active');
  });

  test('explicit view-state props win over the ambient provider', () => {
    const setHoveredItemId = jest.fn();
    const setActiveThreadId = jest.fn();
    primeHook([thread({ id: 'c1' })]);
    render(
      <ReviewViewStateProvider>
        <CommentRail
          projectId="p1"
          documentId="d1"
          ydoc={null}
          role="editor"
          hoveredItemId="c1"
          setHoveredItemId={setHoveredItemId}
          activeThreadId="c1"
          setActiveThreadId={setActiveThreadId}
        />
      </ReviewViewStateProvider>,
    );

    const card = screen.getByTestId('review-thread-card');
    expect(card).toHaveAttribute('data-hovered');
    expect(card).toHaveAttribute('data-active');

    fireEvent.mouseEnter(card);
    expect(setHoveredItemId).toHaveBeenCalledWith('c1');
    fireEvent.click(card);
    expect(setActiveThreadId).toHaveBeenCalledWith('c1');
  });

  test('the signed-in author gets an Edit control on their own item', () => {
    primeHook([thread({ id: 'mine', author: { id: 'me', displayName: 'Me', avatarKey: null } })]);
    render(<CommentRail projectId="p1" documentId="d1" ydoc={null} role="editor" currentUserId="me" />);
    expect(screen.getByTestId('review-edit')).toBeInTheDocument();
  });
});
