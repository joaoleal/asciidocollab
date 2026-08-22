import { PrismaClient } from '@prisma/client';
import { Email } from '@asciidocollab/domain';
import { PrismaSessionStore } from '../../src/services/prisma-session-store';
import { SessionEncryption } from '../../src/services/session-encryption';
import { PrismaUserRepository } from '../../src/persistence/user/prisma-user.repository';
import { startTestContainer, stopTestContainer, TestContainer } from '../helpers/prisma-test-container';
import { createTestUser } from '../helpers/test-data';
import { randomUUID } from 'crypto';

// 32 zero bytes in base64 — a fixed key so a stored ciphertext can be decrypted by the test itself.
const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const DAY_MS = 86_400_000;

type StoredSession = { cookie?: { expires?: Date | null }; userId?: string };

/**
 * Runs `set` and resolves with the arguments the callback received — the array itself, so that a
 * successful `callback()` (zero arguments) is distinguishable from `callback(undefined)`.
 */
function setSession(store: PrismaSessionStore, sid: string, session: StoredSession): Promise<unknown[]> {
  return new Promise((resolve) => {
    void store.set(sid, session, (...arguments_: unknown[]) => resolve(arguments_));
  });
}

/** Runs `get` and resolves with the arguments the callback received. */
function getSession(store: PrismaSessionStore, sid: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    void store.get(sid, (...arguments_: unknown[]) => resolve(arguments_));
  });
}

/** Runs `destroy` and resolves with the arguments the callback received. */
function destroySession(store: PrismaSessionStore, sid: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    void store.destroy(sid, (...arguments_: unknown[]) => resolve(arguments_));
  });
}

