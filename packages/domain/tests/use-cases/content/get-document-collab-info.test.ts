import { GetDocumentCollabInfoUseCase } from '../../../src/use-cases/content/get-document-collab-info';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryDocumentRepository } from '../../ports/file-tree/in-memory-document.repository';
import { ProjectMember } from '../../../src/entities/project-member';
import { FileNode } from '../../../src/entities/file-node';
import { Document } from '../../../src/entities/document';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { DocumentId } from '../../../src/value-objects/ids/document-id';
import { Role } from '../../../src/value-objects/identity/role';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { ContentId } from '../../../src/value-objects/ids/content-id';
import { YjsStateId } from '../../../src/value-objects/ids/yjs-state-id';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { FileNodeNotFoundError } from '../../../src/errors/file-tree/file-node-not-found';
import { ContentNotFoundError } from '../../../src/errors/content/content-not-found';

/**
 * Membership repository that answers the first composite-key lookup and then reports the actor as
 * a non-member, modelling a membership revoked between the access check and the role lookup.
 */
class RevokedAfterFirstLookupMemberRepository extends InMemoryProjectMemberRepository {
  private lookups = 0;

  override async findByCompositeKey(projectId: ProjectId, userId: UserId): Promise<ProjectMember | null> {
    this.lookups += 1;
    return this.lookups === 1 ? super.findByCompositeKey(projectId, userId) : null;
  }
}

describe('GetDocumentCollabInfoUseCase', () => {
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let documentRepo: InMemoryDocumentRepository;
  let useCase: GetDocumentCollabInfoUseCase;

  const editorId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const viewerId = UserId.create('550e8400-e29b-41d4-a716-446655440002');
  const nonMemberId = UserId.create('550e8400-e29b-41d4-a716-446655440009');
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootFolderId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const fileNodeId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
  const assetNodeId = FileNodeId.create('aa1e8400-e29b-41d4-a716-446655440006');
  const documentId = DocumentId.create('bb0e8400-e29b-41d4-a716-446655440007');
  const yjsStateId = 'dd0e8400-e29b-41d4-a716-446655440009';

  beforeEach(async () => {
    projectMemberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    documentRepo = new InMemoryDocumentRepository();

    useCase = new GetDocumentCollabInfoUseCase(projectMemberRepo, fileNodeRepo, documentRepo);

    const rootFolder = new FileNode(rootFolderId, projectId, null, 'Test', FileNodeType.create('folder'), FilePath.create('/'));
    await fileNodeRepo.save(rootFolder);

    const fileNode = new FileNode(fileNodeId, projectId, rootFolderId, 'test.adoc', FileNodeType.create('file'), FilePath.create('/test.adoc'));
    await fileNodeRepo.save(fileNode);

    // A binary asset file node with no backing Document.
    const assetNode = new FileNode(assetNodeId, projectId, rootFolderId, 'logo.png', FileNodeType.create('file'), FilePath.create('/logo.png'));
    await fileNodeRepo.save(assetNode);

    const document = new Document(
      documentId,
      fileNodeId,
      ContentId.create('cc0e8400-e29b-41d4-a716-446655440008'),
      YjsStateId.create(yjsStateId),
      MimeType.create('text/asciidoc'),
    );
    await documentRepo.save(document);

    await projectMemberRepo.addMember(new ProjectMember(projectId, editorId, Role.create('editor')));
    await projectMemberRepo.addMember(new ProjectMember(projectId, viewerId, Role.create('viewer')));
  });

  it('returns role "editor" and the yjsStateId for an editor member', async () => {
    const result = await useCase.execute(editorId, projectId, fileNodeId);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.role).toBe('editor');
      expect(result.value.yjsStateId).toBe(yjsStateId);
    }
  });

  it('maps a viewer member to role "observer"', async () => {
    const result = await useCase.execute(viewerId, projectId, fileNodeId);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.role).toBe('observer');
      expect(result.value.yjsStateId).toBe(yjsStateId);
    }
  });

  it('returns PermissionDeniedError for a non-member', async () => {
    const result = await useCase.execute(nonMemberId, projectId, fileNodeId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('returns FileNodeNotFoundError for an unknown node', async () => {
    const unknownId = FileNodeId.create('ff0e8400-e29b-41d4-a716-446655440099');
    const result = await useCase.execute(editorId, projectId, unknownId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
    }
  });

  it('returns ContentNotFoundError for an asset with no backing Document', async () => {
    const result = await useCase.execute(editorId, projectId, assetNodeId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ContentNotFoundError);
    }
  });

  it('falls back to the editor role when the membership disappears after the access check', async () => {
    const revokingRepo = new RevokedAfterFirstLookupMemberRepository();
    await revokingRepo.addMember(new ProjectMember(projectId, viewerId, Role.create('viewer')));
    const raced = new GetDocumentCollabInfoUseCase(revokingRepo, fileNodeRepo, documentRepo);

    const result = await raced.execute(viewerId, projectId, fileNodeId);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.role).toBe('editor');
    }
  });
});
