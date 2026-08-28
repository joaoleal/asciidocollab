import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RepositorySection } from '@/components/git/repository-section';
import { ApiError } from '@/lib/api/transport';

const mockConnectRepository = jest.fn();
const mockInitializeRepository = jest.fn();
const mockDisconnectRepository = jest.fn();
const mockRotateGitCredential = jest.fn();
const mockGetGitOperation = jest.fn();
const mockGetOAuthProviders = jest.fn();
const mockStartGitOAuth = jest.fn();
const mockNavigateTo = jest.fn();

jest.mock('@/lib/navigate', () => ({
  navigateTo: (...parameters: unknown[]) => mockNavigateTo(...parameters),
}));

/** The visibility seam every dialog this section hosts exposes back to it. */
interface HostedDialogSeam {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Each hosted dialog's latest visibility seam, keyed by which action it belongs to. */
const mockHostedDialogs = new Map<string, HostedDialogSeam>();

// The hosted dialogs are wrapped rather than replaced, so this file still exercises them end to end
// while their `onOpenChange` seams stay reachable — none of them ever asks to *open*, so that half
// of each seam has to be driven directly.
jest.mock('@/components/git/repository-connect-dialog', () => {
  const actual = jest.requireActual('@/components/git/repository-connect-dialog');
  const react = jest.requireActual('react');
  return {
    ...actual,
    ConnectOrInitializeDialog: (properties: HostedDialogSeam & { mode: string }) => {
      mockHostedDialogs.set(properties.mode, properties);
      return react.createElement(actual.ConnectOrInitializeDialog, properties);
    },
  };
});

jest.mock('@/components/git/repository-rotate-dialog', () => {
  const actual = jest.requireActual('@/components/git/repository-rotate-dialog');
  const react = jest.requireActual('react');
  return {
    ...actual,
    RotateCredentialDialog: (properties: HostedDialogSeam) => {
      mockHostedDialogs.set('rotate', properties);
      return react.createElement(actual.RotateCredentialDialog, properties);
    },
  };
});

jest.mock('@/components/git/repository-disconnect-dialog', () => {
  const actual = jest.requireActual('@/components/git/repository-disconnect-dialog');
  const react = jest.requireActual('react');
  return {
    ...actual,
    DisconnectDialog: (properties: HostedDialogSeam) => {
      mockHostedDialogs.set('disconnect', properties);
      return react.createElement(actual.DisconnectDialog, properties);
    },
  };
});

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  connectRepository: (...parameters: unknown[]) => mockConnectRepository(...parameters),
  initializeRepository: (...parameters: unknown[]) => mockInitializeRepository(...parameters),
  disconnectRepository: (...parameters: unknown[]) => mockDisconnectRepository(...parameters),
  rotateGitCredential: (...parameters: unknown[]) => mockRotateGitCredential(...parameters),
  getGitOperation: (...parameters: unknown[]) => mockGetGitOperation(...parameters),
  getOAuthProviders: (...parameters: unknown[]) => mockGetOAuthProviders(...parameters),
  startGitOAuth: (...parameters: unknown[]) => mockStartGitOAuth(...parameters),
}));

const mockRefetch = jest.fn();

interface FakeGitStatus {
  branch: string;
  syncStatus: string;
  ahead: number;
  behind: number;
  lastSyncAt: string | null;
}

/** Mutable stand-in for `useGitStatus`'s result — mutated per test rather than re-rendered. */
const gitStatus: {
  status: FakeGitStatus | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
  refetch: typeof mockRefetch;
} = {
  status: null,
  connected: false,
  loading: false,
  error: null,
  refetch: mockRefetch,
};

jest.mock('@/hooks/use-git-status', () => ({
  useGitStatus: () => gitStatus,
}));

jest.useFakeTimers();

const PROJECT_ID = 'proj-1';

function renderSection() {
  return render(<RepositorySection projectId={PROJECT_ID} />);
}

const remoteUrlField = () => screen.getByLabelText(/remote url/i);
const tokenField = () => screen.getByLabelText(/^access token$/i);

