'use client';

/**
 * Read-only per-line authorship ("blame") viewer for one file: renders the file's content
 * (`BlameDto.lines`, joined) in a CodeMirror 6 view with a gutter extension showing each line's
 * author and a compact authored-at date. Author identity is resolved the same way `HistoryPanel`
 * resolves a commit's author — by looking up `BlameLineDto.authorUserId` against the project's
 * membership via `membersApi.list` — so no new user-fetch endpoint is added. A line whose author
 * maps to no currently-listed member (for example, imported history authored outside the platform)
 * falls back to a neutral "Unknown author" label rather than a blank cell.
 */
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { UserRoundSearch } from 'lucide-react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { asciidocEditorTheme } from '@/lib/codemirror/asciidoc-theme';
import { blameGutter, formatBlameDate, type BlameLineInfo } from '@/lib/codemirror/blame-gutter';
import { Button } from '@/components/ui/button';
import { getBlame } from '@/lib/api/git';
import { membersApi } from '@/lib/api/members';
import { ApiError } from '@/lib/api/transport';
import type { BlameDto } from '@asciidocollab/shared';

/** Shown for a blame line whose author's git identity maps to no platform user. */
const UNKNOWN_AUTHOR_LABEL = 'Unknown author';

/** Said when a refused blame load has no more specific wording of its own. */
const GENERIC_BLAME_FAILURE = "Couldn't load blame for this file.";

/**
 * Turns a refused blame load into the sentence shown in the panel, keyed by the backend's typed
 * error code rather than its prose.
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

/** The subset of a project member blame author resolution needs. */
interface AuthorLookup {
  displayName: string;
}

/** Props for {@link BlameView}. */
export interface BlameViewProperties {
  /** The project the blamed file belongs to. */
  projectId: string;
  /** Whether the view is currently shown. */
  open: boolean;
  /**
   * Called whenever the view asks to open or close.
   *
   * @param open - True to show the view, false to hide it.
   */
  onOpenChange: (open: boolean) => void;
  /** The blamed file's project-relative path. */
  path: string;
  /** The commit/branch to blame at. Omitted to blame the checked-out working tree. */
  ref?: string;
}

/**
 * Loads and renders one file's per-line authorship, in a dialog shaped like the other git dialogs
 * (`HistoryPanel`, `ConflictPanel`): Escape and outside clicks never dismiss it, only the explicit
 * Close button does. Fetches only while `open`.
 */
export function BlameView({ projectId, open, onOpenChange, path, ref }: BlameViewProperties) {
  const [blame, setBlame] = useState<BlameDto | null>(null);
  const [membersByUserId, setMembersByUserId] = useState<Record<string, AuthorLookup>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerReference = useRef<HTMLDivElement>(null);
  const viewReference = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    setBlame(null);
    getBlame(projectId, path, { ref })
      .then((result) => {
        if (!active) return;
        setBlame(result);
      })
      .catch((error_: unknown) => {
        if (!active) return;
        setError(describeBlameFailure(error_));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, projectId, path, ref]);

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
        // Author names are a display nicety only: a failed lookup leaves every line's author
        // falling back to the neutral placeholder, not an error for the whole view.
      });
    return () => {
      active = false;
    };
  }, [open, projectId]);

  useEffect(() => {
    if (!blame || blame.lines.length === 0 || !containerReference.current) return;
    const content = blame.lines.map((line) => line.content).join('\n');
    const infoByLine = new Map<number, BlameLineInfo>();
    for (const line of blame.lines) {
      const member = line.authorUserId ? membersByUserId[line.authorUserId] : undefined;
      const authorLabel = member?.displayName ?? UNKNOWN_AUTHOR_LABEL;
      const dateLabel = formatBlameDate(line.authoredAt);
      infoByLine.set(line.lineNumber, {
        authorLabel,
        hasAuthor: member !== undefined,
        dateLabel,
        tooltip: `${authorLabel} · ${dateLabel} · ${line.hash.slice(0, 7)}`,
      });
    }

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          asciidocEditorTheme,
          blameGutter((lineNumber) => infoByLine.get(lineNumber) ?? null),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      }),
      parent: containerReference.current,
    });
    viewReference.current = view;
    return () => {
      view.destroy();
      viewReference.current = null;
    };
  }, [blame, membersByUserId]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-lg bg-background p-6 shadow-lg"
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
            <UserRoundSearch className="h-5 w-5 text-primary" aria-hidden="true" />
            Blame
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            Per-line authorship for {path}.
          </Dialog.Description>

          <div className="mt-4 space-y-4">
            {loading && <p className="text-sm text-muted-foreground">Loading blame…</p>}

            {!loading && error && (
              <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </div>
            )}

            {!loading && !error && blame && blame.lines.length === 0 && (
              <p className="text-sm text-muted-foreground">This file is empty.</p>
            )}

            {!loading && !error && blame && blame.lines.length > 0 && (
              <div ref={containerReference} className="cm-blame-container rounded-md border" />
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
