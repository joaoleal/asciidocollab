import type { GitOperation, GitDriftSummary } from '@asciidocollab/domain';
import type { GitOperationStatusDto, GitDriftSummaryDto } from '@asciidocollab/shared';

/** Maps a domain drift summary to its wire DTO, preserving null. */
function toGitDriftSummaryDto(summary: GitDriftSummary | null): GitDriftSummaryDto | null {
  if (summary === null) return null;
  return {
    total: summary.total,
    droppedCount: summary.droppedCount,
    anomalies: summary.anomalies.map((anomaly) => ({
      path: anomaly.path,
      kind: anomaly.kind,
      applied: anomaly.applied,
    })),
  };
}

/**
 * Maps a `GitOperation` entity to the progress/status DTO a client polls. Carries only non-sensitive
 * progress fields; the single source of this mapping so the active-operation and operation-status
 * routes never drift apart.
 */
export function toGitOperationStatusDto(operation: GitOperation): GitOperationStatusDto {
  return {
    id: operation.id.value,
    kind: operation.kind,
    state: operation.state,
    progress: operation.progress,
    errorCode: operation.errorCode,
    driftSummary: toGitDriftSummaryDto(operation.driftSummary),
  };
}
