import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectOrInitializeDialog } from '@/components/git/repository-connect-dialog';
import { ApiError } from '@/lib/api/transport';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

const mockConnectRepository = jest.fn();
const mockInitializeRepository = jest.fn();
const mockGetGitOperation = jest.fn();
const mockGetOAuthProviders = jest.fn();
const mockStartGitOAuth = jest.fn();
const mockNavigateTo = jest.fn();

jest.mock('@/lib/navigate', () => ({
  navigateTo: (...parameters: unknown[]) => mockNavigateTo(...parameters),
}));

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  connectRepository: (...parameters: unknown[]) => mockConnectRepository(...parameters),
  initializeRepository: (...parameters: unknown[]) => mockInitializeRepository(...parameters),
  getGitOperation: (...parameters: unknown[]) => mockGetGitOperation(...parameters),
  getOAuthProviders: (...parameters: unknown[]) => mockGetOAuthProviders(...parameters),
  startGitOAuth: (...parameters: unknown[]) => mockStartGitOAuth(...parameters),
}));

jest.useFakeTimers();

const PROJECT_ID = 'proj-1';
const REMOTE_URL = 'https://github.com/acme/handbook.git';

/** A never-settling promise plus the handles that settle it, for driving in-flight request states. */
function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason: unknown) => void } {
  let resolve: (value: unknown) => void = noop;
  let reject: (reason: unknown) => void = noop;
  const promise = new Promise<unknown>((resolveIt, rejectIt) => {
    resolve = resolveIt;
    reject = rejectIt;
  });
  // A rejection settled after unmount is handled by the component's own catch; this keeps Node from
  // reporting the not-yet-attached rejection in the window before that.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function renderDialog(mode: 'connect' | 'initialize' = 'connect') {
  const onOpenChange = jest.fn();
  const onSucceeded = jest.fn();
  const view = render(
    <ConnectOrInitializeDialog
      projectId={PROJECT_ID}
      mode={mode}
      open
      onOpenChange={onOpenChange}
      onSucceeded={onSucceeded}
    />,
  );
  return { onOpenChange, onSucceeded, unmount: view.unmount };
}

/** Fills the shared form with a valid remote URL and token, and optionally a branch. */
function fillForm(options: { branch?: string } = {}) {
  fireEvent.change(screen.getByLabelText(/remote url/i), { target: { value: REMOTE_URL } });
  fireEvent.change(screen.getByLabelText(/^access token$/i), { target: { value: 'ghp_secret' } });
  if (options.branch !== undefined) {
    fireEvent.change(screen.getByLabelText(/branch/i), { target: { value: options.branch } });
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnectRepository.mockResolvedValue({ repository: {} });
  mockInitializeRepository.mockResolvedValue({ operationId: 'op1', projectId: PROJECT_ID });
  mockGetGitOperation.mockResolvedValue({
    id: 'op1',
    kind: 'INITIALIZE',
    state: 'QUEUED',
    progress: 0,
    errorCode: null,
    driftSummary: null,
  });
  mockGetOAuthProviders.mockResolvedValue({ providers: [] });
  mockStartGitOAuth.mockResolvedValue({ authorizeUrl: 'https://github.com/login/oauth/authorize?mock=1' });
});

afterEach(() => {
  jest.clearAllTimers();
});

