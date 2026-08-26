'use client';

/**
 * Read-only dry-run preview of what pushing the current branch would send to the remote: the
 * outgoing commits and the paths they touch. Shaped like `HistoryPanel` — Escape and outside clicks
 * never dismiss it, so browsing the preview is never interrupted by a stray click; only the explicit
 * Close button does. There is no push action here — see {@link PushPreviewDialog}'s doc comment.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { GitPullRequestArrow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CommitPreviewList } from '@/components/git/commit-preview-list';
import { getPushPreview } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { PushPreviewDto } from '@asciidocollab/shared';

/** Said when the preview fetch fails for a reason with no more specific wording of its own. */
const GENERIC_PUSH_PREVIEW_FAILURE = "Couldn't load the push preview.";

/**
 * Turns a refused preview fetch into the sentence shown in the dialog, keyed by the backend's typed
 * error code rather than its prose.
 */
export function describePushPreviewFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_PUSH_PREVIEW_FAILURE;
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need editor access to see what would be pushed.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    default: {
      return GENERIC_PUSH_PREVIEW_FAILURE;
    }
  }
}

/** Props for {@link PushPreviewDialog}. */
export interface PushPreviewDialogProperties {
  /** The project a push would apply to. */
  projectId: string;
  /** Whether the dialog is currently shown. */
  open: boolean;
  /**
   * Called whenever the dialog asks to open or close.
   *
   * @param open - The visibility being requested.
   */
  onOpenChange: (open: boolean) => void;
}

/**
 * Shows what pushing the current branch would send to the remote, without applying anything: the
 * outgoing commits and changed paths. Deliberately read-only — this dialog has no action to actually
 * push; wiring a real push/commit flow from here is a follow-up, not something this component does.
 */
export function PushPreviewDialog({ projectId, open, onOpenChange }: PushPreviewDialogProperties) {
  const [preview, setPreview] = useState<PushPreviewDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPreview(null);
    setError(null);
    setLoading(true);
    getPushPreview(projectId)
      .then((result) => {
        if (!active) return;
        setPreview(result);
      })
      .catch((caughtError: unknown) => {
        if (!active) return;
        setError(describePushPreviewFailure(caughtError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, projectId]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
            <GitPullRequestArrow className="h-5 w-5 text-primary" aria-hidden="true" />
            Push preview
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            The commits and changed paths that would go to the remote if you pushed now.
          </Dialog.Description>

          <div className="mt-4 space-y-4">
            {loading && <p className="text-sm text-muted-foreground">Loading push preview…</p>}

            {!loading && error && (
              <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </div>
            )}

            {!loading && !error && preview && preview.outgoingCommits.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing to push.</p>
            )}

            {!loading && !error && preview && preview.outgoingCommits.length > 0 && (
              <CommitPreviewList
                projectId={projectId}
                enabled={open}
                commits={preview.outgoingCommits}
                changedPaths={preview.changedPaths}
              />
            )}

            <div className="flex justify-end pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
