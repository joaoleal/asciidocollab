import { ConnectRepositoryUseCase } from '../../../src/use-cases/git/connect-repository';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { ValidationError } from '../../../src/errors/common/validation-error';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../../src/errors/git/authentication-failed';
import { RepositoryAlreadyConnectedError } from '../../../src/errors/git/repository-already-connected';
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
import { InMemoryGitCredentialStore } from '../../ports/git/in-memory-git-credential-store';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';
import { GitOperationInProgressError } from '../../../src/errors/git/git-operation-in-progress';
import type { Logger } from '../../../src/ports/observability/logger';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const OWNER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REMOTE_URL = 'https://github.com/example/repo.git';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';

function makeLogger(): Logger & { warnCalls: { message: string; meta?: Record<string, unknown> }[] } {
  const warnCalls: { message: string; meta?: Record<string, unknown> }[] = [];
  return {
    warnCalls,
    warn(message: string, meta?: Record<string, unknown>) {
      warnCalls.push({ message, meta });
    },
  };
}

async function memberRepoWithRole(role: string | null): Promise<InMemoryProjectMemberRepository> {
  const repo = new InMemoryProjectMemberRepository();
  if (role) {
    await repo.addMember(new ProjectMember(PROJECT_ID, OWNER_ID, Role.create(role)));
  }
  return repo;
}

interface Harness {
  useCase: ConnectRepositoryUseCase;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  credentialStore: InMemoryGitCredentialStore;
  commandRunner: InMemoryGitCommandRunner;
  gitOperationRepo: InMemoryGitOperationRepository;
  auditRepo: InMemoryAuditLogRepository;
  memberRepo: InMemoryProjectMemberRepository;
  logger: Logger & { warnCalls: { message: string; meta?: Record<string, unknown> }[] };
}

async function buildHarness(role: string | null = 'owner'): Promise<Harness> {
  const memberRepo = await memberRepoWithRole(role);
  const auditRepo = new InMemoryAuditLogRepository();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const credentialStore = new InMemoryGitCredentialStore();
  const commandRunner = new InMemoryGitCommandRunner();
  const gitOperationRepo = new InMemoryGitOperationRepository();
  const logger = makeLogger();

  const useCase = new ConnectRepositoryUseCase(
    gitRepositoryRepo,
    credentialStore,
    commandRunner,
    gitOperationRepo,
    memberRepo,
    auditRepo,
    logger,
  );

  return {
    useCase,
    gitRepositoryRepo,
    credentialStore,
    commandRunner,
    gitOperationRepo,
    auditRepo,
    memberRepo,
    logger,
  };
}

