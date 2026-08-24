import { ProjectId } from '../../../src/value-objects/ids/project-id';
import {
  GitCredentialRecord,
  GitCredentialSaveInput,
  GitCredentialStore,
} from '../../../src/ports/git/git-credential-store';

/** In-memory implementation of GitCredentialStore for use in tests. */
export class InMemoryGitCredentialStore implements GitCredentialStore {
  private readonly storage = new Map<string, GitCredentialRecord>();

  /** Stores the encrypted credential for a project, overwriting any existing entry. */
  async save(projectId: ProjectId, credential: GitCredentialSaveInput): Promise<void> {
    // Only the shared read shape is retained — provider/createdByUserId are save-only
    // persistence context that load() never hands back (see GitCredentialSaveInput doc).
    const { encryptedToken, tokenHint } = credential;
    this.storage.set(projectId.value, { encryptedToken, tokenHint });
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
