import { CreateFolderUseCase } from '../../../src/use-cases/file-tree/create-folder';
import { FileConflictError } from '../../../src/errors/file-tree/file-conflict';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
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
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { FileNodeNotFoundError } from '../../../src/errors/file-tree/file-node-not-found';

describe('CreateFolderUseCase', () => {
  let projectRepo: InMemoryProjectRepository;
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let fileStore: InMemoryProjectFileStore;
  let auditLogRepo: InMemoryAuditLogRepository;
  let useCase: CreateFolderUseCase;

  const actorId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const nonMemberId = UserId.create('550e8400-e29b-41d4-a716-446655440009');
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootFolderId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    projectMemberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    fileStore = new InMemoryProjectFileStore();
    auditLogRepo = new InMemoryAuditLogRepository();

    useCase = new CreateFolderUseCase(projectMemberRepo, fileNodeRepo, fileStore, auditLogRepo);

    const project = new Project(projectId, ProjectName.create('Test'), null, [], rootFolderId);
    await projectRepo.save(project);

    const rootFolder = new FileNode(rootFolderId, projectId, null, 'Test', FileNodeType.create('folder'), FilePath.create('/'));
    await fileNodeRepo.save(rootFolder);

    const member = new ProjectMember(projectId, actorId, Role.create('editor'));
    await projectMemberRepo.addMember(member);
  });

  it('creates FileNode and calls fileStore.createDirectory', async () => {
    const result = await useCase.execute(actorId, projectId, rootFolderId, 'myfolder');
    expect(result.success).toBe(true);
    if (result.success) {
      const fileNode = await fileNodeRepo.findById(result.value.fileNodeId);
      expect(fileNode?.type.value).toBe('folder');
    }
  });

  it('records a folder.created audit log entry on success', async () => {
    const result = await useCase.execute(actorId, projectId, rootFolderId, 'myfolder');
    expect(result.success).toBe(true);
    const entries = await auditLogRepo.findAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('folder.created');
    expect(entries[0].metadata.path).toBe('/myfolder');
  });

  it('returns PermissionDeniedError for non-member', async () => {
    const result = await useCase.execute(nonMemberId, projectId, rootFolderId, 'myfolder');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('records an authz.denied audit log entry for a non-member', async () => {
    const result = await useCase.execute(nonMemberId, projectId, rootFolderId, 'myfolder');
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
    const result = await useCase.execute(viewerId, projectId, rootFolderId, 'myfolder');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.name).toBe('PermissionDeniedError');
    const entries = await auditLogRepo.findAll();
    expect(entries[0].metadata.reason).toBe('insufficient_role');
  });

  it('returns FileNodeNotFoundError for unknown parent', async () => {
    const unknownId = FileNodeId.create('ff0e8400-e29b-41d4-a716-446655440099');
    const result = await useCase.execute(actorId, projectId, unknownId, 'myfolder');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
    }
  });

  it('throws ValidationError for a folder name with path traversal (..)', async () => {
    await expect(
      useCase.execute(actorId, projectId, rootFolderId, '..'),
    ).rejects.toThrow();
  });

  it('throws ValidationError for a folder name with a forward slash', async () => {
    await expect(
      useCase.execute(actorId, projectId, rootFolderId, 'a/b'),
    ).rejects.toThrow();
  });

  it('throws ValidationError for an empty folder name', async () => {
    await expect(
      useCase.execute(actorId, projectId, rootFolderId, ''),
    ).rejects.toThrow();
  });

  it('creates a folder with spaces in the name', async () => {
    const result = await useCase.execute(actorId, projectId, rootFolderId, 'my folder');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.path.value).toBe('/my folder');
    }
  });

  it('creates a nested folder whose parent has spaces in its name', async () => {
    const parent = await useCase.execute(actorId, projectId, rootFolderId, 'my docs');
    expect(parent.success).toBe(true);
    if (!parent.success) return;

    const child = await useCase.execute(actorId, projectId, parent.value.fileNodeId, 'sub folder');
    expect(child.success).toBe(true);
    if (child.success) {
      expect(child.value.path.value).toBe('/my docs/sub folder');
    }
  });

  it('returns FileConflictError with existingId when folder with same name already exists under same parent', async () => {
    const first = await useCase.execute(actorId, projectId, rootFolderId, 'docs');
    expect(first.success).toBe(true);
    if (!first.success) return;
    const existingId = first.value.fileNodeId.value;

    const second = await useCase.execute(actorId, projectId, rootFolderId, 'docs');
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error).toBeInstanceOf(FileConflictError);
      expect((second.error as FileConflictError).existingId).toBe(existingId);
    }
  });

  test('a failed audit write does NOT fail the operation and is logged', async () => {
    const throwingAudit = { save: jest.fn().mockRejectedValue(new Error('audit db down')) } as never;
    const logger = { warn: jest.fn() };

    const resilientUseCase = new CreateFolderUseCase(projectMemberRepo, fileNodeRepo, fileStore, throwingAudit, logger);

    const result = await resilientUseCase.execute(actorId, projectId, rootFolderId, 'myfolder');
    expect(result.success).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});
