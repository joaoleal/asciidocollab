import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FilePath, ProjectId } from '@asciidocollab/domain';
import { startTestContainer, stopTestContainer } from '@asciidocollab/testing';
import { buildServer } from '../../../src/index';
import { registerRoute } from '../../../src/routes/auth/register';
import { loginRoute } from '../../../src/routes/auth/login';
import { projectRoutes } from '../../../src/routes/projects';
import { fileTreeRoutes } from '../../../src/routes/projects/file-tree';
import { cloneRoutes } from '../../../src/routes/projects/clone';
import { requireAuth } from '../../../src/plugins/require-auth';
import { setupTestEnvironment } from '../../helpers/test-environment';

/**
 * What a copy must NOT carry over, checked against a real database rather than a
 * fake one. Every assertion here is an absence, so the seeding is the load-bearing
 * half of the file: a source with no collaborators, no discussion and no remote
 * would satisfy all of it while proving nothing.
 *
 * Two of the guarantees below cannot be stated against an in-memory fake at all —
 * that a clone which fails part-way leaves neither a row nor a directory behind
 * (the cleanup rides on real foreign-key cascades), and that two users copying the
 * same source at the same time get two independent copies.
 */
const TEST_PASSWORD = 'ValidP@ssw0rd123!';

/** The credential handle on the source's git remote; nothing may carry it into a copy. */
const SOURCE_CREDENTIAL_REF = 'vault://asciidocollab/source-project/deploy-key';

/** A registered user with a live session. */
interface TestUser {
  /** The user's row id. */
  id: string;
  /** The session cookie their login issued. */
  cookie: string;
}

/** The richly seeded source project, and the ids the assertions need from it. */
interface RichSource {
  /** The project every clone in this file copies. */
  projectId: string;
  /** The project's root folder node. */
  rootFolderId: string;
  /** The file node behind the source's one text document. */
  documentNodeId: string;
  /** The document row that the review discussion hangs off. */
  documentId: string;
  /** Every project-relative path the source's tree occupies. */
  paths: string[];
}