/** Fills the shared connect/initialize form with a valid remote URL and token. */
function fillValidForm() {
  fireEvent.change(remoteUrlField(), { target: { value: 'https://github.com/acme/handbook.git' } });
  fireEvent.change(tokenField(), { target: { value: 'ghp_super_secret_token' } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHostedDialogs.clear();
  gitStatus.status = null;
  gitStatus.connected = false;
  gitStatus.loading = false;
  gitStatus.error = null;
  mockConnectRepository.mockResolvedValue({ repository: {} });
  mockInitializeRepository.mockResolvedValue({ operationId: 'op1', projectId: PROJECT_ID });
  mockDisconnectRepository.mockResolvedValue({ ok: true });
  mockRotateGitCredential.mockResolvedValue({ tokenHint: '…a1b2' });
  mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'INITIALIZE', state: 'QUEUED', progress: 0, errorCode: null, driftSummary: null });
  mockGetOAuthProviders.mockResolvedValue({ providers: [] });
  mockStartGitOAuth.mockResolvedValue({ authorizeUrl: 'https://github.com/login/oauth/authorize?mock=1' });
});

afterEach(() => {
  jest.clearAllTimers();
});

describe('RepositorySection — loading', () => {
  test('renders no actionable controls while loading', () => {
    gitStatus.loading = true;
    renderSection();
    expect(screen.queryByRole('button', { name: /connect to a remote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rotate credential/i })).not.toBeInTheDocument();
  });
});

