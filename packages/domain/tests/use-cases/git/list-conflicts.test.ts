import { ListConflictsUseCase } from '../../../src/use-cases/git/list-conflicts';
import { NoConflictInProgressError } from '../../../src/errors/git/no-conflict-in-progress';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');

describe('ListConflictsUseCase', () => {
  test('returns the seeded conflict summaries with their resolved flags, under the awaiting operation id', async () => {
    const gitOperationRepo = new InMemoryGitOperationRepository();
    const enqueued = await gitOperationRepo.enqueue({ projectId: PROJECT_ID, kind: 'PULL', triggeredByUserId: ACTOR_ID });
    const claimed = await gitOperationRepo.claimNextQueued(30_000);
    await gitOperationRepo.transition(claimed!.id, 'AWAITING_CONFLICT');
    await gitOperationRepo.createConflict({ operationId: enqueued.id, path: 'chapters/intro.adoc', isBinary: false });
    await gitOperationRepo.createConflict({ operationId: enqueued.id, path: 'assets/logo.png', isBinary: true });
    await gitOperationRepo.resolveConflict(enqueued.id, 'chapters/intro.adoc', 'ours');
    const useCase = new ListConflictsUseCase(gitOperationRepo);

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result).toEqual({
      success: true,
      value: {
        operationId: enqueued.id,
        files: [
          { path: 'chapters/intro.adoc', isBinary: false, resolved: true },
          { path: 'assets/logo.png', isBinary: true, resolved: false },
        ],
      },
    });
  });

  test('no operation awaiting conflict refuses with NoConflictInProgressError', async () => {
    const gitOperationRepo = new InMemoryGitOperationRepository();
    const useCase = new ListConflictsUseCase(gitOperationRepo);

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(NoConflictInProgressError);
  });
});
