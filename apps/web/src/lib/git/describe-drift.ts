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
 * @param retryHint - The calling flow's recovery action, e.g. `'pull again'` or `'switch to that
 * branch again'` — a branch switch or conflict completion cannot be recovered by pulling again.
 */
export function describeDrift(
  summary: GitDriftSummaryDto | null | undefined,
  leadIn: string,
  retryHint: string,
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
  let obstruction: string;
  let recovery: string;
  if (kindsPresent > 1) {
    obstruction = 'that path is occupied or a document is open in the editor';
    recovery = 'Resolve the obstruction';
  } else if (droppedFilePaths.length > 0) {
    obstruction = 'a file occupies a parent path segment';
    recovery = 'Remove or rename that file';
  } else if (droppedBinaryOpenDocumentPaths.length > 0) {
    obstruction = 'a document is open in the editor at that path';
    recovery = 'Close the document';
  } else {
    obstruction = 'a folder occupies that path';
    recovery = 'Remove or rename the folder';
  }
  return `${leadIn}, but ${droppedPaths.length} ${noun} could not be applied because ${obstruction} and ${verb} dropped: ${summarisePaths(droppedPaths)}. ${recovery}, then ${retryHint} to recover ${pronoun}.`;
}
