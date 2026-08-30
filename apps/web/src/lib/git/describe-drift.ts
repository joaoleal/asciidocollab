import type { GitDriftSummaryDto } from '@asciidocollab/shared';

/** Joins up to a few paths for a message, summarising the rest so the text stays short. */
function summarisePaths(paths: string[]): string {
  if (paths.length <= 3) return paths.join(', ');
  return `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;
}

/**
 * Builds the user-facing message for a git action (pull, branch switch, conflict completion) whose
 * result landed with reconcile drift, or null when there was nothing dropped to report. Shared by
 * every flow that can carry a `GitDriftSummaryDto`, since a benign auto-repair never reaches here —
 * `buildGitDriftSummary` on the server already suppresses a summary unless at least one anomaly was
 * dropped — so this describer only ever has actionable losses to word.
 *
 * The message is kind-aware, because the reconciler reports `applied: false` for three different
 * dropped/actionable situations that must not be worded alike:
 *  - `content_dropped_folder_occupies_path` — a folder occupies the file's leaf path; bytes dropped.
 *  - `content_dropped_file_occupies_ancestor_path` — a file occupies a parent path segment; bytes dropped.
 *  - `content_dropped_binary_open_document` — a document is open in the editor at that path; bytes dropped.
 * All three are actionable losses (name the obstruction and how to recover). This is the only place
 * a regular user, who cannot see the server or admin audit logs, learns a change was dropped.
 *
 * @param summary - The operation's drift summary, or null/undefined when it carried none.
 * @param leadIn - The calling flow's opening clause, e.g. `'Pull applied'` or `'Branch switch applied'`.
 * @param recovery - How the dropped content gets recovered. Either the calling flow's retry action
 * as a string, e.g. `'pull again'` or `'switch to that branch again'` (a branch switch or conflict
 * completion cannot be recovered by pulling again) — worded as "clear the obstruction, then
 * <retry>"; or `{ undo: true }` for an undo, which has NO retry that recovers what it dropped
 * (re-running it only replays the same drop). The undo case makes no recovery promise: it states
 * plainly that the drop happened and is recorded in the project's activity history — the only honest
 * wording, since the undo already cleared its own snapshot and the transient backup ref is not
 * something a regular editor could act on anyway.
 */
export function describeDrift(
  summary: GitDriftSummaryDto | null | undefined,
  leadIn: string,
  recovery: string | { undo: true },
): string | null {
  if (!summary || summary.total === 0) return null;

  const droppedFolderPaths = summary.anomalies
    .filter((anomaly) => anomaly.kind === 'content_dropped_folder_occupies_path')
    .map((anomaly) => anomaly.path);
  const droppedFilePaths = summary.anomalies
    .filter((anomaly) => anomaly.kind === 'content_dropped_file_occupies_ancestor_path')
    .map((anomaly) => anomaly.path);
  const droppedBinaryOpenDocumentPaths = summary.anomalies
    .filter((anomaly) => anomaly.kind === 'content_dropped_binary_open_document')
    .map((anomaly) => anomaly.path);
  const droppedPaths = [...droppedFolderPaths, ...droppedFilePaths, ...droppedBinaryOpenDocumentPaths];

  if (droppedPaths.length === 0) return null;

  const noun = droppedPaths.length === 1 ? 'change' : 'changes';
  const verb = droppedPaths.length === 1 ? 'was' : 'were';
  const pronoun = droppedPaths.length === 1 ? 'it' : 'them';
  const kindsPresent = [
    droppedFolderPaths.length > 0,
    droppedFilePaths.length > 0,
    droppedBinaryOpenDocumentPaths.length > 0,
  ].filter(Boolean).length;
  // Classify the obstruction ONCE, into a single discriminant, so the obstruction wording (needed on
  // every path) and — only on the retry path — its paired clearing instruction are both keyed off the
  // same classification and can never drift apart by being derived twice. The undo path's recovery
  // clause is a fixed string, so its clearing instruction is never looked up: `clearAction` is
  // computed inside the string branch below and NOT on the `{ undo: true }` recovery path.
  let obstructionKind: 'multiple' | 'file' | 'openDocument' | 'folder';
  if (kindsPresent > 1) obstructionKind = 'multiple';
  else if (droppedFilePaths.length > 0) obstructionKind = 'file';
  else if (droppedBinaryOpenDocumentPaths.length > 0) obstructionKind = 'openDocument';
  else obstructionKind = 'folder';
  const obstruction: string = {
    multiple: 'that path is occupied or a document is open in the editor',
    file: 'a file occupies a parent path segment',
    openDocument: 'a document is open in the editor at that path',
    folder: 'a folder occupies that path',
  }[obstructionKind];
  // A retry can genuinely re-apply the drop once the obstruction is cleared, so that case names the
  // obstruction and how to clear it — the clearing instruction is looked up ONLY here, on this path.
  // An undo has no such retry — running it again only replays the same drop — and makes NO recovery
  // promise: it says plainly that the drop is recorded in the project's activity history, which the
  // editor can see, rather than pointing at a preserved version or an operation it cannot act on.
  const recoveryClause =
    typeof recovery === 'string'
      ? `${
          {
            multiple: 'Resolve the obstruction',
            file: 'Remove or rename that file',
            openDocument: 'Close the document',
            folder: 'Remove or rename the folder',
          }[obstructionKind]
        }, then ${recovery} to recover ${pronoun}.`
      : `This is recorded in the project's activity history.`;
  return `${leadIn}, but ${droppedPaths.length} ${noun} could not be applied because ${obstruction} and ${verb} dropped: ${summarisePaths(droppedPaths)}. ${recoveryClause}`;
}
