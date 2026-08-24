import { ProjectId } from '../../value-objects/ids/project-id';

/**
 * An already-encrypted Git access token record for a project.
 *
 * The `encryptedToken` field is opaque ciphertext produced by the infrastructure adapter's
 * encryption scheme — this port never sees, stores, or returns the plaintext secret. The
 * `tokenHint` field is a short, non-sensitive fragment (e.g. The token's last four characters)
 * safe to surface in a client-facing UI so a user can recognize which credential is connected.
 */
export interface GitCredentialRecord {
  /** Ciphertext produced by the infrastructure adapter; never the plaintext token. */
  readonly encryptedToken: string;
  /** A short, non-sensitive fragment of the token for display purposes, or null if none. */
  readonly tokenHint: string | null;
}

/**
 * Port for persisting the encrypted Git access credential associated with a project.
 *
 * Each project has at most one stored credential. This port only moves already-encrypted
 * ciphertext and its display hint — encrypting and decrypting the token is the responsibility
 * of the infrastructure adapter that implements this interface, never of the port's callers or
 * of domain code. The plaintext token itself is never a parameter or return value here.
 */
export interface GitCredentialStore {
  /**
   * Stores the encrypted credential for a project, replacing any existing one.
   *
   * @param projectId - The project the credential authenticates against.
   * @param credential - The encrypted token and its display hint.
   * @returns A promise that resolves when the credential has been saved.
   */
  save(projectId: ProjectId, credential: GitCredentialRecord): Promise<void>;

  /**
   * Reads back the encrypted credential for a project.
   *
   * @param projectId - The project whose credential to read.
   * @returns The stored encrypted credential, or null if the project has none.
   */
  load(projectId: ProjectId): Promise<GitCredentialRecord | null>;

  /**
   * Removes the stored credential for a project. No-op if none exists.
   *
   * @param projectId - The project whose credential should be removed.
   * @returns A promise that resolves when the removal completes.
   */
  delete(projectId: ProjectId): Promise<void>;
}
