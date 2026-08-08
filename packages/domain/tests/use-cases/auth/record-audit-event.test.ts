import { RecordAuditEventUseCase } from '../../../src/use-cases/auth/record-audit-event';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { AUDIT_AUTH_SIGNED_IN } from '../../../src/audit-actions';
import { randomUUID } from 'crypto';

describe('RecordAuditEventUseCase', () => {
  let repo: InMemoryAuditLogRepository;
  let useCase: RecordAuditEventUseCase;
  const actorId = UserId.create(randomUUID());

  beforeEach(() => {
    repo = new InMemoryAuditLogRepository();
    useCase = new RecordAuditEventUseCase(repo);
  });

  test('persists a governance audit record with the given fields', async () => {
    await useCase.execute({
      action: AUDIT_AUTH_SIGNED_IN,
      actorId,
      resourceType: 'User',
      resourceId: actorId.value,
    });
    const all = await repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].action).toBe('auth.signed_in');
    expect(all[0].userId?.value).toBe(actorId.value);
    expect(all[0].projectId).toBeNull();
  });

  test('folds request context into metadata.origin', async () => {
    await useCase.execute({
      action: AUDIT_AUTH_SIGNED_IN,
      actorId,
      resourceType: 'User',
      resourceId: actorId.value,
      context: { ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0' },
    });
    const [record] = await repo.findAll();
    expect(record.metadata.origin).toEqual({ ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0' });
  });

  test('merges event metadata alongside origin without dropping it', async () => {
    await useCase.execute({
      action: 'auth.email_changed',
      actorId,
      resourceType: 'User',
      resourceId: actorId.value,
      metadata: { previousEmail: 'old@x.com', newEmail: 'new@x.com' },
      context: { ipAddress: '203.0.113.7' },
    });
    const [record] = await repo.findAll();
    expect(record.metadata.previousEmail).toBe('old@x.com');
    expect(record.metadata.newEmail).toBe('new@x.com');
    expect(record.metadata.origin).toEqual({ ipAddress: '203.0.113.7', userAgent: undefined });
  });

  test('omits origin when no context is supplied', async () => {
    await useCase.execute({ action: AUDIT_AUTH_SIGNED_IN, actorId, resourceType: 'User', resourceId: actorId.value });
    const [record] = await repo.findAll();
    expect(record.metadata.origin).toBeUndefined();
  });
});
