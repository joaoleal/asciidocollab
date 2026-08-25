'use client';

/**
 * Dialog for resolving a paused pull's merge conflicts: lists every conflicting file with a
 * Keep-ours / Take-theirs action and (for non-binary files) an inline three-way merge editor, then
 * Complete (disabled until every file is resolved) or Undo the pull. Shaped like the other git
 * dialogs (`PullDialog`, `BranchSwitchDialog`): Escape and outside clicks never dismiss it, since a
 * stray click losing track of which files are resolved would be worse than a slightly stickier
 * dialog — only Cancel-equivalent (closing once conflicts are cleared) or an explicit close does.
 */
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, CheckCircle2, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConflictMergeEditor } from '@/components/git/conflict-merge-editor';
import { ApiError } from '@/lib/api/transport';
import type { ConflictResolution, ConflictSummaryDto } from '@asciidocollab/shared';
import type { ConflictsMessage } from '@/hooks/use-conflicts';

/** Said when a refused complete/undo has no more specific wording of its own. */
const GENERIC_COMPLETE_FAILURE = "Couldn't complete the pull.";

/**
 * Turns a refused complete/undo into the sentence shown in the panel, keyed by the backend's typed
 * error code rather than its prose.
 */
export function describeCompleteFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_COMPLETE_FAILURE;
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need editor access to do this.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    case 'unresolved_conflicts': {
      return 'Every conflicting file must be resolved first.';
    }
    case 'nothing_to_undo': {
      return 'There is no paused pull to undo.';
    }
    default: {
      return GENERIC_COMPLETE_FAILURE;
    }
  }
}

/** Said when a refused resolve has no more specific wording of its own. */
const GENERIC_CONFLICT_FAILURE = "Couldn't resolve this file.";

/**
 * Turns a refused per-file resolve (Keep ours / Take theirs / save merge) into the sentence shown
 * next to that file, keyed by the backend's typed error code rather than its prose.
 */
export function describeConflictFailure(caught: unknown): string {
  if (!(caught instanceof ApiError)) return GENERIC_CONFLICT_FAILURE;
  switch (caught.code) {
    case 'insufficient_role': {
      return 'You need editor access to resolve conflicts.';
    }
    case 'git_worker_unavailable': {
      return 'The git service is unavailable. Try again shortly.';
    }
    case 'repository_not_connected': {
      return 'This project has no connected repository.';
    }
    case 'validation_error': {
      return 'Enter the merged content before saving.';
    }
    default: {
      return GENERIC_CONFLICT_FAILURE;
    }
  }
}

/** A conflicting file's resolved/unresolved badge style: the tokenized className plus its label. */
export interface ConflictBadgeStyle {
  /** Tailwind classes for the badge's text color, built from design tokens only. */
  className: string;
  /** Human-readable label — both the accessible name and the visible text. */
  label: string;
}

/**
 * Maps a conflicting file's resolved flag to its rendered badge style. Pure and exported for unit
 * testing, kept JSX-free so it can be tested without rendering (mirrors `syncStatusStyle`).
 */
export function conflictBadgeStyle(resolved: boolean): ConflictBadgeStyle {
  return resolved
    ? { className: 'text-[hsl(var(--success))]', label: 'Resolved' }
    : { className: 'text-muted-foreground', label: 'Unresolved' };
}

/** One conflicting file's row: path, badge, and its resolution controls. */
interface ConflictFileRowProperties {
  projectId: string;
  file: ConflictSummaryDto;
  resolvingPath: string | null;
  editingPath: string | null;
  rowMessage: { path: string; text: string } | null;
  onKeepOurs: (path: string) => void;
  onTakeTheirs: (path: string) => void;
  onEditMerge: (path: string) => void;
  onMergeSaved: (path: string, mergedContent: string) => void;
  onMergeCancelled: () => void;
}

function ConflictFileRow({
  projectId,
  file,
  resolvingPath,
  editingPath,
  rowMessage,
  onKeepOurs,
  onTakeTheirs,
  onEditMerge,
  onMergeSaved,
  onMergeCancelled,
}: ConflictFileRowProperties) {
  const badge = conflictBadgeStyle(file.resolved);
  const BadgeIcon = file.resolved ? CheckCircle2 : Circle;
  const pending = resolvingPath === file.path;
  const isEditing = editingPath === file.path;

  return (
    <li className="flex flex-col gap-2 border-b py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{file.path}</span>
        <span className={`flex items-center gap-1 text-xs ${badge.className}`}>
          <BadgeIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {badge.label}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onKeepOurs(file.path)}
        >
          Keep ours
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onTakeTheirs(file.path)}
        >
          Take theirs
        </Button>
        {!file.isBinary && (
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => onEditMerge(file.path)}>
            Edit merge…
          </Button>
        )}
      </div>
      {rowMessage && rowMessage.path === file.path && (
        <div role="alert" className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          {rowMessage.text}
        </div>
      )}
      {isEditing && !file.isBinary && (
        <ConflictMergeEditor
          projectId={projectId}
          path={file.path}
          onSave={(mergedContent) => onMergeSaved(file.path, mergedContent)}
          onCancel={onMergeCancelled}
        />
      )}
    </li>
  );
}

