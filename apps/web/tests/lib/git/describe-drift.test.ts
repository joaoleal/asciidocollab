import { describeDrift } from '@/lib/git/describe-drift';
import type { GitDriftSummaryDto } from '@asciidocollab/shared';

describe('describeDrift', () => {
  it('returns null for a null summary', () => {
    expect(describeDrift(null, 'Pull applied', 'pull again')).toBeNull();
  });

  it('returns null for an undefined summary', () => {
    expect(describeDrift(undefined, 'Pull applied', 'pull again')).toBeNull();
  });

  it('returns null for an empty (total: 0) summary', () => {
    const summary: GitDriftSummaryDto = { total: 0, droppedCount: 0, anomalies: [] };
    expect(describeDrift(summary, 'Pull applied', 'pull again')).toBeNull();
  });

  it('returns null for a benign-only summary (no dropped paths, defensive fallback)', () => {
    const summary: GitDriftSummaryDto = {
      total: 1,
      droppedCount: 0,
      anomalies: [{ path: 'ghost.adoc', kind: 'modified_missing_node', applied: true }],
    };
    expect(describeDrift(summary, 'Pull applied', 'pull again')).toBeNull();
  });

  it('prefixes the message with the given leadIn', () => {
    const summary: GitDriftSummaryDto = {
      total: 1,
      droppedCount: 1,
      anomalies: [{ path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false }],
    };
    expect(describeDrift(summary, 'Branch switch applied', 'switch to that branch again')).toMatch(
      /^Branch switch applied, but/,
    );
  });

  it('describes a dropped folder-occupies-path change', () => {
    const summary: GitDriftSummaryDto = {
      total: 1,
      droppedCount: 1,
      anomalies: [{ path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false }],
    };
    const message = describeDrift(summary, 'Pull applied', 'pull again');
    expect(message).toContain('docs');
    expect(message).toContain('a folder occupies that path');
    expect(message).toContain('Remove or rename the folder');
    expect(message).toContain('pull again to recover it');
  });

  it('describes a dropped file-occupies-ancestor-path change', () => {
    const summary: GitDriftSummaryDto = {
      total: 1,
      droppedCount: 1,
      anomalies: [{ path: 'notes', kind: 'content_dropped_file_occupies_ancestor_path', applied: false }],
    };
    const message = describeDrift(summary, 'Pull applied', 'pull again');
    expect(message).toContain('notes');
    expect(message).toContain('a file occupies a parent path segment');
    expect(message).toContain('Remove or rename that file');
    expect(message).not.toContain('folder occupies');
  });

  it('describes a dropped binary-open-document change', () => {
    const summary: GitDriftSummaryDto = {
      total: 1,
      droppedCount: 1,
      anomalies: [{ path: 'diagram.png', kind: 'content_dropped_binary_open_document', applied: false }],
    };
    const message = describeDrift(summary, 'Pull applied', 'pull again');
    expect(message).toContain('diagram.png');
    expect(message).toContain('a document is open in the editor at that path');
    expect(message).toContain('Close the document');
  });

  it('describes multiple dropped kinds with a generic combined obstruction/recovery', () => {
    const summary: GitDriftSummaryDto = {
      total: 2,
      droppedCount: 2,
      anomalies: [
        { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false },
        { path: 'diagram.png', kind: 'content_dropped_binary_open_document', applied: false },
      ],
    };
    const message = describeDrift(summary, 'Pull applied', 'pull again');
    expect(message).toContain('docs');
    expect(message).toContain('diagram.png');
    expect(message).toContain('that path is occupied or a document is open in the editor');
    expect(message).toContain('Resolve the obstruction');
    expect(message).toContain('them');
  });

  it('uses singular wording for exactly one dropped path', () => {
    const summary: GitDriftSummaryDto = {
      total: 1,
      droppedCount: 1,
      anomalies: [{ path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false }],
    };
    const message = describeDrift(summary, 'Pull applied', 'pull again');
    expect(message).toContain('1 change could not be applied');
    expect(message).toContain('was dropped');
    expect(message).toContain('recover it');
  });

  it('uses plural wording for multiple dropped paths of the same kind', () => {
    const summary: GitDriftSummaryDto = {
      total: 2,
      droppedCount: 2,
      anomalies: [
        { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false },
        { path: 'assets', kind: 'content_dropped_folder_occupies_path', applied: false },
      ],
    };
    const message = describeDrift(summary, 'Pull applied', 'pull again');
    expect(message).toContain('2 changes could not be applied');
    expect(message).toContain('were dropped');
    expect(message).toContain('recover them');
  });

  it('mixes benign and dropped anomalies, describing only the dropped ones', () => {
    const summary: GitDriftSummaryDto = {
      total: 2,
      droppedCount: 1,
      anomalies: [
        { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false },
        { path: 'gone.adoc', kind: 'removed_missing_node', applied: true },
      ],
    };
    const message = describeDrift(summary, 'Pull applied', 'pull again');
    expect(message).toContain('docs');
    expect(message).not.toContain('gone.adoc');
  });

  it('summarises more than three dropped paths, naming the first three and the remainder count', () => {
    const summary: GitDriftSummaryDto = {
      total: 5,
      droppedCount: 5,
      anomalies: [
        { path: 'a', kind: 'content_dropped_folder_occupies_path', applied: false },
        { path: 'b', kind: 'content_dropped_folder_occupies_path', applied: false },
        { path: 'c', kind: 'content_dropped_folder_occupies_path', applied: false },
        { path: 'd', kind: 'content_dropped_folder_occupies_path', applied: false },
        { path: 'e', kind: 'content_dropped_folder_occupies_path', applied: false },
      ],
    };
    const message = describeDrift(summary, 'Pull applied', 'pull again');
    expect(message).toContain('a, b, c and 2 more');
  });

  it('ends with the supplied retryHint for a branch switch, not "pull again"', () => {
    const summary: GitDriftSummaryDto = {
      total: 1,
      droppedCount: 1,
      anomalies: [{ path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false }],
    };
    const message = describeDrift(summary, 'Branch switch applied', 'switch to that branch again');
    expect(message).toContain('switch to that branch again to recover it');
    expect(message).not.toContain('pull again');
  });

  it('ends with the supplied retryHint for a conflict completion, not "pull again"', () => {
    const summary: GitDriftSummaryDto = {
      total: 1,
      droppedCount: 1,
      anomalies: [{ path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false }],
    };
    const message = describeDrift(summary, 'Conflicts resolved', 'try the operation again');
    expect(message).toContain('try the operation again to recover it');
    expect(message).not.toContain('pull again');
  });
});
