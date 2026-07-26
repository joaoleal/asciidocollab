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
} from '@asciidocollab/domain';
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
});
