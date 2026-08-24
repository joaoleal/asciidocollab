// Requires a live Postgres via testcontainers (see helpers/prisma-test-container.ts), which this
// sandbox cannot run (Prisma's `db push` refuses to execute under an AI agent without explicit
// user consent — verified against the sibling prisma-git-repository.repository.test.ts, which
// fails the same way here). Authored and believed correct against the real `GitCredential` table;
// exercise it in an environment with a real database. The runnable equivalent — same behaviors,
// against a fake Prisma client — lives in prisma-git-credential-store.unit.test.ts.
import { GitProvider, Project, User, UserRepository, ProjectRepository } from '@asciidocollab/domain';
import { PrismaClient } from '@prisma/client';
import { PrismaGitCredentialStore } from '../../../src/persistence/git/prisma-git-credential-store';
import { SessionEncryption } from '../../../src/services/session-encryption';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { PrismaProjectRepository } from '../../../src/persistence/project/prisma-project.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import { createTestUser, createTestProject } from '../../helpers/test-data';

// 32 zero bytes in base64 — a fixed key so a stored ciphertext can be decrypted by the test itself.
const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('PrismaGitCredentialStore', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let store: PrismaGitCredentialStore;
  let encryption: SessionEncryption;
  let userRepo: UserRepository;
  let projectRepo: ProjectRepository;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    encryption = new SessionEncryption({ encryptionKey: KEY });
    store = new PrismaGitCredentialStore(client, encryption);
    userRepo = new PrismaUserRepository(client);
    projectRepo = new PrismaProjectRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.gitCredential.deleteMany();
    await client.project.deleteMany();
    await client.user.deleteMany();
  });

  async function setupProjectAndUser(): Promise<{ project: Project; owner: User }> {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await projectRepo.save(project);
    return { project, owner };
  }

  it('saves and reads back the encrypted token and hint', async () => {
    const { project, owner } = await setupProjectAndUser();
    const ciphertext = encryption.encrypt('ghp_liveTestToken1234');

    await store.save(project.id, {
      encryptedToken: ciphertext,
      tokenHint: '1234',
      provider: GitProvider.create('github'),
      createdByUserId: owner.id,
    });
    const found = await store.load(project.id);

    expect(found).toEqual({ encryptedToken: ciphertext, tokenHint: '1234' });
    expect(encryption.decrypt(found!.encryptedToken)).toBe('ghp_liveTestToken1234');
  });

  it('persists provider and createdByUserId on the row (non-nullable columns)', async () => {
    const { project, owner } = await setupProjectAndUser();

    await store.save(project.id, {
      encryptedToken: encryption.encrypt('token'),
      tokenHint: null,
      provider: GitProvider.create('gitlab'),
      createdByUserId: owner.id,
    });

    const row = await client.gitCredential.findUniqueOrThrow({ where: { projectId: project.id.value } });
    expect(row.provider).toBe('GITLAB');
    expect(row.createdByUserId).toBe(owner.id.value);
    // The plaintext token must never reach the database column.
    expect(row.encryptedToken).not.toBe('token');
  });

  it('returns null for a project with no stored credential', async () => {
    const { project } = await setupProjectAndUser();

    expect(await store.load(project.id)).toBeNull();
  });

  it('overwrites the previous row when saving again for the same project (unique projectId)', async () => {
    const { project, owner } = await setupProjectAndUser();
    await store.save(project.id, {
      encryptedToken: encryption.encrypt('old'),
      tokenHint: 'aaaa',
      provider: GitProvider.create('github'),
      createdByUserId: owner.id,
    });

    await store.save(project.id, {
      encryptedToken: encryption.encrypt('new'),
      tokenHint: 'bbbb',
      provider: GitProvider.create('github'),
      createdByUserId: owner.id,
    });

    const rows = await client.gitCredential.findMany({ where: { projectId: project.id.value } });
    expect(rows).toHaveLength(1);
    expect(encryption.decrypt(rows[0].encryptedToken)).toBe('new');
    expect(rows[0].tokenHint).toBe('bbbb');
  });

  it('deletes the stored credential so a later read returns null', async () => {
    const { project, owner } = await setupProjectAndUser();
    await store.save(project.id, {
      encryptedToken: encryption.encrypt('token'),
      tokenHint: '1234',
      provider: GitProvider.create('github'),
      createdByUserId: owner.id,
    });

    await store.delete(project.id);

    expect(await store.load(project.id)).toBeNull();
    expect(await client.gitCredential.count()).toBe(0);
  });

  it('treats deleting a project with no stored credential as a no-op', async () => {
    const { project } = await setupProjectAndUser();

    await expect(store.delete(project.id)).resolves.toBeUndefined();
  });

  it('cascades away when the owning project is deleted (onDelete: Cascade)', async () => {
    const { project, owner } = await setupProjectAndUser();
    await store.save(project.id, {
      encryptedToken: encryption.encrypt('token'),
      tokenHint: '1234',
      provider: GitProvider.create('github'),
      createdByUserId: owner.id,
    });

    await client.project.delete({ where: { id: project.id.value } });

    expect(await client.gitCredential.count({ where: { projectId: project.id.value } })).toBe(0);
  });

  describe('loadDecrypted (execution-time path for the git-worker — carry-forward #1)', () => {
    it('returns the decrypted plaintext token and hint', async () => {
      const { project, owner } = await setupProjectAndUser();
      await store.save(project.id, {
        encryptedToken: encryption.encrypt('ghp_workerToken'),
        tokenHint: 'oken',
        provider: GitProvider.create('github'),
        createdByUserId: owner.id,
      });

      const decrypted = await store.loadDecrypted(project.id);

      expect(decrypted).toEqual({ token: 'ghp_workerToken', tokenHint: 'oken' });
    });

    it('returns null when the project has no stored credential', async () => {
      const { project } = await setupProjectAndUser();

      expect(await store.loadDecrypted(project.id)).toBeNull();
    });
  });
});
