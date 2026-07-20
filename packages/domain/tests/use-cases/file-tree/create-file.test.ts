import { CreateFileUseCase } from '../../../src/use-cases/file-tree/create-file';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { Project } from '../../../src/entities/project';
import { ProjectMember } from '../../../src/entities/project-member';
import { FileNode } from '../../../src/entities/file-node';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { ProjectName } from '../../../src/value-objects/project/project-name';
import { Role } from '../../../src/value-objects/identity/role';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { FileNodeNotFoundError } from '../../../src/errors/file-tree/file-node-not-found';
import { FileConflictError } from '../../../src/errors/file-tree/file-conflict';

describe('CreateFileUseCase', () => {
  let projectRepo: InMemoryProjectRepository;
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let documentRepo: InMemoryDocumentRepository;
  let fileStore: InMemoryProjectFileStore;
  let auditLogRepo: InMemoryAuditLogRepository;
  let useCase: CreateFileUseCase;

  const actorId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const nonMemberId = UserId.create('550e8400-e29b-41d4-a716-446655440009');
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootFolderId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const initialContent = Buffer.from('');
  const mimeType = MimeType.create('text/asciidoc');

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    projectMemberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    documentRepo = new InMemoryDocumentRepository();
    fileStore = new InMemoryProjectFileStore();
    auditLogRepo = new InMemoryAuditLogRepository();

    useCase = new CreateFileUseCase(projectMemberRepo, fileNodeRepo, documentRepo, fileStore, auditLogRepo);

    const project = new Project(projectId, ProjectName.create('Test'), null, [], rootFolderId);
    await projectRepo.save(project);

    const rootFolder = new FileNode(rootFolderId, projectId, null, 'Test', FileNodeType.create('folder'), FilePath.create('/'));
    await fileNodeRepo.save(rootFolder);

    const member = new ProjectMember(projectId, actorId, Role.create('editor'));
    await projectMemberRepo.addMember(member);
  });

  it('creates FileNode + Document + calls fileStore.createExclusive', async () => {
    const result = await useCase.execute(actorId, projectId, rootFolderId, 'newfile.adoc', mimeType, initialContent);
    expect(result.success).toBe(true);
    if (result.success) {
      const fileNode = await fileNodeRepo.findById(result.value.fileNodeId);
      expect(fileNode).not.toBeNull();
      const content = await fileStore.read(projectId, result.value.path);
      expect(content).not.toBeNull();
    }
  });

  it('records a file.created audit log entry on success', async () => {
    const result = await useCase.execute(actorId, projectId, rootFolderId, 'newfile.adoc', mimeType, initialContent);
    expect(result.success).toBe(true);
    const entries = await auditLogRepo.findAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('file.created');
    expect(entries[0].metadata.path).toBe('/newfile.adoc');
  });

  it('returns FileConflictError when path is taken', async () => {
    await useCase.execute(actorId, projectId, rootFolderId, 'newfile.adoc', mimeType, initialContent);
    const result = await useCase.execute(actorId, projectId, rootFolderId, 'newfile.adoc', mimeType, initialContent);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(FileConflictError);
    }
  });

  it('returns PermissionDeniedError for non-member', async () => {
    const result = await useCase.execute(nonMemberId, projectId, rootFolderId, 'test.adoc', mimeType, initialContent);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('records an authz.denied audit log entry for a non-member', async () => {
    const result = await useCase.execute(nonMemberId, projectId, rootFolderId, 'test.adoc', mimeType, initialContent);
    expect(result.success).toBe(false);
    const entries = await auditLogRepo.findAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('authz.denied');
    expect(entries[0].resourceType).toBe('Project');
    expect(entries[0].resourceId).toBe(projectId.value);
    expect(entries[0].metadata.reason).toBe('not_a_project_member');
  });

  it('denies a viewer and records insufficient_role', async () => {
    const viewerId = UserId.create('550e8400-e29b-41d4-a716-44665544000a');
    await projectMemberRepo.addMember(new ProjectMember(projectId, viewerId, Role.create('viewer')));
    const result = await useCase.execute(viewerId, projectId, rootFolderId, 'test.adoc', mimeType, initialContent);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.name).toBe('PermissionDeniedError');
    const entries = await auditLogRepo.findAll();
    expect(entries[0].metadata.reason).toBe('insufficient_role');
  });

  it('returns FileNodeNotFoundError for unknown parent', async () => {
    const unknownId = FileNodeId.create('ff0e8400-e29b-41d4-a716-446655440099');
    const result = await useCase.execute(actorId, projectId, unknownId, 'test.adoc', mimeType, initialContent);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
    }
  });

  it('throws ValidationError for a name with path traversal (..)', async () => {
    await expect(
      useCase.execute(actorId, projectId, rootFolderId, '../secret.adoc', mimeType, initialContent),
    ).rejects.toThrow();
  });

  it('throws ValidationError for a name containing a newline', async () => {
    await expect(
      useCase.execute(actorId, projectId, rootFolderId, 'bad\nname.adoc', mimeType, initialContent),
    ).rejects.toThrow();
  });

  it('throws ValidationError for a name with a forward slash', async () => {
    await expect(
      useCase.execute(actorId, projectId, rootFolderId, 'a/b.adoc', mimeType, initialContent),
    ).rejects.toThrow();
  });

  it('throws ValidationError for an empty name', async () => {
    await expect(
      useCase.execute(actorId, projectId, rootFolderId, '', mimeType, initialContent),
    ).rejects.toThrow();
  });

  it('creates a file with spaces in the name', async () => {
    const result = await useCase.execute(actorId, projectId, rootFolderId, 'my document.adoc', mimeType, initialContent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.path.value).toBe('/my document.adoc');
      const fileNode = await fileNodeRepo.findById(result.value.fileNodeId);
      expect(fileNode?.name).toBe('my document.adoc');
    }
  });

  test('a failed audit write does NOT fail the operation and is logged', async () => {
    const throwingAudit = { save: jest.fn().mockRejectedValue(new Error('audit db down')) } as never;
    const logger = { warn: jest.fn() };
    jest.spyOn(fileStore, 'remove');

    const resilientUseCase = new CreateFileUseCase(projectMemberRepo, fileNodeRepo, documentRepo, fileStore, throwingAudit, logger);

    const result = await resilientUseCase.execute(actorId, projectId, rootFolderId, 'newfile.adoc', mimeType, initialContent);
    expect(result.success).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    // The already-committed content must NOT be torn down by the compensation path.
    expect(fileStore.remove).not.toHaveBeenCalled();
  });
});

