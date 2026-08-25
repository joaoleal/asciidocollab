import { ProjectId } from '../../value-objects/ids/project-id';
import { UserId } from '../../value-objects/ids/user-id';
import { GitProvider } from '../../value-objects/project/git-provider';

/**
 * A Git access credential's ciphertext, as read back for a project.
 *
 * The `encryptedToken` field is opaque ciphertext produced by the infrastructure adapter's
 * encryption scheme — reading a credential back never exposes the plaintext secret. The
 * `tokenHint` field is a short, non-sensitive fragment (e.g. the token's last four characters)
 * safe to surface in a client-facing UI so a user can recognize which credential is connected.
 */
export interface GitCredentialRecord {
  /** Ciphertext produced by the infrastructure adapter; never the plaintext token. */
  readonly encryptedToken: string;
  /** A short, non-sensitive fragment of the token for display purposes, or null if none. */
  readonly tokenHint: string | null;
}

/**
 * Input for {@link GitCredentialStore.save} — the plaintext access token plus the persistence
 * context the underlying `GitCredential` record requires (`provider`, `createdByUserId`).
 *
 * Unlike {@link GitCredentialRecord} (what `load()` hands back — ciphertext only), `save()` takes
 * the raw token: encrypting it, and deriving the display `tokenHint` from it, is the concrete
 * adapter's job, never its caller's — the same division `PasswordHasher.hash` draws for
 * passwords. The plaintext is held only for the duration of this call; no implementation of this
 * port may log, return, or persist it as-is.
 */
export interface GitCredentialSaveInput {
  /** The raw access token. Encrypted by the adapter before it is ever persisted. */
  readonly token: string;
  /** The git hosting provider this credential authenticates against. */
  readonly provider: GitProvider;
  /** The user who saved (created or most recently rotated) this credential. */
  readonly createdByUserId: UserId;
}

/**
 * Port for persisting the Git access credential associated with a project.
 *
 * Each project has at most one stored credential. `save()` accepts the plaintext token and leaves
 * encryption — and deriving the display hint — entirely to the concrete adapter; `load()` returns
 * only already-encrypted ciphertext and the hint. Nothing reachable through this port ever hands
 * plaintext back to a caller; an adapter's own execution-time decryption (for the git-worker to
 * actually run a command) is a deliberately adapter-specific capability outside this interface.
 */
export interface GitCredentialStore {
  /**
   * Encrypts and stores the credential for a project, replacing any existing one.
   *
   * @param projectId - The project the credential authenticates against.
   * @param credential - The plaintext token and the persistence context (`provider`,
   *   `createdByUserId`) the credential record requires.
   * @returns A promise that resolves when the credential has been saved.
   */
  save(projectId: ProjectId, credential: GitCredentialSaveInput): Promise<void>;

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
