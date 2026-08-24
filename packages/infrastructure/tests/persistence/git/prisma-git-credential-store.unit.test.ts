import { GitProvider, ProjectId, UserId } from '@asciidocollab/domain';
import type { PrismaClient } from '@prisma/client';
import { PrismaGitCredentialStore } from '../../../src/persistence/git/prisma-git-credential-store';
import { SessionEncryption } from '../../../src/services/session-encryption';

// 32 zero bytes in base64 — a fixed test-only key, distinct from any session-encryption key,
// so a stored ciphertext can be decrypted by the test itself.
const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

type FakeRow = {
  id: string;
  projectId: string;
  provider: 'GITHUB' | 'GITLAB' | 'BITBUCKET';
  encryptedToken: string;
  tokenHint: string | null;
  createdByUserId: string;
};

/**
 * Minimal in-memory stand-in for the `gitCredential` Prisma model delegate, keyed by
 * `projectId` (mirroring the table's real unique constraint). No DB/testcontainer needed —
 * this is what lets the round-trip and boundary tests below run in this sandbox.
 */
function fakePrismaClient() {
  const rows = new Map<string, FakeRow>();
  const client = {
    gitCredential: {
      upsert: jest.fn(async ({ where, create, update }: { where: { projectId: string }; create: FakeRow; update: Partial<FakeRow> }) => {
        const existing = rows.get(where.projectId);
        const row = existing ? { ...existing, ...update } : { ...create };
        rows.set(where.projectId, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: { where: { projectId: string } }) => rows.get(where.projectId) ?? null),
      deleteMany: jest.fn(async ({ where }: { where: { projectId: string } }) => {
        const existed = rows.delete(where.projectId);
        return { count: existed ? 1 : 0 };
      }),
    },
  };
  return { client: client as unknown as PrismaClient, rows };
}

/** Wires a fresh fake Prisma client + a real `SessionEncryption` into a fresh store instance. */
function makeStore() {
  const { client, rows } = fakePrismaClient();
  const encryption = new SessionEncryption({ encryptionKey: KEY });
  const store = new PrismaGitCredentialStore(client, encryption);
  return { store, rows, encryption, client };
}

describe('PrismaGitCredentialStore', () => {
  const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440010');
  const otherProjectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440011');
  const createdByUserId = UserId.create('550e8400-e29b-41d4-a716-446655440020');
  const provider = GitProvider.create('github');
  const plaintext = 'ghp_supersecrettoken1234567890';

  describe('save + load', () => {
    it('round-trips the ciphertext unchanged: decrypting what load() returns yields the original plaintext', async () => {
      const { store, encryption } = makeStore();
      const ciphertext = encryption.encrypt(plaintext);

      await store.save(projectId, { encryptedToken: ciphertext, tokenHint: '7890', provider, createdByUserId });
      const found = await store.load(projectId);

      expect(found).not.toBeNull();
      expect(found!.encryptedToken).toBe(ciphertext);
      expect(encryption.decrypt(found!.encryptedToken)).toBe(plaintext);
    });

    it('stores the tokenHint alongside the ciphertext', async () => {
      const { store, encryption } = makeStore();
      const ciphertext = encryption.encrypt(plaintext);

      await store.save(projectId, { encryptedToken: ciphertext, tokenHint: '7890', provider, createdByUserId });

      expect(await store.load(projectId)).toEqual({ encryptedToken: ciphertext, tokenHint: '7890' });
    });

    it('allows a null tokenHint to round-trip', async () => {
      const { store, encryption } = makeStore();
      const ciphertext = encryption.encrypt(plaintext);

      await store.save(projectId, { encryptedToken: ciphertext, tokenHint: null, provider, createdByUserId });

      expect(await store.load(projectId)).toEqual({ encryptedToken: ciphertext, tokenHint: null });
    });

    it('returns null when reading a project with no stored credential', async () => {
      const { store } = makeStore();

      expect(await store.load(projectId)).toBeNull();
    });

    it('persists the non-nullable provider and createdByUserId columns the GitCredential table requires', async () => {
      const { store, rows, encryption } = makeStore();
      const ciphertext = encryption.encrypt(plaintext);

      await store.save(projectId, { encryptedToken: ciphertext, tokenHint: '7890', provider: GitProvider.create('gitlab'), createdByUserId });

      const row = rows.get(projectId.value);
      expect(row?.provider).toBe('GITLAB');
      expect(row?.createdByUserId).toBe(createdByUserId.value);
    });

    it('overwrites the previous credential when saving again for the same project', async () => {
      const { store, encryption } = makeStore();
      await store.save(projectId, { encryptedToken: encryption.encrypt('old-token'), tokenHint: 'aaaa', provider, createdByUserId });

      await store.save(projectId, { encryptedToken: encryption.encrypt('new-token'), tokenHint: 'bbbb', provider, createdByUserId });

      const found = await store.load(projectId);
      expect(found?.tokenHint).toBe('bbbb');
      expect(encryption.decrypt(found!.encryptedToken)).toBe('new-token');
    });

    it('keeps credentials for different projects independent', async () => {
      const { store, encryption } = makeStore();
      await store.save(projectId, { encryptedToken: encryption.encrypt('token-one'), tokenHint: '1111', provider, createdByUserId });
      await store.save(otherProjectId, { encryptedToken: encryption.encrypt('token-two'), tokenHint: '2222', provider, createdByUserId });

      const found = await store.load(otherProjectId);
      expect(encryption.decrypt(found!.encryptedToken)).toBe('token-two');
    });

    it('never persists the plaintext token: the stored row only ever contains ciphertext', async () => {
      const { store, rows, encryption } = makeStore();
      const ciphertext = encryption.encrypt(plaintext);

      await store.save(projectId, { encryptedToken: ciphertext, tokenHint: '7890', provider, createdByUserId });

      const row = rows.get(projectId.value);
      expect(row?.encryptedToken).not.toContain(plaintext);
      expect(JSON.stringify(row)).not.toContain(plaintext);
    });

    it('never logs the plaintext token during save or load', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { store, encryption } = makeStore();
        const ciphertext = encryption.encrypt(plaintext);

        await store.save(projectId, { encryptedToken: ciphertext, tokenHint: '7890', provider, createdByUserId });
        await store.load(projectId);

        for (const spy of [logSpy, warnSpy, errorSpy]) {
          for (const call of spy.mock.calls) {
            expect(call.join(' ')).not.toContain(plaintext);
          }
        }
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  describe('delete', () => {
    it('removes the stored credential so a later read returns null', async () => {
      const { store, encryption } = makeStore();
      await store.save(projectId, { encryptedToken: encryption.encrypt(plaintext), tokenHint: '7890', provider, createdByUserId });

      await store.delete(projectId);

      expect(await store.load(projectId)).toBeNull();
    });

    it('treats deleting a project with no stored credential as a no-op', async () => {
      const { store } = makeStore();

      await expect(store.delete(projectId)).resolves.toBeUndefined();
    });

    it('leaves other projects untouched', async () => {
      const { store, encryption } = makeStore();
      await store.save(projectId, { encryptedToken: encryption.encrypt('token-one'), tokenHint: '1111', provider, createdByUserId });
      await store.save(otherProjectId, { encryptedToken: encryption.encrypt('token-two'), tokenHint: '2222', provider, createdByUserId });

      await store.delete(projectId);

      expect(await store.load(otherProjectId)).not.toBeNull();
    });
  });

  describe('loadDecrypted (adapter-specific execution-time path — carry-forward #1)', () => {
    it('returns the decrypted plaintext token and the tokenHint', async () => {
      const { store, encryption } = makeStore();
      await store.save(projectId, { encryptedToken: encryption.encrypt(plaintext), tokenHint: '7890', provider, createdByUserId });

      const decrypted = await store.loadDecrypted(projectId);

      expect(decrypted).toEqual({ token: plaintext, tokenHint: '7890' });
    });

    it('returns null when the project has no stored credential', async () => {
      const { store } = makeStore();

      expect(await store.loadDecrypted(projectId)).toBeNull();
    });
  });
});
