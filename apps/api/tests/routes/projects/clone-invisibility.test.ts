import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AUDIT_AUTHZ_DENIED, FilePath, ProjectId } from '@asciidocollab/domain';
import { startTestContainer, stopTestContainer } from '@asciidocollab/testing';
import { buildServer } from '../../../src/index';
import { registerRoute } from '../../../src/routes/auth/register';
import { loginRoute } from '../../../src/routes/auth/login';
import { projectRoutes } from '../../../src/routes/projects';
import { fileTreeRoutes } from '../../../src/routes/projects/file-tree';
import { renderConfigRoutes } from '../../../src/routes/projects/render-config';
import { cloneRoutes } from '../../../src/routes/projects/clone';
import { requireAuth } from '../../../src/plugins/require-auth';
import { setupTestEnvironment } from '../../helpers/test-environment';

/**
 * A project row with file nodes and stored bytes but no membership row at all is
 * exactly the residue an abrupt stop mid-clone leaves behind: the clone writes
 * the project row first and the membership row last, so a process killed between
 * the two leaves the copy fully built and owned by nobody.
 *
 * The whole atomicity design rests on that residue being unreachable — no read
 * path may surface it, and nothing a user can count may include it. That premise
 * is what this file tests, and it can only be tested by putting the residue into
 * a real database by hand: a clone that fails cleans up after itself, so no
 * failing clone can leave the row standing long enough to look at.
 */
const TEST_PASSWORD = 'ValidP@ssw0rd123!';

/** Every read path a member of a project can reach it through. */
interface ProjectReadPaths {
  /** The project detail endpoint. */
  detail: number;
  /** The project's file tree. */
  fileTree: number;
  /** The project's render options. */
  renderConfig: number;
  /** Cloning the project, itself a project-scoped read of the whole thing. */
  clone: number;
}

function readCookie(header: string | string[] | undefined): string {
  if (typeof header === 'string') return header;
  if (Array.isArray(header)) return header.join('; ');
  throw new Error('Login did not set a session cookie');
}

