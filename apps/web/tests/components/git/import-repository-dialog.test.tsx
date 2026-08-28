import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportRepositoryDialog } from '@/components/git/import-repository-dialog';
import { ApiError } from '@/lib/api/transport';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

const mockImportRepository = jest.fn();
const mockGetGitOperation = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  importRepository: (...parameters: unknown[]) => mockImportRepository(...parameters),
  getGitOperation: (...parameters: unknown[]) => mockGetGitOperation(...parameters),
}));

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.useFakeTimers();

/** Executor for a promise that intentionally never settles. */
const NEVER_RESOLVE = () => undefined;

function renderDialog(onOpenChange: (open: boolean) => void = jest.fn()) {
  const view = render(<ImportRepositoryDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange, unmount: view.unmount };
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

const providerRadio = (name: RegExp) => screen.getByRole('radio', { name });
const remoteUrlField = () => screen.getByLabelText(/remote url/i);
const tokenField = () => screen.getByLabelText(/token/i);
const submitButton = () => screen.getByRole('button', { name: /^(Start import|Starting…)$/ });

/** Fills the required fields with a valid GitHub import and returns them for reuse. */
function fillValidForm() {
  fireEvent.change(remoteUrlField(), { target: { value: 'https://github.com/acme/handbook.git' } });
  fireEvent.change(tokenField(), { target: { value: 'ghp_super_secret_token' } });
}

const QUEUED_STATUS = { id: 'op1', kind: 'IMPORT', state: 'QUEUED', progress: 0, errorCode: null, driftSummary: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockImportRepository.mockResolvedValue({ operationId: 'op1', projectId: 'proj1' });
  mockGetGitOperation.mockResolvedValue(QUEUED_STATUS);
});

afterEach(() => {
  jest.clearAllTimers();
});

describe('ImportRepositoryDialog form', () => {
  test('defaults to GitHub selected among the three providers', () => {
    renderDialog();
    expect(providerRadio(/github/i)).toHaveAttribute('aria-checked', 'true');
    expect(providerRadio(/gitlab/i)).toHaveAttribute('aria-checked', 'false');
    expect(providerRadio(/bitbucket/i)).toHaveAttribute('aria-checked', 'false');
  });

  test('renders the token field as a password input', () => {
    renderDialog();
    expect(tokenField()).toHaveAttribute('type', 'password');
  });

  test('disables submit until a remote URL and a token are both present', () => {
    renderDialog();
    expect(submitButton()).toBeDisabled();
    fireEvent.change(remoteUrlField(), { target: { value: 'https://github.com/acme/handbook.git' } });
    expect(submitButton()).toBeDisabled();
    fireEvent.change(tokenField(), { target: { value: 'secret' } });
    expect(submitButton()).toBeEnabled();
  });

  test('switching provider selects it and deselects the others', () => {
    renderDialog();
    fireEvent.click(providerRadio(/gitlab/i));
    expect(providerRadio(/gitlab/i)).toHaveAttribute('aria-checked', 'true');
    expect(providerRadio(/github/i)).toHaveAttribute('aria-checked', 'false');
  });
});

describe('ImportRepositoryDialog submission', () => {
  test('sends the trimmed remote URL, the chosen provider, and the token', async () => {
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(mockImportRepository).toHaveBeenCalledWith({
        provider: 'github',
        remoteUrl: 'https://github.com/acme/handbook.git',
        token: 'ghp_super_secret_token',
        branch: undefined,
      }),
    );
  });

  test('includes a trimmed branch only when one was typed', async () => {
    renderDialog();
    fillValidForm();
    fireEvent.change(screen.getByLabelText(/branch/i), { target: { value: '  develop  ' } });
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(mockImportRepository).toHaveBeenCalledWith(expect.objectContaining({ branch: 'develop' })),
    );
  });

  test('disables submit while the request is in flight', async () => {
    mockImportRepository.mockReturnValueOnce(new Promise(NEVER_RESOLVE));
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    const button = await screen.findByRole('button', { name: 'Starting…' });
    expect(button).toBeDisabled();
  });

  test('shows the server refusal and stays on the form when starting the import fails', async () => {
    mockImportRepository.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'slow down'));
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    expect(await screen.findByText(/too many imports recently/i)).toBeInTheDocument();
    expect(remoteUrlField()).toBeInTheDocument();
    expect(mockGetGitOperation).not.toHaveBeenCalled();
  });

  test('treats a 429 with any other code as a rate limit too', async () => {
    mockImportRepository.mockRejectedValueOnce(new ApiError(429, 'too_many_requests', 'slow down'));
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());

    expect(await screen.findByText(/too many imports recently/i)).toBeInTheDocument();
  });

  test('asks the author to sign in again when the start is unauthorized', async () => {
    mockImportRepository.mockRejectedValueOnce(new ApiError(401, 'unauthorized', 'no session'));
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());

    expect(await screen.findByText('Sign in again to start an import.')).toBeInTheDocument();
  });

  test('shows the server explanation for any other refusal', async () => {
    mockImportRepository.mockRejectedValueOnce(new ApiError(409, 'already_importing', 'An import is already running.'));
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());

    expect(await screen.findByText('An import is already running.')).toBeInTheDocument();
  });

  test('falls back to generic wording for a refusal with no explanation of its own', async () => {
    mockImportRepository.mockRejectedValueOnce(new ApiError(500, 'internal_error', '   '));
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());

    expect(await screen.findByText('The import could not be started.')).toBeInTheDocument();
  });

  test('falls back to generic wording when the request never reaches the server', async () => {
    mockImportRepository.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());

    expect(await screen.findByText('The import could not be started.')).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
  });

  test('submitting an empty form starts nothing', async () => {
    renderDialog();
    const form = remoteUrlField().closest('form');
    expect(form).not.toBeNull();

    await act(async () => {
      if (form) fireEvent.submit(form);
    });

    expect(mockImportRepository).not.toHaveBeenCalled();
  });

  test('an import queued after the dialog is gone starts no polling', async () => {
    const pending = deferred();
    mockImportRepository.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockImportRepository).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve({ operationId: 'op1', projectId: 'proj1' });
    });

    expect(mockGetGitOperation).not.toHaveBeenCalled();
  });

  test('an import refused after the dialog is gone shows no error', async () => {
    const pending = deferred();
    mockImportRepository.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockImportRepository).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.reject(new ApiError(401, 'unauthorized', 'no session'));
    });

    expect(screen.queryByText('Sign in again to start an import.')).not.toBeInTheDocument();
  });
});

