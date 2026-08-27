'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { getGitOperation, importRepository, isGitOperationTerminal } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import { GIT_PROVIDERS } from '@asciidocollab/shared';
import type { GitOperationState, GitOperationStatusDto, GitProvider } from '@asciidocollab/shared';

/** How often the operation status is re-read while an import is queued or running. */
const POLL_INTERVAL_MS = 1500;

const REMOTE_URL_FIELD_ID = 'import-repository-remote-url';
const TOKEN_FIELD_ID = 'import-repository-token';
const BRANCH_FIELD_ID = 'import-repository-branch';

const PROVIDER_LABELS: Record<GitProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
};

/** Said when the server offered no usable explanation of its own for a refused start. */
const GENERIC_START_FAILURE = 'The import could not be started.';

/**
 * Turns a refusal to even QUEUE an import (the initial `POST` itself failed) into the sentence
 * shown on the form. Chosen by the machine-readable code/status rather than the prose, so a
 * reworded server message never silently changes which advice is shown.
 */
function describeStartFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_START_FAILURE;
  if (caught.code === 'RATE_LIMITED' || caught.status === 429) {
    return 'You have started too many imports recently. Try again later.';
  }
  if (caught.status === 401) {
    return 'Sign in again to start an import.';
  }
  return caught.message.trim().length > 0 ? caught.message : GENERIC_START_FAILURE;
}

/** Human wording for a queued import that finished in `FAILED`, keyed by its typed error code. */
const OPERATION_FAILURE_MESSAGES: Record<string, string> = {
  repository_unreachable: 'The repository could not be reached. Check the remote URL and try again.',
  authentication_failed: 'The token was rejected. Check it and try again.',
};

/** Said for a `FAILED` operation whose error code carries no specific wording of its own. */
const GENERIC_OPERATION_FAILURE = 'The import failed.';

function describeOperationFailure(errorCode: string | null): string {
  if (errorCode && errorCode in OPERATION_FAILURE_MESSAGES) {
    return OPERATION_FAILURE_MESSAGES[errorCode];
  }
  return GENERIC_OPERATION_FAILURE;
}

/** Wording shown beside the progress bar for each non-terminal operation state. */
const STATE_LABELS: Partial<Record<GitOperationState, string>> = {
  QUEUED: 'Queued…',
  RUNNING: 'Cloning repository…',
  AWAITING_CONFLICT: 'Resolving…',
};

/** Where the flow stands: filling in the form, waiting on the queued operation, or done. */
type Phase =
  | { kind: 'form' }
  | { kind: 'polling'; projectId: string; operationId: string; status: GitOperationStatusDto }
  | { kind: 'succeeded'; projectId: string }
  | { kind: 'failed'; message: string }
  | { kind: 'aborted' };

interface ImportRepositoryFormProperties {
  /**
   * Asks the surrounding dialog to close.
   *
   * @param open - The visibility being requested; the form only ever asks for `false`.
   */
  onOpenChange: (open: boolean) => void;
}

/**
 * The dialog's interactive body. Lives in its own component so that Radix unmounting the portal on
 * close (and the surrounding `Dialog.Root` remounting it on next open) always starts a fresh
 * attempt: no leftover field values, in-flight request, or poll timer from a previous run.
 */
