/**
 * @file Everything a clone must leave behind, asserted against a source that
 * actually has it. Each store is seeded before the copy runs, so "the copy has
 * none" is a statement about the copy rather than about an empty fixture.
 *
 * Two further exclusions are deliberately absent here. The copy's single owner
 * membership and the copy's own audit trail are asserted in
 * `clone-project.test.ts`, under `membership as the commit point` and
 * `the audit trail`, because those are the sections that cover the writes
 * producing them — the exclusion is one half of a behaviour tested there, not a
 * separate fact. Repeating them here would duplicate assertions, and a
 * duplicate is the kind that quietly stops being kept in step.
 */
import { CloneProjectUseCase } from '../../../src/use-cases/project/clone-project';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryActiveCloneRegistry } from '../../ports/project/in-memory-active-clone-registry';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryAssetRepository } from '../../ports/file-tree/in-memory-asset.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';
import { InMemoryCollaborationSessionRepository } from '../../ports/project/in-memory-collaboration-session-repository';
import { InMemoryProjectRenderConfigRepository } from '../../ports/project/in-memory-project-render-config.repository';
import { InMemoryProjectDictionaryRepository } from '../../ports/grammar/in-memory-project-dictionary.repository';
import { InMemoryReviewCommentRepository } from '../../ports/review/in-memory-review-comment.repository';
import { InMemoryReviewReactionRepository } from '../../ports/review/in-memory-review-reaction.repository';
import { InMemoryIgnoredLintRepository } from '../../ports/grammar/in-memory-ignored-lint.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryTemplateRepository } from '../../ports/project/in-memory-template.repository';
import { CollaborativeContentReader } from '../../../src/ports/storage/collaborative-content-reader';
import { Project } from '../../../src/entities/project';
import { ProjectMember } from '../../../src/entities/project-member';
import { FileNode } from '../../../src/entities/file-node';
import { Document } from '../../../src/entities/document';
import { Asset } from '../../../src/entities/asset';
import { ReviewComment } from '../../../src/entities/review-comment';
import { ReviewReaction } from '../../../src/entities/review-reaction';
import { IgnoredLint } from '../../../src/entities/ignored-lint';
import { GitRepository } from '../../../src/entities/git-repository';
import { Template } from '../../../src/entities/template';
import { REVIEW_ITEM_KINDS, ReviewItemKind } from '../../../src/constants/review';
import { ReviewAnchor } from '../../../src/value-objects/review/review-anchor';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { ReviewCommentId } from '../../../src/value-objects/ids/review-comment-id';
import { ReviewReactionId } from '../../../src/value-objects/ids/review-reaction-id';
import { IgnoredLintId } from '../../../src/value-objects/ids/ignored-lint-id';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { TemplateId } from '../../../src/value-objects/ids/template-id';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { ProjectName } from '../../../src/value-objects/project/project-name';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { TemplateCategory } from '../../../src/value-objects/project/template-category';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { Role } from '../../../src/value-objects/identity/role';

const OWNER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440000');
const EDITOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const VIEWER_ID = UserId.create('550e8400-e29b-41d4-a716-446655440002');
const SOURCE_PROJECT_ID = ProjectId.create('660e8400-e29b-41d4-a716-446655440001');
const SOURCE_ROOT_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440000');
const SOURCE_CHAPTERS_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440001');
const SOURCE_INTRO_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440002');
const SOURCE_APPENDIX_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440003');
const SOURCE_NOTES_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440004');
const SOURCE_IMAGES_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440005');
const SOURCE_LOGO_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440006');
const SOURCE_INDEX_ID = FileNodeId.create('770e8400-e29b-41d4-a716-446655440007');

const SOURCE_INDEX_DOCUMENT_ID = DocumentId.create('880e8400-e29b-41d4-a716-446655440001');
const SOURCE_INTRO_DOCUMENT_ID = DocumentId.create('880e8400-e29b-41d4-a716-446655440002');
const SOURCE_NOTES_DOCUMENT_ID = DocumentId.create('880e8400-e29b-41d4-a716-446655440003');

const FOLDER = FileNodeType.create('folder');
const FILE = FileNodeType.create('file');

const ASCIIDOC = MimeType.create('text/asciidoc');
const PNG = MimeType.create('image/png');

