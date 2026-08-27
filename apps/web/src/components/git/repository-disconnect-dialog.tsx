'use client';

/**
 * The "Git Repository" settings section's disconnect dialog: confirms before unlinking the
 * project's connected repository. Split out of `RepositorySection` so this destructive confirm
 * form and its dialog wrapper live on their own.
 */
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { disconnectRepository } from '@/lib/api/git';
import { describeDisconnectFailure } from './repository-error-messages';

interface DisconnectConfirmFormProperties {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnected: () => void;
}

/** The disconnect dialog's interactive body: confirms, then calls the disconnect endpoint. */
function DisconnectConfirmForm({ projectId, open, onOpenChange, onDisconnected }: DisconnectConfirmFormProperties) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const handleConfirm = async () => {
    setPending(true);
    setError(null);
    try {
      await disconnectRepository(projectId);
      if (!onScreen.current) return;
      onDisconnected();
      onOpenChange(false);
    } catch (caughtError) {
      if (!onScreen.current) return;
      setError(describeDisconnectFailure(caughtError));
    } finally {
      if (onScreen.current) setPending(false);
    }
  };

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
        <Unplug className="h-5 w-5 text-destructive" aria-hidden="true" />
        Disconnect this repository?
      </Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-muted-foreground">
        Deletes the stored access credential and unlinks the remote from this project. Your files stay
        exactly as they are; you can reconnect or initialize again afterward, but this project's git
        history and any un-pushed local state stop being tracked against the remote.
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
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={pending}>
            {pending ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </div>
      </div>
    </>
  );
}

interface DisconnectDialogProperties {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnected: () => void;
}

/**
 * Confirms before unlinking the project's connected repository. Escape and outside clicks never
 * dismiss it, so a stray click can't fire an irreversible action; only Cancel or the explicit
 * Disconnect button closes it.
 */
export function DisconnectDialog({ projectId, open, onOpenChange, onDisconnected }: DisconnectDialogProperties) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <DisconnectConfirmForm projectId={projectId} open={open} onOpenChange={onOpenChange} onDisconnected={onDisconnected} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
