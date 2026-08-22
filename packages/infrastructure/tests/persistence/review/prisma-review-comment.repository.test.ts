import { randomUUID } from 'crypto';
import {
  ReviewComment,
  ReviewCommentId,
  ReviewAnchor,
  ProjectId,
  DocumentId,
  UserId,
  FileNodeType,
  FilePath,
  Timestamps,
} from '@asciidocollab/domain';
import type { ReviewItemKind, ReviewItemStatus, AnchorState } from '@asciidocollab/domain';
import { PrismaClient } from '@prisma/client';
import { PrismaReviewCommentRepository } from '../../../src/persistence/review/prisma-review-comment.repository';
import { PrismaUserRepository } from '../../../src/persistence/user/prisma-user.repository';
import { PrismaProjectRepository } from '../../../src/persistence/project/prisma-project.repository';
import { PrismaFileNodeRepository } from '../../../src/persistence/file-tree/prisma-file-node.repository';
import { PrismaDocumentRepository } from '../../../src/persistence/file-tree/prisma-document.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';
import {
  createTestUser,
  createTestProject,
  createTestFileNode,
  createTestDocument,
  createTestReviewComment,
} from '../../helpers/test-data';

/** The slice of the Prisma client this repository drives, stubbed so the query can be asserted. */
function stubbed(): { calls: Record<string, jest.Mock>; stubRepo: PrismaReviewCommentRepository } {
  const calls = {
    create: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    deleteMany: jest.fn().mockResolvedValue({ count: 7 }),
    count: jest.fn().mockResolvedValue(4),
  };
  const stubClient = { reviewComment: calls } as unknown as PrismaClient;
  return { calls, stubRepo: new PrismaReviewCommentRepository(stubClient) };
}

/** A repository whose single stored row is `record`. */
function repoOver(record: Record<string, unknown>): PrismaReviewCommentRepository {
  const stubClient = { reviewComment: { findFirst: jest.fn().mockResolvedValue(record) } };
  return new PrismaReviewCommentRepository(stubClient as unknown as PrismaClient);
}