describe('PrismaSessionStore', () => {
  let container: TestContainer;
  let client: PrismaClient;
  let encryption: SessionEncryption;
  let store: PrismaSessionStore;
  let userRepo: PrismaUserRepository;

  beforeAll(async () => {
    container = await startTestContainer();
    client = container.client;
    encryption = new SessionEncryption({ encryptionKey: KEY });
    store = new PrismaSessionStore(client, encryption);
    userRepo = new PrismaUserRepository(client);
  });

  afterAll(async () => {
    await stopTestContainer(container);
  });

  beforeEach(async () => {
    await client.session.deleteMany();
    await client.user.deleteMany();
  });

  /** The message `SessionEncryption.decrypt` raises for the given stored value. */
  function decryptFailureMessage(stored: string): string {
    try {
      encryption.decrypt(stored);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error(`decrypt unexpectedly succeeded for ${stored}`);
  }

  async function saveUser(): Promise<string> {
    const user = createTestUser({ email: Email.create(`session-${randomUUID()}@example.com`) });
    await userRepo.save(user);
    return user.id.value;
  }

  describe('set', () => {
    it('stores the session under the given sid, encrypted, with the cookie expiry', async () => {
      const userId = await saveUser();
      const expires = new Date(Date.now() + 7_200_000);
      const session = { cookie: { expires }, userId };

      const callbackArguments = await setSession(store, 'sid-stored', session);

      expect(callbackArguments).toEqual([]);
      const row = await client.session.findUniqueOrThrow({ where: { sid: 'sid-stored' } });
      expect(row.userId).toBe(userId);
      expect(row.expiresAt.getTime()).toBe(expires.getTime());
      const raw = JSON.stringify(session);
      expect(row.data).not.toBe(raw);
      expect(encryption.decrypt(row.data as string)).toBe(raw);
    });

    it('stores a null userId when the session carries none', async () => {
      await setSession(store, 'sid-anonymous', { cookie: { expires: new Date(Date.now() + DAY_MS) } });

      const row = await client.session.findUniqueOrThrow({ where: { sid: 'sid-anonymous' } });
      expect(row.userId).toBeNull();
    });

    it('stores a null userId when the session carries an empty one', async () => {
      await setSession(store, 'sid-empty-user', { userId: '' });

      const row = await client.session.findUniqueOrThrow({ where: { sid: 'sid-empty-user' } });
      expect(row.userId).toBeNull();
    });

    it('falls back to a 24-hour expiry when the cookie has no expiry', async () => {
      const before = Date.now();

      await setSession(store, 'sid-no-expires', { cookie: { expires: null } });

      const row = await client.session.findUniqueOrThrow({ where: { sid: 'sid-no-expires' } });
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + DAY_MS);
      expect(row.expiresAt.getTime()).toBeLessThan(Date.now() + DAY_MS + 5000);
    });

    it('falls back to a 24-hour expiry when there is no cookie at all', async () => {
      const before = Date.now();

      await setSession(store, 'sid-no-cookie', {});

      const row = await client.session.findUniqueOrThrow({ where: { sid: 'sid-no-cookie' } });
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + DAY_MS);
      expect(row.expiresAt.getTime()).toBeLessThan(Date.now() + DAY_MS + 5000);
    });

    it('overwrites the row for a sid that is already stored', async () => {
      const firstUser = await saveUser();
      const secondUser = await saveUser();
      const firstExpiry = new Date(Date.now() + 60_000);
      const secondExpiry = new Date(Date.now() + 120_000);
      await setSession(store, 'sid-reused', { cookie: { expires: firstExpiry }, userId: firstUser });

      await setSession(store, 'sid-reused', { cookie: { expires: secondExpiry }, userId: secondUser });

      const rows = await client.session.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(secondUser);
      expect(rows[0].expiresAt.getTime()).toBe(secondExpiry.getTime());
    });

    it('leaves other sessions alone', async () => {
      await setSession(store, 'sid-a', { cookie: { expires: new Date(Date.now() + 60_000) } });
      await setSession(store, 'sid-b', { cookie: { expires: new Date(Date.now() + 60_000) } });

      const rows = await client.session.findMany();
      expect(rows.map((row) => row.sid).toSorted()).toEqual(['sid-a', 'sid-b']);
    });

    it('calls back with the error when the write fails', async () => {
      // A userId with no matching user violates the foreign key.
      const callbackArguments = await setSession(store, 'sid-orphan', { userId: randomUUID() });

      expect(callbackArguments).toHaveLength(1);
      expect(callbackArguments[0]).toMatchObject({ code: 'P2003' });
      expect(await client.session.count()).toBe(0);
    });
  });

  describe('get', () => {
    it('returns the session that was stored', async () => {
      const userId = await saveUser();
      const expires = new Date(Date.now() + 60_000);
      await setSession(store, 'sid-roundtrip', { cookie: { expires }, userId });

      const [error, result] = await getSession(store, 'sid-roundtrip');

      expect(error).toBeNull();
      expect(result).toEqual({ cookie: { expires: expires.toISOString() }, userId });
    });

    it('returns the session for the requested sid, not another one', async () => {
      await setSession(store, 'sid-wanted', { userId: undefined, cookie: { expires: new Date(Date.now() + 60_000) } });
      await client.session.update({
        where: { sid: 'sid-wanted' },
        data: { data: encryption.encrypt(JSON.stringify({ marker: 'wanted' })) },
      });
      await setSession(store, 'sid-other', { cookie: { expires: new Date(Date.now() + 60_000) } });
      await client.session.update({
        where: { sid: 'sid-other' },
        data: { data: encryption.encrypt(JSON.stringify({ marker: 'other' })) },
      });

      const [, result] = await getSession(store, 'sid-wanted');

      expect(result).toEqual({ marker: 'wanted' });
    });

    it('calls back with a null result when the sid is unknown', async () => {
      await setSession(store, 'sid-present', { cookie: { expires: new Date(Date.now() + 60_000) } });

      const callbackArguments = await getSession(store, 'sid-absent');

      expect(callbackArguments).toEqual([null, null]);
    });

    it('still returns a session that expires shortly in the future', async () => {
      await setSession(store, 'sid-nearly-due', { cookie: { expires: new Date(Date.now() + 30_000) } });

      const [error, result] = await getSession(store, 'sid-nearly-due');

      expect(error).toBeNull();
      expect(result).not.toBeNull();
      // A live session is read, never reaped.
      expect(await client.session.count({ where: { sid: 'sid-nearly-due' } })).toBe(1);
    });

    it('returns null and reaps the row for a session that expired a millisecond ago', async () => {
      await setSession(store, 'sid-just-expired', { cookie: { expires: new Date(Date.now() - 1) } });
      await setSession(store, 'sid-live', { cookie: { expires: new Date(Date.now() + 60_000) } });

      const callbackArguments = await getSession(store, 'sid-just-expired');

      expect(callbackArguments).toEqual([null, null]);
      const remaining = await client.session.findMany();
      expect(remaining.map((row) => row.sid)).toEqual(['sid-live']);
    });

    it('calls back with the error when the stored data cannot be decrypted', async () => {
      const otherKey = new SessionEncryption({ encryptionKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=' });
      const ciphertext = otherKey.encrypt(JSON.stringify({ userId: 'x' }));
      await client.session.create({
        data: {
          sid: 'sid-foreign-key',
          userId: null,
          data: ciphertext,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const [error, result] = await getSession(store, 'sid-foreign-key');

      // Compared against the failure decrypting that exact ciphertext raises here, so the assertion
      // pins the store's error to the decrypt step rather than to "something went wrong".
      // (`toBeInstanceOf(Error)` cannot be used: node's crypto errors come from outside the jest
      // sandbox realm, so they are not instances of the test context's `Error`.)
      expect((error as Error).message).toBe(decryptFailureMessage(ciphertext));
      expect(result).toBeNull();
    });

    it('calls back with the error when the decrypted payload is not JSON', async () => {
      await client.session.create({
        data: {
          sid: 'sid-not-json',
          userId: null,
          data: encryption.encrypt('this is not json'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const [error, result] = await getSession(store, 'sid-not-json');

      expect(error).toBeInstanceOf(SyntaxError);
      expect(result).toBeNull();
    });

    it('calls back with the error when the stored data is a JSON object rather than a ciphertext string', async () => {
      // A row written by something other than this store: `data` is a JSON object, so the store
      // stringifies it and hands the result to decrypt, which cannot make sense of it.
      await client.session.create({
        data: {
          sid: 'sid-json-object',
          userId: null,
          data: { userId: 'plaintext' },
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const [error, result] = await getSession(store, 'sid-json-object');

      expect((error as Error).message).toBe(decryptFailureMessage(JSON.stringify({ userId: 'plaintext' })));
      expect(result).toBeNull();
    });

    it('still reports the session as gone when reaping the expired row fails', async () => {
      const deleteError = new Error('delete refused');
      const decrypt = jest.fn();
      const failingClient = {
        session: {
          findUnique: jest.fn(async () => ({
            sid: 'sid-unreapable',
            data: 'irrelevant',
            expiresAt: new Date(Date.now() - 1),
          })),
          delete: jest.fn(async () => {
            throw deleteError;
          }),
        },
      } as unknown as PrismaClient;
      const failingStore = new PrismaSessionStore(failingClient, {
        decrypt,
      } as unknown as SessionEncryption);

      const callbackArguments = await getSession(failingStore, 'sid-unreapable');

      expect(callbackArguments).toEqual([null, null]);
      // The failed delete must not become a read error, and the row is never decrypted.
      expect(decrypt).not.toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('deletes the session with that sid and leaves the others', async () => {
      await setSession(store, 'sid-doomed', { cookie: { expires: new Date(Date.now() + 60_000) } });
      await setSession(store, 'sid-spared', { cookie: { expires: new Date(Date.now() + 60_000) } });

      const callbackArguments = await destroySession(store, 'sid-doomed');

      expect(callbackArguments).toEqual([]);
      const remaining = await client.session.findMany();
      expect(remaining.map((row) => row.sid)).toEqual(['sid-spared']);
    });

    it('makes the session unreadable afterwards', async () => {
      await setSession(store, 'sid-gone', { cookie: { expires: new Date(Date.now() + 60_000) } });

      await destroySession(store, 'sid-gone');

      expect(await getSession(store, 'sid-gone')).toEqual([null, null]);
    });

    it('succeeds for a sid that is not stored', async () => {
      await setSession(store, 'sid-present', { cookie: { expires: new Date(Date.now() + 60_000) } });

      const callbackArguments = await destroySession(store, 'sid-absent');

      expect(callbackArguments).toEqual([]);
      expect(await client.session.count()).toBe(1);
    });

    it('calls back with the error when the delete fails', async () => {
      const deleteError = new Error('deleteMany refused');
      const failingClient = {
        session: {
          deleteMany: jest.fn(async () => {
            throw deleteError;
          }),
        },
      } as unknown as PrismaClient;
      const failingStore = new PrismaSessionStore(failingClient, encryption);

      const callbackArguments = await destroySession(failingStore, 'sid-any');

      expect(callbackArguments).toEqual([deleteError]);
    });
  });
});