describe('RepositorySection — disconnected', () => {
  test('offers connect and initialize actions, but not rotate/disconnect', () => {
    renderSection();
    expect(screen.getByRole('button', { name: /connect to a remote/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /initialize & publish/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rotate credential/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^disconnect$/i })).not.toBeInTheDocument();
  });

  test('connecting submits the form and reloads status on success', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() =>
      expect(mockConnectRepository).toHaveBeenCalledWith(PROJECT_ID, {
        provider: 'github',
        remoteUrl: 'https://github.com/acme/handbook.git',
        token: 'ghp_super_secret_token',
        branch: undefined,
      }),
    );
    await waitFor(() => expect(mockRefetch).toHaveBeenCalled());
  });

  test('shows the mapped error for a non-owner connect attempt without reloading status', async () => {
    mockConnectRepository.mockRejectedValueOnce(new ApiError(403, 'insufficient_role', 'nope'));
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/owner access to connect/i);
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  test('initializing starts the queued operation and clears the token', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /initialize & publish/i }));
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /^initialize & publish$/i }));

    await waitFor(() =>
      expect(mockInitializeRepository).toHaveBeenCalledWith(PROJECT_ID, {
        provider: 'github',
        remoteUrl: 'https://github.com/acme/handbook.git',
        token: 'ghp_super_secret_token',
        branch: undefined,
      }),
    );
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledWith(PROJECT_ID, 'op1'));
    expect(screen.queryByDisplayValue('ghp_super_secret_token')).not.toBeInTheDocument();
  });

  test('polls to SUCCEEDED, then reloads status and closes', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /initialize & publish/i }));
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /^initialize & publish$/i }));
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({ id: 'op1', kind: 'INITIALIZE', state: 'SUCCEEDED', progress: 100, errorCode: null, driftSummary: null });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    await waitFor(() => expect(mockRefetch).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('shows the mapped terminal-failure message on FAILED without reloading status', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /initialize & publish/i }));
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /^initialize & publish$/i }));
    await waitFor(() => expect(mockGetGitOperation).toHaveBeenCalledTimes(1));

    mockGetGitOperation.mockResolvedValue({
      id: 'op1',
      kind: 'INITIALIZE',
      state: 'FAILED',
      progress: 40,
      errorCode: 'authentication_failed',
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    expect(await screen.findByText(/token was rejected/i)).toBeInTheDocument();
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  test('the connect dialog is not dismissed by Escape or an outside click', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent(document.body, new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('RepositorySection — guided OAuth connect', () => {
  test('the OAuth button is hidden while no provider has guided connect available', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    await waitFor(() => expect(mockGetOAuthProviders).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /connect with github/i })).not.toBeInTheDocument(),
    );
  });

  test('the OAuth button shows for the selected provider once it is reported available', async () => {
    mockGetOAuthProviders.mockResolvedValue({ providers: ['github'] });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));

    expect(await screen.findByRole('button', { name: /connect with github/i })).toBeInTheDocument();
  });

  test('the OAuth button hides again after switching to a provider that is not available', async () => {
    mockGetOAuthProviders.mockResolvedValue({ providers: ['github'] });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    await screen.findByRole('button', { name: /connect with github/i });

    fireEvent.click(screen.getByRole('radio', { name: /gitlab/i }));

    expect(screen.queryByRole('button', { name: /connect with/i })).not.toBeInTheDocument();
  });

  test('is disabled until a remote URL is entered, and needs no token', async () => {
    mockGetOAuthProviders.mockResolvedValue({ providers: ['github'] });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    const oauthButton = await screen.findByRole('button', { name: /connect with github/i });
    expect(oauthButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/remote url/i), {
      target: { value: 'https://github.com/acme/handbook.git' },
    });
    expect(oauthButton).toBeEnabled();
  });

  test('clicking posts the start endpoint with the entered remote/branch, then redirects the browser to the authorize URL', async () => {
    mockGetOAuthProviders.mockResolvedValue({ providers: ['github'] });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    const oauthButton = await screen.findByRole('button', { name: /connect with github/i });
    fireEvent.change(screen.getByLabelText(/remote url/i), {
      target: { value: 'https://github.com/acme/handbook.git' },
    });
    fireEvent.change(screen.getByLabelText(/branch/i), { target: { value: 'develop' } });

    fireEvent.click(oauthButton);

    await waitFor(() =>
      expect(mockStartGitOAuth).toHaveBeenCalledWith(PROJECT_ID, 'github', {
        remoteUrl: 'https://github.com/acme/handbook.git',
        branch: 'develop',
      }),
    );
    await waitFor(() =>
      expect(mockNavigateTo).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?mock=1'),
    );
  });

  test('shows the mapped error, and does not redirect, when the start request is refused', async () => {
    mockGetOAuthProviders.mockResolvedValue({ providers: ['github'] });
    mockStartGitOAuth.mockRejectedValueOnce(new ApiError(403, 'insufficient_role', 'nope'));
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    const oauthButton = await screen.findByRole('button', { name: /connect with github/i });
    fireEvent.change(screen.getByLabelText(/remote url/i), {
      target: { value: 'https://github.com/acme/handbook.git' },
    });

    fireEvent.click(oauthButton);

    expect(await screen.findByRole('alert')).toHaveTextContent(/owner access to connect/i);
    expect(mockNavigateTo).not.toHaveBeenCalled();
  });

  test('manual PAT entry still works when the OAuth button is shown', async () => {
    mockGetOAuthProviders.mockResolvedValue({ providers: ['github'] });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    await screen.findByRole('button', { name: /connect with github/i });
    fillValidForm();

    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() =>
      expect(mockConnectRepository).toHaveBeenCalledWith(PROJECT_ID, {
        provider: 'github',
        remoteUrl: 'https://github.com/acme/handbook.git',
        token: 'ghp_super_secret_token',
        branch: undefined,
      }),
    );
  });

  test('the OAuth button never appears in the initialize dialog', async () => {
    mockGetOAuthProviders.mockResolvedValue({ providers: ['github'] });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /initialize & publish/i }));
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    expect(screen.queryByRole('button', { name: /connect with/i })).not.toBeInTheDocument();
  });
});

