import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { AnchorDto, AnchorState, ReviewItemDto } from '@asciidocollab/shared';
import { TaskPanel } from '@/components/review/task-panel';
import { listProjectReviewItems, bulkDeleteProject } from '@/lib/api/review';
import { useFileTreeEvents } from '@/hooks/use-file-tree-events';

jest.mock('@/components/avatar', () => ({
  Avatar: ({ displayName, avatarKey }: { displayName: string; avatarKey: string | null }) =>
    require('react').createElement('span', { 'data-testid': 'avatar', 'data-avatar-key': avatarKey ?? '', 'aria-label': displayName }),
}));

// Render the ⋯ menu inline so its contents (the project-wide delete / hint) are queryable without
// driving Radix's pointer interactions in jsdom.
jest.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// The project SSE hook is inert in these unit tests.
jest.mock('@/hooks/use-file-tree-events', () => ({ useFileTreeEvents: jest.fn() }));

jest.mock('@/lib/api/review', () => ({
  listProjectReviewItems: jest.fn(),
  resolveReviewItem: jest.fn(),
  reactToItem: jest.fn(),
  createReviewItem: jest.fn(),
  replyToThread: jest.fn(),
  bulkDeleteProject: jest.fn(),
}));

const mockList = listProjectReviewItems as jest.MockedFunction<typeof listProjectReviewItems>;
const mockBulkDelete = bulkDeleteProject as jest.MockedFunction<typeof bulkDeleteProject>;

