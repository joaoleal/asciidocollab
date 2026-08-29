'use client';

/**
 * The "Git Repository" settings section's connect/initialize dialog: connect an existing remote
 * (synchronous) or initialize a brand-new one (queued and polled to completion), depending on
 * `mode`. Split out of `RepositorySection` so this self-contained flow — its shared fields, the
 * OAuth branch, and the initialize poll — lives on its own.
 */
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { GitBranch, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  connectRepository,
  getGitOperation,
  getOAuthProviders,
  initializeRepository,
  isGitOperationTerminal,
  startGitOAuth,
  type RepositoryConnectionInput,
} from '@/lib/api/git';
import { navigateTo } from '@/lib/navigate';
import { GIT_PROVIDERS } from '@asciidocollab/shared';
import type { GitOperationState, GitOperationStatusDto, GitProvider } from '@asciidocollab/shared';
import { ProviderIcon } from './provider-icon';
import {
  describeConnectFailure,
  describeInitializeStartFailure,
  describeOAuthStartFailure,
  describeOperationFailure,
} from './repository-error-messages';

/** How often a queued initialize's status is re-read while it runs. */
const POLL_INTERVAL_MS = 1500;

const PROVIDER_LABELS: Record<GitProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
};

/** Wording shown beside the progress bar for each non-terminal operation state. */
const STATE_LABELS: Partial<Record<GitOperationState, string>> = {
  QUEUED: 'Queued…',
  RUNNING: 'Publishing…',
  AWAITING_CONFLICT: 'Resolving…',
};

const REMOTE_URL_FIELD_ID_BASE = 'repository-remote-url';
const TOKEN_FIELD_ID_BASE = 'repository-token';
const BRANCH_FIELD_ID_BASE = 'repository-branch';

/** The shared connect/initialize form's editable state, lifted so the dialog can read and submit it. */
interface ConnectionFormState {
  provider: GitProvider;
  setProvider: (provider: GitProvider) => void;
  remoteUrl: string;
  setRemoteUrl: (value: string) => void;
  token: string;
  setToken: (value: string) => void;
  branch: string;
  setBranch: (value: string) => void;
}

function useConnectionFormState(): ConnectionFormState {
  const [provider, setProvider] = useState<GitProvider>('github');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [token, setToken] = useState('');
  const [branch, setBranch] = useState('');
  return { provider, setProvider, remoteUrl, setRemoteUrl, token, setToken, branch, setBranch };
}

interface RepositoryConnectionFieldsProperties {
  mode: 'connect' | 'initialize';
  form: ConnectionFormState;
  pending: boolean;
}

/**
 * The provider/remote URL/token/branch fields shared by the connect and initialize dialogs — the two
 * differ only in which submit action runs and whether that action completes synchronously, not in
 * what they ask for.
 */
