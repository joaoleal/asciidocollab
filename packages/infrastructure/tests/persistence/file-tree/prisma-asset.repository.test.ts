import { randomUUID } from 'crypto';
import { AssetRepository, UserRepository, ProjectRepository, Project, FileNodeId } from '@asciidocollab/domain';
import { PrismaClient } from '@prisma/client';
import { PrismaAssetRepository } from '../../../src/persistence/file-tree/prisma-asset.repository';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { PrismaProjectRepository } from '../../../src/persistence/project/prisma-project.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import { createTestUser, createTestProject, createTestAsset } from '../../helpers/test-data';

describe('PrismaAssetRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: AssetRepository;
  let userRepo: UserRepository;
  let projectRepo: ProjectRepository;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaAssetRepository(client);
    userRepo = new PrismaUserRepository(client);
    projectRepo = new PrismaProjectRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.asset.deleteMany();
    await client.fileNode.deleteMany();
    await client.project.deleteMany();
    await client.user.deleteMany();
  });

  it('should save and find an asset by id', async () => {
    const project = await setupProject();
    const { fileNodeId } = await setupFileNode(project.id.value);
    const asset = createTestAsset(fileNodeId);
    await repo.save(asset);

    const found = await repo.findById(asset.id);
    expect(found).not.toBeNull();
    expect(found!.id.value).toBe(asset.id.value);
  });

  it('should return null when finding by non-existent id', async () => {
    const result = await repo.findById(FileNodeId.create('00000000-0000-4000-8000-000000000001'));
    expect(result).toBeNull();
  });

  it('finds several assets at once, ignoring ids that have none', async () => {
    const project = await setupProject();
    const { fileNodeId: firstId } = await setupFileNode(project.id.value, 'first.png');
    const { fileNodeId: secondId } = await setupFileNode(project.id.value, 'second.png');
    const { fileNodeId: withoutAsset } = await setupFileNode(project.id.value, 'third.png');
    await repo.save(createTestAsset(firstId));
    await repo.save(createTestAsset(secondId));

    const found = await repo.findByIds([firstId, secondId, withoutAsset]);

    expect(found.map((asset) => asset.id.value).toSorted()).toEqual(
      [firstId.value, secondId.value].toSorted(),
    );
  });

  it('asks the database nothing when there are no ids to look up', async () => {
    const findMany = jest.spyOn(client.asset, 'findMany');

    const found = await repo.findByIds([]);

    expect(found).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    findMany.mockRestore();
  });

  it('should delete an asset', async () => {
    const project = await setupProject();
    const { fileNodeId } = await setupFileNode(project.id.value);
    const asset = createTestAsset(fileNodeId);
    await repo.save(asset);
    await repo.delete(asset.id);
    const found = await repo.findById(asset.id);
    expect(found).toBeNull();
  });

  async function setupProject(): Promise<Project> {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await projectRepo.save(project);
    return project;
  }

  async function setupFileNode(projectId: string, name = 'test.png'): Promise<{ fileNodeId: FileNodeId }> {
    const folderId = randomUUID();
    await client.fileNode.create({ data: { id: folderId, projectId, name: `root-${folderId}`, type: 'FOLDER', path: `/${folderId}`, parentId: null } });
    const fileId = randomUUID();
    await client.fileNode.create({ data: { id: fileId, projectId, name, type: 'FILE', path: `/${folderId}/${name}`, parentId: folderId } });
    return { fileNodeId: FileNodeId.create(fileId) };
  }
});
