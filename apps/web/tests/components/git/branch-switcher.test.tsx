import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BranchSwitcher, describeBranchFailure } from '@/components/git/branch-switcher';
import { BranchSwitchDialog, describeCheckoutFailure } from '@/components/git/branch-switch-dialog';
import { ApiError } from '@/lib/api/transport';
import type { BranchDto } from '@asciidocollab/shared';

/** Placeholder for a deferred handle before its promise executor assigns the real one. */
const noop = () => undefined;

const mockCheckoutBranch = jest.fn();

jest.mock('@/lib/api/git', () => ({
  ...jest.requireActual('@/lib/api/git'),
  checkoutBranch: (...parameters: unknown[]) => mockCheckoutBranch(...parameters),
}));

// Render the dropdown inline so its items are queryable without opening the Radix menu — same
// pattern as `project-card.test.tsx`. The item forwards onSelect via a click, the way Radix would
// choose it.
jest.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    className,
  }: {
    children: React.ReactNode;
    onSelect?: (event: Event) => void;
    disabled?: boolean;
    className?: string;
  }) => (
    <div
      role="menuitem"
      aria-disabled={disabled}
      className={className}
      onClick={(event: React.MouseEvent) => {
        if (!disabled) onSelect?.(event.nativeEvent);
      }}
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

const BRANCHES: BranchDto[] = [
  { name: 'main', isCurrent: true },
  { name: 'dev', isCurrent: false },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckoutBranch.mockResolvedValue({ operationId: 'op1', projectId: 'proj1' });
});

/** A never-settling promise plus the handles that settle it, for driving in-flight request states. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void } {
  let resolve: () => void = noop;
  let reject: (reason: unknown) => void = noop;
  const promise = new Promise<void>((resolveIt, rejectIt) => {
    resolve = resolveIt;
    reject = rejectIt;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Lets the dialog's outside-pointer listener, registered a macrotask after mount, come online. */
async function settleListeners() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

function renderSwitcher(overrides: Partial<React.ComponentProps<typeof BranchSwitcher>> = {}) {
  const onSwitch = overrides.onSwitch ?? jest.fn();
  const onCreate = overrides.onCreate ?? jest.fn().mockResolvedValue(undefined);
  const view = render(
    <BranchSwitcher
      current={'current' in overrides ? overrides.current ?? null : 'main'}
      branches={overrides.branches ?? BRANCHES}
      loading={overrides.loading ?? false}
      switchPending={overrides.switchPending ?? false}
      onSwitch={onSwitch}
      onCreate={onCreate}
    />,
  );
  return { onSwitch, onCreate, unmount: view.unmount };
}

function openCreateDialog() {
  fireEvent.click(screen.getByText('New branch…'));
}

describe('BranchSwitcher trigger', () => {
  test('shows the current branch name', () => {
    renderSwitcher({ current: 'main' });
    expect(screen.getByRole('button', { name: /switch branch/i })).toHaveTextContent('main');
  });

  test('shows a neutral label while loading and no branch is known yet', () => {
    renderSwitcher({ current: null, branches: [], loading: true });
    expect(screen.getByRole('button', { name: /switch branch/i })).toHaveTextContent('Loading…');
  });

  test('shows a plain label once loading finished without resolving a branch', () => {
    renderSwitcher({ current: null, branches: [], loading: false });
    expect(screen.getByRole('button', { name: /switch branch/i })).toHaveTextContent('Branch');
    expect(screen.getByText('No branches found.')).toBeInTheDocument();
  });
});

describe('BranchSwitcher branch list', () => {
  test('lists every branch, indicating which one is current', () => {
    renderSwitcher();
    const items = screen.getAllByRole('menuitem');
    const mainItem = items.find((item) => item.textContent?.includes('main'));
    const developmentItem = items.find((item) => item.textContent?.includes('dev'));
    expect(mainItem).toBeDefined();
    expect(developmentItem).toBeDefined();
    // The current branch's item is disabled (nothing to switch to) and carries a check indicator;
    // the other branch's does not.
    expect(mainItem).toHaveAttribute('aria-disabled', 'true');
    expect(developmentItem).toHaveAttribute('aria-disabled', 'false');
  });

  test('an editor can trigger a switch by choosing a non-current branch', () => {
    const { onSwitch } = renderSwitcher();
    const developmentItem = screen.getAllByRole('menuitem').find((item) => item.textContent?.includes('dev'));
    fireEvent.click(developmentItem!);
    expect(onSwitch).toHaveBeenCalledWith('dev');
  });

  test('choosing the current branch does not trigger a switch', () => {
    const { onSwitch } = renderSwitcher();
    const mainItem = screen.getAllByRole('menuitem').find((item) => item.textContent?.includes('main'));
    fireEvent.click(mainItem!);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  test('disables every switch action while a switch is pending', () => {
    renderSwitcher({ switchPending: true });
    const developmentItem = screen.getAllByRole('menuitem').find((item) => item.textContent?.includes('dev'));
    expect(developmentItem).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: /switch branch/i })).toBeDisabled();
  });
});

