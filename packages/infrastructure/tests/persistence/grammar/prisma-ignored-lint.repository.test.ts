import {
  IgnoredLintRepository,
  UserRepository,
  ProjectRepository,
  FileNodeRepository,
  IgnoredLint,
  IgnoredLintId,
  User,
  FileNode,
} from '@asciidocollab/domain';
import { PrismaClient } from '@prisma/client';
import { PrismaIgnoredLintRepository } from '../../../src/persistence/grammar/prisma-ignored-lint.repository';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { PrismaProjectRepository } from '../../../src/persistence/project/prisma-project.repository';
import { PrismaFileNodeRepository } from '../../../src/persistence/file-tree/prisma-file-node.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import { createTestUser, createTestProject, createTestFileNode } from '../../helpers/test-data';
import { FileNodeType, FilePath } from '@asciidocollab/domain';
import { randomUUID } from 'node:crypto';

describe('PrismaIgnoredLintRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: IgnoredLintRepository;
  let userRepo: UserRepository;
  let projectRepo: ProjectRepository;
  let fileNodeRepo: FileNodeRepository;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaIgnoredLintRepository(client);
    userRepo = new PrismaUserRepository(client);
    projectRepo = new PrismaProjectRepository(client);
    fileNodeRepo = new PrismaFileNodeRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.ignoredLint.deleteMany();
    await client.fileNode.deleteMany();
    await client.project.deleteMany();
    await client.user.deleteMany();
  });

  async function setup(): Promise<{ user: User; document: FileNode }> {
    const user = createTestUser();
    await userRepo.save(user);
    const project = createTestProject();
    await projectRepo.save(project);
    const root = createTestFileNode(project.id, { type: FileNodeType.create('folder'), path: FilePath.create('/root') });
    await fileNodeRepo.save(root);
    const document = createTestFileNode(project.id, { parentId: root.id, name: 'doc.adoc', path: FilePath.create('/root/doc.adoc') });
    await fileNodeRepo.save(document);
    return { user, document };
  }

  it('returns null before anything is stored, then round-trips the blob', async () => {
    const { user, document } = await setup();
    expect(await repo.findByUserAndDocument(user.id, document.id)).toBeNull();

    await repo.upsert(new IgnoredLint(IgnoredLintId.create(randomUUID()), user.id, document.id, '["hash-a"]'));
    const stored = await repo.findByUserAndDocument(user.id, document.id);
    expect(stored?.ignoredLintsJson).toBe('["hash-a"]');
  });

  it('upserts (replaces) the caller’s blob on the (user, document) unique key', async () => {
    const { user, document } = await setup();
    await repo.upsert(new IgnoredLint(IgnoredLintId.create(randomUUID()), user.id, document.id, '["first"]'));
    await repo.upsert(new IgnoredLint(IgnoredLintId.create(randomUUID()), user.id, document.id, '["second"]'));

    const stored = await repo.findByUserAndDocument(user.id, document.id);
    expect(stored?.ignoredLintsJson).toBe('["second"]');
    const count = await client.ignoredLint.count();
    expect(count).toBe(1); // upsert, not a second row
  });
});
