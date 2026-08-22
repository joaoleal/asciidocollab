import {
  ProjectRenderConfigRepository,
  UserRepository,
  ProjectRepository,
  ProjectRenderConfig,
  ProjectRenderConfigId,
  ProjectId,
  Project,
} from '@asciidocollab/domain';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaProjectRenderConfigRepository } from '../../../src/persistence/project/prisma-project-render-config.repository';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { PrismaProjectRepository } from '../../../src/persistence/project/prisma-project.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import { createTestUser, createTestProject } from '../../helpers/test-data';
import { randomUUID } from 'node:crypto';

function makeConfig(projectId: ProjectId, config: Record<string, unknown>): ProjectRenderConfig {
  return new ProjectRenderConfig(ProjectRenderConfigId.create(randomUUID()), projectId, config);
}

describe('PrismaProjectRenderConfigRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: ProjectRenderConfigRepository;
  let userRepo: UserRepository;
  let projectRepo: ProjectRepository;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaProjectRenderConfigRepository(client);
    userRepo = new PrismaUserRepository(client);
    projectRepo = new PrismaProjectRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.projectRenderConfig.deleteMany();
    await client.project.deleteMany();
    await client.user.deleteMany();
  });

  async function setupProject(): Promise<Project> {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await projectRepo.save(project);
    return project;
  }

  it('saves and finds a config by project id, round-tripping nested JSON', async () => {
    const project = await setupProject();
    const entity = makeConfig(project.id, {
      doctype: 'book',
      toclevels: 3,
      customAttributes: { company: 'Acme', version: '1.0' },
      extraFontDirs: ['assets/fonts'],
    });
    await repo.save(entity);

    const found = await repo.findByProjectId(project.id);
    expect(found).not.toBeNull();
    expect(found!.id.value).toBe(entity.id.value);
    expect(found!.projectId.value).toBe(project.id.value);
    expect(found!.config).toEqual({
      doctype: 'book',
      toclevels: 3,
      customAttributes: { company: 'Acme', version: '1.0' },
      extraFontDirs: ['assets/fonts'],
    });
  });

  it('returns null when no config exists for the project', async () => {
    const project = await setupProject();
    expect(await repo.findByProjectId(project.id)).toBeNull();
  });

  it('returns null for a non-existent project id', async () => {
    const result = await repo.findByProjectId(ProjectId.create('00000000-0000-4000-8000-000000000009'));
    expect(result).toBeNull();
  });

  it('upserts in place, keeping one row per project', async () => {
    const project = await setupProject();
    const first = makeConfig(project.id, { media: 'print' });
    await repo.save(first);
    await repo.save(makeConfig(project.id, { media: 'prepress' }));

    const found = await repo.findByProjectId(project.id);
    expect(found!.config).toEqual({ media: 'prepress' });
    // The unique projectId constraint means the second save updates the same row.
    expect(await client.projectRenderConfig.count({ where: { projectId: project.id.value } })).toBe(1);
  });

  it('persists an empty config', async () => {
    const project = await setupProject();
    await repo.save(makeConfig(project.id, {}));
    const found = await repo.findByProjectId(project.id);
    expect(found!.config).toEqual({});
  });

  it('writes JSON-incompatible values as null rather than dropping or crashing on them', async () => {
    const project = await setupProject();
    const entity = makeConfig(project.id, {
      // null / undefined take the same nulling path, but only the first survives a JSON round-trip
      // as a key at all if the serializer used JSON.stringify — it must not.
      pdfTheme: null,
      doctype: undefined,
      // Values TypeScript cannot rule out at the `unknown` boundary and JSON cannot express.
      onRender: () => 'nope',
      revision: 10n,
      // Nulls nested inside objects and arrays go through the same recursion.
      customAttributes: { company: 'Acme', release: null },
      extraFontDirs: ['assets/fonts', null],
      // Primitives are preserved verbatim alongside them.
      toclevels: 3,
      sectnums: true,
    });
    await repo.save(entity);

    const found = await repo.findByProjectId(project.id);
    expect(found!.config).toEqual({
      pdfTheme: null,
      doctype: null,
      onRender: null,
      revision: null,
      customAttributes: { company: 'Acme', release: null },
      extraFontDirs: ['assets/fonts', null],
      toclevels: 3,
      sectnums: true,
    });
  });

  it('falls back to an empty configuration when the stored JSON is not a plain object', async () => {
    const project = await setupProject();
    const id = randomUUID();
    await client.projectRenderConfig.create({
      data: { id, projectId: project.id.value, config: ['not', 'an', 'object'] },
    });

    // An array is `typeof 'object'` — it must still be rejected, not spread into index keys.
    const fromArray = await repo.findByProjectId(project.id);
    expect(fromArray!.config).toEqual({});
    // The row itself is still mapped: only the config document degrades.
    expect(fromArray!.id.value).toBe(id);
    expect(fromArray!.projectId.value).toBe(project.id.value);

    await client.projectRenderConfig.update({ where: { id }, data: { config: 'corrupt' } });
    expect((await repo.findByProjectId(project.id))!.config).toEqual({});

    await client.projectRenderConfig.update({ where: { id }, data: { config: Prisma.JsonNull } });
    expect((await repo.findByProjectId(project.id))!.config).toEqual({});
  });

  it('is removed when its project is deleted (cascade)', async () => {
    const project = await setupProject();
    await repo.save(makeConfig(project.id, { doctype: 'book' }));
    await client.project.delete({ where: { id: project.id.value } });
    expect(await repo.findByProjectId(project.id)).toBeNull();
  });
});
