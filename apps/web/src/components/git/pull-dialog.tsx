'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CommitPreviewList } from '@/components/git/commit-preview-list';
import { getPullPreview, startPull, type StartPullResult } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { PullPreviewDto } from '@asciidocollab/shared';

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

/** Said when the dry-run preview itself can't be loaded, for a reason with no more specific wording. */
const GENERIC_PULL_PREVIEW_FAILURE = "Couldn't load the pull preview.";

/**
 * Turns a refused preview fetch into the sentence shown above the confirm form, using the same
 * per-code wording as {@link describePullFailure} — the preview is gated the same way a real pull is.
 */
function describePullPreviewFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_PULL_PREVIEW_FAILURE;
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need editor access to see what would be pulled.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    default: {
      return GENERIC_PULL_PREVIEW_FAILURE;
    }
  }
}

/**
 * Fetches and renders the dry-run pull preview shown above the confirm form: the incoming commits
 * and changed paths (via {@link CommitPreviewList}), an "already up to date" empty state, and an
 * additional caution banner when the preview reports `affectsOpenFiles`. Purely additive context —
 * it never blocks or changes the confirm form's own action below it.
 */
function PullPreviewSection({ projectId, open }: { projectId: string; open: boolean }) {
  const [preview, setPreview] = useState<PullPreviewDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPreview(null);
    setError(null);
    setLoading(true);
    getPullPreview(projectId)
      .then((result) => {
        if (!active) return;
        setPreview(result);
      })
      .catch((caughtError: unknown) => {
        if (!active) return;
        setError(describePullPreviewFailure(caughtError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, projectId]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading pull preview…</p>;
  }

  if (error) {
    return (
      <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!preview) return null;

  return (
    <div className="space-y-3">
      {preview.incomingCommits.length === 0 ? (
        <p className="text-sm text-muted-foreground">Already up to date.</p>
      ) : (
        <CommitPreviewList
          projectId={projectId}
          enabled={open}
          commits={preview.incomingCommits}
          changedPaths={preview.changedPaths}
        />
      )}
      {preview.affectsOpenFiles && (
        <div className="flex items-start gap-2 rounded-md border border-[hsl(var(--warning-border))] bg-[hsl(var(--warning-bg))] p-2 text-sm text-[hsl(var(--warning))]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Pulling now may change files that are currently open for live editing.</span>
        </div>
      )}
    </div>
  );
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
      <Dialog.Title className="text-lg font-semibold">Pull from remote</Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-muted-foreground">
        Review the incoming commits — including whether they'd touch files currently open for live
        editing — before pulling.
      </Dialog.Description>

      <div className="mt-4 space-y-4">
        <PullPreviewSection projectId={projectId} open={open} />

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
 * Shows a dry-run preview of what pulling would bring in — incoming commits, changed paths, and a
 * caution when that would affect files open in live editing sessions — before confirming the pull.
 * Opened both from the status bar's normal pull entry and from the `409 open_files_need_confirm`
 * refusal path; either way "Pull anyway" retries with `confirmAffectsOpenFiles: true`. Escape and
 * outside clicks never dismiss it — same as the commit/import dialogs — so it is never lost to a
 * stray click; only Cancel or a confirmed pull closes it.
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
