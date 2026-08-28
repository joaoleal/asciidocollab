import { GetOpenRegistrationUseCase, SetOpenRegistrationUseCase } from '../../../src/use-cases/settings/get-open-registration';
import { SetOpenRegistrationUseCase as SetOpenRegistrationUseCaseFromLegacyPath } from '../../../src/use-cases/settings/set-open-registration';
import { InMemoryUserRepository } from '../../ports/user/in-memory-user.repository';
import { InMemorySystemSettingRepository } from '../../ports/admin/in-memory-system-setting.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { User } from '../../../src/entities/user';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Email } from '../../../src/value-objects/identity/email';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import { PermissionDeniedError } from '../../../src/errors/common/permission-denied';
import { randomUUID } from 'crypto';

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

describe('GetOpenRegistrationUseCase', () => {
  let settingRepo: InMemorySystemSettingRepository;
  let useCase: GetOpenRegistrationUseCase;

  beforeEach(() => {
    settingRepo = new InMemorySystemSettingRepository();
    useCase = new GetOpenRegistrationUseCase(settingRepo);
  });

  test('returns false when key absent', async () => {
    const result = await useCase.execute();
    expect(result.enabled).toBe(false);
  });

  test('returns false when value is "false"', async () => {
    await settingRepo.set('openRegistration', 'false');
    const result = await useCase.execute();
    expect(result.enabled).toBe(false);
  });

  test('returns true when value is "true"', async () => {
    await settingRepo.set('openRegistration', 'true');
    const result = await useCase.execute();
    expect(result.enabled).toBe(true);
  });
});

describe('SetOpenRegistrationUseCase', () => {
  let userRepo: InMemoryUserRepository;
  let settingRepo: InMemorySystemSettingRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let useCase: SetOpenRegistrationUseCase;

  beforeEach(() => {
    userRepo = new InMemoryUserRepository();
    settingRepo = new InMemorySystemSettingRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    useCase = new SetOpenRegistrationUseCase(settingRepo, userRepo, auditLogRepo);
  });

  test('returns PermissionDeniedError when actor is not admin', async () => {
    const nonAdmin = makeUser(false);
    await userRepo.save(nonAdmin);

    const result = await useCase.execute(nonAdmin.id, true);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(PermissionDeniedError);
  });

  test('sets openRegistration to true', async () => {
    const admin = makeUser(true);
    await userRepo.save(admin);

    const result = await useCase.execute(admin.id, true);

    expect(result.success).toBe(true);
    const value = await settingRepo.get('openRegistration');
    expect(value).toBe('true');
    const logs = await auditLogRepo.findAll();
    expect(logs.some((l) => l.action === 'settings.open_registration_changed')).toBe(true);
  });

  test('sets openRegistration to false', async () => {
    const admin = makeUser(true);
    await userRepo.save(admin);
    await settingRepo.set('openRegistration', 'true');

    const result = await useCase.execute(admin.id, false);

    expect(result.success).toBe(true);
    const value = await settingRepo.get('openRegistration');
    expect(value).toBe('false');
  });

  test('is reachable under its own module path as well as the module that defines it', () => {
    expect(SetOpenRegistrationUseCaseFromLegacyPath).toBe(SetOpenRegistrationUseCase);
  });

  test('behaves identically when constructed through its own module path', async () => {
    const admin = makeUser(true);
    await userRepo.save(admin);
    const viaOwnPath = new SetOpenRegistrationUseCaseFromLegacyPath(
      settingRepo,
      userRepo,
      auditLogRepo,
    );

    const result = await viaOwnPath.execute(admin.id, true);

    expect(result.success).toBe(true);
    expect(await settingRepo.get('openRegistration')).toBe('true');
  });
});
