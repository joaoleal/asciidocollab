import {
  ProjectDictionaryRepository,
  UserRepository,
  ProjectRepository,
  ProjectDictionaryTerm,
  ProjectDictionaryTermId,
  Project,
  User,
} from '@asciidocollab/domain';
import { PrismaClient } from '@prisma/client';
import { PrismaProjectDictionaryRepository } from '../../../src/persistence/grammar/prisma-project-dictionary.repository';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { PrismaProjectRepository } from '../../../src/persistence/project/prisma-project.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import { createTestUser, createTestProject } from '../../helpers/test-data';
import { randomUUID } from 'node:crypto';

describe('PrismaProjectDictionaryRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: ProjectDictionaryRepository;
  let userRepo: UserRepository;
  let projectRepo: ProjectRepository;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaProjectDictionaryRepository(client);
    userRepo = new PrismaUserRepository(client);
    projectRepo = new PrismaProjectRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.projectDictionaryTerm.deleteMany();
    await client.project.deleteMany();
    await client.user.deleteMany();
  });

  async function setup(): Promise<{ project: Project; user: User }> {
    const user = createTestUser();
    await userRepo.save(user);
    const project = createTestProject();
    await projectRepo.save(project);
    return { project, user };
  }

  it('adds a term and lists it back for the project', async () => {
    const { project, user } = await setup();
    const term = new ProjectDictionaryTerm(ProjectDictionaryTermId.create(randomUUID()), project.id, 'Kubernetes', user.id);
    await repo.add(term);

    const listed = await repo.listByProject(project.id);
    expect(listed.map((t) => t.term)).toEqual(['Kubernetes']);
    expect(listed[0].createdByUserId.value).toBe(user.id.value);
  });

  it('finds a term case-insensitively', async () => {
    const { project, user } = await setup();
    await repo.add(new ProjectDictionaryTerm(ProjectDictionaryTermId.create(randomUUID()), project.id, 'API', user.id));

    expect(await repo.findByTerm(project.id, 'api')).not.toBeNull();
    expect(await repo.findByTerm(project.id, 'API')).not.toBeNull();
    // A genuinely different string is NOT matched (look-alike guard at the persistence layer).
    expect(await repo.findByTerm(project.id, 'APl')).toBeNull();
  });

  it('removes a term by id scoped to its project and reports whether one was removed', async () => {
    const { project, user } = await setup();
    const term = new ProjectDictionaryTerm(ProjectDictionaryTermId.create(randomUUID()), project.id, 'Kubernetes', user.id);
    await repo.add(term);

    expect(await repo.removeById(project.id, term.id)).toBe(true);
    expect(await repo.listByProject(project.id)).toHaveLength(0);
    // Removing again (now absent) reports false.
    expect(await repo.removeById(project.id, term.id)).toBe(false);
  });
});