describe('ConnectOrInitializeDialog submission guards', () => {
  test('submitting an empty form sends no request', async () => {
    renderDialog();
    await act(async () => {
      jest.advanceTimersByTime(0);
    });

    fireEvent.submit(screen.getByLabelText(/remote url/i).closest('form') ?? document.createElement('form'));

    expect(mockConnectRepository).not.toHaveBeenCalled();
  });

  test('sends the trimmed branch when one is entered', async () => {
    renderDialog();
    fillForm({ branch: '  develop  ' });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() =>
      expect(mockConnectRepository).toHaveBeenCalledWith(PROJECT_ID, {
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: 'ghp_secret',
        branch: 'develop',
      }),
    );
  });

  test('cancelling asks to close without sending anything', async () => {
    const { onOpenChange } = renderDialog();
    await act(async () => {
      jest.advanceTimersByTime(0);
    });

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockConnectRepository).not.toHaveBeenCalled();
  });

  test('stays open when Escape is pressed or a pointer goes down outside it', async () => {
    const { onOpenChange } = renderDialog();
    await act(async () => {
      jest.advanceTimersByTime(0);
    });

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('ConnectOrInitializeDialog guided-connect availability lookup', () => {
  test('hides the guided button when the availability lookup is refused', async () => {
    mockGetOAuthProviders.mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
    renderDialog();

    await waitFor(() => expect(mockGetOAuthProviders).toHaveBeenCalled());
    await act(async () => {
      jest.advanceTimersByTime(0);
    });

    expect(screen.queryByRole('button', { name: /connect with/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/remote url/i)).toBeInTheDocument();
  });

  test('hides the guided button when the availability lookup never reaches the server', async () => {
    mockGetOAuthProviders.mockRejectedValue(new TypeError('Failed to fetch'));
    renderDialog();

    await waitFor(() => expect(mockGetOAuthProviders).toHaveBeenCalled());
    await act(async () => {
      jest.advanceTimersByTime(0);
    });

    expect(screen.queryByRole('button', { name: /connect with/i })).not.toBeInTheDocument();
  });

  test('drops an availability result that resolves after the dialog is gone', async () => {
    const pending = deferred();
    mockGetOAuthProviders.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();

    unmount();
    await act(async () => {
      pending.resolve({ providers: ['github'] });
    });

    expect(screen.queryByRole('button', { name: /connect with/i })).not.toBeInTheDocument();
  });

  test('drops an availability failure that settles after the dialog is gone', async () => {
    const pending = deferred();
    mockGetOAuthProviders.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();

    unmount();
    await act(async () => {
      pending.reject(new Error('network down'));
    });

    expect(screen.queryByRole('button', { name: /connect with/i })).not.toBeInTheDocument();
  });
});

describe('ConnectOrInitializeDialog requests that settle after dismissal', () => {
  test('a connect that resolves after dismissal reports no success', async () => {
    const pending = deferred();
    mockConnectRepository.mockReturnValue(pending.promise);
    const { onSucceeded, unmount } = renderDialog();
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(mockConnectRepository).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve({ repository: {} });
    });

    expect(onSucceeded).not.toHaveBeenCalled();
  });

  test('a connect that is refused after dismissal shows no error', async () => {
    const pending = deferred();
    mockConnectRepository.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(mockConnectRepository).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.reject(new ApiError(403, 'insufficient_role', 'nope'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('an initialize that resolves after dismissal starts no polling', async () => {
    const pending = deferred();
    mockInitializeRepository.mockReturnValue(pending.promise);
    const { unmount } = renderDialog('initialize');
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^initialize & publish$/i }));
    await waitFor(() => expect(mockInitializeRepository).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve({ operationId: 'op1', projectId: PROJECT_ID });
    });

    expect(mockGetGitOperation).not.toHaveBeenCalled();
  });

  test('a guided-connect start that resolves after dismissal never redirects', async () => {
    mockGetOAuthProviders.mockResolvedValue({ providers: ['github'] });
    const pending = deferred();
    mockStartGitOAuth.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    const guided = await screen.findByRole('button', { name: /connect with github/i });
    fireEvent.change(screen.getByLabelText(/remote url/i), { target: { value: REMOTE_URL } });
    fireEvent.click(guided);
    await waitFor(() => expect(mockStartGitOAuth).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve({ authorizeUrl: 'https://github.com/login/oauth/authorize?mock=1' });
    });

    expect(mockNavigateTo).not.toHaveBeenCalled();
  });

  test('a guided-connect start refused after dismissal shows no error', async () => {
    mockGetOAuthProviders.mockResolvedValue({ providers: ['github'] });
    const pending = deferred();
    mockStartGitOAuth.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    const guided = await screen.findByRole('button', { name: /connect with github/i });
    fireEvent.change(screen.getByLabelText(/remote url/i), { target: { value: REMOTE_URL } });
    fireEvent.click(guided);
    await waitFor(() => expect(mockStartGitOAuth).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.reject(new ApiError(403, 'insufficient_role', 'nope'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ConnectOrInitializeDialog initialize outcomes', () => {
  test('shows the mapped message when the queue request itself is refused', async () => {
    mockInitializeRepository.mockRejectedValue(new ApiError(409, 'already_connected', 'nope'));
    renderDialog('initialize');
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^initialize & publish$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already has a connected repository/i);
  });

  test('shows a neutral working label for a progress state it has no wording for', async () => {
    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'INITIALIZE',
      state: 'PREPARING',
      progress: 12,
      errorCode: null,
      driftSummary: null,
    });
    renderDialog('initialize');
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^initialize & publish$/i }));

    expect(await screen.findByText(/working…\s*12%/i)).toBeInTheDocument();
  });

  test('closing during the poll asks to close and leaves the operation running', async () => {
    const { onOpenChange } = renderDialog('initialize');
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^initialize & publish$/i }));
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('reports an aborted initialize and offers a close', async () => {
    const { onOpenChange } = renderDialog('initialize');
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^initialize & publish$/i }));
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'INITIALIZE',
      state: 'ABORTED',
      progress: 55,
      errorCode: null,
      driftSummary: null,
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/was aborted/i);
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('closing after a failed initialize asks to close', async () => {
    const { onOpenChange } = renderDialog('initialize');
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^initialize & publish$/i }));
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'INITIALIZE',
      state: 'FAILED',
      progress: 40,
      errorCode: 'repository_unreachable',
      driftSummary: null,
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be reached/i);
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('a poll that answers after dismissal changes nothing', async () => {
    const pending = deferred();
    mockGetGitOperation.mockReturnValue(pending.promise);
    const { onSucceeded, unmount } = renderDialog('initialize');
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /^initialize & publish$/i }));
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve({
        id: 'op1',
        kind: 'INITIALIZE',
        state: 'SUCCEEDED',
        progress: 100,
        errorCode: null,
        driftSummary: null,
      });
    });

    expect(onSucceeded).not.toHaveBeenCalled();
  });
});
