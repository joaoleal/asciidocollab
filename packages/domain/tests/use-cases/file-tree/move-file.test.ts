import { MoveFileUseCase } from '../../../src/use-cases/file-tree/move-file';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
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
import { FileNodeNotFoundError } from '../../../src/errors/file-tree/file-node-not-found';
import { FileConflictError } from '../../../src/errors/file-tree/file-conflict';
import { CannotDeleteRootFolderError } from '../../../src/errors/file-tree/cannot-delete-root-folder';

describe('MoveFileUseCase', () => {
  let projectRepo: InMemoryProjectRepository;
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let fileStore: InMemoryProjectFileStore;
  let auditLogRepo: InMemoryAuditLogRepository;
  let useCase: MoveFileUseCase;

  const actorId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootFolderId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const subFolderId = FileNodeId.create('990e8400-e29b-41d4-a716-446655440005');
  const fileNodeId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
  const filePath = FilePath.create('/test.adoc');
  const fileContent = Buffer.from('hello');

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    projectMemberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    fileStore = new InMemoryProjectFileStore();
    auditLogRepo = new InMemoryAuditLogRepository();

    useCase = new MoveFileUseCase(projectMemberRepo, fileNodeRepo, fileStore, auditLogRepo);

    const project = new Project(projectId, ProjectName.create('Test'), null, [], rootFolderId);
    await projectRepo.save(project);

    const rootFolder = new FileNode(rootFolderId, projectId, null, 'Test', FileNodeType.create('folder'), FilePath.create('/'));
    await fileNodeRepo.save(rootFolder);

    const subFolder = new FileNode(subFolderId, projectId, rootFolderId, 'sub', FileNodeType.create('folder'), FilePath.create('/sub'));
    await fileNodeRepo.save(subFolder);

    const fileNode = new FileNode(fileNodeId, projectId, rootFolderId, 'test.adoc', FileNodeType.create('file'), filePath);
    await fileNodeRepo.save(fileNode);
    await fileStore.write(projectId, filePath, fileContent);

    const member = new ProjectMember(projectId, actorId, Role.create('editor'));
    await projectMemberRepo.addMember(member);
  });

  it('updates FileNode parentId + path and calls fileStore.move', async () => {
    const result = await useCase.execute(actorId, projectId, fileNodeId, subFolderId);
    expect(result.success).toBe(true);
    if (result.success) {
      const updated = await fileNodeRepo.findById(fileNodeId);
      expect(updated?.parentId?.value).toBe(subFolderId.value);
      expect(updated?.path.value).toBe('/sub/test.adoc');
    }
  });

  it('records a file.moved audit log with from/to metadata', async () => {
    const result = await useCase.execute(actorId, projectId, fileNodeId, subFolderId);
    expect(result.success).toBe(true);

    const logs = await auditLogRepo.findByProjectId(projectId);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('file.moved');
    expect(logs[0].resourceId).toBe(fileNodeId.value);
    expect(logs[0].metadata.from).toBe('/test.adoc');
    expect(logs[0].metadata.to).toBe('/sub/test.adoc');
  });

  it('returns FileConflictError on destination conflict', async () => {
    const existingId = FileNodeId.create('bb0e8400-e29b-41d4-a716-446655440007');
    const existingPath = FilePath.create('/sub/test.adoc');
    const existing = new FileNode(existingId, projectId, subFolderId, 'test.adoc', FileNodeType.create('file'), existingPath);
    await fileNodeRepo.save(existing);
    await fileStore.write(projectId, existingPath, Buffer.from('existing'));

    const result = await useCase.execute(actorId, projectId, fileNodeId, subFolderId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(FileConflictError);
    }
  });

  it('cannot move root folder', async () => {
    const result = await useCase.execute(actorId, projectId, rootFolderId, subFolderId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(CannotDeleteRootFolderError);
    }
  });

  it('updates descendant FileNode paths in DB when moving a folder', async () => {
    const sourceId = FileNodeId.create('cc0e8400-e29b-41d4-a716-446655440020');
    const utilitiesId = FileNodeId.create('cc0e8400-e29b-41d4-a716-446655440021');
    const helperFileId = FileNodeId.create('cc0e8400-e29b-41d4-a716-446655440022');
    const libraryId = FileNodeId.create('cc0e8400-e29b-41d4-a716-446655440023');

    const sourceFolder = new FileNode(sourceId, projectId, rootFolderId, 'src', FileNodeType.create('folder'), FilePath.create('/src'));
    await fileNodeRepo.save(sourceFolder);
    await fileStore.createDirectory(projectId, FilePath.create('/src'));

    const utilitiesFolder = new FileNode(utilitiesId, projectId, sourceId, 'utils', FileNodeType.create('folder'), FilePath.create('/src/utils'));
    await fileNodeRepo.save(utilitiesFolder);
    await fileStore.createDirectory(projectId, FilePath.create('/src/utils'));

    const helperFile = new FileNode(helperFileId, projectId, utilitiesId, 'helper.adoc', FileNodeType.create('file'), FilePath.create('/src/utils/helper.adoc'));
    await fileNodeRepo.save(helperFile);
    await fileStore.write(projectId, FilePath.create('/src/utils/helper.adoc'), Buffer.from('helper'));

    const libraryFolder = new FileNode(libraryId, projectId, rootFolderId, 'lib', FileNodeType.create('folder'), FilePath.create('/lib'));
    await fileNodeRepo.save(libraryFolder);
    await fileStore.createDirectory(projectId, FilePath.create('/lib'));

    // Move /src/utils -> /lib/utils
    const result = await useCase.execute(actorId, projectId, utilitiesId, libraryId);
    expect(result.success).toBe(true);

    const updatedHelper = await fileNodeRepo.findById(helperFileId);
    expect(updatedHelper?.path.value).toBe('/lib/utils/helper.adoc');
  });

  it('records an authz.denied audit log entry for a non-member', async () => {
    const nonMemberId = UserId.create('550e8400-e29b-41d4-a716-446655440009');
    const result = await useCase.execute(nonMemberId, projectId, fileNodeId, subFolderId);
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
    const result = await useCase.execute(viewerId, projectId, fileNodeId, subFolderId);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.name).toBe('PermissionDeniedError');
    const entries = await auditLogRepo.findAll();
    expect(entries[0].metadata.reason).toBe('insufficient_role');
  });

  it('returns FileNodeNotFoundError when fileNode belongs to a different project', async () => {
    const otherProjectId = ProjectId.create('ff0e8400-e29b-41d4-a716-446655440099');
    const alienNodeId = FileNodeId.create('ee0e8400-e29b-41d4-a716-446655440011');
    const alienParentId = FileNodeId.create('ee0e8400-e29b-41d4-a716-446655440019');
    const alienNode = new FileNode(
      alienNodeId,
      otherProjectId,
      alienParentId,
      'alien.adoc',
      FileNodeType.create('file'),
      FilePath.create('/alien.adoc'),
    );
    await fileNodeRepo.save(alienNode);

    const result = await useCase.execute(actorId, projectId, alienNodeId, subFolderId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
    }
  });

  it('returns FileNodeNotFoundError when newParent belongs to a different project', async () => {
    const otherProjectId = ProjectId.create('ff0e8400-e29b-41d4-a716-446655440099');
    const alienFolderId = FileNodeId.create('ee0e8400-e29b-41d4-a716-446655440012');
    const alienFolder = new FileNode(
      alienFolderId,
      otherProjectId,
      null,
      'alienfolder',
      FileNodeType.create('folder'),
      FilePath.create('/alienfolder'),
    );
    await fileNodeRepo.save(alienFolder);

    const result = await useCase.execute(actorId, projectId, fileNodeId, alienFolderId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
    }
  });

  test('a failed audit write does NOT fail the operation and is logged', async () => {
    const throwingAudit = { save: jest.fn().mockRejectedValue(new Error('audit db down')) } as never;
    const logger = { warn: jest.fn() };

    const resilientUseCase = new MoveFileUseCase(projectMemberRepo, fileNodeRepo, fileStore, throwingAudit, logger);

    const result = await resilientUseCase.execute(actorId, projectId, fileNodeId, subFolderId);
    expect(result.success).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('MoveFileUseCase — reference rewrite + main-file consistency', () => {
  const actor = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const project = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const sharedDirectoryId = FileNodeId.create('880e8400-e29b-41d4-a716-44665544000a');
  const chaptersDirectoryId = FileNodeId.create('990e8400-e29b-41d4-a716-446655440005');
  const bookId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
  const introId = FileNodeId.create('bb0e8400-e29b-41d4-a716-446655440007');

  const BOOK = '= Book\n\ninclude::chapters/intro.adoc[]\n\nSee xref:chapters/intro.adoc#start[Intro].\n';

  let memberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let fileStore: InMemoryProjectFileStore;
  let auditLogRepo: InMemoryAuditLogRepository;
  let projectRepo: InMemoryProjectRepository;
  let projectEntity: Project;

  function buildUseCase(): MoveFileUseCase {
    return new MoveFileUseCase(memberRepo, fileNodeRepo, fileStore, auditLogRepo);
  }

  beforeEach(async () => {
    memberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    fileStore = new InMemoryProjectFileStore();
    auditLogRepo = new InMemoryAuditLogRepository();
    projectRepo = new InMemoryProjectRepository();

    projectEntity = new Project(project, ProjectName.create('Book'), null, [], rootId);
    await projectRepo.save(projectEntity);

    await fileNodeRepo.save(new FileNode(rootId, project, null, 'Root', FileNodeType.create('folder'), FilePath.create('/')));
    await fileNodeRepo.save(new FileNode(chaptersDirectoryId, project, rootId, 'chapters', FileNodeType.create('folder'), FilePath.create('/chapters')));
    await fileNodeRepo.save(new FileNode(sharedDirectoryId, project, rootId, 'shared', FileNodeType.create('folder'), FilePath.create('/shared')));
    await fileNodeRepo.save(new FileNode(bookId, project, rootId, 'book.adoc', FileNodeType.create('file'), FilePath.create('/book.adoc')));
    await fileNodeRepo.save(new FileNode(introId, project, chaptersDirectoryId, 'intro.adoc', FileNodeType.create('file'), FilePath.create('/chapters/intro.adoc')));
    await fileStore.write(project, FilePath.create('/book.adoc'), Buffer.from(BOOK));
    await fileStore.write(project, FilePath.create('/chapters/intro.adoc'), Buffer.from('[[start]]\n= Intro\n'));
    await fileStore.createDirectory(project, FilePath.create('/shared'));
    await memberRepo.addMember(new ProjectMember(project, actor, Role.create('editor')));
  });

  it('rewrites include:: and xref: paths in other files when a referenced file moves', async () => {
    const useCase = await buildUseCase();
    const result = await useCase.execute(actor, project, introId, sharedDirectoryId);
    expect(result.success).toBe(true);

    const book = (await fileStore.read(project, FilePath.create('/book.adoc')))!.toString('utf8');
    expect(book).toContain('include::shared/intro.adoc[]');
    expect(book).toContain('xref:shared/intro.adoc#start[Intro]');
    expect(book).not.toContain('chapters/intro.adoc');
  });

  it('keeps the project main-file configuration pointing at the moved file', async () => {
    projectEntity.setMainFile(introId);
    await projectRepo.save(projectEntity);

    const useCase = await buildUseCase();
    const result = await useCase.execute(actor, project, introId, sharedDirectoryId);
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.mainFileCleared).toBe(false);

    const reloaded = await projectRepo.findById(project);
    expect(reloaded!.mainFileNodeId!.value).toBe(introId.value);
  });

  it('rewrites references with the default constructor (no separate opt-in)', async () => {
    // The structural rules are domain-owned and always available, so a plain
    // MoveFileUseCase (no extra dependencies) rewrites references too.
    const plain = new MoveFileUseCase(memberRepo, fileNodeRepo, fileStore, auditLogRepo);
    const result = await plain.execute(actor, project, introId, sharedDirectoryId);
    expect(result.success).toBe(true);
    const book = (await fileStore.read(project, FilePath.create('/book.adoc')))!.toString('utf8');
    expect(book).toContain('include::shared/intro.adoc[]');
    expect(book).not.toContain('chapters/intro.adoc');
  });
});
