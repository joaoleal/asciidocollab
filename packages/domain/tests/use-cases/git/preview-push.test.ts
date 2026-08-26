import { PreviewPushUseCase } from '../../../src/use-cases/git/preview-push';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { ProjectMember } from '../../../src/entities/project-member';
import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Role } from '../../../src/value-objects/identity/role';
import { User } from '../../../src/entities/user';
import { Email } from '../../../src/value-objects/identity/email';
import { GitLogEntry } from '../../../src/ports/git/git-command-runner';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryUserRepository } from '../../ports/user/in-memory-user.repository';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440010');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440011');
const REMOTE_URL = 'https://github.com/example/repo.git';
const CURRENT_BRANCH = 'main';

function entry(overrides: Partial<GitLogEntry> = {}): GitLogEntry {
  return {
    hash: '0'.repeat(40),
    message: 'a commit',
    authorEmail: 'author@example.com',
    authoredAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function memberRepoWithRole(role: string | null): Promise<InMemoryProjectMemberRepository> {
  const repo = new InMemoryProjectMemberRepository();
  if (role) {
    await repo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create(role)));
  }
  return repo;
}

interface Harness {
  useCase: PreviewPushUseCase;
  commandRunner: InMemoryGitCommandRunner;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  userRepo: InMemoryUserRepository;
}

interface HarnessOptions {
  role?: string | null;
  connected?: boolean;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { role = 'editor', connected = true } = options;

  const memberRepo = await memberRepoWithRole(role);
  const auditRepo = new InMemoryAuditLogRepository();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const userRepo = new InMemoryUserRepository();

  if (connected) {
    await gitRepositoryRepo.save(
      new GitRepository(
        GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440098'),
        PROJECT_ID,
        GitProvider.create('github'),
        REMOTE_URL,
        PROJECT_ID.value,
        CURRENT_BRANCH,
      ),
    );
  }

  const useCase = new PreviewPushUseCase(memberRepo, auditRepo, gitRepositoryRepo, commandRunner, userRepo);

  return { useCase, commandRunner, gitRepositoryRepo, userRepo };
}

describe('PreviewPushUseCase', () => {
  test('previews the outgoing commits and changed paths, passing the branch through, without any token/credential', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedPreviewPush(PROJECT_ID, {
      outgoing: [entry({ hash: 'c1', message: 'local change' })],
      changedPaths: ['chapters/outro.adoc'],
    });

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.outgoingCommits.map((c) => c.hash)).toEqual(['c1']);
    expect(result.value.outgoingCommits.map((c) => c.message)).toEqual(['local change']);
    expect(result.value.changedPaths).toEqual(['chapters/outro.adoc']);

    expect(harness.commandRunner.previewPushCalls).toEqual([
      { projectId: PROJECT_ID, input: { branch: CURRENT_BRANCH } },
    ]);
  });

  test('an explicit branch overrides the repository link\'s current branch', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedPreviewPush(PROJECT_ID, { outgoing: [], changedPaths: [] });

    await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID, branch: 'release' });

    expect(harness.commandRunner.previewPushCalls[0].input.branch).toBe('release');
  });

  test('a commit whose author email maps to a platform user carries that user\'s id', async () => {
    const harness = await buildHarness();
    const authorId = UserId.create('550e8400-e29b-41d4-a716-446655440012');
    await harness.userRepo.save(
      new User(authorId, Email.create('mapped@example.com'), 'Mapped Author', 'hash', [], null, null),
    );
    harness.commandRunner.seedPreviewPush(PROJECT_ID, {
      outgoing: [entry({ hash: 'c1', authorEmail: 'mapped@example.com' })],
      changedPaths: [],
    });

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.outgoingCommits[0].authorUserId).toEqual(authorId);
  });

  test('a commit whose author email maps to nobody has no authorUserId', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedPreviewPush(PROJECT_ID, {
      outgoing: [entry({ hash: 'c1', authorEmail: 'unmapped@example.com' })],
      changedPaths: [],
    });

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.outgoingCommits[0].authorUserId).toBeUndefined();
  });

  test('a VIEWER is denied with InsufficientRoleError, and the runner is never called', async () => {
    const harness = await buildHarness({ role: 'viewer' });
    harness.commandRunner.seedPreviewPush(PROJECT_ID, { outgoing: [entry()], changedPaths: [] });

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.previewPushCalls).toHaveLength(0);
  });

  test('a non-member is denied with InsufficientRoleError, and the runner is never called', async () => {
    const harness = await buildHarness({ role: null });

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.previewPushCalls).toHaveLength(0);
  });

  test('a denial is recorded to the audit log', async () => {
    const memberRepo = await memberRepoWithRole('viewer');
    const auditRepo = new InMemoryAuditLogRepository();
    const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
    const commandRunner = new InMemoryGitCommandRunner();
    const userRepo = new InMemoryUserRepository();
    const useCase = new PreviewPushUseCase(memberRepo, auditRepo, gitRepositoryRepo, commandRunner, userRepo);

    await useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID });

    const entries = await auditRepo.findAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('authz.denied');
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError, and the runner is never called', async () => {
    const harness = await buildHarness({ connected: false });

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(harness.commandRunner.previewPushCalls).toHaveLength(0);
  });

  test('a generic command failure propagates GitCommandFailedError', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedPreviewPushFailure(PROJECT_ID, new GitCommandFailedError('git log failed'));

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });

  test('never pushes, commits, or otherwise mutates the project\'s working tree, and touches no network', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedPreviewPush(PROJECT_ID, { outgoing: [entry()], changedPaths: ['a.adoc'] });

    await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID });

    expect(harness.commandRunner.pushCalls).toHaveLength(0);
    expect(harness.commandRunner.commitCalls).toHaveLength(0);
    expect(harness.commandRunner.fetchCalls).toHaveLength(0);
  });
});
