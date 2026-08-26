'use client';

/**
 * Read-only unified-diff viewer: renders `DiffDto.unified` — the server's unified-diff STRING — in
 * a CodeMirror 6 view with a line-decoration extension that colors each line by its diff role
 * (added/removed/hunk header/file header/context), using the shared AsciiDoc editor's chrome
 * (font, spacing, gutters, tooltips) via `asciidocEditorTheme` so the diff reads consistently with
 * the editor. This renders the diff text as-is — it never reconstructs two full documents to feed
 * `@codemirror/merge`'s `MergeView` (a unified diff carries only changed hunks plus context, so
 * that reconstruction would be lossy), and it runs no client-side patch/diff engine of its own.
 *
 * AsciiDoc syntax highlighting is deliberately NOT layered on top of the diff text: the grammar's
 * block-level rules (headings, tables, and most other constructs) anchor on column 0, and every
 * diff line is prefixed with `+`/`-`/a leading space, which shifts real content one column to the
 * right and would make the grammar misparse it. Diff-role coloring plus the shared editor chrome
 * is the complete, intentional treatment here.
 */
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { GitCompareArrows } from 'lucide-react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { asciidocEditorTheme } from '@/lib/codemirror/asciidoc-theme';
import { diffLineDecorations } from '@/lib/codemirror/diff-decorations';
import { Button } from '@/components/ui/button';
import { getDiff } from '@/lib/api/git';
import { ApiError } from '@/lib/api/transport';
import type { DiffDto } from '@asciidocollab/shared';

/** Said when a refused diff load has no more specific wording of its own. */
const GENERIC_DIFF_FAILURE = "Couldn't load this diff.";

/**
 * Turns a refused diff load into the sentence shown in the panel, keyed by the backend's typed
 * error code rather than its prose. A first/rootless commit has no parent, so a `<hash>^` `from`
 * is invalid — the underlying git command then fails server-side, and this renders that refusal
 * gracefully rather than crashing the view.
 */
export function describeDiffFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_DIFF_FAILURE;
  switch (caught.code) {
    case 'repository_not_connected': {
      return 'This project has no connected Git repository.';
    }
    case 'git_command_failed': {
      return "Couldn't produce this diff — the selected range may be invalid (for example, a commit with no parent).";
    }
    default: {
      return GENERIC_DIFF_FAILURE;
    }
  }
}

/** Props for {@link DiffView}. */
export interface DiffViewProperties {
  /** The project whose repository the diff belongs to. */
  projectId: string;
  /** Whether the view is currently shown. */
  open: boolean;
  /** Called whenever the view asks to open or close. */
  onOpenChange: (open: boolean) => void;
  /** Project-relative path to scope the diff to a single file. Omitted for the whole tree's diff. */
  path?: string;
  /** The diff's older endpoint — a commit hash, or a commit hash's parent (`${hash}^`). */
  from?: string;
  /** The diff's newer endpoint — a commit hash. */
  to?: string;
}

/**
 * Loads and renders a unified diff for the given range, in a dialog shaped like the other git
 * dialogs (`HistoryPanel`, `ConflictPanel`): Escape and outside clicks never dismiss it, only the
 * explicit Close button does. Fetches only while `open`, and refetches whenever the requested
 * range changes while still open (for example, selecting a different commit).
 */
export function DiffView({ projectId, open, onOpenChange, path, from, to }: DiffViewProperties) {
  const [diff, setDiff] = useState<DiffDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerReference = useRef<HTMLDivElement>(null);
  const viewReference = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    setDiff(null);
    getDiff(projectId, { path, from, to })
      .then((result) => {
        if (!active) return;
        setDiff(result);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(describeDiffFailure(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, projectId, path, from, to]);

  useEffect(() => {
    if (!diff || diff.unified === '' || !containerReference.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: diff.unified,
        extensions: [
          asciidocEditorTheme,
          diffLineDecorations(),
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
  }, [diff]);

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
            <GitCompareArrows className="h-5 w-5 text-primary" aria-hidden="true" />
            Diff
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            {path ? `Changes to ${path}.` : 'Changes across the repository.'}
          </Dialog.Description>

          <div className="mt-4 space-y-4">
            {loading && <p className="text-sm text-muted-foreground">Loading diff…</p>}

            {!loading && error && (
              <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </div>
            )}

            {!loading && !error && diff && diff.unified === '' && (
              <p className="text-sm text-muted-foreground">No changes.</p>
            )}

            {!loading && !error && diff && diff.unified !== '' && (
              <div ref={containerReference} className="cm-diff-container rounded-md border" />
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
