import { GetBehindAheadUseCase } from '../../../src/use-cases/git/get-behind-ahead';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440010');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REMOTE_URL = 'https://github.com/example/repo.git';
const CURRENT_BRANCH = 'feature/topic';

async function connectedRepo(): Promise<InMemoryGitRepositoryRepository> {
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  await gitRepositoryRepo.save(
    new GitRepository(
      GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099'),
      PROJECT_ID,
      GitProvider.create('github'),
      REMOTE_URL,
      PROJECT_ID.value,
      CURRENT_BRANCH,
    ),
  );
  return gitRepositoryRepo;
}

describe('GetBehindAheadUseCase', () => {
  test('a connected project returns the seeded behind/ahead counts', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    commandRunner.seedBehindAhead(PROJECT_ID, { behind: 3, ahead: 1 });

    const useCase = new GetBehindAheadUseCase(gitRepositoryRepo, commandRunner);

    const result = await useCase.execute({ projectId: PROJECT_ID, actorId: ACTOR_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({ behind: 3, ahead: 1 });
  });

  test('the branch passed to getBehindAhead is the row\'s currentBranch', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();

    const useCase = new GetBehindAheadUseCase(gitRepositoryRepo, commandRunner);
    await useCase.execute({ projectId: PROJECT_ID });

    expect(commandRunner.behindAheadCalls).toHaveLength(1);
    expect(commandRunner.behindAheadCalls[0]).toEqual({ projectId: PROJECT_ID, branch: CURRENT_BRANCH });
  });

  test('a project with no repository link is refused with RepositoryNotConnectedError, and getBehindAhead is never called', async () => {
    const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
    const commandRunner = new InMemoryGitCommandRunner();
    const useCase = new GetBehindAheadUseCase(gitRepositoryRepo, commandRunner);

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(commandRunner.behindAheadCalls).toHaveLength(0);
  });

  test('a runner failure propagates', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const failure = new GitCommandFailedError('branch has no remote-tracking ref yet');
    commandRunner.seedBehindAheadFailure(PROJECT_ID, failure);

    const useCase = new GetBehindAheadUseCase(gitRepositoryRepo, commandRunner);
    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result).toEqual({ success: false, error: failure });
  });
});
