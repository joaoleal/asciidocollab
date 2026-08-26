'use client';

/**
 * The project settings page's "Git Repository" section: connect an existing remote, initialize a
 * brand-new one, rotate the stored access credential, and disconnect — the four owner-gated actions
 * that drive `apps/api`'s `POST/PUT …/git/{connect,initialize,disconnect,credential}` routes.
 *
 * Connection state is derived ENTIRELY from {@link useGitStatus} — its `connected` boolean, itself
 * derived from a 404 on the status endpoint — since there is no fetchable "current repository"
 * endpoint to read provider/remoteUrl/tokenHint from after the fact. The connected view therefore
 * shows only a plain connected state plus whatever `useGitStatus` already carries (branch, sync
 * status); a credential rotation's `tokenHint` is shown only once, straight from that call's own
 * response.
 */
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { GitBranch, KeyRound, Link2, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { useGitStatus } from '@/hooks/use-git-status';
import {
  connectRepository,
  disconnectRepository,
  getGitOperation,
  getOAuthProviders,
  initializeRepository,
  isGitOperationTerminal,
  rotateGitCredential,
  startGitOAuth,
  type RepositoryConnectionInput,
} from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import { navigateTo } from '@/lib/navigate';
import { GIT_PROVIDERS } from '@asciidocollab/shared';
import type { GitOperationState, GitOperationStatusDto, GitProvider } from '@asciidocollab/shared';

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

/** Human wording for a queued initialize that finished `FAILED`, keyed by its typed error code. */
const OPERATION_FAILURE_MESSAGES: Record<string, string> = {
  repository_unreachable: 'The repository could not be reached. Check the remote URL and try again.',
  authentication_failed: 'The token was rejected. Check it and try again.',
};

/** Said for a `FAILED` initialize whose error code carries no specific wording of its own. */
const GENERIC_OPERATION_FAILURE = 'The initialize failed.';

/** Turns a terminal `FAILED` initialize's typed error code into the sentence shown on the dialog. */
function describeOperationFailure(errorCode: string | null): string {
  if (errorCode && errorCode in OPERATION_FAILURE_MESSAGES) {
    return OPERATION_FAILURE_MESSAGES[errorCode];
  }
  return GENERIC_OPERATION_FAILURE;
}

/**
 * Turns a refused `POST …/git/connect` into the sentence shown on the form, keyed by the backend's
 * typed error code rather than its prose — a reworded server message never silently changes which
 * advice is shown.
 */
export function describeConnectFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return "Couldn't connect the repository.";
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need owner access to connect a repository.';
    }
    case 'already_connected': {
      return 'This project already has a connected repository.';
    }
    case 'repository_unreachable': {
      return 'The repository could not be reached. Check the remote URL and try again.';
    }
    case 'authentication_failed': {
      return 'The token was rejected. Check it and try again.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    default: {
      return "Couldn't connect the repository.";
    }
  }
}

/** Turns a refused `POST …/git/oauth/<provider>/start` into the sentence shown on the connect form. */
export function describeOAuthStartFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return "Couldn't start the guided connection.";
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need owner access to connect a repository.';
    }
    case 'oauth_not_configured': {
      return 'Guided connect is not available for this provider.';
    }
    case 'validation_error': {
      return 'Enter a valid remote URL first.';
    }
    default: {
      return "Couldn't start the guided connection.";
    }
  }
}

/** Turns a refused `POST …/git/initialize` (the initial queue request itself) into a shown sentence. */
export function describeInitializeStartFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return "Couldn't start the initialize.";
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need owner access to initialize a repository.';
    }
    case 'already_connected': {
      return 'This project already has a connected repository.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    default: {
      return "Couldn't start the initialize.";
    }
  }
}

/** Turns a refused `POST …/git/disconnect` into the sentence shown on the confirm dialog. */
export function describeDisconnectFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return "Couldn't disconnect the repository.";
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need owner access to disconnect this repository.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    default: {
      return "Couldn't disconnect the repository.";
    }
  }
}

