'use client';

/**
 * Shared presentation for a dry-run preview's commit list + changed-path summary — the content the
 * pull and push preview dialogs both render. Read-only and self-contained: it resolves each commit's
 * author itself (via `membersApi.list`, same as `HistoryPanel`) rather than asking its caller to.
 */
import { useEffect, useState } from 'react';
import { GitCommitHorizontal } from 'lucide-react';
import { Avatar } from '@/components/avatar';
import { formatRelativeTime } from '@/lib/format-relative-time';
import { membersApi } from '@/lib/api/members';
import type { CommitDto } from '@asciidocollab/shared';

/** Shown for a commit whose author's git identity maps to no platform user. */
const UNKNOWN_AUTHOR_LABEL = 'Unknown author';

/** The subset of a project member this list needs to resolve a commit's author. */
interface AuthorLookup {
  displayName: string;
}

/**
 * A commit's author, resolved from `CommitDto.authorUserId` against the project's membership — the
 * same DiceBear identity (via the shared `Avatar`) shown elsewhere for a member, seeded from their
 * display name since a commit carries no `avatarKey` of its own. Falls back to a neutral placeholder
 * when the id is absent or maps to no currently-listed member.
 */
function CommitPreviewAuthor({
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

/** One commit's row: short hash, message, author, and authored-at. Not interactive — previews only display. */
function CommitPreviewRow({
  commit,
  membersByUserId,
}: {
  commit: CommitDto;
  membersByUserId: Record<string, AuthorLookup>;
}) {
  return (
    <li className="border-b py-1 last:border-b-0">
      <div className="flex flex-col gap-1 px-2 py-1.5">
        <span className="flex items-center gap-2">
          <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm">{commit.message}</span>
        </span>
        <span className="flex items-center justify-between gap-2 pl-5">
          <CommitPreviewAuthor authorUserId={commit.authorUserId} membersByUserId={membersByUserId} />
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{commit.hash.slice(0, 7)}</span>
            <span>{formatRelativeTime(commit.authoredAt)}</span>
          </span>
        </span>
      </div>
    </li>
  );
}

/** Props for {@link CommitPreviewList}. */
export interface CommitPreviewListProperties {
  /** The project the previewed commits belong to — used only to resolve author display names. */
  projectId: string;
  /** Whether this list is currently visible; author names are fetched only while true. */
  enabled: boolean;
  /** The previewed commits, newest first. */
  commits: CommitDto[];
  /** Every path those commits touch, for the compact changed-paths summary below the list. */
  changedPaths: string[];
}

/**
 * Renders a dry-run preview's commit list plus a compact changed-paths summary. Shared by the pull
 * and push preview dialogs so the commit-row markup exists in exactly one place.
 */
export function CommitPreviewList({ projectId, enabled, commits, changedPaths }: CommitPreviewListProperties) {
  const [membersByUserId, setMembersByUserId] = useState<Record<string, AuthorLookup>>({});

  useEffect(() => {
    if (!enabled) return;
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
        // author falling back to the neutral placeholder, not an error for the whole preview.
      });
    return () => {
      active = false;
    };
  }, [enabled, projectId]);

  return (
    <div className="space-y-3">
      <ul className="max-h-48 overflow-y-auto">
        {commits.map((commit) => (
          <CommitPreviewRow key={commit.hash} commit={commit} membersByUserId={membersByUserId} />
        ))}
      </ul>
      <div className="rounded-md border p-2 text-xs">
        <p className="font-medium text-foreground">
          {changedPaths.length} changed path{changedPaths.length === 1 ? '' : 's'}
        </p>
        {changedPaths.length > 0 && (
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto font-mono text-muted-foreground">
            {changedPaths.map((path) => (
              <li key={path} className="truncate">
                {path}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
