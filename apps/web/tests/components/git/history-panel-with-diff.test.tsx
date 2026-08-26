import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HistoryPanelWithDiff } from '@/components/git/history-panel-with-diff';
import { getDiff, getHistory } from '@/lib/api/git';
import { membersApi } from '@/lib/api/members';
import type { CommitDto } from '@asciidocollab/shared';

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
