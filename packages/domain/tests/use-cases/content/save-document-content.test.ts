import { SaveDocumentContentUseCase } from '../../../src/use-cases/content/save-document-content';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
import { InMemoryCollaborationSessionRepository } from '../../ports/project/in-memory-collaboration-session-repository';
import { ActiveCollaborationSessionError } from '../../../src/errors/content/active-collaboration-session';
import { Project } from '../../../src/entities/project';
import { ProjectMember } from '../../../src/entities/project-member';
import { FileNode } from '../../../src/entities/file-node';
import { Document } from '../../../src/entities/document';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { ProjectName } from '../../../src/value-objects/project/project-name';
import { Role } from '../../../src/value-objects/identity/role';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { FileNodeNotFoundError } from '../../../src/errors/file-tree/file-node-not-found';

describe('SaveDocumentContentUseCase', () => {
  let projectRepo: InMemoryProjectRepository;
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let documentRepo: InMemoryDocumentRepository;
  let fileStore: InMemoryProjectFileStore;
  let useCase: SaveDocumentContentUseCase;

  const actorId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const nonMemberId = UserId.create('550e8400-e29b-41d4-a716-446655440009');
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootFolderId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const fileNodeId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
  const documentId = DocumentId.create('bb0e8400-e29b-41d4-a716-446655440007');
  const filePath = FilePath.create('/test.adoc');
  const initialContent = Buffer.from('= Hello\nWorld');
  const newContent = Buffer.from('= Updated\nContent');

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    projectMemberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    documentRepo = new InMemoryDocumentRepository();
    fileStore = new InMemoryProjectFileStore();

    useCase = new SaveDocumentContentUseCase(projectMemberRepo, fileNodeRepo, documentRepo, fileStore);

    const project = new Project(projectId, ProjectName.create('Test'), null, [], rootFolderId);
    await projectRepo.save(project);

    const rootFolder = new FileNode(rootFolderId, projectId, null, 'Test', FileNodeType.create('folder'), FilePath.create('/'));
    await fileNodeRepo.save(rootFolder);

    const fileNode = new FileNode(fileNodeId, projectId, rootFolderId, 'test.adoc', FileNodeType.create('file'), filePath);
    await fileNodeRepo.save(fileNode);

    const document = new Document(
      documentId,
      fileNodeId,
      ContentId.create('cc0e8400-e29b-41d4-a716-446655440008'),
      YjsStateId.create('dd0e8400-e29b-41d4-a716-446655440009'),
      MimeType.create('text/asciidoc'),
    );
    await documentRepo.save(document);

    await fileStore.write(projectId, filePath, initialContent);

    const member = new ProjectMember(projectId, actorId, Role.create('editor'));
    await projectMemberRepo.addMember(member);
  });

  it('saves content successfully', async () => {
    const result = await useCase.execute(actorId, projectId, fileNodeId, newContent);
    expect(result.success).toBe(true);
  });

  it('subsequent read returns new content', async () => {
    await useCase.execute(actorId, projectId, fileNodeId, newContent);
    const stored = await fileStore.read(projectId, filePath);
    expect(stored).toEqual(newContent);
  });

  it('returns PermissionDeniedError for non-member', async () => {
    const result = await useCase.execute(nonMemberId, projectId, fileNodeId, newContent);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('returns FileNodeNotFoundError for unknown node', async () => {
    const unknownId = FileNodeId.create('ff0e8400-e29b-41d4-a716-446655440099');
    const result = await useCase.execute(actorId, projectId, unknownId, newContent);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
    }
  });

  it('returns FileNodeNotFoundError for a file node with no backing Document', async () => {
    const assetNodeId = FileNodeId.create('aa1e8400-e29b-41d4-a716-446655440016');
    const assetPath = FilePath.create('/logo.png');
    await fileNodeRepo.save(
      new FileNode(assetNodeId, projectId, rootFolderId, 'logo.png', FileNodeType.create('file'), assetPath),
    );

    const result = await useCase.execute(actorId, projectId, assetNodeId, newContent);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
    }
    expect(await fileStore.read(projectId, assetPath)).toBeNull();
  });

  it('rejects write when fileNodeId belongs to a different project', async () => {
    const otherProjectId = ProjectId.create('ee0e8400-e29b-41d4-a716-446655440099');
    const otherRootId = FileNodeId.create('ee0e8400-e29b-41d4-a716-446655440098');
    const otherFileNodeId = FileNodeId.create('ff0e8400-e29b-41d4-a716-446655440099');
    const foreignRoot = new FileNode(
      otherRootId,
      otherProjectId,
      null,
      'Other',
      FileNodeType.create('folder'),
      FilePath.create('/'),
    );
    await fileNodeRepo.save(foreignRoot);
    const foreignNode = new FileNode(
      otherFileNodeId,
      otherProjectId,
      otherRootId,
      'foreign.adoc',
      FileNodeType.create('file'),
      FilePath.create('/foreign.adoc'),
    );
    await fileNodeRepo.save(foreignNode);
    // Also create a Document for the foreign node so the use case can reach the
    // ownership check (without this the document lookup returns null first).
    const foreignDocument = new Document(
      DocumentId.create('ee0e8400-e29b-41d4-a716-446655440097'),
      otherFileNodeId,
      ContentId.create('ee0e8400-e29b-41d4-a716-446655440096'),
      YjsStateId.create('ee0e8400-e29b-41d4-a716-446655440095'),
      MimeType.create('text/asciidoc'),
    );
    await documentRepo.save(foreignDocument);

    const result = await useCase.execute(actorId, projectId, otherFileNodeId, newContent);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
    }
  });

  it('returns a failed Result (not throws) and does not update DB ContentId when disk write fails', async () => {
    const failingStore = {
      write: jest.fn().mockRejectedValue(new Error('disk full')),
    } as unknown as typeof fileStore;

    const useCaseWithFailingStore = new SaveDocumentContentUseCase(
      projectMemberRepo,
      fileNodeRepo,
      documentRepo,
      failingStore,
    );

    const documentBefore = await documentRepo.findByFileNodeId(fileNodeId);
    const contentIdBefore = documentBefore?.contentId.value;

    // Must return a Result, not throw
    const result = await useCaseWithFailingStore.execute(actorId, projectId, fileNodeId, newContent);
    expect(result.success).toBe(false);

    // DB ContentId must not have changed
    const documentAfter = await documentRepo.findByFileNodeId(fileNodeId);
    expect(documentAfter?.contentId.value).toBe(contentIdBefore);
  });
});