describe('ImportRepositoryDialog polling', () => {
  test('polls the returned operation right after the import is queued', async () => {
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledWith('proj1', 'op1'));
  });

  test('clears the token field once the import is queued', async () => {
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalled());
    expect(screen.queryByDisplayValue('ghp_super_secret_token')).not.toBeInTheDocument();
  });

  test('shows progress from the polled status', async () => {
    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'IMPORT', state: 'RUNNING', progress: 42, errorCode: null, driftSummary: null });
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42'));
  });

  test('keeps polling on an interval while the operation is non-terminal', async () => {
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(mockGetGitOperation.mock.calls.length).toBeGreaterThan(1);
  });

  test('stops polling and routes to the new project once the import succeeds', async () => {
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'IMPORT', state: 'SUCCEEDED', progress: 100, errorCode: null, driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard/projects/proj1'));

    const callsAtSuccess = mockGetGitOperation.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockGetGitOperation.mock.calls.length).toBe(callsAtSuccess);
  });

  test('stops polling and explains an authentication failure', async () => {
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'IMPORT',
      state: 'FAILED',
      progress: 60,
      errorCode: 'authentication_failed',
    });
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });

    expect(await screen.findByText(/token was rejected/i)).toBeInTheDocument();
    const callsAtFailure = mockGetGitOperation.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockGetGitOperation.mock.calls.length).toBe(callsAtFailure);
  });

  test('reports an aborted import', async () => {
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'IMPORT', state: 'ABORTED', progress: 10, errorCode: null, driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });

    expect(await screen.findByText(/import was aborted/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('shows a neutral working label for a progress state it has no wording for', async () => {
    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'IMPORT',
      state: 'PREPARING',
      progress: 12,
      errorCode: null,
      driftSummary: null,
    });
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());

    expect(await screen.findByText(/working…\s*12%/i)).toBeInTheDocument();
  });

  test('falls back to generic wording for a failure code it has no message for', async () => {
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'IMPORT',
      state: 'FAILED',
      progress: 60,
      errorCode: 'some_new_code',
      driftSummary: null,
    });
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });

    expect(await screen.findByText('The import failed.')).toBeInTheDocument();
  });

  test('closing after a failed import asks to close', async () => {
    const { onOpenChange } = renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'IMPORT',
      state: 'FAILED',
      progress: 60,
      errorCode: 'repository_unreachable',
      driftSummary: null,
    });
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await screen.findByText(/could not be reached/i);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('closing while the import is still running asks to close', async () => {
    const { onOpenChange } = renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('a poll that answers after the dialog is gone routes nowhere', async () => {
    const pending = deferred();
    mockGetGitOperation.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve({ id: 'op1', kind: 'IMPORT', state: 'SUCCEEDED', progress: 100, errorCode: null, driftSummary: null });
    });

    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('ImportRepositoryDialog dismissal', () => {
  test('closes on Cancel without starting an import', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockImportRepository).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('stays open on Escape', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('stays open on a pointer-down outside it', async () => {
    const { onOpenChange } = renderDialog();
    // Radix attaches its outside-pointer listener on a 0ms timeout; let it register under the
    // suite's fake timers.
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    fireEvent(document.body, new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    fireEvent.click(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('offers Close instead of Cancel once the import is queued, since it keeps running regardless', async () => {
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });
});

describe('ImportRepositoryDialog token secrecy', () => {
  test('never logs the token to the console', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalled());

    const secret = 'ghp_super_secret_token';
    for (const spy of [logSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        expect(call.join(' ')).not.toContain(secret);
      }
    }
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('never writes the token to localStorage or sessionStorage', async () => {
    const localSetSpy = jest.spyOn(Storage.prototype, 'setItem');
    renderDialog();
    fillValidForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalled());

    for (const call of localSetSpy.mock.calls) {
      expect(call.join(' ')).not.toContain('ghp_super_secret_token');
    }
    localSetSpy.mockRestore();
  });
});
