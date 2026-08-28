import { GetAssetContentByPathUseCase } from '../../../src/use-cases/content/get-asset-content-by-path';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryAssetRepository } from '../../ports/file-tree/in-memory-asset.repository';
import { InMemoryProjectFileStore } from '../../ports/storage/in-memory-project-file-store';
import { ProjectMember } from '../../../src/entities/project-member';
import { FileNode } from '../../../src/entities/file-node';
import { Asset } from '../../../src/entities/asset';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { Role } from '../../../src/value-objects/identity/role';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { MimeType } from '../../../src/value-objects/files/mime-type';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { FileNodeNotFoundError } from '../../../src/errors/file-tree/file-node-not-found';
import { ContentNotFoundError } from '../../../src/errors/content/content-not-found';

describe('GetAssetContentByPathUseCase', () => {
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let assetRepo: InMemoryAssetRepository;
  let fileStore: InMemoryProjectFileStore;
  let useCase: GetAssetContentByPathUseCase;

  const actorId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const nonMemberId = UserId.create('550e8400-e29b-41d4-a716-446655440009');
  const projectId = ProjectId.create('770e8400-e29b-41d4-a716-446655440003');
  const rootFolderId = FileNodeId.create('880e8400-e29b-41d4-a716-446655440004');
  const folderId = FileNodeId.create('990e8400-e29b-41d4-a716-446655440005');
  const fileNodeId = FileNodeId.create('aa0e8400-e29b-41d4-a716-446655440006');
  const filePath = FilePath.create('/img/photo.png');
  const fileBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
  const mimeType = MimeType.create('image/png');

  beforeEach(async () => {
    projectMemberRepo = new InMemoryProjectMemberRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    assetRepo = new InMemoryAssetRepository();
    fileStore = new InMemoryProjectFileStore();
    useCase = new GetAssetContentByPathUseCase(projectMemberRepo, assetRepo, fileNodeRepo, fileStore);

    await fileNodeRepo.save(new FileNode(rootFolderId, projectId, null, 'Root', FileNodeType.create('folder'), FilePath.create('/')));
    await fileNodeRepo.save(new FileNode(folderId, projectId, rootFolderId, 'img', FileNodeType.create('folder'), FilePath.create('/img')));
    await fileNodeRepo.save(new FileNode(fileNodeId, projectId, folderId, 'photo.png', FileNodeType.create('file'), filePath));
    await assetRepo.save(new Asset(fileNodeId, mimeType, BigInt(fileBytes.length)));
    await fileStore.write(projectId, filePath, fileBytes);
    await projectMemberRepo.addMember(new ProjectMember(projectId, actorId, Role.create('editor')));
  });

  it('resolves a nested path to the asset bytes for a member', async () => {
    const result = await useCase.execute(actorId, projectId, 'img/photo.png');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.bytes).toEqual(fileBytes);
      expect(result.value.mimeType.value).toBe('image/png');
      expect(result.value.filename).toBe('photo.png');
    }
  });

  it('accepts a leading slash in the requested path', async () => {
    const result = await useCase.execute(actorId, projectId, '/img/photo.png');
    expect(result.success).toBe(true);
  });

  it('denies a non-member', async () => {
    const result = await useCase.execute(nonMemberId, projectId, 'img/photo.png');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
  });

  it('returns not-found for an unknown path', async () => {
    const result = await useCase.execute(actorId, projectId, 'img/missing.png');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
  });

  it('rejects path-traversal segments', async () => {
    const result = await useCase.execute(actorId, projectId, '../secret.png');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
  });

  it('does not resolve a folder path to content', async () => {
    const result = await useCase.execute(actorId, projectId, 'img');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
  });

  it('returns not-found when the resolved node has no Asset record', async () => {
    const documentNodeId = FileNodeId.create('cc0e8400-e29b-41d4-a716-446655440008');
    const documentPath = FilePath.create('/img/notes.adoc');
    await fileNodeRepo.save(
      new FileNode(documentNodeId, projectId, folderId, 'notes.adoc', FileNodeType.create('file'), documentPath),
    );
    await fileStore.write(projectId, documentPath, Buffer.from('= Notes'));

    const result = await useCase.execute(actorId, projectId, 'img/notes.adoc');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(FileNodeNotFoundError);
  });

  it('reports missing content when the asset record exists but its bytes do not', async () => {
    await fileStore.remove(projectId, filePath);
    const result = await useCase.execute(actorId, projectId, 'img/photo.png');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ContentNotFoundError);
  });
});
