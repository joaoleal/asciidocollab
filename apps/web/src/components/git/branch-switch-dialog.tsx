'use client';

/**
 * Confirms a branch switch refused with one of the two synchronous `checkoutBranch` refusals:
 * `409 uncommitted_changes` (retry with `stashLocal: true`) or `409 open_files_need_confirm`
 * (retry with `confirmAffectsOpenFiles: true`). Shaped exactly like `PullDialog` — same
 * Escape/outside-click-proof Content, same "form as its own child component" split so an error
 * never survives a close/reopen, same `onScreen` unmount guard — with the added wrinkle that which
 * warning (and which flag) applies depends on which of the two codes fired.
 */
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { checkoutBranch, type BranchSwitchConfirmCode, type CheckoutBranchResult } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';

/** Said when a retried branch switch is refused for a reason with no more specific wording of its own. */
const GENERIC_CHECKOUT_FAILURE = "Couldn't switch branches.";

/**
 * Turns a refused branch switch into the sentence shown on the confirm dialog (or, for
 * `uncommitted_changes`, the rare case where a retry that already carries `stashLocal: true` is
 * refused again), keyed by the backend's typed error code rather than its prose.
 */
export function describeCheckoutFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_CHECKOUT_FAILURE;
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need editor access to switch branches.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    case 'uncommitted_changes': {
      return 'There are still uncommitted local changes blocking the switch.';
    }
    default: {
      return GENERIC_CHECKOUT_FAILURE;
    }
  }
}

/** Per-code copy for the confirm dialog, keyed on which of the two refusals opened it. */
const CONFIRM_COPY: Readonly<Record<BranchSwitchConfirmCode, { title: string; description: string; confirmLabel: string }>> = {
  uncommitted_changes: {
    title: 'Uncommitted local changes',
    description:
      'You have uncommitted local changes. Switching branches now will carry them across (stash and reapply). Continue?',
    confirmLabel: 'Switch anyway',
  },
  open_files_need_confirm: {
    title: 'Files are open in live editing sessions',
    description: 'Switching branches now may change files that are currently open for live editing. Continue anyway?',
    confirmLabel: 'Switch anyway',
  },
};

interface BranchSwitchConfirmFormProperties {
  projectId: string;
  branchName: string;
  code: BranchSwitchConfirmCode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: (result: CheckoutBranchResult) => void;
}

/**
 * The dialog's interactive body: retries the switch with the flag matching whichever refusal
 * fired. Lives in its own component, same as the pull/commit forms, so a failure message never
 * survives a close/reopen.
 */
function BranchSwitchConfirmForm({
  projectId,
  branchName,
  code,
  open,
  onOpenChange,
  onConfirmed,
}: BranchSwitchConfirmFormProperties) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether this form is still on screen, so a request that settles after the dialog was
  // dismissed never touches state on its way out.
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  // A fresh open starts clean: an error from a previous attempt never lingers into this one.
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const copy = CONFIRM_COPY[code];

  const handleConfirm = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await checkoutBranch(projectId, {
        name: branchName,
        ...(code === 'uncommitted_changes' ? { stashLocal: true } : { confirmAffectsOpenFiles: true }),
      });
      if (!onScreen.current) return;
      onConfirmed(result);
      onOpenChange(false);
    } catch (caughtError) {
      if (!onScreen.current) return;
      setError(describeCheckoutFailure(caughtError));
    } finally {
      if (onScreen.current) setPending(false);
    }
  };

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
        <AlertTriangle className="h-5 w-5 text-[hsl(var(--warning))]" aria-hidden="true" />
        {copy.title}
      </Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-muted-foreground">{copy.description}</Dialog.Description>

      <div className="mt-4 space-y-4">
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleConfirm()} disabled={pending}>
            {pending ? 'Switching…' : copy.confirmLabel}
          </Button>
        </div>
      </div>
    </>
  );
}

/** Props for {@link BranchSwitchDialog}. */
export interface BranchSwitchDialogProperties {
  /** The project a branch switch would apply to. */
  projectId: string;
  /** Whether the dialog is currently shown. */
  open: boolean;
  /** The branch being switched to. Required whenever `open` is true. */
  branchName: string | null;
  /** Which refusal opened the dialog. Required whenever `open` is true. */
  code: BranchSwitchConfirmCode | null;
  /**
   * Called whenever the dialog asks to open or close.
   *
   * @param open - The visibility being requested.
   */
  onOpenChange: (open: boolean) => void;
  /**
   * Called once the retry successfully queues a confirmed branch switch, with the operation to poll.
   *
   * @param result - The queued branch-switch operation.
   */
  onConfirmed: (result: CheckoutBranchResult) => void;
}

/**
 * Warns before retrying a branch switch refused with `409 uncommitted_changes` or
 * `409 open_files_need_confirm`. Escape and outside clicks never dismiss it — same as the pull/commit
 * dialogs — so the warning is never lost to a stray click; only Cancel or a confirmed switch closes it.
 */
export function BranchSwitchDialog({
  projectId,
  open,
  branchName,
  code,
  onOpenChange,
  onConfirmed,
}: BranchSwitchDialogProperties) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          {branchName && code && (
            <BranchSwitchConfirmForm
              projectId={projectId}
              branchName={branchName}
              code={code}
              open={open}
              onOpenChange={onOpenChange}
              onConfirmed={onConfirmed}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