function RepositoryConnectionFields({ mode, form, pending }: RepositoryConnectionFieldsProperties) {
  const remoteUrlFieldId = `${mode}-${REMOTE_URL_FIELD_ID_BASE}`;
  const tokenFieldId = `${mode}-${TOKEN_FIELD_ID_BASE}`;
  const branchFieldId = `${mode}-${BRANCH_FIELD_ID_BASE}`;

  return (
    <>
      <div className="space-y-2">
        <span className="text-sm font-medium">Provider</span>
        <div
          role="radiogroup"
          aria-label="Git hosting provider"
          className="flex gap-1 rounded-md border border-input bg-secondary/40 p-1"
        >
          {GIT_PROVIDERS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={form.provider === candidate}
              disabled={pending}
              onClick={() => form.setProvider(candidate)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                form.provider === candidate
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <ProviderIcon provider={candidate} />
              {PROVIDER_LABELS[candidate]}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={remoteUrlFieldId}>Remote URL</Label>
        <Input
          id={remoteUrlFieldId}
          value={form.remoteUrl}
          onChange={(event) => form.setRemoteUrl(event.target.value)}
          placeholder="https://github.com/org/repo.git"
          autoComplete="off"
          disabled={pending}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={tokenFieldId}>Access token</Label>
        <Input
          id={tokenFieldId}
          type="password"
          value={form.token}
          onChange={(event) => form.setToken(event.target.value)}
          placeholder="Personal access token"
          autoComplete="off"
          disabled={pending}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={branchFieldId}>Branch (optional)</Label>
        <Input
          id={branchFieldId}
          value={form.branch}
          onChange={(event) => form.setBranch(event.target.value)}
          placeholder={mode === 'connect' ? "Defaults to the remote's default branch" : 'Defaults to "main"'}
          autoComplete="off"
          disabled={pending}
        />
      </div>
    </>
  );
}

/** Where the connect/initialize flow stands. */
type Phase =
  | { kind: 'form' }
  | { kind: 'polling'; operationId: string; status: GitOperationStatusDto }
  | { kind: 'succeeded' }
  | { kind: 'failed'; message: string }
  | { kind: 'aborted' };

interface ConnectOrInitializeFormProperties {
  projectId: string;
  mode: 'connect' | 'initialize';
  onOpenChange: (open: boolean) => void;
  onSucceeded: () => void;
}

/**
 * The connect/initialize dialog's interactive body. Lives in its own component so a fresh mount
 * (Radix unmounts the portal on close) always starts clean: no leftover field values, in-flight
 * request, or poll timer from a previous attempt.
 */
function ConnectOrInitializeForm({ projectId, mode, onOpenChange, onSucceeded }: ConnectOrInitializeFormProperties) {
  const form = useConnectionFormState();
  const [pending, setPending] = useState(false);
  const [startFailure, setStartFailure] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  // Providers with the guided OAuth connect flow available; null while still loading (the button
  // stays hidden either way, so a slow/failed lookup never shows a button that would 404).
  const [oauthProviders, setOauthProviders] = useState<GitProvider[] | null>(null);

  // Whether this form is still on screen, so a request that settles after the dialog was dismissed
  // never touches state on its way out.
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  // Only the connect dialog offers guided OAuth (initialize has no existing remote to authorize
  // against yet). Fetched once per mount — a fresh mount is guaranteed on every dialog open, since
  // Radix unmounts the portal on close.
  useEffect(() => {
    if (mode !== 'connect') return;
    let active = true;
    getOAuthProviders()
      .then((result) => {
        if (active) setOauthProviders(result.providers);
      })
      .catch(() => {
        if (active) setOauthProviders([]);
      });
    return () => {
      active = false;
    };
  }, [mode]);

  const trimmedRemoteUrl = form.remoteUrl.trim();
  const canSubmit = trimmedRemoteUrl.length > 0 && form.token.length > 0 && !pending;
  const canStartOAuth = mode === 'connect' && trimmedRemoteUrl.length > 0 && !pending;
  const oauthAvailableForProvider = mode === 'connect' && (oauthProviders?.includes(form.provider) ?? false);

  const handleSubmit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setStartFailure(null);
    const trimmedBranch = form.branch.trim();
    const input: RepositoryConnectionInput = {
      provider: form.provider,
      remoteUrl: trimmedRemoteUrl,
      token: form.token,
      branch: trimmedBranch.length > 0 ? trimmedBranch : undefined,
    };
    try {
      if (mode === 'connect') {
        await connectRepository(projectId, input);
        if (!onScreen.current) return;
        // The token has done its job for this request; clear it immediately rather than leaving it
        // sitting in component state.
        form.setToken('');
        setPhase({ kind: 'succeeded' });
      } else {
        const result = await initializeRepository(projectId, input);
        if (!onScreen.current) return;
        form.setToken('');
        setPhase({
          kind: 'polling',
          operationId: result.operationId,
          status: { id: result.operationId, kind: 'INITIALIZE', state: 'QUEUED', progress: 0, errorCode: null, driftSummary: null },
        });
      }
    } catch (caughtError) {
      if (!onScreen.current) return;
      setStartFailure(mode === 'connect' ? describeConnectFailure(caughtError) : describeInitializeStartFailure(caughtError));
    } finally {
      if (onScreen.current) setPending(false);
    }
  };

  /**
   * Starts the guided OAuth connect flow for the form's currently selected provider: posts the
   * start endpoint with the entered remote URL/branch, then does a full-page redirect to the
   * returned authorize URL. Manual PAT entry (`handleSubmit` above) is entirely unaffected — this
   * is a second, independent way to submit the same dialog.
   */
  const handleOAuthConnect = async () => {
    if (!canStartOAuth) return;
    setPending(true);
    setStartFailure(null);
    const trimmedBranch = form.branch.trim();
    try {
      const result = await startGitOAuth(projectId, form.provider, {
        remoteUrl: trimmedRemoteUrl,
        branch: trimmedBranch.length > 0 ? trimmedBranch : undefined,
      });
      if (!onScreen.current) return;
      navigateTo(result.authorizeUrl);
    } catch (caughtError) {
      if (!onScreen.current) return;
      setStartFailure(describeOAuthStartFailure(caughtError));
      setPending(false);
    }
  };

  const pollingOperationId = phase.kind === 'polling' ? phase.operationId : null;

  // Polls the queued initialize until it reaches a terminal state, then moves the phase on — which
  // (by no longer being "polling") is what stops this same effect on the next render.
  useEffect(() => {
    if (!pollingOperationId) return;
    const operationId: string = pollingOperationId;
    let active = true;

    async function tick() {
      try {
        const status = await getGitOperation(projectId, operationId);
        if (!active || !onScreen.current) return;
        if (isGitOperationTerminal(status.state)) {
          if (status.state === 'SUCCEEDED') {
            setPhase({ kind: 'succeeded' });
          } else if (status.state === 'FAILED') {
            setPhase({ kind: 'failed', message: describeOperationFailure(status.errorCode) });
          } else {
            setPhase({ kind: 'aborted' });
          }
          return;
        }
        setPhase({ kind: 'polling', operationId, status });
      } catch {
        // A transient poll failure doesn't end the initialize — the next tick tries again.
      }
    }

    void tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, pollingOperationId]);

  // Once connect resolves (sync) or the queued initialize reaches SUCCEEDED, tell the caller so it
  // reloads the git status, then close — there's nothing left for this dialog to show.
  useEffect(() => {
    if (phase.kind !== 'succeeded') return;
    if (!onScreen.current) return;
    onSucceeded();
    onOpenChange(false);
  }, [phase, onSucceeded, onOpenChange]);

  const title = mode === 'connect' ? 'Connect a remote repository' : 'Initialize a new repository';
  const description =
    mode === 'connect'
      ? 'Attaches this project to an existing remote repository, publishing its current files there.'
      : 'Publishes this project as the initial commit of a brand-new, currently empty remote repository.';

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
        {mode === 'connect' ? <Link2 className="h-5 w-5 text-primary" aria-hidden="true" /> : <GitBranch className="h-5 w-5 text-primary" aria-hidden="true" />}
        {title}
      </Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-muted-foreground">{description}</Dialog.Description>

      {phase.kind === 'form' && (
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {startFailure && (
            <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
              {startFailure}
            </div>
          )}

          <RepositoryConnectionFields mode={mode} form={form} pending={pending} />

          {oauthAvailableForProvider && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={!canStartOAuth}
              onClick={() => void handleOAuthConnect()}
            >
              {pending ? 'Connecting…' : `Connect with ${PROVIDER_LABELS[form.provider]}`}
            </Button>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {pending ? 'Close' : 'Cancel'}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {pending
                ? (mode === 'connect'
                  ? 'Connecting…'
                  : 'Starting…')
                : (mode === 'connect'
                  ? 'Connect'
                  : 'Initialize & publish')}
            </Button>
          </div>
        </form>
      )}

      {phase.kind === 'polling' && (
        <div className="mt-4 space-y-3">
          <div role="status" className="space-y-2">
            <Progress value={phase.status.progress} aria-label="Initialize progress" />
            <p className="text-sm text-muted-foreground">
              {STATE_LABELS[phase.status.state] ?? 'Working…'} {phase.status.progress}%
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            The initialize will finish on its own. Closing this leaves it running.
          </p>
          <div className="flex justify-end pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </div>
      )}

      {phase.kind === 'succeeded' && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            {mode === 'connect' ? 'Repository connected.' : 'Repository initialized and published.'}
          </p>
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
            The initialize was aborted.
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

interface ConnectOrInitializeDialogProperties {
  projectId: string;
  mode: 'connect' | 'initialize';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSucceeded: () => void;
}

/**
 * Connects an existing remote (synchronous) or initializes a brand-new one (queued and polled to
 * completion), depending on `mode`. Escape and outside clicks never dismiss it — same as the import
 * dialog — so an in-flight request or poll is never orphaned; only the explicit Cancel/Close button
 * (or a successful completion) closes it.
 */
export function ConnectOrInitializeDialog({ projectId, mode, open, onOpenChange, onSucceeded }: ConnectOrInitializeDialogProperties) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <ConnectOrInitializeForm projectId={projectId} mode={mode} onOpenChange={onOpenChange} onSucceeded={onSucceeded} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