describe('CreateFileUseCase — orphan cleanup on DB failure', () => {
  let projectMemberRepo2: InMemoryProjectMemberRepository;
  let fileNodeRepo2: InMemoryFileNodeRepository;
  let documentRepo2: InMemoryDocumentRepository;
  let fileStore2: InMemoryProjectFileStore;

  const actorId2 = UserId.create('550e8400-e29b-41d4-a716-330000000001');
  const projectId2 = ProjectId.create('770e8400-e29b-41d4-a716-330000000003');
  const rootFolderId2 = FileNodeId.create('880e8400-e29b-41d4-a716-330000000004');

  beforeEach(async () => {
    projectMemberRepo2 = new InMemoryProjectMemberRepository();
    fileNodeRepo2 = new InMemoryFileNodeRepository();
    documentRepo2 = new InMemoryDocumentRepository();
    fileStore2 = new InMemoryProjectFileStore();

    const rootFolder2 = new FileNode(
      rootFolderId2, projectId2, null, 'root',
      FileNodeType.create('folder'), FilePath.create('/'),
    );
    await fileNodeRepo2.save(rootFolder2);
    await projectMemberRepo2.addMember(new ProjectMember(projectId2, actorId2, Role.create('editor')));
  });

  it('cleans up the disk file when fileNodeRepo.save throws after createExclusive succeeds', async () => {
    fileNodeRepo2.save = jest.fn().mockRejectedValue(new Error('DB down'));

    const useCase2 = new CreateFileUseCase(projectMemberRepo2, fileNodeRepo2, documentRepo2, fileStore2, new InMemoryAuditLogRepository());

    await expect(
      useCase2.execute(actorId2, projectId2, rootFolderId2, 'new.adoc', MimeType.create('text/asciidoc'), Buffer.from(''))
    ).rejects.toThrow('DB down');

    // The file must have been cleaned up — no orphan on disk
    const orphan = await fileStore2.read(projectId2, FilePath.create('/new.adoc'));
    expect(orphan).toBeNull();
  });
});
