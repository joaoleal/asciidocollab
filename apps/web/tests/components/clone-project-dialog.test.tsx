import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CloneProjectDialog } from '@/components/clone-project-dialog';
import { ApiError } from '@/lib/api/transport';

const mockClone = jest.fn();

jest.mock('@/lib/api', () => ({
  projectsApi: {
    clone: (id: string, name: string) => mockClone(id, name),
  },
}));

/** Executor for a promise that intentionally never settles, so the pending state stays observable. */
const NEVER_RESOLVE = () => undefined;

const clonedProject = {
  id: 'p2',
  name: 'Copy of Docs',
  description: null,
  owners: [{ userId: 'u1', displayName: 'Ada' }],
  tags: [],
  rootFolderId: 'r2',
  mainFileNodeId: null,
  language: null,
  archivedAt: null,
  memberCount: 1,
  fileCount: 4,
  role: 'owner',
  createdAt: '2026-08-22T10:15:00.000Z',
  updatedAt: '2026-08-22T10:15:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockClone.mockResolvedValue({ data: clonedProject });
});

interface RenderOptions {
  projectName?: string;
  onOpenChange?: (open: boolean) => void;
  onCloned?: (project: unknown) => void;
}

function renderDialog({ projectName = 'Docs', onOpenChange = jest.fn(), onCloned = jest.fn() }: RenderOptions = {}) {
  render(
    <CloneProjectDialog
      open
      onOpenChange={onOpenChange}
      projectId="p1"
      projectName={projectName}
      onCloned={onCloned}
    />,
  );
  return { onOpenChange, onCloned };
}

const nameField = () => screen.getByLabelText(/name for the copy/i);
const cloneButton = () => screen.getByRole('button', { name: /^(Clone|Cloning…)$/ });

describe('CloneProjectDialog suggested name', () => {
  test('pre-fills a copy name derived from the source project', () => {
    renderDialog();
    expect(nameField()).toHaveValue('Copy of Docs');
  });

  test('selects the whole suggestion so the first keystroke replaces it', async () => {
    renderDialog();
    const field = nameField();
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveProperty('selectionStart', 0);
    expect(field).toHaveProperty('selectionEnd', 'Copy of Docs'.length);
  });

  test('truncates the whole suggestion to the longest name the server accepts', () => {
    renderDialog({ projectName: 'N'.repeat(200) });
    const field = nameField();
    expect(field).toHaveValue(`Copy of ${'N'.repeat(92)}`);
    expect(field).toHaveProperty('value.length', 100);
  });
});

describe('CloneProjectDialog validation', () => {
  test('disables Clone and explains the problem when the name is only whitespace', () => {
    renderDialog();
    fireEvent.change(nameField(), { target: { value: '   ' } });
    expect(cloneButton()).toBeDisabled();
    expect(screen.getByText(/enter a name for the copy/i)).toBeInTheDocument();
  });

  test('sends nothing while the name is only whitespace', () => {
    renderDialog();
    fireEvent.change(nameField(), { target: { value: '   ' } });
    fireEvent.click(cloneButton());
    expect(mockClone).not.toHaveBeenCalled();
  });

  test('keeps Clone enabled for a name that is non-empty once trimmed', () => {
    renderDialog();
    fireEvent.change(nameField(), { target: { value: '  Handbook 2027  ' } });
    expect(cloneButton()).toBeEnabled();
    expect(screen.queryByText(/enter a name for the copy/i)).not.toBeInTheDocument();
  });
});

