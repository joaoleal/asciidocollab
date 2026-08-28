import { InitializeRepositoryUseCase } from '../../../src/use-cases/git/initialize-repository';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { ValidationError } from '../../../src/errors/common/validation-error';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../../src/errors/git/authentication-failed';
import { RemoteAlreadyInitializedError } from '../../../src/errors/git/remote-already-initialized';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { ProjectMember } from '../../../src/entities/project-member';
import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Role } from '../../../src/value-objects/identity/role';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';
import { GitOperationInProgressError } from '../../../src/errors/git/git-operation-in-progress';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440010');
const OWNER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440011');
const PLACEHOLDER_REPOSITORY_ID = GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440012');
const REMOTE_URL = 'https://github.com/example/existing-project.git';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
const HEAD_COMMIT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

async function memberRepoWithRole(role: string | null): Promise<InMemoryProjectMemberRepository> {
  const repo = new InMemoryProjectMemberRepository();
  if (role) {
    await repo.addMember(new ProjectMember(PROJECT_ID, OWNER_ID, Role.create(role)));
  }
  return repo;
}

interface Harness {
  useCase: InitializeRepositoryUseCase;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  commandRunner: InMemoryGitCommandRunner;
  gitOperationRepo: InMemoryGitOperationRepository;
  auditRepo: InMemoryAuditLogRepository;
  memberRepo: InMemoryProjectMemberRepository;
}

async function buildHarness(role: string | null = 'owner'): Promise<Harness> {
  const memberRepo = await memberRepoWithRole(role);
  const auditRepo = new InMemoryAuditLogRepository();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const gitOperationRepo = new InMemoryGitOperationRepository();

  const useCase = new InitializeRepositoryUseCase(
    gitRepositoryRepo,
    commandRunner,
    gitOperationRepo,
    memberRepo,
    auditRepo,
  );

  return { useCase, gitRepositoryRepo, commandRunner, gitOperationRepo, auditRepo, memberRepo };
}

/**
 * Seeds the placeholder `GitRepository` row a route pre-creates (synchronously, before ever
 * enqueuing the operation) so a worker turn later has somewhere to read `remoteUrl`/`provider`
 * from and something to write back — exactly the shape `ImportRepositoryUseCase`'s pre-created
 * `Project`/`GitRepository` rows take, except initialize's placeholder starts `DISCONNECTED`
 * rather than mid-clone.
 */
async function seedPlaceholderRepository(gitRepositoryRepo: InMemoryGitRepositoryRepository): Promise<GitRepository> {
  const placeholder = new GitRepository(
    PLACEHOLDER_REPOSITORY_ID,
    PROJECT_ID,
    GitProvider.create('github'),
    REMOTE_URL,
    PROJECT_ID.value,
    'main',
    'DISCONNECTED',
    null,
    null,
    null,
    new Date('2024-01-01T00:00:00.000Z'),
    OWNER_ID,
  );
  await gitRepositoryRepo.save(placeholder);
  return placeholder;
}

function seedSuccess(commandRunner: InMemoryGitCommandRunner): void {
  commandRunner.seedInitializeAndPublish(PROJECT_ID, {
    headCommit: HEAD_COMMIT,
    defaultBranch: 'main',
  });
}

