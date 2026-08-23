import { useState } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CloneProjectDialog } from '@/components/clone-project-dialog';
import type { CloneFailure } from '@/components/clone-project-dialog';
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
  onCloneStarted?: () => void;
  onCloned?: (project: unknown) => void;
  onCloneFailed?: (failure: CloneFailure) => void;
}

function renderDialog({
  projectName = 'Docs',
  onOpenChange = jest.fn(),
  onCloneStarted = jest.fn(),
  onCloned = jest.fn(),
  onCloneFailed = jest.fn(),
}: RenderOptions = {}) {
  render(
    <CloneProjectDialog
      open
      onOpenChange={onOpenChange}
      projectId="p1"
      projectName={projectName}
      onCloneStarted={onCloneStarted}
      onCloned={onCloned}
      onCloneFailed={onCloneFailed}
    />,
  );
  return { onOpenChange, onCloneStarted, onCloned, onCloneFailed };
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

  test('announces the busy state and what dismissing it would do', async () => {
    mockClone.mockReturnValueOnce(new Promise(NEVER_RESOLVE));
    renderDialog();
    fireEvent.click(cloneButton());
    // Nothing here is reachable by other means: the pressed button goes disabled and loses focus,
    // and the bar itself carries no text. Only a live region gets any of it spoken.
    const announcement = await screen.findByRole('status');
    expect(within(announcement).getByRole('progressbar')).toBeInTheDocument();
    expect(announcement).toHaveTextContent(/copy will finish on its own/i);
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

  test('says too many clones were requested recently on the status alone', async () => {
    // The rate-limited code and the 429 status are two independent ways of learning the same thing,
    // and a proxy that answers before the API is reached sends only the status.
    mockClone.mockRejectedValueOnce(new ApiError(429, 'TOO_MANY_REQUESTS', 'slow down'));
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

  test('falls back to a generic message when the server sent an empty one', async () => {
    // An empty message survives the transport untouched, and the dialog shows nothing at all for a
    // blank string — it would drop back to idle with the failure unexplained.
    mockClone.mockRejectedValueOnce(new ApiError(500, 'CLONE_FAILED', '   '));
    renderDialog();
    fireEvent.click(cloneButton());
    expect(await screen.findByText(/failed to clone project/i)).toBeInTheDocument();
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
    // The account of the failed attempt is gone: leaving it beside a copy that has just been
    // created would describe the copy the user is about to be handed.
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });
});

describe('CloneProjectDialog success', () => {
  test('sends the trimmed name to the source project', async () => {
    renderDialog();
    fireEvent.change(nameField(), { target: { value: '  Handbook 2027  ' } });
    fireEvent.click(cloneButton());
    await waitFor(() => expect(mockClone).toHaveBeenCalledWith('p1', 'Handbook 2027'));
  });

  test('tells the caller a fresh attempt has begun as soon as the request goes out', async () => {
    mockClone.mockReturnValueOnce(new Promise(NEVER_RESOLVE));
    const { onCloneStarted } = renderDialog();
    fireEvent.click(cloneButton());
    await screen.findByRole('button', { name: 'Cloning…' });
    expect(onCloneStarted).toHaveBeenCalledTimes(1);
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

  test('stays available while a clone is in flight, since nothing else can dismiss the dialog', async () => {
    mockClone.mockReturnValueOnce(new Promise(NEVER_RESOLVE));
    const { onOpenChange } = renderDialog();
    fireEvent.click(cloneButton());
    await screen.findByRole('button', { name: 'Cloning…' });

    // Renamed while the copy runs, because it can no longer cancel anything: the server was already
    // asked for the copy and finishes it regardless. The wording beside the busy bar says so.
    const dismiss = screen.getByRole('button', { name: 'Close' });
    expect(dismiss).toBeEnabled();
    expect(screen.getByText(/copy will finish on its own/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();

    fireEvent.click(dismiss);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// Visibility is the caller's to decide, so asserting the field is still mounted would pass with no
// guards at all: the guards are what stop Radix from ever asking to close. Each guard gets its own
// case so that removing one cannot be covered for by the other.
describe('CloneProjectDialog dismissal guards', () => {
  test('stays open on Escape', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('stays open on a pointer-down outside it', async () => {
    const { onOpenChange } = renderDialog();
    // Radix attaches its outside-pointer listener on a 0ms timeout; let it register.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The pointer-down opens the outside interaction and the click completes it — Radix decides
    // nothing until both have happened, so firing only the first reaches no guard at all.
    fireEvent(document.body, new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    fireEvent.click(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('CloneProjectDialog dismissed while the copy runs', () => {
  interface DismissableDialogProperties {
    onCloned?: (project: unknown) => void;
    onCloneFailed?: (failure: CloneFailure) => void;
    onOpenChange?: (open: boolean) => void;
  }

  /**
   * Mirrors the card that owns the real dialog: closing it truly unmounts the form, which is the
   * condition under which a late outcome has no message area of its own left to be written into.
   * The visibility spy sits beside the state it drives, so a request settling after the dismissal
   * can be caught asking to close a dialog it no longer owns.
   */
  function DismissableDialog({
    onCloned = jest.fn(),
    onCloneFailed = jest.fn(),
    onOpenChange = jest.fn(),
  }: DismissableDialogProperties) {
    const [open, setOpen] = useState(true);
    return (
      <CloneProjectDialog
        open={open}
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
          setOpen(nextOpen);
        }}
        projectId="p1"
        projectName="Docs"
        onCloneStarted={jest.fn()}
        onCloned={onCloned}
        onCloneFailed={onCloneFailed}
      />
    );
  }

  test('hands a failure that lands after the dismissal to the caller', async () => {
    let rejectClone: ((reason: unknown) => void) | undefined;
    mockClone.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectClone = reject;
      }),
    );
    const onCloneFailed = jest.fn();
    render(<DismissableDialog onCloneFailed={onCloneFailed} />);

    fireEvent.click(cloneButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText(/name for the copy/i)).not.toBeInTheDocument());

    if (!rejectClone) throw new Error('the clone request was never started');
    rejectClone(new ApiError(403, 'FORBIDDEN', 'denied'));

    await waitFor(() =>
      expect(onCloneFailed).toHaveBeenCalledWith({
        code: 'FORBIDDEN',
        message: 'You no longer have access to that project.',
      }),
    );
  });

  test('tells the caller which refusal it was, not only how it reads', async () => {
    // The caller has to decide later whether this refusal is still true — a copy landing disproves
    // "a clone is already running" and disproves nothing else — and the sentence is written for a
    // reader, so the code is the only part of it that can be reasoned about.
    let rejectClone: ((reason: unknown) => void) | undefined;
    mockClone.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectClone = reject;
      }),
    );
    const onCloneFailed = jest.fn();
    render(<DismissableDialog onCloneFailed={onCloneFailed} />);

    fireEvent.click(cloneButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText(/name for the copy/i)).not.toBeInTheDocument());

    if (!rejectClone) throw new Error('the clone request was never started');
    rejectClone(new ApiError(409, 'CLONE_IN_PROGRESS', 'already running'));

    await waitFor(() =>
      expect(onCloneFailed).toHaveBeenCalledWith({
        code: 'CLONE_IN_PROGRESS',
        message: 'A clone is already running. Wait for it to finish, then try again.',
      }),
    );
  });

  test('reports a failure the server never answered with no code at all', async () => {
    // A request that never reached an answer — the network dropped — has no code to carry, and
    // inventing one would let the caller treat it as a refusal the server never made.
    let rejectClone: ((reason: unknown) => void) | undefined;
    mockClone.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectClone = reject;
      }),
    );
    const onCloneFailed = jest.fn();
    render(<DismissableDialog onCloneFailed={onCloneFailed} />);

    fireEvent.click(cloneButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText(/name for the copy/i)).not.toBeInTheDocument());

    if (!rejectClone) throw new Error('the clone request was never started');
    rejectClone(new TypeError('Failed to fetch'));

    await waitFor(() =>
      expect(onCloneFailed).toHaveBeenCalledWith({
        code: undefined,
        message: 'Failed to clone project.',
      }),
    );
  });

  test('hands a copy that lands after the dismissal to the caller without asking to close again', async () => {
    let resolveClone: ((value: unknown) => void) | undefined;
    mockClone.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClone = resolve;
      }),
    );
    const onCloned = jest.fn();
    const onOpenChange = jest.fn();
    render(<DismissableDialog onCloned={onCloned} onOpenChange={onOpenChange} />);

    fireEvent.click(cloneButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText(/name for the copy/i)).not.toBeInTheDocument());
    expect(onOpenChange).toHaveBeenCalledTimes(1);

    if (!resolveClone) throw new Error('the clone request was never started');
    resolveClone({ data: clonedProject });

    // The copy is real, so the caller still has to hear about it and show the card.
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith(clonedProject));
    // Asking to close a second time would shut whatever dialog the user has opened since, taking
    // the name they have typed into it with it.
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  test('keeps a failure inside the dialog while it is still open', async () => {
    mockClone.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'denied'));
    const { onCloneFailed } = renderDialog();
    fireEvent.click(cloneButton());

    await screen.findByText(/no longer have access to that project/i);
    expect(onCloneFailed).not.toHaveBeenCalled();
  });
});
