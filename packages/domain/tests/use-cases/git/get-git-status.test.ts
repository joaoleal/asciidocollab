import { GetGitStatusUseCase } from '../../../src/use-cases/git/get-git-status';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440010');

describe('GetGitStatusUseCase', () => {
  test('a connected project with a mix of changes returns branch, classified changes, and repo sync metadata', async () => {
    const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
    const lastSyncAt = new Date('2026-01-01T00:00:00.000Z');
    await gitRepositoryRepo.save(
      new GitRepository(
        GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099'),
        PROJECT_ID,
        GitProvider.create('github'),
        'https://github.com/example/repo.git',
        PROJECT_ID.value,
        'main',
        'BEHIND',
        'main',
        'abc123',
        lastSyncAt,
      ),
    );

    const commandRunner = new InMemoryGitCommandRunner();
    commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [
        { path: 'docs/intro.adoc', changeType: 'modified', state: 'staged' },
        { path: 'docs/chapter1.adoc', changeType: 'modified', state: 'unstaged' },
        { path: 'docs/new-file.adoc', changeType: 'added', state: 'untracked' },
        { path: 'docs/renamed.adoc', changeType: 'renamed', state: 'staged' },
      ],
    });

    const useCase = new GetGitStatusUseCase(gitRepositoryRepo, commandRunner);

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.value.currentBranch).toBe('main');
    expect(result.value.changes).toEqual([
      { path: 'docs/intro.adoc', changeType: 'modified', state: 'staged' },
      { path: 'docs/chapter1.adoc', changeType: 'modified', state: 'unstaged' },
      { path: 'docs/new-file.adoc', changeType: 'added', state: 'untracked' },
      { path: 'docs/renamed.adoc', changeType: 'renamed', state: 'staged' },
    ]);
    expect(result.value.syncStatus).toBe('BEHIND');
    expect(result.value.lastSyncAt).toEqual(lastSyncAt);
    expect(result.value.lastKnownRemoteHead).toBe('abc123');
    expect(result.value.defaultBranch).toBe('main');
  });

  test('a project with no repository link is refused with RepositoryNotConnectedError, and getStatus is never called', async () => {
    const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
    const commandRunner = new InMemoryGitCommandRunner();
    const useCase = new GetGitStatusUseCase(gitRepositoryRepo, commandRunner);

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(commandRunner.statusCalls).toHaveLength(0);
  });

  test('a working-tree read failure propagates the GitCommandFailedError', async () => {
    const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
    await gitRepositoryRepo.save(
      new GitRepository(
        GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099'),
        PROJECT_ID,
        GitProvider.create('github'),
        'https://github.com/example/repo.git',
        PROJECT_ID.value,
      ),
    );

    const commandRunner = new InMemoryGitCommandRunner();
    const failure = new GitCommandFailedError('working tree is not initialized');
    commandRunner.seedStatusFailure(PROJECT_ID, failure);

    const useCase = new GetGitStatusUseCase(gitRepositoryRepo, commandRunner);

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result).toEqual({ success: false, error: failure });
  });
});
