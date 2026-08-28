import { LogoutUseCase } from '../../../src/use-cases/auth/logout';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { AUDIT_AUTH_SIGNED_OUT } from '../../../src/audit-actions';
import { randomUUID } from 'crypto';

describe('LogoutUseCase', () => {
  let auditLogRepo: InMemoryAuditLogRepository;
  let useCase: LogoutUseCase;
  let actorId: UserId;

  beforeEach(() => {
    auditLogRepo = new InMemoryAuditLogRepository();
    useCase = new LogoutUseCase(auditLogRepo);
    actorId = UserId.create(randomUUID());
  });

  test('records a sign-out entry naming the actor as both actor and resource', async () => {
    await useCase.execute(actorId);

    const logs = await auditLogRepo.findAll();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe(AUDIT_AUTH_SIGNED_OUT);
    expect(logs[0].userId?.value).toBe(actorId.value);
    expect(logs[0].projectId).toBeNull();
    expect(logs[0].resourceType).toBe('User');
    expect(logs[0].resourceId).toBe(actorId.value);
  });

  test('captures the request origin into the audit metadata when one is supplied', async () => {
    await useCase.execute(actorId, { ipAddress: '203.0.113.9', userAgent: 'test-agent/1.0' });

    const logs = await auditLogRepo.findAll();
    expect(logs[0].metadata).toEqual({
      origin: { ipAddress: '203.0.113.9', userAgent: 'test-agent/1.0' },
    });
  });

  test('omits the origin when no request context is supplied', async () => {
    await useCase.execute(actorId);

    const logs = await auditLogRepo.findAll();
    expect(logs[0].metadata).toEqual({});
  });

  test('gives every sign-out its own audit entry', async () => {
    await useCase.execute(actorId);
    await useCase.execute(actorId);

    const logs = await auditLogRepo.findAll();
    expect(logs).toHaveLength(2);
  });
});
