import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HistoryPanel } from '@/components/git/history-panel';
import type { CommitDto } from '@asciidocollab/shared';

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
  render(
    <HistoryPanel
      projectId="proj1"
      open
      onOpenChange={onOpenChange}
      onSelectCommit={overrides.onSelectCommit}
    />,
  );
  return { onOpenChange };
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
