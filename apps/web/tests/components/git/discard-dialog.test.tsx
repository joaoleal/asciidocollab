import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describeDiscardFailure, DiscardDialog } from '@/components/git/discard-dialog';
import { ApiError } from '@/lib/api/transport';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

const mockDiscardChanges = jest.fn();

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

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  discardChanges: (...parameters: unknown[]) => mockDiscardChanges(...parameters),
}));

function renderDiscard(overrides: Partial<{ onOpenChange: (open: boolean) => void; onDone: () => void; paths: string[] }> = {}) {
  const onOpenChange = overrides.onOpenChange ?? jest.fn();
  const onDone = overrides.onDone ?? jest.fn();
  const view = render(
    <DiscardDialog
      projectId="proj1"
      open
      onOpenChange={onOpenChange}
      onDone={onDone}
      paths={overrides.paths ?? ['a.adoc', 'b.adoc']}
    />,
  );
  return { onOpenChange, onDone, unmount: view.unmount };
}

function renderRestore(overrides: Partial<{ onOpenChange: (open: boolean) => void; onDone: () => void }> = {}) {
  const onOpenChange = overrides.onOpenChange ?? jest.fn();
  const onDone = overrides.onDone ?? jest.fn();
  render(
    <DiscardDialog
      projectId="proj1"
      open
      mode="restore"
      path="a.adoc"
      commit="abc1234"
      onOpenChange={onOpenChange}
      onDone={onDone}
    />,
  );
  return { onOpenChange, onDone };
}

const discardButton = () => screen.getByRole('button', { name: /^(Discard|Discarding…)$/ });
const restoreButton = () => screen.getByRole('button', { name: /^(Restore|Restoring…)$/ });

beforeEach(() => {
  jest.clearAllMocks();
  mockDiscardChanges.mockResolvedValue({ ok: true });
});

describe('DiscardDialog structure', () => {
  test('renders a real Dialog.Description', () => {
    renderDiscard();
    const dialog = screen.getByRole('dialog');
    const describedById = dialog.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.querySelector(`#${describedById}`)).toHaveTextContent(/discarded|permanently/i);
  });

  test('the confirm button uses the destructive variant', () => {
    renderDiscard();
    expect(discardButton()).toHaveClass('bg-destructive');
  });

  test('stays open on Escape', () => {
    const { onOpenChange } = renderDiscard();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mockDiscardChanges).not.toHaveBeenCalled();
  });

  test('stays open on an outside click', async () => {
    const { onOpenChange } = renderDiscard();
    // The outside-pointer listener is registered a macrotask after the dialog mounts.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('names a single file in the title when only one path is being discarded', () => {
    renderDiscard({ paths: ['a.adoc'] });
    expect(screen.getByText('Discard changes to this file?')).toBeInTheDocument();
  });
});

describe('DiscardDialog discard mode', () => {
  test('confirming sends { paths } to discardChanges', async () => {
    renderDiscard({ paths: ['a.adoc', 'b.adoc'] });
    fireEvent.click(discardButton());
    await waitFor(() => expect(mockDiscardChanges).toHaveBeenCalledWith('proj1', { paths: ['a.adoc', 'b.adoc'] }));
  });

  test('closes and fires onDone on success', async () => {
    const { onOpenChange, onDone } = renderDiscard();
    fireEvent.click(discardButton());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('closes on Cancel without discarding', () => {
    const { onOpenChange } = renderDiscard();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockDiscardChanges).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('renders every path being discarded', () => {
    renderDiscard({ paths: ['a.adoc', 'b.adoc'] });
    expect(screen.getByText('a.adoc')).toBeInTheDocument();
    expect(screen.getByText('b.adoc')).toBeInTheDocument();
  });
});

describe('DiscardDialog restore mode', () => {
  test('confirming sends { path, commit } to discardChanges', async () => {
    renderRestore();
    fireEvent.click(restoreButton());
    await waitFor(() => expect(mockDiscardChanges).toHaveBeenCalledWith('proj1', { path: 'a.adoc', commit: 'abc1234' }));
  });

  test('closes and fires onDone on success', async () => {
    const { onOpenChange, onDone } = renderRestore();
    fireEvent.click(restoreButton());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('DiscardDialog failure', () => {
  test.each([
    ['insufficient_role', 'You need editor access to discard changes.'],
    ['git_worker_unavailable', 'The git service is unavailable. Try again shortly.'],
    ['some_unmapped_code', "Couldn't discard the changes."],
  ])('maps the %s error code to a friendly message and keeps the dialog open', async (code, expectedMessage) => {
    mockDiscardChanges.mockRejectedValueOnce(new ApiError(409, code, 'server said so'));
    const { onOpenChange } = renderDiscard();
    fireEvent.click(discardButton());
    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test('renders the error inside a role="alert"', async () => {
    mockDiscardChanges.mockRejectedValueOnce(new ApiError(409, 'git_worker_unavailable', 'server said so'));
    renderDiscard();
    fireEvent.click(discardButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('The git service is unavailable. Try again shortly.');
  });

  test('shows a generic message when the request never reaches the server', async () => {
    mockDiscardChanges.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderDiscard();
    fireEvent.click(discardButton());
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't discard the changes.");
    expect(discardButton()).toBeEnabled();
  });
});

describe('DiscardDialog requests that settle after dismissal', () => {
  test('a discard that resolves after dismissal reports nothing', async () => {
    const pending = deferred();
    mockDiscardChanges.mockReturnValue(pending.promise);
    const { onDone, unmount } = renderDiscard();
    fireEvent.click(discardButton());
    await waitFor(() => expect(mockDiscardChanges).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve({ ok: true });
    });

    expect(onDone).not.toHaveBeenCalled();
  });

  test('a discard refused after dismissal shows no error', async () => {
    const pending = deferred();
    mockDiscardChanges.mockReturnValue(pending.promise);
    const { unmount } = renderDiscard();
    fireEvent.click(discardButton());
    await waitFor(() => expect(mockDiscardChanges).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.reject(new ApiError(409, 'git_worker_unavailable', 'nope'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('closes on a successful discard even when no completion callback was given', async () => {
    const onOpenChange = jest.fn();
    render(<DiscardDialog projectId="proj1" open onOpenChange={onOpenChange} paths={['a.adoc']} />);

    fireEvent.click(discardButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe('describeDiscardFailure', () => {
  test.each([
    ['insufficient_role', 'discard', 'You need editor access to discard changes.'],
    ['insufficient_role', 'restore', 'You need editor access to restore this file.'],
    ['git_worker_unavailable', 'discard', 'The git service is unavailable. Try again shortly.'],
    ['repository_not_connected', 'discard', 'This project has no connected repository.'],
    ['git_operation_in_progress', 'discard', 'A git operation is already in progress. Try again shortly.'],
    ['some_unmapped_code', 'discard', "Couldn't discard the changes."],
    ['some_unmapped_code', 'restore', "Couldn't restore the file."],
  ] as const)('maps %s (%s) to %s', (code, mode, expectedMessage) => {
    expect(describeDiscardFailure(new ApiError(409, code, 'server said so'), mode)).toBe(expectedMessage);
  });

  test('falls back to the generic discard message for a non-ApiError', () => {
    expect(describeDiscardFailure(new Error('boom'), 'discard')).toBe("Couldn't discard the changes.");
  });
});
