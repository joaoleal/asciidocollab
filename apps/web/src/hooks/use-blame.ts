'use client';

/**
 * Loads one file's per-line authorship ("blame") for the live editor's inline blame gutter. Fetches
 * only while `enabled` (the toolbar toggle is on) and refetches whenever the open file's `path`
 * changes, resolving each line's git author to a project member's display name the same way the
 * history panel does — via `membersApi.list` — so no new user-fetch endpoint is needed. A line whose
 * author maps to no currently-listed member falls back to a neutral "Unknown author" label.
 *
 * The resolved per-line map ({@link BlameLines}) is handed to the editor, which dispatches it into
 * the gutter's backing field; a member-lookup failure is a display nicety only (every line falls back
 * to the placeholder) and never fails the whole read, while a blame-read failure clears the gutter and
 * surfaces a typed message.
 */
import { useEffect, useState } from 'react';
import { getBlame } from '@/lib/api/git';
import { membersApi } from '@/lib/api/members';
import { ApiError } from '@/lib/api/transport';
import { blameTooltip, formatBlameDate, type BlameLineInfo, type BlameLines } from '@/lib/codemirror/blame-gutter';

/** Shown for a blame line whose author's git identity maps to no platform user. */
const UNKNOWN_AUTHOR_LABEL = 'Unknown author';

/** Said when a refused blame load has no more specific wording of its own. */
const GENERIC_BLAME_FAILURE = "Couldn't load blame for this file.";

/**
 * Turns a refused blame load into a display sentence, keyed by the backend's typed error code rather
 * than its prose. Exported so it can be unit-tested independently of the hook.
 */
export function describeBlameFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_BLAME_FAILURE;
  switch (caught.code) {
    case 'repository_not_connected': {
      return 'This project has no connected Git repository.';
    }
    default: {
      return GENERIC_BLAME_FAILURE;
    }
  }
}

/** Inputs for {@link useBlame}. */
export interface UseBlameOptions {
  /** The project the blamed file belongs to, or undefined when none is open. */
  projectId: string | undefined;
  /** The open file's project-relative path, or null/undefined when nothing blameable is open. */
  path: string | null | undefined;
  /** Whether blame is currently toggled on. When false, nothing is fetched and the map is null. */
  enabled: boolean;
}

/** What {@link useBlame} returns. */
export interface UseBlameResult {
  /** The resolved per-line blame map to feed the gutter, or null while off/loading/failed. */
  blameLines: BlameLines;
  /** A display message when the blame read was refused, or null. */
  error: string | null;
  /** Whether a fetch is currently in flight. */
  loading: boolean;
}

/**
 * Fetches and resolves one file's blame while `enabled`, keyed on the project and open file path.
 * Refetches on a file switch; clears to `null` when disabled or when no file is open.
 */
export function useBlame({ projectId, path, enabled }: UseBlameOptions): UseBlameResult {
  const [blameLines, setBlameLines] = useState<BlameLines>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !projectId || !path) {
      setBlameLines(null);
      setError(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    // The member lookup resolves author names; it never rejects the whole read — a failed lookup
    // leaves every line falling back to the neutral placeholder, exactly as the old dialog did.
    const namesPromise = membersApi.list(projectId).then(
      (response): Record<string, string> => {
        const namesByUserId: Record<string, string> = {};
        for (const member of response.data.members) namesByUserId[member.userId] = member.displayName;
        return namesByUserId;
      },
      (): Record<string, string> => ({}),
    );

    Promise.all([getBlame(projectId, path), namesPromise])
      .then(([blame, namesByUserId]) => {
        if (!active) return;
        const infoByLine = new Map<number, BlameLineInfo>();
        for (const line of blame.lines) {
          const resolvedName = line.authorUserId ? namesByUserId[line.authorUserId] : undefined;
          const hasAuthor = resolvedName !== undefined;
          const authorLabel = resolvedName ?? UNKNOWN_AUTHOR_LABEL;
          const dateLabel = formatBlameDate(line.authoredAt);
          infoByLine.set(line.lineNumber, {
            authorLabel,
            hasAuthor,
            dateLabel,
            message: line.message,
            tooltip: blameTooltip(authorLabel, dateLabel, line.hash, line.message),
          });
        }
        setBlameLines(infoByLine);
      })
      .catch((error_: unknown) => {
        if (!active) return;
        setError(describeBlameFailure(error_));
        setBlameLines(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [enabled, projectId, path]);

  return { blameLines, error, loading };
}
