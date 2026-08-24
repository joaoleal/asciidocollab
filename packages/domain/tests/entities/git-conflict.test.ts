import { GitConflict } from '../../src/entities/git-conflict';
import { GitConflictId } from '../../src/value-objects/ids/git-conflict-id';
import { GitOperationId } from '../../src/value-objects/ids/git-operation-id';

describe('GitConflict entity', () => {
  const conflictId = GitConflictId.create('550e8400-e29b-41d4-a716-446655440040');
  const operationId = GitOperationId.create('550e8400-e29b-41d4-a716-446655440041');

  test('creates with all fields', () => {
    const created = new Date('2026-05-26T12:00:00Z');

    const conflict = new GitConflict(conflictId, operationId, 'docs/intro.adoc', true, true, 'theirs', created);

    expect(conflict.id).toBe(conflictId);
    expect(conflict.operationId).toBe(operationId);
    expect(conflict.path).toBe('docs/intro.adoc');
    expect(conflict.isBinary).toBe(true);
    expect(conflict.resolved).toBe(true);
    expect(conflict.resolution).toBe('theirs');
    expect(conflict.createdAt).toBe(created);
  });

  test('defaults isBinary, resolved, resolution, and createdAt for a freshly recorded conflict', () => {
    const conflict = new GitConflict(conflictId, operationId, 'docs/intro.adoc');

    expect(conflict.isBinary).toBe(false);
    expect(conflict.resolved).toBe(false);
    expect(conflict.resolution).toBeNull();
    expect(conflict.createdAt).toBeInstanceOf(Date);
  });

  test.each(['ours', 'theirs', 'merged'] as const)('accepts %s as a resolution', (resolution) => {
    const conflict = new GitConflict(conflictId, operationId, 'docs/intro.adoc', false, true, resolution);
    expect(conflict.resolution).toBe(resolution);
  });
});
