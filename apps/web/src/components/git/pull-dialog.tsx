'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { startPull, type StartPullResult } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';

/** Said when a retried pull is refused for a reason with no more specific wording of its own. */
const GENERIC_PULL_FAILURE = "Couldn't start the pull.";

/**
 * Turns a refused pull into the sentence shown on the confirm dialog, keyed by the backend's typed
 * error code rather than its prose — a reworded server message never silently changes which advice
 * is shown. Deliberately does NOT map any conflict/merge code: those surface later, via the polled
 * operation's state, not this synchronous start call.
 */
export function describePullFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_PULL_FAILURE;
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need editor access to pull.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    default: {
      return GENERIC_PULL_FAILURE;
    }
  }
}

interface PullConfirmFormProperties {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: (result: StartPullResult) => void;
}

/**
 * The dialog's interactive body: retries the pull with `confirmAffectsOpenFiles: true` once the
 * viewer accepts the warning. Lives in its own component, same as the commit/import forms, so a
 * failure message never survives a close/reopen.
 */
function PullConfirmForm({ projectId, open, onOpenChange, onConfirmed }: PullConfirmFormProperties) {
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

  // A fresh open starts clean: an error from a previous attempt (or a previous pull entirely)
  // never lingers into this one.
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const handleConfirm = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await startPull(projectId, { confirmAffectsOpenFiles: true });
      if (!onScreen.current) return;
      onConfirmed(result);
      onOpenChange(false);
    } catch (caughtError) {
      if (!onScreen.current) return;
      setError(describePullFailure(caughtError));
    } finally {
      if (onScreen.current) setPending(false);
    }
  };

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
        <AlertTriangle className="h-5 w-5 text-[hsl(var(--warning))]" aria-hidden="true" />
        Files are open in live editing sessions
      </Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-muted-foreground">
        Pulling now may change files that are currently open for live editing. Continue anyway?
      </Dialog.Description>

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
            {pending ? 'Pulling…' : 'Pull anyway'}
          </Button>
        </div>
      </div>
    </>
  );
}

/** Props for {@link PullDialog}. */
export interface PullDialogProperties {
  /** The project a pull would apply to. */
  projectId: string;
  /** Whether the dialog is currently shown. */
  open: boolean;
  /**
   * Called whenever the dialog asks to open or close.
   *
   * @param open - The visibility being requested.
   */
  onOpenChange: (open: boolean) => void;
  /**
   * Called once "Pull anyway" successfully queues a confirmed pull, with the operation to poll.
   *
   * @param result - The queued pull operation.
   */
  onConfirmed: (result: StartPullResult) => void;
}

/**
 * Warns that files are open in live editing sessions before retrying a pull refused with `409
 * open_files_need_confirm`. Escape and outside clicks never dismiss it — same as the commit/import
 * dialogs — so the warning is never lost to a stray click; only Cancel or a confirmed pull closes it.
 */
export function PullDialog({ projectId, open, onOpenChange, onConfirmed }: PullDialogProperties) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <PullConfirmForm projectId={projectId} open={open} onOpenChange={onOpenChange} onConfirmed={onConfirmed} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