describe('BranchSwitcher create branch', () => {
  test('an editor can open the create-branch dialog and submit a name', async () => {
    const { onCreate } = renderSwitcher();
    openCreateDialog();

    const nameField = screen.getByLabelText(/branch name/i);
    fireEvent.change(nameField, { target: { value: 'feature/x' } });
    fireEvent.click(screen.getByRole('button', { name: /^create branch$/i }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('feature/x'));
  });

  test('closes the create-branch dialog on success', async () => {
    renderSwitcher();
    openCreateDialog();
    fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: 'feature/x' } });
    fireEvent.click(screen.getByRole('button', { name: /^create branch$/i }));

    await waitFor(() => expect(screen.queryByLabelText(/branch name/i)).not.toBeInTheDocument());
  });

  test('disables Create until a name is entered', () => {
    renderSwitcher();
    openCreateDialog();
    expect(screen.getByRole('button', { name: /^create branch$/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: '  ' } });
    expect(screen.getByRole('button', { name: /^create branch$/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: /^create branch$/i })).toBeEnabled();
  });

  test('shows a mapped error and keeps the dialog open on failure', async () => {
    const onCreate = jest.fn().mockRejectedValue(new ApiError(403, 'insufficient_role', 'nope'));
    renderSwitcher({ onCreate });
    openCreateDialog();
    fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: 'feature/x' } });
    fireEvent.click(screen.getByRole('button', { name: /^create branch$/i }));

    expect(await screen.findByText('You need editor access to create a branch.')).toBeInTheDocument();
    expect(screen.getByLabelText(/branch name/i)).toBeInTheDocument();
  });

  test('closes on Cancel without creating', () => {
    const { onCreate } = renderSwitcher();
    openCreateDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/branch name/i)).not.toBeInTheDocument();
  });

  test('submitting the form with a blank name creates nothing', async () => {
    const { onCreate } = renderSwitcher();
    openCreateDialog();
    const form = screen.getByLabelText(/branch name/i).closest('form');
    expect(form).not.toBeNull();

    await act(async () => {
      if (form) fireEvent.submit(form);
    });

    expect(onCreate).not.toHaveBeenCalled();
  });

  test('stays open when Escape is pressed or a pointer goes down outside it', async () => {
    renderSwitcher();
    openCreateDialog();
    await settleListeners();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });

    expect(screen.getByLabelText(/branch name/i)).toBeInTheDocument();
  });

  test('a creation that resolves after the switcher is gone closes nothing', async () => {
    const pending = deferred();
    const onCreate = jest.fn().mockReturnValue(pending.promise);
    const { unmount } = renderSwitcher({ onCreate });
    openCreateDialog();
    fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: 'feature/x' } });
    fireEvent.click(screen.getByRole('button', { name: /^create branch$/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve();
    });

    expect(screen.queryByLabelText(/branch name/i)).not.toBeInTheDocument();
  });

  test('a creation refused after the switcher is gone shows no error', async () => {
    const pending = deferred();
    const onCreate = jest.fn().mockReturnValue(pending.promise);
    const { unmount } = renderSwitcher({ onCreate });
    openCreateDialog();
    fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: 'feature/x' } });
    fireEvent.click(screen.getByRole('button', { name: /^create branch$/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.reject(new ApiError(403, 'insufficient_role', 'nope'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('describeBranchFailure', () => {
  test.each([
    ['insufficient_role', 'You need editor access to create a branch.'],
    ['git_worker_unavailable', 'The git service is unavailable. Try again shortly.'],
    ['repository_not_connected', 'This project has no connected repository.'],
    ['validation_error', 'Enter a valid branch name.'],
    ['some_unmapped_code', "Couldn't create the branch."],
  ])('maps %s to %s', (code, expectedMessage) => {
    expect(describeBranchFailure(new ApiError(409, code, 'server said so'))).toBe(expectedMessage);
  });

  test('falls back to the generic message for a non-ApiError', () => {
    expect(describeBranchFailure(new Error('boom'))).toBe("Couldn't create the branch.");
  });
});

function renderConfirmDialog(
  overrides: Partial<{
    branchName: string;
    code: 'uncommitted_changes' | 'open_files_need_confirm';
    onOpenChange: (open: boolean) => void;
    onConfirmed: (result: unknown) => void;
  }> = {},
) {
  const onOpenChange = overrides.onOpenChange ?? jest.fn();
  const onConfirmed = overrides.onConfirmed ?? jest.fn();
  const view = render(
    <BranchSwitchDialog
      projectId="proj1"
      open
      branchName={overrides.branchName ?? 'dev'}
      code={overrides.code ?? 'open_files_need_confirm'}
      onOpenChange={onOpenChange}
      onConfirmed={onConfirmed}
    />,
  );
  return { onOpenChange, onConfirmed, unmount: view.unmount };
}

const confirmButton = () => screen.getByRole('button', { name: /^(Switch anyway|Switching…)$/ });

describe('BranchSwitchDialog accessibility', () => {
  test('renders a real Dialog.Description for the open-files warning', () => {
    renderConfirmDialog({ code: 'open_files_need_confirm' });
    const dialog = screen.getByRole('dialog');
    const describedById = dialog.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.querySelector(`#${describedById}`)).toHaveTextContent(/open for live editing/i);
  });

  test('renders a real Dialog.Description for the uncommitted-changes warning', () => {
    renderConfirmDialog({ code: 'uncommitted_changes' });
    const dialog = screen.getByRole('dialog');
    const describedById = dialog.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.querySelector(`#${describedById}`)).toHaveTextContent(/uncommitted local changes/i);
  });

  test('stays open on Escape', () => {
    const { onOpenChange } = renderConfirmDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('cannot be dismissed by an outside click', async () => {
    const { onOpenChange } = renderConfirmDialog();
    await settleListeners();
    fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('renders nothing until a branch and a refusal code are known', () => {
    render(
      <BranchSwitchDialog
        projectId="proj1"
        open={false}
        branchName={null}
        code={null}
        onOpenChange={jest.fn()}
        onConfirmed={jest.fn()}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('BranchSwitchDialog retries that settle after dismissal', () => {
  test('a retry that resolves after dismissal confirms nothing', async () => {
    const pending = deferred();
    mockCheckoutBranch.mockReturnValue(pending.promise);
    const { onConfirmed, unmount } = renderConfirmDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockCheckoutBranch).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.resolve();
    });

    expect(onConfirmed).not.toHaveBeenCalled();
  });

  test('a retry refused after dismissal shows no error', async () => {
    const pending = deferred();
    mockCheckoutBranch.mockReturnValue(pending.promise);
    const { unmount } = renderConfirmDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockCheckoutBranch).toHaveBeenCalled());

    unmount();
    await act(async () => {
      pending.reject(new ApiError(409, 'uncommitted_changes', 'still uncommitted'));
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('BranchSwitchDialog confirmation', () => {
  test('retries with stashLocal when uncommitted_changes fired', async () => {
    renderConfirmDialog({ branchName: 'dev', code: 'uncommitted_changes' });
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(mockCheckoutBranch).toHaveBeenCalledWith('proj1', { name: 'dev', stashLocal: true }),
    );
  });

  test('retries with confirmAffectsOpenFiles when open_files_need_confirm fired', async () => {
    renderConfirmDialog({ branchName: 'dev', code: 'open_files_need_confirm' });
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(mockCheckoutBranch).toHaveBeenCalledWith('proj1', { name: 'dev', confirmAffectsOpenFiles: true }),
    );
  });

  test('calls onConfirmed with the queued operation and closes on success', async () => {
    const { onOpenChange, onConfirmed } = renderConfirmDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith({ operationId: 'op1', projectId: 'proj1' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('shows a mapped error and keeps the dialog open on a further refusal', async () => {
    mockCheckoutBranch.mockRejectedValueOnce(new ApiError(409, 'uncommitted_changes', 'still uncommitted'));
    const { onOpenChange } = renderConfirmDialog({ code: 'open_files_need_confirm' });
    fireEvent.click(confirmButton());
    expect(await screen.findByText('There are still uncommitted local changes blocking the switch.')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test('closes on Cancel without switching', () => {
    const { onOpenChange } = renderConfirmDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockCheckoutBranch).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('describeCheckoutFailure', () => {
  test.each([
    ['insufficient_role', 'You need editor access to switch branches.'],
    ['git_worker_unavailable', 'The git service is unavailable. Try again shortly.'],
    ['repository_not_connected', 'This project has no connected repository.'],
    ['uncommitted_changes', 'There are still uncommitted local changes blocking the switch.'],
    ['some_unmapped_code', "Couldn't switch branches."],
  ])('maps %s to %s', (code, expectedMessage) => {
    expect(describeCheckoutFailure(new ApiError(409, code, 'server said so'))).toBe(expectedMessage);
  });

  test('falls back to the generic message for a non-ApiError', () => {
    expect(describeCheckoutFailure(new Error('boom'))).toBe("Couldn't switch branches.");
  });
});
