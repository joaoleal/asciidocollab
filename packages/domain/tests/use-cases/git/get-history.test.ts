import { GetHistoryUseCase } from '../../../src/use-cases/git/get-history';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { GitLogEntry } from '../../../src/ports/git/git-command-runner';
import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { User } from '../../../src/entities/user';
import { Email } from '../../../src/value-objects/identity/email';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryUserRepository } from '../../ports/user/in-memory-user.repository';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440010');
const REMOTE_URL = 'https://github.com/example/repo.git';

async function connectedRepo(): Promise<InMemoryGitRepositoryRepository> {
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  await gitRepositoryRepo.save(
    new GitRepository(
      GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099'),
      PROJECT_ID,
      GitProvider.create('github'),
      REMOTE_URL,
      PROJECT_ID.value,
    ),
  );
  return gitRepositoryRepo;
}

function entry(overrides: Partial<GitLogEntry> = {}): GitLogEntry {
  return {
    hash: '0'.repeat(40),
    message: 'a commit',
    authorEmail: 'author@example.com',
    authoredAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('GetHistoryUseCase', () => {
  test('a connected project returns the runner\'s newest-first commits in the same order', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();

    const entries: GitLogEntry[] = [
      entry({ hash: 'c3', message: 'third', authoredAt: new Date('2026-01-03T00:00:00.000Z') }),
      entry({ hash: 'c2', message: 'second', authoredAt: new Date('2026-01-02T00:00:00.000Z') }),
      entry({ hash: 'c1', message: 'first', authoredAt: new Date('2026-01-01T00:00:00.000Z') }),
    ];
    commandRunner.seedLog(PROJECT_ID, entries);

    const useCase = new GetHistoryUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.commits.map((c) => c.hash)).toEqual(['c3', 'c2', 'c1']);
    expect(result.value.commits.map((c) => c.message)).toEqual(['third', 'second', 'first']);
    expect(result.value.commits.map((c) => c.authoredAt)).toEqual([
      new Date('2026-01-03T00:00:00.000Z'),
      new Date('2026-01-02T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
    ]);
  });

  test('a requested path is passed straight through to the runner\'s log call', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();

    const useCase = new GetHistoryUseCase(gitRepositoryRepo, commandRunner, userRepo);
    await useCase.execute({ projectId: PROJECT_ID, path: 'chapters/intro.adoc' });

    expect(commandRunner.logCalls).toHaveLength(1);
    expect(commandRunner.logCalls[0]).toEqual({
      projectId: PROJECT_ID,
      options: { path: 'chapters/intro.adoc', limit: undefined },
    });
  });

  test('a requested limit is passed straight through to the runner\'s log call', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();

    const useCase = new GetHistoryUseCase(gitRepositoryRepo, commandRunner, userRepo);
    await useCase.execute({ projectId: PROJECT_ID, limit: 20 });

    expect(commandRunner.logCalls).toHaveLength(1);
    expect(commandRunner.logCalls[0]).toEqual({
      projectId: PROJECT_ID,
      options: { path: undefined, limit: 20 },
    });
  });

  test('a commit whose author email maps to a platform user carries that user\'s id', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();

    const authorId = UserId.create('550e8400-e29b-41d4-a716-446655440002');
    await userRepo.save(
      new User(authorId, Email.create('mapped@example.com'), 'Mapped Author', 'hash', [], null, null),
    );

    commandRunner.seedLog(PROJECT_ID, [entry({ hash: 'c1', authorEmail: 'mapped@example.com' })]);

    const useCase = new GetHistoryUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.commits[0].authorUserId).toEqual(authorId);
  });

  test('a commit whose author email maps to nobody has no authorUserId', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();

    commandRunner.seedLog(PROJECT_ID, [entry({ hash: 'c1', authorEmail: 'unmapped@example.com' })]);

    const useCase = new GetHistoryUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.commits[0].authorUserId).toBeUndefined();
  });

  test('two commits sharing the same author email resolve the user once and share the id', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();
    const findByEmailSpy = jest.spyOn(userRepo, 'findByEmail');

    const authorId = UserId.create('550e8400-e29b-41d4-a716-446655440003');
    await userRepo.save(
      new User(authorId, Email.create('repeat@example.com'), 'Repeat Author', 'hash', [], null, null),
    );

    commandRunner.seedLog(PROJECT_ID, [
      entry({ hash: 'c2', authorEmail: 'repeat@example.com' }),
      entry({ hash: 'c1', authorEmail: 'repeat@example.com' }),
    ]);

    const useCase = new GetHistoryUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(findByEmailSpy).toHaveBeenCalledTimes(1);
    expect(result.value.commits[0].authorUserId).toEqual(authorId);
    expect(result.value.commits[1].authorUserId).toEqual(authorId);
  });

  test('a malformed author email leaves that commit unmapped without failing the rest of the history', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();

    commandRunner.seedLog(PROJECT_ID, [
      entry({ hash: 'bad', authorEmail: 'not-an-email' }),
      entry({ hash: 'good', authorEmail: 'unmapped@example.com' }),
    ]);

    const useCase = new GetHistoryUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.commits).toHaveLength(2);
    expect(result.value.commits[0].authorUserId).toBeUndefined();
    expect(result.value.commits[1].authorUserId).toBeUndefined();
  });

  test('a project with no repository link is refused with RepositoryNotConnectedError, and log is never called', async () => {
    const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();
    const useCase = new GetHistoryUseCase(gitRepositoryRepo, commandRunner, userRepo);

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(commandRunner.logCalls).toHaveLength(0);
  });

  test('a runner failure propagates unchanged', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();
    const failure = new GitCommandFailedError('working tree is not initialized');
    commandRunner.seedLogFailure(PROJECT_ID, failure);

    const useCase = new GetHistoryUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result).toEqual({ success: false, error: failure });
  });
});
