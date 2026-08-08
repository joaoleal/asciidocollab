import { PurgeAuthAttemptTelemetryUseCase } from '../../../src/use-cases/admin/purge-auth-attempt-telemetry';
import { InMemoryAuthAttemptTelemetryRepository } from '../../ports/admin/in-memory-auth-attempt-telemetry.repository';
import { AUTH_ATTEMPT_FAILED_SIGN_IN } from '../../../src/entities/auth-attempt-telemetry';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('PurgeAuthAttemptTelemetryUseCase', () => {
  let repo: InMemoryAuthAttemptTelemetryRepository;
  let useCase: PurgeAuthAttemptTelemetryUseCase;

  beforeEach(() => {
    repo = new InMemoryAuthAttemptTelemetryRepository();
    useCase = new PurgeAuthAttemptTelemetryUseCase(repo);
  });

  test('deletes buckets older than now - retentionWindow and returns the count', async () => {
    const now = new Date('2026-06-10T00:00:00.000Z');
    const old = new Date(now.getTime() - 100 * DAY_MS);
    const recent = new Date(now.getTime() - 10 * DAY_MS);

    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: old, now: old });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'b@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: recent, now: recent });

    const result = await useCase.execute({ now, retentionWindowMs: 90 * DAY_MS });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.deleted).toBe(1);
    }
    const remaining = await repo.findAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].identifier).toBe('b@x.com');
  });

  test('deletes nothing when all buckets are within the retention window', async () => {
    const now = new Date('2026-06-10T00:00:00.000Z');
    const recent = new Date(now.getTime() - 1 * DAY_MS);
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: recent, now: recent });

    const result = await useCase.execute({ now, retentionWindowMs: 90 * DAY_MS });
    expect(result.success && result.value.deleted).toBe(0);
    expect(await repo.findAll()).toHaveLength(1);
  });
});
