import { PushChangesUseCase } from '../../../src/use-cases/git/push-changes';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { NonFastForwardError } from '../../../src/errors/git/non-fast-forward';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../../src/errors/git/authentication-failed';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { ProjectMember } from '../../../src/entities/project-member';
import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Role } from '../../../src/value-objects/identity/role';
import type { Logger } from '../../../src/ports/observability/logger';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REMOTE_URL = 'https://github.com/example/repo.git';
const CURRENT_BRANCH = 'main';
const TOKEN = 'ghp_super-secret-token-value';
const NEW_HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

async function memberRepoWithRole(role: string | null): Promise<InMemoryProjectMemberRepository> {
  const repo = new InMemoryProjectMemberRepository();
  if (role) {
    await repo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create(role)));
  }
  return repo;
}

interface Harness {
  useCase: PushChangesUseCase;
  commandRunner: InMemoryGitCommandRunner;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  logger: Logger & { warnCalls: { message: string; meta?: Record<string, unknown> }[] };
}

interface HarnessOptions {
  role?: string | null;
  connected?: boolean;
}

function makeLogger(): Logger & { warnCalls: { message: string; meta?: Record<string, unknown> }[] } {
  const warnCalls: { message: string; meta?: Record<string, unknown> }[] = [];
  return {
    warnCalls,
    warn(message: string, meta?: Record<string, unknown>) {
      warnCalls.push({ message, meta });
    },
  };
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { role = 'editor', connected = true } = options;

  const memberRepo = await memberRepoWithRole(role);
  const auditRepo = new InMemoryAuditLogRepository();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const logger = makeLogger();

  if (connected) {
    await gitRepositoryRepo.save(
      new GitRepository(
        GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099'),
        PROJECT_ID,
        GitProvider.create('github'),
        REMOTE_URL,
        PROJECT_ID.value,
        CURRENT_BRANCH,
        'UP_TO_DATE',
        'main',
        'previous-head-commit-hash',
        null,
        new Date('2024-01-01T00:00:00.000Z'),
        ACTOR_ID,
      ),
    );
  }

  const useCase = new PushChangesUseCase(memberRepo, auditRepo, gitRepositoryRepo, commandRunner, logger);

  return { useCase, commandRunner, gitRepositoryRepo, logger };
}

describe('PushChangesUseCase', () => {
  test('pushes the current branch and updates the repository link to UP_TO_DATE with the new head', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedPush(PROJECT_ID, { headCommit: NEW_HEAD });

    const before = new Date();
    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID, token: TOKEN });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.headCommit).toBe(NEW_HEAD);

    expect(harness.commandRunner.pushCalls).toHaveLength(1);
    expect(harness.commandRunner.pushCalls[0].input).toEqual({
      remoteUrl: REMOTE_URL,
      token: TOKEN,
      branch: CURRENT_BRANCH,
    });

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved).not.toBeNull();
    expect(saved?.syncStatus).toBe('UP_TO_DATE');
    expect(saved?.lastKnownRemoteHead).toBe(NEW_HEAD);
    expect(saved?.lastSyncAt).not.toBeNull();
    expect((saved?.lastSyncAt as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());
    // Everything else about the row is preserved from the loaded one.
    expect(saved?.currentBranch).toBe(CURRENT_BRANCH);
    expect(saved?.remoteUrl).toBe(REMOTE_URL);
  });

  test('a non-fast-forward rejection refuses with NonFastForwardError and leaves the row unchanged', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedPushFailure(PROJECT_ID, new NonFastForwardError());

    const before = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID, token: TOKEN });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(NonFastForwardError);

    const after = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(after?.syncStatus).toBe(before?.syncStatus);
    expect(after?.lastKnownRemoteHead).toBe(before?.lastKnownRemoteHead);
    expect(after?.lastSyncAt).toBe(before?.lastSyncAt);
  });

  test('an unreachable remote propagates RepositoryUnreachableError and leaves the row unchanged', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedPushFailure(PROJECT_ID, new RepositoryUnreachableError());

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID, token: TOKEN });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryUnreachableError);

    const after = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(after?.syncStatus).toBe('UP_TO_DATE');
    expect(after?.lastKnownRemoteHead).toBe('previous-head-commit-hash');
  });

  test('a rejected token propagates AuthenticationFailedError and leaves the row unchanged', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedPushFailure(PROJECT_ID, new AuthenticationFailedError());

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID, token: TOKEN });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(AuthenticationFailedError);

    const after = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(after?.syncStatus).toBe('UP_TO_DATE');
    expect(after?.lastKnownRemoteHead).toBe('previous-head-commit-hash');
  });

  test('a generic command failure propagates GitCommandFailedError', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedPushFailure(PROJECT_ID, new GitCommandFailedError('git push failed'));

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID, token: TOKEN });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });

  test('a VIEWER is denied with InsufficientRoleError and push is never called', async () => {
    const harness = await buildHarness({ role: 'viewer' });
    harness.commandRunner.seedPush(PROJECT_ID, { headCommit: NEW_HEAD });

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID, token: TOKEN });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.pushCalls).toHaveLength(0);
  });

  test('a non-member is denied with InsufficientRoleError and push is never called', async () => {
    const harness = await buildHarness({ role: null });
    harness.commandRunner.seedPush(PROJECT_ID, { headCommit: NEW_HEAD });

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID, token: TOKEN });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.pushCalls).toHaveLength(0);
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError and push is never called', async () => {
    const harness = await buildHarness({ connected: false });
    harness.commandRunner.seedPush(PROJECT_ID, { headCommit: NEW_HEAD });

    const result = await harness.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID, token: TOKEN });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(harness.commandRunner.pushCalls).toHaveLength(0);
  });

  test('the token never appears in anything logged, on either a denied or a failed push', async () => {
    const denied = await buildHarness({ role: 'viewer' });
    await denied.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID, token: TOKEN });
    for (const call of denied.logger.warnCalls) {
      expect(call.message).not.toContain(TOKEN);
      expect(JSON.stringify(call.meta ?? {})).not.toContain(TOKEN);
    }

    const failed = await buildHarness();
    failed.commandRunner.seedPushFailure(PROJECT_ID, new GitCommandFailedError('git push failed'));
    await failed.useCase.execute({ actorId: ACTOR_ID, projectId: PROJECT_ID, token: TOKEN });
    for (const call of failed.logger.warnCalls) {
      expect(call.message).not.toContain(TOKEN);
      expect(JSON.stringify(call.meta ?? {})).not.toContain(TOKEN);
    }
  });
});
