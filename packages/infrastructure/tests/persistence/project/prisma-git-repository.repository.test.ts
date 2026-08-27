import { GitRepositoryRepository, UserRepository, ProjectRepository, GitRepositoryId, Project } from '@asciidocollab/domain';
import { PrismaClient } from '@prisma/client';
import { PrismaGitRepositoryRepository } from '../../../src/persistence/project/prisma-git-repository.repository';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { PrismaProjectRepository } from '../../../src/persistence/project/prisma-project.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import { createTestUser, createTestProject, createTestGitRepository } from '../../helpers/test-data';

describe('PrismaGitRepositoryRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: GitRepositoryRepository;
  let userRepo: UserRepository;
  let projectRepo: ProjectRepository;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaGitRepositoryRepository(client);
    userRepo = new PrismaUserRepository(client);
    projectRepo = new PrismaProjectRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.gitRepository.deleteMany();
    await client.project.deleteMany();
    await client.user.deleteMany();
  });

  it('should save and find a git repository by id', async () => {
    const project = await setupProject();
    const gitRepo = createTestGitRepository(project.id);
    await repo.save(gitRepo);

    const found = await repo.findById(gitRepo.id);
    expect(found).not.toBeNull();
    expect(found!.id.value).toBe(gitRepo.id.value);
  });

  it('should round-trip syncStatus, defaultBranch, and lastKnownRemoteHead', async () => {
    const project = await setupProject();
    const gitRepo = createTestGitRepository(project.id, {
      syncStatus: 'AHEAD',
      defaultBranch: 'develop',
      lastKnownRemoteHead: 'abc123def456',
    });
    await repo.save(gitRepo);

    const found = await repo.findById(gitRepo.id);
    expect(found).not.toBeNull();
    expect(found!.syncStatus).toBe('AHEAD');
    expect(found!.defaultBranch).toBe('develop');
    expect(found!.lastKnownRemoteHead).toBe('abc123def456');
  });

  it('should default syncStatus, defaultBranch, and lastKnownRemoteHead when not provided', async () => {
    const project = await setupProject();
    const gitRepo = createTestGitRepository(project.id);
    await repo.save(gitRepo);

    const found = await repo.findById(gitRepo.id);
    expect(found).not.toBeNull();
    expect(found!.syncStatus).toBe('UP_TO_DATE');
    expect(found!.defaultBranch).toBeNull();
    expect(found!.lastKnownRemoteHead).toBeNull();
  });

  it('should return null when finding by non-existent id', async () => {
    const result = await repo.findById(GitRepositoryId.create('00000000-0000-4000-8000-000000000001'));
    expect(result).toBeNull();
  });

  it('should find by project id', async () => {
    const project = await setupProject();
    const gitRepo = createTestGitRepository(project.id);
    await repo.save(gitRepo);

    const found = await repo.findByProjectId(project.id);
    expect(found).not.toBeNull();
    expect(found!.projectId.value).toBe(project.id.value);
  });

  it('should return null when finding by non-existent project id', async () => {
    const project = await setupProject();
    const result = await repo.findByProjectId(project.id);
    expect(result).toBeNull();
  });

  it('should delete a git repository', async () => {
    const project = await setupProject();
    const gitRepo = createTestGitRepository(project.id);
    await repo.save(gitRepo);
    await repo.delete(gitRepo.id);
    const found = await repo.findById(gitRepo.id);
    expect(found).toBeNull();
  });

  describe('markNeedsReauthUnlessConflicted', () => {
    it('marks a present, non-CONFLICTED row NEEDS_REAUTH and returns true', async () => {
      const project = await setupProject();
      const gitRepo = createTestGitRepository(project.id, { syncStatus: 'BEHIND' });
      await repo.save(gitRepo);

      const result = await repo.markNeedsReauthUnlessConflicted(project.id);

      expect(result).toBe(true);
      const found = await repo.findById(gitRepo.id);
      expect(found!.syncStatus).toBe('NEEDS_REAUTH');
    });

    it('does not touch other columns when marking NEEDS_REAUTH', async () => {
      const project = await setupProject();
      const gitRepo = createTestGitRepository(project.id, {
        syncStatus: 'BEHIND',
        currentBranch: 'feature/x',
        lastKnownRemoteHead: 'abc123def456',
      });
      await repo.save(gitRepo);

      await repo.markNeedsReauthUnlessConflicted(project.id);

      const found = await repo.findById(gitRepo.id);
      expect(found!.currentBranch).toBe('feature/x');
      expect(found!.remoteUrl).toBe(gitRepo.remoteUrl);
      expect(found!.lastKnownRemoteHead).toBe('abc123def456');
    });

    it('leaves a CONFLICTED row untouched and returns false', async () => {
      const project = await setupProject();
      const gitRepo = createTestGitRepository(project.id, { syncStatus: 'CONFLICTED' });
      await repo.save(gitRepo);

      const result = await repo.markNeedsReauthUnlessConflicted(project.id);

      expect(result).toBe(false);
      const found = await repo.findById(gitRepo.id);
      expect(found!.syncStatus).toBe('CONFLICTED');
    });

    it('returns false and inserts nothing when the project has no repository row', async () => {
      const project = await setupProject();

      const result = await repo.markNeedsReauthUnlessConflicted(project.id);

      expect(result).toBe(false);
      const found = await repo.findByProjectId(project.id);
      expect(found).toBeNull();
    });
  });

  describe('saveRefreshedStatus', () => {
    it('writes the observed sync fields onto a non-CONFLICTED row and returns true', async () => {
      const project = await setupProject();
      const gitRepo = createTestGitRepository(project.id, { syncStatus: 'BEHIND', currentBranch: 'feature/x' });
      await repo.save(gitRepo);

      const lastSyncAt = new Date('2024-06-01T00:00:00.000Z');
      const result = await repo.saveRefreshedStatus({
        projectId: project.id,
        syncStatus: 'UP_TO_DATE',
        expectedCurrentStatus: 'BEHIND',
        lastKnownRemoteHead: 'newhead1234',
        lastSyncAt,
      });

      expect(result).toBe(true);
      const found = await repo.findById(gitRepo.id);
      expect(found!.syncStatus).toBe('UP_TO_DATE');
      expect(found!.lastKnownRemoteHead).toBe('newhead1234');
      expect(found!.lastSyncAt!.getTime()).toBe(lastSyncAt.getTime());
      // Untouched columns are preserved.
      expect(found!.currentBranch).toBe('feature/x');
    });

    it('does not clear a stored CONFLICTED status with a non-CONFLICTED write and returns false', async () => {
      const project = await setupProject();
      const gitRepo = createTestGitRepository(project.id, { syncStatus: 'CONFLICTED', lastKnownRemoteHead: 'oldhead0000' });
      await repo.save(gitRepo);

      const result = await repo.saveRefreshedStatus({
        projectId: project.id,
        syncStatus: 'UP_TO_DATE',
        expectedCurrentStatus: 'UP_TO_DATE',
        lastKnownRemoteHead: 'newhead1234',
        lastSyncAt: new Date('2024-06-01T00:00:00.000Z'),
      });

      expect(result).toBe(false);
      const found = await repo.findById(gitRepo.id);
      expect(found!.syncStatus).toBe('CONFLICTED');
      expect(found!.lastKnownRemoteHead).toBe('oldhead0000');
    });

    it('re-asserts CONFLICTED while the row still holds the observed status and returns true', async () => {
      const project = await setupProject();
      const gitRepo = createTestGitRepository(project.id, { syncStatus: 'CONFLICTED', lastKnownRemoteHead: 'oldhead0000' });
      await repo.save(gitRepo);

      const result = await repo.saveRefreshedStatus({
        projectId: project.id,
        syncStatus: 'CONFLICTED',
        expectedCurrentStatus: 'CONFLICTED',
        lastKnownRemoteHead: 'newhead1234',
        lastSyncAt: new Date('2024-06-01T00:00:00.000Z'),
      });

      expect(result).toBe(true);
      const found = await repo.findById(gitRepo.id);
      expect(found!.syncStatus).toBe('CONFLICTED');
      // The conflict is preserved but the observed head/last-sync still refresh.
      expect(found!.lastKnownRemoteHead).toBe('newhead1234');
    });

    it('does NOT re-assert CONFLICTED over a row concurrently resolved off the observed status', async () => {
      // The refresh observed CONFLICTED, but a concurrent complete-merge resolved the row to
      // UP_TO_DATE before this write. The optimistic guard (WHERE syncStatus = expectedCurrentStatus)
      // must match no row, so the stale CONFLICTED re-assert is dropped and the resolved row survives.
      const project = await setupProject();
      const gitRepo = createTestGitRepository(project.id, { syncStatus: 'UP_TO_DATE', lastKnownRemoteHead: 'resolvedhead' });
      await repo.save(gitRepo);

      const result = await repo.saveRefreshedStatus({
        projectId: project.id,
        syncStatus: 'CONFLICTED',
        expectedCurrentStatus: 'CONFLICTED',
        lastKnownRemoteHead: 'stalehead000',
        lastSyncAt: new Date('2024-06-01T00:00:00.000Z'),
      });

      expect(result).toBe(false);
      const found = await repo.findById(gitRepo.id);
      // The row the concurrent resolve wrote survives — not stomped back to CONFLICTED.
      expect(found!.syncStatus).toBe('UP_TO_DATE');
      expect(found!.lastKnownRemoteHead).toBe('resolvedhead');
    });

    it('returns false and inserts nothing when the project has no repository row', async () => {
      const project = await setupProject();

      const result = await repo.saveRefreshedStatus({
        projectId: project.id,
        syncStatus: 'UP_TO_DATE',
        expectedCurrentStatus: 'UP_TO_DATE',
        lastKnownRemoteHead: 'newhead1234',
        lastSyncAt: new Date('2024-06-01T00:00:00.000Z'),
      });

      expect(result).toBe(false);
      const found = await repo.findByProjectId(project.id);
      expect(found).toBeNull();
    });
  });

  async function setupProject(): Promise<Project> {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await projectRepo.save(project);
    return project;
  }
});