describe('what a project copy leaves behind', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let testContext: Awaited<ReturnType<typeof startTestContainer>>;
  let passwordHash: string;
  let storageRoot: string;

  let sourceOwner: TestUser;
  let cloner: TestUser;
  let editorMember: TestUser;
  let viewerMember: TestUser;
  let bystander: TestUser;

  let source: RichSource;
  /** The copy the exclusion assertions all read. */
  let cloneId: string;

  beforeAll(async () => {
    setupTestEnvironment();
    storageRoot = mkdtempSync(path.join(tmpdir(), 'clone-exclusions-storage-'));
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
      await scopedApp.register(cloneRoutes);
    });
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: `exclusions-seed-${Date.now()}@example.com`,
        password: TEST_PASSWORD,
        displayName: 'Seed User',
      },
    });
    passwordHash = await app.services.passwordHasher.hash(TEST_PASSWORD);

    sourceOwner = await createUser('source-owner');
    cloner = await createUser('cloner');
    editorMember = await createUser('editor-member');
    viewerMember = await createUser('viewer-member');
    bystander = await createUser('bystander');

    source = await seedRichSource();

    const response = await clone(cloner.cookie, source.projectId, 'Copy of the rich source');
    expect(response.statusCode).toBe(201);
    cloneId = response.json().data.id;
  });

  afterAll(async () => {
    await app.close();
    await stopTestContainer(testContext);
  });

  async function createUser(label: string): Promise<TestUser> {
    const id = randomUUID();
    const email = `${label}-${Date.now()}-${id.slice(0, 8)}@example.com`;
    await testContext.client.user.create({
      data: {
        id,
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
    const header = loginResponse.headers['set-cookie'];
    if (typeof header !== 'string') throw new Error(`Login for ${label} issued no session cookie`);
    return { id, cookie: header };
  }

  function clone(cookie: string, projectId: string, name: string) {
    return app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/clone`,
      headers: { cookie },
      payload: { name },
    });
  }

  async function createProject(owner: TestUser, name: string): Promise<{ projectId: string; rootFolderId: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { name, description: 'The original', tags: ['handbook'] },
    });
    expect(response.statusCode).toBe(201);
    const { id, rootFolderId } = response.json().data;
    return { projectId: id, rootFolderId };
  }

  async function addTextFile(
    projectId: string,
    parentId: string,
    name: string,
    filePath: string,
    body: string,
  ): Promise<{ fileNodeId: string; documentId: string }> {
    const fileNodeId = randomUUID();
    const documentId = randomUUID();
    await testContext.client.fileNode.create({
      data: { id: fileNodeId, projectId, parentId, name, type: 'FILE', path: filePath },
    });
    await testContext.client.document.create({
      data: {
        id: documentId,
        fileNodeId,
        contentId: randomUUID(),
        yjsStateId: randomUUID(),
        mimeType: 'text/asciidoc',
      },
    });
    await app.stores.fileStore.write(ProjectId.create(projectId), FilePath.create(filePath), Buffer.from(body));
    return { fileNodeId, documentId };
  }

  /**
   * Fills the source with everything a working project accumulates around its
   * content: collaborators, a review discussion with replies and reactions, each
   * author's dismissed grammar issues, a git remote holding a credential handle,
   * and a governance history. None of it describes the content, and none of it may
   * follow the content into a copy.
   */
  async function seedRichSource(): Promise<RichSource> {
    const { projectId, rootFolderId } = await createProject(sourceOwner, 'Team handbook');

    const chaptersFolderId = randomUUID();
    await testContext.client.fileNode.create({
      data: { id: chaptersFolderId, projectId, parentId: rootFolderId, name: 'chapters', type: 'FOLDER', path: '/chapters' },
    });
    await app.stores.fileStore.createDirectory(ProjectId.create(projectId), FilePath.create('/chapters'));

    const intro = await addTextFile(
      projectId,
      chaptersFolderId,
      'intro.adoc',
      '/chapters/intro.adoc',
      '= Introduction\n\nA paragraph the reviewers argued about.\n',
    );
    await testContext.client.project.update({
      where: { id: projectId },
      data: { mainFileNodeId: intro.fileNodeId },
    });

    const logoNodeId = randomUUID();
    await testContext.client.fileNode.create({
      data: { id: logoNodeId, projectId, parentId: rootFolderId, name: 'logo.png', type: 'FILE', path: '/logo.png' },
    });
    const logoBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    await testContext.client.asset.create({
      data: { id: logoNodeId, mimeType: 'image/png', sizeBytes: BigInt(logoBytes.length) },
    });
    await app.stores.fileStore.write(ProjectId.create(projectId), FilePath.create('/logo.png'), logoBytes);

    // Collaborators at three different roles beyond the owner.
    await testContext.client.projectMember.createMany({
      data: [
        { projectId, userId: cloner.id, role: 'VIEWER' },
        { projectId, userId: editorMember.id, role: 'EDITOR' },
        { projectId, userId: viewerMember.id, role: 'VIEWER' },
      ],
    });

    // A review discussion: a comment, a reply beneath it, and an open task — a task
    // being a review row of its own kind rather than a table of its own.
    const commentId = randomUUID();
    const replyId = randomUUID();
    const taskId = randomUUID();
    await testContext.client.reviewComment.create({
      data: {
        id: commentId,
        projectId,
        documentId: intro.documentId,
        parentId: null,
        kind: 'COMMENT',
        body: 'This opening buries the point.',
        authorId: editorMember.id,
        anchorLineHint: 1,
      },
    });
    await testContext.client.reviewComment.create({
      data: {
        id: replyId,
        projectId,
        documentId: intro.documentId,
        parentId: commentId,
        kind: 'COMMENT',
        body: 'Agreed — reordering it.',
        authorId: sourceOwner.id,
        anchorLineHint: 1,
      },
    });
    await testContext.client.reviewComment.create({
      data: {
        id: taskId,
        projectId,
        documentId: intro.documentId,
        parentId: null,
        kind: 'TASK',
        body: 'Rewrite the opening paragraph.',
        authorId: sourceOwner.id,
        status: 'OPEN',
        assigneeId: editorMember.id,
        anchorLineHint: 3,
      },
    });
    await testContext.client.reviewReaction.createMany({
      data: [
        { id: randomUUID(), reviewCommentId: commentId, userId: sourceOwner.id, emoji: '👍' },
        { id: randomUUID(), reviewCommentId: replyId, userId: editorMember.id, emoji: '🎉' },
        { id: randomUUID(), reviewCommentId: taskId, userId: viewerMember.id, emoji: '👀' },
      ],
    });

    // Each author's own dismissed grammar issues for the document.
    await testContext.client.ignoredLint.createMany({
      data: [
        { id: randomUUID(), userId: sourceOwner.id, documentId: intro.fileNodeId, ignoredLintsJson: '{"lints":["a"]}' },
        { id: randomUUID(), userId: editorMember.id, documentId: intro.fileNodeId, ignoredLintsJson: '{"lints":["b"]}' },
      ],
    });

    await testContext.client.gitRepository.create({
      data: {
        id: randomUUID(),
        projectId,
        provider: 'GITHUB',
        remoteUrl: 'https://github.com/example/team-handbook.git',
        credentialRef: SOURCE_CREDENTIAL_REF,
        currentBranch: 'main',
      },
    });

    await testContext.client.auditLog.createMany({
      data: [
        { id: randomUUID(), userId: sourceOwner.id, projectId, action: 'project.updated', resourceType: 'Project', resourceId: projectId },
        { id: randomUUID(), userId: sourceOwner.id, projectId, action: 'member.added', resourceType: 'ProjectMember', resourceId: editorMember.id },
        { id: randomUUID(), userId: editorMember.id, projectId, action: 'file.created', resourceType: 'FileNode', resourceId: intro.fileNodeId },
        { id: randomUUID(), userId: sourceOwner.id, projectId, action: 'authz.denied', resourceType: 'Project', resourceId: projectId },
      ],
    });

    // Settings that DO describe the content, so the exclusions below are read
    // against a copy that demonstrably carried something across.
    await testContext.client.projectRenderConfig.create({
      data: { id: randomUUID(), projectId, config: { doctype: 'book', toc: true } },
    });
    await testContext.client.projectDictionaryTerm.createMany({
      data: [
        { id: randomUUID(), projectId, term: 'AsciiDoCollab', createdByUserId: sourceOwner.id },
        { id: randomUUID(), projectId, term: 'Hocuspocus', createdByUserId: editorMember.id },
      ],
    });

    return {
      projectId,
      rootFolderId,
      documentNodeId: intro.fileNodeId,
      documentId: intro.documentId,
      paths: ['/', '/chapters', '/chapters/intro.adoc', '/logo.png'],
    };
  }

  async function listedProjectIds(cookie: string): Promise<string[]> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects?limit=100',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json().data.map((project: { id: string }) => project.id).toSorted();
  }

  test('the source really carries everything the exclusions are about', async () => {
    // The guard on every absence below. Each of them would hold just as well
    // against a source that had none of this to begin with.
    const [members, comments, tasks, reactions, lints, git, audits] = await Promise.all([
      testContext.client.projectMember.count({ where: { projectId: source.projectId } }),
      testContext.client.reviewComment.count({ where: { projectId: source.projectId, kind: 'COMMENT' } }),
      testContext.client.reviewComment.count({ where: { projectId: source.projectId, kind: 'TASK' } }),
      testContext.client.reviewReaction.count({ where: { comment: { projectId: source.projectId } } }),
      testContext.client.ignoredLint.count({ where: { fileNode: { projectId: source.projectId } } }),
      testContext.client.gitRepository.count({ where: { projectId: source.projectId } }),
      testContext.client.auditLog.findMany({ where: { projectId: source.projectId } }),
    ]);
    expect(members).toBe(4);
    expect(comments).toBe(2);
    expect(tasks).toBe(1);
    expect(reactions).toBe(3);
    expect(lints).toBe(2);
    expect(git).toBe(1);
    // The four seeded entries, the one its own creation wrote, and the one the copy
    // recorded against it — a history with six distinct things in it for the copy
    // to have inherited and did not.
    expect(audits.map((entry) => entry.action).toSorted()).toEqual([
      'authz.denied',
      'file.created',
      'member.added',
      'project.clone_requested',
      'project.created',
      'project.updated',
    ]);
  });

  test('the copy carried the content across, so the exclusions are read against a real copy', async () => {
    const nodes = await testContext.client.fileNode.findMany({ where: { projectId: cloneId } });
    expect(nodes.map((node) => node.path).toSorted()).toEqual(source.paths.toSorted());

    const renderConfig = await testContext.client.projectRenderConfig.findUnique({ where: { projectId: cloneId } });
    expect(renderConfig?.config).toEqual({ doctype: 'book', toc: true });

    const terms = await testContext.client.projectDictionaryTerm.findMany({ where: { projectId: cloneId } });
    expect(terms.map((term) => term.term).toSorted()).toEqual(['AsciiDoCollab', 'Hocuspocus']);
  });

  test('the copy has exactly one member: the user who asked for it, as its owner', async () => {
    const members = await testContext.client.projectMember.findMany({ where: { projectId: cloneId } });
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(cloner.id);
    expect(members[0].role).toBe('OWNER');
  });

  test('the copy carries no review comments and no review tasks', async () => {
    expect(await testContext.client.reviewComment.count({ where: { projectId: cloneId } })).toBe(0);

    // A review row names a document as well as a project, so a copy could inherit
    // the discussion through its documents even with its own project id nowhere on
    // the rows.
    const cloneDocuments = await testContext.client.document.findMany({
      where: { fileNode: { projectId: cloneId } },
      select: { id: true },
    });
    expect(cloneDocuments.length).toBeGreaterThan(0);
    const byDocument = await testContext.client.reviewComment.count({
      where: { documentId: { in: cloneDocuments.map((document) => document.id) } },
    });
    expect(byDocument).toBe(0);
  });

  test('the copy carries no reactions', async () => {
    expect(await testContext.client.reviewReaction.count({ where: { comment: { projectId: cloneId } } })).toBe(0);
  });

  test('the copy carries no dismissed grammar issues', async () => {
    expect(await testContext.client.ignoredLint.count({ where: { fileNode: { projectId: cloneId } } })).toBe(0);
  });

  test('the copy has no git remote, and the source credential handle appears on no other row', async () => {
    expect(await testContext.client.gitRepository.findUnique({ where: { projectId: cloneId } })).toBeNull();

    const carryingTheCredential = await testContext.client.gitRepository.findMany({
      where: { credentialRef: SOURCE_CREDENTIAL_REF },
    });
    expect(carryingTheCredential).toHaveLength(1);
    expect(carryingTheCredential[0].projectId).toBe(source.projectId);
  });

  test('the copy history holds its own creation and nothing of the source history', async () => {
    const entries = await testContext.client.auditLog.findMany({ where: { projectId: cloneId } });
    expect(entries.map((entry) => entry.action)).toEqual(['project.cloned']);
    expect(entries[0].userId).toBe(cloner.id);
    expect(entries[0].resourceId).toBe(cloneId);
  });

  test('a copy that fails part-way leaves no project row and no directory on disk', async () => {
    const owner = await createUser('broken-source-owner');
    const { projectId, rootFolderId } = await createProject(owner, 'Source with a hole in it');
    await addTextFile(projectId, rootFolderId, 'good.adoc', '/good.adoc', '= Readable\n');

    // A file node and a document row whose bytes were never written: the copy walks
    // into it half-way through, after its own project row and its own storage
    // directory already exist.
    const brokenNodeId = randomUUID();
    await testContext.client.fileNode.create({
      data: { id: brokenNodeId, projectId, parentId: rootFolderId, name: 'unreadable.adoc', type: 'FILE', path: '/unreadable.adoc' },
    });
    await testContext.client.document.create({
      data: {
        id: randomUUID(),
        fileNodeId: brokenNodeId,
        contentId: randomUUID(),
        yjsStateId: randomUUID(),
        mimeType: 'text/asciidoc',
      },
    });
    expect(existsSync(path.join(storageRoot, projectId, 'unreadable.adoc'))).toBe(false);

    const directoriesBefore = readdirSync(storageRoot).toSorted();
    const listingsBefore = await Promise.all(
      [owner, cloner, sourceOwner, editorMember, viewerMember, bystander].map((user) => listedProjectIds(user.cookie)),
    );
    const projectRowsBefore = await testContext.client.project.count();

    const response = await clone(owner.cookie, projectId, 'Copy that cannot finish');
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('CLONE_FAILED');

    const listingsAfter = await Promise.all(
      [owner, cloner, sourceOwner, editorMember, viewerMember, bystander].map((user) => listedProjectIds(user.cookie)),
    );
    expect(listingsAfter).toEqual(listingsBefore);

    expect(readdirSync(storageRoot).toSorted()).toEqual(directoriesBefore);
    expect(await testContext.client.project.count()).toBe(projectRowsBefore);
    // A row the cleanup missed would be unreachable forever: nothing that walks
    // visible projects would ever find it again.
    expect(await testContext.client.project.count({ where: { members: { none: {} } } })).toBe(0);
  });

  test('two users copying the same source at once each get their own independent copy', async () => {
    const [firstResponse, secondResponse] = await Promise.all([
      clone(viewerMember.cookie, source.projectId, 'Concurrent copy one'),
      clone(editorMember.cookie, source.projectId, 'Concurrent copy two'),
    ]);

    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(201);

    const firstId = firstResponse.json().data.id;
    const secondId = secondResponse.json().data.id;
    expect(firstId).not.toBe(secondId);

    const owners = await Promise.all(
      [firstId, secondId].map((projectId) => testContext.client.projectMember.findMany({ where: { projectId } })),
    );
    expect(owners[0]).toHaveLength(1);
    expect(owners[1]).toHaveLength(1);
    expect(owners[0][0].userId).toBe(viewerMember.id);
    expect(owners[1][0].userId).toBe(editorMember.id);

    const [firstNodes, secondNodes] = await Promise.all(
      [firstId, secondId].map((projectId) => testContext.client.fileNode.findMany({ where: { projectId } })),
    );
    expect(firstNodes.map((node) => node.path).toSorted()).toEqual(source.paths.toSorted());
    expect(secondNodes.map((node) => node.path).toSorted()).toEqual(source.paths.toSorted());

    const firstNodeIds = new Set(firstNodes.map((node) => node.id));
    const secondNodeIds = new Set(secondNodes.map((node) => node.id));
    expect([...firstNodeIds].filter((id) => secondNodeIds.has(id))).toEqual([]);

    // Each copy's tree must close over itself: a parent pointer reaching into the
    // other copy would make one clone's rename or delete move the other's files.
    const copies = [
      { nodes: firstNodes, ownIds: firstNodeIds },
      { nodes: secondNodes, ownIds: secondNodeIds },
    ];
    for (const copy of copies) {
      for (const node of copy.nodes) {
        if (node.parentId !== null) expect(copy.ownIds.has(node.parentId)).toBe(true);
      }
    }

    const sourceNodes = await testContext.client.fileNode.findMany({ where: { projectId: source.projectId } });
    const sourceNodeIds = new Set(sourceNodes.map((node) => node.id));
    expect([...firstNodeIds].filter((id) => sourceNodeIds.has(id))).toEqual([]);
    expect([...secondNodeIds].filter((id) => sourceNodeIds.has(id))).toEqual([]);
  });
});
