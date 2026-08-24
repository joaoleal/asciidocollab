import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { GitCredentialRecord, GitCredentialStore } from '../../../src/ports/git/git-credential-store';

/** In-memory implementation of GitCredentialStore for use in tests. */
export class InMemoryGitCredentialStore implements GitCredentialStore {
  private readonly storage = new Map<string, GitCredentialRecord>();

  /** Stores the encrypted credential for a project, overwriting any existing entry. */
  async save(projectId: ProjectId, credential: GitCredentialRecord): Promise<void> {
    this.storage.set(projectId.value, credential);
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
