import { CreateProjectUseCase } from '../../../src/use-cases/project/create-project';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
import { InMemoryFileNodeRepository } from '../../ports/file-tree/in-memory-file-node.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectName } from '../../../src/value-objects/project/project-name';
import { InvalidProjectNameError } from '../../../src/errors/project/invalid-project-name';

describe('CreateProjectUseCase', () => {
  let projectRepo: InMemoryProjectRepository;
  let fileNodeRepo: InMemoryFileNodeRepository;
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let useCase: CreateProjectUseCase;
  let actorId: UserId;

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    fileNodeRepo = new InMemoryFileNodeRepository();
    projectMemberRepo = new InMemoryProjectMemberRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    useCase = new CreateProjectUseCase(
      projectRepo,
      fileNodeRepo,
      projectMemberRepo,
      auditLogRepo,
    );

    actorId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  });

  test('creates project with root folder, owner-as-admin, and audit log', async () => {
    const name = ProjectName.create('My Project');
    const result = await useCase.execute(actorId, name, 'A test project', ['docs', 'frontend']);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const { value } = result;

    const project = await projectRepo.findById(value.projectId);
    expect(project).not.toBeNull();
    expect(project!.name.value).toBe('My Project');
    expect(project!.description).toBe('A test project');
    expect(project!.rootFolderId).not.toBeNull();
    expect(project!.rootFolderId!.value).toBe(value.rootFolderId.value);

    const rootFolder = await fileNodeRepo.findById(value.rootFolderId);
    expect(rootFolder).not.toBeNull();
    expect(rootFolder!.type.value).toBe('folder');
    expect(rootFolder!.name).toBe('My Project');
    expect(rootFolder!.parentId).toBeNull();
    expect(rootFolder!.projectId.value).toBe(value.projectId.value);

    const member = await projectMemberRepo.findByCompositeKey(value.projectId, actorId);
    expect(member).not.toBeNull();
    expect(member!.role.value).toBe('owner');

    const logs = await auditLogRepo.findByProjectId(value.projectId);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('project.created');
    expect(logs[0].userId?.value).toBe(actorId.value);
    expect(logs[0].resourceType).toBe('Project');
    expect(logs[0].resourceId).toBe(value.projectId.value);
  });

  test('returns correct result shape with projectId, rootFolderId, and ownerRole=owner', async () => {
    const name = ProjectName.create('Another Project');
    const result = await useCase.execute(actorId, name, null, []);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.projectId).toBeDefined();
    expect(result.value.rootFolderId).toBeDefined();
    expect(result.value.ownerRole).toBe('owner');
  });

  test('rejects empty project name', async () => {
    expect(() => ProjectName.create('')).toThrow(InvalidProjectNameError);
  });
});