describe('a project row carrying no membership row', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let testContext: Awaited<ReturnType<typeof startTestContainer>>;
  let passwordHash: string;
  let storageRoot: string;

  /** The user who would have owned the memberless project had the clone finished. */
  let intendedOwnerId: string;
  let intendedOwnerCookie: string;
  /** An unrelated user, to show the row is not merely hidden from its would-be owner. */
  let bystanderCookie: string;
  let bystanderId: string;

  /** The memberless project seeded straight into the database. */
  let orphanProjectId: string;

  beforeAll(async () => {
    setupTestEnvironment();
    storageRoot = mkdtempSync(path.join(tmpdir(), 'clone-invisibility-storage-'));
    process.env.ASCIIDOCOLLAB_STORAGE_PATH = storageRoot;
    process.env.ASCIIDOCOLLAB_PROJECT_CLONE_RATE_LIMIT_MAX = '200';

    testContext = await startTestContainer();
    app = await buildServer({ prisma: testContext.client });
    await app.register(registerRoute);
    await app.register(loginRoute);
    await app.register(async (scopedApp) => {
      scopedApp.addHook('preHandler', requireAuth);
      await scopedApp.register(projectRoutes);
      await scopedApp.register(fileTreeRoutes);
      await scopedApp.register(renderConfigRoutes);
      await scopedApp.register(cloneRoutes);
    });
    await app.ready();

    const seedEmail = `invisibility-seed-${Date.now()}@example.com`;
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: seedEmail, password: TEST_PASSWORD, displayName: 'Seed User' },
    });
    passwordHash = await app.services.passwordHasher.hash(TEST_PASSWORD);

    const intendedOwner = await createUser('intended-owner');
    intendedOwnerId = intendedOwner.userId;
    intendedOwnerCookie = intendedOwner.cookie;
    const bystander = await createUser('bystander');
    bystanderCookie = bystander.cookie;
    bystanderId = bystander.userId;

    orphanProjectId = await seedMemberlessProject();
  });

  afterAll(async () => {
    await app.close();
    await stopTestContainer(testContext);
  });

  async function createUser(label: string): Promise<{ userId: string; cookie: string }> {
    const userId = randomUUID();
    const email = `${label}-${Date.now()}-${userId.slice(0, 8)}@example.com`;
    await testContext.client.user.create({
      data: {
        id: userId,
        email,
        displayName: label,
        passwordHash,
        passwordHistory: [],
        samlSubject: null,
        mfaSecret: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
    });
    return { userId, cookie: readCookie(loginResponse.headers['set-cookie']) };
  }

  /**
   * Writes the residue by hand: the project row, its file nodes, a document row
   * and the bytes on disk — everything a finished clone has except the one write
   * that would make it reachable.
   */
  async function seedMemberlessProject(): Promise<string> {
    const projectId = randomUUID();
    const rootFolderId = randomUUID();
    const fileNodeId = randomUUID();

    await testContext.client.project.create({
      data: {
        id: projectId,
        name: 'Half-written copy',
        description: 'Everything but the membership row',
        tags: ['orphan'],
        language: null,
        mainFileNodeId: null,
      },
    });
    await testContext.client.fileNode.create({
      data: { id: rootFolderId, projectId, parentId: null, name: 'Half-written copy', type: 'FOLDER', path: '/' },
    });
    await testContext.client.fileNode.create({
      data: { id: fileNodeId, projectId, parentId: rootFolderId, name: 'intro.adoc', type: 'FILE', path: '/intro.adoc' },
    });
    await testContext.client.document.create({
      data: {
        id: randomUUID(),
        fileNodeId,
        contentId: randomUUID(),
        yjsStateId: randomUUID(),
        mimeType: 'text/asciidoc',
      },
    });
    await testContext.client.project.update({ where: { id: projectId }, data: { mainFileNodeId: fileNodeId } });

    await app.stores.fileStore.write(
      ProjectId.create(projectId),
      FilePath.create('/intro.adoc'),
      Buffer.from('= Half-written copy\n'),
    );

    return projectId;
  }

  async function listProjects(cookie: string, archived: boolean): Promise<{ ids: string[]; total: number }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects?limit=100&archived=${archived}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ids: string[] = body.data.map((project: { id: string }) => project.id);
    return { ids, total: body.pagination.total };
  }

  async function readProjectThroughEveryPath(cookie: string, projectId: string): Promise<ProjectReadPaths> {
    const [detail, fileTree, renderConfig, clone] = await Promise.all([
      app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: { cookie } }),
      app.inject({ method: 'GET', url: `/projects/${projectId}/files`, headers: { cookie } }),
      app.inject({ method: 'GET', url: `/api/projects/${projectId}/render-config`, headers: { cookie } }),
      app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/clone`,
        headers: { cookie },
        payload: { name: 'Copy of a row nobody owns' },
      }),
    ]);
    return {
      detail: detail.statusCode,
      fileTree: fileTree.statusCode,
      renderConfig: renderConfig.statusCode,
      clone: clone.statusCode,
    };
  }

  test('the seeded row really is in the database, and really has no members', async () => {
    // Without this the rest of the file would pass just as happily against nothing
    // at all: every assertion below is an absence, and an absence is satisfied by
    // a project that was never written.
    const stored = await testContext.client.project.findUnique({ where: { id: orphanProjectId } });
    expect(stored).not.toBeNull();
    expect(await testContext.client.projectMember.count({ where: { projectId: orphanProjectId } })).toBe(0);
    expect(await testContext.client.fileNode.count({ where: { projectId: orphanProjectId } })).toBe(2);
  });

  test('it is absent from the project listing of the user who would have owned it', async () => {
    const active = await listProjects(intendedOwnerCookie, false);
    expect(active.ids).not.toContain(orphanProjectId);
  });

  test('it is absent from the project listing of an unrelated user', async () => {
    const active = await listProjects(bystanderCookie, false);
    expect(active.ids).not.toContain(orphanProjectId);
  });

  test('it is absent from the archived listing too, where an unreachable row could otherwise hide', async () => {
    const archived = await listProjects(intendedOwnerCookie, true);
    expect(archived.ids).not.toContain(orphanProjectId);
  });

  test('it is not counted in the total the listing reports', async () => {
    // The listing's own total is the only count a user can observe, and a count
    // taken from a different query than the rows is exactly how an invisible row
    // still shows up — as a page that claims more projects than it lists.
    const active = await listProjects(intendedOwnerCookie, false);
    expect(active.total).toBe(active.ids.length);

    const archivedList = await listProjects(intendedOwnerCookie, true);
    expect(archivedList.total).toBe(archivedList.ids.length);
  });

  test('every project-scoped route refuses to open it for the user who would have owned it', async () => {
    const statuses = await readProjectThroughEveryPath(intendedOwnerCookie, orphanProjectId);
    expect(statuses).toEqual({ detail: 403, fileTree: 403, renderConfig: 403, clone: 403 });
  });

  test('every project-scoped route refuses to open it for an unrelated user', async () => {
    const statuses = await readProjectThroughEveryPath(bystanderCookie, orphanProjectId);
    expect(statuses).toEqual({ detail: 403, fileTree: 403, renderConfig: 403, clone: 403 });
  });

  test('the refused clone left nothing of its own behind', async () => {
    // Refuses here rather than relying on the tests above having done it: read on its own — under a
    // name filter, say — this would count the seeded orphan and pass while proving nothing.
    const refused = await readProjectThroughEveryPath(intendedOwnerCookie, orphanProjectId);
    expect(refused.clone).toBe(403);

    // A refusal that still wrote a project row would replace one orphan with two.
    const projectsOwnedByNobody = await testContext.client.project.count({ where: { members: { none: {} } } });
    expect(projectsOwnedByNobody).toBe(1);
  });

  test('a clone aimed at an id no project has is refused, and the database keeps the refusal', async () => {
    // The audit row's `projectId` is a real foreign key, so an entry scoped to a project that does
    // not exist is rejected by Postgres — and because audit writes are best-effort, that rejection
    // is swallowed. The refusal worth recording most, somebody walking the id space to learn which
    // projects exist, was therefore the only one never recorded. Only a real database can tell the
    // two behaviours apart: an in-memory repository enforces no foreign key and stores the broken
    // row as happily as the good one.
    const unknownProjectId = randomUUID();

    const refused = await app.inject({
      method: 'POST',
      url: `/api/projects/${unknownProjectId}/clone`,
      headers: { cookie: bystanderCookie },
      payload: { name: 'Copy of an id that names nothing' },
    });

    expect(refused.statusCode).toBe(403);

    const denial = await testContext.client.auditLog.findFirst({
      where: { action: AUDIT_AUTHZ_DENIED, resourceId: unknownProjectId },
    });
    expect(denial).not.toBeNull();
    expect(denial?.userId).toBe(bystanderId);
    expect(denial?.resourceType).toBe('Project');
    // Unscoped, which is the only way the row can exist at all: the id it names is not a project,
    // so it is carried as the resource that was asked for rather than as the project scope.
    expect(denial?.projectId).toBeNull();

    // Nothing was copied, so the refusal cost the store nothing either.
    expect(await testContext.client.project.count({ where: { id: unknownProjectId } })).toBe(0);
  });

  test('the very same row becomes visible and readable the moment a membership row exists', async () => {
    // The positive control for every assertion above. Each of them is satisfied by
    // an absence, so each would pass unchanged if the reads were broken, if the
    // seed had silently failed, or if the cookies were not logged in. Granting the
    // membership the interrupted clone never got to write turns all of them around
    // on the same row, through the same cookies, in the same server.
    await testContext.client.projectMember.create({
      data: { projectId: orphanProjectId, userId: intendedOwnerId, role: 'OWNER' },
    });

    try {
      const active = await listProjects(intendedOwnerCookie, false);
      expect(active.ids).toContain(orphanProjectId);
      expect(active.total).toBe(active.ids.length);

      const statuses = await readProjectThroughEveryPath(intendedOwnerCookie, orphanProjectId);
      expect(statuses.detail).toBe(200);
      expect(statuses.fileTree).toBe(200);
      expect(statuses.renderConfig).toBe(200);
      expect(statuses.clone).toBe(201);

      // The bystander is still refused, so it is membership that opened the row and
      // not the seeding, the login, or the passage of time.
      const bystander = await listProjects(bystanderCookie, false);
      expect(bystander.ids).not.toContain(orphanProjectId);
    } finally {
      await testContext.client.projectMember.deleteMany({ where: { projectId: orphanProjectId } });
      // Granting the membership turns the clone attempt from refused into successful, so this test
      // creates a real copy. Removing it keeps the file's counts a function of its own seed rather
      // than of which tests happened to run before them.
      await testContext.client.project.deleteMany({ where: { name: 'Copy of a row nobody owns' } });
    }
  });
});
