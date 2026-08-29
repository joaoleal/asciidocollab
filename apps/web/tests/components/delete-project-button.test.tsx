import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { DeleteProjectButton } from '@/components/delete-project-button';

const mockDelete = jest.fn();

jest.mock('@/lib/api', () => ({
  projectsApi: {
    delete: (id: string) => mockDelete(id),
  },
}));

/** The shape of the dismissal events Radix hands to the outside-interaction guards. */
interface DismissEvent {
  preventDefault: () => void;
}

// Capture the Radix onOpenChange so a test can drive the close path directly while
// leaving the rest of the dialog primitives intact. The outside-pointer guard is captured the
// same way: Radix decides on its own whether an outside pointer-down counts as a dismissal, and
// under jsdom it never does, so the guard has to be exercised through the handler itself.
let capturedOnOpenChange: ((open: boolean) => void) | undefined;
let capturedPointerDownOutside: ((event: DismissEvent) => void) | undefined;
jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Root: ({
      onOpenChange,
      ...rest
    }: {
      onOpenChange: (open: boolean) => void;
      children: React.ReactNode;
    }) => {
      capturedOnOpenChange = onOpenChange;
      return <actual.Root onOpenChange={onOpenChange} {...rest} />;
    },
    Content: ({
      onPointerDownOutside,
      ...rest
    }: {
      onPointerDownOutside: (event: DismissEvent) => void;
      children: React.ReactNode;
    }) => {
      capturedPointerDownOutside = onPointerDownOutside;
      return <actual.Content onPointerDownOutside={onPointerDownOutside} {...rest} />;
    },
  };
});

// Executor for a promise that intentionally never settles.
const NEVER_RESOLVE = () => undefined;

const getDialogConfirm = () =>
  within(screen.getByRole('dialog')).getByRole('button', { name: /^(Delete Project|Deleting…)$/ });

beforeEach(() => {
  jest.clearAllMocks();
  mockDelete.mockResolvedValue({ data: { id: 'p1' } });
});

const openDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Delete Project' }));
};

describe('DeleteProjectButton', () => {
  test('renders the trigger button', () => {
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Delete Project' })).toBeInTheDocument();
  });

  test('opens the dialog with the confirmation prompt', () => {
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    openDialog();
    expect(screen.getByText(/permanent and cannot be undone/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Type/)).toBeInTheDocument();
  });

  test('keeps the delete button disabled until the name matches', () => {
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    openDialog();
    // Two buttons share the label; pick the one inside the dialog footer (disabled initially).
    const dialogConfirm = getDialogConfirm();
    expect(dialogConfirm).toBeDisabled();
  });

  test('enables delete and calls the API once the name matches', async () => {
    const onDeleted = jest.fn();
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={onDeleted} />);
    openDialog();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Docs' } });
    const dialogConfirm = getDialogConfirm();
    expect(dialogConfirm).toBeEnabled();
    fireEvent.click(dialogConfirm);
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('p1'));
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  test('does not call the API when the typed name does not match', () => {
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    openDialog();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Wrong' } });
    const dialogConfirm = getDialogConfirm();
    fireEvent.click(dialogConfirm);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('shows the error message when deletion fails with an Error', async () => {
    mockDelete.mockRejectedValueOnce(new Error('Server exploded'));
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    openDialog();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Docs' } });
    fireEvent.click(getDialogConfirm());
    expect(await screen.findByText('Server exploded')).toBeInTheDocument();
  });

  test('shows a generic message when the rejection is not an Error', async () => {
    mockDelete.mockRejectedValueOnce('nope');
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    openDialog();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Docs' } });
    fireEvent.click(getDialogConfirm());
    expect(await screen.findByText('Failed to delete project')).toBeInTheDocument();
  });

  test('shows a loading label while the deletion is in flight', async () => {
    // A promise that never settles keeps the component in its loading state.
    mockDelete.mockReturnValueOnce(new Promise(NEVER_RESOLVE));
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    openDialog();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Docs' } });
    fireEvent.click(getDialogConfirm());
    expect(await screen.findByRole('button', { name: 'Deleting…' })).toBeDisabled();
  });

  test('keeps the dialog open on escape and outside pointer-down', async () => {
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    openDialog();
    // Radix attaches its outside-pointer listener on a 0ms timeout; let it register.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent(document.body, new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    expect(screen.getByText(/permanent and cannot be undone/)).toBeInTheDocument();
  });

  test('resets typed text when Radix requests a close', () => {
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    openDialog();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Docs' } });
    // Drive the captured handler with false: exercises the reset branch in handleOpenChange.
    act(() => capturedOnOpenChange?.(false));
    expect(screen.queryByText(/permanent and cannot be undone/)).not.toBeInTheDocument();
    openDialog();
    expect(screen.getByLabelText(/Type/)).toHaveValue('');
  });

  test('refuses an outside pointer-down as a way of dismissing the confirmation', () => {
    capturedPointerDownOutside = undefined as ((event: DismissEvent) => void) | undefined;
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    openDialog();
    const preventDefault = jest.fn();
    expect(capturedPointerDownOutside).toBeDefined();
    capturedPointerDownOutside?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test('keeps the typed value when Radix reports the dialog opening', () => {
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    openDialog();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Do' } });
    // Reporting an open must not run the reset path that a close does.
    act(() => capturedOnOpenChange?.(true));
    expect(screen.getByLabelText(/Type/)).toHaveValue('Do');
  });

  test('cancel clears the typed value and closes the dialog', () => {
    render(<DeleteProjectButton projectId="p1" projectName="Docs" onDeleted={jest.fn()} />);
    openDialog();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/permanent and cannot be undone/)).not.toBeInTheDocument();
    // Reopening shows a cleared input.
    openDialog();
    expect(screen.getByLabelText(/Type/)).toHaveValue('');
  });
});
