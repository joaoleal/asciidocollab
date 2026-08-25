import { GetBranchesUseCase } from '../../../src/use-cases/git/get-branches';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440022');

describe('GetBranchesUseCase', () => {
  test('a connected project returns the current branch and every local branch name', async () => {
    const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
    await gitRepositoryRepo.save(
      new GitRepository(
        GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440097'),
        PROJECT_ID,
        GitProvider.create('github'),
        'https://github.com/example/repo.git',
        PROJECT_ID.value,
      ),
    );

    const commandRunner = new InMemoryGitCommandRunner();
    commandRunner.seedBranches(PROJECT_ID, {
      current: 'main',
      branches: ['main', 'feature/new-chapter'],
    });

    const useCase = new GetBranchesUseCase(gitRepositoryRepo, commandRunner);

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result).toEqual({
      success: true,
      value: { current: 'main', branches: ['main', 'feature/new-chapter'] },
    });
  });

  test('a project with no repository link is refused with RepositoryNotConnectedError, and listBranches is never called', async () => {
    const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
    const commandRunner = new InMemoryGitCommandRunner();
    const useCase = new GetBranchesUseCase(gitRepositoryRepo, commandRunner);

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(commandRunner.listBranchesCalls).toHaveLength(0);
  });

  test('a branch-list read failure propagates the GitCommandFailedError', async () => {
    const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
    await gitRepositoryRepo.save(
      new GitRepository(
        GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440097'),
        PROJECT_ID,
        GitProvider.create('github'),
        'https://github.com/example/repo.git',
        PROJECT_ID.value,
      ),
    );

    const commandRunner = new InMemoryGitCommandRunner();
    const failure = new GitCommandFailedError('working tree is not initialized');
    commandRunner.seedBranchesFailure(PROJECT_ID, failure);

    const useCase = new GetBranchesUseCase(gitRepositoryRepo, commandRunner);

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result).toEqual({ success: false, error: failure });
  });
});
