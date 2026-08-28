import { GetProjectGitIgnorePatternsUseCase } from '../../../src/use-cases/project/get-project-git-ignore-patterns';
import { SaveProjectGitIgnorePatternsUseCase } from '../../../src/use-cases/project/save-project-git-ignore-patterns';
import { InMemoryProjectRepository } from '../../ports/project/in-memory-project.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { Project } from '../../../src/entities/project';
import { ProjectMember } from '../../../src/entities/project-member';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectName } from '../../../src/value-objects/project/project-name';
import { Role } from '../../../src/value-objects/identity/role';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { ProjectNotFoundError } from '../../../src/errors/project/project-not-found';
import { ValidationError } from '../../../src/errors/common/validation-error';

describe('git ignore patterns use cases', () => {
  let projectRepo: InMemoryProjectRepository;
  let memberRepo: InMemoryProjectMemberRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let getUseCase: GetProjectGitIgnorePatternsUseCase;
  let saveUseCase: SaveProjectGitIgnorePatternsUseCase;

  const ownerId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const editorId = UserId.create('550e8400-e29b-41d4-a716-446655440002');
  const viewerId = UserId.create('550e8400-e29b-41d4-a716-446655440003');
  const nonMemberId = UserId.create('550e8400-e29b-41d4-a716-446655440004');
  const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440005');

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    memberRepo = new InMemoryProjectMemberRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    getUseCase = new GetProjectGitIgnorePatternsUseCase(projectRepo, memberRepo);
    saveUseCase = new SaveProjectGitIgnorePatternsUseCase(projectRepo, memberRepo, auditLogRepo);

    const project = new Project(projectId, ProjectName.create('Test Project'), null, [], null);
    await projectRepo.save(project);

    await memberRepo.addMember(new ProjectMember(projectId, ownerId, Role.create('owner'), new Date()));
    await memberRepo.addMember(new ProjectMember(projectId, editorId, Role.create('editor'), new Date()));
    await memberRepo.addMember(new ProjectMember(projectId, viewerId, Role.create('viewer'), new Date()));
  });

  describe('GetProjectGitIgnorePatternsUseCase', () => {
    test('the owner can read the patterns', async () => {
      const result = await getUseCase.execute(ownerId, projectId);
      expect(result.success).toBe(true);
    });

    test('rejects an editor (non-owner)', async () => {
      const result = await getUseCase.execute(editorId, projectId);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
    });

    test('rejects a viewer (non-owner)', async () => {
      const result = await getUseCase.execute(viewerId, projectId);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
    });

    test('rejects a non-member', async () => {
      const result = await getUseCase.execute(nonMemberId, projectId);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
    });

    test('returns not-found for a non-existent project', async () => {
      const missingId = ProjectId.create('550e8400-e29b-41d4-a716-446655440099');
      const result = await getUseCase.execute(ownerId, missingId);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(ProjectNotFoundError);
    });
  });

  describe('SaveProjectGitIgnorePatternsUseCase', () => {
    test('the owner can update the patterns', async () => {
      const result = await saveUseCase.execute(ownerId, projectId, 'build/\n*.log');
      expect(result.success).toBe(true);
      if (result.success) expect(result.value.gitIgnorePatterns).toBe('build/\n*.log');

      const stored = await projectRepo.findById(projectId);
      expect(stored?.gitIgnorePatterns).toBe('build/\n*.log');
    });

    test('rejects an editor (non-owner) and does not persist', async () => {
      const result = await saveUseCase.execute(editorId, projectId, 'build/');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);

      const stored = await projectRepo.findById(projectId);
      expect(stored?.gitIgnorePatterns).toBeNull();
    });

    test('rejects a viewer (non-owner) and does not persist', async () => {
      const result = await saveUseCase.execute(viewerId, projectId, 'build/');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
    });

    test('rejects a non-member and records an authz.denied audit entry', async () => {
      const result = await saveUseCase.execute(nonMemberId, projectId, 'build/');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);

      const auditLogs = await auditLogRepo.findAll();
      const denial = auditLogs.find((log) => log.action === 'authz.denied');
      expect(denial).toBeDefined();
      expect(denial!.resourceType).toBe('Project');
    });

    test('returns not-found for a non-existent project', async () => {
      const missingId = ProjectId.create('550e8400-e29b-41d4-a716-446655440099');
      const result = await saveUseCase.execute(ownerId, missingId, 'build/');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(ProjectNotFoundError);
    });

    test('rejects patterns beyond the stored length cap without persisting them', async () => {
      const result = await saveUseCase.execute(ownerId, projectId, 'x'.repeat(20_001));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);

      const stored = await projectRepo.findById(projectId);
      expect(stored?.gitIgnorePatterns).toBeNull();
    });

    test('an unexpected entity failure is not translated into a result error', async () => {
      const spy = jest.spyOn(Project.prototype, 'setGitIgnorePatterns').mockImplementation(() => {
        throw new TypeError('entity blew up');
      });
      try {
        await expect(saveUseCase.execute(ownerId, projectId, 'build/')).rejects.toThrow('entity blew up');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
