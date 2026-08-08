import {
  AUTH_ATTEMPT_FAILED_SIGN_IN,
  AUTH_ATTEMPT_PASSWORD_RESET_REQUEST,
} from '../../../src/entities/auth-attempt-telemetry';
import { InMemoryAuthAttemptTelemetryRepository } from './in-memory-auth-attempt-telemetry.repository';

const WINDOW = new Date('2026-06-10T12:00:00.000Z');
const LATER_WINDOW = new Date('2026-06-10T13:00:00.000Z');

describe('InMemoryAuthAttemptTelemetryRepository', () => {
  let repo: InMemoryAuthAttemptTelemetryRepository;

  beforeEach(() => {
    repo = new InMemoryAuthAttemptTelemetryRepository();
  });

  test('coalesces repeated failures for the same (identifier, ip, window) into one bucket', async () => {
    for (let index = 0; index < 5; index++) {
      await repo.record({
        eventType: AUTH_ATTEMPT_FAILED_SIGN_IN,
        identifier: 'user@example.com',
        ipAddress: '203.0.113.7',
        userAgent: null,
        windowStart: WINDOW,
        now: new Date(WINDOW.getTime() + index * 1000),
      });
    }
    const all = await repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].attemptCount).toBe(5);
    expect(all[0].lastAttemptAt.getTime()).toBe(WINDOW.getTime() + 4000);
    expect(all[0].firstAttemptAt.getTime()).toBe(WINDOW.getTime());
  });

  test('coalesces equally when the IP is the "unknown" sentinel', async () => {
    for (let index = 0; index < 3; index++) {
      await repo.record({
        eventType: AUTH_ATTEMPT_FAILED_SIGN_IN,
        identifier: 'user@example.com',
        ipAddress: 'unknown',
        userAgent: null,
        windowStart: WINDOW,
        now: WINDOW,
      });
    }
    const all = await repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].attemptCount).toBe(3);
  });

  test('separate buckets per identifier, ip, and window', async () => {
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'b@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '2.2.2.2', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: LATER_WINDOW, now: LATER_WINDOW });
    expect(await repo.findAll()).toHaveLength(4);
  });

  test('deleteOlderThan removes only buckets older than the cutoff and returns the count', async () => {
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: LATER_WINDOW, now: LATER_WINDOW });
    const deleted = await repo.deleteOlderThan(new Date('2026-06-10T12:30:00.000Z'));
    expect(deleted).toBe(1);
    const remaining = await repo.findAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].windowStart.getTime()).toBe(LATER_WINDOW.getTime());
  });

  test('keeps a distinct bucket per eventType for the same identifier, ip and window', async () => {
    // eventType is part of the coalescing key: a failed sign-in and a password-reset request from the
    // same address in the same window are different security signals and must not be merged.
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_PASSWORD_RESET_REQUEST, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });

    const all = await repo.findAll();
    expect(all).toHaveLength(2);
    expect(all.map((bucket) => bucket.eventType).toSorted()).toEqual(
      [AUTH_ATTEMPT_FAILED_SIGN_IN, AUTH_ATTEMPT_PASSWORD_RESET_REQUEST].toSorted(),
    );
  });

  test('findWithFilters filters by identifier and paginates', async () => {
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'b@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });

    const filtered = await repo.findWithFilters({ identifier: 'a@x.com' }, { page: 1, limit: 50 });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].identifier).toBe('a@x.com');

    const page1 = await repo.findWithFilters({}, { page: 1, limit: 1 });
    expect(page1.total).toBe(2);
    expect(page1.items).toHaveLength(1);
  });
});
