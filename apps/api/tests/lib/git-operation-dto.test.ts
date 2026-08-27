import { GitOperation, GitOperationId, ProjectId, UserId } from '@asciidocollab/domain';
import type { GitDriftSummary } from '@asciidocollab/domain';
import { toGitOperationStatusDto } from '../../src/lib/git-operation-dto';

function operation(driftSummary: GitDriftSummary | null): GitOperation {
  return new GitOperation(
    GitOperationId.create('9c565c51-8f22-4a43-957a-ce070aa0d8da'),
    ProjectId.create('691187ad-44cb-46ff-a0cb-4b4cc7afb177'),
    'PULL',
    'SUCCEEDED',
    UserId.create('100057d5-22e7-4662-ad56-ae3c58f77e45'),
    'main',
    100,
    null,
    null,
    null,
    null,
    new Date(),
    driftSummary,
  );
}

describe('toGitOperationStatusDto', () => {
  it('maps a null drift summary to null', () => {
    expect(toGitOperationStatusDto(operation(null)).driftSummary).toBeNull();
  });

  it('maps a drift summary field-for-field', () => {
    const dto = toGitOperationStatusDto(
      operation({
        total: 2,
        droppedCount: 1,
        anomalies: [
          { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false },
          { path: 'ghost.adoc', kind: 'modified_missing_node', applied: true },
        ],
      }),
    );

    expect(dto.driftSummary).toEqual({
      total: 2,
      droppedCount: 1,
      anomalies: [
        { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false },
        { path: 'ghost.adoc', kind: 'modified_missing_node', applied: true },
      ],
    });
  });
});
