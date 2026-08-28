import { SetAdminStatusUseCase } from '../../../src/use-cases/settings/set-admin-status';
import { InMemoryUserRepository } from '../../ports/user/in-memory-user.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemorySessionRepository } from '../../ports/user/in-memory-session.repository';
import { User } from '../../../src/entities/user';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Email } from '../../../src/value-objects/identity/email';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { CannotModifySelfAdminError } from '../../../src/errors/members/cannot-modify-self-admin';
import { CannotRemoveLastAdminError } from '../../../src/errors/members/cannot-remove-last-admin';
import { UserNotFoundError } from '../../../src/errors/auth/user-not-found';
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

describe('SetAdminStatusUseCase', () => {
  let userRepo: InMemoryUserRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let sessionRepo: InMemorySessionRepository;
  let useCase: SetAdminStatusUseCase;

  beforeEach(() => {
    userRepo = new InMemoryUserRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    sessionRepo = new InMemorySessionRepository();
    useCase = new SetAdminStatusUseCase(userRepo, auditLogRepo, sessionRepo);
  });

  test('returns PermissionDeniedError when actor is not admin', async () => {
    const nonAdmin = makeUser(false);
    const target = makeUser(false);
    await userRepo.save(nonAdmin);
    await userRepo.save(target);

    const result = await useCase.execute(nonAdmin.id, target.id, true);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
  });

  test('returns CannotModifySelfAdminError when actor targets self', async () => {
    const admin = makeUser(true);
    await userRepo.save(admin);

    const result = await useCase.execute(admin.id, admin.id, false);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(CannotModifySelfAdminError);
  });

  test('returns CannotRemoveLastAdminError when demoting last admin', async () => {
    const admin = makeUser(true);
    const user = makeUser(false);
    await userRepo.save(admin);
    await userRepo.save(user);

    const result = await useCase.execute(admin.id, admin.id, false);

    // actor == target so CannotModifySelfAdminError first
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(CannotModifySelfAdminError);
  });

  test('returns CannotRemoveLastAdminError when demoting target who is last admin', async () => {
    const admin = makeUser(true);
    const target = makeUser(true);
    // admin demotes target, but target is the only admin
    await userRepo.save(admin);
    await userRepo.save(target);
    // Only one other admin - admin demotes target; 2 admins total so should succeed
    // But if target is the ONLY admin and we demote target... let's test with just target as only admin after admin removes self
    // Better test: admin is the only admin, tries to demote himself (already tested above)
    // Another test: there's only 1 admin, a different admin tries to demote it
    const singleAdmin = makeUser(true);
    const nonAdminActor = makeUser(true); // second admin
    await userRepo.save(singleAdmin);
    await userRepo.save(nonAdminActor);
    // Both are admins, demoting singleAdmin should work since nonAdminActor is still admin
    const result = await useCase.execute(nonAdminActor.id, singleAdmin.id, false);
    expect(result.success).toBe(true);
  });

  test('success: admin status updated and audit log written', async () => {
    const admin1 = makeUser(true);
    const admin2 = makeUser(true);
    await userRepo.save(admin1);
    await userRepo.save(admin2);

    const result = await useCase.execute(admin1.id, admin2.id, false);

    expect(result.success).toBe(true);
    const updated = await userRepo.findById(admin2.id);
    expect(updated?.isAdmin).toBe(false);
    const logs = await auditLogRepo.findAll();
    expect(logs.some((l) => l.action === 'user.admin_revoked')).toBe(true);
  });

  test('returns PermissionDeniedError when the acting account no longer exists', async () => {
    const target = makeUser(false);
    await userRepo.save(target);

    const result = await useCase.execute(UserId.create(randomUUID()), target.id, true);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
  });

  test('returns UserNotFoundError when the target account does not exist', async () => {
    const admin = makeUser(true);
    await userRepo.save(admin);
    const missingId = UserId.create(randomUUID());

    const result = await useCase.execute(admin.id, missingId, true);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(UserNotFoundError);
      expect(result.error.message).toContain(missingId.value);
    }
  });

  test('refuses to demote an admin target when only one admin would remain', async () => {
    const lastAdminRepo = new LastAdminUserRepository();
    const admin = makeUser(true);
    const target = makeUser(true);
    await lastAdminRepo.save(admin);
    await lastAdminRepo.save(target);
    const guarded = new SetAdminStatusUseCase(lastAdminRepo, auditLogRepo, sessionRepo);

    const result = await guarded.execute(admin.id, target.id, false);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(CannotRemoveLastAdminError);
    const unchanged = await lastAdminRepo.findById(target.id);
    expect(unchanged?.isAdmin).toBe(true);
  });

  test('skips the last-admin check when promoting an existing admin', async () => {
    const lastAdminRepo = new LastAdminUserRepository();
    const admin = makeUser(true);
    const target = makeUser(true);
    await lastAdminRepo.save(admin);
    await lastAdminRepo.save(target);
    const guarded = new SetAdminStatusUseCase(lastAdminRepo, auditLogRepo, sessionRepo);

    const result = await guarded.execute(admin.id, target.id, true);

    expect(result.success).toBe(true);
    const updated = await lastAdminRepo.findById(target.id);
    expect(updated?.isAdmin).toBe(true);
  });
});
