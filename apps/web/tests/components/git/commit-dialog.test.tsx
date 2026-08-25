import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommitDialog } from '@/components/git/commit-dialog';
import { ApiError } from '@/lib/api/transport';

const mockGetGitStatus = jest.fn();
const mockCommitChanges = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  getGitStatus: (...parameters: unknown[]) => mockGetGitStatus(...parameters),
  commitChanges: (...parameters: unknown[]) => mockCommitChanges(...parameters),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

const STATUS_WITH_STAGED = {
  branch: 'main',
  syncStatus: 'UP_TO_DATE',
  ahead: 0,
  behind: 0,
  lastSyncAt: null,
  staged: [
    { path: 'chapter-1.adoc', changeType: 'modified' },
    { path: 'images/diagram.png', changeType: 'added' },
  ],
  unstaged: [],
  untracked: [],
  conflicted: [],
};

const STATUS_WITH_NOTHING_STAGED = {
  ...STATUS_WITH_STAGED,
  staged: [],
};

function renderDialog(overrides: Partial<{ onOpenChange: (open: boolean) => void; onCommitted: () => void }> = {}) {
  const onOpenChange = overrides.onOpenChange ?? jest.fn();
  const onCommitted = overrides.onCommitted ?? jest.fn();
  render(<CommitDialog projectId="proj1" open onOpenChange={onOpenChange} onCommitted={onCommitted} />);
  return { onOpenChange, onCommitted };
}

const messageField = () => screen.getByLabelText(/commit message/i);
const submitButton = () => screen.getByRole('button', { name: /^(Commit|Committing…)$/ });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetGitStatus.mockResolvedValue(STATUS_WITH_STAGED);
  mockCommitChanges.mockResolvedValue({
    commit: { hash: 'abc123', message: 'msg', authorUserId: 'user1', authoredAt: '2026-08-24T00:00:00Z' },
  });
});

describe('CommitDialog staged list', () => {
  test('fetches and lists the staged changes on open', async () => {
    renderDialog();
    expect(await screen.findByText('chapter-1.adoc')).toBeInTheDocument();
    expect(screen.getByText('images/diagram.png')).toBeInTheDocument();
    expect(mockGetGitStatus).toHaveBeenCalledWith('proj1');
  });

  test('shows a muted hint and disables the Commit button when nothing is staged', async () => {
    mockGetGitStatus.mockResolvedValue(STATUS_WITH_NOTHING_STAGED);
    renderDialog();
    expect(await screen.findByText(/nothing staged to commit/i)).toBeInTheDocument();
    fireEvent.change(messageField(), { target: { value: 'Some message' } });
    expect(submitButton()).toBeDisabled();
  });
});

describe('CommitDialog submission', () => {
  test('disables submit until a message is entered and something is staged', async () => {
    renderDialog();
    await screen.findByText('chapter-1.adoc');
    expect(submitButton()).toBeDisabled();
    fireEvent.change(messageField(), { target: { value: '  ' } });
    expect(submitButton()).toBeDisabled();
    fireEvent.change(messageField(), { target: { value: 'Fix typo' } });
    expect(submitButton()).toBeEnabled();
  });

  test('commits the trimmed message', async () => {
    renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.change(messageField(), { target: { value: '  Fix typo  ' } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockCommitChanges).toHaveBeenCalledWith('proj1', 'Fix typo'));
  });

  test('calls onCommitted and closes the dialog on success', async () => {
    const { onOpenChange, onCommitted } = renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.change(messageField(), { target: { value: 'Fix typo' } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(onCommitted).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('disables submit while the request is in flight', async () => {
    mockCommitChanges.mockReturnValueOnce(new Promise(() => undefined));
    renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.change(messageField(), { target: { value: 'Fix typo' } });
    fireEvent.click(submitButton());
    const button = await screen.findByRole('button', { name: 'Committing…' });
    expect(button).toBeDisabled();
  });

  test.each([
    ['empty_commit_message', 'A commit message is required.'],
    ['nothing_staged', 'There are no staged changes to commit.'],
    ['git_operation_in_progress', 'A git operation is already in progress. Try again shortly.'],
    ['insufficient_role', 'You need editor access to commit.'],
    ['git_worker_unavailable', 'The git service is unavailable. Try again shortly.'],
    ['some_unmapped_code', "Couldn't create the commit."],
  ])('maps the %s error code to a friendly message and keeps the dialog open', async (code, expectedMessage) => {
    mockCommitChanges.mockRejectedValueOnce(new ApiError(409, code, 'server said so'));
    const { onOpenChange } = renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.change(messageField(), { target: { value: 'Fix typo' } });
    fireEvent.click(submitButton());
    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test('includes the path from a live_content_flush_failed refusal when present', async () => {
    mockCommitChanges.mockRejectedValueOnce(
      new ApiError(409, 'live_content_flush_failed', 'server said so', undefined, { path: 'chapter-1.adoc' }),
    );
    renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.change(messageField(), { target: { value: 'Fix typo' } });
    fireEvent.click(submitButton());
    expect(await screen.findByText(/chapter-1\.adoc/)).toBeInTheDocument();
  });
});

describe('CommitDialog dismissal', () => {
  test('closes on Cancel without committing', async () => {
    const { onOpenChange } = renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockCommitChanges).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('stays open on Escape', async () => {
    const { onOpenChange } = renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('CommitDialog accessibility', () => {
  test('wires the dialog description via aria-describedby', async () => {
    renderDialog();
    await screen.findByText('chapter-1.adoc');
    const dialog = screen.getByRole('dialog');
    const describedById = dialog.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.querySelector(`#${describedById}`)).toHaveTextContent(/enter a message to commit/i);
  });
});