const task = (overrides: Partial<ReviewItemDto> = {}): ReviewItemDto => ({
  id: 't1',
  documentId: 'd1',
  projectId: 'p1',
  kind: 'task',
  status: 'open',
  body: 'Ship the feature',
  author: { id: 'u1', displayName: 'Alice', avatarKey: null },
  assignee: { id: 'me', displayName: 'Me', avatarKey: null },
  dueDate: '2026-08-01',
  fileNodeId: 'n1',
  fileName: 'guide.adoc',
  reactions: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

/** A faithful root anchor: the wire DTO's required `state` plus the stored line hint. */
const anchored = (line: number, state: AnchorState = 'located'): AnchorDto => ({
  relPos: 'AAAA',
  quote: { prefix: '', exact: 'passage', suffix: '' },
  lineHint: line,
  state,
});

const comment = (overrides: Partial<ReviewItemDto> = {}): ReviewItemDto =>
  task({ id: 'c1', kind: 'comment', status: undefined, body: 'Please clarify', dueDate: undefined, ...overrides });

describe('TaskPanel', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockList.mockResolvedValue([task()]);
  });

  test('renders a row per fetched item', async () => {
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    expect(await screen.findByTestId('task-panel-row')).toBeInTheDocument();
    expect(screen.getByText('Ship the feature')).toBeInTheDocument();
    expect(screen.getByTestId('task-panel-count')).toHaveTextContent('1');
  });

  test('labels each row by its backing file', async () => {
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    const row = await screen.findByTestId('task-panel-row');
    expect(within(row).getByText('guide.adoc')).toBeInTheDocument();
  });

  test('orders rows by file then anchor position, not by the order the server returned', async () => {
    mockList.mockResolvedValue([
      task({ id: 'z-1', documentId: 'd2', fileName: 'zeta.adoc', anchor: anchored(1) }),
      task({ id: 'a-orphan', documentId: 'd1', fileName: 'alpha.adoc', anchor: anchored(2, 'detached') }),
      task({ id: 'a-40', documentId: 'd1', fileName: 'alpha.adoc', anchor: anchored(40) }),
      task({ id: 'a-3', documentId: 'd1', fileName: 'alpha.adoc', anchor: anchored(3) }),
    ]);
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    await waitFor(() => expect(screen.getAllByTestId('task-panel-row')).toHaveLength(4));
    expect(screen.getAllByTestId('task-panel-row').map((row) => row.dataset.itemId)).toEqual([
      'a-3',
      'a-40',
      'a-orphan',
      'z-1',
    ]);
  });

  test('the "Assigned to me" toggle refetches with the current user id', async () => {
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('task-panel-assignee-me'));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith('p1', expect.objectContaining({ assigneeId: 'me' })),
    );
  });

  test('the kind filter narrows the list to comments or tasks without refetching', async () => {
    mockList.mockResolvedValue([task(), comment()]);
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    await waitFor(() => expect(screen.getAllByTestId('task-panel-row')).toHaveLength(2));
    const callsAfterLoad = mockList.mock.calls.length;

    fireEvent.click(screen.getByTestId('task-panel-kind-comment'));
    await waitFor(() => expect(screen.getAllByTestId('task-panel-row')).toHaveLength(1));
    expect(screen.getByText('Please clarify')).toBeInTheDocument();
    expect(screen.queryByText('Ship the feature')).not.toBeInTheDocument();
    // Kind is a client-side filter, so it must not trigger another server fetch.
    expect(mockList).toHaveBeenCalledTimes(callsAfterLoad);
  });

  test('activating a row calls onNavigate with the item', async () => {
    const onNavigate = jest.fn();
    render(<TaskPanel projectId="p1" currentUserId="me" onNavigate={onNavigate} />);
    await screen.findByTestId('task-panel-row');
    fireEvent.click(screen.getByTestId('task-panel-row-open'));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', fileNodeId: 'n1' }));
  });

  test('the document filter refetches for the chosen document', async () => {
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    await screen.findByTestId('task-panel-row');

    fireEvent.change(screen.getByTestId('task-panel-document'), { target: { value: 'd1' } });
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith('p1', expect.objectContaining({ documentId: 'd1' })),
    );
  });

  test('flags an overdue due date on a row', async () => {
    mockList.mockResolvedValue([task({ dueDate: '2000-01-01' })]);
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    const row = await screen.findByTestId('task-panel-row');
    expect(within(row).getByText(/Due/)).toHaveClass('text-destructive');
  });

  test('an unparseable due date renders without crashing', async () => {
    mockList.mockResolvedValue([task({ dueDate: 'whenever' })]);
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    const row = await screen.findByTestId('task-panel-row');
    expect(within(row).getByText(/Due/)).toBeInTheDocument();
  });

  test('a burst of SSE review changes coalesces into a single debounced refetch', async () => {
    jest.useFakeTimers();
    try {
      render(<TaskPanel projectId="p1" currentUserId="me" />);
      // Let the initial fetch settle, then read the SSE handler the panel registered.
      await waitFor(() => expect(mockList).toHaveBeenCalled());
      const before = mockList.mock.calls.length;
      const handlers = (useFileTreeEvents as jest.Mock).mock.calls.at(-1)![1];

      // Three rapid events within the debounce window trigger exactly one refetch.
      handlers.onReviewItemsChanged({ type: 'review-items-changed', documentId: 'd1' });
      handlers.onReviewItemsChanged({ type: 'review-items-changed', documentId: null });
      handlers.onReviewItemsChanged({ type: 'review-items-changed', documentId: 'd2' });
      expect(mockList.mock.calls.length).toBe(before);
      jest.advanceTimersByTime(250);
      expect(mockList.mock.calls.length).toBe(before + 1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('replies are not rendered as standalone rows (the panel lists threads, not replies)', async () => {
    mockList.mockResolvedValue([
      task({ id: 'root', kind: 'comment', status: undefined, body: 'root body' }),
      task({ id: 'reply', parentId: 'root', kind: 'comment', status: undefined, body: 'a reply body' }),
    ]);
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    await screen.findByTestId('task-panel-row');
    expect(screen.getAllByTestId('task-panel-row')).toHaveLength(1);
    expect(screen.queryByText('a reply body')).not.toBeInTheDocument();
    expect(screen.getByTestId('task-panel-count')).toHaveTextContent('1');
  });

  test('confirming the project-wide bulk delete calls the API and refetches', async () => {
    mockBulkDelete.mockResolvedValue({ deleted: 1 });
    render(<TaskPanel projectId="p1" currentUserId="me" isOwner />);
    await screen.findByTestId('task-panel-row');
    const before = mockList.mock.calls.length;

    fireEvent.click(screen.getByTestId('bulk-delete-project'));
    fireEvent.click(screen.getByTestId('bulk-delete-project-confirm'));
    await waitFor(() =>
      expect(mockBulkDelete).toHaveBeenCalledWith('p1', { confirm: true, expectedCount: 1 }),
    );
    await waitFor(() => expect(mockList.mock.calls.length).toBe(before + 1));
  });

  test('shows an empty state naming both comments and tasks', async () => {
    mockList.mockResolvedValue([]);
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    expect(await screen.findByTestId('task-panel-empty')).toHaveTextContent(/comments or tasks/i);
  });

  test('a non-Error rejection still surfaces a load error', async () => {
    mockList.mockRejectedValue('boom');
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn.t load/i);
  });

  test('the status filter refetches with the chosen status', async () => {
    render(<TaskPanel projectId="p1" currentUserId="me" />);
    await screen.findByTestId('task-panel-row');
    fireEvent.click(screen.getByRole('tab', { name: 'In progress' }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith('p1', expect.objectContaining({ status: 'in_progress' })),
    );
  });

  test('the ⋯ menu offers the project-wide delete only to an owner, and only with no filter', async () => {
    const { rerender } = render(<TaskPanel projectId="p1" currentUserId="me" />);
    await screen.findByTestId('task-panel-row');
    // Non-owner: no destructive action in the menu.
    expect(screen.queryByTestId('bulk-delete-project')).not.toBeInTheDocument();

    rerender(<TaskPanel projectId="p1" currentUserId="me" isOwner />);
    await waitFor(() => expect(screen.getByTestId('bulk-delete-project')).toBeInTheDocument());

    // A filter narrows the count below the project total, so the destructive control is withheld
    // in favour of a hint to clear the filters.
    fireEvent.click(screen.getByTestId('task-panel-kind-task'));
    await waitFor(() => expect(screen.queryByTestId('bulk-delete-project')).not.toBeInTheDocument());
    expect(screen.getByText(/Clear the filters/i)).toBeInTheDocument();
  });
});