/** Turns a refused `PUT …/git/credential` into the sentence shown on the rotate form. */
export function describeRotateFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return "Couldn't rotate the credential.";
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need owner access to rotate this credential.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    default: {
      return "Couldn't rotate the credential.";
    }
  }
}

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
              className={`flex-1 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                form.provider === candidate
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
          status: { id: result.operationId, kind: 'INITIALIZE', state: 'QUEUED', progress: 0, errorCode: null },
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
                ? mode === 'connect'
                  ? 'Connecting…'
                  : 'Starting…'
                : mode === 'connect'
                  ? 'Connect'
                  : 'Initialize & publish'}
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
function ConnectOrInitializeDialog({ projectId, mode, open, onOpenChange, onSucceeded }: ConnectOrInitializeDialogProperties) {
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

const ROTATE_TOKEN_FIELD_ID = 'repository-rotate-token';

interface RotateCredentialFormProperties {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The rotate-credential dialog's interactive body: submits a new token and, on success, shows the
 * server-returned hint rather than the token itself — the panel never displays a raw token, only
 * what `PUT …/git/credential` hands back.
 */
function RotateCredentialForm({ projectId, open, onOpenChange }: RotateCredentialFormProperties) {
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenHint, setTokenHint] = useState<string | null | undefined>(undefined);

  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  // A fresh open starts clean: a previous rotation's hint/error never lingers into this one.
  useEffect(() => {
    if (open) {
      setError(null);
      setTokenHint(undefined);
      setToken('');
    }
  }, [open]);

  const canSubmit = token.length > 0 && !pending;

  const handleSubmit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      const result = await rotateGitCredential(projectId, { token });
      if (!onScreen.current) return;
      // The token has done its job; clear it immediately rather than leaving it in component state.
      setToken('');
      setTokenHint(result.tokenHint);
    } catch (caughtError) {
      if (!onScreen.current) return;
      setError(describeRotateFailure(caughtError));
    } finally {
      if (onScreen.current) setPending(false);
    }
  };

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
        <KeyRound className="h-5 w-5 text-primary" aria-hidden="true" />
        Rotate access credential
      </Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-muted-foreground">
        Replaces the access token stored for this repository's connection with a new one.
      </Dialog.Description>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {tokenHint !== undefined && (
          <p className="text-sm text-muted-foreground">
            Credential updated — new token ends in {tokenHint ?? 'an unknown value'}.
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor={ROTATE_TOKEN_FIELD_ID}>New access token</Label>
          <Input
            id={ROTATE_TOKEN_FIELD_ID}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Personal access token"
            autoComplete="off"
            disabled={pending}
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {pending ? 'Rotating…' : 'Rotate credential'}
          </Button>
        </div>
      </form>
    </>
  );
}

interface RotateCredentialDialogProperties {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Rotates the connected repository's stored access credential. Escape and outside clicks never
 * dismiss it, same as the other dialogs here, so a shown token hint is never lost to a stray click.
 */
function RotateCredentialDialog({ projectId, open, onOpenChange }: RotateCredentialDialogProperties) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <RotateCredentialForm projectId={projectId} open={open} onOpenChange={onOpenChange} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

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
function DisconnectDialog({ projectId, open, onOpenChange, onDisconnected }: DisconnectDialogProperties) {
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

/** Which dialog, if any, is currently open on the section. */
type OpenDialog = 'connect' | 'initialize' | 'rotate' | 'disconnect' | null;

/** Props for {@link RepositorySection}. */
export interface RepositorySectionProperties {
  /** The project whose git repository connection this section manages. */
  projectId: string;
}

/**
 * The project settings page's "Git Repository" section. Reads {@link useGitStatus} and branches on
 * its `connected` boolean: disconnected offers Connect/Initialize, connected offers Rotate
 * credential/Disconnect (plus whatever branch/sync info `useGitStatus` already carries). Every
 * action reloads that same status afterward so the section re-derives which view to show — no
 * separate poll of the status endpoint is added beyond the one initialize-operation poll.
 */
export function RepositorySection({ projectId }: RepositorySectionProperties) {
  const { status, connected, loading, refetch } = useGitStatus(projectId);
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null);

  const closeDialog = () => setOpenDialog(null);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading repository connection…</p>;
  }

  if (!connected) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          This project is not connected to a remote git repository.
        </p>
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => setOpenDialog('connect')}>
            <Link2 className="mr-2 h-4 w-4" aria-hidden="true" />
            Connect to a remote
          </Button>
          <Button variant="outline" onClick={() => setOpenDialog('initialize')}>
            <GitBranch className="mr-2 h-4 w-4" aria-hidden="true" />
            Initialize & publish
          </Button>
        </div>

        <ConnectOrInitializeDialog
          projectId={projectId}
          mode="connect"
          open={openDialog === 'connect'}
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
          onSucceeded={() => void refetch()}
        />
        <ConnectOrInitializeDialog
          projectId={projectId}
          mode="initialize"
          open={openDialog === 'initialize'}
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
          onSucceeded={() => void refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="flex items-center gap-1 text-[hsl(var(--success))]">
          <GitBranch className="h-4 w-4" aria-hidden="true" />
          Connected
        </span>
        {status && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{status.branch}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{status.syncStatus}</span>
          </>
        )}
      </div>

      <div className="flex gap-3">
        <Button variant="outline" onClick={() => setOpenDialog('rotate')}>
          <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
          Rotate credential
        </Button>
        <Button variant="destructive" onClick={() => setOpenDialog('disconnect')}>
          <Unplug className="mr-2 h-4 w-4" aria-hidden="true" />
          Disconnect
        </Button>
      </div>

      <RotateCredentialDialog
        projectId={projectId}
        open={openDialog === 'rotate'}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      />
      <DisconnectDialog
        projectId={projectId}
        open={openDialog === 'disconnect'}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        onDisconnected={() => void refetch()}
      />
    </div>
  );
}
