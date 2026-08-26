import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describePullFailure, PullDialog } from '@/components/git/pull-dialog';
import { ApiError } from '@/lib/api/transport';
import type { CommitDto } from '@asciidocollab/shared';

const mockStartPull = jest.fn();
const mockGetPullPreview = jest.fn();
const mockListMembers = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  startPull: (...parameters: unknown[]) => mockStartPull(...parameters),
  getPullPreview: (...parameters: unknown[]) => mockGetPullPreview(...parameters),
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
];

function renderDialog(overrides: Partial<{ onOpenChange: (open: boolean) => void; onConfirmed: (result: unknown) => void }> = {}) {
  const onOpenChange = overrides.onOpenChange ?? jest.fn();
  const onConfirmed = overrides.onConfirmed ?? jest.fn();
  render(<PullDialog projectId="proj1" open onOpenChange={onOpenChange} onConfirmed={onConfirmed} />);
  return { onOpenChange, onConfirmed };
}

const confirmButton = () => screen.getByRole('button', { name: /^(Pull anyway|Pulling…)$/ });

beforeEach(() => {
  jest.clearAllMocks();
  mockStartPull.mockResolvedValue({ operationId: 'op1', projectId: 'proj1' });
  mockGetPullPreview.mockResolvedValue({ incomingCommits: [], changedPaths: [], affectsOpenFiles: false });
  mockListMembers.mockResolvedValue({ data: { members: [] } });
});

describe('PullDialog structure', () => {
  test('renders a real Dialog.Description', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const describedById = dialog.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.querySelector(`#${describedById}`)).toHaveTextContent(/incoming commits/i);
  });

  test('shows Cancel and Pull anyway actions', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(confirmButton()).toBeInTheDocument();
  });
});

describe('PullDialog preview', () => {
  test('fetches the pull preview on open', () => {
    renderDialog();
    expect(mockGetPullPreview).toHaveBeenCalledWith('proj1');
  });

  test('shows a loading state while the preview loads', () => {
    mockGetPullPreview.mockReturnValue(new Promise(() => undefined));
    renderDialog();
    expect(screen.getByText('Loading pull preview…')).toBeInTheDocument();
  });

  test('shows "Already up to date" when there are no incoming commits', async () => {
    mockGetPullPreview.mockResolvedValue({ incomingCommits: [], changedPaths: [], affectsOpenFiles: false });
    renderDialog();
    expect(await screen.findByText('Already up to date.')).toBeInTheDocument();
  });

  test('renders incoming commits and changed paths', async () => {
    mockGetPullPreview.mockResolvedValue({
      incomingCommits: COMMITS,
      changedPaths: ['a.adoc', 'b.adoc'],
      affectsOpenFiles: false,
    });
    renderDialog();

    expect(await screen.findByText('Fix the intro section')).toBeInTheDocument();
    expect(screen.getByText('2 changed paths')).toBeInTheDocument();
    expect(screen.getByText('a.adoc')).toBeInTheDocument();
  });

  test('shows the open-files caution when affectsOpenFiles is true', async () => {
    mockGetPullPreview.mockResolvedValue({
      incomingCommits: COMMITS,
      changedPaths: ['a.adoc'],
      affectsOpenFiles: true,
    });
    renderDialog();

    expect(await screen.findByText(/may change files that are currently open for live editing/i)).toBeInTheDocument();
  });

  test('does not show the open-files caution when affectsOpenFiles is false', async () => {
    mockGetPullPreview.mockResolvedValue({
      incomingCommits: COMMITS,
      changedPaths: ['a.adoc'],
      affectsOpenFiles: false,
    });
    renderDialog();

    await screen.findByText('Fix the intro section');
    expect(screen.queryByText(/may change files that are currently open for live editing/i)).not.toBeInTheDocument();
  });

  test('renders an alert for a failed preview load', async () => {
    mockGetPullPreview.mockRejectedValue(new ApiError(403, 'insufficient_role', 'nope'));
    renderDialog();

    expect(await screen.findByRole('alert')).toHaveTextContent('You need editor access to see what would be pulled.');
  });
});

describe('PullDialog confirmation', () => {
  test('"Pull anyway" retries the pull with confirmAffectsOpenFiles: true', async () => {
    renderDialog();
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(mockStartPull).toHaveBeenCalledWith('proj1', { confirmAffectsOpenFiles: true }),
    );
  });

  test('calls onConfirmed with the queued operation and closes the dialog on success', async () => {
    const { onOpenChange, onConfirmed } = renderDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith({ operationId: 'op1', projectId: 'proj1' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('disables the confirm button while the retry is in flight', async () => {
    mockStartPull.mockReturnValueOnce(new Promise(() => undefined));
    renderDialog();
    fireEvent.click(confirmButton());
    const button = await screen.findByRole('button', { name: 'Pulling…' });
    expect(button).toBeDisabled();
  });

  test('closes on Cancel without pulling', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockStartPull).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('stays open on Escape', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('still allows confirming a pull when the preview failed to load (additive, not blocking)', async () => {
    mockGetPullPreview.mockRejectedValue(new Error('boom'));
    renderDialog();
    await screen.findByRole('alert');
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(mockStartPull).toHaveBeenCalledWith('proj1', { confirmAffectsOpenFiles: true }),
    );
  });
});

describe('PullDialog failure', () => {
  test.each([
    ['insufficient_role', 'You need editor access to pull.'],
    ['git_worker_unavailable', 'The git service is unavailable. Try again shortly.'],
    ['some_unmapped_code', "Couldn't start the pull."],
  ])('maps the %s error code to a friendly message and keeps the dialog open', async (code, expectedMessage) => {
    mockStartPull.mockRejectedValueOnce(new ApiError(409, code, 'server said so'));
    const { onOpenChange } = renderDialog();
    fireEvent.click(confirmButton());
    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('describePullFailure', () => {
  test.each([
    ['insufficient_role', 'You need editor access to pull.'],
    ['git_worker_unavailable', 'The git service is unavailable. Try again shortly.'],
    ['repository_not_connected', 'This project has no connected repository.'],
    ['some_unmapped_code', "Couldn't start the pull."],
  ])('maps %s to %s', (code, expectedMessage) => {
    expect(describePullFailure(new ApiError(409, code, 'server said so'))).toBe(expectedMessage);
  });

  test('falls back to the generic message for a non-ApiError', () => {
    expect(describePullFailure(new Error('boom'))).toBe("Couldn't start the pull.");
  });
});
