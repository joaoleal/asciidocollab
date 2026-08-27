import { buildGitDriftSummary } from '../../src/types/git-drift-summary';

describe('buildGitDriftSummary', () => {
  it('returns null when there are no anomalies', () => {
    expect(buildGitDriftSummary([])).toBeNull();
  });

  it('returns null when every anomaly is benign (applied: true)', () => {
    const summary = buildGitDriftSummary([
      { path: 'ghost.adoc', kind: 'modified_missing_node', applied: true },
      { path: 'gone.adoc', kind: 'removed_missing_node', applied: true },
    ]);

    expect(summary).toBeNull();
  });

  it('returns a summary when at least one anomaly was dropped', () => {
    const summary = buildGitDriftSummary([
      { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false },
    ]);

    expect(summary).toEqual({
      total: 1,
      droppedCount: 1,
      anomalies: [{ path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false }],
    });
  });

  it('counts the total and the dropped subset in a mixed benign+dropped summary', () => {
    const summary = buildGitDriftSummary([
      { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false },
      { path: 'ghost.adoc', kind: 'modified_missing_node', applied: true },
      { path: 'gone.adoc', kind: 'removed_missing_node', applied: true },
    ]);

    expect(summary).toEqual({
      total: 3,
      droppedCount: 1,
      anomalies: [
        { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false },
        { path: 'ghost.adoc', kind: 'modified_missing_node', applied: true },
        { path: 'gone.adoc', kind: 'removed_missing_node', applied: true },
      ],
    });
  });

  it('keeps only the persisted fields, dropping any extra (e.g. message)', () => {
    const summary = buildGitDriftSummary([
      { path: 'a', kind: 'content_dropped_folder_occupies_path', applied: false, message: 'dropped' } as never,
    ]);

    expect(summary?.anomalies[0]).toEqual({ path: 'a', kind: 'content_dropped_folder_occupies_path', applied: false });
    expect(summary?.anomalies[0]).not.toHaveProperty('message');
  });
});
