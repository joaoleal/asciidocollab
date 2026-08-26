'use client';

/**
 * Destructive confirm dialog for discarding uncommitted changes or restoring a single file from
 * an earlier commit, both backed by `POST …/git/discard`. One component, two modes: discard
 * (default — given `paths`) discards uncommitted changes to those paths back to HEAD; restore
 * (`mode: 'restore'` — given `path` + `commit`) replaces one file's content with its content from
 * that commit. Both are irreversible, so this follows the destructive-dialog pattern used by
 * `RepositorySection`'s disconnect confirmation exactly.
 */
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { discardChanges } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';

/** Said when a refused discard/restore has no more specific wording of its own, keyed by mode. */
const GENERIC_FAILURE: Record<'discard' | 'restore', string> = {
  discard: "Couldn't discard the changes.",
  restore: "Couldn't restore the file.",
};

/**
 * Turns a refused discard/restore into the sentence shown on the confirm dialog, keyed by the
 * backend's typed error code rather than its prose — a reworded server message never silently
 * changes which advice is shown.
 */
export function describeDiscardFailure(caught: unknown, mode: 'discard' | 'restore'): string {
  if (!(caught instanceof ApiError)) return GENERIC_FAILURE[mode];
  switch (caught.code) {
    case 'insufficient_role': {
      return mode === 'restore'
        ? 'You need editor access to restore this file.'
        : 'You need editor access to discard changes.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    case 'git_operation_in_progress': {
      return 'A git operation is already in progress. Try again shortly.';
    }
    default: {
      return GENERIC_FAILURE[mode];
    }
  }
}

/** Properties shared by both modes. */
interface DiscardDialogCommonProperties {
  /** The project the discard/restore action applies to. */
  projectId: string;
  /** Whether the dialog is currently shown. */
  open: boolean;
  /**
   * Called whenever the dialog asks to open or close.
   *
   * @param open - The visibility being requested.
   */
  onOpenChange: (open: boolean) => void;
  /** Called after a successful discard/restore, so the caller can refetch status/history. */
  onDone?: () => void;
}

/** Discard mode: discards uncommitted changes to the given paths back to HEAD. */
export interface DiscardModeProperties extends DiscardDialogCommonProperties {
  /** Discriminates this as discard mode. Omitted defaults to discard. */
  mode?: 'discard';
  /** The paths whose uncommitted changes are discarded. */
  paths: string[];
}

/** Restore mode: restores one file's content from a given commit. */
export interface RestoreModeProperties extends DiscardDialogCommonProperties {
  /** Discriminates this as restore mode. */
  mode: 'restore';
  /** The file to restore. */
  path: string;
  /** The commit to restore `path`'s content from. */
  commit: string;
}

/** Props for {@link DiscardDialog} — discard mode (default, `paths`) or restore mode (`mode: 'restore'`, `path` + `commit`). */
export type DiscardDialogProperties = DiscardModeProperties | RestoreModeProperties;

/**
 * The dialog's interactive body: confirms, then calls `discardChanges` with the body shape for
 * whichever mode is active. Lives in its own component so Radix's unmount-on-close resets any
 * error from a previous attempt rather than letting it survive a close/reopen.
 */
function DiscardForm(properties: DiscardDialogProperties) {
  const { projectId, open, onOpenChange, onDone } = properties;
  const mode: 'discard' | 'restore' = properties.mode === 'restore' ? 'restore' : 'discard';
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

  const handleConfirm = async () => {
    setPending(true);
    setError(null);
    try {
      await (properties.mode === 'restore'
        ? discardChanges(projectId, { path: properties.path, commit: properties.commit })
        : discardChanges(projectId, { paths: properties.paths }));
      if (!onScreen.current) return;
      onDone?.();
      onOpenChange(false);
    } catch (caughtError) {
      if (!onScreen.current) return;
      setError(describeDiscardFailure(caughtError, mode));
    } finally {
      if (onScreen.current) setPending(false);
    }
  };

  const fileCount = properties.mode === 'restore' ? 1 : properties.paths.length;
  const title =
    mode === 'restore'
      ? 'Restore this file from an earlier commit?'
      : (fileCount === 1 ? 'Discard changes to this file?' : `Discard changes to ${fileCount} files?`);
  const description =
    properties.mode === 'restore'
      ? `Replaces "${properties.path}" with its content from commit ${properties.commit.slice(0, 7)}. Any uncommitted changes to it are permanently lost.`
      : 'Uncommitted changes to the selected file(s) are permanently discarded and cannot be recovered.';

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
        {mode === 'restore' ? (
          <RotateCcw className="h-5 w-5 text-destructive" aria-hidden="true" />
        ) : (
          <Trash2 className="h-5 w-5 text-destructive" aria-hidden="true" />
        )}
        {title}
      </Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-muted-foreground">{description}</Dialog.Description>

      <div className="mt-4 space-y-4">
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {properties.mode !== 'restore' && properties.paths.length > 0 && (
          <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-input p-2">
            {properties.paths.map((path) => (
              <li key={path} className="truncate font-mono text-sm">
                {path}
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={pending}>
            {pending
              ? (mode === 'restore' ? 'Restoring…' : 'Discarding…')
              : (mode === 'restore' ? 'Restore' : 'Discard')}
          </Button>
        </div>
      </div>
    </>
  );
}

/**
 * Confirms before discarding uncommitted changes to one or more paths, or restoring a single
 * file's content from an earlier commit. Escape and outside clicks never dismiss it, so a stray
 * click can't fire an irreversible action; only Cancel or the explicit destructive button closes
 * it.
 */
export function DiscardDialog(properties: DiscardDialogProperties) {
  const { open, onOpenChange } = properties;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <DiscardForm {...properties} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
