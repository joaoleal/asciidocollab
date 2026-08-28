import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DisconnectDialog } from '@/components/git/repository-disconnect-dialog';
import { ApiError } from '@/lib/api/transport';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

const mockDisconnectRepository = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  disconnectRepository: (...parameters: unknown[]) => mockDisconnectRepository(...parameters),
}));

const PROJECT_ID = 'proj-1';

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

function renderDialog() {
  const onOpenChange = jest.fn();
  const onDisconnected = jest.fn();
  const view = render(
    <DisconnectDialog
      projectId={PROJECT_ID}
      open
      onOpenChange={onOpenChange}
      onDisconnected={onDisconnected}
    />,
  );
  return { onOpenChange, onDisconnected, unmount: view.unmount };
}

const confirmButton = () => screen.getByRole('button', { name: /^disconnect$/i });

beforeEach(() => {
  jest.clearAllMocks();
  mockDisconnectRepository.mockResolvedValue({ ok: true });
});

describe('DisconnectDialog confirmation', () => {
  test('disconnects, reports it, and closes on the explicit confirm', async () => {
    const { onOpenChange, onDisconnected } = renderDialog();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(mockDisconnectRepository).toHaveBeenCalledWith(PROJECT_ID));
    await waitFor(() => expect(onDisconnected).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('cancelling asks to close without disconnecting', () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockDisconnectRepository).not.toHaveBeenCalled();
  });

  test('shows the mapped message when the disconnect is refused', async () => {
    mockDisconnectRepository.mockRejectedValue(new ApiError(404, 'repository_not_connected', 'nope'));
    const { onDisconnected } = renderDialog();

    fireEvent.click(confirmButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/no connected repository/i);
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(confirmButton()).toBeEnabled();
  });

  test('shows a generic message when the request never reaches the server', async () => {
    mockDisconnectRepository.mockRejectedValue(new TypeError('Failed to fetch'));
    renderDialog();

    fireEvent.click(confirmButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't disconnect the repository/i);
  });
});

describe('DisconnectDialog requests that settle after dismissal', () => {
  test('a disconnect that resolves after dismissal reports nothing', async () => {
    const pending = deferred();
    mockDisconnectRepository.mockReturnValue(pending.promise);
    const { onDisconnected, unmount } = renderDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockDisconnectRepository).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve({ ok: true });
    });

    expect(onDisconnected).not.toHaveBeenCalled();
  });

  test('a disconnect refused after dismissal shows no error', async () => {
    const pending = deferred();
    mockDisconnectRepository.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockDisconnectRepository).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.reject(new ApiError(404, 'repository_not_connected', 'nope'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('DisconnectDialog dismissal', () => {
  test('stays open when Escape is pressed or a pointer goes down outside it', async () => {
    const { onOpenChange } = renderDialog();
    // The outside-pointer listener is registered a macrotask after the dialog mounts.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('renders nothing while closed', () => {
    render(
      <DisconnectDialog projectId={PROJECT_ID} open={false} onOpenChange={jest.fn()} onDisconnected={jest.fn()} />,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