function ImportRepositoryForm({ onOpenChange }: ImportRepositoryFormProperties) {
  const router = useRouter();
  const [provider, setProvider] = useState<GitProvider>('github');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [token, setToken] = useState('');
  const [branch, setBranch] = useState('');
  const [pending, setPending] = useState(false);
  const [startFailure, setStartFailure] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });

  // Whether this form is still on screen, so a request that settles after the dialog was
  // dismissed never touches state (or navigates) on its way out.
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  const trimmedRemoteUrl = remoteUrl.trim();
  const canSubmit = trimmedRemoteUrl.length > 0 && token.length > 0 && !pending;

  const handleSubmit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setStartFailure(null);
    try {
      const trimmedBranch = branch.trim();
      const result = await importRepository({
        provider,
        remoteUrl: trimmedRemoteUrl,
        token,
        branch: trimmedBranch.length > 0 ? trimmedBranch : undefined,
      });
      if (!onScreen.current) return;
      // The token has done its job for this request; clear it immediately rather than leaving it
      // sitting in component state for however long the import takes to finish.
      setToken('');
      setPhase({
        kind: 'polling',
        projectId: result.projectId,
        operationId: result.operationId,
        status: { id: result.operationId, kind: 'IMPORT', state: 'QUEUED', progress: 0, errorCode: null, driftSummary: null },
      });
    } catch (caughtError) {
      if (!onScreen.current) return;
      setStartFailure(describeStartFailure(caughtError));
    } finally {
      if (onScreen.current) setPending(false);
    }
  };

  const pollingProjectId = phase.kind === 'polling' ? phase.projectId : null;
  const pollingOperationId = phase.kind === 'polling' ? phase.operationId : null;

  // Polls the queued operation until it reaches a terminal state, then moves the phase on — which
  // (by no longer being "polling") is what stops this same effect on the next render.
  useEffect(() => {
    if (!pollingProjectId || !pollingOperationId) return;
    // Rebound to fresh, definitely-non-null bindings: the two `useState`-derived constants above
    // are narrowed by the guard right here, but that narrowing doesn't survive into the nested
    // `tick` closure below (it may run long after this check, so TypeScript can't carry it in).
    const projectId: string = pollingProjectId;
    const operationId: string = pollingOperationId;
    let active = true;

    async function tick() {
      try {
        const status = await getGitOperation(projectId, operationId);
        if (!active || !onScreen.current) return;
        if (isGitOperationTerminal(status.state)) {
          if (status.state === 'SUCCEEDED') {
            setPhase({ kind: 'succeeded', projectId });
          } else if (status.state === 'FAILED') {
            setPhase({ kind: 'failed', message: describeOperationFailure(status.errorCode) });
          } else {
            setPhase({ kind: 'aborted' });
          }
          return;
        }
        setPhase({ kind: 'polling', projectId, operationId, status });
      } catch {
        // A transient poll failure doesn't end the import — the next tick tries again.
      }
    }

    void tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pollingProjectId, pollingOperationId]);

  // Once the import succeeds, leave: there's no reason to linger on this dialog for a project the
  // user is about to be looking at directly.
  useEffect(() => {
    if (phase.kind !== 'succeeded') return;
    if (!onScreen.current) return;
    onOpenChange(false);
    router.push(`/dashboard/projects/${phase.projectId}`);
    // phase.projectId only changes when phase itself changes kind, so this is safe to key on phase.
  }, [phase, onOpenChange, router]);

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
        <GitBranch className="h-5 w-5 text-primary" aria-hidden="true" />
        Import a repository
      </Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-muted-foreground">
        Clones a remote repository into a new project you own.
      </Dialog.Description>

      {phase.kind === 'form' && (
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {startFailure && (
            <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
              {startFailure}
            </div>
          )}

          <div className="space-y-2">
            <span className="text-sm font-medium">Provider</span>
            <div role="radiogroup" aria-label="Git hosting provider" className="flex gap-1 rounded-md border border-input bg-secondary/40 p-1">
              {GIT_PROVIDERS.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={provider === candidate}
                  disabled={pending}
                  onClick={() => setProvider(candidate)}
                  className={`flex-1 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                    provider === candidate
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {PROVIDER_LABELS[candidate]}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor={REMOTE_URL_FIELD_ID}>Remote URL</Label>
            <Input
              id={REMOTE_URL_FIELD_ID}
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
              placeholder="https://github.com/org/repo.git"
              autoComplete="off"
              disabled={pending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={TOKEN_FIELD_ID}>Access token</Label>
            <Input
              id={TOKEN_FIELD_ID}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Personal access token"
              autoComplete="off"
              disabled={pending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={BRANCH_FIELD_ID}>Branch (optional)</Label>
            <Input
              id={BRANCH_FIELD_ID}
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="Defaults to the remote's default branch"
              autoComplete="off"
              disabled={pending}
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {pending ? 'Close' : 'Cancel'}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {pending ? 'Starting…' : 'Start import'}
            </Button>
          </div>
        </form>
      )}

      {phase.kind === 'polling' && (
        <div className="mt-4 space-y-3">
          <div role="status" className="space-y-2">
            <Progress value={phase.status.progress} aria-label="Import progress" />
            <p className="text-sm text-muted-foreground">
              {STATE_LABELS[phase.status.state] ?? 'Working…'} {phase.status.progress}%
            </p>
          </div>
          <p className="text-xs text-muted-foreground">The import will finish on its own. Closing this leaves it running.</p>
          <div className="flex justify-end pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>
      )}

      {phase.kind === 'succeeded' && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">Import succeeded — opening your project…</p>
        </div>
      )}

      {phase.kind === 'failed' && (
        <div className="mt-4 space-y-3">
          <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {phase.message}
          </div>
          <div className="flex justify-end pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>
      )}

      {phase.kind === 'aborted' && (
        <div className="mt-4 space-y-3">
          <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            The import was aborted.
          </div>
          <div className="flex justify-end pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/** Props for {@link ImportRepositoryDialog}. */
export interface ImportRepositoryDialogProperties {
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
 * Starts a git import into a brand-new project and polls it to completion, routing to the new
 * project once it succeeds. Escape and outside clicks never dismiss it — a long-running import
 * already in flight can't be called back, only the explicit Cancel/Close button leaves.
 */
export function ImportRepositoryDialog({ open, onOpenChange }: ImportRepositoryDialogProperties) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <ImportRepositoryForm onOpenChange={onOpenChange} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
