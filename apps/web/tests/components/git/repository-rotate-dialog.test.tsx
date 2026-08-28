import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RotateCredentialDialog } from '@/components/git/repository-rotate-dialog';
import { ApiError } from '@/lib/api/transport';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

const mockRotateGitCredential = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  rotateGitCredential: (...parameters: unknown[]) => mockRotateGitCredential(...parameters),
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
  const view = render(<RotateCredentialDialog projectId={PROJECT_ID} open onOpenChange={onOpenChange} />);
  return { onOpenChange, unmount: view.unmount, rerender: view.rerender };
}

const tokenField = () => screen.getByLabelText(/new access token/i);

beforeEach(() => {
  jest.clearAllMocks();
  mockRotateGitCredential.mockResolvedValue({ tokenHint: '…a1b2' });
});

describe('RotateCredentialDialog submission', () => {
  test('rotates and shows the returned hint rather than the token', async () => {
    renderDialog();
    fireEvent.change(tokenField(), { target: { value: 'ghp_new_secret_value' } });
    fireEvent.click(screen.getByRole('button', { name: /^rotate credential$/i }));

    await waitFor(() =>
      expect(mockRotateGitCredential).toHaveBeenCalledWith(PROJECT_ID, { token: 'ghp_new_secret_value' }),
    );
    expect(await screen.findByText(/ends in …a1b2/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('ghp_new_secret_value')).not.toBeInTheDocument();
  });

  test('names the hint as unknown when the server returns none', async () => {
    mockRotateGitCredential.mockResolvedValue({ tokenHint: null });
    renderDialog();
    fireEvent.change(tokenField(), { target: { value: 'ghp_new_secret_value' } });
    fireEvent.click(screen.getByRole('button', { name: /^rotate credential$/i }));

    expect(await screen.findByText(/ends in an unknown value/i)).toBeInTheDocument();
  });

  test('sends nothing when the form is submitted with an empty token', async () => {
    renderDialog();
    const form = tokenField().closest('form');
    expect(form).not.toBeNull();

    await act(async () => {
      if (form) fireEvent.submit(form);
    });

    expect(mockRotateGitCredential).not.toHaveBeenCalled();
  });

  test('shows the mapped message when the rotation is refused', async () => {
    mockRotateGitCredential.mockRejectedValue(new ApiError(403, 'insufficient_role', 'nope'));
    renderDialog();
    fireEvent.change(tokenField(), { target: { value: 'ghp_new_secret_value' } });
    fireEvent.click(screen.getByRole('button', { name: /^rotate credential$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/owner access to rotate/i);
    expect(screen.getByRole('button', { name: /^rotate credential$/i })).toBeEnabled();
  });

  test('shows a generic message when the request never reaches the server', async () => {
    mockRotateGitCredential.mockRejectedValue(new TypeError('Failed to fetch'));
    renderDialog();
    fireEvent.change(tokenField(), { target: { value: 'ghp_new_secret_value' } });
    fireEvent.click(screen.getByRole('button', { name: /^rotate credential$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't rotate the credential/i);
  });
});

describe('RotateCredentialDialog rotations that settle after dismissal', () => {
  test('a rotation that resolves after dismissal shows no hint', async () => {
    const pending = deferred();
    mockRotateGitCredential.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    fireEvent.change(tokenField(), { target: { value: 'ghp_new_secret_value' } });
    fireEvent.click(screen.getByRole('button', { name: /^rotate credential$/i }));
    await waitFor(() => expect(mockRotateGitCredential).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve({ tokenHint: '…a1b2' });
    });

    expect(screen.queryByText(/ends in/i)).not.toBeInTheDocument();
  });

  test('a rotation refused after dismissal shows no error', async () => {
    const pending = deferred();
    mockRotateGitCredential.mockReturnValue(pending.promise);
    const { unmount } = renderDialog();
    fireEvent.change(tokenField(), { target: { value: 'ghp_new_secret_value' } });
    fireEvent.click(screen.getByRole('button', { name: /^rotate credential$/i }));
    await waitFor(() => expect(mockRotateGitCredential).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.reject(new ApiError(403, 'insufficient_role', 'nope'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('RotateCredentialDialog dismissal', () => {
  test('asks to close when the Close button is pressed', () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('stays open when Escape is pressed or a pointer goes down outside it', async () => {
    const { onOpenChange } = renderDialog();
    fireEvent.change(tokenField(), { target: { value: 'ghp_new_secret_value' } });
    fireEvent.click(screen.getByRole('button', { name: /^rotate credential$/i }));
    expect(await screen.findByText(/ends in …a1b2/i)).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });

    expect(screen.getByText(/ends in …a1b2/i)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('renders nothing while closed', () => {
    render(<RotateCredentialDialog projectId={PROJECT_ID} open={false} onOpenChange={jest.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
