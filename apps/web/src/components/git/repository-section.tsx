'use client';

/**
 * The project settings page's "Git Repository" section: connect an existing remote, initialize a
 * brand-new one, rotate the stored access credential, and disconnect — the four owner-gated actions
 * that drive `apps/api`'s `POST/PUT …/git/{connect,initialize,disconnect,credential}` routes. Each
 * action's form+dialog lives in its own module ({@link ConnectOrInitializeDialog},
 * {@link RotateCredentialDialog}, {@link DisconnectDialog}); this section only chooses which view
 * to show and opens the matching dialog.
 *
 * Connection state is derived ENTIRELY from {@link useGitStatus} — its `connected` boolean, itself
 * derived from a 404 on the status endpoint — since there is no fetchable "current repository"
 * endpoint to read provider/remoteUrl/tokenHint from after the fact. The connected view therefore
 * shows only a plain connected state plus whatever `useGitStatus` already carries (branch, sync
 * status); a credential rotation's `tokenHint` is shown only once, straight from that call's own
 * response.
 */
import { useState } from 'react';
import { GitBranch, KeyRound, Link2, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useGitStatus } from '@/hooks/use-git-status';
import { ConnectOrInitializeDialog } from './repository-connect-dialog';
import { RotateCredentialDialog } from './repository-rotate-dialog';
import { DisconnectDialog } from './repository-disconnect-dialog';

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
