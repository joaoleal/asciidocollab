import {
  ADMIN_LIST_DEFAULT_LIMIT,
  ADMIN_LIST_MAX_LIMIT,
  isAdmin,
  normalizeAdminPagination,
} from '../../../src/use-cases/admin/admin-list-helpers';
import { PaginationOptions } from '../../../src/ports/admin/audit-log.repository';
import { InMemoryUserRepository } from '../../ports/user/in-memory-user.repository';
import { User } from '../../../src/entities/user';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Email } from '../../../src/value-objects/identity/email';
import { Timestamps } from '../../../src/value-objects/common/timestamps';
import { randomUUID } from 'crypto';

function makeUser(admin: boolean): User {
  return new User(
    UserId.create(randomUUID()),
    Email.create(`user-${randomUUID()}@example.com`),
    'Test User',
    'hash',
    [],
    null,
    null,
    admin,
    new Timestamps(),
    true,
    'SELF_REGISTERED',
  );
}

// Pagination reaching the domain from an untyped delivery-layer payload, where a field the
// interface declares as required can still be absent at runtime.
function paginationFromUntypedPayload(payload: string): PaginationOptions {
  return JSON.parse(payload);
}

describe('normalizeAdminPagination', () => {
  test('falls back to the first page and the default limit when neither is present', () => {
    expect(normalizeAdminPagination(paginationFromUntypedPayload('{}'))).toEqual({
      page: 1,
      limit: ADMIN_LIST_DEFAULT_LIMIT,
    });
  });

  test('falls back to the default limit when only the page is present', () => {
    expect(normalizeAdminPagination(paginationFromUntypedPayload('{"page":4}'))).toEqual({
      page: 4,
      limit: ADMIN_LIST_DEFAULT_LIMIT,
    });
  });

  test('falls back to the first page when only the limit is present', () => {
    expect(normalizeAdminPagination(paginationFromUntypedPayload('{"limit":12}'))).toEqual({
      page: 1,
      limit: 12,
    });
  });

  test('keeps a requested page and limit that are already within range', () => {
    expect(normalizeAdminPagination({ page: 3, limit: 25 })).toEqual({ page: 3, limit: 25 });
  });

  test('raises a zero or negative page to the first page so the repository skip stays non-negative', () => {
    expect(normalizeAdminPagination({ page: 0, limit: 10 }).page).toBe(1);
    expect(normalizeAdminPagination({ page: -7, limit: 10 }).page).toBe(1);
  });

  test('raises a zero or negative limit to one so a page is never silently empty', () => {
    expect(normalizeAdminPagination({ page: 2, limit: 0 }).limit).toBe(1);
    expect(normalizeAdminPagination({ page: 2, limit: -5 }).limit).toBe(1);
  });

  test('clamps a limit above the maximum down to the maximum', () => {
    expect(normalizeAdminPagination({ page: 1, limit: 100_000 }).limit).toBe(ADMIN_LIST_MAX_LIMIT);
  });

  test('truncates fractional page and limit values to whole numbers', () => {
    expect(normalizeAdminPagination({ page: 2.9, limit: 10.7 })).toEqual({ page: 2, limit: 10 });
  });
});

describe('isAdmin', () => {
  let userRepo: InMemoryUserRepository;

  beforeEach(() => {
    userRepo = new InMemoryUserRepository();
  });

  test('is true for a stored user with administrator privileges', async () => {
    const admin = makeUser(true);
    await userRepo.save(admin);

    await expect(isAdmin(userRepo, admin.id)).resolves.toBe(true);
  });

  test('is false for a stored user without administrator privileges', async () => {
    const member = makeUser(false);
    await userRepo.save(member);

    await expect(isAdmin(userRepo, member.id)).resolves.toBe(false);
  });

  test('is false when the actor cannot be resolved', async () => {
    await expect(isAdmin(userRepo, UserId.create(randomUUID()))).resolves.toBe(false);
  });
});
