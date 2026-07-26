import { GetIgnoredLintsUseCase } from '../../../src/use-cases/grammar/get-ignored-lints';
import { ReplaceIgnoredLintsUseCase } from '../../../src/use-cases/grammar/replace-ignored-lints';
import { InMemoryIgnoredLintRepository } from '../../ports/grammar/in-memory-ignored-lint.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { FileNode } from '../../../src/entities/file-node';
import { FileNodeType } from '../../../src/value-objects/files/file-node-type';
import { FilePath } from '../../../src/value-objects/files/file-path';
import { ProjectMember } from '../../../src/entities/project-member';
import { Role } from '../../../src/value-objects/identity/role';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';

const PROJECT = ProjectId.create('11111111-1111-4111-8111-111111111111');
const DOCUMENT = FileNodeId.create('22222222-2222-4222-8222-222222222222');
const MEMBER = UserId.create('55555555-5555-4555-8555-555555555555');
const OTHER = UserId.create('66666666-6666-4666-8666-666666666666');
const OUTSIDER = UserId.create('77777777-7777-4777-8777-777777777777');

describe('Ignored-lints use cases', () => {
  let repo: InMemoryIgnoredLintRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let memberRepo: InMemoryProjectMemberRepository;
  let get: GetIgnoredLintsUseCase;
  let replace: ReplaceIgnoredLintsUseCase;

  beforeEach(async () => {
    repo = new InMemoryIgnoredLintRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    memberRepo = new InMemoryProjectMemberRepository();
    await fileNodeRepo.save(
      new FileNode(DOCUMENT, PROJECT, FileNodeId.create('33333333-3333-4333-8333-333333333333'), 'doc.adoc', FileNodeType.create('file'), FilePath.create('/doc.adoc')),
    );
    await memberRepo.addMember(new ProjectMember(PROJECT, MEMBER, Role.create('editor'), new Date()));
    await memberRepo.addMember(new ProjectMember(PROJECT, OTHER, Role.create('viewer'), new Date()));
    get = new GetIgnoredLintsUseCase(repo, fileNodeRepo, memberRepo);
    replace = new ReplaceIgnoredLintsUseCase(repo, fileNodeRepo, memberRepo);
  });

  it('returns an empty string when the caller has ignored nothing', async () => {
    const result = await get.execute(MEMBER, DOCUMENT);
    expect(result).toEqual({ success: true, value: '' });
  });

  it('round-trips the caller-private blob through replace then get (survives reload)', async () => {
    const blob = '["hash-a","hash-b"]';
    const written = await replace.execute(MEMBER, DOCUMENT, blob);
    expect(written.success).toBe(true);
    const result = await get.execute(MEMBER, DOCUMENT);
    expect(result).toEqual({ success: true, value: blob });
  });

  it('keeps each user’s ignores private — one member never sees another’s blob', async () => {
    await replace.execute(MEMBER, DOCUMENT, '["mine"]');
    await replace.execute(OTHER, DOCUMENT, '["theirs"]');
    expect(await get.execute(MEMBER, DOCUMENT)).toMatchObject({ success: true, value: '["mine"]' });
    expect(await get.execute(OTHER, DOCUMENT)).toMatchObject({ success: true, value: '["theirs"]' });
  });

  it('replace is last-write-wins on the caller’s own record', async () => {
    await replace.execute(MEMBER, DOCUMENT, '["first"]');
    await replace.execute(MEMBER, DOCUMENT, '["second"]');
    expect(await get.execute(MEMBER, DOCUMENT)).toMatchObject({ value: '["second"]' });
  });

  it('denies a non-member on both read and write', async () => {
    const read = await get.execute(OUTSIDER, DOCUMENT);
    const written = await replace.execute(OUTSIDER, DOCUMENT, '["x"]');
    expect(read.success).toBe(false);
    expect(written.success).toBe(false);
    if (!read.success) expect(read.error).toBeInstanceOf(PermissionDeniedError);
    if (!written.success) expect(written.error).toBeInstanceOf(PermissionDeniedError);
  });

  it('denies access to an unknown document', async () => {
    const unknown = FileNodeId.create('99999999-9999-4999-8999-999999999999');
    const result = await get.execute(MEMBER, unknown);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
  });
});