/** Props for {@link ConflictPanel}. */
export interface ConflictPanelProperties {
  /** The project whose conflicts are being resolved. */
  projectId: string;
  /** Whether the dialog is currently shown. */
  open: boolean;
  /**
   * Called whenever the dialog asks to open or close.
   *
   * @param open - The visibility being requested.
   */
  onOpenChange: (open: boolean) => void;
  /** Every currently conflicting file. */
  files: ConflictSummaryDto[];
  /** True while the conflict list is loading. */
  loading: boolean;
  /** A genuinely unexpected load failure, or null. */
  error: string | null;
  /** Whether every conflicting file has been resolved — gates the Complete button. */
  allResolved: boolean;
  /**
   * Resolves one file.
   *
   * @param path - The conflicting file's project-relative path.
   * @param resolution - How to resolve it.
   * @param mergedContent - The final merged text; only meaningful for `'merged'`.
   */
  resolve: (path: string, resolution: ConflictResolution, mergedContent?: string) => Promise<void>;
  /** Completes the paused pull. Disabled by the caller until `allResolved`. */
  complete: () => void;
  /** Abandons the paused pull, reverting the working tree. */
  undo: () => void;
  /** True while a complete/undo is starting or its operation is being polled. */
  completing: boolean;
  /** The outcome message from the most recent complete/undo attempt that did not simply succeed, or null. */
  message: ConflictsMessage | null;
}

/**
 * Lists the project's currently conflicting files and drives their resolution: Keep ours, Take
 * theirs, or (for non-binary files) an inline three-way merge editor. The Complete button stays
 * disabled until every file is resolved — completing early would ask the server to finish a pull
 * still carrying unresolved conflicts, which it refuses.
 */
export function ConflictPanel({
  projectId,
  open,
  onOpenChange,
  files,
  loading,
  error,
  allResolved,
  resolve,
  complete,
  undo,
  completing,
  message,
}: ConflictPanelProperties) {
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<{ path: string; text: string } | null>(null);

  const runResolve = (path: string, resolution: ConflictResolution, mergedContent?: string) => {
    setResolvingPath(path);
    setRowMessage(null);
    resolve(path, resolution, mergedContent)
      .then(() => {
        setEditingPath((current) => (current === path ? null : current));
      })
      .catch((caughtError: unknown) => {
        setRowMessage({ path, text: describeConflictFailure(caughtError) });
      })
      .finally(() => {
        setResolvingPath(null);
      });
  };

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
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            Resolve conflicts
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            Resolve each conflicting file below, then complete the pull. You can also undo it to
            return to the state before the pull started.
          </Dialog.Description>

          <div className="mt-4 space-y-4">
            {message && (
              <div
                role="alert"
                className={
                  message.tone === 'error'
                    ? 'rounded-md bg-destructive/10 p-2 text-sm text-destructive'
                    : 'rounded-md bg-muted p-2 text-sm text-muted-foreground'
                }
              >
                {message.text}
              </div>
            )}

            {loading && <p className="text-sm text-muted-foreground">Loading conflicts…</p>}

            {!loading && error && (
              <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </div>
            )}

            {!loading && !error && files.length === 0 && (
              <p className="text-sm text-muted-foreground">No conflicting files.</p>
            )}

            {!loading && !error && files.length > 0 && (
              <ul>
                {files.map((file) => (
                  <ConflictFileRow
                    key={file.path}
                    projectId={projectId}
                    file={file}
                    resolvingPath={resolvingPath}
                    editingPath={editingPath}
                    rowMessage={rowMessage}
                    onKeepOurs={(path) => runResolve(path, 'ours')}
                    onTakeTheirs={(path) => runResolve(path, 'theirs')}
                    onEditMerge={(path) => setEditingPath(path)}
                    onMergeSaved={(path, mergedContent) => runResolve(path, 'merged', mergedContent)}
                    onMergeCancelled={() => setEditingPath(null)}
                  />
                ))}
              </ul>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={undo} disabled={completing}>
                {completing ? 'Working…' : 'Undo pull'}
              </Button>
              <Button type="button" onClick={complete} disabled={completing || !allResolved}>
                {completing ? 'Working…' : 'Complete'}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
