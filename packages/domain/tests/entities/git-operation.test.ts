import { GitOperation } from '../../src/entities/git-operation';
import { GitOperationId } from '../../src/value-objects/ids/git-operation-id';
import { ProjectId } from '../../src/value-objects/ids/project-id';
import { UserId } from '../../src/value-objects/ids/user-id';
import { GitOperationState } from '../../src/types/git-operation-state';

describe('GitOperation entity', () => {
  const operationId = GitOperationId.create('550e8400-e29b-41d4-a716-446655440030');
  const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440031');
  const userId = UserId.create('550e8400-e29b-41d4-a716-446655440032');

  test('creates with all fields', () => {
    const heartbeat = new Date('2026-05-26T12:00:00Z');
    const started = new Date('2026-05-26T11:59:00Z');
    const finished = new Date('2026-05-26T12:05:00Z');
    const created = new Date('2026-05-26T11:58:00Z');

    const operation = new GitOperation(
      operationId,
      projectId,
      'PUSH',
      'SUCCEEDED',
      userId,
      'main',
      100,
      heartbeat,
      null,
      started,
      finished,
      created,
    );

    expect(operation.id).toBe(operationId);
    expect(operation.projectId).toBe(projectId);
    expect(operation.kind).toBe('PUSH');
    expect(operation.state).toBe('SUCCEEDED');
    expect(operation.triggeredByUserId).toBe(userId);
    expect(operation.branch).toBe('main');
    expect(operation.progress).toBe(100);
    expect(operation.heartbeatAt).toBe(heartbeat);
    expect(operation.errorCode).toBeNull();
    expect(operation.startedAt).toBe(started);
    expect(operation.finishedAt).toBe(finished);
    expect(operation.createdAt).toBe(created);
  });

  test('defaults branch, progress, heartbeat, error, timestamps, and createdAt', () => {
    const operation = new GitOperation(operationId, projectId, 'COMMIT', 'QUEUED', userId);

    expect(operation.branch).toBeNull();
    expect(operation.progress).toBe(0);
    expect(operation.heartbeatAt).toBeNull();
    expect(operation.errorCode).toBeNull();
    expect(operation.startedAt).toBeNull();
    expect(operation.finishedAt).toBeNull();
    expect(operation.createdAt).toBeInstanceOf(Date);
  });

  test('records a typed error code on a failed operation', () => {
    const operation = new GitOperation(operationId, projectId, 'PULL', 'FAILED', userId, null, 40, null, 'merge_conflict');

    expect(operation.state).toBe('FAILED');
    expect(operation.errorCode).toBe('merge_conflict');
  });

  describe('isActive', () => {
    const activeStates: GitOperationState[] = ['QUEUED', 'RUNNING', 'AWAITING_CONFLICT'];
    const terminalStates: GitOperationState[] = ['SUCCEEDED', 'FAILED', 'ABORTED'];

    test.each(activeStates)('is true for %s', (state) => {
      const operation = new GitOperation(operationId, projectId, 'PUSH', state, userId);
      expect(operation.isActive).toBe(true);
    });

    test.each(terminalStates)('is false for %s', (state) => {
      const operation = new GitOperation(operationId, projectId, 'PUSH', state, userId);
      expect(operation.isActive).toBe(false);
    });
  });
});
