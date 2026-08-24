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

/**
 * Prisma-backed implementation of the `GitCredentialStore` port, storing AES-256-GCM ciphertext
 * (produced by {@link SessionEncryption}) in the `GitCredential` table.
 *
 * Resolves carry-forward #2 from the T005 review on the port itself. The `save` method of
 * `GitCredentialStore` takes a `GitCredentialSaveInput` that widens `GitCredentialRecord` with
 * `provider`/`createdByUserId`, since the `GitCredential` row requires both and neither belongs
 * on the record that `load` hands back.
 *
 * Neither `save`, `load`, nor `delete` encrypt or decrypt anything — the `encryptedToken` field
 * they move is already ciphertext produced upstream of this port (per the `GitCredentialRecord`
 * contract, this port never sees, stores, or returns plaintext). The injected
 * {@link SessionEncryption} — keyed with the DEDICATED `git.credentialEncryptionKey` (never the
 * session encryption key), wired by the composition root — is used by this adapter only for
 * {@link loadDecrypted}.
 *
 * Resolves carry-forward #1 (the decrypted-token path) with a deliberately adapter-specific
 * method: `loadDecrypted` is not added to the domain `GitCredentialStore` port. Decryption is an
 * infrastructure concern, and keeping it off the port means every other consumer (use cases, the
 * in-memory test fake) keeps working with ciphertext-only semantics. Only the git-worker's
 * composition root, which already depends on this concrete adapter for DI, should call it, at job
 * execution time, to hand the plaintext to `git` out-of-band via a `GIT_ASKPASS` helper or similar
 * — never via argv, the working tree, `.git/config`, or a log line (Security Constitution 1.3.0).
 */
export class PrismaGitCredentialStore implements GitCredentialStore {
  /**
   * @param prisma - The Prisma client used for database operations.
   * @param encryption - AES-256-GCM service, constructed with the dedicated
   *   `git.credentialEncryptionKey` — used only by `loadDecrypted`, never by `save`/`load`.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryption: SessionEncryption,
  ) {}

  /**
   * Stores the encrypted credential for a project, replacing any existing one.
   *
   * @param projectId - The project the credential authenticates against.
   * @param credential - The already-encrypted token, its display hint, and the persistence
   *   context (`provider`, `createdByUserId`) the `GitCredential` row requires.
   */
  async save(projectId: ProjectId, credential: GitCredentialSaveInput): Promise<void> {
    const data = {
      projectId: projectId.value,
      provider: toPrismaProvider(credential.provider.value),
      encryptedToken: credential.encryptedToken,
      tokenHint: credential.tokenHint,
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
