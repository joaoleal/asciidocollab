import { ConnectRepositoryUseCase } from '../../../src/use-cases/git/connect-repository';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { ValidationError } from '../../../src/errors/common/validation-error';
import { RepositoryUnreachableError } from '../../../src/errors/git/repository-unreachable';
import { AuthenticationFailedError } from '../../../src/errors/git/authentication-failed';
import { GitCredentialEncryptor } from '../../../src/services/git-credential-encryptor';
import { ProjectMember } from '../../../src/entities/project-member';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Role } from '../../../src/value-objects/identity/role';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCredentialStore } from '../../ports/git/in-memory-git-credential-store';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const OWNER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REMOTE_URL = 'https://github.com/example/repo.git';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';

/** A deterministic, reversible stand-in for the real AES-256-GCM encryptor. */
function fakeEncryptor(): GitCredentialEncryptor {
  return {
    encrypt: jest.fn((plaintextToken: string) => ({
      encryptedToken: `enc(${plaintextToken})`,
      tokenHint: plaintextToken.slice(-4),
    })),
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
  credentialEncryptor: GitCredentialEncryptor;
  commandRunner: InMemoryGitCommandRunner;
  gitOperationRepo: InMemoryGitOperationRepository;
  auditRepo: InMemoryAuditLogRepository;
  memberRepo: InMemoryProjectMemberRepository;
}

async function buildHarness(role: string | null = 'owner'): Promise<Harness> {
  const memberRepo = await memberRepoWithRole(role);
  const auditRepo = new InMemoryAuditLogRepository();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const credentialStore = new InMemoryGitCredentialStore();
  const credentialEncryptor = fakeEncryptor();
  const commandRunner = new InMemoryGitCommandRunner();
  const gitOperationRepo = new InMemoryGitOperationRepository();

  const useCase = new ConnectRepositoryUseCase(
    gitRepositoryRepo,
    credentialStore,
    credentialEncryptor,
    commandRunner,
    gitOperationRepo,
    memberRepo,
    auditRepo,
  );

  return {
    useCase,
    gitRepositoryRepo,
    credentialStore,
    credentialEncryptor,
    commandRunner,
    gitOperationRepo,
    auditRepo,
    memberRepo,
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

    // The credential is stored via the encryptor's ciphertext — never the raw token.
    const storedCredential = await harness.credentialStore.load(PROJECT_ID);
    expect(storedCredential).not.toBeNull();
    expect(storedCredential!.encryptedToken).not.toBe(TOKEN);
    expect(storedCredential!.encryptedToken).toBe(`enc(${TOKEN})`);
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
});
