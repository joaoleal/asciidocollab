import { InviteUserUseCase } from '../../../src/use-cases/auth/invite-user';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryUserRepository } from '../../ports/user/in-memory-user.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { ProjectMember } from '../../../src/entities/project-member';
import { User } from '../../../src/entities/user';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { Email } from '../../../src/value-objects/identity/email';
import { Role } from '../../../src/value-objects/identity/role';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { UserNotFoundError } from '../../../src/errors/auth/user-not-found';
import { ProjectMemberAlreadyExistsError } from '../../../src/errors/members/project-member-already-exists';

describe('InviteUserUseCase', () => {
  let userRepo: InMemoryUserRepository;
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let useCase: InviteUserUseCase;

  const adminId = UserId.create('550e8400-e29b-41d4-a716-446655440001');
  const viewerId = UserId.create('550e8400-e29b-41d4-a716-446655440002');
  const inviteeId = UserId.create('550e8400-e29b-41d4-a716-446655440003');
  const projectId = ProjectId.create('660e8400-e29b-41d4-a716-446655440001');

  const adminEmail = Email.create('admin@example.com');
  const viewerEmail = Email.create('viewer@example.com');
  const inviteEmail = Email.create('invitee@example.com');

  beforeEach(async () => {
    userRepo = new InMemoryUserRepository();
    projectMemberRepo = new InMemoryProjectMemberRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    useCase = new InviteUserUseCase(
      userRepo,
      projectMemberRepo,
      auditLogRepo,
    );

    await userRepo.save(new User(adminId, adminEmail, 'Admin', 'hashed', [], null, null));

    await userRepo.save(new User(viewerId, viewerEmail, 'Viewer', 'hashed', [], null, null));

    await userRepo.save(new User(inviteeId, inviteEmail, 'Invitee', 'hashed', [], null, null));

    await projectMemberRepo.addMember(
      new ProjectMember(projectId, adminId, Role.create('owner')),
    );
    await projectMemberRepo.addMember(
      new ProjectMember(projectId, viewerId, Role.create('viewer')),
    );
  });

  test('admin invites user with editor role - returns member and user, persists membership, logs audit', async () => {
    const role = Role.create('editor');
    const result = await useCase.execute(adminId, projectId, inviteEmail, role);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.member.userId.value).toBe(inviteeId.value);
      expect(result.value.member.role.value).toBe('editor');
      expect(result.value.member.joinedAt).toBeInstanceOf(Date);
      expect(result.value.user.id.value).toBe(inviteeId.value);
      expect(result.value.user.email.value).toBe(inviteEmail.value);
      expect(result.value.user.displayName).toBe('Invitee');
    }

    const member = await projectMemberRepo.findByCompositeKey(projectId, inviteeId);
    expect(member).not.toBeNull();
    expect(member!.role.value).toBe('editor');

    const logs = await auditLogRepo.findByProjectId(projectId);
    const inviteLog = logs.find((l) => l.action === 'member.invited');
    expect(inviteLog).toBeDefined();
    expect(inviteLog!.userId?.value).toBe(adminId.value);
    expect(inviteLog!.projectId!.value).toBe(projectId.value);
    expect(inviteLog!.resourceType).toBe('ProjectMember');
    expect(inviteLog!.resourceId).toBe(inviteeId.value);
  });

  test('viewer (non-admin) cannot invite - returns PermissionDeniedError', async () => {
    const role = Role.create('editor');
    const result = await useCase.execute(viewerId, projectId, inviteEmail, role);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(PermissionDeniedError);
    }
  });

  test('duplicate member rejected - returns ProjectMemberAlreadyExistsError', async () => {
    await projectMemberRepo.addMember(
      new ProjectMember(projectId, inviteeId, Role.create('editor')),
    );

    const role = Role.create('editor');
    const result = await useCase.execute(adminId, projectId, inviteEmail, role);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ProjectMemberAlreadyExistsError);
    }
  });

  test('unknown email returns UserNotFoundError', async () => {
    const unknownEmail = Email.create('unknown@example.com');
    const role = Role.create('editor');
    const result = await useCase.execute(adminId, projectId, unknownEmail, role);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(UserNotFoundError);
    }
  });
});
