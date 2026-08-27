'use client';

/**
 * The "Git Repository" settings section's rotate-credential dialog: replaces the access token
 * stored for a connected repository. Split out of `RepositorySection` so this form and its
 * dialog wrapper live on their own.
 */
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { rotateGitCredential } from '@/lib/api/git';
import { describeRotateFailure } from './repository-error-messages';

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
export function RotateCredentialDialog({ projectId, open, onOpenChange }: RotateCredentialDialogProperties) {
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
