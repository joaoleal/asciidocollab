import { PrismaClient } from '@prisma/client';
import {
  AuthAttemptTelemetryRepository,
  AUTH_ATTEMPT_FAILED_SIGN_IN,
  AUTH_ATTEMPT_PASSWORD_RESET_REQUEST,
} from '@asciidocollab/domain';
import { PrismaAuthAttemptTelemetryRepository } from '../../../src/persistence/admin/prisma-auth-attempt-telemetry.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../../helpers/prisma-test-container';

const WINDOW = new Date('2026-06-10T12:00:00.000Z');
const LATER_WINDOW = new Date('2026-06-10T13:00:00.000Z');

describe('PrismaAuthAttemptTelemetryRepository', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let repo: AuthAttemptTelemetryRepository;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    repo = new PrismaAuthAttemptTelemetryRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.authAttemptTelemetry.deleteMany();
  });

  it('coalesces repeated failures for the same (identifier, ip, window) into one bucket', async () => {
    for (let index = 0; index < 4; index++) {
      await repo.record({
        eventType: AUTH_ATTEMPT_FAILED_SIGN_IN,
        identifier: 'user@example.com',
        ipAddress: '203.0.113.7',
        userAgent: 'agent',
        windowStart: WINDOW,
        now: new Date(WINDOW.getTime() + index * 1000),
      });
    }
    const all = await repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].attemptCount).toBe(4);
    expect(all[0].firstAttemptAt.getTime()).toBe(WINDOW.getTime());
    expect(all[0].lastAttemptAt.getTime()).toBe(WINDOW.getTime() + 3000);
  });

  it('coalesces equally when the IP is the "unknown" sentinel', async () => {
    for (let index = 0; index < 3; index++) {
      await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'user@example.com', ipAddress: 'unknown', userAgent: null, windowStart: WINDOW, now: WINDOW });
    }
    const all = await repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].attemptCount).toBe(3);
    expect(all[0].ipAddress).toBe('unknown');
  });

  it('keeps distinct buckets per identifier, ip, and window', async () => {
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'b@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: LATER_WINDOW, now: LATER_WINDOW });
    expect(await repo.findAll()).toHaveLength(3);
  });

  it('deleteOlderThan removes only buckets older than the cutoff and returns the count', async () => {
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: LATER_WINDOW, now: LATER_WINDOW });
    const deleted = await repo.deleteOlderThan(new Date('2026-06-10T12:30:00.000Z'));
    expect(deleted).toBe(1);
    const remaining = await repo.findAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].windowStart.getTime()).toBe(LATER_WINDOW.getTime());
  });

  it('keeps distinct buckets per eventType even for the same identifier/ip/window', async () => {
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_PASSWORD_RESET_REQUEST, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    expect(await repo.findAll()).toHaveLength(2);
  });

  it('findWithFilters can restrict to a single eventType', async () => {
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_PASSWORD_RESET_REQUEST, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });

    const resets = await repo.findWithFilters({ eventType: AUTH_ATTEMPT_PASSWORD_RESET_REQUEST }, { page: 1, limit: 50 });
    expect(resets.total).toBe(1);
    expect(resets.items[0].eventType).toBe(AUTH_ATTEMPT_PASSWORD_RESET_REQUEST);
  });

  it('findWithFilters filters by identifier and paginates', async () => {
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'b@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });

    const filtered = await repo.findWithFilters({ identifier: 'a@x.com' }, { page: 1, limit: 50 });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].identifier).toBe('a@x.com');

    const page1 = await repo.findWithFilters({}, { page: 1, limit: 1 });
    expect(page1.total).toBe(2);
    expect(page1.items).toHaveLength(1);
  });

  it('findWithFilters restricts to a single ipAddress', async () => {
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '203.0.113.7', userAgent: 'agent', windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '198.51.100.4', userAgent: null, windowStart: WINDOW, now: WINDOW });

    const matched = await repo.findWithFilters({ ipAddress: '203.0.113.7' }, { page: 1, limit: 50 });
    expect(matched.total).toBe(1);
    expect(matched.items).toHaveLength(1);
    expect(matched.items[0].ipAddress).toBe('203.0.113.7');
    expect(matched.items[0].identifier).toBe('a@x.com');
    expect(matched.items[0].userAgent).toBe('agent');
    expect(matched.items[0].attemptCount).toBe(1);

    // The filter is an exact match, not a prefix or substring one.
    const prefixOnly = await repo.findWithFilters({ ipAddress: '203.0.113' }, { page: 1, limit: 50 });
    expect(prefixOnly.total).toBe(0);
    expect(prefixOnly.items).toEqual([]);
  });

  it('findWithFilters combines identifier and ipAddress conjunctively', async () => {
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'a@x.com', ipAddress: '1.1.1.1', userAgent: null, windowStart: WINDOW, now: WINDOW });
    await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: 'b@x.com', ipAddress: '2.2.2.2', userAgent: null, windowStart: WINDOW, now: WINDOW });

    // Each half matches a different bucket, so an OR would return two.
    const crossed = await repo.findWithFilters({ identifier: 'a@x.com', ipAddress: '2.2.2.2' }, { page: 1, limit: 50 });
    expect(crossed.total).toBe(0);
    expect(crossed.items).toEqual([]);
  });

  it('findWithFilters bounds the window inclusively by fromDate and toDate', async () => {
    const EARLIER_WINDOW = new Date('2026-06-10T11:00:00.000Z');
    for (const [index, window] of [EARLIER_WINDOW, WINDOW, LATER_WINDOW].entries()) {
      await repo.record({ eventType: AUTH_ATTEMPT_FAILED_SIGN_IN, identifier: `u${index}@x.com`, ipAddress: '1.1.1.1', userAgent: null, windowStart: window, now: window });
    }

    // Both bounds: the boundary buckets themselves are included (gte/lte, not gt/lt).
    const bounded = await repo.findWithFilters({ fromDate: WINDOW, toDate: LATER_WINDOW }, { page: 1, limit: 50 });
    expect(bounded.total).toBe(2);
    // Ordered by lastAttemptAt desc, so the later window comes first.
    expect(bounded.items.map((item) => item.windowStart.getTime())).toEqual([
      LATER_WINDOW.getTime(),
      WINDOW.getTime(),
    ]);

    // Lower bound only.
    const fromOnly = await repo.findWithFilters({ fromDate: LATER_WINDOW }, { page: 1, limit: 50 });
    expect(fromOnly.total).toBe(1);
    expect(fromOnly.items[0].windowStart.getTime()).toBe(LATER_WINDOW.getTime());

    // Upper bound only.
    const toOnly = await repo.findWithFilters({ toDate: EARLIER_WINDOW }, { page: 1, limit: 50 });
    expect(toOnly.total).toBe(1);
    expect(toOnly.items[0].windowStart.getTime()).toBe(EARLIER_WINDOW.getTime());

    // No bound at all: the range clause is omitted rather than built empty, so nothing is filtered.
    const unbounded = await repo.findWithFilters({}, { page: 1, limit: 50 });
    expect(unbounded.total).toBe(3);
    expect(unbounded.items).toHaveLength(3);
  });

  it('rejects a stored bucket whose eventType is outside the domain union', async () => {
    // `eventType` is a plain text column, so a bad writer (or a future value rolled back) can leave
    // an unmappable row. Mapping it must fail loudly rather than mislabel it as a sign-in failure.
    await client.authAttemptTelemetry.create({
      data: {
        eventType: 'totally_bogus',
        identifier: 'a@x.com',
        ipAddress: '1.1.1.1',
        userAgent: null,
        windowStart: WINDOW,
        attemptCount: 1,
        firstAttemptAt: WINDOW,
        lastAttemptAt: WINDOW,
      },
    });

    await expect(repo.findAll()).rejects.toThrow('Unknown auth-attempt eventType: totally_bogus');
    await expect(repo.findWithFilters({}, { page: 1, limit: 50 })).rejects.toThrow(
      'Unknown auth-attempt eventType: totally_bogus',
    );
  });
});