const INDEX_BYTES = Buffer.from('= Handbook\n\ninclude::chapters/intro.adoc[]\n', 'utf8');
const INTRO_BYTES = Buffer.from('== Intro\n\nWelcome to the handbook.\n', 'utf8');
const NOTES_BYTES = Buffer.from('== Notes\n\nStray thoughts.\n', 'utf8');
const LOGO_BYTES = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE, 0x00, 0x80]);

const SOURCE_FILE_BYTES: ReadonlyArray<readonly [string, Buffer]> = [
  ['/index.adoc', INDEX_BYTES],
  ['/chapters/intro.adoc', INTRO_BYTES],
  ['/chapters/appendix/notes.adoc', NOTES_BYTES],
  ['/images/logo.png', LOGO_BYTES],
];

/** Every user who could have left private or attributed state on the source. */
const ALL_USER_IDS: readonly UserId[] = [OWNER_ID, EDITOR_ID, VIEWER_ID];

function sourceRootNode(): FileNode {
  return new FileNode(SOURCE_ROOT_ID, SOURCE_PROJECT_ID, null, 'Handbook', FOLDER, FilePath.create('/'));
}

/** A source tree two folder levels deep, with files at every level. */
function nestedSourceNodes(): FileNode[] {
  return [
    new FileNode(SOURCE_INDEX_ID, SOURCE_PROJECT_ID, SOURCE_ROOT_ID, 'index.adoc', FILE, FilePath.create('/index.adoc')),
    new FileNode(SOURCE_CHAPTERS_ID, SOURCE_PROJECT_ID, SOURCE_ROOT_ID, 'chapters', FOLDER, FilePath.create('/chapters')),
    new FileNode(
      SOURCE_INTRO_ID,
      SOURCE_PROJECT_ID,
      SOURCE_CHAPTERS_ID,
      'intro.adoc',
      FILE,
      FilePath.create('/chapters/intro.adoc'),
    ),
    new FileNode(
      SOURCE_APPENDIX_ID,
      SOURCE_PROJECT_ID,
      SOURCE_CHAPTERS_ID,
      'appendix',
      FOLDER,
      FilePath.create('/chapters/appendix'),
    ),
    new FileNode(
      SOURCE_NOTES_ID,
      SOURCE_PROJECT_ID,
      SOURCE_APPENDIX_ID,
      'notes.adoc',
      FILE,
      FilePath.create('/chapters/appendix/notes.adoc'),
    ),
    new FileNode(SOURCE_IMAGES_ID, SOURCE_PROJECT_ID, SOURCE_ROOT_ID, 'images', FOLDER, FilePath.create('/images')),
    new FileNode(
      SOURCE_LOGO_ID,
      SOURCE_PROJECT_ID,
      SOURCE_IMAGES_ID,
      'logo.png',
      FILE,
      FilePath.create('/images/logo.png'),
    ),
  ];
}

/** The three text documents the nested source tree carries, one per `.adoc` file. */
function sourceDocuments(): Document[] {
  return [
    new Document(
      SOURCE_INDEX_DOCUMENT_ID,
      SOURCE_INDEX_ID,
      ContentId.create('990e8400-e29b-41d4-a716-446655440001'),
      YjsStateId.create('aa0e8400-e29b-41d4-a716-446655440001'),
      ASCIIDOC,
    ),
    new Document(
      SOURCE_INTRO_DOCUMENT_ID,
      SOURCE_INTRO_ID,
      ContentId.create('990e8400-e29b-41d4-a716-446655440002'),
      YjsStateId.create('aa0e8400-e29b-41d4-a716-446655440002'),
      ASCIIDOC,
    ),
    new Document(
      SOURCE_NOTES_DOCUMENT_ID,
      SOURCE_NOTES_ID,
      ContentId.create('990e8400-e29b-41d4-a716-446655440003'),
      YjsStateId.create('aa0e8400-e29b-41d4-a716-446655440003'),
      ASCIIDOC,
    ),
  ];
}

/** Seeds the whole nested source project: its nodes, its rows and its stored bytes. */
async function seedNestedSource(
  fileNodeRepo: InMemoryFileNodeRepository,
  documentRepo: InMemoryDocumentRepository,
  assetRepo: InMemoryAssetRepository,
  fileStore: InMemoryProjectFileStore,
): Promise<void> {
  for (const node of nestedSourceNodes()) {
    await fileNodeRepo.save(node);
  }
  for (const document of sourceDocuments()) {
    await documentRepo.save(document);
  }
  await assetRepo.save(new Asset(SOURCE_LOGO_ID, PNG, BigInt(LOGO_BYTES.length)));
  for (const [path, bytes] of SOURCE_FILE_BYTES) {
    await fileStore.write(SOURCE_PROJECT_ID, FilePath.create(path), bytes);
  }
}

