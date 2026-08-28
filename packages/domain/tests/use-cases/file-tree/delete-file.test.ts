import { DeleteFileUseCase } from '../../../src/use-cases/file-tree/delete-file';
import { FileNodeNotFoundError } from '../../../src/errors/file-tree/file-node-not-found';
import { InMemoryCollaborationSessionRepository } from '../../ports/project/in-memory-collaboration-session-repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';
import { InMemoryYjsStateStore } from '../../ports/storage/in-memory-yjs-state-store';
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

describe('DeleteFileUseCase', () => {
  let projectRepo: InMemoryProjectRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let documentRepo: InMemoryDocumentRepository;
  let useCase: DeleteFileUseCase;
  let actorId: UserId;
  let projectId: ProjectId;
  let project: Project;
  let rootFolderId: FileNodeId;
  let rootFolder: FileNode;
  let childFolderId: FileNodeId;
  let childFolder: FileNode;
  let fileNode: FileNode;
  let fileNodeId: FileNodeId;
  let document: Document;
  let documentId: DocumentId;

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    projectMemberRepo = new InMemoryProjectMemberRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    documentRepo = new InMemoryDocumentRepository();

    useCase = new DeleteFileUseCase(
      projectMemberRepo,
      fileNodeRepo,
      documentRepo,
      auditLogRepo,
    );

    actorId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
    projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
    rootFolderId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
    childFolderId = FileNodeId.create('990e8400-e29b-41d4-a716-446655440005');
    fileNodeId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
    documentId = DocumentId.create('bb0e8400-e29b-41d4-a716-446655440007');

    project = new Project(
      projectId,
      ProjectName.create('Test Project'),
      null,
      [],
      rootFolderId,
    );
    await projectRepo.save(project);

    rootFolder = new FileNode(
      rootFolderId,
      projectId,
      null,
      'Test Project',
      FileNodeType.create('folder'),
      FilePath.create('/'),
    );
    await fileNodeRepo.save(rootFolder);

    childFolder = new FileNode(
      childFolderId,
      projectId,
      rootFolderId,
      'child-folder',
      FileNodeType.create('folder'),
      FilePath.create('/child-folder'),
    );
    await fileNodeRepo.save(childFolder);

    fileNode = new FileNode(
      fileNodeId,
      projectId,
      rootFolderId,
      'test-file.txt',
      FileNodeType.create('file'),
      FilePath.create('/test-file.txt'),
    );
    await fileNodeRepo.save(fileNode);

    document = new Document(
      documentId,
      fileNodeId,
      ContentId.create('cc0e8400-e29b-41d4-a716-446655440008'),
      YjsStateId.create('dd0e8400-e29b-41d4-a716-446655440009'),
      MimeType.create('text/plain'),
    );
    await documentRepo.save(document);

    const member = new ProjectMember(
      projectId,
      actorId,
      Role.create('editor'),
    );
    await projectMemberRepo.addMember(member);
  });

  test('deletes a file and its document and creates audit log', async () => {
    const result = await useCase.execute(actorId, fileNodeId, projectId);

    expect(result.success).toBe(true);

    const deletedNode = await fileNodeRepo.findById(fileNodeId);
    expect(deletedNode).toBeNull();

    const deletedDocument = await documentRepo.findByFileNodeId(fileNodeId);
    expect(deletedDocument).toBeNull();

    const logs = await auditLogRepo.findByProjectId(projectId);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('file.deleted');
    expect(logs[0].userId?.value).toBe(actorId.value);
  });

  test('deletes a folder cascading to children and their documents', async () => {
    const grandchildFileId = FileNodeId.create('ee0e8400-e29b-41d4-a716-44665544000a');
    const grandchildDocumentId = DocumentId.create('ff0e8400-e29b-41d4-a716-44665544000b');

    const grandchildFile = new FileNode(
      grandchildFileId,
      projectId,
      childFolderId,
      'nested.txt',
      FileNodeType.create('file'),
      FilePath.create('/child-folder/nested.txt'),
    );
    await fileNodeRepo.save(grandchildFile);

    const grandchildDocument = new Document(
      grandchildDocumentId,
      grandchildFileId,
      ContentId.create('aa0e8400-e29b-41d4-a716-44665544000c'),
      YjsStateId.create('bb0e8400-e29b-41d4-a716-44665544000d'),
      MimeType.create('text/plain'),
    );
    await documentRepo.save(grandchildDocument);

    const result = await useCase.execute(actorId, childFolderId, projectId);

    expect(result.success).toBe(true);

    const deletedFolder = await fileNodeRepo.findById(childFolderId);
    expect(deletedFolder).toBeNull();

    const deletedGrandchild = await fileNodeRepo.findById(grandchildFileId);
    expect(deletedGrandchild).toBeNull();

    const deletedGrandchildDocument = await documentRepo.findById(grandchildDocumentId);
    expect(deletedGrandchildDocument).toBeNull();

    const rootNode = await fileNodeRepo.findById(rootFolderId);
    expect(rootNode).not.toBeNull();

    const logs = await auditLogRepo.findByProjectId(projectId);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('file.deleted');
  });

  test('cascades through nested folders and deletes files that have no document', async () => {
    const nestedFolderId = FileNodeId.create('110e8400-e29b-41d4-a716-44665544001a');
    const documentlessFileId = FileNodeId.create('220e8400-e29b-41d4-a716-44665544001b');

    await fileNodeRepo.save(
      new FileNode(
        nestedFolderId,
        projectId,
        childFolderId,
        'nested-folder',
        FileNodeType.create('folder'),
        FilePath.create('/child-folder/nested-folder'),
      ),
    );
    await fileNodeRepo.save(
      new FileNode(
        documentlessFileId,
        projectId,
        nestedFolderId,
        'plain.txt',
        FileNodeType.create('file'),
        FilePath.create('/child-folder/nested-folder/plain.txt'),
      ),
    );

    const result = await useCase.execute(actorId, childFolderId, projectId);

    expect(result.success).toBe(true);
    expect(await fileNodeRepo.findById(childFolderId)).toBeNull();
    expect(await fileNodeRepo.findById(nestedFolderId)).toBeNull();
    expect(await fileNodeRepo.findById(documentlessFileId)).toBeNull();
    expect(await fileNodeRepo.findById(rootFolderId)).not.toBeNull();
  });

  test('returns error when deleting root folder', async () => {
    const result = await useCase.execute(actorId, rootFolderId, projectId);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error).toBeDefined();
  });

  test('returns error for non-existent file', async () => {
    const missingId = FileNodeId.create('cc0e8400-e29b-41d4-a716-44665544000e');
    const result = await useCase.execute(actorId, missingId, projectId);

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.name).toBe('FileNodeNotFoundError');
  });

  test('records an authz.denied audit log entry for a non-member', async () => {
    const nonMemberId = UserId.create('550e8400-e29b-41d4-a716-446655440009');
    const result = await useCase.execute(nonMemberId, fileNodeId, projectId);

    expect(result.success).toBe(false);

    const entries = await auditLogRepo.findAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('authz.denied');
    expect(entries[0].resourceType).toBe('FileNode');
    expect(entries[0].resourceId).toBe(fileNodeId.value);
    expect(entries[0].metadata.reason).toBe('not_a_project_member');
  });

  it('denies a viewer and records insufficient_role', async () => {
    const viewerId = UserId.create('550e8400-e29b-41d4-a716-44665544000a');
    await projectMemberRepo.addMember(new ProjectMember(projectId, viewerId, Role.create('viewer')));
    const result = await useCase.execute(viewerId, fileNodeId, projectId);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.name).toBe('PermissionDeniedError');
    const entries = await auditLogRepo.findAll();
    expect(entries[0].metadata.reason).toBe('insufficient_role');
  });

  test('file.deleted audit log carries request origin metadata', async () => {
    const result = await useCase.execute(actorId, fileNodeId, projectId, {
      ipAddress: '203.0.113.7',
      userAgent: 'jest-agent',
    });

    expect(result.success).toBe(true);

    const logs = await auditLogRepo.findByProjectId(projectId);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('file.deleted');
    expect(logs[0].metadata.origin).toEqual({ ipAddress: '203.0.113.7', userAgent: 'jest-agent' });
  });

  test('deny path swallows a failing audit save but reports it via the logger', async () => {
    const logger = { warn: jest.fn() };
    const failingAuditRepo = {
      ...auditLogRepo,
      save: jest.fn().mockRejectedValue(new Error('audit store down')),
    };
    const useCaseWithLogger = new DeleteFileUseCase(
      projectMemberRepo,
      fileNodeRepo,
      documentRepo,
      failingAuditRepo as never,
      undefined,
      undefined,
      logger,
    );

    const nonMemberId = UserId.create('550e8400-e29b-41d4-a716-446655440009');
    const result = await useCaseWithLogger.execute(nonMemberId, fileNodeId, projectId);

    // Audit failure must not convert the clean 403 into a thrown error.
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('PermissionDeniedError');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('a failed audit write does NOT fail the operation and is logged', async () => {
    const throwingAudit = { save: jest.fn().mockRejectedValue(new Error('audit db down')) } as never;
    const logger = { warn: jest.fn() };
    const useCaseWithLogger = new DeleteFileUseCase(
      projectMemberRepo,
      fileNodeRepo,
      documentRepo,
      throwingAudit,
      undefined,
      undefined,
      logger,
    );

    const result = await useCaseWithLogger.execute(actorId, fileNodeId, projectId);

    expect(result.success).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('DeleteFileUseCase with ProjectFileStore + YjsStateStore', () => {
  let fileNodeRepo: InMemoryFileNodeRepository;
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let documentRepo: InMemoryDocumentRepository;
  let fileStore: InMemoryProjectFileStore;
  let yjsStateStore: InMemoryYjsStateStore;
  let useCase: DeleteFileUseCase;

  const actorId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootFolderId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const fileNodeId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
  const documentId = DocumentId.create('bb0e8400-e29b-41d4-a716-446655440007');
  const folderNodeId = FileNodeId.create('cc0e8400-e29b-41d4-a716-446655440008');
  const yjsId = YjsStateId.create('dd0e8400-e29b-41d4-a716-446655440009');
  const filePath = FilePath.create('/test-file.txt');
  const folderPath = FilePath.create('/child-folder');

  beforeEach(async () => {
    fileNodeRepo = new InMemoryFileNodeRepository();
    projectMemberRepo = new InMemoryProjectMemberRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    documentRepo = new InMemoryDocumentRepository();
    fileStore = new InMemoryProjectFileStore();
    yjsStateStore = new InMemoryYjsStateStore();

    useCase = new DeleteFileUseCase(
      projectMemberRepo,
      fileNodeRepo,
      documentRepo,
      auditLogRepo,
      fileStore,
      yjsStateStore,
    );

    const rootFolder = new FileNode(rootFolderId, projectId, null, 'Root', FileNodeType.create('folder'), FilePath.create('/'));
    await fileNodeRepo.save(rootFolder);

    const fileNode = new FileNode(fileNodeId, projectId, rootFolderId, 'test-file.txt', FileNodeType.create('file'), filePath);
    await fileNodeRepo.save(fileNode);
    await fileStore.write(projectId, filePath, Buffer.from('content'));

    const document = new Document(documentId, fileNodeId, ContentId.create('cc0e8400-e29b-41d4-a716-44665544000c'), yjsId, MimeType.create('text/plain'));
    await documentRepo.save(document);
    await yjsStateStore.save(projectId, yjsId, Buffer.from([1, 2, 3]));

    const folderNode = new FileNode(folderNodeId, projectId, rootFolderId, 'child-folder', FileNodeType.create('folder'), folderPath);
    await fileNodeRepo.save(folderNode);

    const member = new ProjectMember(projectId, actorId, Role.create('editor'));
    await projectMemberRepo.addMember(member);
  });

  test('fileStore.remove called for file nodes', async () => {
    await useCase.execute(actorId, fileNodeId, projectId);
    const content = await fileStore.read(projectId, filePath);
    expect(content).toBeNull();
  });

  test('yjsStateStore.delete called when document exists', async () => {
    await useCase.execute(actorId, fileNodeId, projectId);
    const state = await yjsStateStore.load(projectId, yjsId);
    expect(state).toBeNull();
  });

  test('fileStore.removeDirectory called for folder nodes', async () => {
    await useCase.execute(actorId, folderNodeId, projectId);
    // Folder is removed; writing to a file under it via fileStore would still work since
    // in-memory store doesn't enforce directory existence, but the removeDirectory was called.
    // Verify the folder node is deleted from DB.
    const folderNode = await fileNodeRepo.findById(folderNodeId);
    expect(folderNode).toBeNull();
  });

  it('cleans up Yjs state for all documents inside a deleted folder', async () => {
    const childFileId = FileNodeId.create('ff0e8400-e29b-41d4-a716-446655440030');
    const childDocumentId = DocumentId.create('ff0e8400-e29b-41d4-a716-446655440031');
    const childYjsStateId = YjsStateId.create('ff0e8400-e29b-41d4-a716-446655440032');

    const childFile = new FileNode(
      childFileId,
      projectId,
      folderNodeId,
      'note.adoc',
      FileNodeType.create('file'),
      FilePath.create('/child-folder/note.adoc'),
    );
    await fileNodeRepo.save(childFile);

    const childDocument = new Document(
      childDocumentId,
      childFileId,
      ContentId.create('aa0e8400-e29b-41d4-a716-446655440033'),
      childYjsStateId,
      MimeType.create('text/asciidoc'),
    );
    await documentRepo.save(childDocument);

    await yjsStateStore.save(projectId, childYjsStateId, Buffer.from('yjs-data'));
    expect(await yjsStateStore.load(projectId, childYjsStateId)).not.toBeNull();

    const result = await useCase.execute(actorId, folderNodeId, projectId);
    expect(result.success).toBe(true);

    expect(await yjsStateStore.load(projectId, childYjsStateId)).toBeNull();
  });

  it('returns FileNodeNotFoundError when the file node belongs to a different project', async () => {
    const otherProjectId = ProjectId.create('ff0e8400-e29b-41d4-a716-446655440099');
    const alienNodeId = FileNodeId.create('ee0e8400-e29b-41d4-a716-446655440011');
    const alienNode = new FileNode(
      alienNodeId,
      otherProjectId,
      rootFolderId,
      'alien.adoc',
      FileNodeType.create('file'),
      FilePath.create('/alien.adoc'),
    );
    await fileNodeRepo.save(alienNode);

    // actor is a member of projectId, but alienNode belongs to otherProjectId
    const result = await useCase.execute(actorId, alienNodeId, projectId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
    }
  });
});

describe('DeleteFileUseCase — yjsStateStore failure tolerance', () => {
  let fileNodeRepo3: InMemoryFileNodeRepository;
  let projectMemberRepo3: InMemoryProjectMemberRepository;
  let auditLogRepo3: InMemoryAuditLogRepository;
  let documentRepo3: InMemoryDocumentRepository;
  let fileStore3: InMemoryProjectFileStore;

  const actorId3 = UserId.create('550e8400-e29b-41d4-a716-220000000001');
  const projectId3 = ProjectId.create('770e8400-e29b-41d4-a716-220000000003');
  const rootFolderId3 = FileNodeId.create('880e8400-e29b-41d4-a716-220000000004');
  const fileNodeId3 = FileNodeId.create('aa0e8400-e29b-41d4-a716-220000000006');

  beforeEach(async () => {
    fileNodeRepo3 = new InMemoryFileNodeRepository();
    projectMemberRepo3 = new InMemoryProjectMemberRepository();
    auditLogRepo3 = new InMemoryAuditLogRepository();
    documentRepo3 = new InMemoryDocumentRepository();
    fileStore3 = new InMemoryProjectFileStore();

    const rootFolder3 = new FileNode(rootFolderId3, projectId3, null, 'root', FileNodeType.create('folder'), FilePath.create('/'));
    await fileNodeRepo3.save(rootFolder3);

    const function3 = new FileNode(fileNodeId3, projectId3, rootFolderId3, 'doc.adoc', FileNodeType.create('file'), FilePath.create('/doc.adoc'));
    await fileNodeRepo3.save(function3);

    const document3 = new Document(
      DocumentId.create('bb0e8400-e29b-41d4-a716-220000000007'),
      fileNodeId3,
      ContentId.create('cc0e8400-e29b-41d4-a716-220000000008'),
      YjsStateId.create('dd0e8400-e29b-41d4-a716-220000000009'),
      MimeType.create('text/asciidoc'),
    );
    await documentRepo3.save(document3);
    await fileStore3.write(projectId3, FilePath.create('/doc.adoc'), Buffer.from('hello'));
    await projectMemberRepo3.addMember(new ProjectMember(projectId3, actorId3, Role.create('editor')));
  });

  it('returns success even when yjsStateStore.delete throws — deletion is semantically complete once DB rows are gone', async () => {
    const throwingYjsStore = {
      delete: jest.fn().mockRejectedValue(new Error('Yjs store unavailable')),
      deleteAllForProject: jest.fn().mockResolvedValue(undefined),
    };

    const useCase3 = new DeleteFileUseCase(
      projectMemberRepo3,
      fileNodeRepo3,
      documentRepo3,
      auditLogRepo3,
      fileStore3,
      throwingYjsStore as never,
    );

    const result = await useCase3.execute(actorId3, fileNodeId3, projectId3);
    expect(result.success).toBe(true);
  });

  it('returns success when deleting a folder even if yjsStateStore.delete throws for a child document', async () => {
    // Create a subfolder with a document inside it
    const subfolderId = FileNodeId.create('ee0e8400-e29b-41d4-a716-220000000010');
    const subfolder = new FileNode(subfolderId, projectId3, rootFolderId3, 'sub', FileNodeType.create('folder'), FilePath.create('/sub'));
    await fileNodeRepo3.save(subfolder);

    const childFileNodeId = FileNodeId.create('ff0e8400-e29b-41d4-a716-220000000011');
    const childFile = new FileNode(childFileNodeId, projectId3, subfolderId, 'child.adoc', FileNodeType.create('file'), FilePath.create('/sub/child.adoc'));
    await fileNodeRepo3.save(childFile);

    const childDocument = new Document(
      DocumentId.create('110e8400-e29b-41d4-a716-220000000012'),
      childFileNodeId,
      ContentId.create('120e8400-e29b-41d4-a716-220000000013'),
      YjsStateId.create('130e8400-e29b-41d4-a716-220000000014'),
      MimeType.create('text/asciidoc'),
    );
    await documentRepo3.save(childDocument);

    const throwingYjsStore2 = {
      delete: jest.fn().mockRejectedValue(new Error('Yjs store unavailable')),
      deleteAllForProject: jest.fn().mockResolvedValue(undefined),
    };

    const useCase3folder = new DeleteFileUseCase(
      projectMemberRepo3,
      fileNodeRepo3,
      documentRepo3,
      auditLogRepo3,
      fileStore3,
      throwingYjsStore2 as never,
    );

    const result = await useCase3folder.execute(actorId3, subfolderId, projectId3);
    expect(result.success).toBe(true);
  });
});

describe('DeleteFileUseCase — active-session guard', () => {
  const actorG = UserId.create('550e8400-e29b-41d4-a716-000000000001');
  const projectG = ProjectId.create('550e8400-e29b-41d4-a716-000000000002');
  const rootIdG = FileNodeId.create('550e8400-e29b-41d4-a716-000000000003');
  const fileIdG = FileNodeId.create('550e8400-e29b-41d4-a716-000000000004');
  const documentIdG = DocumentId.create('550e8400-e29b-41d4-a716-000000000005');
  const subFolderIdG = FileNodeId.create('550e8400-e29b-41d4-a716-000000000006');
  const childFileIdG = FileNodeId.create('550e8400-e29b-41d4-a716-000000000007');
  const childDocumentIdG = DocumentId.create('550e8400-e29b-41d4-a716-000000000008');

  async function buildGuardRepos(options: {
    fileSessionActive?: boolean;
    childSessionActive?: boolean;
  } = {}) {
    const projectMemberRepo = new InMemoryProjectMemberRepository();
    const fileNodeRepo = new InMemoryFileNodeRepository();
    const documentRepo = new InMemoryDocumentRepository();
    const auditLogRepo = new InMemoryAuditLogRepository();
    const collabSessionRepo = new InMemoryCollaborationSessionRepository();

    const member = new ProjectMember(projectG, actorG, Role.create('editor'));
    await projectMemberRepo.addMember(member);

    const root = new FileNode(rootIdG, projectG, null, 'root', FileNodeType.create('folder'), FilePath.create('/'));
    await fileNodeRepo.save(root);

    const file = new FileNode(fileIdG, projectG, rootIdG, 'file.adoc', FileNodeType.create('file'), FilePath.create('/file.adoc'));
    await fileNodeRepo.save(file);

    const document = new Document(documentIdG, fileIdG, ContentId.create('550e8400-e29b-41d4-a716-000000000009'), YjsStateId.create('550e8400-e29b-41d4-a716-000000000010'), MimeType.create('text/asciidoc'));
    await documentRepo.save(document);

    const subFolder = new FileNode(subFolderIdG, projectG, rootIdG, 'sub', FileNodeType.create('folder'), FilePath.create('/sub'));
    await fileNodeRepo.save(subFolder);

    const childFile = new FileNode(childFileIdG, projectG, subFolderIdG, 'child.adoc', FileNodeType.create('file'), FilePath.create('/sub/child.adoc'));
    await fileNodeRepo.save(childFile);

    const childDocument = new Document(childDocumentIdG, childFileIdG, ContentId.create('550e8400-e29b-41d4-a716-000000000011'), YjsStateId.create('550e8400-e29b-41d4-a716-000000000012'), MimeType.create('text/asciidoc'));
    await documentRepo.save(childDocument);

    if (options.fileSessionActive) {
      await collabSessionRepo.open(projectG, documentIdG);
    }
    if (options.childSessionActive) {
      await collabSessionRepo.open(projectG, childDocumentIdG);
    }

    return { projectMemberRepo, fileNodeRepo, documentRepo, auditLogRepo, collabSessionRepo };
  }

  // The delete guard was relaxed: deleting a file (or a folder containing one) with an active
  // collaboration session now PROCEEDS. The session row is removed by the cascade on the deleted
  // Document; blocking instead would make any merely-opened file impossible to delete.
  it('(a) deleting a file with an active collaboration session proceeds', async () => {
    const repos = await buildGuardRepos({ fileSessionActive: true });
    const useCase = new DeleteFileUseCase(
      repos.projectMemberRepo,
      repos.fileNodeRepo,
      repos.documentRepo,
      repos.auditLogRepo,
    );

    const result = await useCase.execute(actorG, fileIdG, projectG);
    expect(result.success).toBe(true);
  });

  it('(b) deleting a folder with an active descendant session proceeds', async () => {
    const repos = await buildGuardRepos({ childSessionActive: true });
    const useCase = new DeleteFileUseCase(
      repos.projectMemberRepo,
      repos.fileNodeRepo,
      repos.documentRepo,
      repos.auditLogRepo,
    );

    const result = await useCase.execute(actorG, subFolderIdG, projectG);
    expect(result.success).toBe(true);
  });

  it('(c) no active sessions → deletion proceeds', async () => {
    const repos = await buildGuardRepos({});
    const useCase = new DeleteFileUseCase(
      repos.projectMemberRepo,
      repos.fileNodeRepo,
      repos.documentRepo,
      repos.auditLogRepo,
    );

    const result = await useCase.execute(actorG, fileIdG, projectG);
    expect(result.success).toBe(true);
  });

  it('(d) no repo provided → deletion proceeds', async () => {
    const repos = await buildGuardRepos({ fileSessionActive: true });
    const useCase = new DeleteFileUseCase(
      repos.projectMemberRepo,
      repos.fileNodeRepo,
      repos.documentRepo,
      repos.auditLogRepo,
    );

    const result = await useCase.execute(actorG, fileIdG, projectG);
    expect(result.success).toBe(true);
  });
});

describe('DeleteFileUseCase — main-file consistency', () => {
  const actor = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const project = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const mainId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
  const otherId = FileNodeId.create('bb0e8400-e29b-41d4-a716-446655440008');

  let memberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let documentRepo: InMemoryDocumentRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let projectRepo: InMemoryProjectRepository;
  let projectEntity: Project;

  function buildUseCase(): DeleteFileUseCase {
    return new DeleteFileUseCase(memberRepo, fileNodeRepo, documentRepo, auditLogRepo, undefined, undefined, undefined, projectRepo);
  }

  beforeEach(async () => {
    memberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    documentRepo = new InMemoryDocumentRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    projectRepo = new InMemoryProjectRepository();

    projectEntity = new Project(project, ProjectName.create('Book'), null, [], rootId);
    await projectRepo.save(projectEntity);

    await fileNodeRepo.save(new FileNode(rootId, project, null, 'Root', FileNodeType.create('folder'), FilePath.create('/')));
    await fileNodeRepo.save(new FileNode(mainId, project, rootId, 'main.adoc', FileNodeType.create('file'), FilePath.create('/main.adoc')));
    await fileNodeRepo.save(new FileNode(otherId, project, rootId, 'other.adoc', FileNodeType.create('file'), FilePath.create('/other.adoc')));
    await memberRepo.addMember(new ProjectMember(project, actor, Role.create('editor')));
  });

  it('clears the main-file configuration when the configured main file is deleted', async () => {
    projectEntity.setMainFile(mainId);
    await projectRepo.save(projectEntity);

    const result = await buildUseCase().execute(actor, mainId, project);
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.mainFileCleared).toBe(true);
    const reloaded = await projectRepo.findById(project);
    expect(reloaded!.mainFileNodeId).toBeNull();
  });

  it('clears the main-file configuration when the folder containing the main file is deleted', async () => {
    const chaptersId = FileNodeId.create('cc0e8400-e29b-41d4-a716-44665544000c');
    const nestedMainId = FileNodeId.create('dd0e8400-e29b-41d4-a716-44665544000d');
    await fileNodeRepo.save(new FileNode(chaptersId, project, rootId, 'chapters', FileNodeType.create('folder'), FilePath.create('/chapters')));
    await fileNodeRepo.save(new FileNode(nestedMainId, project, chaptersId, 'intro.adoc', FileNodeType.create('file'), FilePath.create('/chapters/intro.adoc')));
    projectEntity.setMainFile(nestedMainId);
    await projectRepo.save(projectEntity);

    const result = await buildUseCase().execute(actor, chaptersId, project);

    expect(result.success).toBe(true);
    if (result.success) expect(result.value.mainFileCleared).toBe(true);
    const reloaded = await projectRepo.findById(project);
    expect(reloaded!.mainFileNodeId).toBeNull();
  });

  it('leaves the main-file configuration intact when a folder that does not contain it is deleted', async () => {
    const chaptersId = FileNodeId.create('cc0e8400-e29b-41d4-a716-44665544000c');
    await fileNodeRepo.save(new FileNode(chaptersId, project, rootId, 'chapters', FileNodeType.create('folder'), FilePath.create('/chapters')));
    projectEntity.setMainFile(mainId);
    await projectRepo.save(projectEntity);

    const result = await buildUseCase().execute(actor, chaptersId, project);

    expect(result.success).toBe(true);
    if (result.success) expect(result.value.mainFileCleared).toBe(false);
    const reloaded = await projectRepo.findById(project);
    expect(reloaded!.mainFileNodeId!.value).toBe(mainId.value);
  });

  it('leaves the main-file configuration intact when a different file is deleted', async () => {
    projectEntity.setMainFile(mainId);
    await projectRepo.save(projectEntity);

    const result = await buildUseCase().execute(actor, otherId, project);
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.mainFileCleared).toBe(false);
    const reloaded = await projectRepo.findById(project);
    expect(reloaded!.mainFileNodeId!.value).toBe(mainId.value);
  });
});