describe('ConnectRepositoryUseCase', () => {
  test('an OWNER connects a valid remote: the repository is created and the credential stored encrypted', async () => {
    const harness = await buildHarness('owner');

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
    expect(repository.projectId).toBe(PROJECT_ID);
    expect(repository.provider.value).toBe('github');
    expect(repository.remoteUrl).toBe(REMOTE_URL);
    expect(repository.syncStatus).toBe('UP_TO_DATE');
    expect(repository.connectedByUserId).toEqual(OWNER_ID);

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved).not.toBeNull();
    expect(saved!.connectedByUserId).toEqual(OWNER_ID);

    // The credential store encrypts internally — never the raw token.
    const storedCredential = await harness.credentialStore.load(PROJECT_ID);
    expect(storedCredential).not.toBeNull();
    expect(storedCredential!.encryptedToken).not.toBe(TOKEN);
    expect(storedCredential!.tokenHint).toBe('7890');
  });

  test('an OWNER connecting authenticates against the remote before storing anything', async () => {
    const harness = await buildHarness('owner');

    await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(harness.commandRunner.remoteAccessCalls).toHaveLength(1);
    expect(harness.commandRunner.remoteAccessCalls[0]).toEqual({ remoteUrl: REMOTE_URL, token: TOKEN });
  });

  test('a non-OWNER (editor) is denied with InsufficientRoleError and nothing is created or stored', async () => {
    const harness = await buildHarness('editor');

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

    expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
    expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
    expect(harness.commandRunner.remoteAccessCalls).toHaveLength(0);

    const entries = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(entries.some((entry) => entry.action === 'authz.denied')).toBe(true);
  });

  test('a non-OWNER (viewer) is denied with InsufficientRoleError', async () => {
    const harness = await buildHarness('viewer');

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
  });

  test('a non-member is denied with InsufficientRoleError', async () => {
    const harness = await buildHarness(null);

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
  });

  test('an invalid provider is rejected with ValidationError before any remote check runs', async () => {
    const harness = await buildHarness('owner');

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'not-a-real-provider',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
    expect(harness.commandRunner.remoteAccessCalls).toHaveLength(0);
  });

  test('a malformed remote URL is rejected with ValidationError before any remote check runs', async () => {
    const harness = await buildHarness('owner');

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: 'not a url; rm -rf /',
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
    expect(harness.commandRunner.remoteAccessCalls).toHaveLength(0);
  });

  test('a project that already has a repository link is refused with RepositoryAlreadyConnectedError', async () => {
    const harness = await buildHarness('owner');
    await harness.gitRepositoryRepo.save(
      new GitRepository(
        GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099'),
        PROJECT_ID,
        GitProvider.create('gitlab'),
        'https://gitlab.com/existing/repo.git',
        PROJECT_ID.value,
      ),
    );

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryAlreadyConnectedError);
    expect(harness.commandRunner.remoteAccessCalls).toHaveLength(0);
    expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
  });

  test('a remote that cannot be reached surfaces RepositoryUnreachableError, and nothing is stored', async () => {
    const harness = await buildHarness('owner');
    harness.commandRunner.seedRemoteAccessFailure(REMOTE_URL, new RepositoryUnreachableError());

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryUnreachableError);
    expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
    expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
  });

  test('a rejected token surfaces AuthenticationFailedError, and nothing is stored', async () => {
    const harness = await buildHarness('owner');
    harness.commandRunner.seedRemoteAccessFailure(REMOTE_URL, new AuthenticationFailedError());

    const result = await harness.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(AuthenticationFailedError);
    expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
    expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
  });

  test('records a successful connection in the audit trail', async () => {
    const harness = await buildHarness('owner');

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

  test('when the repository link fails to save after the credential was stored, the credential is rolled back and the original error propagates', async () => {
    const harness = await buildHarness('owner');
    const linkSaveError = new Error('database constraint violation');
    harness.gitRepositoryRepo.save = async () => {
      throw linkSaveError;
    };

    await expect(
      harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      }),
    ).rejects.toBe(linkSaveError);

    // No orphaned credential material: the just-saved credential was rolled back.
    expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
    expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
  });

  test('a rollback-delete failure is swallowed and logged without the token, and the original save error still propagates', async () => {
    const harness = await buildHarness('owner');
    const linkSaveError = new Error('database constraint violation');
    harness.gitRepositoryRepo.save = async () => {
      throw linkSaveError;
    };
    harness.credentialStore.delete = async () => {
      throw new Error('credential store unavailable');
    };

    await expect(
      harness.useCase.execute({
        actorId: OWNER_ID,
        projectId: PROJECT_ID,
        provider: 'github',
        remoteUrl: REMOTE_URL,
        token: TOKEN,
      }),
    ).rejects.toBe(linkSaveError);

    for (const call of harness.logger.warnCalls) {
      expect(call.message).not.toContain(TOKEN);
      expect(JSON.stringify(call.meta ?? {})).not.toContain(TOKEN);
    }
  });

  test('the token never appears in anything logged, nor in any audit entry, on either a denied or a failed connect', async () => {
    const denied = await buildHarness('editor');
    await denied.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });
    for (const call of denied.logger.warnCalls) {
      expect(call.message).not.toContain(TOKEN);
      expect(JSON.stringify(call.meta ?? {})).not.toContain(TOKEN);
    }
    for (const entry of await denied.auditRepo.findByProjectId(PROJECT_ID)) {
      expect(JSON.stringify(entry.metadata)).not.toContain(TOKEN);
    }

    const failed = await buildHarness('owner');
    failed.commandRunner.seedRemoteAccessFailure(REMOTE_URL, new AuthenticationFailedError());
    await failed.useCase.execute({
      actorId: OWNER_ID,
      projectId: PROJECT_ID,
      provider: 'github',
      remoteUrl: REMOTE_URL,
      token: TOKEN,
    });
    for (const call of failed.logger.warnCalls) {
      expect(call.message).not.toContain(TOKEN);
      expect(JSON.stringify(call.meta ?? {})).not.toContain(TOKEN);
    }
    for (const entry of await failed.auditRepo.findByProjectId(PROJECT_ID)) {
      expect(JSON.stringify(entry.metadata)).not.toContain(TOKEN);
    }
  });

  test('another operation already running for the project refuses with GitOperationInProgressError and stores nothing', async () => {
    const harness = await buildHarness('owner');
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
    expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
    expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
  });
});