/**
 * A PDF theme is an ordinary project document. This feature adds an editor for it, not a storage
 * path — so the save route, the permission checks, the size limit and the content-version bump that
 * feeds the audit trail must all apply to it unchanged (FR-022, FR-023). These assert that
 * INHERITANCE rather than a mechanism of the theme editor's own: if a theme ever acquires special
 * handling in the save path, they fail.
 */
describe('SaveDocumentContentUseCase — a theme is an ordinary document', () => {
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let documentRepo: InMemoryDocumentRepository;
  let fileStore: InMemoryProjectFileStore;
  let useCase: SaveDocumentContentUseCase;

  const actorId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const outsiderId = UserId.create('550e8400-e29b-41d4-a716-446655440009');
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440013');
  const rootFolderId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440014');
  const themeNodeId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440016');
  const themeDocumentId = DocumentId.create('bb0e8400-e29b-41d4-a716-446655440017');
  const themePath = FilePath.create('/branding/corporate-theme.yml');
  const originalContentId = ContentId.create('cc0e8400-e29b-41d4-a716-446655440018');
  const themeYaml = Buffer.from('page:\n  layout: landscape\n');

  beforeEach(async () => {
    projectMemberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    documentRepo = new InMemoryDocumentRepository();
    fileStore = new InMemoryProjectFileStore();
    useCase = new SaveDocumentContentUseCase(projectMemberRepo, fileNodeRepo, documentRepo, fileStore);

    const rootFolder = new FileNode(rootFolderId, projectId, null, 'Test', FileNodeType.create('folder'), FilePath.create('/'));
    await fileNodeRepo.save(rootFolder);
    const themeNode = new FileNode(themeNodeId, projectId, rootFolderId, 'corporate-theme.yml', FileNodeType.create('file'), themePath);
    await fileNodeRepo.save(themeNode);
    await documentRepo.save(
      new Document(themeDocumentId, themeNodeId, originalContentId, YjsStateId.create('dd0e8400-e29b-41d4-a716-446655440019'), MimeType.create('text/yaml')),
    );
    await fileStore.write(projectId, themePath, Buffer.from('page:\n'));
    await projectMemberRepo.addMember(new ProjectMember(projectId, actorId, Role.create('editor')));
  });

  it('saves a theme through the same path as any other document', () => {
    return useCase.execute(actorId, projectId, themeNodeId, themeYaml).then(async (result) => {
      expect(result.success).toBe(true);
      expect(await fileStore.read(projectId, themePath)).toEqual(themeYaml);
    });
  });

  it('bumps the content version, which is what the audit trail records (FR-023)', async () => {
    await useCase.execute(actorId, projectId, themeNodeId, themeYaml);
    const stored = await documentRepo.findByFileNodeId(themeNodeId);
    expect(stored?.contentId.value).not.toBe(originalContentId.value);
  });

  it('refuses a non-member exactly as it would for a prose document (FR-022)', async () => {
    const result = await useCase.execute(outsiderId, projectId, themeNodeId, themeYaml);
    expect(result.success).toBe(false);
  });

  it('applies the same rules to a .yaml theme as a .yml one', async () => {
    const altNodeId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440026');
    const altPath = FilePath.create('/alt-theme.yaml');
    await fileNodeRepo.save(new FileNode(altNodeId, projectId, rootFolderId, 'alt-theme.yaml', FileNodeType.create('file'), altPath));
    await documentRepo.save(
      new Document(DocumentId.create('bb0e8400-e29b-41d4-a716-446655440027'), altNodeId, ContentId.create('cc0e8400-e29b-41d4-a716-446655440028'), YjsStateId.create('dd0e8400-e29b-41d4-a716-446655440029'), MimeType.create('text/yaml')),
    );
    await fileStore.write(projectId, altPath, Buffer.from('page:\n'));
    const result = await useCase.execute(actorId, projectId, altNodeId, themeYaml);
    expect(result.success).toBe(true);
  });
});