describe('RepositorySection — connected', () => {
  beforeEach(() => {
    gitStatus.connected = true;
    gitStatus.status = { branch: 'main', syncStatus: 'UP_TO_DATE', ahead: 0, behind: 0, lastSyncAt: null };
  });

  test('offers rotate and disconnect actions, but not connect/initialize', () => {
    renderSection();
    expect(screen.getByRole('button', { name: /rotate credential/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^disconnect$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect to a remote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /initialize & publish/i })).not.toBeInTheDocument();
  });

  test('shows the branch from the existing git status without fetching anything new', () => {
    renderSection();
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  test('rotating shows the returned token hint and clears the field', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /rotate credential/i }));
    fireEvent.change(screen.getByLabelText(/new access token/i), { target: { value: 'ghp_new_secret_value' } });
    fireEvent.click(screen.getByRole('button', { name: /^rotate credential$/i }));

    await waitFor(() => expect(mockRotateGitCredential).toHaveBeenCalledWith(PROJECT_ID, { token: 'ghp_new_secret_value' }));
    expect(await screen.findByText(/ends in …a1b2/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('ghp_new_secret_value')).not.toBeInTheDocument();
  });

  test('shows the mapped error for a rejected rotation', async () => {
    mockRotateGitCredential.mockRejectedValueOnce(new ApiError(403, 'insufficient_role', 'nope'));
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /rotate credential/i }));
    fireEvent.change(screen.getByLabelText(/new access token/i), { target: { value: 'ghp_new_secret_value' } });
    fireEvent.click(screen.getByRole('button', { name: /^rotate credential$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/owner access to rotate/i);
  });

  test('the disconnect dialog names the consequence in its Dialog.Description', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /^disconnect$/i }));
    const dialog = screen.getByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.querySelector(`[id="${describedBy}"]`)?.textContent).toMatch(/credential/i);
  });

  test('disconnecting only happens on the explicit confirm button', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /^disconnect$/i }));
    expect(mockDisconnectRepository).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^disconnect$/i }));

    await waitFor(() => expect(mockDisconnectRepository).toHaveBeenCalledWith(PROJECT_ID));
    await waitFor(() => expect(mockRefetch).toHaveBeenCalled());
  });

  test('cancelling the disconnect dialog does not call disconnect', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /^disconnect$/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(mockDisconnectRepository).not.toHaveBeenCalled();
  });

  test('shows the mapped error for a rejected disconnect', async () => {
    mockDisconnectRepository.mockRejectedValueOnce(new ApiError(404, 'repository_not_connected', 'nope'));
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /^disconnect$/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^disconnect$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no connected repository/i);
    expect(mockRefetch).not.toHaveBeenCalled();
  });
});

/** Drives one hosted dialog's visibility seam and settles the resulting render. */
async function requestVisibility(key: string, open: boolean) {
  const seam = mockHostedDialogs.get(key);
  expect(seam).toBeDefined();
  await act(async () => {
    seam?.onOpenChange(open);
  });
}

/** Lets the newly opened dialog's own mount-time lookups settle before anything is asserted. */
async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
}

describe('RepositorySection — hosted dialog visibility', () => {
  test('a request to reopen the connect dialog leaves it open', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    await settle();
    await requestVisibility('connect', true);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/remote url/i)).toBeInTheDocument();
  });

  test('a request to reopen the initialize dialog leaves it open', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /initialize & publish/i }));
    await settle();
    await requestVisibility('initialize', true);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('closing the connect dialog through its own seam hides it', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    await settle();
    await requestVisibility('connect', false);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('closing the rotate dialog hides it, and a reopen request leaves it open', async () => {
    gitStatus.connected = true;
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /rotate credential/i }));
    expect(screen.getByLabelText(/new access token/i)).toBeInTheDocument();

    await requestVisibility('rotate', true);
    expect(screen.getByLabelText(/new access token/i)).toBeInTheDocument();

    await requestVisibility('rotate', false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('a request to reopen the disconnect dialog leaves it open', async () => {
    gitStatus.connected = true;
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /^disconnect$/i }));
    await requestVisibility('disconnect', true);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('RepositorySection — no hardcoded colors', () => {
  test('every rendered className carries only design tokens, disconnected view', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    for (const element of document.querySelectorAll('[class]')) {
      const className = element.getAttribute('class') ?? '';
      expect(className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(className).not.toMatch(/rgb\(/);
    }
  });

  test('every rendered className carries only design tokens, connected view', () => {
    gitStatus.connected = true;
    gitStatus.status = { branch: 'main', syncStatus: 'UP_TO_DATE', ahead: 0, behind: 0, lastSyncAt: null };
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /^disconnect$/i }));
    for (const element of document.querySelectorAll('[class]')) {
      const className = element.getAttribute('class') ?? '';
      expect(className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(className).not.toMatch(/rgb\(/);
    }
  });
});

describe('RepositorySection — token secrecy', () => {
  test('never logs a submitted token to the console', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /connect to a remote/i }));
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(mockConnectRepository).toHaveBeenCalled());

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
});
