import type { PrismaClient } from '@prisma/client';
import {
  GitCredentialRecord,
  GitCredentialSaveInput,
  GitCredentialStore,
  ProjectId,
} from '@asciidocollab/domain';
import { SessionEncryption } from '../../services/session-encryption';

/**
 * A decrypted credential, for the execution-time path only.
 *
 * The plaintext `token` must be used immediately by its caller and never logged, persisted, or
 * returned across a process/API boundary — see {@link PrismaGitCredentialStore.loadDecrypted}.
 */
export interface DecryptedGitCredential {
  /** The plaintext Git access token. Transient — hold it only as long as the git operation runs. */
  readonly token: string;
  /** The same non-sensitive display fragment `load()` returns. */
  readonly tokenHint: string | null;
}

/** The tail of a token safe to show in a UI — its last four characters, or null for an empty token. */
function deriveTokenHint(token: string): string | null {
  return token.length > 0 ? token.slice(-4) : null;
}

/**
 * Prisma-backed implementation of the `GitCredentialStore` port, storing AES-256-GCM ciphertext
 * (produced by {@link SessionEncryption}) in the `GitCredential` table.
 *
 * `save` accepts the plaintext token (plus the `provider`/`createdByUserId` persistence context
 * the `GitCredential` row's non-nullable columns require) and encrypts it — and derives the
 * display `tokenHint` from it — before anything is written. `load` and `delete` only ever move
 * already-encrypted ciphertext; nothing on the read side ever exposes plaintext. The injected
 * {@link SessionEncryption} is keyed with the DEDICATED `git.credentialEncryptionKey` (never the
 * session encryption key), wired by the composition root.
 *
 * Decryption for actual use — as opposed to the encrypt-on-write above — is intentionally isolated
 * to `loadDecrypted`, a deliberately adapter-specific method not added to the domain
 * `GitCredentialStore` port: only the git-worker's composition root, which already depends on this
 * concrete adapter for DI, should call it, at job execution time, to hand the plaintext to `git`
 * out-of-band via a `GIT_ASKPASS` helper or similar — never via argv, the working tree,
 * `.git/config`, or a log line.
 */
export class PrismaGitCredentialStore implements GitCredentialStore {
  /**
   * @param prisma - The Prisma client used for database operations.
   * @param encryption - AES-256-GCM service, constructed with the dedicated
   *   `git.credentialEncryptionKey` — used by both `save` (to encrypt) and `loadDecrypted` (to
   *   decrypt), never by `load`.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryption: SessionEncryption,
  ) {}

  /**
   * Encrypts the given plaintext token and stores it for a project, replacing any existing
   * credential.
   *
   * @param projectId - The project the credential authenticates against.
   * @param credential - The plaintext token and the persistence context (`provider`,
   *   `createdByUserId`) the `GitCredential` row requires.
   */
  async save(projectId: ProjectId, credential: GitCredentialSaveInput): Promise<void> {
    const data = {
      projectId: projectId.value,
      provider: toPrismaProvider(credential.provider.value),
      encryptedToken: this.encryption.encrypt(credential.token),
      tokenHint: deriveTokenHint(credential.token),
      createdByUserId: credential.createdByUserId.value,
    };
    await this.prisma.gitCredential.upsert({
      where: { projectId: projectId.value },
      create: data,
      update: {
        provider: data.provider,
        encryptedToken: data.encryptedToken,
        tokenHint: data.tokenHint,
        // createdByUserId is intentionally left out of `update`: rotating a token is not
        // re-creating the credential, so upsert leaves the original creator untouched on
        // update (mirrors the connectedByUserId handling in
        // prisma-git-repository.repository.ts's toPersistenceGitRepository).
      },
    });
  }

  /**
   * Reads back the encrypted credential for a project.
   *
   * @param projectId - The project whose credential to read.
   * @returns The stored ciphertext and display hint, or null if the project has none.
   */
  async load(projectId: ProjectId): Promise<GitCredentialRecord | null> {
    const record = await this.prisma.gitCredential.findUnique({ where: { projectId: projectId.value } });
    return record ? { encryptedToken: record.encryptedToken, tokenHint: record.tokenHint } : null;
  }

  /**
   * Removes the stored credential for a project. No-op if none exists.
   *
   * @param projectId - The project whose credential should be removed.
   */
  async delete(projectId: ProjectId): Promise<void> {
    await this.prisma.gitCredential.deleteMany({ where: { projectId: projectId.value } });
  }

  /**
   * Reads back and decrypts the credential for a project — the execution-time path the
   * git-worker runner needs to authenticate a `git` operation.
   *
   * The returned plaintext is transient: the caller must use it immediately for the job at hand
   * and never log it, write it to the working tree/`.git/config`/argv, or return it to an
   * API/route layer. Nothing beyond this method ever decrypts a stored credential.
   *
   * @param projectId - The project whose credential to decrypt.
   * @returns The decrypted token and its display hint, or null if the project has none.
   */
  async loadDecrypted(projectId: ProjectId): Promise<DecryptedGitCredential | null> {
    const record = await this.load(projectId);
    if (!record) {
      return null;
    }
    return { token: this.encryption.decrypt(record.encryptedToken), tokenHint: record.tokenHint };
  }
}

function toPrismaProvider(value: string): 'GITHUB' | 'GITLAB' | 'BITBUCKET' {
  if (value === 'github') return 'GITHUB';
  if (value === 'gitlab') return 'GITLAB';
  return 'BITBUCKET';
}