const SOURCE_COMMENT_ID = ReviewCommentId.create('ee0e8400-e29b-41d4-a716-446655440001');
const SOURCE_TASK_ID = ReviewCommentId.create('ee0e8400-e29b-41d4-a716-446655440002');
const SOURCE_REPLY_ID = ReviewCommentId.create('ee0e8400-e29b-41d4-a716-446655440003');

/**
 * The two review-item kinds paired with the id each is seeded under. A task is
 * the same row as a comment with a different kind, so a suite that only ever
 * seeds comments never exercises the task case at all.
 */
const REVIEW_ITEM_KIND_CASES: ReadonlyArray<readonly [ReviewItemKind, ReviewCommentId]> = [
  ['comment', SOURCE_COMMENT_ID],
  ['task', SOURCE_TASK_ID],
];

/** A root review item of either kind, anchored in the source's index document. */
function sourceReviewItem(kind: ReviewItemKind, id: ReviewCommentId): ReviewComment {
  const anchor = new ReviewAnchor(null, { prefix: '= ', exact: 'Handbook', suffix: '\n' }, 1, null);
  return new ReviewComment(
    id,
    SOURCE_PROJECT_ID,
    SOURCE_INDEX_DOCUMENT_ID,
    null,
    kind,
    kind === 'task' ? 'Rewrite the opening paragraph.' : 'This heading reads oddly.',
    EDITOR_ID,
    kind === 'task' ? 'open' : null,
    kind === 'task' ? OWNER_ID : null,
    null,
    null,
    null,
    anchor,
  );
}

/** A reply hanging off the seeded root comment, so a whole thread exists to be missed. */
function sourceReviewReply(): ReviewComment {
  return new ReviewComment(
    SOURCE_REPLY_ID,
    SOURCE_PROJECT_ID,
    SOURCE_INDEX_DOCUMENT_ID,
    SOURCE_COMMENT_ID,
    'comment',
    'Agreed, I will take it.',
    OWNER_ID,
  );
}

const SOURCE_REACTIONS: ReadonlyArray<readonly [string, UserId, string]> = [
  ['ff0e8400-e29b-41d4-a716-446655440001', OWNER_ID, '👍'],
  ['ff0e8400-e29b-41d4-a716-446655440002', VIEWER_ID, '🎉'],
];

const SOURCE_IGNORED_LINTS: ReadonlyArray<readonly [string, UserId, FileNodeId]> = [
  ['ab0e8400-e29b-41d4-a716-446655440001', OWNER_ID, SOURCE_INTRO_ID],
  ['ab0e8400-e29b-41d4-a716-446655440002', EDITOR_ID, SOURCE_INDEX_ID],
];

const SOURCE_GIT_REPOSITORY_ID = GitRepositoryId.create('ac0e8400-e29b-41d4-a716-446655440001');
/** The handle the source's stored git credentials are fetched by; the copy must not name it. */
const SOURCE_CREDENTIAL_REFERENCE = 'vault://projects/handbook/git-token';

const SOURCE_TEMPLATE_ID = TemplateId.create('ad0e8400-e29b-41d4-a716-446655440001');

/** Runs a clone that has to succeed, and hands back the copy's project id. */
async function cloneOf(useCase: CloneProjectUseCase, actorId: UserId): Promise<ProjectId> {
  const result = await useCase.execute(actorId, SOURCE_PROJECT_ID, 'Handbook copy');

  expect(result.success).toBe(true);
  if (!result.success) throw result.error;
  return result.value.project.id;
}

/** The copy's own document ids, which are the addresses a copied review row would carry. */
async function cloneDocumentIds(
  fileNodeRepo: InMemoryFileNodeRepository,
  documentRepo: InMemoryDocumentRepository,
  cloneId: ProjectId,
): Promise<DocumentId[]> {
  const nodes = await fileNodeRepo.findByProjectId(cloneId);
  const documents = await documentRepo.findByFileNodeIds(nodes.map((node) => node.id));
  return documents.map((document) => document.id);
}

