import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HistoryPanelWithDiff } from '@/components/git/history-panel-with-diff';
import type { DiffViewProperties } from '@/components/git/diff-view';
import { getDiff, getHistory } from '@/lib/api/git';
import { membersApi } from '@/lib/api/members';
import type { CommitDto } from '@asciidocollab/shared';

/** Every render's props for the hosted diff view, so its `onOpenChange` seam can be driven directly. */
const mockDiffViewRenders: DiffViewProperties[] = [];

// Wraps the real `DiffView` so the integration still renders end to end while each render's props
// stay reachable — the view itself never asks to *open*, so that half of the seam needs driving.
jest.mock('@/components/git/diff-view', () => {
  const actual = jest.requireActual('@/components/git/diff-view');
  const react = jest.requireActual('react');
  return {
    ...actual,
    DiffView: (properties: DiffViewProperties) => {
      mockDiffViewRenders.push(properties);
      return react.createElement(actual.DiffView, properties);
    },
  };
});

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  getHistory: jest.fn(),
  getDiff: jest.fn(),
}));

jest.mock('@/lib/api/members', () => ({
  membersApi: { list: jest.fn() },
}));

const mockGetHistory = getHistory as jest.MockedFunction<typeof getHistory>;
const mockGetDiff = getDiff as jest.MockedFunction<typeof getDiff>;
const mockMembersList = membersApi.list as jest.MockedFunction<typeof membersApi.list>;

const COMMIT: CommitDto = {
  hash: 'deadbeef00000000000000000000000000000000',
  message: 'Fix the thing',
  authoredAt: '2026-08-24T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDiffViewRenders.length = 0;
  mockMembersList.mockResolvedValue({ data: { members: [] } });
  mockGetHistory.mockResolvedValue({ commits: [COMMIT] });
  mockGetDiff.mockResolvedValue({ unified: '' });
});

test('selecting a commit opens its diff, mapping from the commit hash to its parent', async () => {
  render(<HistoryPanelWithDiff projectId="proj1" open onOpenChange={jest.fn()} />);

  await waitFor(() => expect(screen.getByText('Fix the thing')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Fix the thing'));

  await waitFor(() =>
    expect(mockGetDiff).toHaveBeenCalledWith('proj1', {
      path: undefined,
      from: `${COMMIT.hash}^`,
      to: COMMIT.hash,
    }),
  );
  expect(await screen.findByText('Diff')).toBeInTheDocument();
});

test('shows no diff until a commit is selected', async () => {
  render(<HistoryPanelWithDiff projectId="proj1" open onOpenChange={jest.fn()} />);

  await waitFor(() => expect(screen.getByText('Fix the thing')).toBeInTheDocument());
  expect(screen.queryByText('Diff')).not.toBeInTheDocument();
  expect(mockGetDiff).not.toHaveBeenCalled();
});

test('closing the diff leaves the history panel in place and reopens on the next selection', async () => {
  render(<HistoryPanelWithDiff projectId="proj1" open onOpenChange={jest.fn()} />);

  await waitFor(() => expect(screen.getByText('Fix the thing')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Fix the thing'));
  const diffDialog = await screen.findByRole('dialog', { name: /diff/i });

  fireEvent.click(within(diffDialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByText('Diff')).not.toBeInTheDocument());
  expect(screen.getByText('Fix the thing')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Fix the thing'));
  expect(await screen.findByText('Diff')).toBeInTheDocument();
});

test('a request to open the diff view keeps the already-selected commit', async () => {
  render(<HistoryPanelWithDiff projectId="proj1" open onOpenChange={jest.fn()} />);

  await waitFor(() => expect(screen.getByText('Fix the thing')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Fix the thing'));
  expect(await screen.findByText('Diff')).toBeInTheDocument();

  const latest = mockDiffViewRenders.at(-1);
  await act(async () => {
    latest?.onOpenChange(true);
  });

  expect(screen.getByText('Diff')).toBeInTheDocument();
  expect(mockDiffViewRenders.at(-1)?.to).toBe(COMMIT.hash);
});
