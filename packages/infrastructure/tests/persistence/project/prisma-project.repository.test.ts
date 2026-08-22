import { ProjectRepository, UserRepository, ProjectName, Role, Project, Timestamps, FileNodeType, FilePath } from '@asciidocollab/domain';
import { PrismaClient } from '@prisma/client';
import { PrismaProjectRepository } from '../../../src/persistence/project/prisma-project.repository';
import { PrismaProjectMemberRepository } from '../../../src/persistence/project/prisma-project-member.repository';
import { PrismaFileNodeRepository } from '../../../src/persistence/file-tree/prisma-file-node.repository';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import { createTestUser, createTestProject, createTestProjectMember, createTestFileNode } from '../../helpers/test-data';
import { ProjectId } from '@asciidocollab/domain';

describe('PrismaProjectRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: ProjectRepository;
  let userRepo: UserRepository;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaProjectRepository(client);
    userRepo = new PrismaUserRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.projectMember.deleteMany();
    await client.project.deleteMany();
    await client.user.deleteMany();
  });

  it('should save and find a project by id', async () => {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await repo.save(project);

    const found = await repo.findById(project.id);
    expect(found).not.toBeNull();
    expect(found!.id.value).toBe(project.id.value);
  });

  it('should return null when finding by non-existent id', async () => {
    const result = await repo.findById(ProjectId.create('00000000-0000-4000-8000-000000000001'));
    expect(result).toBeNull();
  });

  it('should delete a project', async () => {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await repo.save(project);

    await repo.delete(project.id);
    const found = await repo.findById(project.id);
    expect(found).toBeNull();
  });

  it('should update an existing project on save', async () => {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await repo.save(project);

    const updatedProject = createTestProject({ id: project.id, name: ProjectName.create('Updated Project') });
    await repo.save(updatedProject);

    const found = await repo.findById(project.id);
    expect(found).not.toBeNull();
  });

  it('should handle delete of non-existent entity gracefully', async () => {
    const nonExistentId = ProjectId.create('00000000-0000-4000-8000-000000000002');
    await expect(repo.delete(nonExistentId)).resolves.not.toThrow();
  });

  it('should persist and retrieve tags as JSON', async () => {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject({ tags: ['tag1', 'tag2', 'tag3'] });
    await repo.save(project);

    const found = await repo.findById(project.id);
    expect(found).not.toBeNull();
  });

  it('round-trips the main file node and a supported document language', async () => {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await repo.save(project);
    const fileNodeRepo = new PrismaFileNodeRepository(client);
    // A file may not sit at the root, so the main file hangs off a root folder.
    const root = createTestFileNode(project.id, { name: 'root', type: FileNodeType.create('folder'), path: FilePath.create('/') });
    await fileNodeRepo.save(root);
    const mainFile = createTestFileNode(project.id, { parentId: root.id, name: 'book.adoc', path: FilePath.create('/book.adoc') });
    await fileNodeRepo.save(mainFile);

    const configured = new Project(
      project.id,
      ProjectName.create('Configured Project'),
      'A described project',
      ['docs', 'pdf'],
      null,
      new Timestamps(project.createdAt, new Date()),
      null,
      mainFile.id,
      'pt',
    );
    await repo.save(configured);

    const found = await repo.findById(project.id);
    expect(found).not.toBeNull();
    expect(found!.mainFileNodeId).not.toBeNull();
    expect(found!.mainFileNodeId!.value).toBe(mainFile.id.value);
    expect(found!.language).toBe('pt');
    expect(found!.name.value).toBe('Configured Project');
    expect(found!.description).toBe('A described project');
    expect(found!.tags).toEqual(['docs', 'pdf']);
    expect(found!.archivedAt).toBeNull();
  });

  it('treats a stored language outside the supported set as unset', async () => {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await repo.save(project);
    // The column is free text, so a value the domain would reject can already be in the database.
    // Loading must degrade to "unset" rather than throw and make the project unreadable.
    await client.project.update({ where: { id: project.id.value }, data: { language: 'klingon' } });

    expect((await repo.findById(project.id))!.language).toBeNull();

    // A supported code stored the same way survives, so the guard is not just returning null.
    await client.project.update({ where: { id: project.id.value }, data: { language: 'uk' } });
    expect((await repo.findById(project.id))!.language).toBe('uk');
  });

  it('degrades a non-array stored tags value to an empty list and drops non-string entries', async () => {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject({ tags: ['keep'] });
    await repo.save(project);

    await client.project.update({ where: { id: project.id.value }, data: { tags: 'keep,me' } });
    expect((await repo.findById(project.id))!.tags).toEqual([]);

    await client.project.update({ where: { id: project.id.value }, data: { tags: ['keep', 7, null, 'me'] } });
    expect((await repo.findById(project.id))!.tags).toEqual(['keep', 'me']);
  });

  it('findByMemberId returns active projects for a member and excludes archived ones', async () => {
    const memberRepo = new PrismaProjectMemberRepository(client);
    const user = createTestUser();
    await userRepo.save(user);
    const active = createTestProject();
    const archived = createTestProject();
    await repo.save(active);
    await repo.save(archived);
    await memberRepo.addMember(createTestProjectMember(active.id, user.id, { role: Role.create('owner') }));
    await memberRepo.addMember(createTestProjectMember(archived.id, user.id, { role: Role.create('owner') }));
    await repo.archive(archived.id, new Date());

    const activePage = await repo.findByMemberId(user.id, { page: 1, limit: 10 });
    expect(activePage.total).toBe(1);
    expect(activePage.projects[0].id.value).toBe(active.id.value);
    expect(activePage.totalPages).toBe(1);

    const archivedPage = await repo.findByMemberId(user.id, { page: 1, limit: 10 }, true);
    expect(archivedPage.total).toBe(1);
    expect(archivedPage.projects[0].id.value).toBe(archived.id.value);
  });

  it('archive sets and restore clears the archived flag', async () => {
    const memberRepo = new PrismaProjectMemberRepository(client);
    const user = createTestUser();
    await userRepo.save(user);
    const project = createTestProject();
    await repo.save(project);
    await memberRepo.addMember(createTestProjectMember(project.id, user.id, { role: Role.create('owner') }));

    await repo.archive(project.id, new Date());
    const afterArchive = await repo.findByMemberId(user.id, { page: 1, limit: 10 }, true);
    expect(afterArchive.total).toBe(1);

    await repo.restore(project.id);
    const activeAfterRestore = await repo.findByMemberId(user.id, { page: 1, limit: 10 });
    const archivedAfterRestore = await repo.findByMemberId(user.id, { page: 1, limit: 10 }, true);
    expect(activeAfterRestore.total).toBe(1);
    expect(archivedAfterRestore.total).toBe(0);
  });
});
