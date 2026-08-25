'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { GitCommitHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { commitChanges, getGitStatus } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { PendingChangeDto, PendingChangeType } from '@asciidocollab/shared';

const MESSAGE_FIELD_ID = 'commit-dialog-message';

/** Tokenized label for a pending change's kind, shown beside its path in the staged list. */
const CHANGE_TYPE_LABELS: Record<PendingChangeType, string> = {
  added: 'Added',
  modified: 'Modified',
  removed: 'Removed',
  renamed: 'Renamed',
  copied: 'Copied',
};

/** Said when a commit is refused for a reason with no more specific wording of its own. */
const GENERIC_COMMIT_FAILURE = "Couldn't create the commit.";

/**
 * Turns a refused commit into the sentence shown on the form, keyed by the backend's typed
 * `GitErrorDto`/git-worker error code rather than its prose — a reworded server message never
 * silently changes which advice is shown.
 */
function describeCommitFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_COMMIT_FAILURE;
  switch (caught.code) {
    case 'empty_commit_message': {
      return 'A commit message is required.';
    }
    case 'nothing_staged': {
      return 'There are no staged changes to commit.';
    }
    case 'git_operation_in_progress': {
      return 'A git operation is already in progress. Try again shortly.';
    }
    case 'live_content_flush_failed': {
      const path = typeof caught.details?.path === 'string' ? caught.details.path : null;
      return path
        ? `Couldn't read the latest content for "${path}" — try again.`
        : "Couldn't read the latest content for a file — try again.";
    }
    case 'insufficient_role': {
      return 'You need editor access to commit.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    default: {
      return GENERIC_COMMIT_FAILURE;
    }
  }
}

interface CommitFormProperties {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommitted?: () => void;
}

/**
 * The dialog's interactive body: fetches the staged changes on open, then submits a commit
 * message against them. Lives in its own component, same as the import form, so state (the typed
 * message, any error) never survives a close/reopen.
 */
function CommitForm({ projectId, open, onOpenChange, onCommitted }: CommitFormProperties) {
  const [staged, setStaged] = useState<PendingChangeDto[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [message, setMessage] = useState('');
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

  useEffect(() => {
    if (!open) return;
    setLoadingStatus(true);
    setError(null);
    getGitStatus(projectId)
      .then((status) => {
        if (!onScreen.current) return;
        setStaged(status.staged);
      })
      .catch(() => {
        if (!onScreen.current) return;
        setStaged([]);
        setError('Failed to load staged changes.');
      })
      .finally(() => {
        if (onScreen.current) setLoadingStatus(false);
      });
  }, [open, projectId]);

  const trimmedMessage = message.trim();
  const canSubmit = trimmedMessage.length > 0 && staged.length > 0 && !pending;

  const handleSubmit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      await commitChanges(projectId, trimmedMessage);
      if (!onScreen.current) return;
      onCommitted?.();
      onOpenChange(false);
    } catch (caughtError) {
      if (!onScreen.current) return;
      setError(describeCommitFailure(caughtError));
    } finally {
      if (onScreen.current) setPending(false);
    }
  };

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
        <GitCommitHorizontal className="h-5 w-5 text-primary" aria-hidden="true" />
        Commit changes
      </Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-muted-foreground">
        Enter a message to commit your staged changes.
      </Dialog.Description>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <span className="text-sm font-medium">Staged changes</span>
          {loadingStatus && <p className="text-sm text-muted-foreground">Loading staged changes…</p>}
          {!loadingStatus && staged.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing staged to commit.</p>
          )}
          {!loadingStatus && staged.length > 0 && (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-input p-2">
              {staged.map((change) => (
                <li key={change.path} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{change.path}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {CHANGE_TYPE_LABELS[change.changeType]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor={MESSAGE_FIELD_ID}>Commit message</Label>
          <textarea
            id={MESSAGE_FIELD_ID}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Describe your changes"
            rows={3}
            disabled={pending}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {pending ? 'Committing…' : 'Commit'}
          </Button>
        </div>
      </form>
    </>
  );
}

/** Props for {@link CommitDialog}. */
export interface CommitDialogProperties {
  /** The project whose staged changes are being committed. */
  projectId: string;
  /** Whether the dialog is currently shown. */
  open: boolean;
  /**
   * Called whenever the dialog asks to open or close.
   *
   * @param open - The visibility being requested.
   */
  onOpenChange: (open: boolean) => void;
  /** Called after a commit succeeds, so the caller can refresh git status/tree-status badges. */
  onCommitted?: () => void;
}

/**
 * Reviews the project's staged changes and commits them with a typed message. Escape and outside
 * clicks never dismiss it — same as the import dialog — so a message being typed is never lost to
 * a stray click; only the explicit Cancel button (or a successful commit) closes it.
 */
export function CommitDialog({ projectId, open, onOpenChange, onCommitted }: CommitDialogProperties) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <CommitForm projectId={projectId} open={open} onOpenChange={onOpenChange} onCommitted={onCommitted} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
