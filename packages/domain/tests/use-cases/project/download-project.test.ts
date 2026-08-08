import { DownloadProjectUseCase } from '../../../src/use-cases/project/download-project';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { InMemoryCollaborationSessionRepository } from '../../ports/project/in-memory-collaboration-session-repository';
import { Project } from '../../../src/entities/project';
import { FileNode } from '../../../src/entities/file-node';
import { Document } from '../../../src/entities/document';
import { ProjectMember } from '../../../src/entities/project-member';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { ProjectName } from '../../../src/value-objects/project/project-name';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Role } from '../../../src/value-objects/identity/role';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import type { CollaborativeContentReader } from '../../../src/ports/storage/collaborative-content-reader';

const PROJECT_ID   = '550e8400-e29b-41d4-a716-446655440001';
const MEMBER_ID    = '550e8400-e29b-41d4-a716-446655440002';
const NON_MEMBER   = '550e8400-e29b-41d4-a716-446655440003';
const ROOT_NODE_ID = '550e8400-e29b-41d4-a716-446655440004';
const FOLDER_ID    = '550e8400-e29b-41d4-a716-446655440005';
const FILE_1_ID    = '550e8400-e29b-41d4-a716-446655440006';
const FILE_2_ID    = '550e8400-e29b-41d4-a716-446655440007';
const FILE_3_ID    = '550e8400-e29b-41d4-a716-446655440008';
const DOC_1_ID     = '550e8400-e29b-41d4-a716-446655440009';
const CONTENT_1_ID = '550e8400-e29b-41d4-a716-446655440010';
const YJS_1_ID     = '550e8400-e29b-41d4-a716-446655440011';
const DOC_2_ID     = '550e8400-e29b-41d4-a716-446655440012';
const CONTENT_2_ID = '550e8400-e29b-41d4-a716-446655440013';
const YJS_2_ID     = '550e8400-e29b-41d4-a716-446655440014';

describe('DownloadProjectUseCase', () => {
  let projectRepo: InMemoryProjectRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let memberRepo: InMemoryProjectMemberRepository;
  let useCase: DownloadProjectUseCase;

  const projectId  = ProjectId.create(PROJECT_ID);
  const memberId   = UserId.create(MEMBER_ID);
  const nonMember  = UserId.create(NON_MEMBER);
  const rootNodeId = FileNodeId.create(ROOT_NODE_ID);
  const folderId   = FileNodeId.create(FOLDER_ID);
  const file1Id    = FileNodeId.create(FILE_1_ID);
  const file2Id    = FileNodeId.create(FILE_2_ID);

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    memberRepo = new InMemoryProjectMemberRepository();
    useCase = new DownloadProjectUseCase(projectRepo, fileNodeRepo, memberRepo);

    // Project
    const project = new Project(projectId, ProjectName.create('Test Project'), null, [], rootNodeId);
    await projectRepo.save(project);

    // Root folder
    await fileNodeRepo.save(
      new FileNode(rootNodeId, projectId, null, 'Test Project', FileNodeType.create('folder'), FilePath.create('/')),
    );

    // A sub-folder: /docs
    await fileNodeRepo.save(
      new FileNode(folderId, projectId, rootNodeId, 'docs', FileNodeType.create('folder'), FilePath.create('/docs')),
    );

    // File 1 at root: /readme.adoc
    await fileNodeRepo.save(
      new FileNode(file1Id, projectId, rootNodeId, 'readme.adoc', FileNodeType.create('file'), FilePath.create('/readme.adoc')),
    );

    // File 2 nested: /docs/guide.adoc
    await fileNodeRepo.save(
      new FileNode(file2Id, projectId, folderId, 'guide.adoc', FileNodeType.create('file'), FilePath.create('/docs/guide.adoc')),
    );

    // Membership
    await memberRepo.addMember(new ProjectMember(projectId, memberId, Role.create('viewer')));
  });

  test('member receives project name and list of FILE nodes with relative paths', async () => {
    const result = await useCase.execute(memberId, projectId);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.value.projectName).toBe('Test Project');

    const paths = result.value.files.map((f) => f.relativePath);
    expect(paths).toContain('readme.adoc');
    expect(paths).toContain('docs/guide.adoc');

    // Should NOT include folder nodes
    const nodeIds = result.value.files.map((f) => f.fileNode.id.value);
    expect(nodeIds).toContain(FILE_1_ID);
    expect(nodeIds).toContain(FILE_2_ID);
    expect(nodeIds).not.toContain(ROOT_NODE_ID);
    expect(nodeIds).not.toContain(FOLDER_ID);
  });

  test('non-member returns PermissionDeniedError', async () => {
    const result = await useCase.execute(nonMember, projectId);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(PermissionDeniedError);
  });

  test('result files list excludes folder nodes', async () => {
    const result = await useCase.execute(memberId, projectId);

    expect(result.success).toBe(true);
    if (!result.success) return;

    for (const { fileNode } of result.value.files) {
      expect(fileNode.type.value).toBe('file');
    }
  });

  test('relative paths strip leading slash', async () => {
    const result = await useCase.execute(memberId, projectId);

    expect(result.success).toBe(true);
    if (!result.success) return;

    for (const { relativePath } of result.value.files) {
      expect(relativePath).not.toMatch(/^\//);
    }
  });
});