describe('what a clone does not carry over from its source', () => {
  let projectRepo: InMemoryProjectRepository;
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let registry: InMemoryActiveCloneRegistry;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let documentRepo: InMemoryDocumentRepository;
  let assetRepo: InMemoryAssetRepository;
  let fileStore: InMemoryProjectFileStore;
  let collaborationSessionRepo: InMemoryCollaborationSessionRepository;
  let collaborativeContentReader: CollaborativeContentReader;
  let renderConfigRepo: InMemoryProjectRenderConfigRepository;
  let dictionaryRepo: InMemoryProjectDictionaryRepository;
  let reviewCommentRepo: InMemoryReviewCommentRepository;
  let reviewReactionRepo: InMemoryReviewReactionRepository;
  let ignoredLintRepo: InMemoryIgnoredLintRepository;
  let gitRepositoryRepo: InMemoryGitRepositoryRepository;
  let templateRepo: InMemoryTemplateRepository;
  let logger: { warn: jest.Mock };
  let dependencies: ConstructorParameters<typeof CloneProjectUseCase>;
  let useCase: CloneProjectUseCase;

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    projectMemberRepo = new InMemoryProjectMemberRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    registry = new InMemoryActiveCloneRegistry();
    fileNodeRepo = new InMemoryFileNodeRepository();
    documentRepo = new InMemoryDocumentRepository();
    assetRepo = new InMemoryAssetRepository();
    fileStore = new InMemoryProjectFileStore();
    collaborationSessionRepo = new InMemoryCollaborationSessionRepository();
    collaborativeContentReader = { readContent: jest.fn().mockResolvedValue({ success: true, value: null }) };
    renderConfigRepo = new InMemoryProjectRenderConfigRepository();
    dictionaryRepo = new InMemoryProjectDictionaryRepository();
    reviewCommentRepo = new InMemoryReviewCommentRepository();
    reviewReactionRepo = new InMemoryReviewReactionRepository();
    ignoredLintRepo = new InMemoryIgnoredLintRepository();
    gitRepositoryRepo = new InMemoryGitRepositoryRepository();
    templateRepo = new InMemoryTemplateRepository();
    logger = { warn: jest.fn() };
    dependencies = [
      projectRepo,
      fileNodeRepo,
      projectMemberRepo,
      auditLogRepo,
      registry,
      documentRepo,
      assetRepo,
      fileStore,
      collaborationSessionRepo,
      collaborativeContentReader,
      renderConfigRepo,
      dictionaryRepo,
      logger,
    ];
    useCase = new CloneProjectUseCase(...dependencies);

    await projectRepo.save(
      new Project(
        SOURCE_PROJECT_ID,
        ProjectName.create('Handbook'),
        'Team handbook',
        ['handbook'],
        SOURCE_ROOT_ID,
      ),
    );
    await fileNodeRepo.save(sourceRootNode());
    await projectMemberRepo.addMember(new ProjectMember(SOURCE_PROJECT_ID, OWNER_ID, Role.create('owner')));
    await projectMemberRepo.addMember(new ProjectMember(SOURCE_PROJECT_ID, EDITOR_ID, Role.create('editor')));
    await projectMemberRepo.addMember(new ProjectMember(SOURCE_PROJECT_ID, VIEWER_ID, Role.create('viewer')));
    await seedNestedSource(fileNodeRepo, documentRepo, assetRepo, fileStore);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('review items', () => {
    it.each(REVIEW_ITEM_KIND_CASES)(
      'a source review %s reaches neither the copy nor any document of it',
      async (kind, id) => {
        await reviewCommentRepo.create(sourceReviewItem(kind, id));

        const cloneId = await cloneOf(useCase, OWNER_ID);

        expect(await reviewCommentRepo.listByProject(cloneId, {})).toEqual([]);
        expect(await reviewCommentRepo.countByProject(cloneId)).toBe(0);

        // A copied row would be addressed to the copy's own document, not the
        // source's, so the per-document read is the one a project-wide read
        // could not stand in for.
        const documentIds = await cloneDocumentIds(fileNodeRepo, documentRepo, cloneId);
        expect(documentIds).toHaveLength(3);
        for (const documentId of documentIds) {
          expect(
            await reviewCommentRepo.listByDocument(cloneId, documentId, { includeResolved: true }),
          ).toEqual([]);
        }

        // The source keeps its item: the copy left it where it was rather than moving it.
        const sourceItems = await reviewCommentRepo.listByProject(SOURCE_PROJECT_ID, {});
        expect(sourceItems.map((item) => item.kind)).toEqual([kind]);
        expect(sourceItems[0].id.value).toBe(id.value);
      },
    );

    test('a whole source thread — root, reply and task together — leaves the copy with nothing', async () => {
      for (const [kind, id] of REVIEW_ITEM_KIND_CASES) {
        await reviewCommentRepo.create(sourceReviewItem(kind, id));
      }
      await reviewCommentRepo.create(sourceReviewReply());
      expect(await reviewCommentRepo.countByProject(SOURCE_PROJECT_ID)).toBe(3);

      const cloneId = await cloneOf(useCase, OWNER_ID);

      expect(await reviewCommentRepo.countByProject(cloneId)).toBe(0);
      // Replies are the rows a project-scoped copy would most easily drag along,
      // because they hang off another row rather than off a document passage.
      const sourceItems = await reviewCommentRepo.listByProject(SOURCE_PROJECT_ID, {});
      expect(sourceItems.filter((item) => item.isReply())).toHaveLength(1);
      expect(sourceItems).toHaveLength(3);
    });

    test('the two kinds seeded together are both absent, so neither hides the other', async () => {
      for (const [kind, id] of REVIEW_ITEM_KIND_CASES) {
        await reviewCommentRepo.create(sourceReviewItem(kind, id));
      }

      const cloneId = await cloneOf(useCase, OWNER_ID);

      const cloneItems = await reviewCommentRepo.listByProject(cloneId, {});
      for (const kind of REVIEW_ITEM_KINDS) {
        expect(cloneItems.filter((item) => item.kind === kind)).toEqual([]);
      }

      const sourceItems = await reviewCommentRepo.listByProject(SOURCE_PROJECT_ID, {});
      expect(sourceItems.map((item) => item.kind).toSorted()).toEqual(['comment', 'task']);
    });
  });

  describe('reactions to review items', () => {
    test('reactions on a source comment stay on it, and the copy has nothing for one to attach to', async () => {
      await reviewCommentRepo.create(sourceReviewItem('comment', SOURCE_COMMENT_ID));
      for (const [id, userId, emoji] of SOURCE_REACTIONS) {
        await reviewReactionRepo.toggle(
          new ReviewReaction(ReviewReactionId.create(id), SOURCE_COMMENT_ID, userId, emoji),
        );
      }
      expect(await reviewReactionRepo.listForItems([SOURCE_COMMENT_ID])).toHaveLength(2);

      const cloneId = await cloneOf(useCase, OWNER_ID);

      // A reaction is addressed by the review item it sits on, so the copy's own
      // items are the only place one could have been copied to — and the copy
      // having no items at all is what leaves a reaction nowhere to live there.
      const cloneItems = await reviewCommentRepo.listByProject(cloneId, {});
      expect(await reviewReactionRepo.listForItems(cloneItems.map((item) => item.id))).toEqual([]);
      expect(cloneItems).toEqual([]);

      // Every reaction the store holds is still one of the source's own two.
      const stillOnTheSource = await reviewReactionRepo.listForItems([SOURCE_COMMENT_ID, SOURCE_TASK_ID]);
      expect(stillOnTheSource.map((reaction) => reaction.emoji).toSorted()).toEqual(['🎉', '👍']);
    });
  });

  describe('privately dismissed grammar issues', () => {
    test('no user\'s dismissals follow their files into the copy', async () => {
      for (const [id, userId, documentId] of SOURCE_IGNORED_LINTS) {
        await ignoredLintRepo.upsert(
          new IgnoredLint(IgnoredLintId.create(id), userId, documentId, '{"ignored":["hash-1"]}'),
        );
      }

      const cloneId = await cloneOf(useCase, OWNER_ID);

      // These records are keyed by (user, file node), so the copy's own nodes are
      // the only place a copied one could show up.
      const cloneNodes = await fileNodeRepo.findByProjectId(cloneId);
      expect(cloneNodes).toHaveLength(8);
      for (const node of cloneNodes) {
        for (const userId of ALL_USER_IDS) {
          expect(await ignoredLintRepo.findByUserAndDocument(userId, node.id)).toBeNull();
        }
      }

      // Each author keeps their own dismissals on the source's files.
      for (const [, userId, documentId] of SOURCE_IGNORED_LINTS) {
        expect(await ignoredLintRepo.findByUserAndDocument(userId, documentId)).not.toBeNull();
      }
    });
  });

  describe('the git connection', () => {
    test('the copy is linked to no remote, and no project but the source names its credential', async () => {
      await gitRepositoryRepo.save(
        new GitRepository(
          SOURCE_GIT_REPOSITORY_ID,
          SOURCE_PROJECT_ID,
          GitProvider.create('github'),
          'https://github.com/acme/handbook.git',
          SOURCE_CREDENTIAL_REFERENCE,
        ),
      );

      const cloneId = await cloneOf(useCase, OWNER_ID);

      // A link is one per project, so listing both projects lists every row that
      // exists. Copying the credential handle would hand whoever cloned the
      // project push rights on someone else's remote, so it is checked first and
      // on its own rather than left to follow from the row being absent.
      const projectsNamingTheCredential: string[] = [];
      for (const projectId of [SOURCE_PROJECT_ID, cloneId]) {
        const link = await gitRepositoryRepo.findByProjectId(projectId);
        if (link !== null && link.credentialReference === SOURCE_CREDENTIAL_REFERENCE) {
          projectsNamingTheCredential.push(link.projectId.value);
        }
      }
      expect(projectsNamingTheCredential).toEqual([SOURCE_PROJECT_ID.value]);

      expect(await gitRepositoryRepo.findByProjectId(cloneId)).toBeNull();

      // The source's own link is untouched, down to the credential it points at.
      const sourceLink = await gitRepositoryRepo.findById(SOURCE_GIT_REPOSITORY_ID);
      expect(sourceLink?.projectId.value).toBe(SOURCE_PROJECT_ID.value);
      expect(sourceLink?.remoteUrl).toBe('https://github.com/acme/handbook.git');
    });
  });

  describe('templates', () => {
    test('a template derived from the source gains no counterpart derived from the copy', async () => {
      await templateRepo.save(
        new Template(
          SOURCE_TEMPLATE_ID,
          'Handbook starter',
          'The shape every team handbook starts from.',
          TemplateCategory.create('documentation'),
          SOURCE_PROJECT_ID,
        ),
      );

      const cloneId = await cloneOf(useCase, OWNER_ID);

      const templates = await templateRepo.findAll();
      expect(templates.filter((template) => template.sourceProjectId?.value === cloneId.value)).toEqual([]);
      // The source's template is still there, and still the only one.
      expect(templates.map((template) => template.id.value)).toEqual([SOURCE_TEMPLATE_ID.value]);
      expect(templates[0].sourceProjectId?.value).toBe(SOURCE_PROJECT_ID.value);
    });
  });

  describe('open collaboration sessions', () => {
    test('documents being edited in the source leave the copy with no session of its own', async () => {
      await collaborationSessionRepo.open(SOURCE_PROJECT_ID, SOURCE_INDEX_DOCUMENT_ID);
      await collaborationSessionRepo.open(SOURCE_PROJECT_ID, SOURCE_NOTES_DOCUMENT_ID);

      const cloneId = await cloneOf(useCase, OWNER_ID);

      expect(await collaborationSessionRepo.findActiveDocumentIds(cloneId)).toEqual([]);

      // A session is keyed by (project, document), so the copy's own documents
      // are where a copied one would appear.
      const documentIds = await cloneDocumentIds(fileNodeRepo, documentRepo, cloneId);
      expect(documentIds).toHaveLength(3);
      for (const documentId of documentIds) {
        expect(await collaborationSessionRepo.isActive(cloneId, documentId)).toBe(false);
      }

      // The people editing the source are still editing it.
      const stillOpen = await collaborationSessionRepo.findActiveDocumentIds(SOURCE_PROJECT_ID);
      expect(stillOpen.map((documentId) => documentId.value).toSorted()).toEqual(
        [SOURCE_INDEX_DOCUMENT_ID.value, SOURCE_NOTES_DOCUMENT_ID.value].toSorted(),
      );
    });
  });

  test('is handed no store in which an excluded row could be written', () => {
    const excludedStores: readonly object[] = [
      reviewCommentRepo,
      reviewReactionRepo,
      ignoredLintRepo,
      gitRepositoryRepo,
      templateRepo,
    ];

    // The strongest guarantee available for these five is that the use case
    // cannot reach their rows at all. Two things say so together: none of the
    // collaborators it is constructed with is one of those stores, and the array
    // is typed as the class's own constructor parameters, so a port added to
    // reach one would stop this file compiling rather than pass unnoticed.
    for (const store of excludedStores) {
      expect(dependencies).not.toContain(store);
    }
    expect(dependencies).toHaveLength(13);
  });
});
