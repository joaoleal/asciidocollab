'use client';

/**
 * Commit-history panel: a scrollable list of the connected repository's commits, most recent
 * first, each showing its short hash, message, author, and when it was authored. Read-only —
 * this renders no diff or blame content itself. Shaped like `ConflictPanel`: Escape and outside
 * clicks never dismiss it, so browsing the list is never interrupted by a stray click; only the
 * explicit Close button does.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { GitCommitHorizontal, History } from 'lucide-react';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { useGitHistory } from '@/hooks/use-git-history';
import { formatRelativeTime } from '@/lib/format-relative-time';
import { membersApi } from '@/lib/api/members';
import type { CommitDto } from '@asciidocollab/shared';

/** Shown for a commit whose author's git identity maps to no platform user. */
const UNKNOWN_AUTHOR_LABEL = 'Unknown author';

/** The subset of a project member this panel needs to resolve a commit's author. */
interface AuthorLookup {
  displayName: string;
}

/**
 * A commit's author, resolved from `CommitDto.authorUserId` against the project's membership —
 * the same DiceBear identity (via the shared `Avatar`) shown elsewhere for a member, seeded from
 * their display name since a commit carries no `avatarKey` of its own. Falls back to a neutral
 * placeholder when the id is absent or maps to no currently-listed member (for example, imported
 * history authored outside the platform).
 */
function CommitAuthor({
  authorUserId,
  membersByUserId,
}: {
  authorUserId?: string;
  membersByUserId: Record<string, AuthorLookup>;
}) {
  const member = authorUserId ? membersByUserId[authorUserId] : undefined;
  if (!member) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground"
        >
          —
        </span>
        <span className="truncate">{UNKNOWN_AUTHOR_LABEL}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Avatar avatarKey={null} displayName={member.displayName} size={20} />
      <span className="truncate">{member.displayName}</span>
    </span>
  );
}

/** One commit's row: short hash, message, author, and authored-at, activating `onSelectCommit`. */
function CommitRow({
  commit,
  membersByUserId,
  onSelectCommit,
}: {
  commit: CommitDto;
  membersByUserId: Record<string, AuthorLookup>;
  onSelectCommit?: (commit: CommitDto) => void;
}) {
  return (
    <li className="border-b py-1 last:border-b-0">
      <button
        type="button"
        onClick={() => onSelectCommit?.(commit)}
        className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-2">
          <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm">{commit.message}</span>
        </span>
        <span className="flex items-center justify-between gap-2 pl-5">
          <CommitAuthor authorUserId={commit.authorUserId} membersByUserId={membersByUserId} />
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{commit.hash.slice(0, 7)}</span>
            <span>{formatRelativeTime(commit.authoredAt)}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** Props for {@link HistoryPanel}. */
export interface HistoryPanelProperties {
  /** The project whose connected repository's history is being viewed. */
  projectId: string;
  /** Whether the panel is currently shown. */
  open: boolean;
  /**
   * Called whenever the panel asks to open or close.
   *
   * @param open - The visibility being requested.
   */
  onOpenChange: (open: boolean) => void;
  /** Project-relative path to scope the history to a single file's commits. Omitted for the whole repository. */
  path?: string;
  /** Maximum number of commits to load. Omitted to use the server's default. */
  limit?: number;
  /**
   * Called when a commit row is activated (click or keyboard). This is the seam a diff-view
   * companion component uses: pass a handler here that opens that commit's diff. Left undefined,
   * rows render but do nothing when activated — this panel never renders diff or blame content
   * itself.
   *
   * @param commit - The activated commit.
   */
  onSelectCommit?: (commit: CommitDto) => void;
}

/**
 * Lists the project's connected repository's commit history. Loading, empty ("No commits yet"),
 * and error states are rendered the same way the other git dialogs render theirs. Author identity
 * is resolved by looking up `CommitDto.authorUserId` against the project's membership — no new
 * user-fetch endpoint is added.
 */
export function HistoryPanel({ projectId, open, onOpenChange, path, limit, onSelectCommit }: HistoryPanelProperties) {
  const { commits, connected, loading, error } = useGitHistory(projectId, { path, limit, enabled: open });
  const [membersByUserId, setMembersByUserId] = useState<Record<string, AuthorLookup>>({});

  useEffect(() => {
    if (!open) return;
    let active = true;
    membersApi
      .list(projectId)
      .then((response) => {
        if (!active) return;
        const map: Record<string, AuthorLookup> = {};
        for (const member of response.data.members) {
          map[member.userId] = { displayName: member.displayName };
        }
        setMembersByUserId(map);
      })
      .catch(() => {
        // Author names are a display nicety only: a failed lookup just leaves every commit's
        // author falling back to the neutral placeholder, not an error for the whole panel.
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
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-lg bg-background p-6 shadow-lg"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
            <History className="h-5 w-5 text-primary" aria-hidden="true" />
            Commit history
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            {path ? `Commits touching ${path}, most recent first.` : "The repository's commits, most recent first."}
          </Dialog.Description>

          <div className="mt-4 space-y-4">
            {loading && <p className="text-sm text-muted-foreground">Loading commit history…</p>}

            {!loading && error && (
              <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </div>
            )}

            {!loading && !error && connected && commits.length === 0 && (
              <p className="text-sm text-muted-foreground">No commits yet.</p>
            )}

            {!loading && !error && !connected && (
              <p className="text-sm text-muted-foreground">This project has no connected repository.</p>
            )}

            {!loading && !error && commits.length > 0 && (
              <ul>
                {commits.map((commit) => (
                  <CommitRow
                    key={commit.hash}
                    commit={commit}
                    membersByUserId={membersByUserId}
                    onSelectCommit={onSelectCommit}
                  />
                ))}
              </ul>
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
