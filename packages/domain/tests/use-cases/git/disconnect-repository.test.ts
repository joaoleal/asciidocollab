import { DisconnectRepositoryUseCase } from '../../../src/use-cases/git/disconnect-repository';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { GitOperationInProgressError } from '../../../src/errors/git/git-operation-in-progress';
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
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const OWNER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REPOSITORY_ID = GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099');
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';

async function memberRepoWithRole(role: string | null): Promise<InMemoryProjectMemberRepository> {
  const repo = new InMemoryProjectMemberRepository();
  if (role) {
    await repo.addMember(new ProjectMember(PROJECT_ID, OWNER_ID, Role.create(role)));
  }
  return repo;
}

interface Harness {
  useCase: DisconnectRepositoryUseCase;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  credentialStore: InMemoryGitCredentialStore;
  gitOperationRepo: InMemoryGitOperationRepository;
  auditRepo: InMemoryAuditLogRepository;
  memberRepo: InMemoryProjectMemberRepository;
}

async function buildHarness(role: string | null = 'owner'): Promise<Harness> {
  const memberRepo = await memberRepoWithRole(role);
  const auditRepo = new InMemoryAuditLogRepository();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const credentialStore = new InMemoryGitCredentialStore();
  const gitOperationRepo = new InMemoryGitOperationRepository();

  const useCase = new DisconnectRepositoryUseCase(
    memberRepo,
    auditRepo,
    gitRepositoryRepo,
    credentialStore,
    gitOperationRepo,
  );

  return { useCase, gitRepositoryRepo, credentialStore, gitOperationRepo, auditRepo, memberRepo };
}

async function seedConnectedRepository(harness: Harness): Promise<void> {
  await harness.gitRepositoryRepo.save(
    new GitRepository(
      REPOSITORY_ID,
      PROJECT_ID,
      GitProvider.create('github'),
      'https://github.com/example/repo.git',
      PROJECT_ID.value,
    ),
  );
  await harness.credentialStore.save(PROJECT_ID, {
    token: TOKEN,
    provider: GitProvider.create('github'),
    createdByUserId: OWNER_ID,
  });
}

describe('DisconnectRepositoryUseCase', () => {
  test('an OWNER disconnects a connected project: the repository link and credential are both deleted', async () => {
    const harness = await buildHarness('owner');
    await seedConnectedRepository(harness);

    const result = await harness.useCase.execute({ actorId: OWNER_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({ ok: true });

    expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
    expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
  });

  test('records the disconnect in the audit trail', async () => {
    const harness = await buildHarness('owner');
    await seedConnectedRepository(harness);

    await harness.useCase.execute({ actorId: OWNER_ID, projectId: PROJECT_ID });

    const entries = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(entries.some((entry) => entry.action === 'git.repository_disconnected')).toBe(true);
  });

  test('a non-OWNER (editor) is denied with InsufficientRoleError and nothing is deleted', async () => {
    const harness = await buildHarness('editor');
    await seedConnectedRepository(harness);

    const result = await harness.useCase.execute({ actorId: OWNER_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(InsufficientRoleError);

    expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).not.toBeNull();
    expect(await harness.credentialStore.load(PROJECT_ID)).not.toBeNull();

    const entries = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(entries.some((entry) => entry.action === 'authz.denied')).toBe(true);
  });

  test('a non-OWNER (viewer) is denied with InsufficientRoleError', async () => {
    const harness = await buildHarness('viewer');
    await seedConnectedRepository(harness);

    const result = await harness.useCase.execute({ actorId: OWNER_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
  });

  test('a project with no connected repository is refused with RepositoryNotConnectedError, and the credential store is left untouched', async () => {
    const harness = await buildHarness('owner');

    const result = await harness.useCase.execute({ actorId: OWNER_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
  });

  test('an in-flight git operation refuses the disconnect with GitOperationInProgressError, and nothing is deleted', async () => {
    const harness = await buildHarness('owner');
    await seedConnectedRepository(harness);
    await harness.gitOperationRepo.enqueue({
      projectId: PROJECT_ID,
      kind: 'PUSH',
      triggeredByUserId: OWNER_ID,
    });
    await harness.gitOperationRepo.claimNextQueued(30_000);

    const result = await harness.useCase.execute({ actorId: OWNER_ID, projectId: PROJECT_ID });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitOperationInProgressError);

    expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).not.toBeNull();
    expect(await harness.credentialStore.load(PROJECT_ID)).not.toBeNull();
  });

  test('a mid-op failure deleting the repository row leaves the credential deleted but the row intact; a retry then completes cleanly', async () => {
    const harness = await buildHarness('owner');
    await seedConnectedRepository(harness);

    const deleteSpy = jest
      .spyOn(harness.gitRepositoryRepo, 'delete')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(
      harness.useCase.execute({ actorId: OWNER_ID, projectId: PROJECT_ID }),
    ).rejects.toThrow('storage unavailable');

    // The credential — the secret — is gone even though the failure happened after it was
    // deleted; the repository row is still there, so the project still reads as connected.
    expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
    expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).not.toBeNull();

    deleteSpy.mockRestore();

    const retry = await harness.useCase.execute({ actorId: OWNER_ID, projectId: PROJECT_ID });

    expect(retry.success).toBe(true);
    expect(await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID)).toBeNull();
    expect(await harness.credentialStore.load(PROJECT_ID)).toBeNull();
  });
});
