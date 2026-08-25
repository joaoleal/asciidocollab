import { randomUUID } from 'crypto';
import { GitOperation, GitOperationId, ProjectId, UserId } from '@asciidocollab/domain';
import {
  dispatchGitOperation,
  UNHANDLED_GIT_OPERATION_KIND_ERROR_CODE,
  type GitOperationHandlerRegistry,
} from '../../src/dispatch/git-operation-dispatcher.js';

const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');

function buildOperation(kind: GitOperation['kind']): GitOperation {
  return new GitOperation(GitOperationId.create(randomUUID()), ProjectId.create(randomUUID()), kind, 'RUNNING', ACTOR_ID, null);
}

describe('dispatchGitOperation routing for INITIALIZE', () => {
  test('an INITIALIZE operation routes to its registered handler', async () => {
    const initializeHandler = jest.fn().mockResolvedValue({ kind: 'succeeded' });
    const registry: GitOperationHandlerRegistry = { INITIALIZE: initializeHandler };
    const operation = buildOperation('INITIALIZE');

    const outcome = await dispatchGitOperation(operation, registry);

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(initializeHandler).toHaveBeenCalledWith(operation);
  });

  test('an INITIALIZE operation with no registered handler fails as unhandled, rather than falling through to another kind\'s handler', async () => {
    const importHandler = jest.fn().mockResolvedValue({ kind: 'succeeded' });
    const registry: GitOperationHandlerRegistry = { IMPORT: importHandler };
    const operation = buildOperation('INITIALIZE');

    const outcome = await dispatchGitOperation(operation, registry);

    expect(outcome).toEqual({ kind: 'failed', errorCode: UNHANDLED_GIT_OPERATION_KIND_ERROR_CODE });
    expect(importHandler).not.toHaveBeenCalled();
  });
});
