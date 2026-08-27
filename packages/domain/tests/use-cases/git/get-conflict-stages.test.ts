import { GetConflictStagesUseCase } from '../../../src/use-cases/git/get-conflict-stages';
import { NoConflictInProgressError } from '../../../src/errors/git/no-conflict-in-progress';
import { GitConflictNotFoundError } from '../../../src/errors/git/git-conflict-not-found';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { GitOperationId } from '../../../src/value-objects/ids/git-operation-id';
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';
import { InMemoryConflictStageStore } from '../../ports/git/in-memory-conflict-stage-store';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const TEXT_PATH = 'chapters/intro.adoc';
const BINARY_PATH = 'assets/logo.png';

async function buildAwaitingOperation(gitOperationRepo: InMemoryGitOperationRepository): Promise<GitOperationId> {
  const enqueued = await gitOperationRepo.enqueue({ projectId: PROJECT_ID, kind: 'PULL', triggeredByUserId: ACTOR_ID });
  const claimed = await gitOperationRepo.claimNextQueued(30_000);
  await gitOperationRepo.transition(claimed!.id, 'AWAITING_CONFLICT');
  return enqueued.id;
}

describe('GetConflictStagesUseCase', () => {
  test('returns the seeded base/ours/theirs text for a non-binary conflict', async () => {
    const gitOperationRepo = new InMemoryGitOperationRepository();
    const conflictStageStore = new InMemoryConflictStageStore();
    const operationId = await buildAwaitingOperation(gitOperationRepo);
    conflictStageStore.seedStages(operationId, TEXT_PATH, {
      base: Buffer.from('base text', 'utf8'),
      ours: Buffer.from('our text', 'utf8'),
      theirs: Buffer.from('their text', 'utf8'),
      isBinary: false,
    });
    const useCase = new GetConflictStagesUseCase(gitOperationRepo, conflictStageStore);

    const result = await useCase.execute({ projectId: PROJECT_ID, path: TEXT_PATH });

    expect(result).toEqual({
      success: true,
      value: { base: 'base text', ours: 'our text', theirs: 'their text', isBinary: false },
    });
  });

  test('maps a null base (add/add conflict) to null, not an empty string', async () => {
    const gitOperationRepo = new InMemoryGitOperationRepository();
    const conflictStageStore = new InMemoryConflictStageStore();
    const operationId = await buildAwaitingOperation(gitOperationRepo);
    conflictStageStore.seedStages(operationId, TEXT_PATH, {
      base: null,
      ours: Buffer.from('our text', 'utf8'),
      theirs: Buffer.from('their text', 'utf8'),
      isBinary: false,
    });
    const useCase = new GetConflictStagesUseCase(gitOperationRepo, conflictStageStore);

    const result = await useCase.execute({ projectId: PROJECT_ID, path: TEXT_PATH });

    expect(result.success).toBe(true);
    expect(result.success && result.value.base).toBeNull();
  });

  test('maps a deleted "ours" side (modify/delete conflict) to null, distinct from a binary empty string', async () => {
    const gitOperationRepo = new InMemoryGitOperationRepository();
    const conflictStageStore = new InMemoryConflictStageStore();
    const operationId = await buildAwaitingOperation(gitOperationRepo);
    conflictStageStore.seedStages(operationId, TEXT_PATH, {
      base: Buffer.from('base text', 'utf8'),
      ours: null,
      theirs: Buffer.from('their text', 'utf8'),
      isBinary: false,
    });
    const useCase = new GetConflictStagesUseCase(gitOperationRepo, conflictStageStore);

    const result = await useCase.execute({ projectId: PROJECT_ID, path: TEXT_PATH });

    expect(result).toEqual({
      success: true,
      value: { base: 'base text', ours: null, theirs: 'their text', isBinary: false },
    });
  });

  test('a binary conflict maps to empty content and isBinary:true', async () => {
    const gitOperationRepo = new InMemoryGitOperationRepository();
    const conflictStageStore = new InMemoryConflictStageStore();
    const operationId = await buildAwaitingOperation(gitOperationRepo);
    conflictStageStore.seedStages(operationId, BINARY_PATH, {
      base: Buffer.from([0x00, 0x01]),
      ours: Buffer.from([0x02, 0x03]),
      theirs: Buffer.from([0x04, 0x05]),
      isBinary: true,
    });
    const useCase = new GetConflictStagesUseCase(gitOperationRepo, conflictStageStore);

    const result = await useCase.execute({ projectId: PROJECT_ID, path: BINARY_PATH });

    expect(result).toEqual({
      success: true,
      value: { base: null, ours: '', theirs: '', isBinary: true },
    });
  });

  test('no operation awaiting conflict refuses with NoConflictInProgressError', async () => {
    const gitOperationRepo = new InMemoryGitOperationRepository();
    const conflictStageStore = new InMemoryConflictStageStore();
    const useCase = new GetConflictStagesUseCase(gitOperationRepo, conflictStageStore);

    const result = await useCase.execute({ projectId: PROJECT_ID, path: TEXT_PATH });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(NoConflictInProgressError);
  });

  test('a path with no captured stages refuses with GitConflictNotFoundError', async () => {
    const gitOperationRepo = new InMemoryGitOperationRepository();
    const conflictStageStore = new InMemoryConflictStageStore();
    await buildAwaitingOperation(gitOperationRepo);
    const useCase = new GetConflictStagesUseCase(gitOperationRepo, conflictStageStore);

    const result = await useCase.execute({ projectId: PROJECT_ID, path: 'no/such/file.adoc' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitConflictNotFoundError);
  });
});
