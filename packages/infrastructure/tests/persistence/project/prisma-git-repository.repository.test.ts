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

  async function setupProject(): Promise<Project> {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await projectRepo.save(project);
    return project;
  }
});
