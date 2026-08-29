'use client';

/**
 * Editor-only header affordance: shows the project's current branch, lists every local branch in a
 * dropdown with a switch action on each, and offers a "New branch…" dialog to create one. The
 * dropdown reuses `DropdownMenu` (there is no Select/Combobox in this app); the create dialog
 * mirrors the commit dialog's own-form-component pattern so a typed name/error never survives a
 * close/reopen. The switch confirm step (for the two synchronous `checkoutBranch` refusals) is a
 * separate `BranchSwitchDialog`, mounted independently — see `useBranches`.
 */
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, GitBranch, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiError } from '@/lib/api/transport';
import type { BranchDto } from '@asciidocollab/shared';

const NAME_FIELD_ID = 'branch-switcher-new-branch-name';

/** Said when creating a branch is refused for a reason with no more specific wording of its own. */
const GENERIC_BRANCH_FAILURE = "Couldn't create the branch.";

/**
 * Turns a refused branch creation into the sentence shown on the "New branch…" form, keyed by the
 * backend's typed error code rather than its prose.
 */
export function describeBranchFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_BRANCH_FAILURE;
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need editor access to create a branch.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    case 'validation_error': {
      return 'Enter a valid branch name.';
    }
    default: {
      return GENERIC_BRANCH_FAILURE;
    }
  }
}

interface CreateBranchFormProperties {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<void>;
}

/**
 * The create-branch dialog's interactive body: a single name field submitted to `onCreate`. Lives
 * in its own component, same as the commit form, so a typed name/error never survives a close/reopen.
 */
function CreateBranchForm({ open, onOpenChange, onCreate }: CreateBranchFormProperties) {
  const [name, setName] = useState('');
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

  // A fresh open starts clean: a previous attempt's typed name/error never lingers into this one.
  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
    }
  }, [open]);

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !pending;

  const handleSubmit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      await onCreate(trimmedName);
      if (!onScreen.current) return;
      onOpenChange(false);
    } catch (caughtError) {
      if (!onScreen.current) return;
      setError(describeBranchFailure(caughtError));
    } finally {
      if (onScreen.current) setPending(false);
    }
  };

  return (
    <>
      <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
        <GitBranch className="h-5 w-5 text-primary" aria-hidden="true" />
        New branch
      </Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-muted-foreground">
        Create a new branch from the current branch tip.
      </Dialog.Description>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor={NAME_FIELD_ID}>Branch name</Label>
          <input
            id={NAME_FIELD_ID}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="feature/my-change"
            disabled={pending}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {pending ? 'Creating…' : 'Create branch'}
          </Button>
        </div>
      </form>
    </>
  );
}

/** Props for {@link BranchSwitcher}. */
export interface BranchSwitcherProperties {
  /** The currently checked-out branch, or null while not yet loaded. */
  current: string | null;
  /** Every local branch, in no particular order. */
  branches: BranchDto[];
  /** True while the branch list is loading. */
  loading: boolean;
  /** True while a switch is starting or its operation is being polled — disables switch actions. */
  switchPending: boolean;
  /**
   * Starts switching to the given branch.
   *
   * @param name - The branch name to switch to.
   */
  onSwitch: (name: string) => void;
  /**
   * Creates a new branch with the given name; rejects on failure so the dialog can show why.
   *
   * @param name - The new branch's name.
   */
  onCreate: (name: string) => Promise<void>;
}

/**
 * The trigger + branch list dropdown, plus the "New branch…" create dialog. Renders even before the
 * branch list has loaded (the trigger shows a neutral label), so the header layout never shifts once
 * an editor's connected project resolves its branches.
 */
export function BranchSwitcher({
  current,
  branches,
  loading,
  switchPending,
  onSwitch,
  onCreate,
}: BranchSwitcherProperties) {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={switchPending} aria-label="Switch branch" className="shrink-0">
            {switchPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <GitBranch className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            <span className="max-w-[10rem] truncate" title={current ?? undefined}>
              {current ?? (loading ? 'Loading…' : 'Branch')}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {branches.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No branches found.</div>
          )}
          {branches.map((branch) => (
            <DropdownMenuItem
              key={branch.name}
              disabled={branch.isCurrent || switchPending}
              onSelect={() => {
                if (!branch.isCurrent) onSwitch(branch.name);
              }}
              className="flex items-center gap-2"
            >
              <span className="flex h-4 w-4 items-center justify-center">
                {branch.isCurrent && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
              </span>
              <span className="truncate">{branch.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreateOpen(true)} className="flex items-center gap-2">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New branch…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-lg bg-background p-6 shadow-lg"
            onPointerDownOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => event.preventDefault()}
          >
            <CreateBranchForm open={createOpen} onOpenChange={setCreateOpen} onCreate={onCreate} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