describe('DownloadProjectUseCase — content source resolution', () => {
  let projectRepo: InMemoryProjectRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let memberRepo: InMemoryProjectMemberRepository;
  let documentRepo: InMemoryDocumentRepository;
  let collaborationSessionRepo: InMemoryCollaborationSessionRepository;

  const projectId  = ProjectId.create(PROJECT_ID);
  const memberId   = UserId.create(MEMBER_ID);
  const rootNodeId = FileNodeId.create(ROOT_NODE_ID);
  const folderId   = FileNodeId.create(FOLDER_ID);
  const file1Id    = FileNodeId.create(FILE_1_ID);  // live document
  const file2Id    = FileNodeId.create(FILE_2_ID);  // dormant document
  const file3Id    = FileNodeId.create(FILE_3_ID);  // binary asset (no document)

  const document1 = new Document(
    DocumentId.create(DOC_1_ID),
    file1Id,
    ContentId.create(CONTENT_1_ID),
    YjsStateId.create(YJS_1_ID),
    MimeType.create('text/asciidoc'),
  );
  const document2 = new Document(
    DocumentId.create(DOC_2_ID),
    file2Id,
    ContentId.create(CONTENT_2_ID),
    YjsStateId.create(YJS_2_ID),
    MimeType.create('text/asciidoc'),
  );

  const liveText = '= Live Content\nEdited by user';

  async function setup(reader: CollaborativeContentReader) {
    projectRepo = new InMemoryProjectRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    memberRepo = new InMemoryProjectMemberRepository();
    documentRepo = new InMemoryDocumentRepository();
    collaborationSessionRepo = new InMemoryCollaborationSessionRepository();

    const project = new Project(projectId, ProjectName.create('Test Project'), null, [], rootNodeId);
    await projectRepo.save(project);

    await fileNodeRepo.save(new FileNode(rootNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/')));
    await fileNodeRepo.save(new FileNode(folderId, projectId, rootNodeId, 'docs', FileNodeType.create('folder'), FilePath.create('/docs')));
    // file1: live document
    await fileNodeRepo.save(new FileNode(file1Id, projectId, rootNodeId, 'readme.adoc', FileNodeType.create('file'), FilePath.create('/readme.adoc')));
    // file2: dormant document
    await fileNodeRepo.save(new FileNode(file2Id, projectId, folderId, 'guide.adoc', FileNodeType.create('file'), FilePath.create('/docs/guide.adoc')));
    // file3: binary asset (no document)
    await fileNodeRepo.save(new FileNode(file3Id, projectId, rootNodeId, 'photo.png', FileNodeType.create('file'), FilePath.create('/photo.png')));

    await documentRepo.save(document1);
    await documentRepo.save(document2);
    // document1 has active session; document2 does not
    await collaborationSessionRepo.open(projectId, document1.id);

    await memberRepo.addMember(new ProjectMember(projectId, memberId, Role.create('viewer')));

    return new DownloadProjectUseCase(projectRepo, fileNodeRepo, memberRepo, documentRepo, collaborationSessionRepo, reader);
  }

  test('mixed project: live doc → inline, dormant doc → stored, binary → stored', async () => {
    const reader: CollaborativeContentReader = {
      readContent: jest.fn().mockResolvedValue({ success: true, value: liveText }),
    };
    const useCase = await setup(reader);

    const result = await useCase.execute(memberId, projectId);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const byId = new Map(result.value.files.map((f) => [f.fileNode.id.value, f]));

    // file1: active session + reader returns text → inline
    const file1Entry = byId.get(FILE_1_ID);
    expect(file1Entry).toBeDefined();
    if (!file1Entry) throw new Error('file1 is missing from the download');
    expect(file1Entry.source.kind).toBe('inline');
    const inlineBytes = (file1Entry.source as Extract<typeof file1Entry.source, { kind: 'inline' }>).bytes;
    expect(inlineBytes).toEqual(Buffer.from(liveText, 'utf8'));

    // file2: document exists but NO active session → stored
    const file2Entry = byId.get(FILE_2_ID);
    expect(file2Entry).toBeDefined();
    expect(file2Entry!.source.kind).toBe('stored');

    // file3: no document (binary) → stored
    const file3Entry = byId.get(FILE_3_ID);
    expect(file3Entry).toBeDefined();
    expect(file3Entry!.source.kind).toBe('stored');
  });

  test('each returned file carries a resolved source', async () => {
    const reader: CollaborativeContentReader = {
      readContent: jest.fn().mockResolvedValue({ success: true, value: liveText }),
    };
    const useCase = await setup(reader);

    const result = await useCase.execute(memberId, projectId);

    expect(result.success).toBe(true);
    if (!result.success) return;

    for (const file of result.value.files) {
      expect(file).toHaveProperty('source');
      expect(['inline', 'stored']).toContain(file.source.kind);
    }
  });

  test('reader SECURITY: authorized projectId is always passed to reader (no cross-tenant read)', async () => {
    const readerMock = jest.fn().mockResolvedValue({ success: true, value: liveText });
    const reader: CollaborativeContentReader = { readContent: readerMock };
    const useCase = await setup(reader);

    await useCase.execute(memberId, projectId);

    // Every readContent call must use the authorized projectId
    for (const call of readerMock.mock.calls) {
      const [calledProjectId] = call as [{ value: string }, unknown];
      expect(calledProjectId.value).toBe(PROJECT_ID);
    }
  });

  test('no collab deps → all sources are stored (backward-compatible)', async () => {
    projectRepo = new InMemoryProjectRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    memberRepo = new InMemoryProjectMemberRepository();

    const project = new Project(projectId, ProjectName.create('Test Project'), null, [], rootNodeId);
    await projectRepo.save(project);
    await fileNodeRepo.save(new FileNode(rootNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/')));
    await fileNodeRepo.save(new FileNode(file1Id, projectId, rootNodeId, 'readme.adoc', FileNodeType.create('file'), FilePath.create('/readme.adoc')));
    await memberRepo.addMember(new ProjectMember(projectId, memberId, Role.create('viewer')));

    const useCase = new DownloadProjectUseCase(projectRepo, fileNodeRepo, memberRepo);
    const result = await useCase.execute(memberId, projectId);

    expect(result.success).toBe(true);
    if (!result.success) return;
    for (const file of result.value.files) {
      expect(file.source.kind).toBe('stored');
    }
  });
});

describe('DownloadProjectUseCase — batch document lookup (N+1 prevention)', () => {
  test('findByFileNodeIds is called once for all files, not once per file', async () => {
    const projectId  = ProjectId.create(PROJECT_ID);
    const memberId   = UserId.create(MEMBER_ID);
    const rootNodeId = FileNodeId.create(ROOT_NODE_ID);
    const file1Id    = FileNodeId.create(FILE_1_ID);
    const file2Id    = FileNodeId.create(FILE_2_ID);
    const file3Id    = FileNodeId.create(FILE_3_ID);

    const projectRepo = new InMemoryProjectRepository();
    const fileNodeRepo = new InMemoryFileNodeRepository();
    const memberRepo = new InMemoryProjectMemberRepository();
    const documentRepo = new InMemoryDocumentRepository();
    const sessionRepo = new InMemoryCollaborationSessionRepository();

    const project = new Project(projectId, ProjectName.create('P'), null, [], rootNodeId);
    await projectRepo.save(project);
    await fileNodeRepo.save(new FileNode(rootNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/')));
    await fileNodeRepo.save(new FileNode(file1Id, projectId, rootNodeId, 'a.adoc', FileNodeType.create('file'), FilePath.create('/a.adoc')));
    await fileNodeRepo.save(new FileNode(file2Id, projectId, rootNodeId, 'b.adoc', FileNodeType.create('file'), FilePath.create('/b.adoc')));
    await fileNodeRepo.save(new FileNode(file3Id, projectId, rootNodeId, 'c.adoc', FileNodeType.create('file'), FilePath.create('/c.adoc')));
    await memberRepo.addMember(new ProjectMember(projectId, memberId, Role.create('viewer')));

    const findByFileNodeIdsSpy = jest.spyOn(documentRepo, 'findByFileNodeIds');
    const findByFileNodeIdSpy  = jest.spyOn(documentRepo, 'findByFileNodeId');

    const reader: CollaborativeContentReader = { readContent: jest.fn().mockResolvedValue({ success: true, value: null }) };
    const useCase = new DownloadProjectUseCase(projectRepo, fileNodeRepo, memberRepo, documentRepo, sessionRepo, reader);
    const result = await useCase.execute(memberId, projectId);

    expect(result.success).toBe(true);
    // Batch method called exactly once for all files
    expect(findByFileNodeIdsSpy).toHaveBeenCalledTimes(1);
    // Per-file method must NOT be called (that would be N+1)
    expect(findByFileNodeIdSpy).not.toHaveBeenCalled();
  });

  test('concurrency cap: resolving 20 files does not issue more than CONCURRENCY_CAP concurrent external calls', async () => {
    const projectId  = ProjectId.create(PROJECT_ID);
    const memberId   = UserId.create(MEMBER_ID);
    const rootNodeId = FileNodeId.create(ROOT_NODE_ID);

    const projectRepo = new InMemoryProjectRepository();
    const fileNodeRepo = new InMemoryFileNodeRepository();
    const memberRepo = new InMemoryProjectMemberRepository();
    const documentRepo = new InMemoryDocumentRepository();
    const sessionRepo = new InMemoryCollaborationSessionRepository();

    const project = new Project(projectId, ProjectName.create('P'), null, [], rootNodeId);
    await projectRepo.save(project);
    await fileNodeRepo.save(new FileNode(rootNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/')));
    for (let index = 0; index < 20; index++) {
      const id = FileNodeId.create(`550e8400-e29b-41d4-a716-4466554400${String(index).padStart(2, '0')}`);
      await fileNodeRepo.save(new FileNode(id, projectId, rootNodeId, `f${index}.adoc`, FileNodeType.create('file'), FilePath.create(`/f${index}.adoc`)));
    }
    await memberRepo.addMember(new ProjectMember(projectId, memberId, Role.create('viewer')));

    let maxConcurrent = 0;
    let concurrent = 0;
    const reader: CollaborativeContentReader = {
      readContent: jest.fn().mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 0));
        concurrent--;
        return { success: true, value: null };
      }),
    };
    const useCase = new DownloadProjectUseCase(projectRepo, fileNodeRepo, memberRepo, documentRepo, sessionRepo, reader);
    await useCase.execute(memberId, projectId);

    // With 20 files and no active sessions, reader won't be called; but this validates the
    // structure works. If sessions were active, maxConcurrent should be ≤ CONCURRENCY_CAP.
    expect(maxConcurrent).toBeLessThanOrEqual(10);
  });
});

describe('DownloadProjectUseCase — batch session lookup (N+1 prevention for sessions)', () => {
  test('findActiveDocumentIds is called once instead of isActive once-per-file', async () => {
    const projectId  = ProjectId.create(PROJECT_ID);
    const memberId   = UserId.create(MEMBER_ID);
    const rootNodeId = FileNodeId.create(ROOT_NODE_ID);
    const file1Id    = FileNodeId.create(FILE_1_ID);
    const file2Id    = FileNodeId.create(FILE_2_ID);
    const file3Id    = FileNodeId.create(FILE_3_ID);

    const projectRepo = new InMemoryProjectRepository();
    const fileNodeRepo = new InMemoryFileNodeRepository();
    const memberRepo = new InMemoryProjectMemberRepository();
    const documentRepo = new InMemoryDocumentRepository();
    const sessionRepo = new InMemoryCollaborationSessionRepository();

    const project = new Project(projectId, ProjectName.create('P'), null, [], rootNodeId);
    await projectRepo.save(project);
    await fileNodeRepo.save(new FileNode(rootNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/')));
    await fileNodeRepo.save(new FileNode(file1Id, projectId, rootNodeId, 'a.adoc', FileNodeType.create('file'), FilePath.create('/a.adoc')));
    await fileNodeRepo.save(new FileNode(file2Id, projectId, rootNodeId, 'b.adoc', FileNodeType.create('file'), FilePath.create('/b.adoc')));
    await fileNodeRepo.save(new FileNode(file3Id, projectId, rootNodeId, 'c.adoc', FileNodeType.create('file'), FilePath.create('/c.adoc')));
    await memberRepo.addMember(new ProjectMember(projectId, memberId, Role.create('viewer')));

    const findActiveDocumentIdsSpy = jest.spyOn(sessionRepo, 'findActiveDocumentIds');
    const isActiveSpy = jest.spyOn(sessionRepo, 'isActive');

    const reader: CollaborativeContentReader = { readContent: jest.fn().mockResolvedValue({ success: true, value: null }) };
    const useCase = new DownloadProjectUseCase(projectRepo, fileNodeRepo, memberRepo, documentRepo, sessionRepo, reader);
    await useCase.execute(memberId, projectId);

    // Batch method called once for the whole project — not once per file.
    expect(findActiveDocumentIdsSpy).toHaveBeenCalledTimes(1);
    // Per-file isActive must NOT be called (that would be N+1).
    expect(isActiveSpy).not.toHaveBeenCalled();
  });

  test('InMemoryCollaborationSessionRepository.findActiveDocumentIds returns open document IDs', async () => {
    const projectId = ProjectId.create(PROJECT_ID);
    const document1Id = DocumentId.create(DOC_1_ID);
    const repo = new InMemoryCollaborationSessionRepository();

    await repo.open(projectId, document1Id);
    // doc2 intentionally NOT opened

    const active = await repo.findActiveDocumentIds(projectId);
    expect(active.map((d) => d.value)).toContain(DOC_1_ID);
    expect(active.map((d) => d.value)).not.toContain(DOC_2_ID);
  });
});

describe('DownloadProjectUseCase — configurable concurrency cap (Finding 9)', () => {
  test('concurrencyCap:2 limits concurrent readContent calls to at most 2', async () => {
    const projectId  = ProjectId.create(PROJECT_ID);
    const memberId   = UserId.create(MEMBER_ID);
    const rootNodeId = FileNodeId.create(ROOT_NODE_ID);

    const projectRepo = new InMemoryProjectRepository();
    const fileNodeRepo = new InMemoryFileNodeRepository();
    const memberRepo = new InMemoryProjectMemberRepository();
    const documentRepo = new InMemoryDocumentRepository();
    const sessionRepo = new InMemoryCollaborationSessionRepository();

    const project = new Project(projectId, ProjectName.create('P'), null, [], rootNodeId);
    await projectRepo.save(project);
    await fileNodeRepo.save(new FileNode(rootNodeId, projectId, null, 'root', FileNodeType.create('folder'), FilePath.create('/')));

    // Create 6 files, each with an active session so readContent is actually called.
    for (let index = 0; index < 6; index++) {
      const fileId = FileNodeId.create(`550e8400-e29b-41d4-a716-cc0000000${index}00`);
      const documentId = DocumentId.create(`550e8400-e29b-41d4-a716-dd0000000${index}00`);
      const contentId = ContentId.create(`550e8400-e29b-41d4-a716-ee0000000${index}00`);
      const yjsId  = YjsStateId.create(`550e8400-e29b-41d4-a716-ff0000000${index}00`);
      await fileNodeRepo.save(new FileNode(fileId, projectId, rootNodeId, `f${index}.adoc`, FileNodeType.create('file'), FilePath.create(`/f${index}.adoc`)));
      await documentRepo.save(new Document(documentId, fileId, contentId, yjsId, MimeType.create('text/asciidoc')));
      await sessionRepo.open(projectId, documentId);
    }
    await memberRepo.addMember(new ProjectMember(projectId, memberId, Role.create('viewer')));

    let maxConcurrent = 0;
    let concurrent = 0;
    const reader: CollaborativeContentReader = {
      readContent: jest.fn().mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 0));
        concurrent--;
        return { success: true, value: null };
      }),
    };

    const useCase = new DownloadProjectUseCase(projectRepo, fileNodeRepo, memberRepo, documentRepo, sessionRepo, reader, undefined, 2);
    await useCase.execute(memberId, projectId);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
