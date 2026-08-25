import { ProjectId } from '../../../src/value-objects/ids/project-id';
import {
  GitCredentialRecord,
  GitCredentialSaveInput,
  GitCredentialStore,
} from '../../../src/ports/git/git-credential-store';

/** The tail of a token safe to show in a UI, or null for an empty token. */
function deriveTokenHint(token: string): string | null {
  return token.length > 0 ? token.slice(-4) : null;
}

/**
 * In-memory implementation of GitCredentialStore for use in tests.
 *
 * Stands in for the real AES-256-GCM adapter with a trivial, deterministic, reversible tag —
 * enough to prove a caller's plaintext token is never stored or forwarded as-is, without pulling
 * real cryptography into domain tests.
 */
export class InMemoryGitCredentialStore implements GitCredentialStore {
  private readonly storage = new Map<string, GitCredentialRecord>();

  /** Encrypts (via the fake transform) and stores the credential for a project. */
  async save(projectId: ProjectId, credential: GitCredentialSaveInput): Promise<void> {
    // Only the ciphertext + hint are retained — provider/createdByUserId are save-only
    // persistence context that load() never hands back (see GitCredentialSaveInput doc).
    this.storage.set(projectId.value, {
      encryptedToken: `encrypted:${credential.token}`,
      tokenHint: deriveTokenHint(credential.token),
    });
  }

  /** Returns the encrypted credential for a project, or null if none is stored. */
  async load(projectId: ProjectId): Promise<GitCredentialRecord | null> {
    return this.storage.get(projectId.value) ?? null;
  }

  /** Removes the stored credential for a project. No-op if none exists. */
  async delete(projectId: ProjectId): Promise<void> {
    this.storage.delete(projectId.value);
  }
}