describe('SaveDocumentContentUseCase — active-session guard', () => {
  const actorId2 = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const projectId2 = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootFolderId2 = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const fileNodeId2 = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
  const documentId2 = DocumentId.create('bb0e8400-e29b-41d4-a716-446655440007');
  const filePath2 = FilePath.create('/test.adoc');

  async function buildRepos(withActiveSession: boolean) {
    const projectMemberRepo = new InMemoryProjectMemberRepository();
    const fileNodeRepo = new InMemoryFileNodeRepository();
    const documentRepo = new InMemoryDocumentRepository();
    const fileStore = new InMemoryProjectFileStore();
    const collabSessionRepo = new InMemoryCollaborationSessionRepository();

    const rootFolder = new FileNode(rootFolderId2, projectId2, null, 'root', FileNodeType.create('folder'), FilePath.create('/'));
    await fileNodeRepo.save(rootFolder);

    const fileNode2 = new FileNode(fileNodeId2, projectId2, rootFolderId2, 'test.adoc', FileNodeType.create('file'), filePath2);
    await fileNodeRepo.save(fileNode2);

    const yjsStateId2 = YjsStateId.create('dd0e8400-e29b-41d4-a716-446655440009');
    const document2 = new Document(
      documentId2,
      fileNodeId2,
      ContentId.create('cc0e8400-e29b-41d4-a716-446655440008'),
      yjsStateId2,
      MimeType.create('text/asciidoc'),
    );
    await documentRepo.save(document2);
    await fileStore.write(projectId2, filePath2, Buffer.from('initial'));

    const member2 = new ProjectMember(projectId2, actorId2, Role.create('editor'));
    await projectMemberRepo.addMember(member2);

    if (withActiveSession) {
      await collabSessionRepo.open(projectId2, documentId2);
    }

    return { projectMemberRepo, fileNodeRepo, documentRepo, fileStore, collabSessionRepo };
  }

  it('(a) active session → returns ActiveCollaborationSessionError without writing', async () => {
    const repos = await buildRepos(true);
    const useCase = new SaveDocumentContentUseCase(
      repos.projectMemberRepo,
      repos.fileNodeRepo,
      repos.documentRepo,
      repos.fileStore,
      repos.collabSessionRepo,
    );

    const result = await useCase.execute(actorId2, projectId2, fileNodeId2, Buffer.from('new content'));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ActiveCollaborationSessionError);
    }
    const stored = await repos.fileStore.read(projectId2, filePath2);
    expect(stored?.toString()).toBe('initial');
  });

  it('(b) no active session → write proceeds normally', async () => {
    const repos = await buildRepos(false);
    const useCase = new SaveDocumentContentUseCase(
      repos.projectMemberRepo,
      repos.fileNodeRepo,
      repos.documentRepo,
      repos.fileStore,
      repos.collabSessionRepo,
    );

    const result = await useCase.execute(actorId2, projectId2, fileNodeId2, Buffer.from('new content'));

    expect(result.success).toBe(true);
  });

  it('(c) no collaborationSessionRepo → write always proceeds (backwards-compatible)', async () => {
    const repos = await buildRepos(false);
    const useCase = new SaveDocumentContentUseCase(
      repos.projectMemberRepo,
      repos.fileNodeRepo,
      repos.documentRepo,
      repos.fileStore,
    );

    const result = await useCase.execute(actorId2, projectId2, fileNodeId2, Buffer.from('no repo'));

    expect(result.success).toBe(true);
  });
});
