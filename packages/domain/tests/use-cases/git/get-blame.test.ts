import { GetBlameUseCase } from '../../../src/use-cases/git/get-blame';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { GitBlameLine } from '../../../src/ports/git/git-command-runner';
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
const FILE_PATH = 'chapters/intro.adoc';

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

function line(overrides: Partial<GitBlameLine> = {}): GitBlameLine {
  return {
    lineNumber: 1,
    hash: '0'.repeat(40),
    message: 'A commit subject',
    authorEmail: 'author@example.com',
    authoredAt: new Date('2026-01-01T00:00:00.000Z'),
    content: 'Some line of text.',
    ...overrides,
  };
}

describe('GetBlameUseCase', () => {
  test('a connected project returns the runner\'s lines in file order', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();

    const lines: GitBlameLine[] = [
      line({ lineNumber: 1, hash: 'c1', message: 'Add the title', content: '= Title' }),
      line({ lineNumber: 2, hash: 'c2', message: 'Blank line', content: '' }),
      line({ lineNumber: 3, hash: 'c3', message: 'Write the intro', content: 'Some prose.' }),
    ];
    commandRunner.seedBlame(PROJECT_ID, lines);

    const useCase = new GetBlameUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID, path: FILE_PATH });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.lines.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
    expect(result.value.lines.map((l) => l.hash)).toEqual(['c1', 'c2', 'c3']);
    expect(result.value.lines.map((l) => l.message)).toEqual(['Add the title', 'Blank line', 'Write the intro']);
    expect(result.value.lines.map((l) => l.content)).toEqual(['= Title', '', 'Some prose.']);
    expect(result.value.lines.map((l) => l.authoredAt)).toEqual([
      line().authoredAt,
      line().authoredAt,
      line().authoredAt,
    ]);
  });

  test('the requested path and ref are passed straight through to the runner\'s blame call', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();

    const useCase = new GetBlameUseCase(gitRepositoryRepo, commandRunner, userRepo);
    await useCase.execute({ projectId: PROJECT_ID, path: FILE_PATH, ref: 'c0ffee' });

    expect(commandRunner.blameCalls).toHaveLength(1);
    expect(commandRunner.blameCalls[0]).toEqual({
      projectId: PROJECT_ID,
      input: { path: FILE_PATH, ref: 'c0ffee' },
    });
  });

  test('a line whose author email maps to a platform user carries that user\'s id', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();

    const authorId = UserId.create('550e8400-e29b-41d4-a716-446655440002');
    await userRepo.save(
      new User(authorId, Email.create('mapped@example.com'), 'Mapped Author', 'hash', [], null, null),
    );

    commandRunner.seedBlame(PROJECT_ID, [line({ authorEmail: 'mapped@example.com' })]);

    const useCase = new GetBlameUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID, path: FILE_PATH });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.lines[0].authorUserId).toEqual(authorId);
  });

  test('a line whose author email maps to nobody has no authorUserId', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();

    commandRunner.seedBlame(PROJECT_ID, [line({ authorEmail: 'unmapped@example.com' })]);

    const useCase = new GetBlameUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID, path: FILE_PATH });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.lines[0].authorUserId).toBeUndefined();
  });

  test('two lines sharing the same author email resolve the user once and share the id', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();
    const findByEmailSpy = jest.spyOn(userRepo, 'findByEmail');

    const authorId = UserId.create('550e8400-e29b-41d4-a716-446655440003');
    await userRepo.save(
      new User(authorId, Email.create('repeat@example.com'), 'Repeat Author', 'hash', [], null, null),
    );

    commandRunner.seedBlame(PROJECT_ID, [
      line({ lineNumber: 1, hash: 'c1', authorEmail: 'repeat@example.com' }),
      line({ lineNumber: 2, hash: 'c2', authorEmail: 'repeat@example.com' }),
    ]);

    const useCase = new GetBlameUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID, path: FILE_PATH });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(findByEmailSpy).toHaveBeenCalledTimes(1);
    expect(result.value.lines[0].authorUserId).toEqual(authorId);
    expect(result.value.lines[1].authorUserId).toEqual(authorId);
  });

  test('a malformed author email leaves that line unmapped without failing the rest of the blame', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();

    commandRunner.seedBlame(PROJECT_ID, [
      line({ lineNumber: 1, hash: 'bad', authorEmail: 'not-an-email' }),
      line({ lineNumber: 2, hash: 'good', authorEmail: 'unmapped@example.com' }),
    ]);

    const useCase = new GetBlameUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID, path: FILE_PATH });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.lines).toHaveLength(2);
    expect(result.value.lines[0].authorUserId).toBeUndefined();
    expect(result.value.lines[1].authorUserId).toBeUndefined();
  });

  test('a project with no repository link is refused with RepositoryNotConnectedError, and blame is never called', async () => {
    const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();
    const useCase = new GetBlameUseCase(gitRepositoryRepo, commandRunner, userRepo);

    const result = await useCase.execute({ projectId: PROJECT_ID, path: FILE_PATH });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(commandRunner.blameCalls).toHaveLength(0);
  });

  test('a runner failure propagates unchanged', async () => {
    const gitRepositoryRepo = await connectedRepo();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();
    const failure = new GitCommandFailedError('working tree is not initialized');
    commandRunner.seedBlameFailure(PROJECT_ID, failure);

    const useCase = new GetBlameUseCase(gitRepositoryRepo, commandRunner, userRepo);
    const result = await useCase.execute({ projectId: PROJECT_ID, path: FILE_PATH });

    expect(result).toEqual({ success: false, error: failure });
  });
});
