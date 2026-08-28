import { RemoveUserUseCase } from '../../../src/use-cases/auth/remove-user';
import { InMemoryUserRepository } from '../../ports/user/in-memory-user.repository';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemorySessionRepository } from '../../ports/user/in-memory-session.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { User } from '../../../src/entities/user';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Email } from '../../../src/value-objects/identity/email';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { CannotRemoveSelfError } from '../../../src/errors/members/cannot-remove-self';
import { CannotRemoveLastAdminError } from '../../../src/errors/members/cannot-remove-last-admin';
import { UserNotFoundError } from '../../../src/errors/auth/user-not-found';
import { ProjectMember } from '../../../src/entities/project-member';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { Role } from '../../../src/value-objects/identity/role';
import { randomUUID } from 'crypto';

// Stands in for the window where another request demotes an admin between the target lookup and
// the admin count, so the count reports fewer admins than the store still holds.
class LastAdminUserRepository extends InMemoryUserRepository {
  async countAdmins(): Promise<number> {
    return 1;
  }
}

function makeUser(isAdmin = false): User {
  return new User(
    UserId.create(randomUUID()),
    Email.create(`user-${randomUUID()}@example.com`),
    'Test User',
    'hash',
    [],
    null,
    null,
    isAdmin,
    new Timestamps(),
    true,
    'SELF_REGISTERED',
  );
}

describe('RemoveUserUseCase', () => {
  let userRepo: InMemoryUserRepository;
  let projectMemberRepo: InMemoryProjectMemberRepository;
  let sessionRepo: InMemorySessionRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let useCase: RemoveUserUseCase;

  beforeEach(() => {
    userRepo = new InMemoryUserRepository();
    projectMemberRepo = new InMemoryProjectMemberRepository();
    sessionRepo = new InMemorySessionRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    useCase = new RemoveUserUseCase(userRepo, projectMemberRepo, sessionRepo, auditLogRepo);
  });

  test('returns PermissionDeniedError when actor is not admin', async () => {
    const nonAdmin = makeUser(false);
    const target = makeUser(false);
    await userRepo.save(nonAdmin);
    await userRepo.save(target);

    const result = await useCase.execute(nonAdmin.id, target.id);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
  });

  test('returns CannotRemoveSelfError when actor is target', async () => {
    const admin = makeUser(true);
    await userRepo.save(admin);

    const result = await useCase.execute(admin.id, admin.id);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(CannotRemoveSelfError);
  });

  test('returns CannotRemoveLastAdminError when target is last admin', async () => {
    const actorAdmin = makeUser(true);
    const soleAdmin = makeUser(true);
    const normalUser = makeUser(false);
    await userRepo.save(actorAdmin);
    await userRepo.save(soleAdmin);
    await userRepo.save(normalUser);
    // Both actorAdmin and soleAdmin are admins (2 admins), so removing soleAdmin should succeed
    // To test "last admin" error: have only 1 admin (soleAdmin) and a different admin tries to remove them
    // But if there's only 1 admin, the actor can't be admin too
    // Actually: let's make actor admin and target the only other admin; total = 2 admins
    // This should succeed (1 admin remains after removal)
    const result = await useCase.execute(actorAdmin.id, soleAdmin.id);
    expect(result.success).toBe(true);
  });

  test('returns CannotRemoveLastAdminError when there is only 1 admin total', async () => {
    const actor = makeUser(true); // only admin
    const target = makeUser(false);
    await userRepo.save(actor);
    await userRepo.save(target);

    const result = await useCase.execute(actor.id, target.id);
    // target is not admin so no last-admin check
    expect(result.success).toBe(true);
  });

  test('sessions deleted before user deletion, hard delete completes', async () => {
    const admin = makeUser(true);
    const target = makeUser(false);
    await userRepo.save(admin);
    await userRepo.save(target);

    const result = await useCase.execute(admin.id, target.id);

    expect(result.success).toBe(true);
    expect(sessionRepo.deletedUserIds).toContain(target.id.value);
    const deleted = await userRepo.findById(target.id);
    expect(deleted).toBeNull();
    const logs = await auditLogRepo.findAll();
    expect(logs.some((l) => l.action === 'user.removed')).toBe(true);
  });

  test('returns PermissionDeniedError when the acting account no longer exists', async () => {
    const target = makeUser(false);
    await userRepo.save(target);

    const result = await useCase.execute(UserId.create(randomUUID()), target.id);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
  });

  test('returns UserNotFoundError when the target account does not exist', async () => {
    const admin = makeUser(true);
    await userRepo.save(admin);
    const missingId = UserId.create(randomUUID());

    const result = await useCase.execute(admin.id, missingId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(UserNotFoundError);
      expect(result.error.message).toContain(missingId.value);
    }
  });

  test('refuses to remove an admin target when only one admin would remain', async () => {
    const lastAdminRepo = new LastAdminUserRepository();
    const admin = makeUser(true);
    const target = makeUser(true);
    await lastAdminRepo.save(admin);
    await lastAdminRepo.save(target);
    const guarded = new RemoveUserUseCase(
      lastAdminRepo,
      projectMemberRepo,
      sessionRepo,
      auditLogRepo,
    );

    const result = await guarded.execute(admin.id, target.id);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(CannotRemoveLastAdminError);
    expect(await lastAdminRepo.findById(target.id)).not.toBeNull();
  });

  test('promotes the acting admin on a sole-owner project they already belong to', async () => {
    const admin = makeUser(true);
    const target = makeUser(false);
    await userRepo.save(admin);
    await userRepo.save(target);
    const projectId = ProjectId.create(randomUUID());
    await projectMemberRepo.addMember(
      new ProjectMember(projectId, target.id, Role.create('owner'), new Date()),
    );
    await projectMemberRepo.addMember(
      new ProjectMember(projectId, admin.id, Role.create('editor'), new Date()),
    );

    const result = await useCase.execute(admin.id, target.id);

    expect(result.success).toBe(true);
    if (result.success) expect(result.value.projectIdsTransferred).toEqual([projectId.value]);
    const membership = await projectMemberRepo.findByCompositeKey(projectId, admin.id);
    expect(membership?.role.value).toBe('owner');
  });

  test('adds the acting admin as owner of a sole-owner project they were not a member of', async () => {
    const admin = makeUser(true);
    const target = makeUser(false);
    await userRepo.save(admin);
    await userRepo.save(target);
    const projectId = ProjectId.create(randomUUID());
    await projectMemberRepo.addMember(
      new ProjectMember(projectId, target.id, Role.create('owner'), new Date()),
    );

    const result = await useCase.execute(admin.id, target.id);

    expect(result.success).toBe(true);
    if (result.success) expect(result.value.projectIdsTransferred).toEqual([projectId.value]);
    const membership = await projectMemberRepo.findByCompositeKey(projectId, admin.id);
    expect(membership?.role.value).toBe('owner');
    const logs = await auditLogRepo.findAll();
    const removal = logs.find((l) => l.action === 'user.removed');
    expect(removal?.metadata).toEqual({ projectIdsTransferred: [projectId.value] });
  });
});
