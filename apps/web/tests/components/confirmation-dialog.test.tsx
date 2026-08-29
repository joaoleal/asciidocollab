import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmationDialog } from '@/components/confirmation-dialog';

/** The shape of the dismissal events Radix hands to the outside-interaction guards. */
interface DismissEvent {
  preventDefault: () => void;
}

// Radix decides on its own whether an outside pointer-down counts as a dismissal, and under jsdom
// it never does — so the guard the dialog installs would go untested. Capturing the handler off
// Radix's Content (while still rendering the real one) lets the guard be exercised directly.
let capturedPointerDownOutside: ((event: DismissEvent) => void) | undefined;
jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
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

describe('ConfirmationDialog', () => {
  test('renders title and description when open', () => {
    render(
      <ConfirmationDialog
        open={true}
        onOpenChange={jest.fn()}
        title="Remove member"
        description="Are you sure you want to remove this member?"
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.getByText('Remove member')).toBeInTheDocument();
    expect(screen.getByText('Are you sure you want to remove this member?')).toBeInTheDocument();
  });

  test('calls onConfirm when confirm button is clicked', () => {
    const onConfirm = jest.fn();
    render(
      <ConfirmationDialog
        open={true}
        onOpenChange={jest.fn()}
        title="Delete"
        description="Permanent."
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('calls onOpenChange(false) when cancel is clicked', () => {
    const onOpenChange = jest.fn();
    render(
      <ConfirmationDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Delete"
        description="Permanent."
        onConfirm={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('does not render content when closed', () => {
    render(
      <ConfirmationDialog
        open={false}
        onOpenChange={jest.fn()}
        title="Hidden title"
        description="Hidden."
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.queryByText('Hidden title')).not.toBeInTheDocument();
  });

  test('renders custom confirm and cancel labels', () => {
    render(
      <ConfirmationDialog
        open={true}
        onOpenChange={jest.fn()}
        title="Archive"
        description="Archive it?"
        confirmLabel="Archive now"
        cancelLabel="Keep it"
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Archive now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeInTheDocument();
  });

  test('shows a loading label and disables both buttons while loading', () => {
    render(
      <ConfirmationDialog
        open={true}
        onOpenChange={jest.fn()}
        title="Delete"
        description="Permanent."
        confirmLabel="Delete"
        onConfirm={jest.fn()}
        loading={true}
      />,
    );
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  test('prevents closing on escape key and outside pointer-down', async () => {
    const onOpenChange = jest.fn();
    render(
      <ConfirmationDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Sticky"
        description="Stays open."
        onConfirm={jest.fn()}
      />,
    );
    // Radix attaches its outside-pointer listener on a 0ms timeout; let it register.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent(document.body, new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    // The guard handlers preventDefault, so onOpenChange is never asked to close.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('refuses an outside pointer-down as a way of dismissing the decision', () => {
    capturedPointerDownOutside = undefined as ((event: DismissEvent) => void) | undefined;
    render(
      <ConfirmationDialog
        open={true}
        onOpenChange={jest.fn()}
        title="Sticky"
        description="Stays open."
        onConfirm={jest.fn()}
      />,
    );
    const preventDefault = jest.fn();
    expect(capturedPointerDownOutside).toBeDefined();
    capturedPointerDownOutside?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test('awaits an async onConfirm handler', async () => {
    const onConfirm = jest.fn().mockResolvedValue(undefined);
    render(
      <ConfirmationDialog
        open={true}
        onOpenChange={jest.fn()}
        title="Delete"
        description="Permanent."
        variant="default"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
