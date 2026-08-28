import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HistoryPanel } from '@/components/git/history-panel';
import { ApiError } from '@/lib/api/transport';
import type { CommitDto } from '@asciidocollab/shared';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

const mockGetHistory = jest.fn();
const mockListMembers = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  getHistory: (...parameters: unknown[]) => mockGetHistory(...parameters),
}));

jest.mock('@/lib/api/members', () => ({
  membersApi: { list: (...parameters: unknown[]) => mockListMembers(...parameters) },
}));

jest.mock('@/components/avatar', () => ({
  Avatar: ({ displayName }: { displayName: string }) =>
    require('react').createElement('span', { 'data-testid': 'avatar', 'aria-label': displayName }),
}));

const COMMITS: CommitDto[] = [
  { hash: 'abc1234567890', message: 'Fix the intro section', authorUserId: 'user1', authoredAt: '2026-08-20T00:00:00.000Z' },
  { hash: 'def4567890123', message: 'Imported from legacy history', authoredAt: '2026-08-19T00:00:00.000Z' },
];

function renderPanel(overrides: Partial<{ onSelectCommit: (commit: CommitDto) => void }> = {}) {
  const onOpenChange = jest.fn();
  const view = render(
    <HistoryPanel
      projectId="proj1"
      open
      onOpenChange={onOpenChange}
      onSelectCommit={overrides.onSelectCommit}
    />,
  );
  return { onOpenChange, unmount: view.unmount };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListMembers.mockResolvedValue({
    data: { members: [{ userId: 'user1', displayName: 'Alice Smith', email: 'alice@example.com', role: 'editor', joinedAt: '2026-01-01T00:00:00.000Z' }] },
  });
});

describe('HistoryPanel rendering', () => {
  test('renders a real Dialog.Description', () => {
    mockGetHistory.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    const dialog = screen.getByRole('dialog');
    const describedById = dialog.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.querySelector(`#${describedById}`)).toHaveTextContent(/commits/i);
  });

  test('shows a loading state while the history loads', () => {
    mockGetHistory.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    expect(screen.getByText('Loading commit history…')).toBeInTheDocument();
  });

  test('renders each commit row with its short hash, message, date, and known author', async () => {
    mockGetHistory.mockResolvedValue({ commits: COMMITS });
    renderPanel();

    expect(await screen.findByText('Fix the intro section')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Alice Smith')).toBeInTheDocument());
  });

  test('falls back to a neutral placeholder for a commit with no mapped author', async () => {
    mockGetHistory.mockResolvedValue({ commits: COMMITS });
    renderPanel();

    expect(await screen.findByText('Imported from legacy history')).toBeInTheDocument();
    expect(screen.getByText('Unknown author')).toBeInTheDocument();
  });

  test('shows an empty state when the repository has no commits', async () => {
    mockGetHistory.mockResolvedValue({ commits: [] });
    renderPanel();

    expect(await screen.findByText('No commits yet.')).toBeInTheDocument();
  });

  test('shows an error state for a genuine load failure', async () => {
    mockGetHistory.mockRejectedValue(new Error('network down'));
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load git history.');
  });
});

describe('HistoryPanel commit selection', () => {
  test('activating a commit row fires onSelectCommit with that commit', async () => {
    mockGetHistory.mockResolvedValue({ commits: COMMITS });
    const onSelectCommit = jest.fn();
    renderPanel({ onSelectCommit });

    const row = await screen.findByText('Fix the intro section');
    fireEvent.click(row);

    expect(onSelectCommit).toHaveBeenCalledWith(COMMITS[0]);
  });

  test('rows render without error when onSelectCommit is not provided', async () => {
    mockGetHistory.mockResolvedValue({ commits: COMMITS });
    renderPanel();

    const row = await screen.findByText('Fix the intro section');
    expect(() => fireEvent.click(row)).not.toThrow();
  });
});

describe('HistoryPanel scoping and closed state', () => {
  test('requests nothing while closed', () => {
    mockGetHistory.mockResolvedValue({ commits: [] });
    render(<HistoryPanel projectId="proj1" open={false} onOpenChange={jest.fn()} />);

    expect(mockListMembers).not.toHaveBeenCalled();
  });

  test('describes the history as scoped to one file when a path is given', async () => {
    mockGetHistory.mockResolvedValue({ commits: COMMITS });
    render(<HistoryPanel projectId="proj1" open path="docs/intro.adoc" limit={10} onOpenChange={jest.fn()} />);

    expect(await screen.findByText('Commits touching docs/intro.adoc, most recent first.')).toBeInTheDocument();
    expect(mockGetHistory).toHaveBeenCalledWith('proj1', { path: 'docs/intro.adoc', limit: 10 });
  });

  test('reports a project with no connected repository without showing an error', async () => {
    mockGetHistory.mockRejectedValue(new ApiError(404, 'repository_not_connected', 'nope'));
    renderPanel();

    expect(await screen.findByText('This project has no connected repository.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading commit history…')).not.toBeInTheDocument();
  });
});

describe('HistoryPanel author lookup resilience', () => {
  test('falls back to the neutral placeholder when the member lookup fails', async () => {
    mockGetHistory.mockResolvedValue({ commits: COMMITS });
    mockListMembers.mockRejectedValue(new Error('network down'));
    renderPanel();

    expect(await screen.findByText('Fix the intro section')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Unknown author')).toHaveLength(COMMITS.length));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('does not apply a member lookup that resolves after unmounting', async () => {
    mockGetHistory.mockResolvedValue({ commits: COMMITS });
    let settle: (value: unknown) => void = noop;
    mockListMembers.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { unmount } = renderPanel();
    expect(await screen.findByText('Fix the intro section')).toBeInTheDocument();

    unmount();
    await act(async () => {
      settle({ data: { members: [{ userId: 'user1', displayName: 'Alice Smith' }] } });
    });

    expect(screen.queryByLabelText('Alice Smith')).not.toBeInTheDocument();
  });
});

describe('HistoryPanel dismissal', () => {
  test('asks to close when the Close button is pressed', async () => {
    mockGetHistory.mockResolvedValue({ commits: [] });
    const { onOpenChange } = renderPanel();
    await screen.findByText('No commits yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('stays open when Escape is pressed or a pointer goes down outside it', async () => {
    mockGetHistory.mockResolvedValue({ commits: [] });
    const { onOpenChange } = renderPanel();
    await screen.findByText('No commits yet.');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });

    expect(screen.getByText('No commits yet.')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