describe('PrismaReviewCommentRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: PrismaReviewCommentRepository;
  let userRepo: PrismaUserRepository;
  let projectRepo: PrismaProjectRepository;
  let fileNodeRepo: PrismaFileNodeRepository;
  let documentRepo: PrismaDocumentRepository;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaReviewCommentRepository(client);
    userRepo = new PrismaUserRepository(client);
    projectRepo = new PrismaProjectRepository(client);
    fileNodeRepo = new PrismaFileNodeRepository(client);
    documentRepo = new PrismaDocumentRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.reviewReaction.deleteMany();
    await client.reviewComment.deleteMany();
    await client.document.deleteMany();
    await client.fileNode.deleteMany();
    await client.project.deleteMany();
    await client.user.deleteMany();
  });

  /** Sets up user/project/fileNode/document FK parents and returns their ids. */
  async function setupDocument(): Promise<{ projectId: ProjectId; documentId: DocumentId; authorId: UserId }> {
    const owner = createTestUser();
    await userRepo.save(owner);
    const project = createTestProject();
    await projectRepo.save(project);
    const folder = createTestFileNode(project.id, { type: FileNodeType.create('folder'), path: FilePath.create('/docs') });
    await fileNodeRepo.save(folder);
    const file = createTestFileNode(project.id, { parentId: folder.id, name: 'doc.adoc', path: FilePath.create('/docs/doc.adoc') });
    await fileNodeRepo.save(file);
    const document = createTestDocument(file.id);
    await documentRepo.save(document);
    return { projectId: project.id, documentId: document.id, authorId: owner.id };
  }

  /** Adds a second document to an existing project (under its own folder) and returns its id. */
  async function addDocument(projectId: ProjectId, name: string): Promise<DocumentId> {
    const folder = createTestFileNode(projectId, {
      type: FileNodeType.create('folder'),
      name: 'extra',
      path: FilePath.create('/extra'),
    });
    await fileNodeRepo.save(folder);
    const file = createTestFileNode(projectId, { parentId: folder.id, name, path: FilePath.create(`/extra/${name}`) });
    await fileNodeRepo.save(file);
    const document = createTestDocument(file.id);
    await documentRepo.save(document);
    return document.id;
  }

  it('round-trips a root comment with anchor fields preserved', async () => {
    const { projectId, documentId, authorId } = await setupDocument();
    const relativePos = new Uint8Array([1, 2, 3, 4, 255]);
    const anchor = new ReviewAnchor(
      relativePos,
      { prefix: 'before ', exact: 'the passage', suffix: ' after' },
      42,
      'sect-intro',
      'located',
    );
    const comment = new ReviewComment(
      ReviewCommentId.create(randomUUID()),
      projectId,
      documentId,
      null,
      'comment',
      'A comment body',
      authorId,
      null,
      null,
      null,
      null,
      null,
      anchor,
    );
    await repo.create(comment);

    const found = await repo.findById(projectId, comment.id);
    expect(found).not.toBeNull();
    expect(found!.id.value).toBe(comment.id.value);
    expect(found!.body).toBe('A comment body');
    expect(found!.anchor).not.toBeNull();
    expect([...found!.anchor!.relPos!]).toEqual([1, 2, 3, 4, 255]);
    expect(found!.anchor!.quote).toEqual({ prefix: 'before ', exact: 'the passage', suffix: ' after' });
    expect(found!.anchor!.lineHint).toBe(42);
    expect(found!.anchor!.sectionId).toBe('sect-intro');
    expect(found!.anchor!.state).toBe('located');
  });

  it('persists a refreshed anchor line hint without disturbing the rest of the anchor', async () => {
    // The write path the collaboration server uses on write-back: re-measure the hint, persist, and
    // leave the relative-position pair, quote, section, state and updatedAt exactly as they were.
    const { projectId, documentId, authorId } = await setupDocument();
    const anchor = new ReviewAnchor(
      new Uint8Array([7, 7, 7]),
      { prefix: 'p ', exact: 'passage', suffix: ' s' },
      3,
      'sect-intro',
      'located',
    );
    const comment = new ReviewComment(
      ReviewCommentId.create(randomUUID()),
      projectId,
      documentId,
      null,
      'comment',
      'A comment body',
      authorId,
      null,
      null,
      null,
      null,
      null,
      anchor,
    );
    await repo.create(comment);
    const stored = await repo.findById(projectId, comment.id);

    expect(stored!.refreshAnchorLineHint(87)).toBe(true);
    await repo.update(stored!);

    const reloaded = await repo.findById(projectId, comment.id);
    expect(reloaded!.anchor!.lineHint).toBe(87);
    expect([...reloaded!.anchor!.relPos!]).toEqual([7, 7, 7]);
    expect(reloaded!.anchor!.quote!.exact).toBe('passage');
    expect(reloaded!.anchor!.sectionId).toBe('sect-intro');
    expect(reloaded!.anchor!.state).toBe('located');
    expect(reloaded!.updatedAt.getTime()).toBe(stored!.updatedAt.getTime());
  });

  it('scopes findById to the project (tenant filter)', async () => {
    const { projectId, documentId, authorId } = await setupDocument();
    const row = await createTestReviewComment(client, {
      projectId: projectId.value,
      documentId: documentId.value,
      authorId: authorId.value,
    });

    const foundSameTenant = await repo.findById(projectId, ReviewCommentId.create(row.id));
    expect(foundSameTenant).not.toBeNull();

    const otherProject = ProjectId.create(randomUUID());
    const foundOtherTenant = await repo.findById(otherProject, ReviewCommentId.create(row.id));
    expect(foundOtherTenant).toBeNull();
  });

  it('cascades a thread delete to its replies', async () => {
    const { projectId, documentId, authorId } = await setupDocument();
    const root = await createTestReviewComment(client, {
      projectId: projectId.value,
      documentId: documentId.value,
      authorId: authorId.value,
    });
    await createTestReviewComment(client, {
      projectId: projectId.value,
      documentId: documentId.value,
      authorId: authorId.value,
      parentId: root.id,
      body: 'a reply',
    });
    expect(await repo.countByDocument(projectId, documentId)).toBe(2);

    await repo.delete(projectId, ReviewCommentId.create(root.id));

    expect(await repo.countByDocument(projectId, documentId)).toBe(0);
  });

  it('does not delete across tenants', async () => {
    const { projectId, documentId, authorId } = await setupDocument();
    const row = await createTestReviewComment(client, {
      projectId: projectId.value,
      documentId: documentId.value,
      authorId: authorId.value,
    });

    await repo.delete(ProjectId.create(randomUUID()), ReviewCommentId.create(row.id));

    expect(await repo.findById(projectId, ReviewCommentId.create(row.id))).not.toBeNull();
  });

  it('applies the includeResolved filter, keeping replies of resolved roots', async () => {
    const { projectId, documentId, authorId } = await setupDocument();
    const resolvedRoot = await createTestReviewComment(client, {
      projectId: projectId.value,
      documentId: documentId.value,
      authorId: authorId.value,
      resolvedAt: new Date(),
      resolvedById: authorId.value,
    });
    await createTestReviewComment(client, {
      projectId: projectId.value,
      documentId: documentId.value,
      authorId: authorId.value,
    }); // unresolved root
    await createTestReviewComment(client, {
      projectId: projectId.value,
      documentId: documentId.value,
      authorId: authorId.value,
      parentId: resolvedRoot.id,
      body: 'reply to resolved root',
    });

    const withResolved = await repo.listByDocument(projectId, documentId, { includeResolved: true });
    expect(withResolved).toHaveLength(3);

    const withoutResolved = await repo.listByDocument(projectId, documentId, { includeResolved: false });
    // resolved root omitted; unresolved root + reply kept.
    expect(withoutResolved).toHaveLength(2);
    expect(withoutResolved.some((c) => c.id.value === resolvedRoot.id)).toBe(false);
    expect(withoutResolved.some((c) => c.isReply())).toBe(true);
  });

  it('filters listByProject by assignee and status', async () => {
    const { projectId, documentId, authorId } = await setupDocument();
    const assignee = createTestUser();
    await userRepo.save(assignee);

    await createTestReviewComment(client, {
      projectId: projectId.value,
      documentId: documentId.value,
      authorId: authorId.value,
      kind: 'TASK',
      status: 'OPEN',
      assigneeId: assignee.id.value,
    });
    await createTestReviewComment(client, {
      projectId: projectId.value,
      documentId: documentId.value,
      authorId: authorId.value,
      kind: 'TASK',
      status: 'RESOLVED',
      assigneeId: authorId.value,
      resolvedAt: new Date(),
      resolvedById: authorId.value,
    });

    const byAssignee = await repo.listByProject(projectId, { assigneeId: assignee.id });
    expect(byAssignee).toHaveLength(1);
    expect(byAssignee[0].assigneeId!.value).toBe(assignee.id.value);
    expect(byAssignee[0].status).toBe('open');

    const byStatus = await repo.listByProject(projectId, { status: 'resolved' });
    expect(byStatus).toHaveLength(1);
    expect(byStatus[0].status).toBe('resolved');
  });

  it('counts items on a document', async () => {
    const { projectId, documentId, authorId } = await setupDocument();
    await createTestReviewComment(client, { projectId: projectId.value, documentId: documentId.value, authorId: authorId.value });
    await createTestReviewComment(client, { projectId: projectId.value, documentId: documentId.value, authorId: authorId.value });
    await createTestReviewComment(client, { projectId: projectId.value, documentId: documentId.value, authorId: authorId.value });

    expect(await repo.countByDocument(projectId, documentId)).toBe(3);
    expect(await repo.countByProject(projectId)).toBe(3);
  });

  it('filters listByProject by document, and returns the whole project when no filter is given', async () => {
    const { projectId, documentId, authorId } = await setupDocument();
    const second = await addDocument(projectId, 'second.adoc');
    await createTestReviewComment(client, { projectId: projectId.value, documentId: documentId.value, authorId: authorId.value, body: 'on the first' });
    await createTestReviewComment(client, { projectId: projectId.value, documentId: second.value, authorId: authorId.value, body: 'on the second' });

    const onSecond = await repo.listByProject(projectId, { documentId: second });
    expect(onSecond.map((c) => c.body)).toEqual(['on the second']);
    expect(onSecond[0].documentId.value).toBe(second.value);

    const unfiltered = await repo.listByProject(projectId, {});
    expect(unfiltered.map((c) => c.body).toSorted()).toEqual(['on the first', 'on the second']);
  });

  it('deletes every item on one document, leaving the rest of the project intact', async () => {
    const { projectId, documentId, authorId } = await setupDocument();
    const second = await addDocument(projectId, 'second.adoc');
    await createTestReviewComment(client, { projectId: projectId.value, documentId: documentId.value, authorId: authorId.value });
    await createTestReviewComment(client, { projectId: projectId.value, documentId: documentId.value, authorId: authorId.value });
    await createTestReviewComment(client, { projectId: projectId.value, documentId: second.value, authorId: authorId.value });

    expect(await repo.deleteByDocument(projectId, documentId)).toBe(2);
    expect(await repo.countByDocument(projectId, documentId)).toBe(0);
    expect(await repo.countByProject(projectId)).toBe(1);
    // A second pass removes nothing.
    expect(await repo.deleteByDocument(projectId, documentId)).toBe(0);
  });

  it('deletes every item in the project and does not reach across tenants', async () => {
    const { projectId, documentId, authorId } = await setupDocument();
    await createTestReviewComment(client, { projectId: projectId.value, documentId: documentId.value, authorId: authorId.value });
    await createTestReviewComment(client, { projectId: projectId.value, documentId: documentId.value, authorId: authorId.value });

    expect(await repo.deleteByProject(ProjectId.create(randomUUID()))).toBe(0);
    expect(await repo.countByProject(projectId)).toBe(2);

    expect(await repo.deleteByProject(projectId)).toBe(2);
    expect(await repo.countByProject(projectId)).toBe(0);
  });

  describe('enum round-trips', () => {
    const statuses: { domain: ReviewItemStatus; column: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'WONTFIX' }[] = [
      { domain: 'open', column: 'OPEN' },
      { domain: 'in_progress', column: 'IN_PROGRESS' },
      { domain: 'resolved', column: 'RESOLVED' },
      { domain: 'wontfix', column: 'WONTFIX' },
    ];

    it.each(statuses)('stores and reads back the $domain task status as $column', async ({ domain, column }) => {
      const { projectId, documentId, authorId } = await setupDocument();
      const task = new ReviewComment(
        ReviewCommentId.create(randomUUID()),
        projectId,
        documentId,
        null,
        'task',
        'a task body',
        authorId,
        domain,
        authorId,
        new Date('2026-09-01T00:00:00.000Z'),
      );
      await repo.create(task);

      const row = await client.reviewComment.findUniqueOrThrow({ where: { id: task.id.value } });
      expect(row.kind).toBe('TASK');
      expect(row.status).toBe(column);

      const found = await repo.findById(projectId, task.id);
      expect(found!.kind).toBe('task');
      expect(found!.status).toBe(domain);
      expect(found!.assigneeId!.value).toBe(authorId.value);
      expect(found!.dueDate!.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    const anchorStates: { domain: AnchorState; column: 'LOCATED' | 'SECTION' | 'DETACHED' }[] = [
      { domain: 'located', column: 'LOCATED' },
      { domain: 'section', column: 'SECTION' },
      { domain: 'detached', column: 'DETACHED' },
    ];

    it.each(anchorStates)('stores and reads back the $domain anchor state as $column', async ({ domain, column }) => {
      const { projectId, documentId, authorId } = await setupDocument();
      const comment = new ReviewComment(
        ReviewCommentId.create(randomUUID()),
        projectId,
        documentId,
        null,
        'comment',
        'anchored body',
        authorId,
        null,
        null,
        null,
        null,
        null,
        new ReviewAnchor(null, { prefix: '', exact: 'passage', suffix: '' }, 5, 'sect-1', domain),
      );
      await repo.create(comment);

      const row = await client.reviewComment.findUniqueOrThrow({ where: { id: comment.id.value } });
      expect(row.anchorState).toBe(column);

      const found = await repo.findById(projectId, comment.id);
      expect(found!.anchor!.state).toBe(domain);
    });
  });

  it('maps a comment with neither author nor anchor to all-null columns and back', async () => {
    // The deleted-author case: `authorId` is SET NULL on user delete, and a root comment made
    // without a captured passage carries no anchor at all.
    const { projectId, documentId } = await setupDocument();
    const comment = new ReviewComment(
      ReviewCommentId.create(randomUUID()),
      projectId,
      documentId,
      null,
      'comment',
      'orphaned body',
      null,
    );
    await repo.create(comment);

    const row = await client.reviewComment.findUniqueOrThrow({ where: { id: comment.id.value } });
    expect(row.authorId).toBeNull();
    expect(row.status).toBeNull();
    expect(row.anchorRelPos).toBeNull();
    expect(row.anchorQuotePrefix).toBeNull();
    expect(row.anchorQuoteExact).toBeNull();
    expect(row.anchorQuoteSuffix).toBeNull();
    expect(row.anchorLineHint).toBeNull();
    expect(row.anchorSectionId).toBeNull();
    // No anchor still has to satisfy the NOT NULL anchorState column; `located` is the default.
    expect(row.anchorState).toBe('LOCATED');

    const found = await repo.findById(projectId, comment.id);
    expect(found!.authorId).toBeNull();
    expect(found!.anchor).toBeNull();
    expect(found!.status).toBeNull();
    expect(found!.body).toBe('orphaned body');
  });

  describe('query shapes handed to Prisma', () => {
    const projectId = ProjectId.create('11111111-1111-4111-8111-111111111111');
    const documentId = DocumentId.create('22222222-2222-4222-8222-222222222222');
    const commentId = ReviewCommentId.create('33333333-3333-4333-8333-333333333333');
    const userId = UserId.create('44444444-4444-4444-8444-444444444444');

    it('scopes findById by id and project, and returns null on a miss', async () => {
      const { calls, stubRepo } = stubbed();
      expect(await stubRepo.findById(projectId, commentId)).toBeNull();
      expect(calls.findFirst).toHaveBeenCalledWith({
        where: { id: commentId.value, projectId: projectId.value },
      });
    });

    it('omits the resolved filter entirely when resolved items are included', async () => {
      const { calls, stubRepo } = stubbed();
      await stubRepo.listByDocument(projectId, documentId, { includeResolved: true });
      expect(calls.findMany).toHaveBeenCalledWith({
        where: { projectId: projectId.value, documentId: documentId.value },
      });
    });

    it('adds exactly the reply-or-unresolved disjunction when resolved items are excluded', async () => {
      const { calls, stubRepo } = stubbed();
      await stubRepo.listByDocument(projectId, documentId, { includeResolved: false });
      expect(calls.findMany).toHaveBeenCalledWith({
        where: {
          projectId: projectId.value,
          documentId: documentId.value,
          OR: [{ parentId: { not: null } }, { resolvedAt: null }],
        },
      });
    });

    it('builds a project-only where clause when no filter is supplied', async () => {
      const { calls, stubRepo } = stubbed();
      await stubRepo.listByProject(projectId, {});
      expect(calls.findMany).toHaveBeenCalledWith({ where: { projectId: projectId.value } });
    });

    it('maps every supplied filter onto its own column', async () => {
      const { calls, stubRepo } = stubbed();
      await stubRepo.listByProject(projectId, { assigneeId: userId, status: 'in_progress', documentId });
      expect(calls.findMany).toHaveBeenCalledWith({
        where: {
          projectId: projectId.value,
          assigneeId: userId.value,
          status: 'IN_PROGRESS',
          documentId: documentId.value,
        },
      });
    });

    it('scopes delete by id and project, and the bulk deletes by their own keys', async () => {
      const { calls, stubRepo } = stubbed();
      await stubRepo.delete(projectId, commentId);
      expect(calls.deleteMany).toHaveBeenLastCalledWith({
        where: { id: commentId.value, projectId: projectId.value },
      });

      expect(await stubRepo.deleteByDocument(projectId, documentId)).toBe(7);
      expect(calls.deleteMany).toHaveBeenLastCalledWith({
        where: { projectId: projectId.value, documentId: documentId.value },
      });

      expect(await stubRepo.deleteByProject(projectId)).toBe(7);
      expect(calls.deleteMany).toHaveBeenLastCalledWith({ where: { projectId: projectId.value } });
    });

    it('counts with the same keys it deletes with', async () => {
      const { calls, stubRepo } = stubbed();
      expect(await stubRepo.countByDocument(projectId, documentId)).toBe(4);
      expect(calls.count).toHaveBeenLastCalledWith({
        where: { projectId: projectId.value, documentId: documentId.value },
      });

      expect(await stubRepo.countByProject(projectId)).toBe(4);
      expect(calls.count).toHaveBeenLastCalledWith({ where: { projectId: projectId.value } });
    });

    it('writes every column of a fully populated task', async () => {
      const { calls, stubRepo } = stubbed();
      const createdAt = new Date('2026-01-02T03:04:05.000Z');
      const updatedAt = new Date('2026-01-03T03:04:05.000Z');
      const resolvedAt = new Date('2026-01-04T03:04:05.000Z');
      const dueDate = new Date('2026-02-01T00:00:00.000Z');
      const task = new ReviewComment(
        commentId,
        projectId,
        documentId,
        null,
        'task',
        'do the thing',
        userId,
        'wontfix',
        userId,
        dueDate,
        resolvedAt,
        userId,
        new ReviewAnchor(new Uint8Array([9, 8, 7]), { prefix: 'p', exact: 'e', suffix: 's' }, 12, 'sect-9', 'section'),
        new Timestamps(createdAt, updatedAt),
      );

      await stubRepo.create(task);
      expect(calls.create).toHaveBeenCalledWith({
        data: {
          id: commentId.value,
          projectId: projectId.value,
          documentId: documentId.value,
          parentId: null,
          kind: 'TASK',
          body: 'do the thing',
          authorId: userId.value,
          status: 'WONTFIX',
          assigneeId: userId.value,
          dueDate,
          resolvedAt,
          resolvedById: userId.value,
          anchorRelPos: Buffer.from([9, 8, 7]),
          anchorQuotePrefix: 'p',
          anchorQuoteExact: 'e',
          anchorQuoteSuffix: 's',
          anchorLineHint: 12,
          anchorSectionId: 'sect-9',
          anchorState: 'SECTION',
          createdAt,
          updatedAt,
        },
      });
    });

    it('collapses a reply with no anchor to nulls and keys the update by id', async () => {
      const { calls, stubRepo } = stubbed();
      const parentId = ReviewCommentId.create('55555555-5555-4555-8555-555555555555');
      const createdAt = new Date('2026-01-02T03:04:05.000Z');
      const reply = new ReviewComment(
        commentId,
        projectId,
        documentId,
        parentId,
        'comment',
        'a reply',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        new Timestamps(createdAt, createdAt),
      );

      await stubRepo.update(reply);
      expect(calls.update).toHaveBeenCalledWith({
        where: { id: commentId.value },
        data: {
          id: commentId.value,
          projectId: projectId.value,
          documentId: documentId.value,
          parentId: parentId.value,
          kind: 'COMMENT',
          body: 'a reply',
          authorId: null,
          status: null,
          assigneeId: null,
          dueDate: null,
          resolvedAt: null,
          resolvedById: null,
          anchorRelPos: null,
          anchorQuotePrefix: null,
          anchorQuoteExact: null,
          anchorQuoteSuffix: null,
          anchorLineHint: null,
          anchorSectionId: null,
          anchorState: 'LOCATED',
          createdAt,
          updatedAt: createdAt,
        },
      });
    });

    it('refuses to persist a value outside the mapped enum rather than writing a wrong one', async () => {
      const { calls, stubRepo } = stubbed();

      const badKind = new ReviewComment(commentId, projectId, documentId, null, 'sketch' as ReviewItemKind, 'b', null, 'open');
      await expect(stubRepo.create(badKind)).rejects.toThrow('Unknown review item kind: sketch');

      const badStatus = new ReviewComment(commentId, projectId, documentId, null, 'task', 'b', null, 'archived' as ReviewItemStatus);
      await expect(stubRepo.create(badStatus)).rejects.toThrow('Unknown review item status: archived');

      const badAnchorState = new ReviewComment(
        commentId, projectId, documentId, null, 'comment', 'b', null, null, null, null, null, null,
        new ReviewAnchor(null, { prefix: '', exact: 'e', suffix: '' }, null, null, 'floating' as AnchorState),
      );
      await expect(stubRepo.create(badAnchorState)).rejects.toThrow('Unknown anchor state: floating');

      expect(calls.create).not.toHaveBeenCalled();
    });
  });

  describe('a stored row carrying a value the mapper does not know', () => {
    // The row has to be injected through a stubbed client: Postgres would accept a widened enum
    // (ALTER TYPE ... ADD VALUE), but Prisma's own deserializer rejects the unknown label before
    // the mapper ever sees it ("Value 'FLOATING' not found in enum 'AnchorState'"). These branches
    // guard against a schema/mapper drift that no database round-trip can reproduce.
    const rowId = '33333333-3333-4333-8333-333333333333';
    const projectId = ProjectId.create('11111111-1111-4111-8111-111111111111');

    /** A well-formed stored row, with `overrides` stamped over it. */
    function row(overrides: Record<string, unknown>): Record<string, unknown> {
      return {
        id: rowId,
        projectId: projectId.value,
        documentId: '22222222-2222-4222-8222-222222222222',
        parentId: null,
        kind: 'COMMENT',
        body: 'a body',
        authorId: null,
        status: null,
        assigneeId: null,
        dueDate: null,
        resolvedAt: null,
        resolvedById: null,
        anchorRelPos: null,
        anchorQuotePrefix: null,
        anchorQuoteExact: null,
        anchorQuoteSuffix: null,
        anchorLineHint: null,
        anchorSectionId: null,
        anchorState: 'LOCATED',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
      };
    }

    it('fails loudly on an unknown kind rather than guessing', async () => {
      await expect(
        repoOver(row({ kind: 'SKETCH' })).findById(projectId, ReviewCommentId.create(rowId)),
      ).rejects.toThrow('Unknown review item kind: SKETCH');
    });

    it('fails loudly on an unknown status rather than guessing', async () => {
      await expect(
        repoOver(row({ kind: 'TASK', status: 'ARCHIVED' })).findById(projectId, ReviewCommentId.create(rowId)),
      ).rejects.toThrow('Unknown review item status: ARCHIVED');
    });

    it('fails loudly on an unknown anchor state rather than guessing', async () => {
      await expect(
        repoOver(row({ anchorQuoteExact: 'passage', anchorState: 'FLOATING' })).findById(
          projectId,
          ReviewCommentId.create(rowId),
        ),
      ).rejects.toThrow('Unknown anchor state: FLOATING');
    });
  });
});