describe('CloneProjectDialog pending state', () => {
  test('shows an indeterminate busy indicator while the clone is running', async () => {
    mockClone.mockReturnValueOnce(new Promise(NEVER_RESOLVE));
    renderDialog();
    fireEvent.click(cloneButton());
    const indicator = await screen.findByRole('progressbar');
    expect(indicator).not.toHaveAttribute('aria-valuenow');
  });

  test('disables Clone while the request is in flight so a second click cannot submit twice', async () => {
    mockClone.mockReturnValueOnce(new Promise(NEVER_RESOLVE));
    renderDialog();
    fireEvent.click(cloneButton());
    const button = await screen.findByRole('button', { name: 'Cloning…' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mockClone).toHaveBeenCalledTimes(1);
  });
});

describe('CloneProjectDialog error copy', () => {
  test('says another clone is already running', async () => {
    mockClone.mockRejectedValueOnce(new ApiError(409, 'CLONE_IN_PROGRESS', 'already running'));
    renderDialog();
    fireEvent.click(cloneButton());
    expect(await screen.findByText(/clone is already running/i)).toBeInTheDocument();
  });

  test('says too many clones were requested recently', async () => {
    mockClone.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'slow down'));
    renderDialog();
    fireEvent.click(cloneButton());
    expect(await screen.findByText(/too many clones recently/i)).toBeInTheDocument();
  });

  test('names the file whose current content could not be read and invites a retry', async () => {
    mockClone.mockRejectedValueOnce(
      new ApiError(503, 'LIVE_CONTENT_UNAVAILABLE', 'unreadable', undefined, {
        path: '/chapters/intro.adoc',
      }),
    );
    renderDialog();
    fireEvent.click(cloneButton());
    const message = await screen.findByText(/\/chapters\/intro\.adoc/);
    expect(message).toHaveTextContent(/try again/i);
  });

  test('still invites a retry when the server names no unreadable file', async () => {
    mockClone.mockRejectedValueOnce(new ApiError(503, 'LIVE_CONTENT_UNAVAILABLE', 'unreadable'));
    renderDialog();
    fireEvent.click(cloneButton());
    expect(await screen.findByText(/could not read the current content/i)).toHaveTextContent(/try again/i);
  });

  test('says access to the source project has been lost', async () => {
    mockClone.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'denied'));
    renderDialog();
    fireEvent.click(cloneButton());
    expect(await screen.findByText(/no longer have access to that project/i)).toBeInTheDocument();
  });

  test("shows the server's own message when the name is rejected", async () => {
    mockClone.mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', 'Name must be 100 characters or fewer'));
    renderDialog();
    fireEvent.click(cloneButton());
    expect(await screen.findByText('Name must be 100 characters or fewer')).toBeInTheDocument();
  });

  test("shows the server's own message when the clone fails for an unforeseen reason", async () => {
    mockClone.mockRejectedValueOnce(new ApiError(500, 'CLONE_FAILED', 'The copy could not be completed'));
    renderDialog();
    fireEvent.click(cloneButton());
    expect(await screen.findByText('The copy could not be completed')).toBeInTheDocument();
  });

  test('falls back to a generic message when the failure is not an API error', async () => {
    mockClone.mockRejectedValueOnce('nope');
    renderDialog();
    fireEvent.click(cloneButton());
    expect(await screen.findByText(/failed to clone project/i)).toBeInTheDocument();
  });
});

describe('CloneProjectDialog after a failure', () => {
  test('stays open with the edited name preserved', async () => {
    mockClone.mockRejectedValueOnce(new ApiError(500, 'CLONE_FAILED', 'boom'));
    const { onOpenChange } = renderDialog();
    fireEvent.change(nameField(), { target: { value: 'Handbook 2027' } });
    fireEvent.click(cloneButton());
    await screen.findByText('boom');
    expect(nameField()).toHaveValue('Handbook 2027');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('lets the user retry, and clears the previous message on success', async () => {
    mockClone.mockRejectedValueOnce(new ApiError(500, 'CLONE_FAILED', 'boom'));
    const { onCloned } = renderDialog();
    fireEvent.click(cloneButton());
    await screen.findByText('boom');
    fireEvent.click(cloneButton());
    await waitFor(() => expect(onCloned).toHaveBeenCalledTimes(1));
    expect(mockClone).toHaveBeenCalledTimes(2);
  });
});

describe('CloneProjectDialog success', () => {
  test('sends the trimmed name to the source project', async () => {
    renderDialog();
    fireEvent.change(nameField(), { target: { value: '  Handbook 2027  ' } });
    fireEvent.click(cloneButton());
    await waitFor(() => expect(mockClone).toHaveBeenCalledWith('p1', 'Handbook 2027'));
  });

  test('hands the created project back to the caller and closes the dialog', async () => {
    const { onCloned, onOpenChange } = renderDialog();
    fireEvent.click(cloneButton());
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith(clonedProject));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('CloneProjectDialog cancel', () => {
  test('closes without cloning', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockClone).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('is disabled while a clone is in flight', async () => {
    mockClone.mockReturnValueOnce(new Promise(NEVER_RESOLVE));
    renderDialog();
    fireEvent.click(cloneButton());
    await screen.findByRole('button', { name: 'Cloning…' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});

describe('CloneProjectDialog dismissal guards', () => {
  test('stays open on Escape and on a pointer-down outside it', async () => {
    renderDialog();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent(document.body, new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    fireEvent.click(document.body);
    expect(nameField()).toBeInTheDocument();
  });
});
