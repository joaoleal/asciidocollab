import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describePullFailure, PullDialog } from '@/components/git/pull-dialog';
import { ApiError } from '@/lib/api/transport';

const mockStartPull = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  startPull: (...parameters: unknown[]) => mockStartPull(...parameters),
}));

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
});

describe('PullDialog warning', () => {
  test('renders a real Dialog.Description warning about open files', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const describedById = dialog.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.querySelector(`#${describedById}`)).toHaveTextContent(/open for live editing/i);
  });

  test('shows Cancel and Pull anyway actions', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(confirmButton()).toBeInTheDocument();
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
