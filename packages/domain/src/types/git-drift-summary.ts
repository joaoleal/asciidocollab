/**
 * A compact, persistable record of the reconciler drift a SUCCEEDED pull hit while landing its
 * change-set. Stored on the `GitOperation` row and surfaced to the user who triggered the pull —
 * who has no access to the server log or the (admin-only) audit log, and would otherwise never learn
 * that a pulled change was dropped and needs recovery.
 *
 * A summary is produced only when at least one anomaly was dropped (`applied: false`); a lossless
 * auto-repair — every anomaly `applied: true` — surfaces nothing to the user, since there is nothing
 * for them to act on. This is unrelated to the admin audit log, which records every anomaly
 * (dropped or not) separately via `anomalyAuditMetadata` on the raw anomaly list.
 *
 * Deliberately smaller than the audit record: it omits the long per-anomaly messages (the client
 * composes its own short line from `kind`), keeping the operation row lean while still naming the
 * affected paths so the user can act.
 */
export interface GitDriftSummary {
  /** How many changes in the pull hit drift. */
  readonly total: number;
  /** How many of those were dropped (content discarded, not landed) — the ones needing user recovery. */
  readonly droppedCount: number;
  /** The affected paths and how each was handled. */
  readonly anomalies: readonly GitDriftAnomaly[];
}

/** One drifted change in a {@link GitDriftSummary}. */
export interface GitDriftAnomaly {
  /** Workspace-relative POSIX path (no leading slash); the destination for a rename. */
  readonly path: string;
  /** The reconciler drift kind (mirrors the reconciler's anomaly kinds). */
  readonly kind: string;
  /** Whether the pulled content survived (`false` only for a dropped change). */
  readonly applied: boolean;
}

/**
 * Builds a {@link GitDriftSummary} from a list of reconciler anomalies, or `null` when none of them
 * was dropped — covering both the empty-list case and a purely benign auto-repair (every anomaly
 * `applied: true`), so a caller stores nothing, and the user sees nothing, on a lossless apply.
 * Accepts any anomaly shape carrying the three persisted fields, so the reconciler's richer
 * `GitReconcileAnomaly` passes through directly.
 *
 * When at least one anomaly WAS dropped, the summary is unchanged from before: `total` counts every
 * anomaly (benign and dropped alike), `droppedCount` counts only the drops, and `anomalies` lists
 * all of them faithfully — a mixed summary still reports the benign repairs alongside the drops.
 */
export function buildGitDriftSummary(
  anomalies: readonly GitDriftAnomaly[],
): GitDriftSummary | null {
  const droppedCount = anomalies.filter((anomaly) => !anomaly.applied).length;
  if (droppedCount === 0) return null;
  return {
    total: anomalies.length,
    droppedCount,
    anomalies: anomalies.map((anomaly) => ({
      path: anomaly.path,
      kind: anomaly.kind,
      applied: anomaly.applied,
    })),
  };
}
