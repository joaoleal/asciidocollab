import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommitDialog } from '@/components/git/commit-dialog';
import { ApiError } from '@/lib/api/transport';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

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

const STATUS_WITH_NOTHING_PENDING = {
  ...STATUS_WITH_STAGED,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
};

const STATUS_WITH_UNSTAGED_AND_UNTRACKED = {
  ...STATUS_WITH_STAGED,
  staged: [],
  unstaged: [{ path: 'chapter-2.adoc', changeType: 'modified' }],
  untracked: [{ path: 'notes.adoc', changeType: 'added' }],
  conflicted: [{ path: 'conflicted.adoc', changeType: 'modified' }],
};

function renderDialog(overrides: Partial<{ onOpenChange: (open: boolean) => void; onCommitted: () => void }> = {}) {
  const onOpenChange = overrides.onOpenChange ?? jest.fn();
  const onCommitted = overrides.onCommitted ?? jest.fn();
  const view = render(<CommitDialog projectId="proj1" open onOpenChange={onOpenChange} onCommitted={onCommitted} />);
  return { onOpenChange, onCommitted, unmount: view.unmount };
}

/** A never-settling promise plus the handles that settle it, for driving in-flight request states. */
function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason: unknown) => void } {
  let resolve: (value: unknown) => void = noop;
  let reject: (reason: unknown) => void = noop;
  const promise = new Promise<unknown>((resolveIt, rejectIt) => {
    resolve = resolveIt;
    reject = rejectIt;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
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

describe('CommitDialog changes list', () => {
  test('fetches and lists the pending changes on open', async () => {
    renderDialog();
    expect(await screen.findByText('chapter-1.adoc')).toBeInTheDocument();
    expect(screen.getByText('images/diagram.png')).toBeInTheDocument();
    expect(mockGetGitStatus).toHaveBeenCalledWith('proj1');
  });

  test('lists unstaged and untracked changes but excludes conflicted ones', async () => {
    mockGetGitStatus.mockResolvedValue(STATUS_WITH_UNSTAGED_AND_UNTRACKED);
    renderDialog();
    expect(await screen.findByText('chapter-2.adoc')).toBeInTheDocument();
    expect(screen.getByText('notes.adoc')).toBeInTheDocument();
    expect(screen.queryByText('conflicted.adoc')).not.toBeInTheDocument();
    fireEvent.change(messageField(), { target: { value: 'Commit my edits' } });
    expect(submitButton()).toBeEnabled();
  });

  test('shows a muted hint and disables the Commit button when nothing is pending', async () => {
    mockGetGitStatus.mockResolvedValue(STATUS_WITH_NOTHING_PENDING);
    renderDialog();
    expect(await screen.findByText(/nothing to commit/i)).toBeInTheDocument();
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

  test('disables Cancel while the request is in flight so an in-flight commit is not abandoned', async () => {
    mockCommitChanges.mockReturnValueOnce(new Promise(() => undefined));
    renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.change(messageField(), { target: { value: 'Fix typo' } });
    fireEvent.click(submitButton());
    await screen.findByRole('button', { name: 'Committing…' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
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

  test('names no file when a live_content_flush_failed refusal carries no path', async () => {
    mockCommitChanges.mockRejectedValueOnce(new ApiError(409, 'live_content_flush_failed', 'server said so'));
    renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.change(messageField(), { target: { value: 'Fix typo' } });
    fireEvent.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't read the latest content for a file — try again.",
    );
  });

  test('shows a generic message when the commit never reaches the server', async () => {
    mockCommitChanges.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.change(messageField(), { target: { value: 'Fix typo' } });
    fireEvent.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't create the commit.");
    expect(submitButton()).toBeEnabled();
  });

  test('submitting with a blank message commits nothing', async () => {
    renderDialog();
    await screen.findByText('chapter-1.adoc');
    const form = messageField().closest('form');
    expect(form).not.toBeNull();

    await act(async () => {
      if (form) fireEvent.submit(form);
    });

    expect(mockCommitChanges).not.toHaveBeenCalled();
  });

  test('closes on a successful commit even when no committed callback was given', async () => {
    const onOpenChange = jest.fn();
    render(<CommitDialog projectId="proj1" open onOpenChange={onOpenChange} />);
    await screen.findByText('chapter-1.adoc');
    fireEvent.change(messageField(), { target: { value: 'Fix typo' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe('CommitDialog change loading failures', () => {
  test('reports a refused changes load without leaving the dialog on loading', async () => {
    mockGetGitStatus.mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
    renderDialog();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load changes.');
    expect(screen.queryByText(/loading changes/i)).not.toBeInTheDocument();
    expect(screen.getByText(/nothing to commit/i)).toBeInTheDocument();
  });

  test('reports a changes load that never reaches the server', async () => {
    mockGetGitStatus.mockRejectedValue(new TypeError('Failed to fetch'));
    renderDialog();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load changes.');
    expect(screen.queryByText(/loading changes/i)).not.toBeInTheDocument();
  });

  test('drops a changes result that arrives after dismissal', async () => {
    const pending = deferred();
    mockGetGitStatus.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    expect(screen.getByText(/loading changes/i)).toBeInTheDocument();

    unmount();
    await act(async () => {
      pending.resolve(STATUS_WITH_STAGED);
    });

    expect(screen.queryByText('chapter-1.adoc')).not.toBeInTheDocument();
  });

  test('drops a staged-changes failure that arrives after dismissal', async () => {
    const pending = deferred();
    mockGetGitStatus.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();

    unmount();
    await act(async () => {
      pending.reject(new TypeError('Failed to fetch'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('CommitDialog commits that settle after dismissal', () => {
  test('a commit that resolves after dismissal reports nothing', async () => {
    const pending = deferred();
    mockCommitChanges.mockReturnValue(pending.promise);
    const { onCommitted, unmount } = renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.change(messageField(), { target: { value: 'Fix typo' } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockCommitChanges).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve({ commit: { hash: 'abc123', message: 'Fix typo', authoredAt: '2026-08-24T00:00:00Z' } });
    });

    expect(onCommitted).not.toHaveBeenCalled();
  });

  test('a commit refused after dismissal shows no error', async () => {
    const pending = deferred();
    mockCommitChanges.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    await screen.findByText('chapter-1.adoc');
    fireEvent.change(messageField(), { target: { value: 'Fix typo' } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockCommitChanges).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.reject(new ApiError(409, 'nothing_staged', 'nope'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  test('stays open when a pointer goes down outside it', async () => {
    const { onOpenChange } = renderDialog();
    await screen.findByText('chapter-1.adoc');
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
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