describe('InitializeRepositoryUseCase', () => {
  test('an OWNER initializes an existing project onto an empty remote: the pre-created link is updated in place', async () => {
    const harness = await buildHarness('owner');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);
    seedSuccess(harness.commandRunner);

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const repository = result.value.repository;
    // Same row, updated — never a second one minted for this project.
    expect(repository.id).toEqual(PLACEHOLDER_REPOSITORY_ID);
    expect(repository.projectId).toBe(PROJECT_ID);
    expect(repository.provider.value).toBe('github');
    expect(repository.remoteUrl).toBe(REMOTE_URL);
    expect(repository.syncStatus).toBe('UP_TO_DATE');
    expect(repository.currentBranch).toBe('main');
    expect(repository.defaultBranch).toBe('main');
    expect(repository.lastKnownRemoteHead).toBe(HEAD_COMMIT);
    expect(repository.connectedByUserId).toEqual(OWNER_ID);

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved).not.toBeNull();
    expect(saved!.id).toEqual(PLACEHOLDER_REPOSITORY_ID);
    expect(saved!.syncStatus).toBe('UP_TO_DATE');
    expect(saved!.lastKnownRemoteHead).toBe(HEAD_COMMIT);

    // No second row was ever inserted for the project — `findByProjectId`'s 1:1 contract already
    // guarantees at most one, but this pins the specific id it must be.
    expect((await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID))!.id).toEqual(PLACEHOLDER_REPOSITORY_ID);
  });

  test('calls the adapter with the exact remote URL, token, and branch', async () => {
    const harness = await buildHarness('owner');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);
    seedSuccess(harness.commandRunner);

    await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
      branch: 'trunk',
    });

    expect(harness.commandRunner.initializeAndPublishCalls).toHaveLength(1);
    expect(harness.commandRunner.initializeAndPublishCalls[0].projectId).toBe(PROJECT_ID);
    expect(harness.commandRunner.initializeAndPublishCalls[0].input).toEqual({
      remoteUrl: REMOTE_URL,
      token: TOKEN,
      branch: 'trunk',
    });
  });

  test('a non-OWNER (editor) is denied with InsufficientRoleError, audited, and nothing is called or updated', async () => {
    const harness = await buildHarness('editor');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(InsufficientRoleError);

    expect(harness.commandRunner.initializeAndPublishCalls).toHaveLength(0);
    const untouched = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(untouched!.syncStatus).toBe('DISCONNECTED');

    const entries = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(entries.some((entry) => entry.action === 'authz.denied')).toBe(true);
  });

  test('a non-OWNER (viewer) is denied with InsufficientRoleError', async () => {
    const harness = await buildHarness('viewer');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.initializeAndPublishCalls).toHaveLength(0);
  });

  test('a non-member is denied with InsufficientRoleError', async () => {
    const harness = await buildHarness(null);
    await seedPlaceholderRepository(harness.gitRepositoryRepo);

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.initializeAndPublishCalls).toHaveLength(0);
  });

  test('an invalid provider is rejected with ValidationError before the adapter is called', async () => {
    const harness = await buildHarness('owner');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'not-a-real-provider',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
    expect(harness.commandRunner.initializeAndPublishCalls).toHaveLength(0);
  });

  test('a malformed remote URL is rejected with ValidationError before the adapter is called', async () => {
    const harness = await buildHarness('owner');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: 'not a url; rm -rf /',
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
    expect(harness.commandRunner.initializeAndPublishCalls).toHaveLength(0);
  });

  test('a claimed operation with no pre-created repository link surfaces GitCommandFailedError, and the adapter is never called', async () => {
    const harness = await buildHarness('owner');
    // No placeholder row seeded — mirrors a route/enqueue bug, not a user-facing refusal.

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(harness.commandRunner.initializeAndPublishCalls).toHaveLength(0);
    expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
  });

  test('a remote that already has commits surfaces RemoteAlreadyInitializedError, and the placeholder row is left untouched', async () => {
    const harness = await buildHarness('owner');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);
    harness.commandRunner.seedInitializeAndPublishFailure(PROJECT_ID, new RemoteAlreadyInitializedError());

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RemoteAlreadyInitializedError);

    const untouched = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(untouched!.id).toEqual(PLACEHOLDER_REPOSITORY_ID);
    expect(untouched!.syncStatus).toBe('DISCONNECTED');

    const entries = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(entries.some((entry) => entry.action === 'git.repository_connected')).toBe(false);
  });

  test('a remote that cannot be reached surfaces RepositoryUnreachableError, and the placeholder row is left untouched', async () => {
    const harness = await buildHarness('owner');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);
    harness.commandRunner.seedInitializeAndPublishFailure(PROJECT_ID, new RepositoryUnreachableError());

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryUnreachableError);

    const untouched = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(untouched!.id).toEqual(PLACEHOLDER_REPOSITORY_ID);
    expect(untouched!.syncStatus).toBe('DISCONNECTED');
  });

  test('a rejected token surfaces AuthenticationFailedError, and the placeholder row is left untouched', async () => {
    const harness = await buildHarness('owner');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);
    harness.commandRunner.seedInitializeAndPublishFailure(PROJECT_ID, new AuthenticationFailedError());

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(AuthenticationFailedError);

    const untouched = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(untouched!.id).toEqual(PLACEHOLDER_REPOSITORY_ID);
    expect(untouched!.syncStatus).toBe('DISCONNECTED');
  });

  test('any other git command failure surfaces GitCommandFailedError, and the placeholder row is left untouched', async () => {
    const harness = await buildHarness('owner');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);
    harness.commandRunner.seedInitializeAndPublishFailure(PROJECT_ID, new GitCommandFailedError('push failed'));

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);

    const untouched = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(untouched!.id).toEqual(PLACEHOLDER_REPOSITORY_ID);
    expect(untouched!.syncStatus).toBe('DISCONNECTED');
  });

  test('records a successful publish in the audit trail', async () => {
    const harness = await buildHarness('owner');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);
    seedSuccess(harness.commandRunner);

    await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    const entries = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(entries.some((entry) => entry.action === 'git.repository_connected')).toBe(true);
  });

  test('another operation already active for the project refuses with GitOperationInProgressError and publishes nothing', async () => {
    const harness = await buildHarness('owner');
    await seedPlaceholderRepository(harness.gitRepositoryRepo);
    seedSuccess(harness.commandRunner);
    await harness.gitOperationRepo.enqueue({
      projectId: PROJECT_ID,
      kind: 'PULL',
      triggeredByUserId: OWNER_ID,
    });

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitOperationInProgressError);
    expect(harness.commandRunner.initializeAndPublishCalls).toHaveLength(0);
    const stored = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(stored?.syncStatus).toBe('DISCONNECTED');
  });
});
