import type { GitCredentialRecord, GitCredentialSaveInput, GitCredentialStore, ProjectId } from '@asciidocollab/domain';

/** The tail of a token safe to show in a UI, or null for an empty token. */
function deriveTokenHint(token: string): string | null {
  return token.length > 0 ? token.slice(-4) : null;
}

/**
 * A local, minimal in-memory `GitCredentialStore` fake for this app's tests. See
 * `in-memory-git-operation-repository.ts`'s class docs for why this app keeps its own fakes rather
 * than reusing `packages/domain/tests`'.
 *
 * Stands in for the real AES-256-GCM adapter with a trivial, deterministic, reversible tag — enough
 * to prove a caller's plaintext token is never stored or forwarded as-is, without pulling real
 * cryptography into these tests.
 */
export class InMemoryGitCredentialStore implements GitCredentialStore {
  private readonly storage = new Map<string, GitCredentialRecord>();

  /** Every call made to `save`, in call order, for asserting the exact plaintext token handed in. */
  readonly saveCalls: { projectId: ProjectId; credential: GitCredentialSaveInput }[] = [];

  async save(projectId: ProjectId, credential: GitCredentialSaveInput): Promise<void> {
    this.saveCalls.push({ projectId, credential });
    // Only the ciphertext + hint are retained — provider/createdByUserId are save-only persistence
    // context that load() never hands back (see GitCredentialSaveInput's own docs).
    this.storage.set(projectId.value, {
      encryptedToken: `encrypted:${credential.token}`,
      tokenHint: deriveTokenHint(credential.token),
    });
  }

  async load(projectId: ProjectId): Promise<GitCredentialRecord | null> {
    return this.storage.get(projectId.value) ?? null;
  }

  async delete(projectId: ProjectId): Promise<void> {
    this.storage.delete(projectId.value);
  }
}
