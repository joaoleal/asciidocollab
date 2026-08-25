import path from 'path';
import type { PrismaClient } from '@prisma/client';
import { GitProvider, ProjectId, UserId } from '@asciidocollab/domain';
import { PrismaGitCredentialStore, SessionEncryption } from '@asciidocollab/infrastructure';
import { createServices } from '../../src/di/services';
import { getConfig } from '../../src/config';
import { setupTestEnvironment } from '../helpers/test-environment';

// Deliberately NOT the session encryption key `setupTestEnvironment` sets
// (32 zero bytes) — this pins that the git credential store is keyed with its
// own dedicated key rather than reusing the session one.
const GIT_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

type FakeRow = {
  projectId: string;
  provider: 'GITHUB' | 'GITLAB' | 'BITBUCKET';
  encryptedToken: string;
  tokenHint: string | null;
  createdByUserId: string;
};

/**
 * Minimal in-memory stand-in for the `gitCredential` Prisma model delegate — enough for
 * `createServices` to construct real repositories/services against, and for the wired store
 * to actually save/load through, without a database.
 */
function fakePrismaClient(): PrismaClient {
  const rows = new Map<string, FakeRow>();
  const client = {
    gitCredential: {
      upsert: jest.fn(
        async ({ where, create, update }: { where: { projectId: string }; create: FakeRow; update: Partial<FakeRow> }) => {
          const existing = rows.get(where.projectId);
          const row = existing ? { ...existing, ...update } : { ...create };
          rows.set(where.projectId, row);
          return row;
        },
      ),
      findUnique: jest.fn(async ({ where }: { where: { projectId: string } }) => rows.get(where.projectId) ?? null),
      deleteMany: jest.fn(async ({ where }: { where: { projectId: string } }) => {
        const existed = rows.delete(where.projectId);
        return { count: existed ? 1 : 0 };
      }),
    },
  };
  return client as unknown as PrismaClient;
}

describe('git credential store wiring', () => {
  beforeAll(() => {
    setupTestEnvironment();
    process.env.ASCIIDOCOLLAB_GIT_CREDENTIAL_ENCRYPTION_KEY = GIT_CREDENTIAL_ENCRYPTION_KEY;
  });

  it('registers a resolvable, correctly-typed git credential store keyed with the dedicated encryption key', async () => {
    const appConfig = getConfig();
    expect(appConfig.git.credentialEncryptionKey).toBe(GIT_CREDENTIAL_ENCRYPTION_KEY);

    const services = createServices({
      appConfig,
      prisma: fakePrismaClient(),
      commonPasswordsPath: path.join(__dirname, '..', '..', 'data', 'common-passwords.txt'),
    });

    expect(services.gitCredentialStore).toBeInstanceOf(PrismaGitCredentialStore);

    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440030');
    const createdByUserId = UserId.create('550e8400-e29b-41d4-a716-446655440031');
    const provider = GitProvider.create('github');
    const plaintext = 'ghp_testtoken1234567890';

    const store = services.gitCredentialStore as PrismaGitCredentialStore;
    await store.save(projectId, { token: plaintext, provider, createdByUserId });

    // Decrypt the raw stored ciphertext with an INDEPENDENTLY constructed SessionEncryption
    // under the SAME dedicated key the wiring is supposed to use. If the composition root had
    // instead built the git credential store with the session encryption key, this would fail
    // (wrong key / auth-tag mismatch) even though the store's own round trip below would still
    // "work" against itself either way.
    const independentEncryption = new SessionEncryption({ encryptionKey: GIT_CREDENTIAL_ENCRYPTION_KEY });
    const stored = await store.load(projectId);
    expect(independentEncryption.decrypt(stored!.encryptedToken)).toBe(plaintext);

    const decrypted = await store.loadDecrypted(projectId);
    expect(decrypted).toEqual({ token: plaintext, tokenHint: '7890' });
  });
});
